/**
 * Prismer IM — v1.9.x WS protocol payload types (Track C)
 *
 * Adds 10 new ServerEvents types on top of the 1.8.2 baseline (`src/im/ws/events.ts`).
 * 9 daemon-protocol events + 1 workspace_file.changed (from 10-asset-network-drive.md §六).
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
 */

import type { AgentStatus } from './index';

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
}

// ─── host.acked (cloud → daemon, ACK reply) ──────────────────

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
   */
  attachedAssetIds?: string[];
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
}

export interface TaskDispatchRequestPayload {
  taskId: string;
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
