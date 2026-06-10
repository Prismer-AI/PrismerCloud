/**
 * Prismer IM — v1.9.x WS protocol payload types (Track C)
 *
 * Adds 10 new ServerEvents types on top of the 1.8.2 baseline (`src/im/ws/events.ts`).
 * 9 daemon-protocol events + workspace/asset change broadcasts.
 * Plus `host.acked` — the cloud → daemon ACK reply for `agent.host.declare`.
 *
 * See [docs/refactor/03-ws-protocol.md] for the authoritative protocol spec.
 *
 * Layout note: payload interfaces live in this file (Track C owned). The new
 * literal strings extend the existing `WSClientEventType` / `WSServerEventType`
 * unions in `src/im/types/index.ts` directly — small, single-line edits there
 * minimize the hot-spot conflict surface with Track A. See WORKTREE-SETUP.md §六.
 *
 * m1 status (all 11 types finalized):
 *   ✅ agent.host.declare / host.acked
 *   ✅ agent.status.changed
 *   ✅ task.dispatch.request / .progress / .reply
 *   ✅ task.cancel
 *   ✅ agent.changed
 *   ✅ workspace.changed
 *   ✅ agent_profile.changed
 *   ✅ workspace_file.changed
 *   ✅ asset.changed
 */

// AgentStatus is duplicated here (instead of imported from './index') to avoid
// a circular barrel cycle: index.ts does `export * from './im-events'` so any
// import from index.ts in this file creates a self-loop that madge flags.
// Keep this union in sync with the canonical definition in index.ts.
type AgentStatus = 'online' | 'busy' | 'idle' | 'offline';

// release201/25 §7 / release201/26 — typed L3 input contract (cloud-side
// source of truth). `TaskDispatchRequestPayload.contextEnvelope` carries
// this across the wire so adapters can render it natively. The mirror
// `sdk/prismer-cloud/runtime/src/types/conversation-envelope.ts` MUST stay
// in lockstep (same manual-sync convention as the daemon im-events mirror).
import type { ConversationContextEnvelope } from './conversation-envelope';

// ─── agent.host.declare (daemon → cloud) ─────────────────────

/**
 * Per-agent declaration entry inside `agent.host.declare`.
 * `profiles[].version` is the daemon's local version; cloud compares against
 * im_agent_profiles.version to compute `profilesToSync` in the ACK.
 */
export interface HostedAgentDeclaration {
  imUserId: string;
  name: string;
  adapterName: string;
  capabilities: string[];
  profiles: Array<{ id: string; version: number }>;
}

export interface AgentHostDeclarePayload {
  daemonId: string;
  daemonVersion: string;
  platform: 'darwin' | 'linux' | 'win32';
  agents: HostedAgentDeclaration[];
  /**
   * v2.0 §4.8.2 R7 — optional human-readable label the daemon supplies for
   * its physical device (e.g. "Mac Studio (Jason's office)"). When absent
   * the cloud falls back to the daemon hostname (extracted from daemonId)
   * or the literal string `daemonId`.
   */
  daemonLabel?: string;
  /**
   * v2.0 §4.8.2 R7 — daemon-declared device kind. When absent the cloud
   * infers from im_containers.deviceType (k8s vs local) or defaults to
   * `local`. Used so the UI Devices panel can badge the row correctly.
   */
  daemonKind?: 'k8s' | 'local' | 'edge';
}

// ─── host.acked (cloud → daemon, ACK reply) ──────────────────

export interface RejectedHostedAgent {
  imUserId: string;
  reason: 'bound-to-other-daemon' | 'not-owned' | 'unknown';
  ownerDaemonId?: string;
}

/**
 * Returned with `requestId` matching the originating `agent.host.declare`.
 * `syncCursor` keys are intentionally string-typed for forward extensibility;
 * Track A may add e.g. `workspace_files`, `assets` cursors in m2/m3.
 */
export interface HostAckedPayload {
  workspaceId: string;
  syncCursor: {
    workspaces: number;
    agent_profiles: number;
    [key: string]: number;
  };
  profilesToSync: string[];
  /** Profile IDs the daemon declared but that no longer exist on the cloud
   *  (soft-deleted). The daemon should remove these from its local store so
   *  it stops trying to dispatch tasks to dead profiles. */
  profilesToDelete: string[];
  /** Agents this daemon is accepted to host after this ACK. */
  acceptedAgents?: string[];
  /**
   * Agents this daemon declared but cloud refused. New runtimes must stop
   * declaring these ids until they are explicitly installed/reassigned again.
   */
  rejectedAgents?: RejectedHostedAgent[];
}

// ─── agent.status.changed (bidirectional) ────────────────────

/**
 * Sent by daemon when an agent it hosts changes status. Cloud writes
 * im_agent_cards.status, then re-broadcasts the same event to other WS
 * connections of the same user (so mobile UI sees it).
 */
export interface AgentStatusChangedPayload {
  agentImUserId: string;
  status: AgentStatus;
  /** Set when status === 'busy' to identify the active profile. */
  activeProfileId?: string;
  /** Tasks the agent is currently running, if status === 'busy'. */
  runningTaskIds?: string[];
}

// ─── task.dispatch.request (cloud → daemon) ──────────────────

/**
 * Conversation-history snippet supplied to the daemon as task context.
 *
 * `dispatchToAgent` (mention-driven) populates `context` from the most recent
 * group-chat messages. Cap: see TASK_CONTEXT_DEFAULTS in m2.
 *
 * Pure point-to-point dispatches (e.g. mobile → cloud → daemon without
 * a group-chat trigger) may omit `context`.
 */
export interface TaskDispatchContextEntry {
  sender: string;
  senderRole: 'human' | 'agent' | 'admin' | 'system';
  content: string;
  createdAt: string;
  /**
   * Asset IDs the human attached to THIS chat message (from
   * `m.metadata.kind === 'workspace_asset_attachment'`). Daemon-side
   * `payload.assetRefs` carries the full hydrated list across the
   * conversation; this per-entry list lets the prompt explain WHICH message
   * an asset arrived with.
   *
   * 2026-05-31 release201/30 P0 — kept for backwards compatibility. New
   * cloud builds also populate `attachedAssets` with full metadata; older
   * cloud builds without enrichment still send id-only here and the daemon
   * falls back to id-only rendering inside `<attached_assets>`.
   */
  attachedAssetIds?: string[];
  /**
   * 2026-05-31 release201/30 §XML-context P0 — enriched metadata for the
   * assets the human attached to this message. Composed cloud-side from
   * `im_messages.attachments[]` (mime / filename / sizeBytes) plus legacy
   * `metadata.attachments`. Daemon's `composeConversationContextXml`
   * renders each entry as `<asset id="..." mime="..." filename="..."
   * size_bytes="..."/>` inside a `<attached_assets>` child of
   * `<prior_message>` / `<current_message>` so the agent sees prior-turn
   * file attachments instead of getting a blank text body.
   *
   * Optional + forward-compatible: when missing the daemon emits id-only
   * elements derived from `attachedAssetIds`. Empty array also renders no
   * `<attached_assets>` element.
   */
  attachedAssets?: Array<{
    id: string;
    mime?: string;
    filename?: string;
    sizeBytes?: number;
  }>;
}

/**
 * Hydrated asset reference attached to a dispatch (Wave-8 W1).
 *
 * Cloud queries IMAsset by id during `emitDaemonDispatchRequest` and ships
 * the metadata daemon needs to make a mime-aware routing decision (inline
 * text body / pass URI to the adapter / drop). `contentHash` is the cache
 * key; daemon's `assetCache.getOrFetch(contentHash, …)` returns the local
 * file path.
 */
export interface AssetRef {
  assetId: string;
  /** sha256 hex — drives the daemon's local asset cache lookup. */
  contentHash: string;
  /** Asset mime type (e.g. `text/markdown`). May be null when upload omitted it. */
  mime: string | null;
  /** Byte length. May be null when upload omitted it. */
  sizeBytes: number | null;
  /** Row-level kind: `file`, `sandbox-output`, `image`, etc. */
  kind: string;
  /** Workspace ID — daemon passes this as `wsId` hint to the asset cache. */
  workspaceId: string;
  /**
   * Where this ref came from:
   *   - `attachment` → user attached it to the task or to a chat message
   *     (the asset content is part of the agent's context)
   *   - `context` → reserved for future use (e.g. references in agent memory)
   */
  role: 'attachment' | 'context';
  /**
   * Cloud-hosted URL for this asset, when known (IMAsset.cdnUrl). Adapters
   * prefer this for image/file blocks over a daemon-resolved cache copy. The
   * daemon's `resolveAssetRefs` also fills this from contentHash for assets
   * the cloud didn't stamp; carrying it cloud-side is load-bearing for
   * cross-turn image quote re-injection (release201/26 §13.4 P2) — the daemon
   * never saw the quoted message's attachment, so it cannot resolve the url on
   * its own.
   */
  cdnUrl?: string;
  /** Optional human-readable filename (IMAsset.metadata.title / source name). */
  filename?: string;
}

export interface TaskDispatchRequestPayload {
  taskId: string;
  /**
   * release202/09 §3.2 — structural run-vs-task signal.
   *   - `'run'`  → chat-dispatch run (`taskId` here mirrors the run id). The
   *     daemon injects `PRISMER_RUN_ID` (not `PRISMER_TASK_ID`); the platform
   *     closes the turn from the agent's reply — no `cloud task` op needed.
   *   - `'task'` → kanban task. The daemon injects `PRISMER_TASK_ID`.
   * Optional + forward-compatible: missing → daemon falls back to id-shape
   * (`run_` prefix) and then legacy probe-both. Promoted from the previous
   * `metadata.kind='agent_run'` signal.
   */
  kind?: 'run' | 'task';
  /**
   * The run id when `kind === 'run'`. Carried explicitly so the daemon never
   * has to treat the `taskId` field as a run id by convention.
   */
  runId?: string;
  /** Agent target for runtimeRoute='agent'. Shell dispatches do not use this. */
  agentImUserId?: string;
  /** Runtime/device target for runtimeRoute='shell'. */
  targetDaemonId?: string;
  profileId: string;
  capability: string;
  prompt: string;
  /** Execution surface. `shell` is daemon-local command execution. */
  runtimeRoute?: 'agent' | 'sandbox' | 'shell';
  metadata?: Record<string, unknown>;
  /** Default 30 minutes when omitted. */
  timeoutMs?: number;
  /** Recent group-chat messages, oldest first. Optional for non-mention dispatches. */
  context?: TaskDispatchContextEntry[];
  /** Set when this dispatch originated from a group-chat mention. */
  conversationId?: string;
  /**
   * Channel mode for the originating conversation.
   *   - `direct` → 1:1 DM. Single-hop auto-dispatch, reply is naturally
   *     directed at the only other party — no @-mention required.
   *   - `group` → multi-party room. Only explicit `@username` mentions
   *     dispatch. To continue a chain, the reply must end with
   *     `@<recipient>`.
   * Optional + forward-compatible: missing values render as 'unknown' in
   * the prompt (daemon side, appendChannelContext).
   */
  conversationType?: 'direct' | 'group';
  /**
   * Active participants of the dispatch's conversation. Daemon injects this
   * into [Channel context] so the agent knows the authoritative recipient list
   * without hallucinating or having to call `prismer.conversation.listAgents`. Capped at 50
   * entries server-side.
   */
  participants?: Array<{
    imUserId: string;
    username: string;
    displayName: string;
    role: string;
    agentType?: string | null;
  }>;
  /**
   * Wave-8 W1: assets the cloud wants the daemon to fold into the agent's
   * context. Daemon mime-splits these:
   *   - text-like (`text/*`, `application/json|xml`, +json/+xml/+csv) → inline
   *     body into instructions (truncate at 16 KiB if oversized).
   *   - other (image/*, application/pdf, etc.) → pass `file://<cachePath>` URI
   *     so the adapter's read/parse tool can pick it up.
   * Daemon must report back via `TaskDispatchReplyPayload.assetObservability`.
   */
  assetRefs?: AssetRef[];
  /**
   * release201/09 Phase 2 — task project scope. NULL = workspace-level
   * (`_unscoped` sentinel on disk). Daemon uses this together with
   * `agentImUserId` / `profile.workspaceId` to compose the per-task
   * scratch path: `workspaces/<wid>/projects/<pid|_unscoped>/tasks/<tid>/`.
   * Also forwarded into the spawned agent process as `PRISMER_ACTIVE_PROJECT_ID`
   * (when non-null) so built-in skill --project flag defaults work.
   */
  projectId?: string | null;
  /**
   * release201/30 §7 Phase 3 — propagated trace id (originated at frontend
   * via X-Prismer-Trace-Id, stamped onto task metadata by message.service /
   * task.service). Daemon prefixes stderr lines with `[trace=<id>]` so a
   * single grep ties cloud + daemon logs to the same user-facing action.
   *
   * Optional + forward-compatible: missing values cause daemon to mint a
   * `daemon-fallback-*` id local to the run so the prefix is always present.
   */
  traceId?: string;
  /**
   * release201/30 — username of the chat sender that triggered this dispatch.
   * Daemon uses this to label the <current_message author="..."> tag inside
   * the XML-wrapped conversation context sessions-style adapters send.
   *
   * Optional: when missing, daemon falls back to the recipient's own
   * username (still correct for single-author dispatch flows).
   */
  triggerSenderUsername?: string;
  /**
   * release201/30 — role of the trigger message sender. Mirrors
   * `TaskDispatchContextEntry.senderRole` vocabulary.
   */
  triggerSenderRole?: 'human' | 'agent' | 'admin' | 'system';
  /**
   * release201/25 §7 / release201/26 envelope refactor — typed L3 input
   * contract built cloud-side by `ConversationMemoryService.buildEnvelope`.
   *
   * Envelope-aware adapters consume via `renderContextEnvelope` (per-adapter
   * `context-render.ts` modules under `sdk/.../adapters/<name>/`). Legacy
   * fields above (`context`, `participants`, `triggerSenderUsername`,
   * `triggerSenderRole`) are intentionally still populated for one release
   * window so older daemons / adapters without envelope awareness keep
   * working — they read the flat fields, envelope-aware paths prefer this
   * one.
   *
   * Optional + forward-compatible: missing means the cloud build predates
   * the envelope wiring or the flag is off; daemon falls through to the
   * legacy XML composer / N-message path. See docs/release201/26 §7.
   */
  contextEnvelope?: ConversationContextEnvelope;
}

// ─── task.dispatch.progress (daemon → cloud) ─────────────────

/**
 * Throttling rules live on the daemon (not in protocol):
 * emit when ≥1s since last + (≥1% delta OR `message` changed).
 */
export interface TaskDispatchProgressPayload {
  taskId: string;
  /** 0..1 */
  progress: number;
  message?: string;
  detail?: Record<string, unknown>;
}

// ─── task.dispatch.reply (daemon → cloud) ────────────────────

/**
 * Cloud handler dispatches to taskService.completeTask (ok=true) or
 * failTask (ok=false). `requestId` matches the originating dispatch.request.
 */
/**
 * Wave-8 W1: per-asset record describing how the daemon handled the asset.
 * Cloud merges these into `task.metadata.observability.assets.strategies`
 * so e2e specs (and future UI) can see whether assets actually reached the
 * adapter or silently fell through.
 */
export type AssetDispatchStrategy =
  /** Full UTF-8 body inlined into instructions. */
  | 'inline-text'
  /** Body inlined but truncated at the daemon's safety cap (default 16 KiB). */
  | 'inline-text-truncated'
  /** Adapter received only `file://<cachePath>`; expected to read with its own tool. */
  | 'uri-only'
  /** Asset attempted but failed (download, decode, oversize, etc.). */
  | 'error';

export interface AssetDispatchObservation {
  assetId: string;
  contentHash: string;
  mime: string | null;
  sizeBytes: number | null;
  strategy: AssetDispatchStrategy;
  /** Bytes actually inlined for `inline-text*` (full body for `inline-text`, the cap for truncated). */
  inlinedBytes?: number;
  /** Populated when strategy === 'error'. */
  error?: string;
}

/**
 * P1-2 (2026-05-25): per-file outbox rejection record. Daemon's
 * `outbox-watcher` quarantines files whose magic bytes don't match the
 * file extension (e.g. agent writes `report.pdf` but the bytes are
 * markdown) and reports them here so cloud can persist + re-inject into
 * the next dispatch prompt.
 */
export interface OutboxRejectionRecord {
  filename: string;
  reason: string;
  inferredMime: string;
  detectedMime: string;
  rejectedAt: string;
}

export interface TaskDispatchReplyPayload {
  taskId: string;
  ok: boolean;
  output?: string;
  error?: { code: string; message: string };
  /** IDs of assets uploaded via POST /api/im/assets prior to reply. */
  assetIds?: string[];
  metrics?: { tokensUsed?: number; durationMs?: number };
  /** Wave-8 W1: how the daemon handled each `payload.assetRefs[i]`. */
  assetObservability?: AssetDispatchObservation[];
  /**
   * P1-2: files daemon's outbox-watcher rejected this turn for MIME ≠
   * extension. Cloud persists at `IMTask.metadata.outboxRejections` and
   * the next dispatch's prompt warns the agent up front.
   */
  outboxRejections?: OutboxRejectionRecord[];
}

// ─── task.dispatch.resume_failed (daemon → cloud) ────────────

/**
 * release201/26 §8 Phase 4 — daemon reports that an interrupted run could
 * NOT be resumed from its local checkpoint (kill -9 / crash / corrupt
 * checkpoint). Cloud writes `IMTaskRun.status='resume_failed'` and surfaces a
 * "任务中断，点击重试" strip in the conversation timeline so the human can
 * re-dispatch. Distinct from `task.dispatch.reply { ok:false }` (which is a
 * normal terminal failure with an agent reply) — resume_failed means the run
 * never got a chance to finish and there is no agent output.
 *
 * `runId` is the IMTaskRun.id (the daemon's local-run identity); `taskId` is
 * the wire-level IMTask.id when one exists (may equal runId for run-style
 * chat dispatches). Cloud resolves the run by `runId` first.
 */
export interface TaskDispatchResumeFailedPayload {
  runId: string;
  taskId?: string;
  reason?: string;
}

// ─── task.cancel (cloud → daemon) ────────────────────────────

/**
 * Daemon should signal/SIGINT the running adapter and reply with
 * task.dispatch.reply { ok: false, error: { code: 'task_cancelled' } }.
 */
export interface TaskCancelPayload {
  taskId: string;
  reason?: string;
}

// ─── Track A schema-derived broadcast events (m1 Day 3-4) ────
//
// Field names below are aligned with Track A's m1 Prisma models in
// `prisma/schema.prisma` (commit 30adb24 / 89c5dd4):
//   IMWorkspace        — id, ownerImUserId, name, slug, isDefault, updatedAt
//   IMAgentProfile     — id, workspaceId, agentImUserId, name, config, version
//   IMAgentCard        — imUserId, name, capabilities, status
//   IMWorkspaceFile    — id, workspaceId, path, assetId, version, deletedAt
//   IMAsset            — id, workspaceId, contentHash, storageUri
//
// Daemon handler contract (see 03-ws-protocol.md §`workspace.changed` /
// `agent_profile.changed`): on receipt, daemon issues a single
// `GET /api/im/<resource>/<id>` to refresh local SQLite mirror — the event
// itself only carries identifiers + a freshness hint, not the full record.

/**
 * Emitted when an IMWorkspace row is created or updated (e.g. PATCH name /
 * metadata).
 *
 * IMWorkspace has no numeric `version` column (unlike IMAgentProfile), so we
 * surface `updatedAt` as the freshness hint. Daemon compares against its
 * local mirror's `updatedAt` to decide whether to refetch.
 */
export interface WorkspaceChangedPayload {
  workspaceId: string;
  /** ISO-8601 timestamp from im_workspaces.updatedAt. */
  updatedAt: string;
}

/**
 * Emitted when an IMAgentProfile row is created or updated.
 * `version` increments on each update (optimistic-lock counter).
 */
export interface AgentProfileChangedPayload {
  profileId: string;
  version: number;
}

/**
 * Emitted by `PATCH /api/im/agents/:userId` on display-name change (and
 * future capability changes). `fields` carries only the changed columns —
 * absent keys mean "unchanged".
 *
 * Wire shape is locked-in: `src/im/api/agents.ts` (Track A m1) emits exactly
 * `{ agentImUserId, fields: { displayName } }`. The cast in that file goes
 * away once the matching string lands in `WSServerEventType` here.
 */
export interface AgentChangedPayload {
  agentImUserId: string;
  fields: {
    displayName?: string;
    /**
     * IM slug (IMUser.username). §30 B3.8 Q2 — inline rename UI on the agent
     * card can rewrite this; broadcast lets other tabs/devices refresh their
     * local cache without a full reload.
     */
    username?: string;
    capabilities?: string[];
  };
}

/**
 * Emitted by `POST /api/im/workspaces/:wsId/files` (create/update) and
 * `DELETE` (soft-delete via `deletedAt`).
 *
 * `assetId` + `contentHash` are required for create/update (file is bound to
 * an immutable blob), absent for delete. `version` mirrors
 * im_workspace_files.version (incremented per path rebind). `contentHash`
 * is denormalized from im_assets.contentHash via the file's assetId.
 */
export interface WorkspaceFileChangedPayload {
  workspaceId: string;
  path: string;
  operation: 'create' | 'update' | 'delete';
  assetId?: string;
  contentHash?: string;
  version: number;
}

/**
 * Emitted whenever an im_assets row is created, metadata-mutated, or
 * soft-deleted. Daemon treats this as a prompt to pull `/api/im/assets/index`
 * immediately, bypassing its periodic metadata throttle.
 */
export interface AssetChangedPayload {
  workspaceId: string;
  assetId: string;
  operation: 'create' | 'update' | 'delete';
  contentHash?: string;
  assetIndexSeq?: number;
  revision?: number;
}

// ─── approval.requested / approval.decided (ACP) ─────────────

export interface ApprovalRequestedPayload {
  approvalId: string;
  workspaceId: string;
  conversationId: string | null;
  taskId: string | null;
  requestedById: string;
  category: string;
  title: string;
  status: 'pending';
  createdAt: string;
  expiresAt: string | null;
}

export interface ApprovalDecidedPayload {
  approvalId: string;
  workspaceId: string;
  conversationId: string | null;
  taskId: string | null;
  requestedById: string;
  decidedById: string;
  status: 'approved' | 'rejected' | 'expired';
  selectedValue: string | null;
  decidedAt: string;
}

// ─── task.approval.resolve (cloud → daemon) ──────────────────
//
// release201/25 §16.4 A6 — cloud forwards a human approval decision to
// the daemon hosting the assignee agent so the daemon can additionally
// call hermes-native `POST /v1/runs/{runId}/approval` (api_server.py
// _handle_run_approval). Cloud-side approval-card persists / audits as
// before; this event is the SECOND write that keeps hermes-internal
// state (session-level "always" cache, pending timer) consistent with
// our redispatched task. Without it, choosing `session` or `always` on
// the card has no effect on hermes — only `once` and `deny` are honored
// via the redispatch path.
//
// daemon resolves runId by looking up the most recent run for `taskId`
// in `local_run_sessions` (registered when /v1/runs returned run_id, or
// when /api/sessions returned run_id mid-stream). If no row found
// (sessions API never started, or row was GC'd) the daemon logs and
// no-ops — the cloud-side redispatch still happens via the existing
// approval.decided path.
export interface TaskApprovalResolvePayload {
  taskId: string;
  approvalId: string;
  agentImUserId: string;
  /** Hermes-native choice. Maps to cloud-side ApprovalDTO.selectedValue. */
  choice: 'once' | 'session' | 'always' | 'deny';
  /** When true, hermes resolves every pending approval on the run, not just this one. */
  resolveAll: boolean;
}

// ─── workspace.clear.daemon-cleanup (cloud → daemon) ──────────
//
// release201/09 §9.4b (2026-05-30) — final step of WorkspaceClearError
// cascade. After cloud Prisma rows are gone, cloud fans out this event to
// every daemon that hosted any agent in the cleared workspace so each
// daemon wipes the local-only state cloud cannot see:
//   - ~/.hermes/profiles/<n>/memories/MEMORY.md + USER.md (the actual
//     contamination source from the 2026-05-30 incident)
//   - ~/.hermes/profiles/<n>/sessions/state.db (per-session goal state)
//   - ~/.hermes/profiles/<n>/SOUL.md (regenerated next spawn)
//   - ~/.prismer/devices/<did>/agents/<aid>/memory/* (agent-private memory)
// Skills/ stays intact — sha256-diff sync owns its lifecycle (§9.3.2).
//
// Wipe is best-effort; failures stderr-log but do not fail the cascade
// (cloud-side rows are already gone). Cascade ordering: cloud-first,
// daemon-second — guarantees cloud DB is consistent before daemon mutates
// local FS, so a partial wipe degrades to "stale orphan files" rather than
// "live profile pointing at dead cloud row".
export interface WorkspaceClearDaemonCleanupPayload {
  workspaceId: string;
  /** Agent IM-user IDs from the cleared workspace; daemon enumerates local
   * profiles matching these to find which on-disk profile names to wipe. */
  agentImUserIds: string[];
  /** ISO-8601 timestamp the cloud cascade completed. */
  clearedAt: string;
}
