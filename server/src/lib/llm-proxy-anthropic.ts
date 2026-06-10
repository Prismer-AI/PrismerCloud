/**
 * LLM Proxy — Anthropic protocol thin pipe to NewAPI gateway
 *
 * Mirrors src/lib/llm-proxy.ts for Anthropic /v1/messages:
 *   1. Auth swap on x-api-key (or Authorization Bearer) → NewAPI x-api-key
 *   2. Body byte-pipe with stream-detection peek (no semantic parsing)
 *   3. SSE event names differ (message_start / content_block_start /
 *      content_block_delta / content_block_stop / message_delta / message_stop /
 *      ping) — passed through verbatim
 *   4. Usage extraction: Anthropic { input_tokens, output_tokens } via
 *      extractAnthropicUsage()
 *   5. (Cleanup-3, 2026-05-25) LLM-call-level idempotency cache shared with
 *      the OpenAI proxy via `llm-proxy-cache.ts`. Same `x-prismer-idempotency-key`
 *      header, same Redis namespace `llm-cache:`, same 24h TTL. On daemon
 *      crash + cloud re-dispatch, a cache hit replays the buffered SSE
 *      events byte-for-byte and re-records usage with `cached=true` so finance
 *      can subtract idempotency-cache hits from the real Anthropic spend.
 */

import { NextRequest } from 'next/server';
import { ensureNacosConfig } from '@/lib/nacos-config';
import { createModuleLogger } from '@/lib/logger';
import { resolveNewAPIToken } from '@/lib/newapi-admin';
import { calculateLLMCredits, extractAnthropicUsage, type LLMUsage } from '@/lib/llm-pricing';
import { recordUsageBackground, generateTaskId, type UsageRecordRequest } from '@/lib/usage-recorder';
import { IDEMPOTENCY_HEADER, readCache, writeCache, usageForCache, type LLMCacheEntry } from '@/lib/llm-proxy-cache';
import {
  getLlmProxyStreamBodyTimeoutMs,
  getLlmProxyTimeoutMs,
  withLlmProxyStreamingDispatcher,
} from '@/lib/llm-proxy-upstream';
import { streamWithResume } from '@/lib/llm-proxy-stream-resume';
import type { GuardResult } from '@/lib/api-guard';

const log = createModuleLogger('LLMProxyAnthropic');

function getNewAPIBaseUrl(): string {
  const url = process.env.NEWAPI_ANTHROPIC_BASE_URL || process.env.NEWAPI_BASE_URL;
  if (!url) throw new Error('[LLMProxyAnthropic] NEWAPI_BASE_URL not configured');
  return url.replace(/\/$/, '');
}

function getTimeoutMs(): number {
  return getLlmProxyTimeoutMs();
}

// ============================================================================
// release202/12 (P6) — upstream request header ALLOWLIST (Anthropic flavour)
// ============================================================================
//
// Mirrors the OpenAI proxy's allowlist (see llm-proxy.ts) but adds the
// Anthropic-protocol headers a /v1/messages upstream needs. Forward ONLY these,
// then set the upstream x-api-key ourselves (auth swap unchanged below).
//
// Anthropic-specific entries:
//   anthropic-version — REQUIRED by the Messages API; dropping it 400s the call.
//   anthropic-beta — opt-in beta features (e.g. prompt caching, long context);
//     a legitimate caller selector, so forward it.
//   anthropic-dangerous-direct-browser-access — set by the official SDK in
//     browser mode; forward so SDK callers behave identically through the proxy.
// Intentionally NOT forwarded: authorization / x-api-key / cookie (swapped/leak),
// x-prismer-* (internal, read before forwarding), x-stainless-* (SDK telemetry).
const UPSTREAM_HEADER_ALLOWLIST = new Set([
  'content-type',
  'accept',
  'accept-encoding',
  'user-agent',
  'anthropic-version',
  'anthropic-beta',
  'anthropic-dangerous-direct-browser-access',
]);
const STRIP_RESPONSE_HEADERS = new Set(['transfer-encoding', 'connection', 'keep-alive']);

/**
 * Serve a cache hit as a Response. Replays SSE chunks (streaming) or the
 * raw body (non-streaming) and re-records the usage with `cached=true` so
 * finance dashboards can subtract these from the real Anthropic spend tally.
 */
function serveCacheHit(entry: LLMCacheEntry, guard: GuardResult, endpoint: string): Response {
  if (entry.usage) {
    const usage: LLMUsage = {
      prompt_tokens: entry.usage.promptTokens ?? 0,
      completion_tokens: entry.usage.completionTokens ?? 0,
      total_tokens: entry.usage.totalTokens ?? (entry.usage.promptTokens ?? 0) + (entry.usage.completionTokens ?? 0),
    };
    recordUsage(guard, entry.model || 'unknown', usage, endpoint, true);
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

export async function proxyAnthropicToNewAPI(
  request: NextRequest,
  guard: GuardResult,
  endpoint: string,
): Promise<Response> {
  await ensureNacosConfig();

  const newApiToken = await resolveNewAPIToken(guard.auth.userId);
  const upstreamUrl = `${getNewAPIBaseUrl()}${endpoint}`;

  // Cleanup-3: idempotency cache check — mirrors the OpenAI proxy. Anthropic
  // /v1/messages is the only endpoint we proxy, so no endpoint-kind gating.
  // release202/12 (P5) — namespace by resolved user; see llm-proxy.ts rationale.
  const rawIdempotencyKey = request.headers.get(IDEMPOTENCY_HEADER);
  const idempotencyKey = rawIdempotencyKey ? `${guard.auth.userId}:${rawIdempotencyKey}` : null;
  if (idempotencyKey) {
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
        'llm-proxy-anthropic: cache hit — replaying buffered response (saved an upstream Anthropic call)',
      );
      return serveCacheHit(hit, guard, endpoint);
    }
  }

  const headers = buildUpstreamHeaders(request.headers, newApiToken);

  let body: string | null = null;
  let parsedBody: Record<string, unknown> | null = null;
  let isStreaming = false;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const rawBody = await request.text();
    try {
      const parsed = JSON.parse(rawBody);
      isStreaming = !!parsed.stream;
      parsedBody = parsed;
      body = rawBody;
    } catch {
      body = rawBody;
    }
  }

  // Cache write key — only used when the caller passed an idempotency header.
  const cacheWriteKey = idempotencyKey;

  // ── Streaming path: delegate to resume-capable runner ──
  if (isStreaming && parsedBody) {
    return handleAnthropicStreamingWithResume({
      upstreamUrl,
      headers,
      initialBody: parsedBody,
      guard,
      endpoint,
      cacheWriteKey,
      taskRunId: request.headers.get('x-prismer-task-run-id') ?? undefined,
    });
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), getTimeoutMs());
  log.info(
    {
      upstreamUrl,
      isStreaming,
      bodyLen: body?.length ?? 0,
      streamBodyTimeoutMs: isStreaming ? getLlmProxyStreamBodyTimeoutMs() : undefined,
    },
    'Forwarding Anthropic request',
  );

  let upstream: Response;
  try {
    upstream = await fetch(
      upstreamUrl,
      withLlmProxyStreamingDispatcher(
        {
          method: request.method,
          headers,
          body,
          signal: controller.signal,
          cache: 'no-store',
        } as RequestInit,
        isStreaming,
      ),
    );
  } catch (err) {
    clearTimeout(timeoutId);
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({ error: { message: `LLM gateway unreachable: ${msg}`, type: 'proxy_error' } }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (!upstream.ok && !isStreaming) {
    const errBody = await upstream.text();
    return new Response(errBody, { status: upstream.status, headers: buildResponseHeaders(upstream.headers) });
  }

  // Streaming with parseable body → resume-capable runner above. This path
  // only fires for non-parseable bodies (extremely rare for Anthropic).
  if (isStreaming) return handleAnthropicStreaming(upstream, guard, endpoint, cacheWriteKey);
  return handleAnthropicNonStreaming(upstream, guard, endpoint, cacheWriteKey);
}

// ============================================================================
// Streaming Anthropic with resume-on-disconnect
// ============================================================================
//
// Mirrors `handleStreamingWithResume` in the OpenAI proxy. On a non-terminal
// upstream disconnect, re-POSTs with the original body + assistant prefill.
// Anthropic supports prefill natively (and is in fact stricter than OpenAI:
// prefill content must NOT end with whitespace — `injectPrefill()` trims).

interface AnthropicStreamingWithResumeArgs {
  upstreamUrl: string;
  headers: Headers;
  initialBody: Record<string, unknown>;
  guard: GuardResult;
  endpoint: string;
  cacheWriteKey: string | null;
  taskRunId?: string;
}

async function handleAnthropicStreamingWithResume(args: AnthropicStreamingWithResumeArgs): Promise<Response> {
  const { upstreamUrl, headers, initialBody, guard, endpoint, cacheWriteKey, taskRunId } = args;

  let inputTokens: number | null = null;
  let outputTokens = 0;
  let model = 'unknown';
  const cacheChunks: string[] = [];
  let upstreamContentType = 'text/event-stream; charset=utf-8';
  let upstreamStatus = 200;
  let upstreamWasOk = true;

  log.info(
    {
      upstreamUrl,
      streamBodyTimeoutMs: getLlmProxyStreamBodyTimeoutMs(),
      taskRunId,
    },
    'Forwarding Anthropic request (streaming with resume)',
  );

  // Eager first attempt so we can thread real status + content-type into the
  // client Response. On non-OK, pass through verbatim (no resume).
  let firstUpstreamConsumed = false;
  let firstUpstream: Response;
  {
    const ac = new AbortController();
    const timeoutId = setTimeout(() => ac.abort(), getTimeoutMs());
    try {
      firstUpstream = await fetch(
        upstreamUrl,
        withLlmProxyStreamingDispatcher(
          {
            method: 'POST',
            headers,
            body: JSON.stringify(initialBody),
            signal: ac.signal,
            cache: 'no-store',
          } as RequestInit,
          true,
        ),
      );
    } catch (err) {
      clearTimeout(timeoutId);
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ endpoint, error: msg, taskRunId }, 'Anthropic upstream fetch failed (streaming)');
      return new Response(
        JSON.stringify({
          error: { message: `LLM gateway unreachable: ${msg}`, type: 'proxy_error' },
        }),
        { status: 502, headers: { 'Content-Type': 'application/json' } },
      );
    } finally {
      clearTimeout(timeoutId);
    }
    upstreamStatus = firstUpstream.status;
    upstreamContentType = firstUpstream.headers.get('content-type') || 'text/event-stream; charset=utf-8';
    if (!firstUpstream.ok) {
      upstreamWasOk = false;
      const errBody = await firstUpstream.text();
      return new Response(errBody, {
        status: firstUpstream.status,
        headers: buildResponseHeaders(firstUpstream.headers),
      });
    }
  }

  const stream = streamWithResume({
    initialBody,
    kind: 'anthropic-chat',
    ctx: { taskRunId, cacheKey: cacheWriteKey },
    openUpstream: async (body) => {
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
      if (cacheWriteKey) cacheChunks.push(event + '\n\n');
      // Anthropic frames: `event: <name>` + `data: <json>`. Track input
      // tokens (message_start) + output tokens (message_delta) + model.
      const dataLine = event.split('\n').find((l) => l.startsWith('data: '));
      if (!dataLine) return;
      try {
        const parsed = JSON.parse(dataLine.slice(6)) as {
          type?: string;
          message?: { model?: string; usage?: { input_tokens?: number } };
          usage?: { output_tokens?: number };
        };
        if (parsed.type === 'message_start' && parsed.message?.usage) {
          inputTokens = parsed.message.usage.input_tokens ?? inputTokens;
          model = parsed.message.model || model;
        } else if (parsed.type === 'message_delta' && parsed.usage) {
          outputTokens = parsed.usage.output_tokens ?? outputTokens;
        }
      } catch {
        /* partial JSON */
      }
    },
  });

  const reader = stream.getReader();
  const teedStream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          if (inputTokens !== null) {
            recordUsage(
              guard,
              model,
              {
                prompt_tokens: inputTokens,
                completion_tokens: outputTokens,
                total_tokens: inputTokens + outputTokens,
              },
              endpoint,
            );
          } else {
            log.warn({ endpoint, taskRunId }, 'Anthropic streaming-with-resume ended without usage; billing skipped');
          }
          if (cacheWriteKey && upstreamWasOk) {
            const finalUsage: LLMUsage | null =
              inputTokens !== null
                ? {
                    prompt_tokens: inputTokens,
                    completion_tokens: outputTokens,
                    total_tokens: inputTokens + outputTokens,
                  }
                : null;
            const entry: LLMCacheEntry = {
              status: upstreamStatus,
              isStreaming: true,
              contentType: upstreamContentType,
              chunks: cacheChunks,
              usage: usageForCache(finalUsage),
              model,
              cachedAt: new Date().toISOString(),
              upstream: model,
            };
            void writeCache(cacheWriteKey, entry);
          }
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        log.warn({ error: String(err), taskRunId }, 'Anthropic stream-with-resume tee error — closing');
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

async function handleAnthropicNonStreaming(
  upstream: Response,
  guard: GuardResult,
  endpoint: string,
  cacheWriteKey: string | null,
): Promise<Response> {
  const text = await upstream.text();
  const responseHeaders = buildResponseHeaders(upstream.headers);

  let extractedUsage: LLMUsage | null = null;
  let extractedModel = 'unknown';
  try {
    const parsed = JSON.parse(text);
    extractedUsage = extractAnthropicUsage(parsed);
    extractedModel = (parsed as { model?: string }).model || 'unknown';
    if (extractedUsage) recordUsage(guard, extractedModel, extractedUsage, endpoint);
    else log.warn({ endpoint }, 'No usage in Anthropic non-streaming response');
  } catch {
    log.warn({ endpoint }, 'Failed to parse Anthropic non-streaming body for billing');
  }

  // Cleanup-3 cache write — only on 2xx so transient upstream errors don't
  // get memoised (a crash-resume should be free to retry on a fresh 5xx).
  if (cacheWriteKey && upstream.ok) {
    const entry: LLMCacheEntry = {
      status: upstream.status,
      isStreaming: false,
      contentType: responseHeaders.get('content-type') || 'application/json',
      body: text,
      usage: usageForCache(extractedUsage),
      model: extractedModel,
      cachedAt: new Date().toISOString(),
      upstream: extractedModel,
    };
    void writeCache(cacheWriteKey, entry);
  }

  return new Response(text, { status: upstream.status, headers: responseHeaders });
}

async function handleAnthropicStreaming(
  upstream: Response,
  guard: GuardResult,
  endpoint: string,
  cacheWriteKey: string | null,
): Promise<Response> {
  if (!upstream.body) return new Response(null, { status: 502 });

  let inputTokens: number | null = null;
  let outputTokens = 0;
  let model = 'unknown';
  let buf = '';
  // Cleanup-3: buffer raw SSE bytes for the cache write. We only commit
  // after `done` succeeds so partial streams from a flaky upstream don't
  // poison the cache. Anthropic message stream is typically 4-16KB so the
  // peak buffer is bounded by upstream's response size.
  const cacheChunks: string[] = [];
  const decoderForCache = new TextDecoder();

  const reader = upstream.body.getReader();
  // Match the OpenAI proxy's double-close safety pattern: consumer cancel +
  // reader.read() racing with the `done` branch can both call close() → second
  // call throws "Controller is already closed". Single flag + safeClose covers
  // both paths.
  let streamClosed = false;
  const safeClose = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (streamClosed) return;
    streamClosed = true;
    try {
      controller.close();
    } catch {
      /* consumer cancelled between flag check and call — treat as already-closed */
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (streamClosed) return;
      try {
        const { done, value } = await reader.read();
        if (streamClosed) return;
        if (done) {
          if (inputTokens !== null) {
            recordUsage(
              guard,
              model,
              {
                prompt_tokens: inputTokens,
                completion_tokens: outputTokens,
                total_tokens: inputTokens + outputTokens,
              },
              endpoint,
            );
          } else {
            log.warn({ endpoint }, 'Anthropic streaming ended without usage; billing skipped');
          }
          // Cleanup-3: commit the buffered stream to Redis. Fire-and-forget —
          // a Redis hiccup must not break the live response we already
          // streamed to the client.
          if (cacheWriteKey && upstream.ok) {
            const finalUsage: LLMUsage | null =
              inputTokens !== null
                ? {
                    prompt_tokens: inputTokens,
                    completion_tokens: outputTokens,
                    total_tokens: inputTokens + outputTokens,
                  }
                : null;
            const entry: LLMCacheEntry = {
              status: upstream.status,
              isStreaming: true,
              contentType:
                buildResponseHeaders(upstream.headers).get('content-type') || 'text/event-stream; charset=utf-8',
              chunks: cacheChunks,
              usage: usageForCache(finalUsage),
              model,
              cachedAt: new Date().toISOString(),
              upstream: model,
            };
            void writeCache(cacheWriteKey, entry);
          }
          safeClose(controller);
          return;
        }
        controller.enqueue(value);
        // Cleanup-3: also push the same bytes (as text) into the cache buffer
        // for byte-identical replay. Decode with streaming flag so multi-byte
        // UTF-8 splits across chunk boundaries are preserved.
        if (cacheWriteKey) {
          try {
            cacheChunks.push(decoderForCache.decode(value, { stream: true }));
          } catch {
            /* non-critical — drop cache on decode failure */
          }
        }
        try {
          buf += new TextDecoder().decode(value);
          const events = buf.split('\n\n');
          buf = events.pop() ?? '';
          for (const ev of events) {
            const dataLine = ev.split('\n').find((l) => l.startsWith('data: '));
            if (!dataLine) continue;
            try {
              const parsed = JSON.parse(dataLine.slice(6));
              // Anthropic SSE event names: message_start (initial usage +
              // model), content_block_start / _delta / _stop (text deltas),
              // message_delta (output_tokens running total + stop_reason),
              // message_stop (terminal), ping (keepalive). Only message_start
              // and message_delta carry usage / model info we need.
              if (parsed.type === 'message_start' && parsed.message?.usage) {
                inputTokens = parsed.message.usage.input_tokens ?? inputTokens;
                model = parsed.message.model || model;
              } else if (parsed.type === 'message_delta' && parsed.usage) {
                outputTokens = parsed.usage.output_tokens ?? outputTokens;
              }
            } catch {
              /* partial JSON */
            }
          }
        } catch {
          /* non-critical */
        }
      } catch (err) {
        if (!streamClosed) {
          log.warn({ error: String(err) }, 'Anthropic stream read error');
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
  if (!responseHeaders.has('content-type')) {
    responseHeaders.set('content-type', 'text/event-stream; charset=utf-8');
  }
  return new Response(stream, { status: upstream.status, headers: responseHeaders });
}

function recordUsage(guard: GuardResult, model: string, usage: LLMUsage, endpoint: string, cached = false): void {
  try {
    const cost = calculateLLMCredits(model, usage);
    // release202/12 (P8) — cache hit = idempotency replay; book ZERO credits to
    // honour the cache's anti-double-bill purpose. Mirrors the OpenAI proxy.
    const billedCredits = cached ? 0 : cost.credits;
    const record: UsageRecordRequest = {
      task_id: generateTaskId(cached ? 'llm-cached' : 'llm'),
      task_type: 'llm_proxy_anthropic',
      input: {
        type: 'query',
        value: `${endpoint} model=${model}${cached ? ' cached=true' : ''}`,
      },
      metrics: {
        tokens_input: cost.promptTokens,
        tokens_output: cost.completionTokens,
        processing_time_ms: 0,
      },
      cost: { compression_credits: billedCredits, total_credits: billedCredits },
    };
    // release202/12 (P2b) — book to the apiGuard-resolved guard.auth.userId, the
    // same identity that minted the upstream token; no auth-header re-parse.
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
      cached ? 'Anthropic usage recorded (from cache hit — 0 credits)' : 'Anthropic usage recorded',
    );
  } catch (err) {
    log.error({ error: String(err) }, 'Failed to record Anthropic usage');
  }
}

function buildUpstreamHeaders(incoming: Headers, newApiToken: string): Headers {
  // release202/12 (P6) — allowlist (NOT strip-list): forward only known-safe
  // upstream headers, then set our x-api-key. See UPSTREAM_HEADER_ALLOWLIST.
  const headers = new Headers();
  for (const [key, value] of incoming.entries()) {
    if (UPSTREAM_HEADER_ALLOWLIST.has(key.toLowerCase())) headers.set(key, value);
  }
  headers.set('x-api-key', `sk-${newApiToken}`);
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
// Test-only exports (Cleanup-3 idempotency cache)
// ============================================================================
//
// Exposed for src/lib/__tests__/llm-proxy-anthropic-idempotency.test.ts. Not
// part of the public proxy surface — production code paths consume these
// helpers internally via proxyAnthropicToNewAPI.
export const __test = {
  serveCacheHit,
  recordUsage,
  buildUpstreamHeaders,
};
