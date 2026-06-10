// Local-server RPC route attacher.
//
// Wires the 7 phase-0 daemon memory endpoints onto the existing local HTTP
// server (sdk/prismer-cloud/runtime/src/daemon/local-server.ts) via the
// optional `attachMemory` hook on LocalServerOptions.
//
// Endpoints (all bound to 127.0.0.1):
//   GET  /local/memory/stats
//   GET  /local/memory/list?workspaceId=&pageType=&limit=
//   GET  /local/memory/search?workspaceId=&q=&topK=&maxBytes=
//   GET  /local/memory/load?workspaceId=&path=  OR  ?uri=prismer://...
//   POST /local/memory/write                  body: MemoryWriteInput
//   POST /local/memory/flush                  body: { workspaceId }
//   POST /local/memory/invalidate             body: { workspaceId, pageIds[] }
//   POST /local/memory/observability/emit     body: MemoryOutboxEnvelopeT (T2-A)
//
// Phase-1 (C2): /flush actually uploads via outbox worker; /invalidate is
// also reachable via daemon WS push from cloud.
//
// /observability/emit (T2-A, doc 23 §1.5.5): out-of-process agents (e.g. the
// Python Hermes provider) need a way to enqueue recall_inject / recall_pull
// observability events into the daemon's outbox. In-process hooks (hooks.ts)
// call slot.outbox.enqueue() directly, but Hermes runs as a separate Python
// process with no SQLite handle to the per-workspace store. The endpoint is
// a thin pass-through: it parses the JSON body, looks up the workspace slot,
// and calls slot.outbox.enqueue() with full envelope schema validation. The
// MemoryOutboxEnvelope zod union accepts both memory.* and observability
// events, so cloud-side routing is unchanged. Idempotency is enforced by
// the outbox's UNIQUE(idempotencyKey) — repeat emits dedupe automatically.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MemoryRuntime } from './runtime.js';
import type { MemoryWriteInput, MemoryPageType } from './types.js';
import { buildManifest, finalizeSelected } from './fork/index.js';

export interface AttachMemoryRpcOptions {
  runtime: MemoryRuntime;
}

const MEMORY_PATH_PREFIX = '/local/memory/';

export function attachMemoryRpc(
  opts: AttachMemoryRpcOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const { runtime } = opts;

  return async (req, res) => {
    const url = req.url ?? '/';
    if (!url.startsWith(MEMORY_PATH_PREFIX) && url !== '/local/memory') return false;

    // Strip query string for routing.
    const [pathOnly = '', queryRaw = ''] = url.split('?', 2);
    const query = parseQuery(queryRaw);
    const subpath = pathOnly.slice(MEMORY_PATH_PREFIX.length); // '' if exactly '/local/memory/'
    const method = req.method ?? 'GET';

    try {
      if (method === 'GET' && subpath === 'stats') {
        return handleStats(runtime, query, res);
      }
      if (method === 'GET' && subpath === 'list') {
        return handleList(runtime, query, res);
      }
      if (method === 'GET' && subpath === 'search') {
        return handleSearch(runtime, query, res);
      }
      if (method === 'GET' && subpath === 'load') {
        return handleLoad(runtime, query, res);
      }
      if (method === 'POST' && subpath === 'write') {
        const body = await readJson(req);
        return handleWrite(runtime, body, res);
      }
      if (method === 'POST' && subpath === 'flush') {
        const body = await readJson(req);
        return handleFlush(runtime, body, res);
      }
      if (method === 'POST' && subpath === 'invalidate') {
        const body = await readJson(req);
        return handleInvalidate(runtime, body, res);
      }
      if (method === 'POST' && subpath === 'observability/emit') {
        const body = await readJson(req);
        return handleObservabilityEmit(runtime, body, res);
      }
      // M-B (doc 25 §3 支柱 2) — fork-recall 2-call protocol. The host
      // calls /recall/manifest first to get candidate pages (Stage 1),
      // runs its own LLM selector (Stage 2), then POSTs the selection
      // to /recall/finalize for content-snippet resolution (Stage 3).
      if (method === 'GET' && subpath === 'recall/manifest') {
        return handleRecallManifest(runtime, query, res);
      }
      if (method === 'POST' && subpath === 'recall/finalize') {
        const body = await readJson(req);
        return handleRecallFinalize(runtime, body, res);
      }
      // Path matched the memory prefix but no route — surface 404 from this
      // handler so it can be distinguished from other server 404s.
      respond(res, 404, { error: 'memory_route_not_found', path: url });
      return true;
    } catch (err) {
      respond(res, 500, {
        error: 'memory_rpc_failed',
        message: err instanceof Error ? err.message : String(err),
      });
      return true;
    }
  };
}

function handleStats(
  runtime: MemoryRuntime,
  query: Record<string, string>,
  res: ServerResponse,
): boolean {
  const workspaceId = query.workspaceId;
  if (workspaceId) {
    // Use peek so a stranger /stats?workspaceId= doesn't implicitly open a
    // store for a workspace that was never written to.
    const slot = runtime.peek(workspaceId);
    respond(res, 200, slot ? slot.store.stats() : { workspaceId, pageCount: 0, pendingOutbox: 0, deadLetterCount: 0, lastSyncAt: null, dbPath: null });
    return true;
  }
  // Global stats: aggregate across all open workspaces.
  const ids = runtime.workspaceIds();
  const perWorkspace = ids.map((id) => {
    const slot = runtime.peek(id);
    return slot ? slot.store.stats() : null;
  }).filter((s): s is NonNullable<typeof s> => s !== null);
  respond(res, 200, {
    workspaces: perWorkspace,
    workspaceCount: perWorkspace.length,
    totalPages: perWorkspace.reduce((acc, s) => acc + s.pageCount, 0),
    totalPending: perWorkspace.reduce((acc, s) => acc + s.pendingOutbox, 0),
    totalDeadLetter: perWorkspace.reduce((acc, s) => acc + s.deadLetterCount, 0),
  });
  return true;
}

function handleList(
  runtime: MemoryRuntime,
  query: Record<string, string>,
  res: ServerResponse,
): boolean {
  const workspaceId = query.workspaceId;
  if (!workspaceId) return respond400(res, 'workspaceId query param required');
  const pageType = query.pageType as MemoryPageType | undefined;
  const limit = query.limit ? Number(query.limit) : undefined;
  const slot = runtime.resolve(workspaceId);
  const pages = slot.store.list({ pageType, limit });
  respond(res, 200, { pages });
  return true;
}

// Mirrors the MemoryPageType union in `./types.ts`. Kept inline (not imported
// as a const) because the type itself is a string-literal union — runtime
// validation needs an actual array. Update both together if the union changes.
const ALLOWED_PAGE_TYPES: readonly MemoryPageType[] = [
  'hub',
  'leaf',
  'decision',
  'glossary',
  'archive',
];

function handleSearch(
  runtime: MemoryRuntime,
  query: Record<string, string>,
  res: ServerResponse,
): boolean {
  const workspaceId = query.workspaceId;
  if (!workspaceId) return respond400(res, 'workspaceId query param required');
  const q = query.q ?? query.query ?? '';
  if (!q) return respond400(res, 'q (or query) param required');
  const topK = query.topK ? Number(query.topK) : undefined;
  const maxBytes = query.maxBytes ? Number(query.maxBytes) : undefined;

  // Phase-0 ships single-value pageType matching the canonical TS adapter
  // contract (sdk/prismer-cloud/runtime/src/adapters/memory-tools.ts:170).
  // parseQuery() is last-wins on duplicate keys, so single-value is safe;
  // multi-value support is a separate change to query parsing. Unknown
  // values are silently ignored (treated as undefined) to keep the daemon
  // forward-compatible with adapter-side validation.
  const ptRaw = query.pageType;
  const pageType =
    ptRaw && (ALLOWED_PAGE_TYPES as readonly string[]).includes(ptRaw)
      ? ([ptRaw as MemoryPageType] as MemoryPageType[])
      : undefined;

  const slot = runtime.resolve(workspaceId);
  const results = slot.search.hybrid(q, { topK, maxBytes, pageType });
  respond(res, 200, { query: q, results });
  return true;
}

function handleLoad(
  runtime: MemoryRuntime,
  query: Record<string, string>,
  res: ServerResponse,
): boolean {
  let workspaceId = query.workspaceId;
  let pagePath = query.path;
  if (query.uri) {
    const parsed = parsePrismerUri(query.uri);
    if (!parsed) return respond400(res, `uri ${query.uri} is not a valid prismer:// memory URI`);
    workspaceId = parsed.workspaceId;
    pagePath = parsed.path;
  }
  if (!workspaceId) return respond400(res, 'workspaceId (or uri) required');
  if (!pagePath) return respond400(res, 'path (or uri) required');
  const slot = runtime.resolve(workspaceId);
  const page = slot.store.loadByPath(pagePath);
  if (!page) {
    respond(res, 404, { error: 'memory_page_not_found', workspaceId, path: pagePath });
    return true;
  }
  const content = slot.store.loadContent(page.id);
  respond(res, 200, { page, content: content?.content ?? null });
  return true;
}

function handleWrite(
  runtime: MemoryRuntime,
  body: unknown,
  res: ServerResponse,
): boolean {
  const input = body as Partial<MemoryWriteInput>;
  if (!input?.workspaceId || !input.path || typeof input.content !== 'string' || !input.actorImUserId || !input.actorKind) {
    return respond400(
      res,
      'memory.write requires workspaceId, path, content, actorImUserId, actorKind',
    );
  }
  const slot = runtime.resolve(input.workspaceId);
  const page = slot.store.write(input as MemoryWriteInput);
  respond(res, 200, { page });
  return true;
}

function handleFlush(
  runtime: MemoryRuntime,
  body: unknown,
  res: ServerResponse,
): boolean {
  const { workspaceId } = (body ?? {}) as { workspaceId?: string };
  if (!workspaceId) return respond400(res, 'workspaceId required');
  const slot = runtime.resolve(workspaceId);
  // Phase-0 stub: returns queue depth + flushed=0 (no worker uploads yet).
  respond(res, 200, slot.outbox.flush());
  return true;
}

function handleInvalidate(
  runtime: MemoryRuntime,
  body: unknown,
  res: ServerResponse,
): boolean {
  const { workspaceId, pageIds, reason } = (body ?? {}) as {
    workspaceId?: string;
    pageIds?: unknown;
    reason?: string;
  };
  if (!workspaceId) return respond400(res, 'workspaceId required');
  if (!Array.isArray(pageIds) || pageIds.some((id) => typeof id !== 'string')) {
    return respond400(res, 'pageIds must be string[]');
  }
  const slot = runtime.resolve(workspaceId);
  slot.store.invalidate(pageIds as string[], reason ?? 'cloud_force_refresh');
  respond(res, 200, { workspaceId, invalidated: pageIds.length });
  return true;
}

/**
 * POST /local/memory/observability/emit — out-of-process observability event
 * sink. Body is a full MemoryOutboxEnvelope (zod union); we look up the slot
 * by `workspaceId` and call slot.outbox.enqueue() which runs schema validation
 * and de-duplicates by idempotencyKey. Returns the resulting outbox row id +
 * deadLetter flag so the caller can correlate.
 */
function handleObservabilityEmit(
  runtime: MemoryRuntime,
  body: unknown,
  res: ServerResponse,
): boolean {
  if (typeof body !== 'object' || body === null) {
    return respond400(res, 'request body must be a JSON object');
  }
  const workspaceId = (body as { workspaceId?: unknown }).workspaceId;
  if (typeof workspaceId !== 'string' || !workspaceId) {
    return respond400(res, 'workspaceId is required (string)');
  }
  const slot = runtime.resolve(workspaceId);
  // outbox.enqueue does its own schema validation. Schema failures land in
  // memory_outbox_dead_letter and return { deadLetter: true }; we surface
  // that as a 400 so the caller can fix the payload.
  const result = slot.outbox.enqueue(body);
  if (result.deadLetter) {
    respond(res, 400, { error: 'envelope_validation_failed', deadLetterId: result.id });
    return true;
  }
  respond(res, 200, { id: result.id, deadLetter: false });
  return true;
}

// ---- helpers ---------------------------------------------------------------

function respond(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function respond400(res: ServerResponse, message: string): boolean {
  respond(res, 400, { error: 'invalid_request', message });
  return true;
}

function parseQuery(raw: string): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const part of raw.split('&')) {
    if (!part) continue;
    const [k = '', v = ''] = part.split('=', 2);
    if (!k) continue;
    out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' '));
  }
  return out;
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

// ─── M-B fork recall handlers ──────────────────────────────────────────
//
// Stage 1: GET /local/memory/recall/manifest?workspaceId=&q=&limit=&pageType=
//   Returns candidate pages with (path, title, description, mtimeMs,
//   pageType). Bounded by limit (default 200, cap 500). When `q` is empty,
//   ordering is updatedAt DESC.
//
// Stage 3: POST /local/memory/recall/finalize { workspaceId, paths[] }
//   Resolves selector-picked filenames into RelevantMemory[] with content
//   snippets (≤500 bytes per result by default). Drops paths that don't
//   exist (defensive — selector hallucinates sometimes).
//
// Stage 2 (LLM selector) lives in the host. The daemon never holds the
// API key (option A from doc 25 §7 judgment 4).
function handleRecallManifest(
  runtime: MemoryRuntime,
  query: Record<string, string>,
  res: ServerResponse,
): boolean {
  const workspaceId = query.workspaceId;
  if (!workspaceId) return respond400(res, 'workspaceId query param required');
  const q = query.q ?? query.query ?? '';
  const limitParam = query.limit ? Number(query.limit) : undefined;
  const ptRaw = query.pageType;
  const pageType =
    ptRaw && (ALLOWED_PAGE_TYPES as readonly string[]).includes(ptRaw)
      ? [ptRaw as MemoryPageType]
      : undefined;

  // peek: don't auto-create the SQLite store for a workspace that was
  // never written to. buildManifest already returns an empty response in
  // that case.
  const manifest = buildManifest(runtime, workspaceId, q, {
    ...(limitParam !== undefined ? { limit: limitParam } : {}),
    ...(pageType ? { pageType } : {}),
  });
  respond(res, 200, manifest);
  return true;
}

function handleRecallFinalize(
  runtime: MemoryRuntime,
  body: unknown,
  res: ServerResponse,
): boolean {
  if (!body || typeof body !== 'object') {
    return respond400(res, 'json body required');
  }
  const b = body as { workspaceId?: unknown; paths?: unknown; snippetMaxBytes?: unknown };
  if (typeof b.workspaceId !== 'string' || !b.workspaceId) {
    return respond400(res, 'workspaceId is required');
  }
  if (!Array.isArray(b.paths)) {
    return respond400(res, 'paths[] is required');
  }
  const paths: string[] = [];
  for (const p of b.paths) {
    if (typeof p === 'string' && p.length > 0) paths.push(p);
  }
  const snippetMaxBytes =
    typeof b.snippetMaxBytes === 'number' && b.snippetMaxBytes > 0 ? b.snippetMaxBytes : undefined;
  const results = finalizeSelected(runtime, b.workspaceId, paths, snippetMaxBytes);
  respond(res, 200, { workspaceId: b.workspaceId, results });
  return true;
}

/**
 * `prismer://workspace/<workspaceId>/memory/<path>` → { workspaceId, path }.
 * Returns null on malformed input (caller surfaces 400).
 */
function parsePrismerUri(uri: string): { workspaceId: string; path: string } | null {
  const PREFIX = 'prismer://workspace/';
  if (!uri.startsWith(PREFIX)) return null;
  const rest = uri.slice(PREFIX.length);
  const segMemory = '/memory/';
  const memoryIdx = rest.indexOf(segMemory);
  if (memoryIdx <= 0) return null;
  const workspaceId = rest.slice(0, memoryIdx);
  const path = rest.slice(memoryIdx + segMemory.length);
  if (!workspaceId || !path) return null;
  return { workspaceId, path };
}
