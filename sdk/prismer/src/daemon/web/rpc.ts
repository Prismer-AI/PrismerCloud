// Workspace web-tools RPC (`/local/web/*`) — the daemon leg of the
// web-capability fix (release203, user ruling: WE are the search backend).
//
// Why this exists: Hermes agents in agent-rt pods have NO native web tools —
// all 7 upstream search backends are unconfigured, so the tools' check_fn
// drops web_search / web_extract from the model schema — and agents rationally
// fell back to `execute_code` + python `subprocess` for web research (197
// execute_code vs 0 web calls over 14 days). Per the ruling we do NOT put
// third-party search keys/packages into pods; the cloud Load API is already
// the workspace's search backend:
//
//   POST ${cloud.baseUrl}/api/context/load  { input: <query | url | url[]> }
//     → auto-detects, does search + cache-check + compress + deposit
//       (Exa server-side), bills the workspace.
//
// (memory203 doc 02 ruling: "load.web = 显式 defer 到 /api/context/load
// (身份边界)".)
//
// So the daemon exposes two loopback routes for the provider-shell tools
// (plugins/memory/prismer/__init__.py — web_search / web_load):
//
//   POST /local/web/search   body { query, limit? }
//   POST /local/web/load     body { url } | { urls: string[] }
//                            (http(s) OR prismer:// URIs — memory203/20 §2.2:
//                            workspace assets/files load through the same lane)
//
// Both FORWARD to the cloud Load API with the daemon's own
// `Authorization: Bearer <cloud.apiKey>` — the SAME sk-prismer agent token
// extract.ts uses for /api/v1/messages. Auth form verified: the Load API's
// apiGuard accepts a plain `Bearer sk-prismer-*` header (src/lib/api-guard.ts
// resolveAuth, dual-form Bearer) — no JWT exchange needed.
//
// Output bounding: the Load API returns compressed (hqcc) content, but a
// 15-result query response can still be large. Every text field on
// result/results is clipped to WEB_TEXT_FIELD_MAX chars with an explicit
// truncation marker so tool output can't blow the model context.
//
// These are NOT memory ops — they cohabit the daemon local server (like
// /local/asset/*) because the loopback server is the established seam every
// in-pod agent process can reach without holding cloud credentials itself.

import { execFileSync } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CloudClient } from '../../auth.js';
import { createLogger } from '../../lib/logger.js';
import {
  runHeadlessLoad,
  runHeadlessSearch,
  type HeadlessLoadOutcome,
  type HeadlessSearchOutcome,
  type ProviderAttempt,
  type SerpEngine,
} from './headless-serp.js';
import { SeenJournal, defaultPrismerCacheDir } from './seen-journal.js';

const log = createLogger('web-tool');

export interface HeadlessSeam {
  /** Runtime210/01: local headless SERP (stubbed in tests). */
  search: (query: string) => Promise<HeadlessSearchOutcome>;
  /** Runtime210/01: local URL read via chromium (stubbed in tests). */
  load: (url: string) => Promise<HeadlessLoadOutcome>;
}

export interface AttachWebRpcOptions {
  /**
   * Daemon cloud client (holds `baseUrl` + agent sk-prismer `apiKey`).
   * Absent (unit tests / cloud-unreachable boot) → routes degrade to a
   * structured 503 instead of throwing (降级不中断).
   */
  cloud?: CloudClient;
  /** Flag source (FF_WEB_HEADLESS_SERP family). Default process.env — tests inject. */
  env?: Record<string, string>;
  /** Headless provider seam — tests stub; default = real engine chain. */
  headless?: Partial<HeadlessSeam>;
  /** Deposit-dedup journal file — tests inject; default ~/.prismer/cache. */
  journalFile?: string;
  /** Cache dir for the embedded python script. */
  cacheDir?: string;
}

// ─── runtime210/01 experiment: FF_WEB_HEADLESS_SERP (default off) ────────────

export type SerpMode = 'off' | 'fallback' | 'local-first';

export interface SerpFlags {
  mode: SerpMode;
  bing: boolean;
  google: boolean;
  ddg: boolean;
  order: SerpEngine[];
}

export function resolveSerpFlags(env: Record<string, string> = {}): SerpFlags {
  // 2026-08-23 最终裁决（自动化会话降级实验闭合后）：未设 flag → fallback——
  // cloud（Exa+Serper API）保相关性，headless 只在 cloud 失败时兜底（相关性不
  // 承诺）。显式 'off'/'local-first' 仍可覆盖。
  const raw = (env.FF_WEB_HEADLESS_SERP ?? '').trim().toLowerCase();
  const mode: SerpMode = raw === 'off' ? 'off' : raw === 'local-first' ? 'local-first' : 'fallback';
  const bing = (env.FF_WEB_HEADLESS_SERP_BING ?? '').trim() !== 'false';
  const google = (env.FF_WEB_HEADLESS_SERP_GOOGLE ?? '').trim() === 'true';
  const ddg = (env.FF_WEB_HEADLESS_SERP_DDG ?? '').trim() !== 'false';
  let order: SerpEngine[] = ['bing', 'ddg', 'google'];
  const orderRaw = (env.FF_WEB_HEADLESS_SERP_ORDER ?? '').trim();
  if (orderRaw) {
    order = orderRaw
      .split(',')
      .map((s) => s.trim())
      .filter((s): s is SerpEngine => s === 'bing' || s === 'google' || s === 'ddg');
  }
  if (!google) order = order.filter((e) => e !== 'google');
  if (!bing) order = order.filter((e) => e !== 'bing');
  if (!ddg) order = order.filter((e) => e !== 'ddg');
  if (order.length === 0) order = ['bing', 'ddg'];
  return { mode, bing, google, ddg, order };
}

/** hqcc clip for headless-deposited content (design doc §6.4). */
const HQCC_CLIP = 30_000;

function clipText(s: string, max = HQCC_CLIP): string {
  return s.length > max ? s.slice(0, max) : s;
}

const WEB_PATH_PREFIX = '/local/web/';

/**
 * The Load API does real work per call (Exa search + per-URL compression of
 * every cache miss), so give it a much wider budget than the CloudClient 30s
 * default. Live-measured (2026-07-03, dev): a cold 3-result query took 59s —
 * a 60s ceiling lost the race by a hair. Default 120s, env-tunable
 * (PRISMER_WEB_LOAD_TIMEOUT_MS) like the extraction timeouts; the provider
 * shell waits slightly longer so the daemon, not the shell, is the timeout
 * authority.
 */
function loadApiTimeoutMs(): number {
  const raw = Number(process.env.PRISMER_WEB_LOAD_TIMEOUT_MS ?? '');
  return Number.isFinite(raw) && raw >= 1_000 ? raw : 120_000;
}

/** Max characters kept per text field (hqcc / raw / text / content / snippet). */
export const WEB_TEXT_FIELD_MAX = 8_000;

/** web_search limit ceiling — mirrors the Load API's return.topK semantics. */
const SEARCH_LIMIT_MAX = 10;
const SEARCH_LIMIT_DEFAULT = 5;

/** web_load batch ceiling — keep a single tool call bounded. */
const LOAD_URLS_MAX = 5;

interface WebRpcContext {
  cloud?: CloudClient;
  env: Record<string, string>;
  journal: SeenJournal;
  headless: HeadlessSeam;
}

export function attachWebRpc(
  opts: AttachWebRpcOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const env: Record<string, string> = (opts.env ?? process.env) as Record<string, string>;
  const flags = resolveSerpFlags(env);
  const ctx: WebRpcContext = {
    cloud: opts.cloud,
    env,
    journal: opts.journalFile ? new SeenJournal(opts.journalFile) : SeenJournal.open(opts.cacheDir),
    headless: {
      search:
        opts.headless?.search ??
        ((query: string) => runHeadlessSearch(query, { engines: flags.order, cacheDir: opts.cacheDir })),
      load: opts.headless?.load ?? ((url: string) => runHeadlessLoad(url, { cacheDir: opts.cacheDir })),
    },
  };

  return async (req, res) => {
    const url = req.url ?? '/';
    if (!url.startsWith(WEB_PATH_PREFIX)) return false;
    const [pathOnly = ''] = url.split('?', 2);
    const subpath = pathOnly.slice(WEB_PATH_PREFIX.length);
    const method = req.method ?? 'GET';

    try {
      if (method === 'POST' && subpath === 'search') {
        const body = await readJson(req);
        return await handleWebSearch(ctx, body, res);
      }
      if (method === 'POST' && subpath === 'load') {
        const body = await readJson(req);
        return await handleWebLoad(ctx, body, res);
      }
      if (method === 'GET' && subpath === 'doctor') {
        return await handleDoctor(ctx, res);
      }
      respond(res, 404, { error: 'web_route_not_found', path: url });
      return true;
    } catch (err) {
      respond(res, 500, {
        error: 'web_rpc_failed',
        message: err instanceof Error ? err.message : String(err),
      });
      return true;
    }
  };
}

/**
 * POST /local/web/search { query, limit? }
 *
 * flag 三态（FF_WEB_HEADLESS_SERP，默认 off）:
 *   off        → 原路径：cloud Load API query mode（现行为字节级保留）
 *   fallback   → cloud 优先，失败 → 本地 headless SERP（degraded）
 *   local-first→ 本地 headless SERP 为主，失败回落 cloud；结果异步回归缓存
 */
async function handleWebSearch(ctx: WebRpcContext, body: unknown, res: ServerResponse): Promise<boolean> {
  const b = (body ?? {}) as { query?: unknown; limit?: unknown };
  const query = typeof b.query === 'string' ? b.query.trim() : '';
  if (!query) {
    respond(res, 400, { ok: false, error: 'query_required', message: 'web_search requires a non-empty query string' });
    return true;
  }
  const limitRaw = typeof b.limit === 'number' && Number.isFinite(b.limit) ? Math.floor(b.limit) : SEARCH_LIMIT_DEFAULT;
  const limit = Math.min(Math.max(limitRaw, 1), SEARCH_LIMIT_MAX);
  const flags = resolveSerpFlags(ctx.env);
  const traceId = mintTraceId();
  const started = Date.now();
  const attempts: ProviderAttempt[] = [];
  let degraded = false;

  // 1) local-first: headless 先（断云仍可用）
  if (flags.mode === 'local-first') {
    const outcome = await ctx.headless.search(query);
    attempts.push(...outcome.attempts);
    if (outcome.ok) {
      if (ctx.cloud) {
        await depositRegression(
          ctx.cloud,
          ctx.journal,
          outcome.results.map((r) => ({ url: r.url, hqcc: r.snippet, tags: [query], engine: r.engine })),
        );
      }
      const payload = buildLocalQueryPayload(query, outcome, limit, traceId, started);
      log.info(`headless search ok trace=${traceId} query="${clip(query, 80)}" results=${outcome.results.length}`);
      respond(res, 200, { ok: true, ...payload, degraded: true, providerAttempts: attempts });
      return true;
    }
    degraded = true;
  }

  // 2) cloud 路径（off 原路径 / fallback / local-first 回落）
  if (!ctx.cloud) {
    respond(res, 503, {
      ok: false,
      error: 'cloud_not_wired',
      message: degraded
        ? 'headless providers failed and daemon has no cloud client'
        : 'daemon has no cloud client — web search unavailable',
    });
    return true;
  }
  const resp = await ctx.cloud.request<Record<string, unknown>>('POST', '/api/context/load', {
    body: {
      input: query,
      inputType: 'query',
      search: { topK: limit },
      processing: { maxConcurrent: 5 },
      return: { topK: limit },
    },
    timeoutMs: loadApiTimeoutMs(),
    headers: forwardedProtoHeader(ctx.cloud),
  });
  if (resp.ok) {
    const bounded = boundLoadApiPayload(resp.data);
    const extra = degraded || flags.mode !== 'off' ? { degraded: true, providerAttempts: attempts } : {};
    const returned = Array.isArray((bounded as { results?: unknown[] }).results)
      ? (bounded as { results: unknown[] }).results.length
      : undefined;
    log.info(`search ok trace=${traceId} query="${clip(query, 80)}" status=200 results=${returned ?? '?'} ms=${Date.now() - started}`);
    respond(res, 200, { ok: true, ...bounded, ...extra });
    return true;
  }

  // 3) cloud 失败 + fallback 模式 → headless
  if (flags.mode === 'fallback') {
    attempts.push({ provider: 'cloud', ok: false, ms: Date.now() - started, error: resp.error?.code ?? 'cloud_error' });
    const outcome = await ctx.headless.search(query);
    attempts.push(...outcome.attempts);
    if (outcome.ok) {
      if (ctx.cloud) {
        await depositRegression(
          ctx.cloud,
          ctx.journal,
          outcome.results.map((r) => ({ url: r.url, hqcc: r.snippet, tags: [query], engine: r.engine })),
        );
      }
      const payload = buildLocalQueryPayload(query, outcome, limit, traceId, started);
      log.info(`fallback headless search ok trace=${traceId} query="${clip(query, 80)}" results=${outcome.results.length}`);
      respond(res, 200, { ok: true, ...payload, degraded: true, providerAttempts: attempts });
      return true;
    }
    log.warn(`search failed trace=${traceId} query="${clip(query, 80)}" status=502 ms=${Date.now() - started}`, {
      error: resp.error?.code,
    });
    respond(res, 502, {
      ok: false,
      error: 'all_providers_failed',
      message: 'cloud and headless search providers failed',
      providerAttempts: attempts,
    });
    return true;
  }

  const ms = Date.now() - started;
  log.warn(`search failed trace=${traceId} query="${clip(query, 80)}" status=${resp.status} ms=${ms}`, {
    error: resp.error?.code,
  });
  respond(res, resp.status || 502, {
    ok: false,
    error: resp.error?.code ?? 'cloud_request_failed',
    message: resp.error?.message ?? `cloud returned HTTP ${resp.status}`,
    ...(attempts.length ? { providerAttempts: attempts } : {}),
  });
  return true;
}

/**
 * POST /local/web/load { url } | { urls }
 *
 * flag 三态同 search。prismer:// URI 恒走 cloud（asset 解析是 cloud-resident）；
 * local-first 只接管 http(s) 读取（chromium 串行：pod 内单浏览器）。
 */
async function handleWebLoad(ctx: WebRpcContext, body: unknown, res: ServerResponse): Promise<boolean> {
  const b = (body ?? {}) as { url?: unknown; urls?: unknown };
  const rawUrls: unknown[] = Array.isArray(b.urls) ? b.urls : b.url !== undefined ? [b.url] : [];
  const urls = rawUrls.filter((u): u is string => typeof u === 'string').map((u) => u.trim()).filter(Boolean);
  if (urls.length === 0) {
    respond(res, 400, { ok: false, error: 'url_required', message: 'web_load requires `url` or `urls[]`' });
    return true;
  }
  if (urls.length > LOAD_URLS_MAX) {
    respond(res, 400, { ok: false, error: 'too_many_urls', message: `web_load accepts at most ${LOAD_URLS_MAX} urls per call` });
    return true;
  }
  // Scheme allowlist, defense in depth (the provider shell pre-validates too):
  // http(s) for the web, PLUS prismer:// (memory203/20 §2.2 / 19 B9) so agents
  // can load workspace assets/files the memory wiki points at
  // (`prismer://<owner>/asset/<sha>`, `prismer://.../file/...`) instead of
  // re-reading raw sources — the cloud Load API natively resolves prismer://
  // URIs (route.ts parsePrismerUri) and stays the authority on which forms
  // exist. Everything else (file:// / ftp:// / loopback schemes) never rides
  // the workspace-billed load lane.
  const bad = urls.find((u) => !/^(https?|prismer):\/\//i.test(u));
  if (bad) {
    respond(res, 400, { ok: false, error: 'invalid_url', message: `web_load only accepts http(s) or prismer:// URIs (got: ${clip(bad, 120)})` });
    return true;
  }
  const flags = resolveSerpFlags(ctx.env);
  const httpUrls = urls.filter((u) => /^https?:\/\//i.test(u));
  const prismerUrls = urls.filter((u) => /^prismer:\/\//i.test(u));
  const traceId = mintTraceId();
  const started = Date.now();
  const attempts: ProviderAttempt[] = [];
  let degraded = false;

  // 1) local-first: 本地读 http(s)（串行，单 chromium）；prismer:// 混合时整体走 cloud
  if (flags.mode === 'local-first' && httpUrls.length > 0 && prismerUrls.length === 0) {
    const reads: Array<HeadlessLoadOutcome> = [];
    for (const u of httpUrls) {
      reads.push(await ctx.headless.load(u));
    }
    attempts.push(...reads.flatMap((r) => r.attempts));
    const okReads = reads.filter((r) => r.ok);
    if (okReads.length === httpUrls.length) {
      const input: string | string[] = urls.length === 1 ? urls[0]! : urls;
      if (ctx.cloud) {
        await depositRegression(
          ctx.cloud,
          ctx.journal,
          okReads.map((r) => ({ url: r.url, hqcc: r.text ?? '', raw: r.text, engine: 'chromium' })),
        );
      }
      const payload = buildLocalLoadPayload(input, okReads, traceId, started);
      log.info(`headless load ok trace=${traceId} urls=${okReads.length}`);
      respond(res, 200, { ok: true, ...payload, degraded: true, providerAttempts: attempts });
      return true;
    }
    degraded = true; // 部分失败 → cloud 处理全部
  }

  // 2) cloud 路径（off / fallback / local-first 回落 / prismer:// 恒走此）
  if (!ctx.cloud) {
    respond(res, 503, {
      ok: false,
      error: 'cloud_not_wired',
      message: degraded
        ? 'headless load providers failed and daemon has no cloud client'
        : 'daemon has no cloud client — web load unavailable',
    });
    return true;
  }
  const input: string | string[] = urls.length === 1 ? urls[0]! : urls;
  const resp = await ctx.cloud.request<Record<string, unknown>>('POST', '/api/context/load', {
    body: { input },
    timeoutMs: loadApiTimeoutMs(),
    headers: forwardedProtoHeader(ctx.cloud),
  });
  const ms = Date.now() - started;
  if (resp.ok) {
    const bounded = boundLoadApiPayload(resp.data);
    const extra = degraded || flags.mode !== 'off' ? { degraded: true, providerAttempts: attempts } : {};
    log.info(`load ok trace=${traceId} urls=${urls.length} status=200 ms=${ms}`, { first: clip(urls[0]!, 120) });
    respond(res, 200, { ok: true, ...bounded, ...extra });
    return true;
  }

  // 3) cloud 失败 + fallback 模式 → 本地读（仅纯 http(s) 时）
  if (flags.mode === 'fallback' && prismerUrls.length === 0) {
    attempts.push({ provider: 'cloud', ok: false, ms, error: resp.error?.code ?? 'cloud_error' });
    const reads: Array<HeadlessLoadOutcome> = [];
    for (const u of httpUrls) {
      reads.push(await ctx.headless.load(u));
    }
    attempts.push(...reads.flatMap((r) => r.attempts));
    const okReads = reads.filter((r) => r.ok);
    if (okReads.length === httpUrls.length && okReads.length > 0) {
      if (ctx.cloud) {
        await depositRegression(
          ctx.cloud,
          ctx.journal,
          okReads.map((r) => ({ url: r.url, hqcc: r.text ?? '', raw: r.text, engine: 'chromium' })),
        );
      }
      const payload = buildLocalLoadPayload(input, okReads, traceId, started);
      respond(res, 200, { ok: true, ...payload, degraded: true, providerAttempts: attempts });
      return true;
    }
    log.warn(`load failed trace=${traceId} urls=${urls.length} status=502 ms=${ms}`, {
      error: resp.error?.code,
      first: clip(urls[0]!, 120),
    });
    respond(res, 502, {
      ok: false,
      error: 'all_providers_failed',
      message: 'cloud and headless load providers failed',
      providerAttempts: attempts,
    });
    return true;
  }

  log.warn(`load failed trace=${traceId} urls=${urls.length} status=${resp.status} ms=${ms}`, {
    error: resp.error?.code,
    first: clip(urls[0]!, 120),
  });
  respond(res, resp.status || 502, {
    ok: false,
    error: resp.error?.code ?? 'cloud_request_failed',
    message: resp.error?.message ?? `cloud returned HTTP ${resp.status}`,
    ...(attempts.length ? { providerAttempts: attempts } : {}),
  });
  return true;
}

// ─── runtime210/01: load-shaped builders + deposit regression + doctor ────────

function buildLocalQueryPayload(
  query: string,
  outcome: HeadlessSearchOutcome,
  limit: number,
  requestId: string,
  startedAt: number,
): Record<string, unknown> {
  const results = outcome.results.slice(0, limit).map((r) => ({
    rank: r.rank,
    url: r.url,
    title: r.title,
    hqcc: r.snippet,
    cached: false,
    cachedAt: null,
    ranking: { score: 0, factors: { searchRank: r.rank } },
    meta: { source: 'headless_serp', engine: r.engine },
  }));
  return {
    success: true,
    requestId,
    mode: 'query',
    results,
    summary: { query, searched: results.length, cacheHits: 0, compressed: 0, returned: results.length },
    cost: { searchCredits: 0, compressionCredits: 0, totalCredits: 0, savedByCache: 0 },
    processingTime: Date.now() - startedAt,
  };
}

function buildLocalLoadPayload(
  input: string | string[],
  reads: Array<{ url: string; title?: string; text?: string }>,
  requestId: string,
  startedAt: number,
): Record<string, unknown> {
  const items = reads.map((r) => ({
    url: r.url,
    title: r.title ?? r.url,
    hqcc: clipText(r.text ?? ''),
    raw: r.text ?? undefined,
    cached: false,
    cachedAt: null,
    imageLinks: [],
    meta: { source: 'headless_serp', engine: 'chromium' },
  }));
  const base = { success: true, requestId, processingTime: Date.now() - startedAt };
  if (typeof input === 'string') {
    return { ...base, mode: 'single_url', result: items[0], cost: { credits: 0, cached: false } };
  }
  return {
    ...base,
    mode: 'batch_urls',
    results: items,
    summary: { total: items.length, found: items.length, notFound: 0, cached: 0, processed: items.length },
    cost: { credits: 0, cached: 0 },
  };
}

/**
 * 数据回归（去中心化管道）：把本地读取的结果异步写回 cloud `im_context_cache`，
 * 走现成 free-tier `POST /api/context/save`。seen-journal 过滤：本 daemon 每
 * URL 只投一次（ContextCacheService.deposit 是盲 upsert，防 agent↔agent 覆盖）。
 * 10s 短超时 + catch：回归失败绝不影响工具响应。
 */
async function depositRegression(
  cloud: CloudClient,
  journal: SeenJournal,
  items: Array<{ url: string; hqcc: string; raw?: string; tags?: string[]; engine?: string }>,
): Promise<void> {
  const fresh = items.filter((i) => !journal.has(i.url));
  if (fresh.length === 0) return;
  try {
    const resp = await cloud.request<Record<string, unknown>>('POST', '/api/context/save', {
      body: {
        items: fresh.map((i) => ({
          url: i.url,
          hqcc: clipText(i.hqcc),
          ...(i.raw ? { raw: i.raw } : {}),
          visibility: 'public',
          tags: i.tags ?? [],
          meta: { source: 'headless_serp', ...(i.engine ? { engine: i.engine } : {}) },
        })),
      },
      timeoutMs: 10_000,
    });
    if (resp.ok) {
      journal.add(fresh.map((i) => i.url));
    } else {
      log.warn('headless deposit failed', { error: resp.error?.code, urls: fresh.length });
    }
  } catch (err) {
    log.warn('headless deposit error', { err });
  }
}

/** GET /local/web/doctor — Phase 0 探针与运行期健康面。 */
async function handleDoctor(ctx: WebRpcContext, res: ServerResponse): Promise<boolean> {
  const flags = resolveSerpFlags(ctx.env);
  const chromium = probePythonPlaywright();
  const engines: Record<string, { probed: boolean; reachable?: boolean; error?: string }> = {
    bing: { probed: false },
    ddg: { probed: false },
    google: { probed: false },
  };
  if (flags.mode !== 'off') {
    if (flags.bing) engines.bing = await probeHttp('https://www.bing.com/');
    if (flags.ddg) engines.ddg = await probeHttp('https://html.duckduckgo.com/');
    if (flags.google) engines.google = await probeHttp('https://www.google.com/');
  }
  respond(res, 200, {
    ok: true,
    flags: { serp: flags.mode, bing: flags.bing, google: flags.google, ddg: flags.ddg, order: flags.order },
    chromium,
    engines,
    cloud: { wired: !!ctx.cloud, baseUrl: ctx.cloud?.baseUrl ?? null },
  });
  return true;
}

function probePythonPlaywright(): { available: boolean; error?: string } {
  try {
    execFileSync('python3', ['-c', 'import playwright'], { stdio: 'pipe', timeout: 10_000 });
    return { available: true };
  } catch (err) {
    return { available: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function probeHttp(url: string): Promise<{ probed: boolean; reachable: boolean; error?: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3_000), redirect: 'manual' });
    return { probed: true, reachable: res.status < 500 };
  } catch (err) {
    return { probed: true, reachable: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The Load API's query mode internally SELF-FETCHES sibling routes
 * (`/api/search`, `/api/compress`) at `x-forwarded-proto || 'https'` +
 * incoming Host. With no proto header a plain-HTTP dev/pod cloud
 * (`http://host.docker.internal:3000`) gets self-fetched as httpS → TLS
 * against a plaintext port → "fetch failed: other side closed" → 500.
 * Send the proto that matches the daemon's own cloud baseUrl (found live,
 * 2026-07-03).
 */
function forwardedProtoHeader(cloud: CloudClient): Record<string, string> {
  try {
    return { 'x-forwarded-proto': new URL(cloud.baseUrl).protocol.replace(':', '') || 'https' };
  } catch {
    return { 'x-forwarded-proto': 'https' };
  }
}

// ─── payload bounding ────────────────────────────────────────────────────────

const TEXT_FIELDS = ['hqcc', 'raw', 'text', 'content', 'snippet'] as const;

/**
 * Clip every known text field on the Load API payload (`result` object and/or
 * `results[]` array) to WEB_TEXT_FIELD_MAX chars, appending an explicit
 * truncation marker. Non-text structure (summary/cost/ranking/meta) passes
 * through untouched so the model keeps the provenance fields.
 */
export function boundLoadApiPayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  const out: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
  if (out.result && typeof out.result === 'object' && !Array.isArray(out.result)) {
    out.result = boundEntry(out.result as Record<string, unknown>);
  }
  if (Array.isArray(out.results)) {
    out.results = out.results.map((r) =>
      r && typeof r === 'object' && !Array.isArray(r) ? boundEntry(r as Record<string, unknown>) : r,
    );
  }
  return out;
}

function boundEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const out = { ...entry };
  for (const field of TEXT_FIELDS) {
    const v = out[field];
    if (typeof v === 'string' && v.length > WEB_TEXT_FIELD_MAX) {
      out[field] = `${v.slice(0, WEB_TEXT_FIELD_MAX)}\n…[truncated ${v.length - WEB_TEXT_FIELD_MAX} chars — web_load the URL for more]`;
      out[`${field}Truncated`] = true;
    }
  }
  return out;
}

// ─── small helpers (mirrors memory/rpc.ts) ───────────────────────────────────

function mintTraceId(): string {
  return `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  const raw = JSON.stringify(body ?? {});
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) });
  res.end(raw);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let raw = '';
  req.setEncoding('utf8');
  for await (const chunk of req) raw += chunk as string;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('invalid_json');
  }
}
