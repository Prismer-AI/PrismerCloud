// Local-server RPC route attacher.
//
// Wires the 7 phase-0 daemon memory endpoints onto the existing local HTTP
// server (sdk/prismer/src/daemon/local-server.ts) via the
// optional `attachMemory` hook on LocalServerOptions.
//
// Security (memory203 doc 08 §2 F2 → spec16 §8.1 MA-0S, fail-closed): every
// memory RPC MUST carry a per-agent scoped capability in the
// `x-prismer-memory-cap` header (minted by the daemon at agent-spawn, verified
// offline against the per-boot key — see cap.ts). There is NO enforce-off
// branch anymore (M-CAP-001): a missing cap → 401 `memory_cap_required`; an
// expired / tampered / forged cap → 401 `memory_cap_invalid`. The cap's
// workspace scope is authoritative and lives at the CAP layer (spec16 §13.4):
// a request for any other workspaceId (query, body, or `?uri=`) is a
// cap-layer workspace mismatch → 401 `memory_cap_invalid` (scopeOk below —
// there is no separate non-cap workspace-scope guard in this daemon). The
// acting identity is ALWAYS the verified cap subject — body/query actor
// fields are never trusted. Daemon-internal maintenance (outbox flush, WS
// invalidate, extraction) never enters these handlers — it writes the store
// in-process (see runner-wiring).
//
// Endpoints (all bound to 127.0.0.1):
//   GET  /local/memory/stats
//   GET  /local/memory/list?workspaceId=&pageType=&limit=
//   GET  /local/memory/conflicts?workspaceId=&limit=    (memory203 doc 07)
//   GET  /local/memory/health?workspaceId=&kind=&limit= (memory203/13 §P4 — Dream
//                                              CONVERGENCE candidate READ: FORWARDS
//                                              to cloud GET /memory/health/{orphans|
//                                              duplicates|stale}. The READ half the
//                                              orchestrator needs to DECIDE clusters
//                                              before calling the curation verbs.)
//   GET  /local/memory/search?workspaceId=&q=&topK=&maxBytes=
//   GET  /local/memory/place-context?workspaceId=&q=   (memory203/18 R6.2 — the
//                                              memory_browse "write-time structure
//                                              view": INDEX + hubs-with-snippet +
//                                              nearest pages, assembled by the SAME
//                                              helper the extraction leg uses)
//   GET  /local/memory/load?workspaceId=&path=  OR  ?uri=prismer://...
//   POST /local/memory/write                  body: MemoryWriteInput
//   POST /local/memory/flush                  body: { workspaceId }
//   POST /local/memory/invalidate             body: { workspaceId, pageIds[] }
//   POST /local/memory/observability/emit     body: MemoryOutboxEnvelopeT (T2-A)
//   POST /local/memory/curate                 body: { workspaceId, op, pageId?, reason? }
//                                              (MVP4 phase-1 — FORWARDS to cloud
//                                               curation endpoints; orchestrator
//                                               gate is cloud-side, passed through)
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

import { randomUUID, createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CloudClient } from '../../auth.js';
import type { MemoryRuntime } from './runtime.js';
import type {
  MemoryWriteInput,
  MemoryPage,
  MemoryPageType,
  MemorySearchResult,
  MemoryNavigation,
  MemoryVisibility,
} from './types.js';
import { assemblePlaceContext, bumpMemoryStageCounter } from './hook-server.js';
import { memoryPathToUri, normalizeMemoryPath } from './store.js';
import { buildRecallContext } from './extract.js';
import {
  checkDeliverableGate,
  deliverableProvenanceToken,
  parseDeliverableSource,
} from './deliverable-gate.js';
import { checkDescriptionGate, checkPkfProjection } from './write-gate.js';
import { buildManifest, finalizeSelected } from './fork/index.js';
import { getRecallStats } from './recall-stats.js';
import { ScopedMemoryStore } from './scoped-store.js';
import { sliceSection } from './section.js';
import { upgradeBareAssetUris, type ResolveAssetContentHash } from './bare-asset-upgrade.js';
import { promoteReferencedAssetSpans } from './span-mint.js';
import { verifyCap, renewCapV2, capAllowsWorkspace, isSystemCap, type MemoryCap } from './cap.js';
import { canCapReadAsset, canCapReadPage, capToReader, type AssetAclProjection } from './acl-predicate.js';
import { fetchPageFromCloudByPath } from './cloud-sync.js';
import type { MemoryKeyManager } from './key-manager.js';
import { createLogger } from '../../lib/logger.js';
import { canonicalDurabilityCommitKey } from '../../adapters/coding/shared/lifecycle/canonical-turn-identity.js';
import type { PostTurnPageReceipt } from '../../adapters/coding/shared/lifecycle/post-turn-store.js';
import { recordToolSequence } from './tool-sequence.js';


export interface MemoryWriteDurabilityRun {
  taskId: string | null;
  workspaceId: string;
  agentImUserId: string;
}

export interface AttachMemoryRpcOptions {
  runtime: MemoryRuntime;
  /**
   * Daemon cloud client. Used by the local-first `load` 回源 fallback and the
   * `curate` forward (cloud-side governance verbs). NOT used for extraction:
   * memory203/13 §0.5 retired the cloud-extract lane — extraction runs in the
   * agent's own runtime, never via cloud LLM. Absent (e.g. unit tests, or
   * cloud-unreachable boot) → load falls through to a local 404 and curate
   * degrades to a no-op (doc 18 §4c "降级不中断").
   */
  cloud?: CloudClient;
  /** Stamped onto scoped-store writes by the provider routes. Defaults to ''. */
  deviceId?: string;
  /**
   * Per-workspace key manager. Used by the local-first `load` fallback (07 §3):
   * when a页 misses locally and is回源'd from the cloud superset, an encrypted
   * row is decrypted with this before landing as local plaintext (fail-closed to
   * the unreadable sentinel when no key). Absent ⇒ encrypted回源 pages land as
   * sentinel; plaintext回源 unaffected.
   */
  keyManager?: MemoryKeyManager;
  /**
   * Exact provider-session → Cloud dispatch identity lookup. Direct writes
   * without an exact, matching active run remain ordinary local-first writes;
   * they must never guess a durability turn from agent recency.
   */
  resolveDurabilityRun?: (providerSessionId: string) => MemoryWriteDurabilityRun | null;
  recordExplicitMemoryReceipt?: (input: {
    providerSessionId: string;
    workspaceId: string;
    agentImUserId: string;
    canonicalTurnId: string;
    receipt: PostTurnPageReceipt;
  }) => void;
  /**
   * pkf v1.1 §4.7 — assetId → contentHash lookup backing the write-time
   * bare-asset-URI upgrade (see bare-asset-upgrade.ts). The runner wires this
   * to the workspace AssetMetadataIndex (with an on-demand cloud delta pull on
   * a miss). Absent / null / throwing → the bare pointer degrades to the
   * workspace-scoped assetId form (still v1.1-valid); the write is NEVER
   * blocked by this lookup.
   */
  resolveAssetContentHash?: ResolveAssetContentHash;
  /**
   * memory211 fix round (external review P1) — assetId → Asset-ACL projection
   * for the T3 chunk lane's cap boundary (`canCapReadAsset`). The runner wires
   * this to the workspace AssetMetadataIndex (local read, no I/O); an unwired
   * resolver / an asset with no verdict FAILS CLOSED (the chunk hit is dropped,
   * never leaked), so the lane degrades to wiki-only instead of failing open.
   */
  resolveAssetAcl?: ResolveAssetAcl;
}

const MEMORY_PATH_PREFIX = '/local/memory/';

/**
 * assetId → the Asset-ACL attributes the daemon holds for it (memory211 fix
 * round, external review P1). Synchronous + local by design: the search hot
 * path must not grow a network leg, and the projection is refreshed by the
 * same `/assets/index` channel that feeds `#filename` resolution. Returns
 * null when the asset has no readable verdict — the boundary then DENIES.
 */
export type ResolveAssetAcl = (workspaceId: string, assetId: string) => AssetAclProjection | null;

export function attachMemoryRpc(
  opts: AttachMemoryRpcOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const {
    runtime,
    cloud,
    deviceId = '',
    keyManager,
    resolveDurabilityRun,
    recordExplicitMemoryReceipt,
    resolveAssetContentHash,
    resolveAssetAcl,
  } = opts;

  return async (req, res) => {
    const url = req.url ?? '/';
    if (!url.startsWith(MEMORY_PATH_PREFIX) && url !== '/local/memory') return false;

    // Strip query string for routing.
    const [pathOnly = '', queryRaw = ''] = url.split('?', 2);
    const query = parseQuery(queryRaw);
    const subpath = pathOnly.slice(MEMORY_PATH_PREFIX.length); // '' if exactly '/local/memory/'
    const method = req.method ?? 'GET';

    // Long-running adapters (Hermes gateway) outlive the 15-minute cap TTL.
    // Renewal accepts only a still-authentic v2 token from this daemon boot,
    // then re-mints from the CURRENT authority snapshot. It intentionally runs
    // before the normal expiry gate; renewCapV2 itself rejects v1, tampering,
    // daemon restarts, snapshot expiry/invalidation, and removed actors.
    if (method === 'POST' && subpath === 'cap/refresh') {
      const presented = readHeader(req, 'x-prismer-memory-cap');
      const renewed = renewCapV2(presented);
      const verified = verifyCap(renewed);
      if (!renewed || !verified) {
        process.stderr.write(
          `[memory-rpc:cap] refresh deny reason=cap_invalid` +
            `${presented ? ` capHash=${capHashPrefix(presented)}` : ''}\n`,
        );
        respond(res, 401, { error: 'memory_cap_invalid' });
        return true;
      }
      respond(res, 200, { cap: renewed, exp: verified.exp });
      return true;
    }

    // ─── cap gate (doc 08 §2 F2 → spec16 §8.1 MA-0S, always fail-closed) ───
    // Every memory RPC must carry a per-agent scoped capability in the
    // `x-prismer-memory-cap` header; verifyCap re-checks the daemon's own
    // per-boot HMAC offline (µs-level, local-first). Missing → 401
    // `memory_cap_required`; invalid (expired / bad signature / tampered
    // payload / wrong version) → 401 `memory_cap_invalid`. The deleted
    // PRISMER_MEMORY_CAP_ENFORCE escape must never return (a security hotfix
    // cannot flag back into the no-cap bypass — M-CAP-001). The scope check
    // itself is per-handler (each resolves its workspaceId from query/body/
    // uri); `cap` is threaded into every handler below and is never null.
    // Deny logs carry only the reasonCode + a sha256 prefix of the presented
    // token — never the full cap or signature.
    const capToken = readHeader(req, 'x-prismer-memory-cap');
    const cap = verifyCap(capToken);
    if (!cap) {
      process.stderr.write(
        `[memory-rpc:cap] deny reason=${capToken ? 'cap_invalid' : 'cap_required'}` +
          `${capToken ? ` capHash=${capHashPrefix(capToken)}` : ''}` +
          ` method=${method} subpath=${subpath}\n`,
      );
      respond(res, 401, { error: capToken ? 'memory_cap_invalid' : 'memory_cap_required' });
      return true;
    }

    try {
      if (method === 'GET' && subpath === 'stats') {
        return handleStats(runtime, query, res, cap);
      }
      if (method === 'GET' && subpath === 'list') {
        return handleList(runtime, query, res, cap);
      }
      if (method === 'GET' && subpath === 'conflicts') {
        return handleConflicts(runtime, query, res, cap);
      }
      if (method === 'GET' && subpath === 'health') {
        return await handleHealth(cloud, query, res, cap);
      }
      if (method === 'GET' && subpath === 'search') {
        return await handleSearch(runtime, query, res, deviceId, cap, resolveAssetAcl, cloud);
      }
      if (method === 'GET' && subpath === 'place-context') {
        return handlePlaceContext(runtime, query, res, cap);
      }
      if (method === 'GET' && subpath === 'load') {
        return await handleLoad(runtime, query, res, deviceId, cap, cloud, keyManager);
      }
      if (method === 'POST' && subpath === 'write') {
        const body = await readJson(req);
        return await handleWrite(
          runtime,
          deviceId,
          body,
          res,
          cap,
          cloud,
          keyManager,
          resolveDurabilityRun,
          recordExplicitMemoryReceipt,
          resolveAssetContentHash,
        );
      }
      if (method === 'POST' && subpath === 'flush') {
        const body = await readJson(req);
        return handleFlush(runtime, body, res, cap);
      }
      // memory211/01 W5 轴 H — `sync` is the CLI-facing alias of `flush`: the
      // CLI's `memory sync` used to probe only the legacy `/memory/sync` paths,
      // which no daemon exposes, so the verb always reported the gateway as
      // unavailable. Same handler, same ws cap gate.
      if (method === 'POST' && subpath === 'sync') {
        const body = await readJson(req);
        return handleFlush(runtime, body, res, cap);
      }
      // memory211/01 W5 轴 H — soft-delete a page. Deletion authority lives
      // CLOUD-side (the destructive command + ACL), so this forwards exactly
      // like the curate verbs and passes the cloud verdict through.
      if (method === 'POST' && subpath === 'delete') {
        const body = await readJson(req);
        return await handleDelete(cloud, runtime, body, res, cap);
      }
      if (method === 'POST' && subpath === 'invalidate') {
        const body = await readJson(req);
        return handleInvalidate(runtime, body, res, cap);
      }
      if (method === 'POST' && subpath === 'observability/emit') {
        const body = await readJson(req);
        return handleObservabilityEmit(runtime, body, res, cap);
      }
      // M-B (doc 25 §3 支柱 2) — fork-recall 2-call protocol. The host
      // calls /recall/manifest first to get candidate pages (Stage 1),
      // runs its own LLM selector (Stage 2), then POSTs the selection
      // to /recall/finalize for content-snippet resolution (Stage 3).
      if (method === 'GET' && subpath === 'recall/manifest') {
        return handleRecallManifest(runtime, query, res, cap);
      }
      if (method === 'POST' && subpath === 'recall/finalize') {
        const body = await readJson(req);
        return handleRecallFinalize(runtime, body, res, cap);
      }
      // ─── Retired extract routes (memory203/13 §0.5) ────────────────────
      // `extract-turn` / `extract-compress` USED to forward the agent's turns
      // to the cloud `/api/im/memory/extract` LLM. That cloud-extraction
      // architecture is RETIRED: per §0.5 all memory LLM work runs in the
      // agent's OWN runtime (automatic auto-extraction is now Hermes's native
      // background_review, which calls memory_write directly). The cloud does
      // ZERO LLM for memory. We keep the routes addressable so an older provider
      // shell never 404s, but they are inert no-ops (410-equivalent) and forward
      // NOTHING to any cloud LLM. The shell has been neutered to stop calling
      // them (plugins/memory/prismer/__init__.py).
      if (method === 'POST' && (subpath === 'extract-turn' || subpath === 'extract-compress')) {
        respond(res, 200, { ok: true, retired: true, reason: 'cloud_extract_retired_memory203_13_0_5' });
        return true;
      }
      if (method === 'POST' && subpath === 'mirror') {
        const body = await readJson(req);
        return handleMirror(runtime, deviceId, body, res, cap);
      }
      // ─── Curation governance route (memory203 MVP4 phase-1) ────────────────
      // The curation verbs (promote_to_hub / supersede /
      // rebuild_index) live CLOUD-side (they operate on the superset:
      // sections / proposal / authority), not on the daemon local subset. So
      // unlike search/load (which read the local FTS5 store), this route
      // FORWARDS to the matching cloud endpoint via `cloud` and returns the
      // cloud response verbatim — including the cloud's own
      // orchestrator_only 403 (memory-acl.ts). The daemon only gates the ws
      // cap here; it does NOT re-implement or re-gate the orchestrator check.
      if (method === 'POST' && subpath === 'curate') {
        const body = await readJson(req);
        return await handleCurate(cloud, body, res, cap);
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
  cap: MemoryCap,
): boolean {
  // A scoped (non-system) cap with no explicit workspaceId is forced to its
  // own ws — a global aggregate would otherwise leak cross-workspace counts.
  let workspaceId = query.workspaceId;
  if (!workspaceId && !capAllowsWorkspace(cap, '*')) workspaceId = cap.ws;
  if (workspaceId) {
    if (!scopeOk(cap, workspaceId, res)) return true;
    // Use peek so a stranger /stats?workspaceId= doesn't implicitly open a
    // store for a workspace that was never written to.
    const slot = runtime.peek(workspaceId);
    respond(res, 200, slot ? slot.store.stats() : { workspaceId, pageCount: 0, pendingOutbox: 0, deadLetterCount: 0, lastSyncAt: null, dbPath: null });
    return true;
  }
  // Global stats: aggregate across all open workspaces (system cap / no-cap).
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
  cap: MemoryCap,
): boolean {
  const workspaceId = effectiveWs(cap, query.workspaceId);
  if (!workspaceId) return respond400(res, 'workspaceId query param required');
  if (!scopeOk(cap, workspaceId, res)) return true;
  const pageType = query.pageType as MemoryPageType | undefined;
  const limit = query.limit ? Number(query.limit) : undefined;
  const slot = runtime.resolve(workspaceId);
  const pages = slot.store.list({ pageType, limit });
  // F5 boundary predicate (doc 08 §2.5): hide other agents' agent/private pages
  // from the listing. Workspace-visible pages are unaffected.
  const visible = pages.filter((p) => canCapReadPage(cap, p));
  respond(res, 200, { pages: visible });
  return true;
}

/**
 * GET /local/memory/conflicts?workspaceId=&limit= — memory203 doc 07. Lists the
 * LOCAL pages this device knows are in `'remote-conflict'`: its own writes that
 * lost an LWW conflict the cloud resolved, learned on down-sync re-pull
 * (cloud-sync.ts `materialisePage` → `store.setSyncStatus`). The host shows
 * 「我的写在另一台设备上失败了」without polling the cloud
 * `/memory/health/conflicts`. F5 boundary predicate applies (a scoped cap only
 * sees pages it can read), exactly like `handleList`.
 */
function handleConflicts(
  runtime: MemoryRuntime,
  query: Record<string, string>,
  res: ServerResponse,
  cap: MemoryCap,
): boolean {
  const workspaceId = effectiveWs(cap, query.workspaceId);
  if (!workspaceId) return respond400(res, 'workspaceId query param required');
  if (!scopeOk(cap, workspaceId, res)) return true;
  const limit = query.limit ? Number(query.limit) : undefined;
  // peek (not resolve): a workspace never synced has no conflicts and we don't
  // want to implicitly open a store just to answer "no conflicts".
  const slot = runtime.peek(workspaceId);
  if (!slot) {
    respond(res, 200, { pages: [] });
    return true;
  }
  const pages = slot.store.listRemoteConflicts(limit);
  const visible = pages.filter((p) => canCapReadPage(cap, p));
  respond(res, 200, { pages: visible });
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

// memory211/01 §3 轴C W1a — batch recall bound. Spec open ruling point 1 leaves
// the ceiling + over-limit semantics open; this is the W1 default (slice to the
// bound, flag `truncated`), revisable without a wire change.
const MAX_BATCH_QUERIES = 8;

/**
 * memory211/01 §3 轴C W1a — batch recall. `queries` (a JSON array in the query
 * string) runs up to {@link MAX_BATCH_QUERIES} recalls in ONE tool call; the
 * single-`q` form is unchanged. Returns
 * `{ query, results, resultsByQuery: [{query, results}...], truncated? }` where
 * `query`/`results` stay the FIRST query's — an old consumer reading only those
 * two fields sees byte-for-byte today's shape.
 */
async function handleSearch(
  runtime: MemoryRuntime,
  query: Record<string, string>,
  res: ServerResponse,
  deviceId: string,
  cap: MemoryCap,
  resolveAssetAcl?: ResolveAssetAcl,
  cloud?: CloudClient,
): Promise<boolean> {
  const workspaceId = effectiveWs(cap, query.workspaceId);
  if (!workspaceId) return respond400(res, 'workspaceId query param required');
  if (!scopeOk(cap, workspaceId, res)) return true;
  const parsed = parseSearchQueries(query);
  if (!parsed.ok) return respond400(res, parsed.message);
  const { queries, truncated } = parsed;
  // W7 item 1 — one trace per recall (plus a second `stage=navigate` line when
  // the miss lane fired). Counts and durations only; never the query text.
  const traceId = readTraceId(query);
  const traceStartedAt = Date.now();
  const topK = query.topK ? Number(query.topK) : undefined;
  const maxBytes = query.maxBytes ? Number(query.maxBytes) : undefined;
  const sourceWorkspaceId = query.sourceWorkspaceId?.trim();
  if (sourceWorkspaceId && sourceWorkspaceId !== workspaceId) {
    return await handleExternalSearch(cloud, {
      sourceWorkspaceId,
      targetWorkspaceId: workspaceId,
      queries,
      limit: topK,
      truncated,
      traceId,
      traceStartedAt,
      res,
      cap,
    });
  }

  // Phase-0 ships single-value pageType matching the canonical TS adapter
  // contract (sdk/prismer/src/adapters/memory-tools.ts:170).
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
  const actorImUserId = isSystemCap(cap) ? undefined : cap.sub;
  // memory211/01 §6.9 裁决 1 — navigation is judged PER QUERY: query A can hit
  // while query B misses, so each group carries its own (optional) payload.
  const resultsByQuery = queries.map((q) => {
    const { results, navigation } = runWorkspaceSearch(slot, cap, workspaceId, q, {
      topK,
      maxBytes,
      pageType,
      resolveAssetAcl,
    });
    // M-RECALL-EMIT — one recall_pull per query: a batched call carries N
    // distinct recall intents, and collapsing them would under-count M1
    // adoption. Best-effort (旁路; never blocks the response).
    emitRecallPull(slot.outbox, deviceId, {
      workspaceId,
      actorImUserId,
      actorKind: 'agent',
      query: q,
      tool: 'memory_search',
      topK: topK ?? null,
      hitCount: results.length,
      pageId: results[0]?.pageId,
    });
    return { query: q, results, ...(navigation ? { navigation } : {}) };
  });
  // doc 18 §8 — every /local/memory/search is an agent-driven recall (the P0
  // main path); count it so recallStats.toolRecallCount reflects "did the agent
  // self-recall?" regardless of in-process vs out-of-process (hermes) caller.
  getRecallStats().recordToolRecall();
  // W7 item 1 (D11-5) — the read-side trace the write lane always had.
  const recalledResults = resultsByQuery.flatMap((g) => g.results);
  const navigatedQueries = resultsByQuery.filter((g) => g.navigation);
  emitReadTrace({
    stage: 'search',
    queries: queries.length,
    navigation_used: navigatedQueries.length > 0,
    tiers: tierDistribution(recalledResults),
    results: recalledResults.length,
    duration_ms: Date.now() - traceStartedAt,
    traceId,
  });
  if (navigatedQueries.length > 0) {
    emitReadTrace({
      stage: 'navigate',
      queries: navigatedQueries.length,
      start_points: navigatedQueries.reduce((n, g) => n + (g.navigation?.startPoints.length ?? 0), 0),
      duration_ms: Date.now() - traceStartedAt,
      traceId,
    });
  }
  // W7 item 4 (D11-4) — the behaviour record the turn metrics and the GQ
  // `behavior` category grade. verb + counts only: the query text never enters
  // the ring (see tool-sequence.ts).
  recordToolSequence(workspaceId, {
    verb: 'search',
    path: '',
    durationMs: Date.now() - traceStartedAt,
    at: new Date(traceStartedAt).toISOString(),
    queries: queries.length,
    ...(navigatedQueries.length > 0 ? { navigation: 1 as const } : { navigation: 0 as const }),
  });
  respond(res, 200, {
    query: queries[0],
    results: resultsByQuery[0]?.results ?? [],
    // Mirrors `results`: the FIRST query's navigation, so a single-query caller
    // reads the payload off the top level and never has to index the batch.
    ...(resultsByQuery[0]?.navigation ? { navigation: resultsByQuery[0]!.navigation } : {}),
    resultsByQuery,
    ...(truncated ? { truncated: true } : {}),
  });
  return true;
}

async function handleExternalSearch(
  cloud: CloudClient | undefined,
  input: {
    sourceWorkspaceId: string;
    targetWorkspaceId: string;
    queries: string[];
    limit?: number;
    truncated: boolean;
    traceId: string | undefined;
    traceStartedAt: number;
    res: ServerResponse;
    cap: MemoryCap;
  },
): Promise<boolean> {
  if (!cloud) {
    respond(input.res, 503, { ok: false, error: 'cloud_not_wired' });
    return true;
  }
  const params = new URLSearchParams({ workspaceId: input.targetWorkspaceId });
  const actorHeader = !isSystemCap(input.cap) ? { 'X-Prismer-Memory-Actor': input.cap.sub } : undefined;
  const resp = await cloud.request<{ ok?: boolean; data?: unknown }>('POST', `/api/im/memory/external/search?${params}`, {
    body: {
      sourceWorkspaceId: input.sourceWorkspaceId,
      queries: input.queries,
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    },
    timeoutMs: 20_000,
    ...(actorHeader ? { headers: actorHeader } : {}),
  });
  if (!resp.ok) {
    respond(input.res, resp.status || 502, {
      ok: false,
      error: resp.error?.code ?? 'cloud_request_failed',
      message: resp.error?.message ?? `cloud returned HTTP ${resp.status}`,
    });
    return true;
  }
  const data = resp.data && typeof resp.data === 'object' && 'data' in resp.data ? resp.data.data : resp.data;
  const body = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const results = Array.isArray(body.results) ? body.results : [];
  const groups = Array.isArray(body.resultsByQuery) ? body.resultsByQuery : [];
  emitReadTrace({
    stage: 'search',
    queries: input.queries.length,
    navigation_used: Boolean(body.navigation),
    tiers: `grant:${results.length}`,
    results: results.length,
    duration_ms: Date.now() - input.traceStartedAt,
    ...(input.traceId ? { traceId: input.traceId } : {}),
  });
  recordToolSequence(input.targetWorkspaceId, {
    verb: 'search',
    path: '',
    durationMs: Date.now() - input.traceStartedAt,
    at: new Date(input.traceStartedAt).toISOString(),
    queries: input.queries.length,
    navigation: body.navigation ? 1 : 0,
  });
  getRecallStats().recordToolRecall();
  respond(input.res, 200, {
    query: input.queries[0],
    results,
    ...(body.navigation ? { navigation: body.navigation } : {}),
    resultsByQuery: groups,
    ...(input.truncated || body.truncated ? { truncated: true } : {}),
  });
  return true;
}

/**
 * Resolve the query list for one search request. The legacy `q`/`query` params
 * are the single-query form; `queries` (JSON array) is the W1a batch form and
 * wins when both are present.
 */
function parseSearchQueries(
  query: Record<string, string>,
): { ok: true; queries: string[]; truncated: boolean } | { ok: false; message: string } {
  const raw = query.queries;
  if (raw !== undefined && raw.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, message: 'queries must be a JSON array of strings' };
    }
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      parsed.some((s) => typeof s !== 'string')
    ) {
      return { ok: false, message: 'queries must be a non-empty JSON array of strings' };
    }
    const cleaned = parsed.map((s) => s.trim()).filter((s) => s.length > 0);
    if (cleaned.length === 0) {
      return { ok: false, message: 'queries must contain at least one non-empty query' };
    }
    return {
      ok: true,
      queries: cleaned.slice(0, MAX_BATCH_QUERIES),
      truncated: cleaned.length > MAX_BATCH_QUERIES,
    };
  }
  const q = query.q ?? query.query ?? '';
  if (!q) return { ok: false, message: 'q (or queries) param required' };
  return { ok: true, queries: [q], truncated: false };
}

/**
 * One query's recall: hybrid search + the F5 boundary predicate (doc 08 §2.5,
 * search收口) — within the cap's workspace, hide other agents' agent/private
 * page hits, because a private page's snippet must not leak via search any more
 * than via load/list. The per-hit page lookup is a bounded SQLite point query
 * (topK ≤ 20). Workspace-visible pages are unaffected.
 *
 * memory211 fix round (external review P1) — the SAME boundary now covers the
 * T3 chunk lane: a chunk hit addresses an ASSET (`pageId` mirrors the assetId,
 * `memory_pages` never has a row for it), so it was previously judged by the
 * `!page` pass and always kept — fail-OPEN where the hook recall path fails
 * CLOSED. Chunk hits are judged by `canCapReadAsset` against the workspace's
 * asset projection; an asset with no resolvable verdict is dropped.
 */
function runWorkspaceSearch(
  slot: ReturnType<MemoryRuntime['resolve']>,
  cap: MemoryCap,
  workspaceId: string,
  q: string,
  options: {
    topK?: number;
    maxBytes?: number;
    pageType?: MemoryPageType[];
    resolveAssetAcl?: ResolveAssetAcl;
  },
): { results: MemorySearchResult[]; navigation?: MemoryNavigation } {
  // memory211/01 §6.9 裁决 1 — the navigation payload rides the same recall and
  // the same boundary predicate as the hits it replaces the fake-ranked lane
  // with.
  const { results: recalled, navigation } = slot.search.hybridWithNavigation(q, options);
  const results = recalled.filter((r) => {
    // T3 chunk hit: the asset, not a page, is the resource. Judged on the
    // asset projection (visibility / owner), DENY when the daemon cannot
    // verify it. `r.assetId` is set on every chunk hit (`search.ts` mint); a
    // wiki hit never carries it.
    if (r.assetId) {
      return canCapReadAsset(cap, options.resolveAssetAcl?.(workspaceId, r.assetId));
    }
    const page = slot.store.loadById(r.pageId);
    // Drop only a confirmed private page the cap can't read; a missing row
    // (FTS/store race) is left in place (no content leak — it has no page).
    return !page || canCapReadPage(cap, page);
  });
  // memory211/01 §6.9 裁决 1 + W6-finish fix round 1 (F2) — the SAME boundary
  // applies to the miss-lane navigation. A start point carries path + title +
  // childrenCount, which is exactly what a scoped cap must not learn about a
  // hub/INDEX it cannot read (the cloud side already filters start points
  // through `allowedPageIds` + the per-row read verdict). An unreadable entry is
  // dropped, not downgraded; if nothing survives there is no navigation to give.
  let visibleNavigation = navigation;
  if (navigation) {
    const startPoints = navigation.startPoints.filter((sp) => {
      const page = slot.store.loadByPath(sp.path);
      return !page || canCapReadPage(cap, page);
    });
    visibleNavigation = startPoints.length > 0 ? { ...navigation, startPoints } : undefined;
  }
  return { results, ...(visibleNavigation ? { navigation: visibleNavigation } : {}) };
}

/**
 * GET /local/memory/place-context?workspaceId=&q=  (memory203/18 R6.2 — the
 * memory_browse正门). "Write-time structure view": EXACTLY the
 * buildRecallContext inputs the background-extraction leg uses — the INDEX
 * (with snippet), the hub pages WITH a note on what each is about (R6.1), and,
 * when `q` is present, the nearest pages via the same local hybrid search.
 * Assembled by the SHARED `assemblePlaceContext` helper (hook-server.ts) so
 * browse and extraction cannot drift. `q` absent → `nearest` is [] (structure
 * only). Response: `{ index: {...}|null, hubs: [...], hubsByRecent: [...],
 * nearest: [...] }`, every entry a `{ path, title, pageType, snippet }`;
 * hub rows additionally carry `children` + `updatedAt` and `hubsByRecent[]`
 * is the same hub set in recency order (memory211/03 §7 B1 — additive only).
 */
function handlePlaceContext(
  runtime: MemoryRuntime,
  query: Record<string, string>,
  res: ServerResponse,
  cap: MemoryCap,
): boolean {
  const workspaceId = effectiveWs(cap, query.workspaceId);
  if (!workspaceId) return respond400(res, 'workspaceId query param required');
  if (!scopeOk(cap, workspaceId, res)) return true;
  const q = (query.q ?? query.query ?? '').trim();
  // W7 item 1 — `stage=browse` is the read trace of the memory_browse tool
  // (`/local/memory/place-context`). `queried` is a boolean, not the query text.
  const traceId = readTraceId(query);
  const traceStartedAt = Date.now();
  const slot = runtime.resolve(workspaceId);
  // F5 boundary predicate parity (doc 08 §2.5) + product204/34 Track 0.1c: hide
  // other agents' agent/private pages AND every non-member role/council page
  // from the hub + nearest listings, exactly like handleSearch/handleList — a
  // page's snippet must not leak via browse either. The filter now lives INSIDE
  // assemblePlaceContext (single source; hub/nearest/recent can't drift), driven
  // by a cap-derived reader.
  const parts = assemblePlaceContext(slot, q || undefined, capToReader(cap));
  // Project through the SAME buildRecallContext slicing the extraction prompt
  // gets (400-char INDEX snippet / 200-char hub+nearest snippets), so what the
  // browsing agent sees is byte-compatible with what the extract model sees.
  const [index] = buildRecallContext(parts.indexPage, parts.indexSnippet, [], []);
  // memory211/01 §3 轴C W1a — tree-shaped browse: each hub carries its child-of
  // children. buildRecallContext projects to the flat {path,title,pageType,
  // snippet} row the extract model sees (it does not know about children), so
  // the child arrays are zipped back on by path afterwards — hub list and child
  // lists stay a single assembly in assemblePlaceContext (no drift).
  const childrenByPath = new Map(parts.hubPages.map((h) => [h.path, h.children]));
  const hubs = buildRecallContext(null, null, parts.hubPages, [], 20).map((h) => {
    const children = childrenByPath.get(h.path) ?? [];
    return {
      ...h,
      children,
      // memory211/03 §7 B1 — freshness signal at the finest granularity the
      // browse shape gives: the hub row's own updatedAt, spread with the latest
      // write of its direct child-of children (a hub row is not re-touched when
      // a leaf under it is written, so the hub's own timestamp alone would hide
      // fresh subtree activity). Epoch ms — same unit as MemoryPage.updatedAt.
      updatedAt: latestHubUpdatedAt(slot, h.path, children),
    };
  });
  // memory211/03 §7 B1 (v1.1 评审修正 V3) — explicit recency sequence: the SAME
  // hub set sorted by that `updatedAt` DESC. `index`/`hubs[]` order is
  // untouched (structure-first, zero regression for existing consumers);
  // `hubsByRecent[]` is the additive recency signal — 结构序为主 + 显式 hubsByRecent.
  const hubsByRecent = [...hubs].sort((a, b) => b.updatedAt - a.updatedAt);
  // `nearest` is unchanged this wave: ordering it by graph DISTANCE (how many
  // hops from the queried node) needs the W1b alignment of the search/graph
  // layer, and is recorded as deferred rather than approximated here.
  const nearest = buildRecallContext(null, null, [], parts.nearest);
  emitReadTrace({
    stage: 'browse',
    hubs: hubs.length,
    nearest: nearest.length,
    queried: q.length > 0,
    duration_ms: Date.now() - traceStartedAt,
    traceId,
  });
  recordToolSequence(workspaceId, {
    verb: 'browse',
    path: '',
    durationMs: Date.now() - traceStartedAt,
    at: new Date(traceStartedAt).toISOString(),
  });
  respond(res, 200, { index: index ?? null, hubs, hubsByRecent, nearest });
  return true;
}

/**
 * memory211/03 §7 B1 — freshest write across a hub's browse subtree: the hub
 * row's own `updatedAt`, spread with each child page's `updatedAt` when newer.
 * `children` are exactly the direct child-of rows the browse tree already
 * surfaces, so no path outside the response payload is touched. A child whose
 * page row is missing locally (link without page) is ignored. Epoch ms, same
 * unit as `MemoryPage.updatedAt` (the daemon surfaces this unit on memory_load
 * results too).
 */
function latestHubUpdatedAt(
  slot: ReturnType<MemoryRuntime['resolve']>,
  hubPath: string,
  children: Array<{ path: string; title: string | null }>,
): number {
  let latest = slot.store.loadByPath(hubPath)?.updatedAt ?? 0;
  for (const child of children) {
    const childTs = slot.store.loadByPath(child.path)?.updatedAt;
    if (childTs !== undefined) latest = Math.max(latest, childTs);
  }
  return latest;
}

async function handleLoad(
  runtime: MemoryRuntime,
  query: Record<string, string>,
  res: ServerResponse,
  deviceId: string,
  cap: MemoryCap,
  cloud: CloudClient | undefined,
  keyManager: MemoryKeyManager | undefined,
): Promise<boolean> {
  let workspaceId = query.workspaceId;
  let pagePath = query.path;
  // memory202/09 P0: `?section=` query param, or the `#section` anchor embedded
  // in `?uri=`. Query param wins when both are present.
  let section = query.section;
  if (query.uri) {
    const parsed = parsePrismerUri(query.uri);
    if (!parsed) return respond400(res, `uri ${query.uri} is not a valid prismer:// memory URI`);
    workspaceId = parsed.workspaceId;
    pagePath = parsed.path;
    if (!section && parsed.section) section = parsed.section;
  }
  workspaceId = effectiveWs(cap, workspaceId);
  if (!workspaceId) return respond400(res, 'workspaceId (or uri) required');
  if (!pagePath) return respond400(res, 'path (or uri) required');
  // Scope gate on the URI-or-query-resolved ws (a cross-ws `?uri=` is a
  // cap-layer 401, not a silent load of another workspace's page).
  if (!scopeOk(cap, workspaceId, res)) return true;
  const sourceWorkspaceId = query.sourceWorkspaceId?.trim();
  if (sourceWorkspaceId && sourceWorkspaceId !== workspaceId) {
    return await handleExternalLoad(cloud, {
      sourceWorkspaceId,
      targetWorkspaceId: workspaceId,
      path: pagePath,
      section,
      res,
      cap,
    });
  }
  // W7 item 1 — the direct-recall leg gets its own read trace, on the miss (404)
  // as well as the hit: a load that 404s is still navigation behaviour worth
  // counting. Page path only (the write lane logs paths too); never the content.
  const traceId = readTraceId(query);
  const traceStartedAt = Date.now();
  // W7 item 4 — the same terminal step appends the behaviour entry. `path` is
  // the page path (allowed); a load never carries query text by construction.
  const finishLoad = (found: boolean): void => {
    emitReadTrace({
      stage: 'load',
      path: pagePath!,
      found,
      duration_ms: Date.now() - traceStartedAt,
      traceId,
    });
    recordToolSequence(workspaceId, {
      verb: 'load',
      path: pagePath!,
      durationMs: Date.now() - traceStartedAt,
      at: new Date(traceStartedAt).toISOString(),
    });
  };
  const slot = runtime.resolve(workspaceId);
  let page = slot.store.loadByPath(pagePath);
  // memory203 doc 07 §3 — local-first fallback: a subset MISS triggers a
  // targeted回源 from the cloud superset (GET /memory/resolve?uri=), which
  // materialises just this page into the local store; we then re-load it
  // locally (<5ms FTS). Strictly best-effort + local-first: if the cloud is
  // unreachable the fetch returns false and we fall through to a genuine 404 —
  // "断云仍 load 本地" never regresses to a 5xx. Only when the page is truly
  // absent locally (no point回源'ing a hit).
  if (!page && cloud) {
    const filled = await fetchPageFromCloudByPath(cloud, runtime, workspaceId, pagePath, keyManager);
    if (filled) page = slot.store.loadByPath(pagePath);
  }
  // doc 18 §8 — a memory_load is also an agent-driven recall (P0 path); count
  // it before the 404 branch so an attempted load of a missing page still
  // registers as agent recall intent.
  getRecallStats().recordToolRecall();
  // M-RECALL-EMIT — a memory_load is a directed self-recall ("recall_pull").
  // Emit before the 404 branch so an attempted load of a missing page still
  // registers as recall intent. Best-effort (旁路; never blocks the response).
  emitRecallPull(slot.outbox, deviceId, {
    workspaceId,
    actorImUserId: isSystemCap(cap) ? undefined : cap.sub,
    actorKind: 'agent',
    query: pagePath,
    tool: 'memory_load',
    topK: null,
    hitCount: page ? 1 : 0,
    pageId: page?.id,
  });
  if (!page) {
    finishLoad(false);
    respond(res, 404, { error: 'memory_page_not_found', workspaceId, path: pagePath });
    return true;
  }
  // F5 boundary predicate (doc 08 §2.5): within the cap's workspace, an agent
  // may still only read its own agent/private pages. Deny → 404 (not 403), so a
  // cross-agent private page is indistinguishable from a missing one (no
  // existence leak).
  if (!canCapReadPage(cap, page)) {
    finishLoad(false);
    respond(res, 404, { error: 'memory_page_not_found', workspaceId, path: pagePath });
    return true;
  }
  const content = slot.store.loadContent(page.id);
  const fullContent = content?.content ?? null;
  // memory202/09 P0: when a section anchor is given and it resolves, return just
  // that sub-section (heading → next same/higher heading). Unmatched anchor or
  // null content falls back to the whole page (page-level behaviour unchanged).
  let body = fullContent;
  if (section && fullContent) {
    const sliced = sliceSection(fullContent, section);
    if (sliced !== null) body = sliced;
  }
  // memory203/18 R6.2 — additively include the page's outbound links so
  // 「顺着索引往下看」is executable from memory_load (the read side of the
  // browse→load→write loop). The authoritative edge table (im_memory_links)
  // lives CLOUD-side, so this is a best-effort forward (same cloud-call
  // pattern as handleCurate).
  //
  // memory211/01 §3 轴C W1a — the old "offline → omit `links`" hole is closed:
  // when the cloud transfer does NOT answer (no cloud wired, transport failure,
  // or a non-2xx), the daemon falls back to its OWN `memory_links` mirror and
  // assembles the same `{ outbound, backlinks }` envelope. An authoritative
  // cloud answer (ok, even when empty) is never overridden — the local table is
  // the offline truth, not a competing one. A load still never regresses to a
  // 5xx.
  let links: unknown;
  if (cloud) {
    try {
      const resp = await cloud.request<{ ok?: boolean; data?: unknown }>(
        'GET',
        `/api/im/memory/pages/${encodeURIComponent(page.id)}/links?workspaceId=${encodeURIComponent(workspaceId)}`,
        { timeoutMs: 5_000 },
      );
      if (resp.ok) {
        links =
          resp.data && typeof resp.data === 'object' && 'data' in resp.data
            ? resp.data.data
            : resp.data;
      }
    } catch {
      /* best-effort — local-first load must not fail on a cloud hiccup */
    }
  }
  if (links === undefined) links = slot.store.pageLinks(page.path);
  finishLoad(true);
  respond(res, 200, {
    page,
    content: body,
    section: section ?? null,
    ...(links !== undefined ? { links } : {}),
  });
  return true;
}

async function handleExternalLoad(
  cloud: CloudClient | undefined,
  input: {
    sourceWorkspaceId: string;
    targetWorkspaceId: string;
    path: string;
    section?: string;
    res: ServerResponse;
    cap: MemoryCap;
  },
): Promise<boolean> {
  if (!cloud) {
    respond(input.res, 503, { ok: false, error: 'cloud_not_wired' });
    return true;
  }
  const params = new URLSearchParams({ workspaceId: input.targetWorkspaceId });
  const actorHeader = !isSystemCap(input.cap) ? { 'X-Prismer-Memory-Actor': input.cap.sub } : undefined;
  const resp = await cloud.request<{ ok?: boolean; data?: unknown }>('POST', `/api/im/memory/external/load?${params}`, {
    body: {
      sourceWorkspaceId: input.sourceWorkspaceId,
      path: input.section ? `${input.path}#${input.section}` : input.path,
      format: 'both',
    },
    timeoutMs: 20_000,
    ...(actorHeader ? { headers: actorHeader } : {}),
  });
  if (!resp.ok) {
    respond(input.res, resp.status || 502, {
      ok: false,
      error: resp.error?.code ?? 'cloud_request_failed',
      message: resp.error?.message ?? `cloud returned HTTP ${resp.status}`,
    });
    return true;
  }
  const data = resp.data && typeof resp.data === 'object' && 'data' in resp.data ? resp.data.data : resp.data;
  const external = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const externalPage =
    external.page && typeof external.page === 'object' ? (external.page as Record<string, unknown>) : {};
  const page = {
    id: String(externalPage.pageId ?? ''),
    path: String(externalPage.path ?? input.path),
    title: typeof externalPage.title === 'string' ? externalPage.title : null,
    pageType: typeof externalPage.pageType === 'string' ? externalPage.pageType : 'leaf',
    version: typeof externalPage.version === 'number' ? externalPage.version : 0,
    contentHash: '',
    sourceWorkspaceId: input.sourceWorkspaceId,
    tier: 'grant',
    via: typeof externalPage.via === 'string' ? externalPage.via : external.via,
  };
  getRecallStats().recordToolRecall();
  respond(input.res, 200, {
    page,
    content:
      typeof externalPage.content === 'string'
        ? externalPage.content
        : typeof externalPage.contentHtml === 'string'
          ? externalPage.contentHtml
          : null,
    section: input.section ?? null,
  });
  return true;
}

/**
 * Serialize a structured visibility back to the cloud's owner-prefixed string.
 * This is the EXACT form cloud memory-acl.ts expects: `workspace`,
 * `agent:<imUserId>`, `private:<imUserId>`, `role:<slug>`, `council:<id>`. It
 * is what rides on the `memory.page.upsert` outbox envelope, so a role/council
 * scope round-trips up-sync to the cloud (which honors `body.visibility`).
 */
function visibilityToString(v: MemoryVisibility | undefined): string | undefined {
  if (!v) return undefined;
  switch (v.kind) {
    case 'workspace':
      return 'workspace';
    case 'agent':
    case 'private':
      return v.imUserId ? `${v.kind}:${v.imUserId}` : v.kind;
    case 'role':
      return v.slug ? `role:${v.slug}` : undefined;
    case 'council':
      return v.id ? `council:${v.id}` : undefined;
    case 'task':
      return v.id ? `task:${v.id}` : undefined;
    default: {
      const _exhaustive: never = v;
      return _exhaustive;
    }
  }
}

/**
 * Parse a caller-supplied visibility STRING (the memory_write tool passes a
 * string, not the structured union) into a {@link MemoryVisibility}. Accepts
 * `workspace`, `agent:<id>`, `private:<id>`, `role:<slug>`, `council:<id>`.
 * Conservative default (D3): absent / empty / unknown → `workspace`. An already-
 * structured object (system/CLI callers passing the union directly) passes
 * through untouched. Never throws — an unparseable value degrades to workspace.
 */
function parseVisibilityString(v: unknown): MemoryVisibility {
  if (v && typeof v === 'object' && 'kind' in v) return v as MemoryVisibility;
  if (typeof v !== 'string') return { kind: 'workspace' };
  const s = v.trim();
  if (!s || s === 'workspace') return { kind: 'workspace' };
  const colon = s.indexOf(':');
  if (colon <= 0) return { kind: 'workspace' };
  const kind = s.slice(0, colon);
  const subject = s.slice(colon + 1).trim();
  if (!subject) return { kind: 'workspace' };
  switch (kind) {
    case 'agent':
      return { kind: 'agent', imUserId: subject };
    case 'private':
      return { kind: 'private', imUserId: subject };
    case 'role':
      return { kind: 'role', slug: subject };
    case 'council':
      return { kind: 'council', id: subject };
    case 'task':
      return { kind: 'task', id: subject };
    default:
      return { kind: 'workspace' };
  }
}

// memory203/18 R6.4 — write ops. `replace` is the legacy whole-page write;
// the section ops forward to the CLOUD section verbs (the daemon subset has no
// section index — the cloud is authoritative for section splicing).
const WRITE_OPS = ['replace', 'append-section', 'rewrite-section'] as const;
type WriteOp = (typeof WRITE_OPS)[number];

/**
 * memory211/01 轴H ① — is the page ALREADY placed by a live child-of edge in the
 * local graph mirror? The placement promise ("no parentHubPath AND no existing
 * child-of edge") is about GRAPH placement, not just about the content link the
 * body happens to carry: a page whose row was pruned / re-synced under another
 * path convention still has its edge, and that edge is a placement. False on any
 * store error (the gate then stays as strict as it was before this clause).
 */
function hasChildOfGraphEdge(slot: ReturnType<MemoryRuntime['resolve']>, pagePath: string): boolean {
  try {
    const uri = memoryPathToUri(slot.store.workspaceId(), pagePath);
    const row = slot.store
      .rawDb()
      .prepare(
        `SELECT 1 FROM memory_links
         WHERE workspaceId = ? AND sourceUri = ? AND relation = 'child-of' LIMIT 1`,
      )
      .get(slot.store.workspaceId(), uri);
    return row !== undefined;
  } catch {
    return false;
  }
}

/**
 * memory203/18 R6.3 — placement-guard mode. Env-read dynamically
 * (Nacos/env late-binding). enforce (DEFAULT) rejects an un-anchored NEW leaf
 * with a structured `placement_required` error. `warn` and `off` remain
 * explicit emergency compatibility modes; neither is the production default.
 * Enforce returns a
 * `placement_required` error carrying the hub candidates.
 */
function placementEnforceMode(): 'off' | 'warn' | 'enforce' {
  const v = (process.env.PRISMER_MEMORY_PLACEMENT_ENFORCE ?? 'enforce').trim().toLowerCase();
  if (v === 'enforce') return 'enforce';
  if (v === 'off' || v === 'false' || v === '0' || v === '') return 'off';
  return 'warn';
}

interface ExplicitWriteDurability {
  canonicalCommitKey: string;
  outboxIdempotencyKey: string;
  run: MemoryWriteDurabilityRun;
}

function resolveExplicitWriteDurability(input: {
  providerSessionId: unknown;
  durabilityReceiptIndex: unknown;
  workspaceId: string;
  agentImUserId: string;
  resolveDurabilityRun: AttachMemoryRpcOptions['resolveDurabilityRun'];
}): ExplicitWriteDurability | undefined {
  const providerSessionId =
    typeof input.providerSessionId === 'string' ? input.providerSessionId.trim() : '';
  if (!providerSessionId || !input.resolveDurabilityRun) return undefined;
  const run = input.resolveDurabilityRun(providerSessionId);
  if (
    !run?.taskId ||
    run.workspaceId !== input.workspaceId ||
    run.agentImUserId !== input.agentImUserId
  ) {
    return undefined;
  }
  const receiptIndex =
    typeof input.durabilityReceiptIndex === 'number' &&
    Number.isSafeInteger(input.durabilityReceiptIndex) &&
    input.durabilityReceiptIndex >= 0 &&
    input.durabilityReceiptIndex < 32
      ? input.durabilityReceiptIndex
      : 0;
  const canonicalCommitKey = canonicalDurabilityCommitKey({
    workspaceId: input.workspaceId,
    agentImUserId: input.agentImUserId,
    canonicalTurnId: run.taskId,
  });
  return {
    canonicalCommitKey,
    outboxIdempotencyKey:
      receiptIndex === 0 ? canonicalCommitKey : `${canonicalCommitKey}/${receiptIndex}`,
    run,
  };
}

async function handleWrite(
  runtime: MemoryRuntime,
  deviceId: string,
  body: unknown,
  res: ServerResponse,
  cap: MemoryCap,
  cloud: CloudClient | undefined,
  keyManager: MemoryKeyManager | undefined,
  resolveDurabilityRun: AttachMemoryRpcOptions['resolveDurabilityRun'],
  recordExplicitMemoryReceipt: AttachMemoryRpcOptions['recordExplicitMemoryReceipt'],
  resolveAssetContentHash: AttachMemoryRpcOptions['resolveAssetContentHash'],
): Promise<boolean> {
  const input = body as Partial<MemoryWriteInput> & {
    // memory203/18 R1.1 — structural placement: OPTIONAL declaration that this
    // page hangs under an existing hub. Mirrors the auto-extract leg
    // (hook-server writeExtractedPage): the tree edge is the `memory.link.upsert`
    // GRAPH event, not the content link — cloud rebuild-index nests by
    // im_memory_links only.
    parentHubPath?: unknown;
    relation?: unknown;
    // memory203/18 R8.1 — chain trace id; caller-supplied or minted `wr_…`.
    traceId?: unknown;
    // memory203/18 R6.4 — replace | append-section | rewrite-section.
    op?: unknown;
    // Heading id (slug) the section ops target. Required for section ops.
    section?: unknown;
    // E4 (product204) — role/council-scoped write. The tool passes a STRING
    // (`workspace` | `agent:<id>` | `private:<id>` | `role:<slug>` |
    // `council:<id>`); parseVisibilityString maps it to the union below. Absent
    // → workspace (D3 conservative default).
    visibility?: unknown;
    /** Provider-owned session identity, supplied by the in-process provider. */
    providerSessionId?: unknown;
    /** Stable receipt ordering for multiple explicit writes in one turn. */
    durabilityReceiptIndex?: unknown;
  };
  // E4 — resolve the visibility scope once (string form from the tool, or an
  // already-structured union from a system/CLI caller). Threaded into store.write
  // so it persists + rehydrates + emits `role:<slug>` / `council:<id>` on the
  // outbox envelope (visibilityToString) for cloud up-sync.
  const visibility: MemoryVisibility = parseVisibilityString(input.visibility);
  // spec16 §8.1 — the acting agent is ALWAYS the VERIFIED cap subject. Body
  // actor fields are never trusted (a caller cannot attribute its write to
  // someone else — M-CAP-001); actorKind is fixed to 'agent' (this RPC is the
  // agent authoring surface; humans go through cloud memory).
  const actorImUserId = cap.sub;
  const actorKind = 'agent' as const;
  if (!input?.workspaceId || !input.path || typeof input.content !== 'string') {
    return respond400(res, 'memory.write requires workspaceId, path, and content');
  }
  if (!scopeOk(cap, input.workspaceId, res)) return true;
  // Narrowed snapshot for the write/outbox transaction closure below — TS does
  // not carry property-level narrowing (input.workspaceId) into a callback.
  const workspaceId = input.workspaceId;

  // product204/34 Track 0.1 (§2.2) — VISIBILITY cap-authz. `actorImUserId` above
  // is already pinned to cap.sub, but the requested `visibility` was taken
  // straight from the body: without this gate any agent could forge a write to
  // `role:<anySlug>` / `council:<anyId>` / `private:<someoneElse>`. Authorization
  // to WRITE a scope is the same boundary predicate as reading it (own
  // agent/private, own role or orchestrator, member council; workspace is the
  // shared default). Unauthorized → 403 (auditable), no silent downgrade, no
  // row written. The system cap bypasses via canCapReadPage's isSystemCap branch.
  if (!canCapReadPage(cap, { workspaceId: input.workspaceId, visibility })) {
    process.stdout.write(
      `[memory-trace] stage=visibility_forbidden path=${input.path} ` +
        `visibility=${visibilityToString(visibility) ?? 'workspace'} sub=${cap.sub}\n`,
    );
    respond(res, 403, {
      error: 'memory_visibility_forbidden',
      code: 'memory_visibility_forbidden',
      message: `cap not authorized to write visibility '${visibilityToString(visibility) ?? 'workspace'}'`,
    });
    return true;
  }

  const parentHubPath =
    typeof input.parentHubPath === 'string' && input.parentHubPath.trim()
      ? input.parentHubPath.trim()
      : undefined;
  // Relation whitelist: agent-declared placement is `child-of` (tree) or
  // `related` (mesh); anything else falls back to the tree default.
  const relation = input.relation === 'related' ? 'related' : 'child-of';
  // W7 item 4 — the write leg's tool-sequence duration starts here (after the
  // request has been adjudicated as a legitimate write, so a rejected write
  // never enters the behaviour ring).
  const writeStartedAt = Date.now();
  const traceId =
    typeof input.traceId === 'string' && input.traceId.trim()
      ? input.traceId.trim()
      : `wr_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  const explicitDurability = resolveExplicitWriteDurability({
    providerSessionId: input.providerSessionId,
    durabilityReceiptIndex: input.durabilityReceiptIndex,
    workspaceId,
    agentImUserId: actorImUserId,
    resolveDurabilityRun,
  });

  // memory203/18 R6.4 — op routing. Default `replace` keeps the legacy
  // whole-page shape byte-for-byte; the section ops forward to the cloud
  // section verbs (handleSectionWrite below).
  const opRaw = typeof input.op === 'string' && input.op.trim() ? input.op.trim() : 'replace';
  if (!(WRITE_OPS as readonly string[]).includes(opRaw)) {
    return respond400(res, `op must be one of: ${WRITE_OPS.join(', ')}`);
  }
  const op = opRaw as WriteOp;
  const section =
    typeof input.section === 'string' && input.section.trim() ? input.section.trim() : undefined;
  if (op !== 'replace') {
    if (!section) return respond400(res, `op=${op} requires section (the target heading id)`);
    return await handleSectionWrite(runtime, res, cloud, keyManager, cap, {
      workspaceId: input.workspaceId,
      path: input.path,
      content: input.content,
      op,
      section,
      actorImUserId,
      actorKind,
      traceId,
      providerSessionId:
        typeof input.providerSessionId === 'string' ? input.providerSessionId.trim() : '',
      explicitDurability,
      recordExplicitMemoryReceipt,
    });
  }

  // memory203/13 §0.5 — DIRECT write. memory_write is the agent authoring a PKF
  // page it ALREADY extracted in its OWN runtime (explicit "remember this" path
  // 主动, or Hermes background_review's automatic memory_write 自动). The cloud
  // does ZERO LLM for memory: the page persists locally, up-syncs via the outbox,
  // and the existing cloud materialize path anti-orphan-anchors it to INDEX (P1).
  // We do NOT re-route this through any cloud `extractMemories` lane — that
  // cloud-LLM extraction architecture is retired (see §0.5; the prior
  // routeThroughExtract here was the contaminated design being废'd).
  const slot = runtime.resolve(input.workspaceId);

  // memory203/18 R1.4 — write-time 回源 (write hygiene). When the page this
  // write targets is absent locally, or only local-only (never seen the cloud
  // head), first pull the cloud head via the SAME single-page回源 handleLoad
  // uses. The local row then lands AT the cloud version (store adopts it), so
  // this write's outbox `parentVersion` continues the cloud head instead of
  // fabricating a base-v0/v1 remote-conflict (the W1-gate's 5 cross-agent
  // full-page-rewrite conflicts). Fail-open: offline / cloud miss → proceed
  // exactly as today (local-first write never blocks on the cloud).
  let existing = slot.store.loadByAnyPath(input.path);
  if (cloud && (!existing || existing.syncStatus === 'local-only')) {
    const filled = await fetchPageFromCloudByPath(
      cloud,
      runtime,
      input.workspaceId,
      normalizeMemoryPath(input.path),
      keyManager,
    );
    if (filled) existing = slot.store.loadByAnyPath(input.path);
    else if (!existing) {
      createLogger('memory-rpc').info('write-time 回源 found no cloud page (fresh page or offline) — proceeding local-first', {
        path: input.path,
      });
    }
  }

  // memory203/18 R6.3 — placement guard (off|warn|enforce, DEFAULT enforce).
  // Fires only for a NEW un-anchored leaf: no existing page at this path, not a
  // hub declaration, no parentHubPath, and no rel="child-of" content link.
  // memory211/01 轴H ① closes the last hole in the predicate: the placement
  // promise is "no parentHubPath AND no EXISTING child-of edge", so a leaf whose
  // child-of edge already sits in the local graph mirror (the page row was
  // pruned/re-synced under another path convention while the edge survived) is
  // placed by that edge and must not be rejected. This is the skill's promised
  // `placement_required` — the error code the spec audit reported as missing
  // lived only here; W2 keeps it the single enforcing surface and documents the
  // extraction pipeline's safe-by-construction fallback (auto-promote to hub)
  // instead of a 422 a background leg could not act on.
  // Ordered LAST in the wave (after browse + parentHubPath are live) per the
  // §9.3 sequencing rule — the agent has the eyes + hands before the gate.
  const placementMode = placementEnforceMode();
  const declaresHub = input.pageType === 'hub' || (input.pageType as string) === 'index';
  const hasChildOfLink = /rel=["']child-of["']/i.test(input.content);
  const hasChildOfEdge = hasChildOfGraphEdge(slot, input.path);
  if (
    placementMode !== 'off' &&
    !existing &&
    !declaresHub &&
    !parentHubPath &&
    !hasChildOfLink &&
    !hasChildOfEdge
  ) {
    if (placementMode === 'enforce') {
      // Track 0.1c — the 422 hint's hub list is agent-facing; scope it to the
      // writing agent's reader so a non-member role/council hub can't leak here.
      const parts = assemblePlaceContext(slot, undefined, capToReader(cap));
      const hubs = parts.hubPages.slice(0, 10).map((h) => ({
        path: h.path,
        title: h.title,
        snippet: (h.snippet ?? '').slice(0, 200),
      }));
      process.stdout.write(
        `[memory-trace] stage=placement_rejected path=${input.path} traceId=${traceId}\n`,
      );
      respond(res, 422, {
        error: 'placement_required',
        code: 'placement_required',
        message:
          'New memory pages must be placed in the wiki structure, not left flat under INDEX. ' +
          'Either (a) pass parentHubPath with one of the hubs below (relation child-of), ' +
          '(b) declare this page itself as a topic hub via pageType=hub, or ' +
          '(c) call memory_browse first to see the structure and pick a placement.',
        hubs,
      });
      return true;
    }
    bumpMemoryStageCounter('placementWarn');
    process.stdout.write(
      `[memory-trace] stage=placement_warn path=${input.path} traceId=${traceId}\n`,
    );
  }

  // memory211/01 轴H — deliverable admission gate (G9 pointer + G10 REDEFINED
  // as the sharding trigger). The gate itself now lives in ONE place
  // (`deliverable-gate.ts`) because 轴H requires the automatic extraction path
  // to run the SAME gate as this RPC — the pre-W2 state was the D3 defect
  // (main extraction path unreachable by any gate).
  //
  //   G9  — the body must carry a materializable derived-from pointer to the
  //         declared asset. Missing → 422 deliverable_pointer_missing
  //         (fail-closed, no retry). UNCHANGED from product210/03 W1 (spec
  //         §0.1 keeps it explicitly).
  //   G10 — SUPERSEDED (spec §0.1 / 轴A): the old anti-copy budget
  //         (body ≤ min(32KiB, 10% × source) → 422 distill_over_budget) is
  //         GONE. copy+reference means a distilled page MAY carry the source's
  //         near-full content; the only bound left is extreme-case protection,
  //         re-thresholded by §6.9 裁决 4: 64K CHARACTERS (source → sharding
  //         pipeline; page body over the ceiling → 422 sharding_required).
  //   W1-2 idempotency — deterministic provenance token `asset:<id>#<hash>` is
  //         appended to sourceRefs; a prior page already carrying the token
  //         short-circuits as dedupe-hit (same-product replay), returning the
  //         existing path with NO second write.
  const ds = parseDeliverableSource((input as Record<string, unknown>).deliverableSource);
  const gateRejection = checkDeliverableGate(ds, input.content);
  if (ds && gateRejection) {
    bumpMemoryStageCounter(gateRejection.stage);
    process.stdout.write(
      `[memory-trace] stage=${gateRejection.code} path=${input.path} asset=${ds.assetId} traceId=${traceId}\n`,
    );
    respond(res, gateRejection.httpStatus, {
      error: gateRejection.code,
      code: gateRejection.code,
      message: gateRejection.message,
    });
    return true;
  }
  if (ds) {
    const token = deliverableProvenanceToken(ds);
    if (token) {
      const dup = slot.store
        .rawDb()
        .prepare('SELECT id, path FROM memory_pages WHERE workspaceId = ? AND sourceRefsJson LIKE ? LIMIT 1')
        .get(workspaceId, `%"${token}"%`) as { id: string; path: string } | undefined;
      if (dup) {
        bumpMemoryStageCounter('deliverableDedupeHit');
        process.stdout.write(
          `[memory-trace] stage=deliverable_dedupe_hit requested=${input.path} existing=${dup.path} traceId=${traceId}\n`,
        );
        respond(res, 200, {
          page: { id: dup.id, path: dup.path },
          dedupeHit: true,
          message:
            'This deliverable was already distilled (source asset + contentHash match). Extend the existing page instead of writing a duplicate.',
        });
        return true;
      }
      const refs = Array.isArray(input.sourceRefs) ? [...input.sourceRefs] : [];
      if (!refs.includes(token)) refs.push(token);
      (input as { sourceRefs?: string[] }).sourceRefs = refs;
    }
  }

  // memory211/01 轴H ② — frontmatter description is MANDATORY for a NEW page on
  // the authoring surface. The skill and the extraction prompt both promise the
  // one-sentence self-summary; it is what snippet/recall read (F1/F2), so a page
  // without one is a recall-blind page. PKF/HTML bodies only (markdown is the
  // legacy compatibility input and has no frontmatter to check). An interactive
  // 422 is safe here — the agent sees it and can add the line and retry; the
  // automatic extraction pipeline does NOT run this gate (a background leg
  // cannot repair, so the gate would silently drop the memory).
  const descriptionRejection = !existing ? checkDescriptionGate(input.content) : null;
  if (descriptionRejection) {
    bumpMemoryStageCounter('descriptionRequired');
    process.stdout.write(
      `[memory-trace] stage=description_required path=${input.path} traceId=${traceId}\n`,
    );
    respond(res, 422, {
      error: descriptionRejection.code,
      code: descriptionRejection.code,
      message: descriptionRejection.message,
    });
    return true;
  }

  // pkf v1.1 §4.7 — write-time bare-asset-URI upgrade. The memory skill /
  // dispatch guidance / extraction prompt teach the bare
  // `prismer://asset/<id>` pointer form (G9), but v1.1 strict validation
  // rejects it on read-back (compat-read only; validator 'bare-asset-uri') —
  // the canonical authoring form is the scoped
  // `prismer://workspace/<ws>/asset/<contentHash>`. Deterministic rewrite of
  // every bare href/src AFTER the G9 gate (which deliberately matches the bare
  // form) and BEFORE the page lands, so the store AND the outbox up-sync both
  // carry the upgraded pointers. Resolution failure degrades to the
  // workspace-scoped assetId form (still v1.1-valid) and NEVER blocks the
  // write — this is hygiene, not a gate.
  const upgrade = await upgradeBareAssetUris(input.content, workspaceId, resolveAssetContentHash);
  if (upgrade.changed) {
    input.content = upgrade.content;
    if (upgrade.canonical > 0) bumpMemoryStageCounter('bareUriUpgraded');
    if (upgrade.scopedDegrade > 0) bumpMemoryStageCounter('bareUriScopedDegrade');
    process.stdout.write(
      `[memory-trace] stage=bare_uri_upgrade path=${input.path} canonical=${upgrade.canonical} ` +
        `scopedDegrade=${upgrade.scopedDegrade} traceId=${traceId}\n`,
    );
  }

  // memory211/01 轴H ③ — the HTML/PKF projection body must pass `validatePkf`
  // before it lands. Cloud-side `normalizeWriteSource` has enforced the same
  // strict source policy since §11.2 (`invalid_pkf`); the daemon accepted
  // anything, so a body the cloud would refuse could up-sync and only fail at
  // materialization. Deliberately AFTER the bare-asset-URI upgrade above: the
  // taught `prismer://asset/<id>` form must already be rewritten into its
  // v1.1-valid scoped form, or the strict-only `bare-asset-uri` error would
  // reject exactly the pointer shape G9 mandates. Warnings never reject.
  const pkfRejection = checkPkfProjection(input.content);
  if (pkfRejection) {
    bumpMemoryStageCounter('pkfInvalid');
    process.stdout.write(
      `[memory-trace] stage=pkf_invalid path=${input.path} detail=${pkfRejection.detail} traceId=${traceId}\n`,
    );
    respond(res, 422, {
      error: pkfRejection.code,
      code: pkfRejection.code,
      detail: pkfRejection.detail,
      message: pkfRejection.message,
    });
    return true;
  }

  // product210/03 #20/#21 — structure-quality advisories (warn-level, never
  // blocking; the deterministic half of "extraction richness" and
  // "section-first" — the teaching already lives in the memory skill and the
  // extraction prompt, but agent-authored writes bypass the classifier).
  //   flatPage                — a >1KiB body with ZERO semantic <section> blocks
  //                             (markdown-flat wall; PKF richness unused).
  //   replaceOnSectionedPage  — whole-page `replace` against an EXISTING page
  //                             that already carries sections: section ops
  //                             (append-section / rewrite-section) are the
  //                             minimal unit; whole-page rewrite clobbers
  //                             concurrent authors and fights dream's
  //                             section-level convergence semantics.
  const sectionCount = (input.content.match(/<section[\s>]/gi) ?? []).length;
  if (sectionCount === 0 && Buffer.byteLength(input.content, 'utf8') > 1024) {
    bumpMemoryStageCounter('flatPage');
    process.stdout.write(
      `[memory-trace] stage=flat_page_advisory path=${input.path} traceId=${traceId}\n`,
    );
  }
  if (existing && op === 'replace') {
    // Sections are a cloud-side projection; the local subset mirrors the
    // canonical content — detect section blocks in the CURRENT stored body.
    const hasSections = (() => {
      try {
        const row = slot.store
          .rawDb()
          .prepare(
            'SELECT c.content AS content FROM memory_page_content c WHERE c.pageId = ? LIMIT 1',
          )
          .get(existing.id) as { content?: string } | undefined;
        return /<section[\s>]/i.test(row?.content ?? '');
      } catch {
        return false; // content table absent in older local schemas — advisory skipped
      }
    })();
    if (hasSections) {
      bumpMemoryStageCounter('replaceOnSectionedPage');
      process.stdout.write(
        `[memory-trace] stage=replace_on_sectioned_page path=${input.path} traceId=${traceId}\n`,
      );
    }
  }

  // Path-namespace convergence: when the page already exists under a VARIANT
  // path (`memory/x` vs `x`, ±.pkf), write to the EXISTING row's path so the
  // two conventions extend one page instead of forking a near-duplicate.
  const effectivePath = existing?.path ?? input.path;
  if (existing && effectivePath !== input.path) {
    createLogger('memory-rpc').info('write path normalized onto the existing page variant', {
      requested: input.path,
      effective: effectivePath,
    });
  }
  // spec16 §10.2 (M-OUTBOX-001) — the page aggregate and its outbox events are
  // ONE SQLite transaction, reusing the extracted-page-applicator pattern
  // (`db.transaction` wrapping store.write + outbox.enqueue; the nested
  // store.write transaction becomes a savepoint). An enqueue failure throws →
  // the whole aggregate (page/version/content/FTS/outbox) rolls back and the
  // RPC returns an error — never a success that strands the page local-only
  // (the prior best-effort enqueue committed the page first, then logged).
  const db = slot.store.rawDb();
  const writeTx = db.transaction(() => {
    const page = slot.store.write({
      ...(input as MemoryWriteInput),
      path: effectivePath,
      // `version` is an internal cloud-sync adoption channel — never taken from
      // the RPC body (a caller could otherwise inflate the version chain).
      version: undefined,
      // E4 — override the raw (possibly string) body value with the parsed union.
      visibility,
      actorImUserId,
      actorKind,
    });
    let pageOutboxId: string | null = null;
    // Up-sync: enqueue a memory.page.upsert so this agent-authored write flushes
    // to the cloud (the outbox worker pushes it; the cloud adopts the daemon page
    // id). store.write alone is local-only — WITHOUT this event the page never
    // leaves the device. The enqueue runs INSIDE the same transaction as the
    // write; a failure here aborts the write too (no local-only success fork).
    if (deviceId) {
      const pageOutbox = slot.outbox.enqueue({
        eventId: randomUUID(),
        schemaVersion: 1,
        eventType: 'memory.page.upsert',
        workspaceId,
        actorImUserId,
        actorKind,
        deviceId,
        createdAt: new Date().toISOString(),
        idempotencyKey: explicitDurability?.outboxIdempotencyKey ??
          `upsert:${workspaceId}:${page.id}:${Math.max(0, page.version - 1)}:${page.contentHash}`,
        pageId: page.id,
        path: page.path,
        parentVersion: Math.max(0, page.version - 1),
        contentHash: page.contentHash,
        payload: { kind: 'inline', content: input.content },
        ...(visibilityToString(page.visibility) ? { visibility: visibilityToString(page.visibility) } : {}),
        traceId,
      });
      if (pageOutbox.deadLetter) {
        throw new Error(`memory-rpc: page upsert envelope rejected (${pageOutbox.id})`);
      }
      pageOutboxId = pageOutbox.id;
      // memory203/18 R1.1 — declared placement → emit the page→hub edge as a
      // GRAPH event, mirroring hook-server's writeExtractedPage (idempotency key
      // included). This is what actually nests the page under its hub cloud-side;
      // the agent's content link alone never becomes a tree edge.
      if (parentHubPath) {
        // Validate locally, warn-not-reject: an absent hub still emits (the
        // cloud resolves paths on materialize / marks the edge broken — W1 has
        // no fail-closed guardrail, R6.3 gates AFTER browse+placement are live),
        // but a typo'd hub path is loudly visible in the daemon log.
        // Variant-tolerant existence check (memory/x vs x, ±.pkf) — a hub the
        // agent names in the OTHER path convention is not a "missing hub".
        if (!slot.store.loadByAnyPath(parentHubPath)) {
          createLogger('memory-rpc').warn(
            'memory.write parentHubPath not found locally (link emitted anyway; cloud resolves or marks broken)',
            { path: page.path, parentHubPath },
          );
        }
        // memory203/18 W2 P0 — normalized URI composition. The W1 shape
        // (`prismer://…/memory/${path}` with a path that ALREADY starts with
        // `memory/`) produced `…/memory/memory/…`, which the cloud silently
        // dropped (W1-gate: 3/3 agent child-of edges → 0 rows). Plain-path
        // fields ride along so the cloud lane can skip URI parsing entirely.
        const sourceUri = memoryPathToUri(workspaceId, page.path);
        const targetUri = memoryPathToUri(workspaceId, parentHubPath);
        const idem = `link-upsert:${workspaceId}:${createHash('sha256')
          .update(sourceUri + targetUri + relation)
          .digest('hex')}`;
        const linkOutbox = slot.outbox.enqueue({
          eventId: randomUUID(),
          schemaVersion: 1,
          eventType: 'memory.link.upsert',
          workspaceId,
          actorImUserId,
          actorKind,
          deviceId,
          createdAt: new Date().toISOString(),
          idempotencyKey: idem,
          sourceUri,
          targetUri,
          relation,
          sourcePath: normalizeMemoryPath(page.path),
          targetPath: normalizeMemoryPath(parentHubPath),
          extractedFromPageId: page.id,
          traceId,
        });
        if (linkOutbox.deadLetter) {
          throw new Error(`memory-rpc: link upsert envelope rejected (${linkOutbox.id})`);
        }
      }
    }
    return { page, pageOutboxId };
  });

  let written: { page: MemoryPage; pageOutboxId: string | null };
  try {
    written = writeTx();
  } catch (err) {
    // spec16 §10.2 step 5 — an enqueue failure rolls the page aggregate back
    // and the RPC MUST NOT return success (the transaction already aborted).
    const message = err instanceof Error ? err.message : String(err);
    createLogger('memory-rpc').error('write/outbox transaction failed — page aggregate rolled back', {
      path: effectivePath,
      error: message,
    });
    respond(res, 500, { error: 'memory_outbox_failed', message });
    return true;
  }
  // memory211/01 W4 轴F — lazy span mint on the cited raw chunks (mint 即升层).
  // AFTER the page aggregate committed (the mint is a derived projection: it
  // must never roll a write back, and it must never be rolled back WITH a write
  // that later fails). Its own outbox events ride the same transaction-free
  // channel and are idempotent, so a crash between the two is harmless.
  promoteReferencedAssetSpans({
    store: slot.store,
    outbox: slot.outbox,
    content: input.content,
    deviceId,
    traceId,
  });
  stageExplicitReceipt(recordExplicitMemoryReceipt, {
    providerSessionId: typeof input.providerSessionId === 'string' ? input.providerSessionId.trim() : '',
    workspaceId,
    agentImUserId: actorImUserId,
    explicitDurability,
    receipt: {
      pageId: written.page.id,
      path: written.page.path,
      version: written.page.version,
      contentHash: written.page.contentHash,
      authority: 'outbox',
      ...(written.pageOutboxId ? { authorityEventId: written.pageOutboxId } : {}),
    },
  });
  // W7 item 4 (D11-4) — the write leg joins the tool sequence (a turn that ends
  // in a memory_write is often the TAIL of a browse→load→write loop; without
  // this row the ring cannot show that the write followed a read).
  recordToolSequence(workspaceId, {
    verb: 'write',
    path: written.page.path,
    durationMs: Date.now() - writeStartedAt,
    at: new Date(writeStartedAt).toISOString(),
  });
  respond(res, 200, {
    page: written.page,
    // spec16 §10.2 step 4 — success carries BOTH the local version and the
    // outbox event id (null when deviceId is absent: unit-test wiring, not an
    // agent-authored RPC — the runner always stamps the daemon id).
    localVersion: written.page.version,
    outboxEventId: written.pageOutboxId,
    authority: 'outbox',
    // Additive: echo the declared placement so the calling tool can confirm
    // the edge was queued (absent for a plain write — legacy shape unchanged).
    ...(parentHubPath ? { link: { targetPath: parentHubPath, relation } } : {}),
  });
  return true;
}

/**
 * memory203/18 R6.4 — section-level write (`op=append-section|rewrite-section`).
 *
 * The daemon subset has NO section index; the cloud owns section splicing
 * (memory-write.service appendSection/rewriteSection: version DAG bump, section
 * index rebuild, HTML side-car, invalidate fan-out). So this handler FORWARDS
 * to the cloud section verbs — same cloud-call pattern as handleCurate,
 * including the `X-Prismer-Memory-Actor` override — then refreshes the LOCAL
 * subset copy from the cloud response.
 *
 * IMPORTANT: NO `memory.page.upsert` outbox event is emitted for a section
 * write. The cloud write is already authoritative (it bumped the version DAG
 * itself); an outbox upsert on top would DOUBLE-APPLY the edit (or LWW-race
 * the very version the cloud just minted). The local refresh below is a pure
 * subset-mirror write (store.write + syncStatus 'acked'), never an up-sync.
 *
 * Offline (`cloud` absent) → explicit 503 `section_write_requires_cloud` (NOT
 * a silent no-op: the agent can fall back to op=replace, which is local-first).
 */
async function handleSectionWrite(
  runtime: MemoryRuntime,
  res: ServerResponse,
  cloud: CloudClient | undefined,
  keyManager: MemoryKeyManager | undefined,
  cap: MemoryCap,
  args: {
    workspaceId: string;
    path: string;
    content: string;
    op: 'append-section' | 'rewrite-section';
    section: string;
    actorImUserId: string;
    actorKind: 'human' | 'agent';
    traceId: string;
    providerSessionId: string;
    explicitDurability?: ExplicitWriteDurability;
    recordExplicitMemoryReceipt: AttachMemoryRpcOptions['recordExplicitMemoryReceipt'];
  },
): Promise<boolean> {
  const {
    workspaceId,
    path: pagePath,
    content,
    op,
    section,
    actorImUserId,
    actorKind,
    traceId,
    providerSessionId,
    explicitDurability,
    recordExplicitMemoryReceipt,
  } = args;
  const log = createLogger('memory-rpc');
  const slot = runtime.resolve(workspaceId);
  const sectionWriteStartedAt = Date.now();

  if (!cloud) {
    respond(res, 503, {
      error: 'section_write_requires_cloud',
      message:
        'Section-level writes are applied by the cloud (authoritative section index); the cloud is not reachable. ' +
        'Retry later, or use op=replace for a local-first whole-page write.',
      op,
    });
    return true;
  }

  // Resolve the target page: local (variant-tolerant), else 回源 the cloud head.
  let page = slot.store.loadByAnyPath(pagePath);
  if (!page) {
    const filled = await fetchPageFromCloudByPath(
      cloud,
      runtime,
      workspaceId,
      normalizeMemoryPath(pagePath),
      keyManager,
    );
    if (filled) page = slot.store.loadByAnyPath(pagePath);
  }
  if (!page) {
    respond(res, 404, {
      error: 'memory_page_not_found',
      message: `op=${op} targets an existing page; no page found at '${pagePath}' (locally or in the cloud). Use op=replace to create a new page.`,
      workspaceId,
      path: pagePath,
    });
    return true;
  }

  // Forward to the cloud section verb (actor override — same rationale as
  // handleCurate: the daemon authenticates as the owner; the cloud must
  // evaluate the ACL as the ACTING agent).
  const verb = op === 'append-section' ? 'append' : 'rewrite';
  const actorHeader = !isSystemCap(cap) ? { 'X-Prismer-Memory-Actor': cap.sub } : undefined;
  const resp = await cloud.request<{ ok?: boolean; data?: unknown }>(
    'POST',
    `/api/im/memory/pages/${encodeURIComponent(page.id)}/sections/${verb}`,
    {
      body: { workspaceId, section, content },
      timeoutMs: 30_000,
      ...(actorHeader ? { headers: actorHeader } : {}),
    },
  );
  if (!resp.ok) {
    // Cloud verdict passthrough (404 section_not_found / 403 ACL / 422 …).
    respond(res, resp.status || 502, {
      ok: false,
      op,
      section,
      error: resp.error?.code ?? 'cloud_request_failed',
      message: resp.error?.message ?? `cloud returned HTTP ${resp.status}`,
    });
    return true;
  }
  const cloudData =
    resp.data && typeof resp.data === 'object' && 'data' in resp.data ? resp.data.data : resp.data;

  // Refresh the local subset copy so the next local read sees the spliced page.
  // Preferred: the cloud response carries the full updated page (content +
  // version) — mirror it directly, adopting the cloud version. Fallbacks: a
  // fresh single-page回源; else a local splice via section.ts (best-effort —
  // the cloud stays authoritative and the ws-invalidate fan-out heals a stale
  // local copy on the next load either way).
  try {
    const updated = cloudData as { content?: unknown; version?: unknown } | null;
    if (updated && typeof updated.content === 'string') {
      slot.store.write({
        workspaceId,
        id: page.id,
        path: page.path,
        content: updated.content,
        title: page.title ?? undefined,
        pageType: page.pageType,
        visibility: page.visibility,
        ...(typeof updated.version === 'number' && updated.version > 0
          ? { version: updated.version }
          : {}),
        actorImUserId,
        actorKind,
      });
      slot.store.setSyncStatus(page.id, 'acked');
    } else if (
      !(await fetchPageFromCloudByPath(cloud, runtime, workspaceId, normalizeMemoryPath(page.path), keyManager))
    ) {
      // Last resort: splice locally. append = concat; rewrite = sliceSection
      // replace (markdown ATX pages only — a PKF page that doesn't slice is
      // left for the invalidate-refresh path).
      const local = slot.store.loadContent(page.id)?.content;
      if (typeof local === 'string') {
        let next: string | null = null;
        if (op === 'append-section') {
          next = `${local.replace(/\s+$/, '')}\n\n${content.trim()}\n`;
        } else {
          const slice = sliceSection(local, section);
          if (slice !== null) next = local.replace(slice, content.replace(/\s+$/, ''));
        }
        if (next !== null) {
          slot.store.write({
            workspaceId,
            id: page.id,
            path: page.path,
            content: next,
            title: page.title ?? undefined,
            pageType: page.pageType,
            visibility: page.visibility,
            actorImUserId,
            actorKind,
          });
        }
      }
    }
  } catch (err) {
    log.warn('section-write local refresh failed (cloud applied; local heals on invalidate)', {
      path: page.path,
      error: (err as Error).message,
    });
  }

  process.stdout.write(
    `[memory-trace] stage=section_write(op=${op}) path=${page.path} traceId=${traceId}\n`,
  );
  const refreshed = slot.store.loadByAnyPath(page.path) ?? page;
  stageExplicitReceipt(recordExplicitMemoryReceipt, {
    providerSessionId,
    workspaceId,
    agentImUserId: actorImUserId,
    explicitDurability,
    receipt: {
      pageId: refreshed.id,
      path: refreshed.path,
      version: refreshed.version,
      contentHash: refreshed.contentHash,
      authority: 'cloud',
    },
  });
  // W7 item 4 — a section write is a `write` in the tool sequence too (same
  // verb, different op): the browse→load→write tail must not lose section-level
  // writes just because they ride the cloud-authoritative op path.
  recordToolSequence(workspaceId, {
    verb: 'write',
    path: refreshed.path,
    durationMs: Date.now() - sectionWriteStartedAt,
    at: new Date(sectionWriteStartedAt).toISOString(),
  });
  respond(res, 200, { page: refreshed, op, section, authority: 'cloud' });
  return true;
}

function stageExplicitReceipt(
  record: AttachMemoryRpcOptions['recordExplicitMemoryReceipt'],
  input: {
    providerSessionId: string;
    workspaceId: string;
    agentImUserId: string;
    explicitDurability?: ExplicitWriteDurability;
    receipt: PostTurnPageReceipt;
  },
): void {
  if (!record || !input.providerSessionId || !input.explicitDurability?.run.taskId) return;
  try {
    record({
      providerSessionId: input.providerSessionId,
      workspaceId: input.workspaceId,
      agentImUserId: input.agentImUserId,
      canonicalTurnId: input.explicitDurability.run.taskId,
      receipt: input.receipt,
    });
  } catch (error) {
    createLogger('memory-rpc').error('explicit durability receipt staging failed', {
      path: input.receipt.path,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function handleFlush(
  runtime: MemoryRuntime,
  body: unknown,
  res: ServerResponse,
  cap: MemoryCap,
): boolean {
  const { workspaceId } = (body ?? {}) as { workspaceId?: string };
  if (!workspaceId) return respond400(res, 'workspaceId required');
  if (!scopeOk(cap, workspaceId, res)) return true;
  const slot = runtime.resolve(workspaceId);
  // Phase-0 stub: returns queue depth + flushed=0 (no worker uploads yet).
  respond(res, 200, slot.outbox.flush());
  return true;
}

function handleInvalidate(
  runtime: MemoryRuntime,
  body: unknown,
  res: ServerResponse,
  cap: MemoryCap,
): boolean {
  const { workspaceId, pageIds, reason } = (body ?? {}) as {
    workspaceId?: string;
    pageIds?: unknown;
    reason?: string;
  };
  if (!workspaceId) return respond400(res, 'workspaceId required');
  if (!scopeOk(cap, workspaceId, res)) return true;
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
  cap: MemoryCap,
): boolean {
  if (typeof body !== 'object' || body === null) {
    return respond400(res, 'request body must be a JSON object');
  }
  const workspaceId = (body as { workspaceId?: unknown }).workspaceId;
  if (typeof workspaceId !== 'string' || !workspaceId) {
    return respond400(res, 'workspaceId is required (string)');
  }
  if (!scopeOk(cap, workspaceId, res)) return true;
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

// ─── Provider-facing handlers (doc 18 §4c) ─────────────────────────────────
//
// The remaining provider-facing handler is `handleMirror` (built-in MEMORY.md
// 收编), which writes the mirrored content into the workspace-shared bucket. The
// out-of-process provider shell only knows `workspaceId` (no profile /
// agentImUserId), so mirrored writes land workspace-shared.

const PROVIDER_LOG = '[memory-rpc:provider]';

// memory203/13 §0.5 — the `handleExtractTurn` / `handleExtractCompress` handlers
// (and their `runExtract` / `runExtractInBackground` helpers) USED to forward
// turns to the cloud `/api/im/memory/extract` LLM. That cloud-extraction
// architecture is RETIRED: extraction runs in the agent's OWN runtime
// (automatic = Hermes background_review → memory_write; explicit = the agent's
// memory skill → cloud memory write). The cloud does ZERO LLM for memory. The
// routes above now short-circuit to an inert no-op, so those handlers and the
// daemon-side extract pipeline (extract.ts) are no longer wired here.

/**
 * POST /local/memory/mirror
 * Body: { workspaceId, action, target, content, metadata? }
 * Mirrors an agent's built-in MEMORY.md edit into the local workspace-shared
 * substrate. `add` / `replace` write the content at `target`; `remove` is a
 * fail-soft log (no destructive delete plumbing is exposed out-of-band — the
 * cloud/agent built-in store remains the authority). Never needs `cloud`.
 */
function handleMirror(
  runtime: MemoryRuntime,
  deviceId: string,
  body: unknown,
  res: ServerResponse,
  cap: MemoryCap,
): boolean {
  const b = (body ?? {}) as {
    workspaceId?: unknown;
    action?: unknown;
    target?: unknown;
    content?: unknown;
  };
  if (typeof b.workspaceId !== 'string' || !b.workspaceId) {
    return respond400(res, 'workspaceId is required');
  }
  if (!scopeOk(cap, b.workspaceId, res)) return true;
  const action = typeof b.action === 'string' ? b.action : '';
  const target = typeof b.target === 'string' ? b.target : '';
  const content = typeof b.content === 'string' ? b.content : '';
  if (action === 'remove' || !target || !content) {
    // Non-write actions (or missing fields) degrade to an acknowledged no-op.
    respond(res, 200, { ok: true, mirrored: false, action });
    return true;
  }
  const scopedRoot = deriveScopedRoot(runtime.resolve(b.workspaceId).store.stats().dbPath);
  if (!scopedRoot) {
    respond(res, 200, { ok: true, mirrored: false, reason: 'no_scoped_root' });
    return true;
  }
  const scoped = new ScopedMemoryStore({ rootDir: scopedRoot, workspaceId: b.workspaceId, deviceId });
  try {
    scoped.write({
      scope: 'workspace-shared',
      path: target,
      content,
      title: target,
      description: `mirrored agent memory ${action}`,
      pageType: 'leaf',
      actorImUserId: cap.sub,
      actorKind: 'agent',
    });
    respond(res, 200, { ok: true, mirrored: true, action });
  } catch (err) {
    process.stderr.write(`${PROVIDER_LOG} mirror write failed path=${target}: ${(err as Error).message}\n`);
    respond(res, 200, { ok: true, mirrored: false, reason: 'write_failed' });
  } finally {
    scoped.close();
  }
  return true;
}

/**
 * POST /local/memory/curate
 * Body: { workspaceId, op: 'promote_to_hub'|'supersede'|'rebuild_index', pageId?, reason?,
 *         childPaths? (promote_to_hub only — memory203/18 R1.3) }
 *
 * Curation is a CLOUD-superset governance op (memory203/04 §3, MVP4 phase-1):
 * the verbs operate on the cloud-authoritative page graph (leaf→hub promotion,
 * archive+stale supersede, INDEX TOC rebuild), so this handler is a thin
 * FORWARD to the matching cloud endpoint — NOT a local-store mutation like
 * search/load. The forward path per op:
 *   - promote_to_hub → POST /api/im/memory/pages/:id/promote-to-hub (orch-only)
 *   - supersede      → POST /api/im/memory/pages/:id/supersede      (orch-only)
 *   - rebuild_index  → POST /api/im/memory/index/rebuild           (orch-only)
 *
 * memory203/13 §0.5 — `run_dream` is REMOVED from curate. Dream is NOT a cloud
 * LLM trigger advertised to every agent: it is the ORCHESTRATOR's
 * memory-dream skill calling the write VERBS (promote/supersede/rebuild). The
 * prior `run_dream → POST /api/im/memory/page-dream` forward fired a cloud LLM
 * from any agent — that violates "all memory LLM runs in the agent's own
 * runtime", so the op (and its cloud forward) is gone. The three remaining ops
 * map to write verbs (no cloud LLM).
 *
 * The cloud (memory-acl.ts isOrchestratorActor) returns 403 for non-orchestrator
 * actors on the three governance ops; this handler passes that 403 through
 * verbatim (status + body) so a non-orchestrator agent gets a clean
 * "you are not the orchestrator" rather than a crash. The daemon's only gate
 * here is the ws cap (scopeOk below) — it does NOT re-gate the orchestrator
 * check (single source of truth = cloud).
 *
 * `cloud` absent (offline / unit test) → 200 degraded no-op, mirroring the
 * extract routes' "降级不中断" contract (doc 18 §4c).
 */
const CURATE_OPS = ['promote_to_hub', 'supersede', 'rebuild_index', 'section_merge', 'section_supersede', 'rewire'] as const;
type CurateOp = (typeof CURATE_OPS)[number];

/**
 * GET /local/memory/health?workspaceId=&kind=&limit=  (memory203/13 §P4)
 *
 * The Dream CONVERGENCE *READ* half. The curate WRITE verbs (promote/supersede/
 * rebuild) had no companion that lets the orchestrator READ what to converge —
 * so the agent had the hands but no eyes. This forwards to the cloud
 * `GET /api/im/memory/health/{kind}` candidate surfaces (orphan leaves,
 * near-duplicate clusters, stale garbage) so the orchestrator's OWN LLM can
 * cluster + decide before enacting. The cloud does ZERO LLM here — it only
 * scans the page graph and returns `{ items, total }`. Same passthrough shape
 * as handleCurate (ws cap gate daemon-side; ACL gate cloud-side).
 *
 * `kind` (default `all`) selects which surface(s):
 *   orphans    → GET /api/im/memory/health/orphans
 *   duplicates → GET /api/im/memory/health/duplicates  (near-dup clusters)
 *   stale      → GET /api/im/memory/health/stale       (garbage candidates)
 *   conflicts  → GET /api/im/memory/health/conflicts   (live remote-conflict
 *                pages + latestTwoVersionSummaries — memory203/18 §11.4 #3
 *                semantic review loop; a curation touch or clean rewrite
 *                clears the state)
 *   oversized  → GET /api/im/memory/health/oversized   (hub/INDEX size ADVISORY
 *                — memory203/20 §1.2 record-not-limit: measured + suggested
 *                for orchestrator split, never machine-enforced)
 *   all        → fetch every kind, return { orphans, duplicates, stale, conflicts, oversized }
 *
 * `cloud` absent (offline / unit test) → 200 degraded empty, honouring the same
 * "降级不中断" contract as handleCurate.
 */
const HEALTH_KINDS = ['orphans', 'duplicates', 'stale', 'conflicts', 'oversized'] as const;
type HealthKind = (typeof HEALTH_KINDS)[number];

async function handleHealth(
  cloud: CloudClient | undefined,
  query: Record<string, string>,
  res: ServerResponse,
  cap: MemoryCap,
): Promise<boolean> {
  const workspaceId = effectiveWs(cap, query.workspaceId);
  if (!workspaceId) return respond400(res, 'workspaceId query param required');
  if (!scopeOk(cap, workspaceId, res)) return true;

  const kindRaw = (query.kind ?? 'all').toLowerCase();
  const kinds: HealthKind[] =
    kindRaw === 'all'
      ? [...HEALTH_KINDS]
      : (HEALTH_KINDS as readonly string[]).includes(kindRaw)
        ? [kindRaw as HealthKind]
        : [];
  if (kinds.length === 0) {
    return respond400(res, `kind must be one of: all, ${HEALTH_KINDS.join(', ')}`);
  }
  const limit = query.limit && Number.isFinite(Number(query.limit)) ? Number(query.limit) : undefined;

  if (!cloud) {
    // Health candidates live cloud-side (full page graph); offline → degrade.
    respond(res, 200, {
      ok: true,
      degraded: true,
      reason: 'cloud_not_wired',
      candidates: Object.fromEntries(kinds.map((k) => [k, { items: [], total: 0 }])),
    });
    return true;
  }

  const params = new URLSearchParams({ workspaceId });
  if (limit !== undefined) params.set('limit', String(limit));
  // Forward the verified acting agent (same rationale as handleCurate): the
  // daemon authenticates with one owner api_key, so without the actor override
  // the cloud would resolve the owner's ACL. These are read-only health scans
  // (not orchestrator-gated), but forwarding the actor keeps the workspace ACL
  // projection correct (the agent only sees pages it can read).
  const actorHeader = !isSystemCap(cap) ? { 'X-Prismer-Memory-Actor': cap.sub } : undefined;

  const candidates: Record<string, unknown> = {};
  for (const kind of kinds) {
    const resp = await cloud.request<{ ok?: boolean; data?: unknown }>(
      'GET',
      `/api/im/memory/health/${kind}?${params.toString()}`,
      { timeoutMs: 20_000, ...(actorHeader ? { headers: actorHeader } : {}) },
    );
    if (!resp.ok) {
      respond(res, resp.status || 502, {
        ok: false,
        kind,
        error: resp.error?.code ?? 'cloud_request_failed',
        message: resp.error?.message ?? `cloud returned HTTP ${resp.status}`,
      });
      return true;
    }
    // Cloud wraps results as `{ ok, data }`; unwrap to the inner `{ items, total }`.
    candidates[kind] =
      resp.data && typeof resp.data === 'object' && 'data' in resp.data ? resp.data.data : resp.data;
  }
  respond(res, 200, { ok: true, candidates });
  return true;
}

/**
 * POST /local/memory/delete  (memory211/01 W5 轴 H — CLI 路由对齐)
 *
 * `{ workspaceId, pageId }` → cloud `DELETE /api/im/memory/pages/:id`. Deletion
 * authority is adjudicated CLOUD-side (soft delete + ACL); the daemon applies
 * only the ws cap gate and passes the cloud status/body through verbatim, with
 * the same actor-forwarding rule the curate verbs use so cloud resolves the
 * ACTING agent's authority rather than the daemon's owner key.
 *
 * On a cloud success the LOCAL mirror is invalidated (the same
 * `slot.store.invalidate` the cloud-force-refresh path uses), so the next local
 * search/load does not resurrect a page cloud already deleted. Offline (no
 * cloud) the local invalidation still runs — the delete degrades to a local
 * removal and reports `degraded` rather than lying about cloud authority.
 */
async function handleDelete(
  cloud: CloudClient | undefined,
  runtime: MemoryRuntime,
  body: unknown,
  res: ServerResponse,
  cap: MemoryCap,
): Promise<boolean> {
  const b = (body ?? {}) as { workspaceId?: unknown; pageId?: unknown };
  if (typeof b.workspaceId !== 'string' || !b.workspaceId) {
    return respond400(res, 'workspaceId is required');
  }
  if (typeof b.pageId !== 'string' || !b.pageId) {
    return respond400(res, 'pageId is required');
  }
  if (!scopeOk(cap, b.workspaceId, res)) return true;

  if (cloud) {
    const actorHeader = !isSystemCap(cap) ? { 'X-Prismer-Memory-Actor': cap.sub } : undefined;
    const resp = await cloud.request<{ ok?: boolean; data?: unknown }>(
      'DELETE',
      `/api/im/memory/pages/${encodeURIComponent(b.pageId)}?workspaceId=${encodeURIComponent(b.workspaceId)}`,
      { timeoutMs: 30_000, ...(actorHeader ? { headers: actorHeader } : {}) },
    );
    if (!resp.ok) {
      respond(res, resp.status || 502, {
        ok: false,
        error: resp.error?.code ?? 'cloud_request_failed',
        message: resp.error?.message ?? `cloud returned HTTP ${resp.status}`,
      });
      return true;
    }
    runtime.resolve(b.workspaceId).store.invalidate([b.pageId], 'deleted');
    const cloudData = resp.data && typeof resp.data === 'object' && 'data' in resp.data ? resp.data.data : resp.data;
    respond(res, 200, { ok: true, data: cloudData });
    return true;
  }

  // Offline degrade — honest about what happened: local mirror invalidated,
  // cloud deletion deferred until the daemon is online again.
  runtime.resolve(b.workspaceId).store.invalidate([b.pageId], 'deleted_offline');
  respond(res, 200, { ok: true, degraded: true, reason: 'cloud_not_wired', pageId: b.pageId });
  return true;
}

async function handleCurate(
  cloud: CloudClient | undefined,
  body: unknown,
  res: ServerResponse,
  cap: MemoryCap,
): Promise<boolean> {
  const b = (body ?? {}) as {
    workspaceId?: unknown;
    op?: unknown;
    pageId?: unknown;
    reason?: unknown;
    // memory203/18 R1.3 — promote_to_hub only: existing page paths to attach
    // under the promoted hub as child-of, in the same cloud transaction.
    // Pass-through: the cloud lane consumes it (emitting now is forward-
    // compatible; an older cloud simply ignores the extra field).
    childPaths?: unknown;
    // memory211/01 W5 轴 G — section-level curation verbs. Same pass-through
    // posture: the daemon validates shape only, the cloud owns authority.
    section?: unknown;
    targetSection?: unknown;
    sourcePageId?: unknown;
    sourceSection?: unknown;
    mergedContent?: unknown;
    supersededByPageId?: unknown;
    supersededBySection?: unknown;
    linkId?: unknown;
    toPageId?: unknown;
    toPath?: unknown;
    toSection?: unknown;
  };
  if (typeof b.workspaceId !== 'string' || !b.workspaceId) {
    return respond400(res, 'workspaceId is required');
  }
  const op = typeof b.op === 'string' ? (b.op as CurateOp) : undefined;
  if (!op || !(CURATE_OPS as readonly string[]).includes(op)) {
    return respond400(res, `op must be one of: ${CURATE_OPS.join(', ')}`);
  }
  if ((op === 'promote_to_hub' || op === 'supersede') && (typeof b.pageId !== 'string' || !b.pageId)) {
    return respond400(res, `op=${op} requires pageId`);
  }
  // W5 轴 G — shape checks for the section verbs (the cloud re-authorizes).
  if (op === 'section_merge' && (!b.targetSection || !b.sourcePageId || !b.sourceSection || !b.mergedContent)) {
    return respond400(res, 'op=section_merge requires targetSection, sourcePageId, sourceSection, mergedContent');
  }
  if (op === 'section_supersede' && !b.section) {
    return respond400(res, 'op=section_supersede requires section');
  }
  if (op === 'rewire' && (!b.linkId || (!b.toPageId && !b.toPath))) {
    return respond400(res, 'op=rewire requires linkId and (toPageId | toPath)');
  }
  // ws cap gate — the ONLY gate the daemon applies; the orchestrator gate is
  // the cloud's job (passed through below).
  if (!scopeOk(cap, b.workspaceId, res)) return true;

  if (!cloud) {
    // Curation verbs live cloud-side; offline → honour the degrade contract.
    respond(res, 200, { ok: true, degraded: true, reason: 'cloud_not_wired', op });
    return true;
  }

  const workspaceId = b.workspaceId;
  const pageId = typeof b.pageId === 'string' ? b.pageId : undefined;
  const reason = typeof b.reason === 'string' ? b.reason : undefined;
  const childPaths = Array.isArray(b.childPaths)
    ? b.childPaths.filter((p): p is string => typeof p === 'string' && p.length > 0)
    : undefined;

  // Resolve the cloud endpoint + body for the requested op. All three are POST.
  // (run_dream removed — memory203/13 §0.5: no cloud-LLM Dream trigger.)
  let path: string;
  let cloudBody: Record<string, unknown>;
  switch (op) {
    case 'promote_to_hub':
      path = `/api/im/memory/pages/${encodeURIComponent(pageId!)}/promote-to-hub`;
      cloudBody = {
        workspaceId,
        // R1.3 — 挂子: forwarded verbatim; cloud builds the child-of edges.
        ...(childPaths && childPaths.length > 0 ? { childPaths } : {}),
      };
      break;
    case 'supersede':
      path = `/api/im/memory/pages/${encodeURIComponent(pageId!)}/supersede`;
      cloudBody = { workspaceId, ...(reason ? { reason } : {}) };
      break;
    case 'rebuild_index':
      path = '/api/im/memory/index/rebuild';
      cloudBody = { workspaceId };
      break;
    // memory211/01 W5 轴 G — section-level verbs. The merge path lands the
    // `supersedes`/`derived-from` provenance edges cloud-side; the daemon only
    // forwards, exactly like promote_to_hub.
    case 'section_merge':
      path = `/api/im/memory/pages/${encodeURIComponent(pageId!)}/sections/merge`;
      cloudBody = {
        workspaceId,
        targetSection: b.targetSection,
        sourcePageId: b.sourcePageId,
        sourceSection: b.sourceSection,
        mergedContent: b.mergedContent,
        ...(reason ? { reason } : {}),
      };
      break;
    case 'section_supersede':
      path = `/api/im/memory/pages/${encodeURIComponent(pageId!)}/sections/supersede`;
      cloudBody = {
        workspaceId,
        section: b.section,
        ...(b.supersededByPageId ? { supersededByPageId: b.supersededByPageId } : {}),
        ...(b.supersededBySection ? { supersededBySection: b.supersededBySection } : {}),
        ...(reason ? { reason } : {}),
      };
      break;
    case 'rewire':
      path = '/api/im/memory/links/rewire';
      cloudBody = {
        workspaceId,
        linkId: b.linkId,
        ...(b.toPageId ? { toPageId: b.toPageId } : {}),
        ...(b.toPath ? { toPath: b.toPath } : {}),
        ...(b.toSection ? { toSection: b.toSection } : {}),
      };
      break;
  }

  // Orchestrator-gate correctness: the daemon authenticates to cloud with ONE
  // owner-resolved api_key (runner.ts), shared across every agent it hosts. If
  // we forwarded with no actor identity, cloud would see callerKind='user'
  // (owner) and isOrchestratorActor would return true unconditionally — the
  // "整理=编排专属" gate would be bypassed for ANY agent. So we forward the
  // VERIFIED acting-agent identity (cap.sub) in `X-Prismer-Memory-Actor`; cloud
  // honours it ONLY from a human/owner principal and re-resolves the ACL as that
  // agent (callerKind='agent'), so the gate evaluates the agent's authority.
  // System-cap (daemon-internal) and absent caps forward no override.
  const actorHeader = !isSystemCap(cap) ? { 'X-Prismer-Memory-Actor': cap.sub } : undefined;
  const resp = await cloud.request<{ ok?: boolean; data?: unknown }>('POST', path, {
    body: cloudBody,
    timeoutMs: 30_000,
    ...(actorHeader ? { headers: actorHeader } : {}),
  });
  // Pass the cloud status + body through. A cloud 403 (orchestrator_only)
  // reaches the agent as a clean 403 with the cloud's error code — NOT a daemon
  // crash or a swallowed success. The daemon does NOT re-gate; the cloud's
  // verdict is authoritative.
  if (!resp.ok) {
    respond(res, resp.status || 502, {
      ok: false,
      op,
      error: resp.error?.code ?? 'cloud_request_failed',
      message: resp.error?.message ?? `cloud returned HTTP ${resp.status}`,
    });
    return true;
  }
  // The cloud wraps results as `{ ok, data }`; unwrap to the inner `data` so the
  // agent sees the actual curation result (Dream candidates / updated page /
  // rebuild summary) rather than a doubly-nested envelope.
  const cloudData = resp.data && typeof resp.data === 'object' && 'data' in resp.data ? resp.data.data : resp.data;
  respond(res, 200, { ok: true, op, data: cloudData });
  return true;
}

/**
 * MemoryRuntime stores per-workspace memory at `<baseDir>/<slug>/memory.db`;
 * ScopedMemoryStore shares the same `<baseDir>`. Strip the trailing
 * `<slug>/memory.db` to recover the shared root. Mirrors the helper in
 * hook-server.ts.
 */
function deriveScopedRoot(memoryDbPath: string | null): string | null {
  if (!memoryDbPath || memoryDbPath === ':memory:') return null;
  const m = memoryDbPath.match(/^(.+)\/[^/]+\/memory\.db$/);
  return m ? m[1]! : null;
}

// ---- recall_pull emission (M-RECALL-EMIT) ----------------------------------
//
// A tool-driven memory_search / memory_load is an agent self-recall. We log it
// to the outbox as a `recall_pull` observability event so the cloud-side M1
// adoption metric ("did a real agent turn actively pull memory?") has data.
//
// Strictly best-effort: the search/load result has ALREADY been computed and
// is about to be returned. Any failure here (missing actor identity, schema
// reject, SQLite error) must NOT change the response — observability is a
// side-channel, never on the critical path. We therefore:
//   - skip emission entirely when no actor identity was forwarded (the client
//     omits it for anonymous callers; we never fabricate an actor — that would
//     pollute the adoption dataset);
//   - wrap enqueue() in try/catch so a dead-letter / throw never bubbles.

interface RecallPullInput {
  workspaceId: string;
  actorImUserId?: string;
  actorKind?: string;
  query: string;
  tool: 'memory_search' | 'memory_load';
  topK: number | null;
  hitCount: number;
  pageId?: string;
}

function emitRecallPull(
  outbox: { enqueue(event: unknown): unknown },
  deviceId: string,
  input: RecallPullInput,
): void {
  // No actor identity → skip (don't fabricate; would pollute M1 adoption).
  if (!input.actorImUserId) return;
  try {
    const eventId = randomUUID();
    const createdAt = new Date().toISOString();
    const actorKind = input.actorKind === 'human' ? 'human' : 'agent';
    outbox.enqueue({
      eventId,
      schemaVersion: 1,
      eventType: 'recall_pull',
      workspaceId: input.workspaceId,
      actorImUserId: input.actorImUserId,
      actorKind,
      deviceId,
      createdAt,
      idempotencyKey: `obs:recall_pull:${input.actorImUserId}:${createdAt}:${eventId.slice(0, 8)}`,
      ...(input.pageId ? { pageId: input.pageId } : {}),
      query: input.query,
      metadataJson: { tool: input.tool },
      metricsJson: {
        hitCount: input.hitCount,
        ...(input.topK !== null ? { topK: input.topK } : {}),
      },
    });
  } catch (err) {
    // 旁路：永不阻断 recall。仅记一行 stderr 供排障。
    process.stderr.write(
      `[memory-rpc:recall_pull] emit failed (non-blocking): ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

// ---- cap gate helpers (spec16 §8.1 MA-0S) ----------------------------------

/**
 * First 8 hex chars of sha256(presented-cap-token). Deny logs carry ONLY this
 * prefix (never the full cap / signature) plus the reasonCode — enough to
 * correlate a rejected token with the minted one in the daemon log.
 */
function capHashPrefix(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 8);
}

/**
 * Authoritative workspaceId for a request: when a scoped (non-system) agent cap
 * is present and the caller omitted the id, default to cap.ws. An explicit
 * value is returned as-is so the scope gate (`scopeOk`) can reject a mismatch.
 */
function effectiveWs(cap: MemoryCap, requested: string | undefined): string | undefined {
  if (requested) return requested;
  if (!capAllowsWorkspace(cap, '*')) return cap.ws;
  return undefined;
}

/**
 * Per-handler scope gate (spec16 §13.4). The cap must authorize `workspaceId`
 * (exact ws or system wildcard). A mismatch is a CAP-LAYER workspace mismatch
 * — the request's workspaceId disagrees with the verified cap's own ws claim —
 * so it denies with 401 `memory_cap_invalid`, NOT a generic scope 403. This is
 * the daemon's single workspace-scope rejection path (there is no separate
 * non-cap scope guard). The 403s that remain on the RPC surface are the
 * visibility authz gate (`memory_visibility_forbidden`, F5) and cloud ACL
 * passthroughs (e.g. orchestrator_only) — neither is a workspace mismatch.
 */
function scopeOk(cap: MemoryCap, workspaceId: string, res: ServerResponse): boolean {
  if (!capAllowsWorkspace(cap, workspaceId)) {
    process.stderr.write(
      `[memory-rpc:cap] deny reason=cap_ws_mismatch capSub=${cap.sub} ws=${workspaceId}\n`,
    );
    respond(res, 401, { error: 'memory_cap_invalid' });
    return false;
  }
  return true;
}

function readHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// ---- read-side trace (memory211/01 §6.11 D11-5, W7 item 1) ------------------

// The write lane has logged `[memory-trace]` stages since memory203/18 R8.2;
// until W7 every READ handler (search / load / browse / the search miss-lane's
// navigation) was silent, so "渐进披露 + direct-recall shortcut" — the §6.9-1
// breakthrough claim — had zero observational face on the path it actually
// happens. These helpers give the four read handlers the SAME line format the
// write side uses (`[memory-trace] stage=… key=value…`), same retention (local
// stderr, full volume — no sampling), with one hard difference: a read trace
// NEVER carries the query text. Only counts, page paths, durations and the
// traceId. (`tierDistribution`/`readTraceId`/`emitReadTrace` are the whole
// surface — keep the no-query-content rule true by construction.)

/**
 * The trace id for one read request. A caller that already owns a turn/run id
 * passes `?traceId=` so the line joins the write-side chain (R8.1); everyone
 * else gets a request-local id (the `rd_` prefix marks the read lane, mirroring
 * the write lane's `wr_`).
 */
function readTraceId(query: Record<string, string>): string {
  // Whitelist, mirroring the write lane's posture (a traceId is a caller thread
  // id, not free text): anything outside `[A-Za-z0-9_-]{1,32}` — including a
  // value carrying whitespace or a newline, which would forge/extend trace rows
  // in the log — falls back to a freshly minted id.
  const passed = query.traceId?.trim();
  return passed && TRACE_ID_RE.test(passed)
    ? passed
    : `rd_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

/** Caller-supplied trace ids must be a short opaque token (see readTraceId). */
const TRACE_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * Tier histogram of one recall's hits, in a stable (`wiki,asset,raw`) order so
 * two equal recalls render byte-identical lines. Empty recall ⇒ `none`.
 */
function tierDistribution(results: Array<{ tier?: string }>): string {
  const counts = new Map<string, number>();
  for (const r of results) {
    const tier = r.tier ?? 'unknown';
    counts.set(tier, (counts.get(tier) ?? 0) + 1);
  }
  if (counts.size === 0) return 'none';
  return ['wiki', 'asset', 'raw']
    .filter((t) => counts.has(t))
    .concat([...counts.keys()].filter((t) => !['wiki', 'asset', 'raw'].includes(t)).sort())
    .map((t) => `${t}:${counts.get(t)}`)
    .join(',');
}

/** One read-side `[memory-trace]` line. Never throws, never logs query text. */
function emitReadTrace(fields: Record<string, string | number | boolean>): void {
  const line = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  process.stderr.write(`[memory-trace] ${line}\n`);
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
  cap: MemoryCap,
): boolean {
  const workspaceId = effectiveWs(cap, query.workspaceId);
  if (!workspaceId) return respond400(res, 'workspaceId query param required');
  if (!scopeOk(cap, workspaceId, res)) return true;
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
  // product204/34 Track 0.1d — the fork-recall manifest is agent-facing but
  // buildManifest runs a RAW FTS query (fork/manifest.ts) with no visibility
  // filter, so it enumerates every role/council/other-agent-private candidate.
  // Gate it with the SAME boundary predicate as handleSearch/handleList/browse
  // (loadByAnyPath → canCapReadPage).
  const slot = runtime.peek(workspaceId);
  if (slot) {
    manifest.entries = manifest.entries.filter((e) => {
      const page = slot.store.loadByAnyPath(e.path);
      return !page || canCapReadPage(cap, page);
    });
  }
  respond(res, 200, manifest);
  return true;
}

function handleRecallFinalize(
  runtime: MemoryRuntime,
  body: unknown,
  res: ServerResponse,
  cap: MemoryCap,
): boolean {
  if (!body || typeof body !== 'object') {
    return respond400(res, 'json body required');
  }
  const b = body as { workspaceId?: unknown; paths?: unknown; snippetMaxBytes?: unknown };
  if (typeof b.workspaceId !== 'string' || !b.workspaceId) {
    return respond400(res, 'workspaceId is required');
  }
  if (!scopeOk(cap, b.workspaceId, res)) return true;
  if (!Array.isArray(b.paths)) {
    return respond400(res, 'paths[] is required');
  }
  const paths: string[] = [];
  for (const p of b.paths) {
    if (typeof p === 'string' && p.length > 0) paths.push(p);
  }
  const snippetMaxBytes =
    typeof b.snippetMaxBytes === 'number' && b.snippetMaxBytes > 0 ? b.snippetMaxBytes : undefined;
  let results = finalizeSelected(runtime, b.workspaceId, paths, snippetMaxBytes);
  // product204/34 Track 0.1d — finalizeSelected returns page CONTENT (≤500B) for
  // whatever paths the selector named, with NO ACL check → an agent could name
  // role:/council:/private:<other> paths and read their content. This is the
  // highest-severity leaf of the fork-recall path (content, not just metadata).
  // Fail-CLOSED: drop any result the cap cannot read (a vanished page → dropped).
  const slot = runtime.peek(b.workspaceId);
  results = slot
    ? results.filter((r) => {
        const page = slot.store.loadByAnyPath(r.path);
        return page ? canCapReadPage(cap, page) : false;
      })
    : [];
  respond(res, 200, { workspaceId: b.workspaceId, results });
  return true;
}

/**
 * `prismer://workspace/<workspaceId>/memory/<path>[#section]`
 *   → { workspaceId, path, section? }.
 * Returns null on malformed input (caller surfaces 400).
 *
 * memory202/09 P0: the `#section` anchor is parsed out (no longer folded into
 * `path`) so `handleLoad` can return a sub-section. No `#` ⇒ section undefined
 * and `path` is byte-for-byte the prior value.
 */
function parsePrismerUri(uri: string): { workspaceId: string; path: string; section?: string } | null {
  const PREFIX = 'prismer://workspace/';
  if (!uri.startsWith(PREFIX)) return null;
  const rest = uri.slice(PREFIX.length);
  const segMemory = '/memory/';
  const memoryIdx = rest.indexOf(segMemory);
  if (memoryIdx <= 0) return null;
  const workspaceId = rest.slice(0, memoryIdx);
  let path = rest.slice(memoryIdx + segMemory.length);
  let section: string | undefined;
  const anchorIdx = path.indexOf('#');
  if (anchorIdx >= 0) {
    const anchor = path.slice(anchorIdx + 1).trim();
    if (anchor) section = anchor;
    path = path.slice(0, anchorIdx);
  }
  if (!workspaceId || !path) return null;
  return section ? { workspaceId, path, section } : { workspaceId, path };
}
