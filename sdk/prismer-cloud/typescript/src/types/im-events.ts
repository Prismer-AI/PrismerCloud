// MUST sync with sdk/prismer-cloud/runtime/src/types/im-events.ts
//
// Prismer SDK — IM WS protocol payload types (v2.0)
//
// Mirror of `src/im/types/im-events.ts` from the cloud package, kept in sync
// so that runtime/ws-client (Track B) and other SDK consumers compile against
// the same wire shapes the cloud handlers accept and emit.
//
// Source of truth chain:
//   src/im/types/im-events.ts  ─▶  this file  ─▶  sdk/.../runtime/types/im-events.ts
//
// There is no automatic generation; all three files are hand-maintained to
// avoid a build dependency between the cloud Next.js app and the SDK. v2.0's
// joint review (A1) caught that this file was missing six fields the runtime
// + cloud already emit (`runtimeRoute`, `targetDaemonId`, `conversationType`,
// `participants`, `attachedAssetIds`, `assetRefs`). Until v2.1 introduces a
// build-time check or makes the runtime depend on this SDK package, the
// manual sync banner above is what we have.
//
// AgentStatus enum is duplicated locally (not re-exported from cloud) because
// the SDK is shipped as an independent npm package with no dependency on the
// Next.js app.

/** Subset of the cloud-side AgentStatus enum used by status-change events. */
export type IMAgentStatus = 'online' | 'busy' | 'idle' | 'offline';

// ─── agent.host.declare (daemon → cloud) ─────────────────────

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

export interface RejectedHostedAgent {
  imUserId: string;
  reason: 'bound-to-other-daemon' | 'not-owned' | 'unknown';
  ownerDaemonId?: string;
}

export interface HostAckedPayload {
  workspaceId: string;
  syncCursor: {
    workspaces: number;
    agent_profiles: number;
    [key: string]: number;
  };
  profilesToSync: string[];
  /** Profile IDs the daemon declared but that no longer exist on the cloud
   *  (soft-deleted). The daemon should remove these from its local store. */
  profilesToDelete: string[];
  acceptedAgents?: string[];
  rejectedAgents?: RejectedHostedAgent[];
}

// ─── agent.status.changed (bidirectional) ────────────────────

export interface AgentStatusChangedPayload {
  agentImUserId: string;
  status: IMAgentStatus;
  activeProfileId?: string;
  runningTaskIds?: string[];
}

// ─── task.dispatch.request (cloud → daemon) ──────────────────

export interface TaskDispatchContextEntry {
  sender: string;
  senderRole: 'human' | 'agent' | 'admin' | 'system';
  content: string;
  createdAt: string;
  /** Wave-8 W1: assets the human attached to THIS chat message. */
  attachedAssetIds?: string[];
}

/** Wave-8 W1: hydrated asset reference attached to a dispatch. */
export interface AssetRef {
  assetId: string;
  contentHash: string;
  mime: string | null;
  sizeBytes: number | null;
  kind: string;
  workspaceId: string;
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
  timeoutMs?: number;
  context?: TaskDispatchContextEntry[];
  conversationId?: string;
  /**
   * Channel mode for the originating conversation. Optional and
   * forward-compatible: when missing, daemon renders 'unknown' in the
   * [Channel context] prompt block.
   *   - `direct`: 1:1 DM (no @-mention needed in reply).
   *   - `group`: multi-party room (end reply with `@<recipient>` to
   *     continue the chain).
   */
  conversationType?: 'direct' | 'group';
  /**
   * Active participants of the dispatch's conversation. Daemon injects this
   * into [Channel context] so the agent knows the authoritative recipient list
   * without hallucinating. Capped at 50 entries server-side.
   */
  participants?: Array<{
    imUserId: string;
    username: string;
    displayName: string;
    role: string;
    agentType?: string | null;
  }>;
  /** Wave-8 W1: assets cloud wants daemon to fold into agent context. */
  assetRefs?: AssetRef[];
}

// ─── task.dispatch.progress (daemon → cloud) ─────────────────

export interface TaskDispatchProgressPayload {
  taskId: string;
  progress: number;
  message?: string;
  detail?: Record<string, unknown>;
}

// ─── task.dispatch.reply (daemon → cloud) ────────────────────

/** Wave-8 W1: how the daemon handled a single AssetRef. */
export type AssetDispatchStrategy =
  | 'inline-text'
  | 'inline-text-truncated'
  | 'uri-only'
  | 'error';

export interface AssetDispatchObservation {
  assetId: string;
  contentHash: string;
  mime: string | null;
  sizeBytes: number | null;
  strategy: AssetDispatchStrategy;
  inlinedBytes?: number;
  error?: string;
}

/**
 * P1-2 (2026-05-25): per-file outbox rejection record emitted by daemon when
 * outbox-watcher quarantines an artifact (MIME ≠ filename extension). Cloud
 * persists these on `IMTask.metadata.outboxRejections` and re-injects into
 * the next dispatch prompt as agent-visible feedback.
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
  assetIds?: string[];
  metrics?: { tokensUsed?: number; durationMs?: number };
  /** Wave-8 W1: per-asset handling report. */
  assetObservability?: AssetDispatchObservation[];
  /**
   * P1-2: files quarantined by daemon outbox-watcher's magic-bytes guard
   * during this turn. Empty/absent when nothing was rejected.
   */
  outboxRejections?: OutboxRejectionRecord[];
}

// ─── task.cancel (cloud → daemon) ────────────────────────────

export interface TaskCancelPayload {
  taskId: string;
  reason?: string;
}

// ─── WS message envelope shape (matches cloud `WSMessage<T>`) ─

/**
 * Wire envelope for v2.0 WS events. `timestamp` is required (mirrors the
 * cloud-side `WSMessage<T>` definition in src/im/types/index.ts).
 */
export interface IMWSMessage<T = unknown> {
  type: string;
  payload: T;
  requestId?: string;
  timestamp: number;
}

// ─── Schema-derived broadcasts ───────────────────────────────

export interface WorkspaceChangedPayload {
  workspaceId: string;
  /** ISO-8601 timestamp from im_workspaces.updatedAt. */
  updatedAt: string;
}

export interface AgentProfileChangedPayload {
  profileId: string;
  version: number;
}

export interface AgentChangedPayload {
  agentImUserId: string;
  fields: {
    displayName?: string;
    capabilities?: string[];
  };
}

export interface WorkspaceFileChangedPayload {
  workspaceId: string;
  path: string;
  operation: 'create' | 'update' | 'delete';
  assetId?: string;
  contentHash?: string;
  version: number;
}

export interface AssetChangedPayload {
  workspaceId: string;
  assetId: string;
  operation: 'create' | 'update' | 'delete';
  contentHash?: string;
  assetIndexSeq?: number;
  revision?: number;
}
