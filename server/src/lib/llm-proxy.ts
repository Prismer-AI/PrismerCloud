/**
 * LLM Proxy — thin reverse proxy to NewAPI gateway
 *
 * Design principles:
 *   1. Byte-level transparent pipe — we never parse request bodies
 *   2. Key swap only — replace sk-prismer-* with NewAPI token
 *   3. Usage extraction — read standard `usage` field from response for billing
 *   4. Fail-open for billing — if usage extraction fails, the LLM call still succeeds
 */

import { NextRequest } from 'next/server';
import { ensureNacosConfig } from '@/lib/nacos-config';
import { createModuleLogger } from '@/lib/logger';
import { resolveNewAPIToken } from '@/lib/newapi-admin';
import { resolveChain, applyVisionFilter, type ResolvedSource } from '@/lib/llm/provider-sources';
import { calculateImageCredits, calculateLLMCredits, type ImageUsage, type LLMUsage } from '@/lib/llm-pricing';
import { recordUsageBackground, generateTaskId, type UsageRecordRequest } from '@/lib/usage-recorder';
import { IDEMPOTENCY_HEADER, readCache, writeCache, usageForCache, type LLMCacheEntry } from '@/lib/llm-proxy-cache';
import {
  getLlmProxyStreamBodyTimeoutMs,
  getLlmProxyTimeoutMs,
  withLlmProxyStreamingDispatcher,
} from '@/lib/llm-proxy-upstream';
import { streamWithResume } from '@/lib/llm-proxy-stream-resume';
import type { GuardResult } from '@/lib/api-guard';

const log = createModuleLogger('LLMProxy');

// ============================================================================
// Cleanup-2 (2026-05-25) — LLM-call-level idempotency cache
// ============================================================================
//
// When a daemon pod crashes mid-LLM-call and the cloud P0-2 sweep re-dispatches
// the task, the hermes/openclaw adapter re-fires the same /v1/chat/completions
// request. Without dedup the user is billed twice (e.g. ~$0.05 per crash).
//
// The adapter sends `X-Prismer-Idempotency-Key: llm:<hash>` derived from
// (taskRunId, attemptNo, stepSeq, model, prompt) — see
// sdk/prismer-cloud/runtime/src/adapters/hermes/index.ts:llmIdempotencyKey.
//
// On hit we replay the cached SSE chunks (streaming) or JSON body (non-streaming)
// directly from Redis. On miss we forward to upstream, buffer the full response,
// and persist to Redis with a 24h TTL (matches the upper bound for realistic
// daemon-resume windows).
//
// Billing pass-through: cache hits still call recordLLMUsage() with the cached
// `usage` so the user's account reflects the call happened, but the usage
// record's input.value carries a `cached=true` marker so finance can subtract
// these from the real OpenAI spend tally.
//
// Backward compat: requests without the header skip the cache entirely.
//
// 2026-05-25 (Cleanup-3): cache infrastructure (Redis client, read/write
// helpers, types) extracted to `llm-proxy-cache.ts` so the Anthropic proxy
// can share the same Redis namespace + TTL + on-disk format without forking
// the Redis client.

/**
 * Serve a cache hit as a Response. Replays SSE chunks (streaming) or the
 * raw body (non-streaming) and re-records the usage with `cached=true` in
 * the input.value so billing analytics keep parity but finance can filter.
 */
function serveCacheHit(entry: LLMCacheEntry, guard: GuardResult, endpoint: string): Response {
  // Billing pass-through — see header comment for the cached=true rationale.
  if (entry.usage) {
    recordLLMUsage(guard, entry.model || 'unknown', entry.usage as LLMUsage, endpoint, true);
  }
  const headers = new Headers();
  headers.set('content-type', entry.contentType);
  headers.set('x-prismer-cache', 'hit');
  if (entry.isStreaming && entry.chunks) {
    const chunks = entry.chunks;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    });
    return new Response(stream, { status: entry.status, headers });
  }
  return new Response(entry.body ?? '', { status: entry.status, headers });
}

// ============================================================================
// Config
// ============================================================================

/**
 * release202/07 — back-compat alias. The per-agent proxy route used to pass a
 * `ForceProvider`; chains generalize it (any chain id is now valid). Kept as a
 * named type so the route's existing import keeps compiling; `proxyToNewAPI`'s
 * 4th arg is now `chainId?: string` and `'newapi'`/`'deepseek'` resolve to
 * built-in single-element chains.
 */
export type ForceProvider = 'newapi' | 'deepseek';

function getTimeoutMs(): number {
  return getLlmProxyTimeoutMs();
}

// ============================================================================
// 上游过载(429/503) → DeepSeek flash fallback
// ============================================================================
//
// 根因(2026-06-01 追查):primary 上游(newapi/kimi-k2.6)过载时回 429
// "engine is currently overloaded"，proxy 此前原样直透 → daemon Hermes 重试 3 次
// 仍 429 → 把错误串当 agent 回复 body 倒出来。
//
// 本机制:proxy 在**单次请求内**主路重试 N 次(默认 3)on 429/503，仍过载就切
// DeepSeek flash(deepseek-v4-flash)再发一次，返回 DeepSeek 的成功响应——对
// Hermes 透明,它根本不会看到 429。key-gated(需 DEEPSEEK_API_KEY)，
// DEEPSEEK_FALLBACK_ENABLED=false 可关。primary 本就是 deepseek(bypass)时不兜底。

function isOverloadStatus(status: number): boolean {
  return status === 429 || status === 503;
}

/** 主路在 fallback 前的最大尝试次数(含首发)。默认 3。 */
function getFallbackPrimaryAttempts(): number {
  const raw = Number(process.env.LLM_PROXY_OVERLOAD_ATTEMPTS);
  return Number.isFinite(raw) && raw >= 1 ? Math.min(5, Math.floor(raw)) : 3;
}

function overloadBackoffMs(attempt: number, resp: Response): number {
  // 尊重 Retry-After(秒)；否则指数退避 400ms·2^(n-1)，上限 2.5s。
  const ra = Number(resp.headers.get('retry-after'));
  if (Number.isFinite(ra) && ra > 0) return Math.min(5000, ra * 1000);
  return Math.min(2500, 400 * 2 ** (attempt - 1));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface OverloadFallbackResult {
  response: Response;
  /** resume 路径要用的「实际」上游(fallback 后会变 deepseek)。 */
  effectiveUrl: string;
  effectiveHeaders: Headers;
  effectiveBody: string | null;
  usedFallback: boolean;
}

/**
 * 单次上游请求 + 网络错误兜底成 502 Response(调用方统一查 .ok)。
 * 不消费 body —— 成功/流式响应原样回。
 */
async function fetchUpstreamOnce(
  url: string,
  headers: Headers,
  body: string | null,
  method: string,
  isStreaming: boolean,
  endpoint: string,
): Promise<Response> {
  const ac = new AbortController();
  const timeoutId = setTimeout(() => ac.abort(), getTimeoutMs());
  try {
    return await fetch(
      url,
      withLlmProxyStreamingDispatcher(
        { method, headers, body, signal: ac.signal, cache: 'no-store' } as RequestInit,
        isStreaming,
      ),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ endpoint, url, error: msg }, 'Upstream fetch failed');
    return new Response(
      JSON.stringify({ error: { message: `LLM gateway unreachable: ${msg}`, type: 'proxy_error' } }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 主路 fetch + 过载重试 + DeepSeek fallback。返回最终 Response 及 resume 要用的
 * effective(url/headers/body)。过载的中间响应会被 drain(小 JSON,非流),最终
 * 返回的响应**不** drain(调用方可读 body / 转发流)。
 */
// ============================================================================
// Provider chain fallback (release202/07)
// ============================================================================
//
// Generalizes the single primary→deepseek overload fallback above into an
// ordered, config-driven chain of upstream sources (source1 → source2 → …,
// unbounded). Walks the chain trying each source; on a retriable failure
// (§3.2 of doc 07) drops to the next. Decision 1: a vision-capable initial
// model prunes non-vision fallback sources. Decision 2: streaming only falls
// back at the response-head stage (a started stream is discarded, not spliced).
// Decision 3: each source declares its own defaultModel for fallback.

/** Per-source resolved request spec for one chain hop. */
interface SourceSpec {
  id: string;
  url: string; // baseUrl + endpoint
  token: string; // bearer WITHOUT sk- prefix (buildUpstreamHeaders re-adds it)
  model?: string; // model to send for this source (undefined → keep body's model)
  /** true when this source coerced the model (guard/fallback) — caller may warn. */
  modelCoerced: boolean;
}

/** Why a resolved source was excluded from the runnable chain. */
type DropReason = 'missing-key' | 'no-base-url';
interface DroppedSource {
  id: string;
  reason: DropReason;
}

/**
 * Outcome of resolving a chain into runnable specs. `dropped` carries the
 * sources that were excluded (and why) so the caller can surface a precise
 * `provider_chain_unconfigured` error instead of silently degrading to another
 * provider (release202/07 fix — see buildSourceSpecs).
 */
interface ChainBuild {
  specs: SourceSpec[];
  dropped: DroppedSource[];
  chainId: string;
}

/**
 * Decide whether an upstream failure should fall through to the NEXT source.
 * Retriable: network/502, 429/503 overload, 5xx (incl. newapi `do_request_failed`),
 * 404 model-not-found, and 400s that are clearly model/capability rejections.
 * NOT retriable: 401/403 auth (next source won't fix creds), generic 400.
 */
function shouldChainFallback(status: number, errText: string): boolean {
  if (status >= 200 && status < 300) return false;
  if (status === 401 || status === 403) return false;
  if (status === 400) {
    return /model|not[ _-]?found|unsupported|unknown variant|image_url|does not exist|no such/i.test(errText);
  }
  if (status === 404) return true;
  if (status >= 500 || status === 429) return true;
  return false;
}

/** Default chain when the caller passes none: legacy env-bypass still honored. */
function defaultChainId(): string {
  return process.env.DEEPSEEK_BYPASS_ENABLED === 'true' ? 'deepseek' : 'default';
}

/** Pick the model to send to a given source (decision 3 + modelGuardPrefix). */
function modelForSource(
  source: ResolvedSource,
  requestModel: unknown,
  isPrimary: boolean,
): { model: string | undefined; coerced: boolean } {
  const req = typeof requestModel === 'string' && requestModel.length > 0 ? requestModel : undefined;
  if (req && source.modelMap?.[req]) return { model: source.modelMap[req], coerced: source.modelMap[req] !== req };
  const guardOk = !source.modelGuardPrefix || (req ? req.toLowerCase().startsWith(source.modelGuardPrefix.toLowerCase()) : false);
  if (isPrimary && req && guardOk) return { model: req, coerced: false };
  // Fallback hop, missing model, or guard-rejected → use the source's default.
  const fallback = source.defaultModel ?? (guardOk ? req : undefined);
  return { model: fallback, coerced: fallback !== req };
}

/**
 * Resolve a chain id into ordered, ready-to-fetch per-source specs (token +
 * url + model). Static sources with a missing key are dropped (recorded in
 * `dropped` with a reason). Images collapse to the first per-user (newapi)
 * source — only newapi serves images.
 *
 * release202/07 fix — this used to SILENTLY re-route an explicitly-requested
 * but fully-unservable chain to the platform `default` (newapi). That masked
 * misconfiguration: a deepseek-pinned agent whose DEEPSEEK_API_KEY was absent
 * on the env got served by newapi with a `deepseek-*` model id newapi can't
 * serve → opaque upstream 500, three retries, error string dumped as the
 * agent's reply. We now return the empty `specs` + the `dropped` reasons and
 * let the caller surface a precise `provider_chain_unconfigured` error.
 */
async function buildSourceSpecs(args: {
  chainId: string;
  endpoint: string;
  endpointKind: EndpointKind;
  userId: string;
  requestModel: unknown;
}): Promise<ChainBuild> {
  const { chainId, endpoint, endpointKind, userId, requestModel } = args;
  let chain = resolveChain(chainId);
  if (endpointKind === 'images') {
    chain = chain.filter((s) => s.tokenMode === 'per-user').slice(0, 1);
    if (chain.length === 0) chain = resolveChain('newapi');
  } else {
    chain = applyVisionFilter(chain, requestModel);
  }

  const specs: SourceSpec[] = [];
  const dropped: DroppedSource[] = [];
  for (const source of chain) {
    if (!source.baseUrl) {
      dropped.push({ id: source.id, reason: 'no-base-url' });
      continue;
    }
    let token: string;
    if (source.tokenMode === 'per-user') {
      token = await resolveNewAPIToken(userId);
    } else {
      const raw = source.apiKeyEnv ? process.env[source.apiKeyEnv] : undefined;
      if (!raw) {
        dropped.push({ id: source.id, reason: 'missing-key' }); // static source, no key — unusable
        continue;
      }
      token = raw.replace(/^sk-/, '');
    }
    // A source is the request-model-passthrough "primary" ONLY when it is the
    // first chain member AND no earlier member was dropped. A promoted fallback
    // (its intended primary was unusable) must coerce to its OWN default model,
    // never passthrough the dropped primary's model id — that passthrough is
    // exactly the `deepseek-v4-flash`→newapi 500 we're killing.
    const isPrimary = specs.length === 0 && dropped.length === 0;
    const { model, coerced } = modelForSource(source, requestModel, isPrimary);
    specs.push({ id: source.id, url: `${source.baseUrl}${endpoint}`, token, model, modelCoerced: coerced });
  }

  return { specs, dropped, chainId };
}

/** Reconstruct an error Response from already-read text (no stale content-length). */
function rebuildErrorResponse(status: number, errText: string, orig: Headers): Response {
  return new Response(errText, {
    status,
    headers: { 'content-type': orig.get('content-type') ?? 'application/json' },
  });
}

/**
 * Walk a provider chain. Returns the same shape as the legacy overload
 * fallback (so call sites + resume threading are unchanged). On success the
 * response body is NOT consumed (caller forwards/streams it); on a non-OK head
 * the small error JSON IS read to decide fallback and the returned Response is
 * a fresh rebuild so the caller can read it again.
 */
async function fetchUpstreamWithChainFallback(args: {
  specs: SourceSpec[];
  parsedBody: Record<string, unknown> | null;
  bodyStr: string | null;
  isStreaming: boolean;
  method: string;
  endpoint: string;
  requestHeaders: Headers;
}): Promise<OverloadFallbackResult> {
  const { specs, parsedBody, bodyStr, isStreaming, method, endpoint, requestHeaders } = args;
  const maxAttempts = getFallbackPrimaryAttempts();

  let lastResult: OverloadFallbackResult | null = null;

  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const isLast = i === specs.length - 1;
    const headers = buildUpstreamHeaders(requestHeaders, spec.token);
    // Rewrite the model for this source if it differs from the body's.
    let srcBody = bodyStr;
    if (parsedBody && spec.model && parsedBody.model !== spec.model) {
      srcBody = JSON.stringify({ ...parsedBody, model: spec.model });
      if (spec.modelCoerced) {
        log.warn(
          { event: 'llm.model.coerced', source: spec.id, requested: parsedBody.model, sent: spec.model },
          'llm-proxy: model coerced for source',
        );
      }
    } else if (parsedBody && !parsedBody.model && spec.model) {
      srcBody = JSON.stringify({ ...parsedBody, model: spec.model });
    }

    // Overload retry within this source before moving on.
    let resp: Response = await fetchUpstreamOnce(spec.url, headers, srcBody, method, isStreaming, endpoint);
    for (let attempt = 1; attempt < maxAttempts && isOverloadStatus(resp.status); attempt++) {
      const wait = overloadBackoffMs(attempt, resp);
      await resp.text().catch(() => {});
      log.warn(
        { event: 'llm.source.overload', source: spec.id, status: resp.status, attempt, maxAttempts, wait },
        'llm-proxy: source overloaded, retrying',
      );
      await sleep(wait);
      resp = await fetchUpstreamOnce(spec.url, headers, srcBody, method, isStreaming, endpoint);
    }

    if (resp.ok) {
      return { response: resp, effectiveUrl: spec.url, effectiveHeaders: headers, effectiveBody: srcBody, usedFallback: i > 0 };
    }

    const errText = await resp.text().catch(() => '');
    lastResult = {
      response: rebuildErrorResponse(resp.status, errText, resp.headers),
      effectiveUrl: spec.url,
      effectiveHeaders: headers,
      effectiveBody: srcBody,
      usedFallback: i > 0,
    };
    if (!isLast && shouldChainFallback(resp.status, errText)) {
      log.warn(
        { event: 'llm.chain.fallback', from: spec.id, to: specs[i + 1].id, status: resp.status },
        'llm-proxy: source failed → next in chain',
      );
      continue;
    }
    return lastResult;
  }

  return (
    lastResult ?? {
      response: new Response(
        JSON.stringify({ error: { message: 'no upstream source available', type: 'proxy_error' } }),
        { status: 502, headers: { 'Content-Type': 'application/json' } },
      ),
      effectiveUrl: '',
      effectiveHeaders: requestHeaders,
      effectiveBody: bodyStr,
      usedFallback: false,
    }
  );
}

// ============================================================================
// release202/12 (P6) — upstream request header ALLOWLIST
// ============================================================================
//
// Previously we forwarded EVERY inbound header except a small strip set. That
// leaked arbitrary caller headers (Cookie, X-Api-Key, custom auth, internal
// routing) straight to the upstream gateway URL — combined with a poisoned
// baseUrl that's an SSRF / credential-exfil surface. We now forward ONLY the
// headers an OpenAI-compatible upstream actually needs and ADD the bearer
// ourselves (unchanged auth swap below).
//
// Rationale per entry:
//   content-type / accept / accept-encoding — standard HTTP content negotiation.
//   user-agent — upstreams (and their WAFs) log/route on it; harmless to keep.
//   openai-organization / openai-project / openai-beta — OpenAI routing/feature
//     selectors a compatible client may legitimately set.
// Intentionally NOT forwarded:
//   authorization / x-api-key / cookie — auth is swapped to the upstream token
//     below; forwarding the caller's would leak it.
//   x-prismer-* (idempotency-key, task-run-id, trace-id) — internal; read by the
//     proxy itself BEFORE forwarding (see proxyToNewAPI), never needed upstream.
//   x-stainless-* (OpenAI SDK telemetry) — telemetry only; dropped to keep the
//     forwarded surface tight.
const UPSTREAM_HEADER_ALLOWLIST = new Set([
  'content-type',
  'accept',
  'accept-encoding',
  'user-agent',
  'openai-organization',
  'openai-project',
  'openai-beta',
]);

// Headers to strip from upstream response before returning to client
const STRIP_RESPONSE_HEADERS = new Set(['transfer-encoding', 'connection', 'keep-alive']);

// ============================================================================
// Main proxy function
// ============================================================================

/** Endpoint kind detected from the upstream path. */
type EndpointKind = 'chat' | 'embeddings' | 'images' | 'other';

function detectEndpointKind(endpoint: string): EndpointKind {
  if (endpoint.includes('/images/generations')) return 'images';
  if (endpoint.includes('/embeddings')) return 'embeddings';
  if (endpoint.includes('/chat/completions')) return 'chat';
  return 'other';
}

/** Subset of an images.generations request we keep around for billing. */
interface ImageRequestContext {
  model: string;
  size: string;
  n: number;
}

function extractImageRequest(parsed: unknown): ImageRequestContext {
  const p = (parsed ?? {}) as Record<string, unknown>;
  const model = typeof p.model === 'string' && p.model ? p.model : 'unknown';
  const size = typeof p.size === 'string' && p.size ? p.size : '1024x1024';
  const nRaw = typeof p.n === 'number' ? p.n : 1;
  const n = Math.max(1, Math.min(10, Math.floor(nRaw)));
  return { model, size, n };
}

/**
 * Proxy an OpenAI-compatible request to NewAPI.
 *
 * @param request        - Incoming Next.js request
 * @param guard          - Validated auth from apiGuard
 * @param endpoint       - Upstream path, e.g. '/v1/chat/completions'
 * @param forceProvider  - Optional per-call override. `'deepseek'` forces the
 *                         DeepSeek bypass on regardless of env;
 *                         `'newapi'` forces it off regardless of env;
 *                         `undefined` keeps the legacy env-driven behaviour.
 *                         The per-agent proxy alias route passes a value here.
 */
export async function proxyToNewAPI(
  request: NextRequest,
  guard: GuardResult,
  endpoint: string,
  chainId?: string,
): Promise<Response> {
  await ensureNacosConfig();

  // release202/07 — provider chain. `chainId` selects an ordered list of
  // upstream sources (source1 → source2 → …) from the config registry; the
  // proxy walks it, falling through on retriable failures. Legacy callers pass
  // 'newapi' / 'deepseek' (back-compat single-element chains); `undefined`
  // resolves to defaultChainId() (honors the legacy DEEPSEEK_BYPASS_ENABLED
  // env toggle). The actual source specs are built AFTER body parse below
  // because they need the request model (per-source model + vision filter).
  const endpointKind: EndpointKind = detectEndpointKind(endpoint);

  // Cleanup-2: idempotency cache check (chat + embeddings only — images use a
  // separate non-OpenAI-shape response, easier to skip than to special-case).
  // release202/12 (P5) — namespace the cache key by the resolved user so a
  // client-supplied idempotency header can NEVER read another tenant's cached
  // completion (the header value is attacker-controlled; without this prefix a
  // guessed/shared key replays + bills across users). Every downstream
  // readCache/writeCache derives from this namespaced value.
  const rawIdempotencyKey = request.headers.get(IDEMPOTENCY_HEADER);
  const idempotencyKey = rawIdempotencyKey ? `${guard.auth.userId}:${rawIdempotencyKey}` : null;
  if (idempotencyKey && endpointKind !== 'images') {
    const hit = await readCache(idempotencyKey);
    if (hit) {
      log.info(
        {
          key: idempotencyKey,
          model: hit.model,
          isStreaming: hit.isStreaming,
          chunks: hit.chunks?.length,
          usage: hit.usage,
        },
        'llm-proxy: cache hit — replaying buffered response (saved an upstream LLM call)',
      );
      return serveCacheHit(hit, guard, endpoint);
    }
  }

  // Prepare request body
  let body: string | null = null;
  let parsedBody: Record<string, unknown> | null = null;
  let isStreaming = false;
  let imageRequest: ImageRequestContext | null = null;

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    // Read body once to detect streaming and inject stream_options
    const rawBody = await request.text();
    try {
      const parsed = JSON.parse(rawBody);
      isStreaming = !!parsed.stream;
      // Inject stream_options for usage reporting in final SSE chunk.
      // chat-completions only — `stream_options.include_usage` is an OpenAI
      // Chat Completions param. The Responses API ('other') uses a different
      // streaming/usage shape, so injecting it would pollute the request body
      // (release202/03 §3.1 — Codex responses path).
      if (endpointKind === 'chat' && isStreaming && !parsed.stream_options?.include_usage) {
        parsed.stream_options = { ...parsed.stream_options, include_usage: true };
      }
      if (endpointKind === 'images') {
        imageRequest = extractImageRequest(parsed);
      }
      // release202/07 — model passthrough is now per-source: the chain walker
      // sends each source its own model (primary = the incoming model verbatim;
      // fallback hops use that source's defaultModel / modelGuardPrefix). No
      // silent override here — the body keeps exactly what the daemon/UI sent.
      parsedBody = parsed;
      body = JSON.stringify(parsed);
    } catch {
      // Non-JSON body (unlikely for LLM calls) — pass through as-is
      body = rawBody;
    }
  }

  // release202/07 — resolve the provider chain into ordered per-source specs.
  // Needs the parsed request model (per-source model selection + vision filter).
  const requestedChainId = chainId ?? defaultChainId();
  const build = await buildSourceSpecs({
    chainId: requestedChainId,
    endpoint,
    endpointKind,
    userId: guard.auth.userId,
    requestModel: parsedBody?.model,
  });
  const specs = build.specs;

  // Observability (debug-pipeline system-logs ring buffer): a requested chain
  // that resolved to ZERO usable sources is a config error, NOT a routing
  // decision — surface it loudly and return a precise error instead of
  // silently degrading to another provider/model. `event:` tags are greppable
  // via `scripts/debug/logs.ts --contains=llm.chain`.
  if (specs.length === 0) {
    log.error(
      {
        event: 'llm.chain.unservable',
        chainId: build.chainId,
        dropped: build.dropped,
        userId: guard.auth.userId,
        requestModel: typeof parsedBody?.model === 'string' ? parsedBody.model : null,
      },
      'llm-proxy: requested provider chain has no usable upstream source',
    );
    const detail = build.dropped.map((d) => `${d.id}: ${d.reason}`).join('; ') || 'no sources resolved';
    return new Response(
      JSON.stringify({
        error: {
          message: `Provider chain "${build.chainId}" has no usable upstream source (${detail}). Configure the source credentials (e.g. DEEPSEEK_API_KEY) or route the agent to a different chain.`,
          type: 'provider_chain_unconfigured',
        },
      }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Chain served, but with degraded membership (a pinned source was dropped) —
  // WARN so an operator sees the silently-missing source in the ring buffer.
  if (build.dropped.length > 0) {
    log.warn(
      {
        event: 'llm.chain.degraded',
        chainId: build.chainId,
        dropped: build.dropped,
        served: specs.map((s) => s.id),
      },
      'llm-proxy: provider chain served with dropped sources',
    );
  }

  const primaryUrl = specs[0]?.url ?? '';

  // Cache write key — only used when the caller passed an idempotency header
  // AND we're hitting an endpoint we know how to cache (chat / embeddings).
  const cacheWriteKey = endpointKind !== 'images' ? idempotencyKey : null;

  // ── Streaming chat path: delegate to resume-capable runner ──
  // (Embeddings is technically `isStreaming`-able but in practice always
  // returns a single JSON blob; if someone sends stream=true to embeddings,
  // the runner still works because resume only kicks in on disconnect.)
  if (isStreaming && parsedBody && endpointKind === 'chat') {
    return handleStreamingWithResume({
      specs,
      initialBody: parsedBody,
      guard,
      endpoint,
      cacheWriteKey,
      taskRunId: request.headers.get('x-prismer-task-run-id') ?? undefined,
      requestHeaders: request.headers,
    });
  }

  // ── Non-streaming + non-chat: forward via the chain walker ──
  log.info(
    {
      primaryUrl,
      chainLength: specs.length,
      isStreaming,
      bodyLength: body?.toString().length ?? 0,
      streamBodyTimeoutMs: isStreaming ? getLlmProxyStreamBodyTimeoutMs() : undefined,
    },
    'Forwarding to upstream',
  );

  const { response: upstream } = await fetchUpstreamWithChainFallback({
    specs,
    bodyStr: body,
    parsedBody,
    isStreaming,
    method: request.method,
    endpoint,
    requestHeaders: request.headers,
  });
  log.info({ status: upstream.status, isStreaming }, 'Upstream responded');

  // Handle error responses from upstream (pass through as-is)
  if (!upstream.ok && !isStreaming) {
    const errorBody = await upstream.text();
    return new Response(errorBody, {
      status: upstream.status,
      headers: buildResponseHeaders(upstream.headers),
    });
  }

  // Route to streaming or non-streaming handler
  if (isStreaming) {
    // Streaming + non-chat (e.g. embeddings with stream=true) — keep the
    // legacy passthrough handler; resume isn't meaningful for these.
    return handleStreaming(upstream, guard, endpoint, cacheWriteKey);
  }
  if (endpointKind === 'images') {
    return handleImageGeneration(upstream, guard, endpoint, imageRequest);
  }
  return handleNonStreaming(upstream, guard, endpoint, cacheWriteKey);
}

// ============================================================================
// Streaming chat with resume-on-disconnect
// ============================================================================
//
// Wraps the upstream fetch + SSE forward loop in `streamWithResume`. The
// runner owns retries: on non-terminal upstream disconnect it re-POSTs with
// the original body + assistant prefill carrying whatever content we already
// streamed downstream. The client sees one continuous SSE stream.
//
// Usage extraction + idempotency cache writes still happen here: the runner
// invokes our `onEvent` callback for every successfully parsed SSE frame so
// we can mirror the legacy `handleStreaming` accounting.

interface StreamingWithResumeArgs {
  /** release202/07 — ordered provider chain; first-attempt walks it for fallback. */
  specs: SourceSpec[];
  initialBody: Record<string, unknown>;
  guard: GuardResult;
  endpoint: string;
  cacheWriteKey: string | null;
  taskRunId?: string;
  /** 原始请求头,用于构造每个 source 的 upstream headers。 */
  requestHeaders: Headers;
}

async function handleStreamingWithResume(args: StreamingWithResumeArgs): Promise<Response> {
  const { specs, guard, endpoint, cacheWriteKey, taskRunId, requestHeaders } = args;
  // upstream 三要素由 chain walker 选定的 winning source 决定;resume runner 用
  // effective 值重开同一 source(decision 2: 已开始的流不再换 source)。
  let upstreamUrl = specs[0]?.url ?? '';
  let headers = buildUpstreamHeaders(requestHeaders, specs[0]?.token ?? '');
  let initialBody = args.initialBody;

  let extractedUsage: LLMUsage | null = null;
  let extractedModel = 'unknown';
  const cacheChunks: string[] = [];
  // Track upstream content-type from the FIRST successful response so we can
  // mirror it in the client-facing Response. We resolve these BEFORE building
  // the Response by running the initial fetch eagerly below, then passing
  // the already-open upstream into the runner for the first attempt.
  let upstreamContentType = 'text/event-stream; charset=utf-8';
  let upstreamStatus = 200;
  // Track if any upstream attempt returned a non-OK status — we only cache 2xx.
  let upstreamWasOk = true;

  log.info(
    {
      upstreamUrl,
      streamBodyTimeoutMs: getLlmProxyStreamBodyTimeoutMs(),
      taskRunId,
    },
    'Forwarding to upstream (streaming with resume)',
  );

  // Run the FIRST upstream attempt eagerly so we have the real status +
  // content-type to thread into the client Response. Any non-OK status →
  // surface as a direct error response (no resume — resume is only for
  // mid-stream disconnects after we've started forwarding bytes).
  let firstUpstreamConsumed = false;
  let firstUpstream: Response;
  {
    // 首发走 chain walker：逐 source 尝试，命中可重试错误就跳下一个。winning
    // source 的 effective url/headers/body 写回,后续 resume 重开同一 source。
    const attempt = await fetchUpstreamWithChainFallback({
      specs,
      bodyStr: JSON.stringify(initialBody),
      parsedBody: initialBody,
      isStreaming: true,
      method: 'POST',
      endpoint,
      requestHeaders,
    });
    firstUpstream = attempt.response;
    upstreamUrl = attempt.effectiveUrl;
    headers = attempt.effectiveHeaders;
    try {
      initialBody = JSON.parse(attempt.effectiveBody ?? '{}') as Record<string, unknown>;
    } catch {
      /* keep original initialBody if reparse fails */
    }
    upstreamStatus = firstUpstream.status;
    upstreamContentType = firstUpstream.headers.get('content-type') || 'text/event-stream; charset=utf-8';
    if (!firstUpstream.ok) {
      upstreamWasOk = false;
      // For non-OK responses on the initial attempt, mirror legacy behaviour
      // and pass the body through verbatim (no resume).
      const errBody = await firstUpstream.text();
      return new Response(errBody, {
        status: firstUpstream.status,
        headers: buildResponseHeaders(firstUpstream.headers),
      });
    }
  }

  const stream = streamWithResume({
    initialBody,
    kind: 'openai-chat',
    ctx: { taskRunId, cacheKey: cacheWriteKey },
    openUpstream: async (body) => {
      // First call: consume the already-opened firstUpstream (saves a
      // redundant network round-trip). Subsequent calls are resumes —
      // re-open with the prefilled body.
      if (!firstUpstreamConsumed) {
        firstUpstreamConsumed = true;
        return {
          ok: firstUpstream.ok,
          status: firstUpstream.status,
          body: firstUpstream.body,
        };
      }
      const ac = new AbortController();
      const timeoutId = setTimeout(() => ac.abort(), getTimeoutMs());
      try {
        const resp = await fetch(
          upstreamUrl,
          withLlmProxyStreamingDispatcher(
            {
              method: 'POST',
              headers,
              body: JSON.stringify(body),
              signal: ac.signal,
              cache: 'no-store',
            } as RequestInit,
            true,
          ),
        );
        if (!resp.ok) upstreamWasOk = false;
        return { ok: resp.ok, status: resp.status, body: resp.body };
      } finally {
        clearTimeout(timeoutId);
      }
    },
    onEvent: (event) => {
      // Mirror legacy handleStreaming's usage + cache accounting. The runner
      // re-emits frames byte-for-byte (or, on dedupe, synthesises minimal
      // frames carrying just the kept content tail). For cache replay we
      // store the events as we saw them on the wire — close enough for
      // diagnostic replay; the live client already got the real bytes.
      if (cacheWriteKey) {
        cacheChunks.push(event + '\n\n');
      }
      for (const line of event.split('\n')) {
        if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
        try {
          const parsed = JSON.parse(line.slice(6));
          if (parsed.model) extractedModel = parsed.model;
          if (parsed.usage) extractedUsage = parsed.usage;
        } catch {
          /* partial JSON */
        }
      }
    },
  });

  // Tee the stream so we can observe close-of-stream for billing without
  // blocking the client-facing forward path. Easier alternative: attach a
  // TransformStream that records on flush. We use a manual pipe via a
  // ReadableStream wrapper.
  const reader = stream.getReader();
  const teedStream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          if (extractedUsage) {
            recordLLMUsage(guard, extractedModel, extractedUsage, endpoint);
          } else {
            log.warn({ endpoint, taskRunId }, 'Streaming-with-resume ended without usage data — billing skipped');
          }
          if (cacheWriteKey && upstreamWasOk) {
            const entry: LLMCacheEntry = {
              status: upstreamStatus,
              isStreaming: true,
              contentType: upstreamContentType,
              chunks: cacheChunks,
              usage: usageForCache(extractedUsage),
              model: extractedModel,
              cachedAt: new Date().toISOString(),
              upstream: extractedModel,
            };
            void writeCache(cacheWriteKey, entry);
          }
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        log.warn({ error: String(err), taskRunId }, 'Stream-with-resume tee error — closing');
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });

  const responseHeaders = new Headers();
  responseHeaders.set('content-type', upstreamContentType);
  responseHeaders.set('cache-control', 'no-cache');
  responseHeaders.set('x-accel-buffering', 'no');

  return new Response(teedStream, {
    status: upstreamStatus,
    headers: responseHeaders,
  });
}

// ============================================================================
// Image generation response (non-streaming only)
// ============================================================================

async function handleImageGeneration(
  upstream: Response,
  guard: GuardResult,
  endpoint: string,
  request: ImageRequestContext | null,
): Promise<Response> {
  const bodyText = await upstream.text();

  if (upstream.ok && request) {
    try {
      const parsed = JSON.parse(bodyText);
      // OpenAI Images shape: { created, data: [{ url|b64_json, revised_prompt? }] }
      // NewAPI sometimes echoes `usage` for tokenized image models — capture if present.
      const n = Array.isArray(parsed?.data) ? parsed.data.length : request.n;
      const upstreamCostUsd = typeof parsed?.usage?.cost_usd === 'number' ? parsed.usage.cost_usd : undefined;
      recordImageUsage(guard, request.model, { n, size: request.size, upstreamCostUsd }, endpoint);
    } catch {
      log.warn({ endpoint }, 'Failed to parse image-gen response body');
    }
  }

  return new Response(bodyText, {
    status: upstream.status,
    headers: buildResponseHeaders(upstream.headers),
  });
}

// ============================================================================
// Non-streaming response
// ============================================================================

async function handleNonStreaming(
  upstream: Response,
  guard: GuardResult,
  endpoint: string,
  cacheWriteKey: string | null,
): Promise<Response> {
  const bodyText = await upstream.text();
  const responseHeaders = buildResponseHeaders(upstream.headers);

  // Best-effort usage extraction for billing + cache population
  let extractedUsage: LLMUsage | undefined;
  let extractedModel = 'unknown';
  try {
    const parsed = JSON.parse(bodyText);
    if (parsed.usage) {
      extractedModel = parsed.model || 'unknown';
      extractedUsage = parsed.usage as LLMUsage;
      recordLLMUsage(guard, extractedModel, extractedUsage, endpoint);
    }
  } catch {
    log.warn({ endpoint }, 'Failed to extract usage from non-streaming response');
  }

  // Cleanup-2 cache write — only on 2xx so we don't memoize transient upstream
  // errors (a crash-resume should be free to retry on a fresh 5xx).
  if (cacheWriteKey && upstream.ok) {
    const entry: LLMCacheEntry = {
      status: upstream.status,
      isStreaming: false,
      contentType: responseHeaders.get('content-type') || 'application/json',
      body: bodyText,
      usage: usageForCache(extractedUsage),
      model: extractedModel,
      cachedAt: new Date().toISOString(),
      upstream: extractedModel,
    };
    void writeCache(cacheWriteKey, entry);
  }

  return new Response(bodyText, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

// ============================================================================
// Streaming response (SSE)
// ============================================================================

async function handleStreaming(
  upstream: Response,
  guard: GuardResult,
  endpoint: string,
  cacheWriteKey: string | null,
): Promise<Response> {
  if (!upstream.body) {
    return new Response(null, { status: 502 });
  }

  let extractedUsage: LLMUsage | null = null;
  let extractedModel = 'unknown';
  let lineBuffer = '';
  // Cleanup-2: buffer raw SSE bytes for the cache write. We only commit
  // after `done` succeeds — partial streams from a flaky upstream don't
  // poison the cache. Bounded by upstream's own response size; for a typical
  // 4-8KB chat completion the buffer is ~10KB peak.
  const cacheChunks: string[] = [];
  const decoderForCache = new TextDecoder();

  // Use ReadableStream constructor for maximum compatibility with Next.js
  const reader = upstream.body.getReader();
  // 2026-05-24 — every previous "Stream read error: Controller is already
  // closed" warning traces to one of two races:
  //   1. consumer cancels the ReadableStream → the `cancel()` callback
  //      below runs reader.cancel(), the still-pending reader.read() in
  //      `pull` rejects, we hit the catch and called controller.close()
  //      a second time (first close happened during the cancel transition).
  //   2. `done` branch closed the controller and `pull` was re-invoked once
  //      more by the consumer; reader.read() returned done=true again,
  //      reached controller.close() a second time.
  // A single flag + `safeClose` covers both — close once, ignore the rest.
  // Also short-circuits any further reader.read() / enqueue once the
  // downstream consumer is gone so we don't keep pulling from upstream.
  let streamClosed = false;
  const safeClose = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (streamClosed) return;
    streamClosed = true;
    try {
      controller.close();
    } catch {
      /* close can throw if the consumer cancelled between the flag check
         and the call — treat the same as already-closed. */
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (streamClosed) return;
      try {
        const { done, value } = await reader.read();
        if (streamClosed) return; // consumer disconnected mid-read
        if (done) {
          // Process remaining buffer
          if (lineBuffer) {
            for (const line of lineBuffer.split('\n')) {
              if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
              try {
                const parsed = JSON.parse(line.slice(6));
                if (parsed.model) extractedModel = parsed.model;
                if (parsed.usage) extractedUsage = parsed.usage;
              } catch {
                /* skip */
              }
            }
          }
          if (extractedUsage) {
            recordLLMUsage(guard, extractedModel, extractedUsage, endpoint);
          } else {
            log.warn({ endpoint }, 'Streaming ended without usage data — billing skipped');
          }
          // Cleanup-2: commit the buffered stream to Redis. Fire-and-forget;
          // a Redis hiccup must not break the live response we already
          // streamed to the client.
          if (cacheWriteKey && upstream.ok) {
            const entry: LLMCacheEntry = {
              status: upstream.status,
              isStreaming: true,
              contentType:
                buildResponseHeaders(upstream.headers).get('content-type') || 'text/event-stream; charset=utf-8',
              chunks: cacheChunks,
              usage: usageForCache(extractedUsage),
              model: extractedModel,
              cachedAt: new Date().toISOString(),
              upstream: extractedModel,
            };
            void writeCache(cacheWriteKey, entry);
          }
          safeClose(controller);
          return;
        }

        // Always forward immediately
        controller.enqueue(value);
        // Cleanup-2: also push the same bytes (as text) into the cache buffer.
        // We decode once with the streaming flag so multi-byte UTF-8 splits
        // across chunk boundaries are preserved; the final flush in the
        // `done` branch above will already have consumed everything.
        if (cacheWriteKey) {
          try {
            cacheChunks.push(decoderForCache.decode(value, { stream: true }));
          } catch {
            /* non-critical — drop cache on decode failure */
          }
        }

        // Best-effort: scan for usage data
        try {
          const text = new TextDecoder().decode(value);
          lineBuffer += text;
          const lines = lineBuffer.split('\n');
          lineBuffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
            try {
              const parsed = JSON.parse(line.slice(6));
              if (parsed.model) extractedModel = parsed.model;
              if (parsed.usage) extractedUsage = parsed.usage;
            } catch {
              /* skip partial JSON */
            }
          }
        } catch {
          /* non-critical */
        }
      } catch (err) {
        // Only warn when this wasn't an expected consumer-cancel. The flag
        // is set by `cancel()` below before reader.cancel() throws the read
        // out of pending, so by the time we land here it's already true.
        if (!streamClosed) {
          log.warn({ error: String(err) }, 'Stream read error');
        }
        safeClose(controller);
      }
    },
    cancel() {
      streamClosed = true;
      reader.cancel().catch(() => {});
    },
  });

  const responseHeaders = buildResponseHeaders(upstream.headers);
  // Ensure proper SSE headers for streaming
  if (!responseHeaders.has('content-type')) {
    responseHeaders.set('content-type', 'text/event-stream; charset=utf-8');
  }

  return new Response(stream, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

// ============================================================================
// Billing helper
// ============================================================================

function recordImageUsage(guard: GuardResult, model: string, usage: ImageUsage, endpoint: string): void {
  try {
    const cost = calculateImageCredits(model, usage);

    const record: UsageRecordRequest = {
      task_id: generateTaskId('img'),
      task_type: 'image_generation',
      input: {
        type: 'query',
        value: `${endpoint} model=${model} size=${cost.size} n=${cost.n}`,
      },
      metrics: {
        tokens_input: 0,
        tokens_output: 0,
        processing_time_ms: 0,
      },
      cost: {
        compression_credits: cost.credits,
        total_credits: cost.credits,
      },
    };

    // release202/12 (P2b) — pass the already-resolved guard.auth.userId so the
    // local-credit deduction books spend to the SAME identity apiGuard validated
    // (and minted the upstream token with), not a re-parse of the auth header.
    recordUsageBackground(record, guard.auth.authHeader, guard.auth.userId);

    log.info(
      {
        userId: guard.auth.userId,
        model,
        n: cost.n,
        size: cost.size,
        upstreamCostUsd: cost.upstreamCostUsd,
        credits: cost.credits,
      },
      'Image-gen usage recorded',
    );
  } catch (err) {
    log.error({ error: String(err) }, 'Failed to record image-gen usage');
  }
}

function recordLLMUsage(guard: GuardResult, model: string, usage: LLMUsage, endpoint: string, cached = false): void {
  try {
    const cost = calculateLLMCredits(model, usage);
    // release202/12 (P8) — a cache hit means an idempotency replay (crash-resume
    // re-fires the SAME logical call). The cache exists precisely to PREVENT
    // double-billing, so a hit must book ZERO credits — only a usage record for
    // analytics/"work happened", not a second charge. Tokens are kept for the
    // analytics tally; the `cached=true` stamp lets finance see it was free.
    const billedCredits = cached ? 0 : cost.credits;

    const record: UsageRecordRequest = {
      task_id: generateTaskId(cached ? 'llm-cached' : 'llm'),
      task_type: 'llm_proxy',
      input: {
        type: 'query',
        value: `${endpoint} model=${model}${cached ? ' cached=true' : ''}`,
      },
      metrics: {
        tokens_input: cost.promptTokens,
        tokens_output: cost.completionTokens,
        processing_time_ms: 0,
      },
      cost: {
        compression_credits: billedCredits,
        total_credits: billedCredits,
      },
    };

    // release202/12 (P2b) — single identity source: book to guard.auth.userId.
    recordUsageBackground(record, guard.auth.authHeader, guard.auth.userId);

    log.info(
      {
        userId: guard.auth.userId,
        model,
        promptTokens: cost.promptTokens,
        completionTokens: cost.completionTokens,
        credits: billedCredits,
        cached,
      },
      cached ? 'LLM usage recorded (from cache hit — 0 credits)' : 'LLM usage recorded',
    );
  } catch (err) {
    log.error({ error: String(err) }, 'Failed to record LLM usage');
  }
}

// ============================================================================
// Header utilities
// ============================================================================

function buildUpstreamHeaders(incoming: Headers, newApiToken: string): Headers {
  // release202/12 (P6) — allowlist (NOT strip-list): forward only known-safe
  // upstream headers, then add our bearer. See UPSTREAM_HEADER_ALLOWLIST.
  const headers = new Headers();
  for (const [key, value] of incoming.entries()) {
    if (UPSTREAM_HEADER_ALLOWLIST.has(key.toLowerCase())) headers.set(key, value);
  }
  headers.set('Authorization', `Bearer sk-${newApiToken}`);
  return headers;
}

function buildResponseHeaders(upstream: Headers): Headers {
  const headers = new Headers();
  for (const [key, value] of upstream.entries()) {
    if (STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
    headers.set(key, value);
  }
  return headers;
}

// ============================================================================
// Test-only exports (Cleanup-2 idempotency cache)
// ============================================================================
//
// Exposed for src/lib/__tests__/llm-proxy-idempotency.test.ts. Not part of
// the public proxy surface — production code paths consume these helpers
// internally via proxyToNewAPI.
export const __test = {
  readCache,
  writeCache,
  serveCacheHit,
  usageForCache,
  buildSourceSpecs,
  shouldChainFallback,
  buildUpstreamHeaders,
};
