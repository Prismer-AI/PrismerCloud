// v2.1 §9.5 — daemon-as-hook-intake HTTP routes.
//
// Three local-only routes (127.0.0.1 trust boundary, no Bearer auth):
//
//   POST /v1/hooks/pre_llm_call?profile=&adapter=&session=
//     stdin: Hermes shell-hook JSON (§9.5.6 schema)
//     resolve agent context from query/registry, do ScopedMemoryStore
//     multi-pass recall, return {"context": "...[Relevant memory]..."}
//
//   POST /v1/hooks/post_llm_call?profile=&adapter=&session=
//     stdin: same shape; extra.user_message + extra.assistant_response +
//     extra.conversation_history.
//     heuristic-filter → cloud /memory/extract → mirror to local store
//     synchronously so next turn's recall sees it. Returns 204.
//
//   POST /v1/hooks/on_session_end?profile=&adapter=&session=
//     stdin: minimal payload; flush outbox and drop run-session row.
//     Returns 204.
//
// Error handling: any 5xx surfaces in the response body but Hermes
// continues (30s timeout, then aborts) — never block the LLM main loop.

import { randomUUID, createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CloudClient } from '../../auth.js';
import type { MemoryRuntime } from './runtime.js';
import { ScopedMemoryStore } from './scoped-store.js';
import {
  extractFromTurn,
  buildRecallContext,
  shouldSkipExtraction,
  type ExtractInput,
  type ExtractedPage,
  type RecallContextPage,
} from './extract.js';
import {
  compactSlice,
  type CompactionSliceMsg,
  type RecallPageRef,
} from './compaction.js';
import { RecallObservationStore, type RecallMode, type RecallObservation } from './recall-observations.js';
import {
  memoryPathToUri,
  normalizeMemoryPath,
  type MemoryPageGraphContext,
  type ReplicaAwareMemoryPage,
} from './store.js';
import { canReaderReadVisibility, type MemoryReader } from './acl-predicate.js';
import { createLogger } from '../../lib/logger.js';
import { getRecallStats } from './recall-stats.js';
import type { RunSessionRegistry } from './run-session-map.js';
import type { MemorySearchResult, MemoryVisibility } from './types.js';
import type {
  PostTurnJob,
  PostTurnPageReceipt,
} from '../../adapters/coding/shared/lifecycle/post-turn-store.js';
import { terminalRoutingEvidenceError } from '../../adapters/coding/shared/lifecycle/post-turn-context.js';
import type { PostTurnExtractionResult } from '../../adapters/coding/shared/lifecycle/post-turn-worker.js';
import {
  finalizeTerminalTurn,
  getTerminalFinalizer,
} from '../../adapters/coding/shared/lifecycle/terminal-finalizer.js';

export interface HookResolverContext {
  agentImUserId: string;
  workspaceId: string;
  profileId: string | null;
  profileName: string;
  roleTemplateSlug: string | null;
  conversationId: string | null;
  taskId: string | null;
  messageId: string | null;
  adapterName: string;
  model: string | null;
  proxyProvider: string | null;
  servedModel?: string | null;
  servedProvider?: string | null;
  /** Terminal evidence marker; configured profile/run intent never sets it. */
  routingEvidenceSource?: 'adapter';
}

export interface ProfileResolver {
  /**
   * Given a profile name from the query string, resolve the daemon-side
   * binding (agentImUserId, workspaceId, roleTemplateSlug). Returns null
   * when the profile isn't installed on this daemon.
   */
  byProfileName(profileName: string): {
    agentImUserId: string;
    workspaceId: string;
    profileId?: string | null;
    roleTemplateSlug: string | null;
    adapterName: string;
    model: string | null;
    proxyProvider: string | null;
  } | null;
}

export interface AttachHookServerOptions {
  cloud: CloudClient;
  memoryRuntime: MemoryRuntime;
  runSessionRegistry: RunSessionRegistry;
  profileResolver: ProfileResolver;
  deviceId: string;
  /**
   * Optional outbox flush trigger called from `on_session_end`. Defaults
   * to a no-op; the runner wires the actual `worker.flushNow()` here so
   * residual `memory.page.upsert` envelopes leave the daemon before the
   * agent considers the session dead.
   */
  flushOutbox?: () => Promise<void>;
  /** Daemon-persisted native write receipts override a lost provider buffer. */
  resolveExplicitMemoryReceipts?: (input: {
    workspaceId: string;
    agentImUserId: string;
    canonicalTurnId: string;
  }) => PostTurnPageReceipt[];
  /**
   * memory211/01 W3 review B1 — resolve the byte size of attached assets so the
   * extraction lane can declare `deliverableSource.sizeBytes` and the G10
   * sharding trigger (>64K-character source ⇒ 422 sharding_required) is reachable from a
   * conversation turn, not only from the ingest-task lane. The runner wires this
   * to the workspace asset-metadata index. Return {} on any miss — the gate then
   * degrades to G9-only for that turn, never blocks extraction.
   */
  resolveAssetSizes?: (workspaceId: string, assetIds: string[]) => Promise<Record<string, number>>;
}

/** Explicit hook metadata wins; otherwise use the authoritative profile snapshot. */
export function resolvePostTurnModel(
  extra: Record<string, unknown>,
  profileModel: string | null | undefined,
): string {
  if (typeof extra.model === 'string' && extra.model.trim()) return extra.model.trim();
  return typeof profileModel === 'string' ? profileModel.trim() : '';
}

const HOOK_PREFIX = '/v1/hooks/';
const LOG = '[hook-server]';
// memory203/18 R8.2 — one grep-able prefix for every extraction stage log, each
// line carrying the R8.1 traceId: stage=received|skipped(reason=…)|llm_called|
// llm_failed(status=…)|written(paths=…)|synced. llm_called/llm_failed are
// emitted by extract.ts with the same prefix.
const TRACE = '[memory-trace]';

function traceLog(stage: string, traceId: string, detail = ''): void {
  process.stdout.write(`${TRACE} stage=${stage} traceId=${traceId}${detail ? ` ${detail}` : ''}\n`);
}

// memory203/18 R8.2 — extraction-pipeline stage counters (治 sync_turn/extract
// 链的 `except: pass` 黑洞). Module-level (the daemon is single-process,
// mirroring recall-stats.ts) and surfaced on /healthz as `memory.counters` so
// 「0 次触发 vs 被门槛拦 vs LLM/写失败」is one HTTP call apart, no pod-log 抢捞.
export interface MemoryStageCounters {
  /** post_llm_call intakes that reached this hook server. */
  received: number;
  /** Turns skipped BEFORE the LLM (scratch session / empty turn / heuristic filter). */
  skipped: number;
  /** Pages successfully extracted AND written to the local store. */
  extracted: number;
  /** Failures in the extract→write leg (gateway LLM failure, or a local page write threw). */
  writeFailed: number;
  /**
   * memory203/18 W2 — turns where the LLM was reached but yielded ZERO pages
   * (genuine "nothing durable" OR a parse-salvage that recovered nothing).
   * Terminal state for the W1-gate's `llm_called → silence` observability gap.
   */
  extractedEmpty: number;
  /**
   * memory203/18 R6.3 (ramp=warn) — writes that created a NEW un-anchored leaf
   * (no parentHubPath, no rel="child-of" content link) and were let through
   * with a warning. Bumped by rpc.ts handleWrite.
   */
  placementWarn: number;
  /**
   * memory203/18 R9.2 — extraction turns pushed onto the deferred-retry queue
   * after a limiter-class gateway failure (429 / 504 / status=0). Counts
   * INITIAL defers only (a re-queue after a failed retry does not re-count).
   */
  deferred: number;
  /** R9.2 — deferred extractions that RECOVERED on a later retry (pages written path reached). */
  deferredRetried: number;
  /** R9.2 — deferred extractions given up after max attempts (knowledge lost, loudly). */
  deferredAbandoned: number;
  /** product210/03 G9 — deliverable writes rejected for a missing derived-from pointer. */
  deliverablePointerMissing: number;
  /**
   * memory211/01 轴H — extraction-batch pages gated out by the deliverable gate
   * (the pipeline's rejection path; the RPC's G9 rejections count in
   * `deliverablePointerMissing` above, this is the filter leg).
   */
  extractionGatedOut: number;
  /**
   * memory211/01 轴A — deliverable writes whose SOURCE exceeds the sharding
   * threshold (422 sharding_required). Incremented by BOTH extraction legs and
   * by the RPC write path whenever a gate rejection carries
   * `code === 'sharding_required'`.
   *
   * W3 review B2 — the sibling `distillOverBudget` slot was DELETED: nothing
   * incremented it anywhere (grep: declarations + zeros only), and its comment
   * claimed to count "the same thing post-REDEFINED", which made the /healthz
   * shape advertise a counter that could never move.
   */
  shardingRequired: number;
  /** memory211/01 轴H ② — new pages rejected for a missing frontmatter description. */
  descriptionRequired: number;
  /** memory211/01 轴H ③ — bodies rejected by the PKF structure validation gate. */
  pkfInvalid: number;
  /** product210/03 W1-2 — deliverable replays short-circuited as dedupe-hit. */
  deliverableDedupeHit: number;
  /** product210/03 #20 — >1KiB body with zero semantic sections (PKF richness unused). */
  flatPage: number;
  /** product210/03 #21 — whole-page replace against a page that already has sections. */
  replaceOnSectionedPage: number;
  /**
   * pkf v1.1 §4.7 — writes where ≥1 bare `prismer://asset/<id>` href/src was
   * upgraded to the canonical workspace-scoped contentHash form (rpc.ts
   * handleWrite, bare-asset-upgrade.ts).
   */
  bareUriUpgraded: number;
  /**
   * pkf v1.1 §4.7 — writes where an unresolvable asset degraded the bare
   * pointer to the workspace-scoped assetId form (still v1.1-valid; the write
   * is never blocked).
   */
  bareUriScopedDegrade: number;
  /**
   * S5 §3.4-3b (specs/05 Task 5) — background compactions that hit a REAL
   * failure (candidate GET / LLM / empty projection / persist). Ordinary gates
   * do not move this counter; see runBackgroundCompaction for the split.
   */
  compactionFailed: number;
}

const stageCounters: MemoryStageCounters = {
  received: 0,
  skipped: 0,
  extracted: 0,
  writeFailed: 0,
  extractedEmpty: 0,
  placementWarn: 0,
  deferred: 0,
  deferredRetried: 0,
  deferredAbandoned: 0,
  deliverablePointerMissing: 0,
  extractionGatedOut: 0,
  shardingRequired: 0,
  descriptionRequired: 0,
  pkfInvalid: 0,
  deliverableDedupeHit: 0,
  flatPage: 0,
  replaceOnSectionedPage: 0,
  bareUriUpgraded: 0,
  bareUriScopedDegrade: 0,
  compactionFailed: 0,
};

/**
 * Cross-module counter bump (rpc.ts handleWrite owns the R6.3 placement guard
 * but the counters live here so /healthz surfaces ONE `memory.counters` shape).
 */
export function bumpMemoryStageCounter(key: keyof MemoryStageCounters): void {
  stageCounters[key] += 1;
}

/** Snapshot for /healthz (local-server.ts). Always a stable all-numbers shape. */
export function getMemoryStageCounters(): MemoryStageCounters {
  return { ...stageCounters };
}

/** Reset to zeros — test-only (mirrors recall-stats.ts). */
export function resetMemoryStageCounters(): void {
  stageCounters.received = 0;
  stageCounters.skipped = 0;
  stageCounters.extracted = 0;
  stageCounters.writeFailed = 0;
  stageCounters.extractedEmpty = 0;
  stageCounters.placementWarn = 0;
  stageCounters.deliverablePointerMissing = 0;
  stageCounters.extractionGatedOut = 0;
  stageCounters.shardingRequired = 0;
  stageCounters.descriptionRequired = 0;
  stageCounters.pkfInvalid = 0;
  stageCounters.deliverableDedupeHit = 0;
  stageCounters.flatPage = 0;
  stageCounters.replaceOnSectionedPage = 0;
  stageCounters.bareUriUpgraded = 0;
  stageCounters.bareUriScopedDegrade = 0;
  stageCounters.compactionFailed = 0;
  stageCounters.deferred = 0;
  stageCounters.deferredRetried = 0;
  stageCounters.deferredAbandoned = 0;
}

const RECALL_TOP_K = 5;
const RECALL_MAX_BYTES = 3 * 1024;
const RECALL_THRESHOLD = 0.2;

// release201/26 §14.9 (#A2) — eval/throwaway sessions use an ISOLATED scratch
// scope: recall reads ONLY the per-session scratch bucket (never the shared /
// agent-private stores) and extract is SKIPPED, so a throwaway run neither
// reads contaminated shared memory nor writes pollution into it (fixes the
// release201/24 Phase 2 eval pollution). The eval gateway profile + synthetic
// conversationId are keyed `eval-<runId>...`.
function isScratchSession(ctx: HookResolverContext): boolean {
  return ctx.profileName.startsWith('eval-') || Boolean(ctx.conversationId?.startsWith('eval-'));
}
function scratchKey(ctx: HookResolverContext): string {
  return ctx.conversationId || ctx.profileName;
}
// release201/26 §14.5 (#A2) — recall SHADOW mode: still compute + LOG recall,
// but do NOT inject it into the prompt (on the hermes path hermes owns
// injection via builtin MEMORY.md; our recall runs as a measured shadow
// signal).
//
// Desktop-202 doc 18 §3a/§4c (v8.1) — the auto-injection path RETIRES into
// observation: archive recall is now agent-driven (the `memory_search` /
// `memory_load` tools), so the pre_llm_call recall runs as a measured shadow
// (shadowFiredCount, recall-observations) rather than padding the prompt. On
// the **desktop daemon** (capability bit `PRISMER_LOCAL_GATEWAY=1`) shadow is
// therefore DEFAULT ON. CLI / K8s daemons keep the legacy default (off = real
// injection) unless the operator sets the env explicitly, so舰队-wide behaviour
// is unchanged (doc 18 §14 铁律回归). Explicit `FF_MEMORY_RECALL_SHADOW`
// always wins over the capability default.
export function recallShadowEnabled(): boolean {
  const explicit = process.env.FF_MEMORY_RECALL_SHADOW;
  if (explicit === 'true') return true;
  if (explicit === 'false') return false;
  // No explicit setting → desktop daemon defaults shadow ON; others keep
  // the legacy inject behaviour.
  return process.env.PRISMER_LOCAL_GATEWAY === '1';
}
// release201/26 §14.5 (#A4) — best-effort double-sign observation write. Never
// throws / blocks the hook; lives in `recall-observations.db` beside memory.db.
function recordObservation(memoryDbPath: string, obs: RecallObservation): void {
  try {
    const dbPath = memoryDbPath.replace(/memory\.db$/, 'recall-observations.db');
    const store = new RecallObservationStore({ dbPath });
    try {
      store.open();
      store.record(obs);
    } finally {
      store.close();
    }
  } catch (err) {
    process.stderr.write(`${LOG} recall-observation write failed: ${(err as Error).message}\n`);
  }
}

export function attachHookServer(
  opts: AttachHookServerOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    const url = req.url ?? '/';
    if (!url.startsWith(HOOK_PREFIX)) return false;
    if (req.method !== 'POST') {
      respond(res, 405, { error: 'method_not_allowed' });
      return true;
    }
    const [pathOnly = '', queryRaw = ''] = url.split('?', 2);
    const query = parseQuery(queryRaw);
    const event = pathOnly.slice(HOOK_PREFIX.length);

    let body: HookStdinPayload;
    try {
      body = await readJson(req);
    } catch (err) {
      respond(res, 400, { error: 'invalid_json', message: (err as Error).message });
      return true;
    }
    const extra = body.extra ?? {};
    // This event can only be emitted by the signed in-process Hermes plugin.
    // It is deliberately handled before the generic hook payload rejects
    // served_* fields supplied on pre/post_llm_call.
    if (event === 'post_api_request') {
      return handleTerminalRoutingEvidence(res, body, opts);
    }
    if (Object.hasOwn(extra, 'served_model') || Object.hasOwn(extra, 'served_provider')) {
      respond(res, 400, { error: 'untrusted_routing_evidence' });
      return true;
    }

    const ctx = resolveContext(query, body, opts);
    if (!ctx) {
      respond(res, 422, {
        error: 'unresolved_profile',
        message: `Profile '${query.profile ?? '(missing)'}' not bound on this daemon`,
      });
      return true;
    }

    try {
      if (event === 'pre_llm_call') {
        return await handlePreLlmCall(res, body, ctx, opts);
      }
      if (event === 'post_llm_call') {
        return await handlePostLlmCall(res, body, ctx, opts);
      }
      if (event === 'on_session_end') {
        return await handleSessionEnd(res, body, ctx, opts);
      }
      respond(res, 404, { error: 'unknown_hook_event', event });
      return true;
    } catch (err) {
      process.stderr.write(
        `${LOG} ${event} handler threw: ${(err as Error).stack ?? (err as Error).message}\n`,
      );
      respond(res, 500, { error: 'hook_handler_failed', message: (err as Error).message });
      return true;
    }
  };
}

function handleTerminalRoutingEvidence(
  res: ServerResponse,
  body: HookStdinPayload,
  opts: AttachHookServerOptions,
): true {
  const extra = body.extra ?? {};
  const providerSessionId = body.session_id?.trim() ?? '';
  const agentImUserId =
    typeof extra.agent_im_user_id === 'string' ? extra.agent_im_user_id.trim() : '';
  const workspaceId = typeof extra.workspace_id === 'string' ? extra.workspace_id.trim() : '';
  const servedModel = typeof extra.served_model === 'string' ? extra.served_model.trim() : '';
  const servedProvider =
    typeof extra.served_provider === 'string' ? extra.served_provider.trim() : '';
  if (!providerSessionId || !agentImUserId || !workspaceId || !servedModel || !servedProvider) {
    respond(res, 400, { error: 'invalid_terminal_routing_evidence' });
    return true;
  }
  const ctx = opts.runSessionRegistry.lookupByProviderSession(providerSessionId);
  if (!ctx) {
    respond(res, 422, { error: 'unresolved_provider_session' });
    return true;
  }
  if (ctx.agentImUserId !== agentImUserId || ctx.workspaceId !== workspaceId) {
    respond(res, 403, { error: 'terminal_routing_identity_mismatch' });
    return true;
  }
  const recorded = opts.runSessionRegistry.recordTerminalRoutingByProviderSession(
    providerSessionId,
    { servedModel, servedProvider, routingEvidenceSource: 'adapter' },
  );
  if (!recorded) {
    respond(res, 409, { error: 'terminal_routing_not_recorded' });
    return true;
  }
  respond(res, 204, null);
  return true;
}

// ---- recall ACL (product204/34 Track 0.1b) -------------------------------

/**
 * Project the TRUSTED daemon dispatch ctx onto the shared MemoryReader. Unlike
 * the RPC path there is no signed cap here — the ctx IS the daemon's own trusted
 * knowledge of whose turn this is (resolved from the profile binding + run
 * registry, not agent-supplied). Membership judges:
 *   - role:<slug>   POSITIVE — the agent recalls its OWN role's pages
 *                   (ctx.roleTemplateSlug).
 *   - council:<id>  POSITIVE — a turn happening INSIDE conversation <id> is a
 *                   member of council <id> (ctx.conversationId). This is exactly
 *                   where council personas get their memory (doc34 M5 ④).
 *   - orchestrator-reads-all-roles  DENY (fail-closed). HookResolverContext
 *                   carries no taskAuthority, so orchestrator status is NOT
 *                   cleanly determinable from ctx; we refuse to GUESS it (e.g.
 *                   from roleTemplateSlug==='team-manager'). A non-orchestrator simply
 *                   never over-reads. Wiring it positively needs `taskAuthority`
 *                   plumbed into HookResolverContext (flagged, not guessed).
 */
function readerFromCtx(ctx: HookResolverContext): MemoryReader {
  return {
    imUserId: ctx.agentImUserId,
    roleSlugs: ctx.roleTemplateSlug ? [ctx.roleTemplateSlug] : undefined,
    councilIds: ctx.conversationId ? [ctx.conversationId] : undefined,
    // isOrchestrator intentionally omitted — undeterminable from ctx (fail-closed).
  };
}

/**
 * ACL-filter raw FTS hits before they enter an agent-facing recall / compaction
 * context. `slot.search.hybrid` returns EVERY matching page in the workspace
 * regardless of visibility (search.ts filters only workspaceId/MATCH/stale/
 * archivedAt), so an unfiltered hit list injects other agents' `private` pages
 * and every `role:`/`council:` page into the prompt. We resolve each hit's
 * visibility from the store and drop what this reader may not see. A hit whose
 * page vanished (race) is dropped — fail-closed.
 */
function filterRecallHits<T extends MemorySearchResult>(
  slot: ReturnType<MemoryRuntime['resolve']>,
  hits: T[],
  reader: MemoryReader,
): T[] {
  return hits.filter((h) => {
    // loadByAnyPath's declared return is the narrow MemoryPage, but V3 rows
    // carry the replica columns at runtime — the store maps every row through
    // rowToPage (ReplicaAwareMemoryPage), the type the boundary predicate
    // relies on for the exact-actor-set pre-check.
    const page = slot.store.loadByAnyPath(h.path) as ReplicaAwareMemoryPage | null;
    if (!page) return false; // page gone → fail-closed
    // product209/16 §8.3 — exact-actor-set pre-check (same semantics as
    // canCapReadPage / assemblePlaceContext.canSee): a V3 REPLICATED row must
    // name this reader's actor BEFORE coarse visibility; empty set = deny all;
    // NULL (pre-V3 / local-authored) = normal visibility rules.
    if (!reader.isSystem && page.replicaActorIds !== undefined && page.replicaActorIds !== null) {
      if (!Array.isArray(page.replicaActorIds) || page.replicaActorIds.length === 0) return false;
      if (!page.replicaActorIds.includes(reader.imUserId)) return false;
    }
    return canReaderReadVisibility(reader, page.visibility);
  });
}

// ---- handlers ------------------------------------------------------------

async function handlePreLlmCall(
  res: ServerResponse,
  body: HookStdinPayload,
  ctx: HookResolverContext,
  opts: AttachHookServerOptions,
): Promise<true> {
  const extra = (body.extra ?? {}) as Record<string, unknown>;
  const userMessage = typeof extra.user_message === 'string' ? extra.user_message : '';
  if (!userMessage.trim()) {
    // Nothing to anchor recall against; return empty context.
    respond(res, 200, { context: '' });
    return true;
  }
  // Build the recall query from the user message. P1 will compose
  // last-N-turns + active task title (§9.11 P1.3) — for MVP the bare
  // user message is enough to demonstrate the loop.
  const slot = opts.memoryRuntime.resolve(ctx.workspaceId);
  // Build search query — keep short to bias FTS5 toward content tokens.
  const query = userMessage.slice(0, 240);
  const scopedRoot = deriveScopedRoot(slot.store.stats().dbPath);
  const scratch = isScratchSession(ctx);

  let merged: MemorySearchResult[] = [];

  if (scratch) {
    // release201/26 §14.9 — isolated recall: search ONLY the per-session
    // scratch bucket; never the shared / agent-private stores. A fresh scratch
    // bucket is empty → no contaminated recall (fixes the Phase 2 pollution).
    try {
      if (scopedRoot) {
        const scoped = new ScopedMemoryStore({
          rootDir: scopedRoot,
          workspaceId: ctx.workspaceId,
          deviceId: opts.deviceId,
        });
        try {
          merged = scoped.search({
            query,
            scope: 'session-scratch',
            sessionKey: scratchKey(ctx),
            options: { topK: RECALL_TOP_K, maxBytes: RECALL_MAX_BYTES, relevanceThreshold: RECALL_THRESHOLD },
          });
        } finally {
          scoped.close();
        }
      }
    } catch (err) {
      process.stderr.write(`${LOG} scratch recall failed: ${(err as Error).message}\n`);
    }
  } else {
    // Workspace-shared pass. product204/34 Track 0.1b — ACL-filter the raw FTS
    // hits: `hybrid` returns EVERY visibility (no filter in search.ts), so
    // without this an agent's recall injects other agents' private pages and
    // every role/council page. The trusted dispatch ctx supplies the reader
    // (role = own role, council = this conversation); unauthorized hits dropped.
    const sharedResults = filterRecallHits(
      slot,
      slot.search.hybrid(query, {
        topK: RECALL_TOP_K,
        maxBytes: RECALL_MAX_BYTES,
        relevanceThreshold: RECALL_THRESHOLD,
      }),
      readerFromCtx(ctx),
    );
    // Agent-private pass (best-effort; the per-agent bucket lives under
    // ScopedMemoryStore's directory layout, not the MemoryRuntime pool).
    let privateResults: typeof sharedResults = [];
    try {
      if (scopedRoot && ctx.agentImUserId) {
        const scoped = new ScopedMemoryStore({
          rootDir: scopedRoot,
          workspaceId: ctx.workspaceId,
          deviceId: opts.deviceId,
        });
        try {
          privateResults = scoped.search({
            query,
            scope: 'agent-private',
            agentImUserId: ctx.agentImUserId,
            options: { topK: RECALL_TOP_K, maxBytes: RECALL_MAX_BYTES, relevanceThreshold: RECALL_THRESHOLD },
          });
        } finally {
          scoped.close();
        }
      }
    } catch (err) {
      process.stderr.write(`${LOG} agent-private recall failed: ${(err as Error).message}\n`);
    }
    merged = [...sharedResults, ...privateResults].sort((a, b) => b.score - a.score).slice(0, RECALL_TOP_K);
  }

  const shadow = recallShadowEnabled();
  // release201/26 §14.5 (#A4) — double-sign: log what our recall computed + the
  // mode, for offline recall/prompting optimization. Best-effort.
  if (scopedRoot) {
    recordObservation(slot.store.stats().dbPath, {
      workspaceId: ctx.workspaceId,
      agentImUserId: ctx.agentImUserId || null,
      conversationId: ctx.conversationId,
      sessionKey: scratch ? scratchKey(ctx) : null,
      query,
      ourRecall: merged.map((r) => ({ path: r.path, score: r.score, snippet: r.snippet })),
      mode: (shadow ? 'shadow' : 'inject') as RecallMode,
      injected: !shadow && merged.length > 0,
    });
  }

  // release201/26 §14.5 — SHADOW: recall-only, do NOT inject (hermes owns
  // prompting via builtin MEMORY.md). The recall was logged above.
  if (shadow || merged.length === 0) {
    // doc 18 §8 — count a shadow pass only when shadow mode actually computed a
    // recall (照算不注入). An empty-result inject pass is not a shadow firing.
    if (shadow) {
      getRecallStats().recordShadowFired();
      process.stdout.write(
        `${LOG} pre_llm_call SHADOW (not injected) agent=${ctx.agentImUserId} workspace=${ctx.workspaceId} hits=${merged.length}\n`,
      );
    }
    respond(res, 200, { context: '' });
    return true;
  }

  const lines: string[] = ['[Relevant memory from prior sessions]'];
  for (const r of merged) {
    lines.push(`- ${r.path}${r.title ? ` (${r.title})` : ''}: ${r.snippet}`);
  }
  process.stdout.write(
    `${LOG} pre_llm_call recall agent=${ctx.agentImUserId} workspace=${ctx.workspaceId} hits=${merged.length}\n`,
  );
  respond(res, 200, { context: lines.join('\n') });
  return true;
}

async function handlePostLlmCall(
  res: ServerResponse,
  body: HookStdinPayload,
  ctx: HookResolverContext,
  opts: AttachHookServerOptions,
): Promise<true> {
  // memory203/13 §0.5 + line 101 — DAEMON-SIDE automatic extraction (the "自动"
  // leg). The governing rule: all memory-extraction LLM work runs in the AGENT's
  // own runtime — HERE, the daemon inside the agent's pod, using the agent's own
  // gateway credentials (opts.cloud.baseUrl + opts.cloud.apiKey, both injected for
  // the hosted agent). The cloud does ZERO LLM for memory; it only proxies the
  // agent-initiated `/api/v1/messages` call. This is NOT the retired cloud
  // `extractMemories` lane — the INITIATOR is the agent runtime.
  //
  // We do NOT rely on Hermes's native background_review: it spawns with
  // skip_memory=True, so our memory_write tool is never injected — whatever it
  // "remembers" lands in Hermes's built-in MEMORY.md, never our PKF wiki. So we
  // run extraction ourselves, post-turn, fire-and-forget.
  //
  // memory203/18 R8.1/R8.2 — count the intake + resolve the chain traceId. The
  // provider's sync_turn stamps `extra.trace_id`; a caller without one gets a
  // daemon-minted id so every downstream stage log still correlates.
  stageCounters.received += 1;
  const rxExtra = (body.extra ?? {}) as Record<string, unknown>;
  const traceId =
    typeof rxExtra.trace_id === 'string' && rxExtra.trace_id.trim()
      ? rxExtra.trace_id.trim()
      : `tr_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  traceLog('received', traceId, `agent=${ctx.agentImUserId} workspace=${ctx.workspaceId}`);
  // Skip scratch/eval sessions (they neither read nor write shared memory).
  if (isScratchSession(ctx)) {
    stageCounters.skipped += 1;
    traceLog('skipped(reason=scratch_session)', traceId);
    respond(res, 204, null);
    return true;
  }
  const userMessage = typeof rxExtra.user_message === 'string' ? rxExtra.user_message : '';
  const assistantResponse =
    typeof rxExtra.assistant_response === 'string' ? rxExtra.assistant_response : '';
  const rawToolFailures = Array.isArray(rxExtra.tool_failures) ? rxExtra.tool_failures : [];
  const toolFailures = rawToolFailures
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((item) => ({
      tool: typeof item.tool === 'string' ? item.tool : 'unknown',
      ...(typeof item.code === 'string' ? { code: item.code } : {}),
      summary: typeof item.summary === 'string' ? item.summary : String(item.error ?? ''),
    }));
  const attachedAssetIds = Array.isArray(rxExtra.attached_asset_ids)
    ? (rxExtra.attached_asset_ids as unknown[]).filter(
        (value): value is string => typeof value === 'string' && value.trim().length > 0,
      )
    : undefined;
  const stagedMemoryReceipts = ctx.taskId
    ? opts.resolveExplicitMemoryReceipts?.({
        workspaceId: ctx.workspaceId,
        agentImUserId: ctx.agentImUserId,
        canonicalTurnId: ctx.taskId,
      }) ?? []
    : [];
  const explicitMemoryReceipts = parseExplicitMemoryReceipts([
    ...(Array.isArray(rxExtra.explicit_memory_receipts) ? rxExtra.explicit_memory_receipts : []),
    ...stagedMemoryReceipts,
  ]);
  const providerTurnId = body.session_id?.trim() || undefined;
  const canonicalTurnId = ctx.taskId ?? providerTurnId ?? traceId;

  // The hook is an intake signal, not the reliability boundary. Persist the
  // normalized terminal snapshot synchronously before acknowledging; the worker
  // owns all extraction/write retries after this point.
  const durableFinalizerWired = getTerminalFinalizer() !== null;
  finalizeTerminalTurn({
    workspaceId: ctx.workspaceId,
    agentImUserId: ctx.agentImUserId,
    ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
    ...(ctx.taskId?.startsWith('run_') ? { runId: ctx.taskId } : {}),
    ...(ctx.messageId ? { messageId: ctx.messageId } : {}),
    canonicalTurnId,
    turnId: providerTurnId ?? canonicalTurnId,
    lane: explicitMemoryReceipts.length > 0 ? 'explicit' : 'async-repair',
    terminalState: 'completed',
    userMessage,
    assistantResponse,
    toolFailures,
    traceId,
    executionContext: {
      adapterName: ctx.adapterName,
      ...(ctx.profileId ? { profileId: ctx.profileId } : {}),
      ...(ctx.profileName ? { profileName: ctx.profileName } : {}),
      ...(ctx.roleTemplateSlug ? { roleSlug: ctx.roleTemplateSlug } : {}),
      ...(ctx.proxyProvider ? { proxyProvider: ctx.proxyProvider } : {}),
      ...(providerTurnId ? { providerTurnId } : {}),
      ...(attachedAssetIds?.length ? { attachedAssetIds } : {}),
    },
    ...(explicitMemoryReceipts.length > 0 ? { explicitMemoryReceipts } : {}),
  });

  // Respond 204 immediately — extraction is a non-blocking side-channel that must
  // never stall the turn. Durable work runs in PostTurnWorker.
  respond(res, 204, null);
  // Compatibility for direct hook-server embedders/tests that did not wire the
  // Runtime finalizer. The daemon itself always takes the durable lane.
  if (!durableFinalizerWired) {
    void runBackgroundExtraction(body, ctx, opts, traceId).catch((err) => {
      process.stderr.write(`${LOG} background extraction threw: ${(err as Error).message}\n`);
    });
  }
  // ALSO fire-and-forget the SIBLING conversation-compaction leg. Fully
  // non-blocking (the 204 already returned); orthogonal to extraction (extract
  // owns durable capture, compaction owns the aging session projection). Scratch
  // sessions already returned above, so this keeps parity.
  void runBackgroundCompaction(body, ctx, opts, traceId).catch((err) => {
    process.stderr.write(`${LOG} background compaction threw: ${(err as Error).message}\n`);
  });
  return true;
}

function parseExplicitMemoryReceipts(value: unknown): Array<{
  pageId: string;
  path: string;
  version: number;
  contentHash: string;
  authority?: 'cloud' | 'outbox';
  authorityEventId?: string;
}> {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    const pageId = typeof row.pageId === 'string' ? row.pageId.trim() : '';
    const path = typeof row.path === 'string' ? row.path.trim() : '';
    const version = typeof row.version === 'number' ? row.version : 0;
    const contentHash = typeof row.contentHash === 'string' ? row.contentHash.trim() : '';
    if (!pageId || !path || !Number.isInteger(version) || version < 1 || !contentHash) return [];
    const key = `${pageId}\u0000${path}\u0000${version}\u0000${contentHash}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const authority = row.authority === 'cloud' || row.authority === 'outbox'
      ? row.authority
      : undefined;
    const authorityEventId = typeof row.authorityEventId === 'string' && row.authorityEventId.trim()
      ? row.authorityEventId.trim()
      : undefined;
    return [{
      pageId,
      path,
      version,
      contentHash,
      ...(authority ? { authority } : {}),
      ...(authorityEventId ? { authorityEventId } : {}),
    }];
  });
}

const extractLog = createLogger('memory-extract-hook');

/** B2 — `shardingRequired` is the LIVE counter for the G10 sharding trigger. */
function countShardingRejections(codes: readonly string[] | undefined): void {
  for (const code of codes ?? []) {
    if (code === 'sharding_required') stageCounters.shardingRequired += 1;
  }
}

export interface DurablePostTurnExtractionOptions {
  cloud: CloudClient;
  memoryRuntime: MemoryRuntime;
  signal?: AbortSignal;
  /**
   * memory211/01 W3 review B1 — same contract as
   * {@link AttachHookServerOptions.resolveAssetSizes}: arms the G10 sharding
   * trigger for the durable (PostTurnWorker) extraction leg.
   */
  resolveAssetSizes?: (workspaceId: string, assetIds: string[]) => Promise<Record<string, number>>;
}

/**
 * memory211/01 W3 review B1 — resolve sizes for THIS turn's attached assets so
 * both extraction legs can declare `deliverableSource.sizeBytes`. Any failure
 * degrades to "no sizes" (the gate then enforces G9 only) — a size lookup must
 * never cost the turn its memory.
 */
async function resolveAttachedAssetSizes(
  resolve: ((workspaceId: string, assetIds: string[]) => Promise<Record<string, number>>) | undefined,
  workspaceId: string,
  assetIds: readonly string[],
): Promise<Record<string, number>> {
  if (!resolve || assetIds.length === 0) return {};
  try {
    return await resolve(workspaceId, [...assetIds]);
  } catch (err) {
    extractLog.warn(`asset size resolve failed ws=${workspaceId}: ${(err as Error).message}`);
    return {};
  }
}

/** Provider-independent durable extraction lane used by PostTurnWorker. */
export async function extractDurablePostTurn(
  job: PostTurnJob,
  opts: DurablePostTurnExtractionOptions,
): Promise<PostTurnExtractionResult> {
  const payload = job.payload;
  const routingError = terminalRoutingEvidenceError(payload.executionContext);
  if (routingError) throw new Error(routingError);
  const input: ExtractInput = {
    userMessage: payload.userMessage,
    assistantResponse: payload.assistantResponse,
    conversationHistory: [],
    agentImUserId: job.agentImUserId,
    workspaceId: job.workspaceId,
    roleSlug: payload.executionContext?.roleSlug ?? null,
    conversationId: job.conversationId ?? null,
    runId: job.turnId,
    sessionMetadata: {
      model: payload.executionContext?.model ?? '',
      platform: payload.executionContext?.adapterName ?? 'runtime',
    },
    ...(payload.traceId ? { traceId: payload.traceId } : {}),
    ...(payload.executionContext?.attachedAssetIds?.length
      ? { attachedAssetIds: payload.executionContext.attachedAssetIds }
      : {}),
    // memory211/01 W3 review B1 — source sizes arm the G10 sharding trigger on
    // the durable leg too (not only the ingest-task lane).
    attachedAssetSizes: await resolveAttachedAssetSizes(
      opts.resolveAssetSizes,
      job.workspaceId,
      payload.executionContext?.attachedAssetIds ?? [],
    ),
  };
  const skipReason = shouldSkipExtraction(input);
  if (skipReason) {
    stageCounters.skipped += 1;
    traceLog(`skipped(reason=${skipReason})`, payload.traceId ?? '');
    // memory211/08 A4-① — the reason rides to the worker for extract.done
    // (previously dropped here; the healthz counter was its only surface).
    return { pages: [], skipReason };
  }

  const slot = opts.memoryRuntime.resolve(job.workspaceId);
  const ctx: HookResolverContext = {
    agentImUserId: job.agentImUserId,
    workspaceId: job.workspaceId,
    profileId: payload.executionContext?.profileId ?? null,
    profileName: payload.executionContext?.profileName ?? '',
    roleTemplateSlug: null,
    conversationId: job.conversationId ?? null,
    taskId: job.turnId,
    messageId: job.messageId ?? null,
    adapterName: payload.executionContext?.adapterName ?? 'runtime',
    model: payload.executionContext?.model ?? null,
    proxyProvider: payload.executionContext?.proxyProvider ?? null,
  };
  const searchQuery = `${input.userMessage}\n${input.assistantResponse}`.slice(0, 400);
  const place = assemblePlaceContext(slot, searchQuery, readerFromCtx(ctx));
  const recallPages = buildRecallContext(
    place.indexPage,
    place.indexSnippet,
    place.hubPages,
    place.nearest,
  );
  const result = await extractFromTurn(input, {
    cloud: opts.cloud,
    recallPages,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (result.error) {
    // memory211/08 review fix — the HTTP status is the diagnosable part of an
    // extraction failure (429 vs 5xx tells the ops story). It used to be
    // dropped here, which made the diag field `errorStatus` unreachable by
    // construction (this throw happens before the success return below).
    const err = new Error(result.error) as Error & { status?: number };
    if (result.errorStatus != null) err.status = result.errorStatus;
    throw err;
  }
  traceLog(`llm_response(${formatLlmResponseDetail(result)})`, payload.traceId ?? '');
  if (result.pages.length === 0) stageCounters.extractedEmpty += 1;
  // memory211/01 W3 review B4 — BOTH legs go through the same deliverable gate,
  // so BOTH count what it refused. The durable leg used to count only
  // `extractedEmpty`, which made a gate-heavy workspace read as "the extractor
  // yields nothing" instead of "the gate refuses half of it".
  for (const code of result.gateRejections ?? []) {
    stageCounters.extractionGatedOut += 1;
    if (code === 'sharding_required') stageCounters.shardingRequired += 1;
  }
  // memory211/08 A4-① — extractor diagnostics ride to the worker so
  // extract.done metricsJson carries numbers, not dialogue. (No errorStatus
  // here: a failed extraction throws above with the status attached.)
  return {
    pages: result.pages,
    gatedOut: result.gateRejections?.length ?? 0,
    truncated: result.truncated,
    latencyMs: result.latencyMs,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
  };
}

/**
 * Daemon background-review extraction (memory203/13 §0.5). Builds a recall
 * context from the LOCAL store (workspace INDEX + hub pages + nearest pages),
 * runs the in-pod gateway LLM extraction (agent credentials), and writes each
 * produced PKF page via the SAME direct-write path `handleWrite` uses
 * (slot.store.write + outbox `memory.page.upsert`) so it up-syncs and the cloud
 * materialize path anti-orphan-anchors it. Fully non-blocking; the hook already
 * returned 204.
 */
async function runBackgroundExtraction(
  body: HookStdinPayload,
  ctx: HookResolverContext,
  opts: AttachHookServerOptions,
  traceId: string,
): Promise<void> {
  const extra = (body.extra ?? {}) as Record<string, unknown>;
  const userMessage = typeof extra.user_message === 'string' ? extra.user_message : '';
  const assistantResponse =
    typeof extra.assistant_response === 'string' ? extra.assistant_response : '';
  if (!userMessage.trim() && !assistantResponse.trim()) {
    stageCounters.skipped += 1;
    traceLog('skipped(reason=empty_turn)', traceId);
    return;
  }
  const conversationHistory = Array.isArray(extra.conversation_history)
    ? (extra.conversation_history as Array<{ role: string; content: string }>)
    : [];
  const terminalRouting = {
    ...(ctx.servedModel ? { model: ctx.servedModel } : {}),
    ...(ctx.servedProvider ? { provider: ctx.servedProvider } : {}),
    ...(ctx.routingEvidenceSource ? { routingEvidenceSource: ctx.routingEvidenceSource } : {}),
  };
  const routingError = terminalRoutingEvidenceError(terminalRouting);
  if (routingError) {
    stageCounters.skipped += 1;
    traceLog(`skipped(reason=${routingError})`, traceId);
    return;
  }
  const model = terminalRouting.model!;
  // memory203/20 §2.1 — ADDITIVE field: asset ids attached to this turn
  // (`extra.attached_asset_ids`, stamped by the provider shell's sync_turn).
  // Absent → extract.ts falls back to parsing the `<attached_assets>` XML the
  // dispatch composer left in the user message, so older shells still work.
  const attachedAssetIds = Array.isArray(extra.attached_asset_ids)
    ? (extra.attached_asset_ids as unknown[]).filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    : undefined;

  const extractInput: ExtractInput = {
    userMessage,
    assistantResponse,
    conversationHistory,
    agentImUserId: ctx.agentImUserId,
    workspaceId: ctx.workspaceId,
    roleSlug: ctx.roleTemplateSlug,
    conversationId: ctx.conversationId,
    runId: body.session_id ?? '',
    sessionMetadata: { model, platform: ctx.adapterName },
    traceId,
    ...(attachedAssetIds && attachedAssetIds.length > 0 ? { attachedAssetIds } : {}),
    // memory211/01 W3 review B1 — source sizes arm the sharding trigger here too
    attachedAssetSizes: await resolveAttachedAssetSizes(
      opts.resolveAssetSizes,
      ctx.workspaceId,
      attachedAssetIds ?? [],
    ),
  };

  // memory203/18 R8.2 — run the heuristic gate HERE (extractFromTurn re-checks,
  // idempotent) so a filtered turn is a counted+logged `skipped(reason=…)`
  // stage, not a silent no-op inside the extract call.
  const skipReason = shouldSkipExtraction(extractInput);
  if (skipReason) {
    stageCounters.skipped += 1;
    traceLog(`skipped(reason=${skipReason})`, traceId);
    return;
  }

  // First (live) attempt. A limiter-class failure defers instead of dropping
  // (memory203/18 R9.2); anything else counts writeFailed as before.
  const outcome = await attemptExtraction(extractInput, ctx, opts);
  if (outcome === 'limiter_failure') {
    enqueueDeferredExtraction({ input: extractInput, ctx, opts, attempts: 1 }, traceId);
  }
}

// ─── conversation compaction (sibling of runBackgroundExtraction) ────────────

const compactLog = createLogger('memory-compaction-hook');

// Turn-gate — avoid a candidate GET on EVERY turn (the candidate eval is cheap on
// the cloud, but a poll per turn across a busy pod adds up). We poll the candidate
// only every COMPACTION_POLL_EVERY_N-th turn per conversation. TUNABLE via env
// (MEMORY_COMPACTION_POLL_EVERY_N). Module-level, single-process daemon (mirrors
// recall-stats.ts / the deferred queue). Cheap enough that the cloud's own §8
// trigger evaluation is the real gate; this just thins the polling.
const COMPACTION_POLL_EVERY_N = Math.max(1, Number(process.env.MEMORY_COMPACTION_POLL_EVERY_N ?? 5));
// Below this many turns of history, a slice can't have aged past the recent window
// yet — skip the poll entirely (belt-and-suspenders with the cloud trigger floor).
const COMPACTION_MIN_HISTORY = 8;
// memory203 — DEVICE-LOCAL recall over the aging slice, feeding the compaction
// skill the memory pages that may already hold its durable facts (so it emits
// POINTERS, not INLINE). Mirrors the RECALL_* pattern handlePreLlmCall uses; a
// slightly wider topK because a slice spans many messages / topics.
const COMPACTION_RECALL_TOP_K = 6;
// Below this many messages a slice is too thin to be worth a recall pass.
const COMPACTION_RECALL_MIN_SLICE = 2;
const compactionTurnCounter = new Map<string, number>();

/** Test-only: reset the compaction turn-gate (mirrors resetMemoryStageCounters). */
export function resetCompactionTurnGate(): void {
  compactionTurnCounter.clear();
}

/** Candidate returned by the cloud GET .../compaction-candidate. */
type CompactionCandidateResponse =
  | { shouldCompact: false }
  | {
      shouldCompact: true;
      reason?: string;
      conversationType: 'group' | 'direct';
      slice: CompactionSliceMsg[];
      coversFromMessageId: string;
      coversToMessageId: string;
    };

/**
 * Daemon background conversation-compaction (sibling of runBackgroundExtraction).
 * Resolves the turn's conversationId, asks the cloud whether an aging slice
 * should be compacted (GET .../compaction-candidate — the cloud runs NO LLM,
 * only the §8 trigger evaluation), and when fired runs ONE in-pod gateway LLM
 * call (agent credentials, via compactSlice → extract.ts's callGatewayOnce) to
 * produce the session projection, then POSTs it to .../segments. Fully
 * non-blocking; the hook already returned 204. Errors are logged, never thrown.
 */
/**
 * S5 §3.4-3b (specs/05 Task 5) — report a REAL compaction failure to the cloud.
 *
 * The master doc asked for a "run metadata write", which the daemon has no
 * endpoint for; the durable alternative is the run/task event channel, which
 * lands a queryable row for the operator.
 *
 * LANDING TARGET (T1-2b R1 fix) — the first cut posted to
 * `POST /api/im/tasks/:id/event`. That route is TASK-scoped: it resolves the id
 * against `im_tasks` and answers `400 RUN_ID_ON_TASK_ROUTE` for anything in the
 * run id space. `ctx.taskId` in the post-turn hook IS the run id of the turn
 * being dispatched (the run-session registry stores the wire run id as
 * `canonicalTurnId`), so in production every report was rejected — and the
 * best-effort catch below swallowed it. The durable half of this observability
 * was a silent no-op; only the local counter ever moved.
 *
 * So: post to the RUN-scoped `POST /api/im/runs/:runId/events` (assignee-
 * authenticated by `checkRunReadAccess`), and retry the task-scoped route ONCE
 * only when that answers 404 — the id space is deliberately ambiguous
 * (release202/09 §3.2: chat dispatches carry a run id, kanban-task dispatches
 * carry a task id, legacy runs keep bare cuids), and 404 is its only signal.
 * A non-404 (403 identity / 5xx / status 0 unreachable) is not an id mismatch,
 * so retrying a second route there would just be noise.
 *
 * Fully best-effort: a failed upload must never create a second failure.
 */
async function reportCompactionFailure(
  ctx: HookResolverContext,
  opts: AttachHookServerOptions,
  stage: string,
  detail: Record<string, unknown>,
): Promise<void> {
  bumpMemoryStageCounter('compactionFailed');
  if (!ctx.taskId) return; // no run attribution → the local counter is enough
  const id = encodeURIComponent(ctx.taskId);
  const message = `compaction ${stage} failed`;
  const payload = { stage, ...detail };
  try {
    const res = await opts.cloud.request('POST', `/api/im/runs/${id}/events`, {
      body: { type: 'COMPACTION_FAILED', level: 'warn', message, payload },
    });
    if (res.ok || res.status !== 404) return;
    await opts.cloud.request('POST', `/api/im/tasks/${id}/event`, {
      body: { code: 'COMPACTION_FAILED', message, payload },
    });
  } catch {
    /* best-effort — never let the report become a failure of its own */
  }
}

export async function runBackgroundCompaction(
  body: HookStdinPayload,
  ctx: HookResolverContext,
  opts: AttachHookServerOptions,
  traceId: string,
): Promise<void> {
  // (a) Resolve the conversationId for this turn. The hook maps session→conversation
  // in resolveContext (via the run-session registry — the "session-map" verb), so
  // ctx.conversationId is the resolved conversation. Non-fatal when absent
  // (profile-only orphan hooks lose conversationId stamping).
  const conversationId = ctx.conversationId;
  if (!conversationId) {
    traceLog('compact_skipped(reason=no_conversation_id)', traceId);
    return;
  }

  // Turn-gate: only poll the candidate every COMPACTION_POLL_EVERY_N-th turn per
  // conversation, and never before COMPACTION_MIN_HISTORY turns of history.
  const extra = (body.extra ?? {}) as Record<string, unknown>;
  const historyLen = Array.isArray(extra.conversation_history)
    ? (extra.conversation_history as unknown[]).length
    : 0;
  if (historyLen > 0 && historyLen < COMPACTION_MIN_HISTORY) {
    return;
  }
  const nextCount = (compactionTurnCounter.get(conversationId) ?? 0) + 1;
  compactionTurnCounter.set(conversationId, nextCount);
  if (nextCount % COMPACTION_POLL_EVERY_N !== 0) {
    return;
  }

  // (b) Ask the cloud whether an aging slice should be compacted.
  traceLog('compact_candidate_poll', traceId, `conversation=${conversationId} turn=${nextCount}`);
  const candRes = await opts.cloud.request<{ ok?: boolean; data?: CompactionCandidateResponse }>(
    'GET',
    `/api/im/conversations/${conversationId}/compaction-candidate`,
  );
  if (!candRes.ok) {
    traceLog(`compact_candidate_failed(status=${candRes.status})`, traceId);
    void reportCompactionFailure(ctx, opts, 'candidate_get', { status: candRes.status });
    compactLog.warn('compaction-candidate GET failed (non-fatal)', {
      conversationId,
      status: candRes.status,
      error: candRes.error?.message,
    });
    return;
  }
  const candidate = candRes.data?.data;
  // (c) Common case: nothing aged past the recent window — cheap no-op.
  if (!candidate || !candidate.shouldCompact) {
    return;
  }

  // (c2) DEVICE-LOCAL recall over the slice content. So durable facts in this
  // slice that ALREADY live in memory become POINTERS (memoryRefs) instead of
  // being INLINED (degraded) into the summary — the "digest = memory projection"
  // paradigm. Same on-device FTS5 path handlePreLlmCall uses (slot.search.hybrid),
  // NO cloud recall call (north-star: recall on device). The cloud POST /segments
  // then persists the produced projection over the pinned range.
  // Best-effort: a search failure yields an empty recallContext, never blocks.
  const recallContext: RecallPageRef[] = [];
  if (candidate.slice.length >= COMPACTION_RECALL_MIN_SLICE) {
    try {
      const slot = opts.memoryRuntime.resolve(ctx.workspaceId);
      // Query = compact concat of the slice's message texts, capped and biased to
      // content tokens (the `line` is `@username (role): text`).
      const query = candidate.slice.map((m) => m.line).join('\n').slice(0, 600);
      // product204/34 Track 0.1b — ACL-filter (same reason as the pre_llm_call
      // shared pass): a conversation's compaction must NOT pull another council's
      // / role's / another agent's private memory into its projection.
      const hits = filterRecallHits(
        slot,
        slot.search.hybrid(query, {
          topK: COMPACTION_RECALL_TOP_K,
          maxBytes: RECALL_MAX_BYTES,
          relevanceThreshold: RECALL_THRESHOLD,
        }),
        readerFromCtx(ctx),
      );
      const seen = new Set<string>();
      for (const h of hits) {
        if (seen.has(h.path)) continue;
        seen.add(h.path);
        recallContext.push({ path: h.path, snippet: h.snippet });
      }
    } catch (err) {
      compactLog.warn('compaction local recall failed (proceeding without recallContext)', {
        conversationId,
        error: (err as Error).message,
      });
    }
  }

  // (d) Run ONE in-pod gateway LLM call to produce the session projection.
  const model = resolvePostTurnModel(extra, ctx.model);
  traceLog(
    'compact_producing',
    traceId,
    `conversation=${conversationId} slice=${candidate.slice.length} recall=${recallContext.length}`,
  );
  const result = await compactSlice(
    {
      slice: candidate.slice,
      recallContext,
      conversationType: candidate.conversationType,
      model,
      traceId,
      runId: body.session_id ?? '',
    },
    { cloud: opts.cloud },
  );
  if (result.error) {
    // Already logged inside compactSlice (stage=compact_llm_failed).
    void reportCompactionFailure(ctx, opts, 'llm', { error: result.error });
    return;
  }
  if (!result.summary.trim() && !(result.salientFacts.memoryRefs?.length)) {
    // The model produced nothing substantive — do not persist an empty segment.
    traceLog('compact_skipped(reason=empty_projection)', traceId);
    void reportCompactionFailure(ctx, opts, 'empty_projection', {});
    return;
  }

  // (e) POST the produced segment to the cloud (persist over the pinned range +
  // fill memory coverage). Bearer cloud.apiKey (added by cloud.request).
  const postRes = await opts.cloud.request(
    'POST',
    `/api/im/conversations/${conversationId}/segments`,
    {
      body: {
        summary: result.summary,
        salientFacts: result.salientFacts,
        coversFromMessageId: candidate.coversFromMessageId,
        coversToMessageId: candidate.coversToMessageId,
        producerModel: 'agent-compaction',
      },
    },
  );
  if (!postRes.ok) {
    traceLog(`compact_persist_failed(status=${postRes.status})`, traceId);
    void reportCompactionFailure(ctx, opts, 'persist', { status: postRes.status });
    compactLog.warn('compaction segment POST failed (non-fatal)', {
      conversationId,
      status: postRes.status,
      error: postRes.error?.message,
    });
    return;
  }
  traceLog('compact_persisted', traceId, `conversation=${conversationId}`);
  process.stdout.write(
    `${LOG} post_llm_call compacted conversation=${conversationId} agent=${ctx.agentImUserId} slice=${candidate.slice.length}\n`,
  );
}

// ─── R9.2 — deferred extraction retry (doc 18 §9.4) ─────────────────────────
//
// Under burst, the in-pod extraction call to /api/v1/messages is starved by the
// workspace concurrency limiter (429 / 504 slot-deadline / status=0
// cloud_unreachable) — and the turn from EXACTLY the busiest ingestion window
// used to be dropped forever. Instead: limiter-class failures land on a small
// in-memory deferred queue, drained SERIALLY (one entry per tick, deliberately
// gentle on the limiter) by a jittered ~60s pump, max 3 total attempts per
// entry. A successful retry runs the normal written/synced path with the
// ORIGINAL traceId, so the trace chain shows the gap AND the recovery.
//
// KNOWN BOUND (deliberate, per R9.2 scope): the queue is in-memory only — a pod
// restart loses pending entries (no persistence; the outbox is for durable
// events, this is a best-effort salvage of a side-channel). Bounded at
// DEFERRED_QUEUE_MAX with drop-oldest + a `stage=deferred_dropped` log.

/** Limiter-class = worth deferring: rate-limit, slot-deadline, transport. */
function isLimiterClassStatus(status: number): boolean {
  return status === 429 || status === 504 || status === 0;
}

export interface DeferredExtraction {
  input: ExtractInput;
  ctx: HookResolverContext;
  opts: AttachHookServerOptions;
  /** Failed attempts so far (1 after the initial live failure). */
  attempts: number;
}

const DEFERRED_QUEUE_MAX = 32;
const DEFERRED_MAX_ATTEMPTS = 3;
const deferredQueue: DeferredExtraction[] = [];
let deferredPumpTimer: NodeJS.Timeout | null = null;

function deferredRetryIntervalMs(): number {
  const base = Number(process.env.MEMORY_EXTRACT_RETRY_INTERVAL_MS ?? 60_000);
  const jitter = base * 0.2 * (Math.random() * 2 - 1); // ±20%
  return Math.max(1_000, Math.round(base + jitter));
}

/** Lazy, self-stopping pump: one entry per tick; unref'd so it never holds the process. */
function ensureDeferredPumpScheduled(): void {
  if (deferredPumpTimer || deferredQueue.length === 0) return;
  deferredPumpTimer = setTimeout(() => {
    deferredPumpTimer = null;
    void drainDeferredExtractionOnce()
      .catch((err) => {
        process.stderr.write(`${LOG} deferred extraction pump threw: ${(err as Error).message}\n`);
      })
      .finally(() => ensureDeferredPumpScheduled());
  }, deferredRetryIntervalMs());
  deferredPumpTimer.unref?.();
}

/** Push a limiter-failed extraction onto the bounded queue (drop-oldest). */
export function enqueueDeferredExtraction(entry: DeferredExtraction, traceId: string): void {
  if (deferredQueue.length >= DEFERRED_QUEUE_MAX) {
    const dropped = deferredQueue.shift();
    traceLog('deferred_dropped(reason=queue_full)', dropped?.input.traceId ?? '');
  }
  deferredQueue.push(entry);
  stageCounters.deferred += 1;
  traceLog(`deferred(reason=limiter, attempt=${entry.attempts})`, traceId);
  ensureDeferredPumpScheduled();
}

/** Queue depth — /healthz-adjacent introspection + tests. */
export function getDeferredExtractionQueueSize(): number {
  return deferredQueue.length;
}

/** Test-only: clear the queue + stop the pump (mirrors resetMemoryStageCounters). */
export function resetDeferredExtractions(): void {
  deferredQueue.length = 0;
  if (deferredPumpTimer) {
    clearTimeout(deferredPumpTimer);
    deferredPumpTimer = null;
  }
}

/**
 * Drain ONE deferred entry (serial by design). Exported so tests drive it
 * deterministically; the timer pump calls exactly this.
 */
export async function drainDeferredExtractionOnce(): Promise<void> {
  const entry = deferredQueue.shift();
  if (!entry) return;
  const attempt = entry.attempts + 1;
  const traceId = entry.input.traceId ?? '';
  traceLog(`deferred_retry(attempt=${attempt})`, traceId);
  const outcome = await attemptExtraction(entry.input, entry.ctx, entry.opts).catch((err) => {
    process.stderr.write(`${LOG} deferred retry threw: ${(err as Error).message}\n`);
    return 'hard_failure' as const;
  });
  if (outcome === 'limiter_failure') {
    if (attempt < DEFERRED_MAX_ATTEMPTS) {
      // Back of the queue with the bumped attempt count — no re-count of
      // `deferred` (it counts entries, not tries).
      entry.attempts = attempt;
      deferredQueue.push(entry);
      traceLog(`deferred(reason=limiter, attempt=${attempt})`, traceId);
    } else {
      stageCounters.deferredAbandoned += 1;
      traceLog(`extraction_abandoned(attempts=${attempt})`, traceId);
    }
    return;
  }
  if (outcome === 'hard_failure') {
    // Non-limiter failure on retry — retrying again won't help; abandon loudly.
    stageCounters.deferredAbandoned += 1;
    traceLog(`extraction_abandoned(attempts=${attempt}, reason=hard_failure)`, traceId);
    return;
  }
  // 'written' or 'empty' — the extraction leg completed; count the recovery.
  stageCounters.deferredRetried += 1;
}

/**
 * One extraction attempt: rebuild the FRESH place-context (the wiki may have
 * changed since the turn), call the in-pod gateway, and on success run the
 * normal finalize (llm_response/no_pages stages + write loop + written/synced
 * logs) with the entry's ORIGINAL traceId. Shared by the live path
 * (runBackgroundExtraction) and the deferred pump so the two cannot drift.
 */
async function attemptExtraction(
  extractInput: ExtractInput,
  ctx: HookResolverContext,
  opts: AttachHookServerOptions,
): Promise<'written' | 'empty' | 'limiter_failure' | 'hard_failure'> {
  const traceId = extractInput.traceId ?? '';
  const slot = opts.memoryRuntime.resolve(ctx.workspaceId);

  // ── build recall context from the LOCAL store ──────────────────────────────
  // The agent decides placement against the REAL wiki: its INDEX, the hub pages
  // (WITH a snippet of what each is about — R6.1), and the pages nearest the
  // turn (so it can extend an existing page instead of forking a near-duplicate
  // leaf). Shared with the memory_browse RPC (rpc.ts /place-context) via
  // assemblePlaceContext so the two structure views cannot drift.
  const searchQuery = `${extractInput.userMessage}\n${extractInput.assistantResponse}`.slice(0, 400);
  // Track 0.1c — the extraction placement prompt is agent/LLM-facing; scope it
  // to this dispatch's reader so it can't surface another role/council's pages.
  const place = assemblePlaceContext(slot, searchQuery, readerFromCtx(ctx));
  const recallPages: RecallContextPage[] = buildRecallContext(
    place.indexPage,
    place.indexSnippet,
    place.hubPages,
    place.nearest,
  );

  const result = await extractFromTurn(extractInput, { cloud: opts.cloud, recallPages });
  if (result.error) {
    // Already logged inside extractFromTurn (stage=llm_failed(status=…)).
    // R9.2 — limiter-class (429/504/0) is DEFER-worthy, not a terminal failure.
    if (isLimiterClassStatus(result.errorStatus ?? 0)) return 'limiter_failure';
    stageCounters.writeFailed += 1;
    return 'hard_failure';
  }
  // memory203/18 W2 — terminal-state observability for the extraction leg. The
  // W1-gate saw `llm_called` then SILENCE with extracted stuck at 0; these two
  // stages make「真 0 记忆」vs「隐性失败」one grep apart:
  //   llm_response(pages=N, chars=M[, tokens=in:X/out:Y][, truncated]) — the LLM
  //   leg completed and what it yielded; tokens are the memory203/20 §2.1
  //   record-not-limit usage record; `truncated` flags stop_reason=max_tokens
  //   (the W1-gate 0-yield root cause — truncated JSON used to parse to []
  //   silently; salvage remains the pure fallback).
  traceLog(`llm_response(${formatLlmResponseDetail(result)})`, traceId);
  if (result.pages.length === 0) {
    stageCounters.extractedEmpty += 1;
    // memory211/01 轴H — "the LLM answered but the gate refused" must not read
    // as a plain no-op: it is the main extraction path's admission rejection.
    const gatedOut = result.gateRejections?.length ?? 0;
    if (gatedOut > 0) {
      stageCounters.extractionGatedOut += gatedOut;
      countShardingRejections(result.gateRejections);
      traceLog(`skipped(reason=deliverable_gate, rejected=${gatedOut})`, traceId);
    } else {
      traceLog('skipped(reason=no_pages)', traceId);
    }
    return 'empty';
  }
  // Partial gate rejections: the kept pages still flow, the refused ones are
  // counted so the under-count is visible in /healthz.
  const gatedOutPartial = result.gateRejections?.length ?? 0;
  if (gatedOutPartial > 0) {
    stageCounters.extractionGatedOut += gatedOutPartial;
    countShardingRejections(result.gateRejections);
  }

  const writtenPaths: string[] = [];
  let enqueuedCount = 0;
  for (const page of result.pages) {
    try {
      const enqueued = writeExtractedPage(slot, ctx, opts.deviceId, page, traceId);
      stageCounters.extracted += 1;
      writtenPaths.push(page.path);
      if (enqueued) enqueuedCount += 1;
    } catch (err) {
      stageCounters.writeFailed += 1;
      extractLog.error('local write of extracted page failed', {
        path: page.path,
        error: (err as Error).message,
      });
    }
  }
  if (writtenPaths.length > 0) {
    traceLog(`written(paths=${writtenPaths.join(',')})`, traceId);
  }
  // `synced` here means "queued into the outbox" — the upload+ack itself is the
  // outbox worker's async job; a page that failed to enqueue stays local-only.
  if (enqueuedCount > 0) {
    traceLog('synced', traceId, `queued=${enqueuedCount}`);
  }
  process.stdout.write(
    `${LOG} post_llm_call extracted+wrote ${result.pages.length} page(s) agent=${ctx.agentImUserId} workspace=${ctx.workspaceId}\n`,
  );
  return 'written';
}

/**
 * memory203/20 §2.1 — the `llm_response(...)` stage-line detail. Pure +
 * exported so the usage-recording line SHAPE is testable:
 *   `pages=N, chars=M[, tokens=in:X/out:Y][, truncated]`
 * Tokens are RECORDED (never budgeted); absent when the gateway reported no
 * usage block.
 */
export function formatLlmResponseDetail(result: {
  pages: unknown[];
  rawTextChars?: number;
  truncated?: boolean;
  promptTokens?: number;
  completionTokens?: number;
  latencyMs?: number;
}): string {
  const parts = [`pages=${result.pages.length}`, `chars=${result.rawTextChars ?? 0}`];
  if (typeof result.promptTokens === 'number' || typeof result.completionTokens === 'number') {
    parts.push(`tokens=in:${result.promptTokens ?? '?'}/out:${result.completionTokens ?? '?'}`);
  }
  if (typeof result.latencyMs === 'number') parts.push(`latency_ms=${result.latencyMs}`);
  if (result.truncated) parts.push('truncated');
  return parts.join(', ');
}

/**
 * memory203/18 R6.1/R6.2 — assemble the "write-time placement" structure view
 * from the LOCAL store: the INDEX row + its snippet, the hub pages WITH a
 * snippet of what each hub is ABOUT (description when authored, else the first
 * ~200 chars of content best-effort, else ''), and — when a query is given —
 * the nearest pages via the same local hybrid search the extraction leg uses.
 *
 * SHARED between the background-extraction leg (above) and the memory_browse
 * RPC (rpc.ts GET /local/memory/place-context): one assembly, two consumers,
 * so what the browsing agent sees is exactly what the extract model sees.
 * (R6.1: the old hook-server call site mapped hubs WITHOUT a snippet, leaving
 * the model blind to hub topics → it rationally fell back to placement='new'
 * → orphan leaves under INDEX.)
 */
export interface PlaceContextParts {
  indexPage: { path: string; title: string | null; pageType: string } | null;
  indexSnippet: string | null;
  hubPages: Array<{
    path: string;
    title: string | null;
    pageType: string;
    snippet: string;
    /**
     * memory211/01 §3 轴C W1a — tree-shaped browse: the hub's child-of children
     * (path-sorted, titles resolved best-effort), from the local `memory_links`
     * mirror. Empty for a hub with no children yet.
     */
    children: Array<{ path: string; title: string | null }>;
  }>;
  nearest: Array<{ path: string; title: string | null; snippet: string }>;
}

export function assemblePlaceContext(
  slot: ReturnType<MemoryRuntime['resolve']>,
  searchQuery?: string,
  reader?: MemoryReader,
): PlaceContextParts {
  // product204/34 Track 0.1c — ACL filter, single-source. `hubPages`/`recent`
  // come from `slot.store.list` (raw, every visibility) and `nearest` from raw
  // `slot.search.hybrid`; all three feed an agent/LLM (memory_browse RPC,
  // extraction placement prompt, write-placement 422 hint). Without a filter
  // they leak other agents' private pages + every role/council page. When a
  // `reader` is supplied we drop what it may not see via the SAME
  // canReaderReadVisibility matrix the recall passes use — no drift. No reader
  // (enforce-off legacy) → unchanged, matching how canCapReadPage handles null.
  //
  // product209/16 §8.3 — exact-actor-set pre-check (acl-predicate
  // canCapReadPage step 2, same semantics): a V3 REPLICATED row carries the
  // Cloud-generated exact actor set — the reader's actor must be a member
  // BEFORE the coarse visibility matrix applies, so a ready replica's
  // hub/recent hint surface cannot show pages the exact set excluded from
  // this actor. Empty set = deny all; NULL (pre-V3 / local-authored) =
  // normal visibility rules; the daemon-internal system reader bypasses.
  const canSee = (page: {
    visibility: MemoryVisibility;
    replicaActorIds?: readonly string[] | null;
  }): boolean => {
    if (!reader) return true;
    if (!reader.isSystem && page.replicaActorIds !== undefined && page.replicaActorIds !== null) {
      if (!Array.isArray(page.replicaActorIds) || page.replicaActorIds.length === 0) return false;
      if (!page.replicaActorIds.includes(reader.imUserId)) return false;
    }
    return canReaderReadVisibility(reader, page.visibility);
  };
  const indexRow = slot.store.loadIndexPage();
  const indexSnippet = indexRow ? slot.store.loadIndexPageContent() : null;
  const visibleHubs = slot.store.list({ pageType: 'hub', limit: 20 }).filter((p) => canSee(p));
  // memory211/01 §3 轴C W1a — the browse tree's child edges, aggregated from the
  // local `memory_links` mirror in one call for the whole visible hub set.
  // Let-it-throw: the store `list` above already crossed the same replica-recall
  // gate, so there is no new failure mode to soften here.
  const hubGraphContext =
    visibleHubs.length > 0
      ? slot.store.pageGraphContext(visibleHubs.map((p) => p.id))
      : new Map<string, MemoryPageGraphContext>();
  const hubPages = visibleHubs.map((p) => ({
    path: p.path,
    title: p.title,
    pageType: p.pageType,
    snippet: p.description ?? hubContentSnippet(slot, p.id),
    children: hubGraphContext.get(p.id)?.children ?? [],
  }));
  let nearest: PlaceContextParts['nearest'] = [];
  if (searchQuery?.trim()) {
    // Nearest pages by a hybrid search against the query text (cheap, local FTS5).
    try {
      const hits = slot.search.hybrid(searchQuery, { topK: 8, maxBytes: 4 * 1024 });
      nearest = (reader ? filterRecallHits(slot, hits, reader) : hits).map((r) => ({
        path: r.path,
        title: r.title,
        snippet: r.snippet,
      }));
    } catch (err) {
      extractLog.warn('place-context search failed (proceeding with INDEX+hubs only)', {
        error: (err as Error).message,
      });
    }
  }

  // memory203/24 Step 4 — recall-before-write reliability: ALWAYS surface the
  // most-recently-written leaves, not just FTS-nearest. The page the agent should
  // EXTEND (a same-session earlier write on the same concept) must be visible
  // even when the FTS query misranks it — different restate wording, CJK
  // tokenization, or an FTS index that hasn't caught the just-written row. Merge
  // recency-FIRST (the just-written page leads) then FTS-nearest, dedup by path;
  // buildRecallContext caps the total. This is what lets the model choose
  // placement="extend" instead of forking a near-duplicate.
  const recent = slot.store
    .list({ pageType: 'leaf', limit: 6 })
    .filter((p) => canSee(p)) // Track 0.1c — a role/council leaf must not leak via "recent"
    .map((p) => ({ path: p.path, title: p.title, snippet: (p.description ?? '').slice(0, 200) }));
  const mergedNearest: PlaceContextParts['nearest'] = [];
  const seenNearest = new Set<string>();
  for (const n of [...recent, ...nearest]) {
    if (seenNearest.has(n.path)) continue;
    seenNearest.add(n.path);
    mergedNearest.push(n);
  }
  nearest = mergedNearest;
  return {
    indexPage: indexRow
      ? { path: indexRow.path, title: indexRow.title, pageType: indexRow.pageType }
      : null,
    indexSnippet,
    hubPages,
    nearest,
  };
}

/** Best-effort first ~200 chars of a hub's content (loadContent throws on non-inline payloads). */
function hubContentSnippet(slot: ReturnType<MemoryRuntime['resolve']>, pageId: string): string {
  try {
    return (slot.store.loadContent(pageId)?.content ?? '').slice(0, 200);
  } catch {
    return '';
  }
}

/**
 * Write one extracted page via the SAME direct-write path `handleWrite` uses:
 * `slot.store.write` (local-first) + an `memory.page.upsert` outbox enqueue so it
 * up-syncs to the cloud (where materialize anti-orphan-anchors it to INDEX).
 * 'agent:self' visibility routes to the agent's private bucket; 'workspace' to the
 * shared bucket. Mirrors handleWrite's outbox envelope shape exactly.
 */
function writeExtractedPage(
  slot: ReturnType<MemoryRuntime['resolve']>,
  ctx: HookResolverContext,
  deviceId: string,
  page: ExtractedPage,
  // memory203/18 R8.1 — stamped onto both outbox envelopes (page.upsert +
  // link.upsert) so the cloud sync events / page provenance carry the chain id.
  traceId?: string,
): boolean {
  const visibility =
    page.visibility === 'agent:self' && ctx.agentImUserId
      ? ({ kind: 'agent', imUserId: ctx.agentImUserId } as const)
      : ({ kind: 'workspace' } as const);
  // memory203/16 (audit fix) — an ATTACHED leaf must carry a rel="child-of" link to
  // its hub so the cloud materialize records leaf→hub membership and rebuild-index
  // nests it UNDER the hub, instead of the anti-orphan anchor dropping it flat under
  // INDEX (the observed orphan-leaf symptom). Deterministic + idempotent: append the
  // link only when the model didn't already author one for this hub.
  let content = page.content;
  if (page.placement === 'attach' && page.parentHubPath) {
    const hub = page.parentHubPath;
    const hasChildOf = /rel=["']child-of["']/i.test(content) && content.includes(hub);
    if (!hasChildOf) {
      // memory203/18 W2 P0 — normalized composition (never `…/memory/memory/…`).
      const href = memoryPathToUri(ctx.workspaceId, hub);
      content = `${content}\n<p><a href="${href}" rel="child-of">${hub}</a></p>`;
    }
  }
  const written = slot.store.write({
    workspaceId: ctx.workspaceId,
    path: page.path,
    content,
    title: page.title,
    description: `auto-extracted (${page.placement})`,
    pageType: page.pageType,
    visibility,
    sourceRefs: [
      ...(ctx.conversationId ? [`conv:${ctx.conversationId}`] : []),
      ...(ctx.taskId ? [`task:${ctx.taskId}`] : []),
    ],
    actorImUserId: ctx.agentImUserId,
    actorKind: 'agent',
  });
  if (!deviceId) return false;
  // Up-sync (same envelope as handleWrite). Best-effort — a queue failure leaves
  // the page local-only but never throws.
  let enqueued = false;
  try {
    slot.outbox.enqueue({
      eventId: randomUUID(),
      schemaVersion: 1,
      eventType: 'memory.page.upsert',
      workspaceId: ctx.workspaceId,
      actorImUserId: ctx.agentImUserId,
      actorKind: 'agent',
      deviceId,
      createdAt: new Date().toISOString(),
      idempotencyKey: `upsert:${ctx.workspaceId}:${written.id}:${Math.max(0, written.version - 1)}:${written.contentHash}`,
      pageId: written.id,
      path: written.path,
      parentVersion: Math.max(0, written.version - 1),
      contentHash: written.contentHash,
      payload: { kind: 'inline', content },
      ...(visibility.kind === 'workspace'
        ? {}
        : { visibility: `${visibility.kind}:${visibility.imUserId}` }),
      ...(traceId ? { traceId } : {}),
    });
    enqueued = true;
  } catch (err) {
    extractLog.warn('extracted-page upsert enqueue failed (page is local-only)', {
      path: written.path,
      error: (err as Error).message,
    });
  }

  // memory203/16 (audit fix) — emit the leaf→hub `child-of` link as a GRAPH event.
  // The cloud materialize does NOT extract `<a rel>` links from page content, and
  // rebuild-index nests leaves by the im_memory_links table — so the content link
  // alone (added above, for the reader) would never nest the leaf. This explicit
  // `memory.link.upsert` is what actually anchors the leaf under its hub.
  if (page.placement === 'attach' && page.parentHubPath && deviceId) {
    try {
      // memory203/18 W2 P0 — normalized URIs (a page path that already starts
      // with `memory/` no longer doubles the prefix), PLUS plain-path fields
      // (`sourcePath`/`targetPath`) the cloud lane prefers over URI parsing.
      const sourceUri = memoryPathToUri(ctx.workspaceId, page.path);
      const targetUri = memoryPathToUri(ctx.workspaceId, page.parentHubPath);
      const relation = 'child-of';
      const idem = `link-upsert:${ctx.workspaceId}:${createHash('sha256')
        .update(sourceUri + targetUri + relation)
        .digest('hex')}`;
      slot.outbox.enqueue({
        eventId: randomUUID(),
        schemaVersion: 1,
        eventType: 'memory.link.upsert',
        workspaceId: ctx.workspaceId,
        actorImUserId: ctx.agentImUserId,
        actorKind: 'agent',
        deviceId,
        createdAt: new Date().toISOString(),
        idempotencyKey: idem,
        sourceUri,
        targetUri,
        relation,
        sourcePath: normalizeMemoryPath(page.path),
        targetPath: normalizeMemoryPath(page.parentHubPath),
        extractedFromPageId: written.id,
        ...(traceId ? { traceId } : {}),
      });
    } catch (err) {
      extractLog.warn('extracted child-of link enqueue failed (leaf nests only after next Dream)', {
        path: written.path,
        hub: page.parentHubPath,
        error: (err as Error).message,
      });
    }
  }
  return enqueued;
}

async function handleSessionEnd(
  res: ServerResponse,
  body: HookStdinPayload,
  ctx: HookResolverContext,
  opts: AttachHookServerOptions,
): Promise<true> {
  const runId = body.session_id ?? '';
  if (runId) opts.runSessionRegistry.drop(runId);
  if (opts.flushOutbox) {
    try {
      await opts.flushOutbox();
    } catch (err) {
      process.stderr.write(`${LOG} session_end flush threw: ${(err as Error).message}\n`);
    }
  }
  process.stdout.write(`${LOG} on_session_end run=${runId} agent=${ctx.agentImUserId}\n`);
  respond(res, 204, null);
  return true;
}

// ---- helpers -------------------------------------------------------------

interface HookStdinPayload {
  hook_event_name?: string;
  tool_name?: string | null;
  tool_input?: unknown;
  session_id?: string;
  cwd?: string;
  extra?: Record<string, unknown>;
}

function resolveContext(
  query: Record<string, string>,
  body: HookStdinPayload,
  opts: AttachHookServerOptions,
): HookResolverContext | null {
  const profileName = query.profile;

  // memory203/14 (2026-07-01) — IN-PROCESS provider trigger path. The
  // MemoryProvider.sync_turn runs INSIDE the gateway process (reliably invoked
  // per turn by conversation_loop, unlike a config.yaml shell hook which a
  // long-running gateway never registers when added post-startup). It POSTs here
  // WITHOUT a profile query (it has no profile name) but supplies its agent +
  // workspace identity from its env. Resolve from those, enriching
  // conversationId/taskId from the active run when discoverable.
  if (!profileName) {
    const extra = (body.extra ?? {}) as Record<string, unknown>;
    const agentImUserId =
      typeof extra.agent_im_user_id === 'string' ? extra.agent_im_user_id : '';
    const workspaceId = typeof extra.workspace_id === 'string' ? extra.workspace_id : '';
    if (!agentImUserId || !workspaceId) return null;
    const sid = body.session_id ?? '';
    const byRun = sid ? opts.runSessionRegistry.lookup(sid) : null;
    const byProviderSession = byRun || !sid
      ? null
      : opts.runSessionRegistry.lookupByProviderSession(sid);
    const byAgent = byRun || byProviderSession
      ? null
      : opts.runSessionRegistry.lookupActiveByAgent(agentImUserId, {
          adapterName: 'hermes',
          excludeProviderCacheRows: true,
        });
    const active =
      byRun ?? byProviderSession ?? (byAgent && !('ambiguous' in byAgent) ? byAgent : null);
    const profile = active?.profileName
      ? opts.profileResolver.byProfileName(active.profileName)
      : null;
    return {
      agentImUserId,
      workspaceId,
      profileId: active?.profileId ?? profile?.profileId ?? null,
      profileName: active?.profileName ?? '',
      roleTemplateSlug: active?.roleTemplateSlug ?? profile?.roleTemplateSlug ?? null,
      conversationId: active?.conversationId ?? null,
      taskId: active?.taskId ?? null,
      messageId: active?.messageId ?? null,
      adapterName: active?.adapterName ?? 'hermes',
      model: active?.model ?? profile?.model ?? null,
      proxyProvider: active?.proxyProvider ?? profile?.proxyProvider ?? null,
      servedModel: active?.servedModel ?? null,
      servedProvider: active?.servedProvider ?? null,
      ...(active?.routingEvidenceSource === 'adapter'
        ? { routingEvidenceSource: 'adapter' as const }
        : {}),
    };
  }

  // First try run-session registry (set by hermes adapter when it
  // received run_id). This carries the freshest conversationId/taskId.
  const runId = body.session_id ?? '';
  const fromRegistry = runId ? opts.runSessionRegistry.lookup(runId) : null;
  if (fromRegistry) {
    const profile = fromRegistry.profileName
      ? opts.profileResolver.byProfileName(fromRegistry.profileName)
      : null;
    return {
      agentImUserId: fromRegistry.agentImUserId,
      workspaceId: fromRegistry.workspaceId,
      profileId: fromRegistry.profileId ?? profile?.profileId ?? null,
      profileName: fromRegistry.profileName,
      roleTemplateSlug: fromRegistry.roleTemplateSlug ?? profile?.roleTemplateSlug ?? null,
      conversationId: fromRegistry.conversationId,
      taskId: fromRegistry.taskId,
      messageId: fromRegistry.messageId ?? null,
      adapterName: fromRegistry.adapterName,
      model: fromRegistry.model ?? profile?.model ?? null,
      proxyProvider: fromRegistry.proxyProvider ?? profile?.proxyProvider ?? null,
      servedModel: fromRegistry.servedModel ?? null,
      servedProvider: fromRegistry.servedProvider ?? null,
      ...(fromRegistry.routingEvidenceSource === 'adapter'
        ? { routingEvidenceSource: 'adapter' as const }
        : {}),
    };
  }

  // Fallback: profile-only resolution via the daemon's agent_profiles
  // mirror. Loses conversationId/taskId stamping for orphan hooks, but
  // recall still works because workspaceId + agentImUserId are intact.
  const profile = opts.profileResolver.byProfileName(profileName);
  if (!profile) return null;
  return {
    agentImUserId: profile.agentImUserId,
    workspaceId: profile.workspaceId,
    profileId: profile.profileId ?? null,
    profileName,
    roleTemplateSlug: profile.roleTemplateSlug,
    conversationId: null,
    taskId: null,
    messageId: null,
    adapterName: profile.adapterName,
    model: profile.model,
    proxyProvider: profile.proxyProvider,
    servedModel: null,
    servedProvider: null,
  };
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  if (status === 204 || body === null) {
    res.end();
    return;
  }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
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

async function readJson(req: IncomingMessage): Promise<HookStdinPayload> {
  let raw = '';
  req.setEncoding('utf8');
  for await (const chunk of req) raw += chunk as string;
  if (!raw) return {};
  return JSON.parse(raw) as HookStdinPayload;
}

/**
 * MemoryRuntime stores per-workspace memory at
 * `<baseDir>/<workspaceSlug>/memory.db`. ScopedMemoryStore stores at
 * `<baseDir>/<workspaceSlug>/_shared.db` and `<baseDir>/<workspaceSlug>/agents/<id>.db`.
 * Both use the same `<baseDir>` root, so given a runtime db path we strip
 * the trailing `<slug>/memory.db` to get the shared baseDir.
 */
function deriveScopedRoot(memoryDbPath: string | null): string | null {
  if (!memoryDbPath || memoryDbPath === ':memory:') return null;
  // .../baseDir/<slug>/memory.db → .../baseDir
  const m = memoryDbPath.match(/^(.+)\/[^/]+\/memory\.db$/);
  return m ? m[1]! : null;
}
