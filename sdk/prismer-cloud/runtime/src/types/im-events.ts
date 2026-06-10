// MUST sync with sdk/prismer-cloud/typescript/src/types/im-events.ts
//
// MIRROR of `sdk/prismer-cloud/typescript/src/types/im-events.ts`.
//
// `@prismer/sdk` doesn't expose a `/types/im-events` subpath in its exports
// map, and `@prismer/runtime` is a standalone npm package (no workspace
// linking). Duplicating the wire types here is the simplest path; when the
// canonical mirror in the SDK changes (i.e. when the cloud-side
// `src/im/types/im-events.ts` changes), this file MUST be updated in lockstep.
//
// v2.0's joint review (A1) caught the SDK mirror lagging behind this file.
// Until v2.1 lets the runtime depend on the SDK (or vice versa), the manual
// sync banner above is what we have.
//
// Source of truth chain:
//   src/im/types/im-events.ts  ─▶  sdk/.../types/im-events.ts  ─▶  this file

// release201/25 §7 / release201/26 — typed L3 input contract mirror. Source
// of truth is `src/im/types/conversation-envelope.ts` on the cloud side;
// the daemon mirror in `./conversation-envelope.ts` MUST stay aligned.
import type { ConversationContextEnvelope } from './conversation-envelope.js';

export type IMAgentStatus = 'online' | 'busy' | 'idle' | 'offline';

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

export interface AgentStatusChangedPayload {
  agentImUserId: string;
  status: IMAgentStatus;
  activeProfileId?: string;
  runningTaskIds?: string[];
}

export interface TaskDispatchContextEntry {
  sender: string;
  senderRole: 'human' | 'agent' | 'admin' | 'system';
  content: string;
  createdAt: string;
  /** Wave-8 W1: assets the human attached to THIS chat message. */
  attachedAssetIds?: string[];
  /**
   * 2026-05-31 release201/30 §XML-context P0 — enriched metadata for the
   * assets attached to this message. Daemon renders each entry as
   * `<asset id mime filename size_bytes/>` inside a `<attached_assets>`
   * child of `<prior_message>` / `<current_message>` so the agent sees
   * prior-turn file attachments (PDF / image / etc.) instead of a blank
   * text body. Optional + forward-compat with older cloud builds (falls
   * back to id-only rendering from `attachedAssetIds`).
   */
  attachedAssets?: Array<{
    id: string;
    mime?: string;
    filename?: string;
    sizeBytes?: number;
  }>;
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
  /**
   * 14b rev.3 §3.0.4 — cloud-hosted URL for this asset, when present.
   * Adapters prefer this for image/file blocks (cheaper than base64) but
   * fall back to `base64` when the URL is not reachable by the upstream
   * LLM provider (D35 smart probing).
   */
  cdnUrl?: string;
  /**
   * Optional human-readable filename. Surfaced to adapters that want to
   * label `input_file` blocks (OpenClaw `/v1/responses`).
   */
  filename?: string;
}

/**
 * 14b rev.3 §3.0.4 / §9 P3 — what `resolveAssetRefs` hands to an adapter for
 * multimodal-aware dispatch. Extends AssetRef with:
 *  - `localPath` — daemon's local cache copy (still surfaced so file-based
 *     tools in legacy adapters keep working);
 *  - `base64` — populated when daemon decided cdnUrl was unreachable and
 *     inlined the bytes (D35 fallback);
 *  - `reachable` — cdnUrl reachability probe result for adapter introspection.
 */
export interface ResolvedAssetRef extends AssetRef {
  localPath?: string;
  base64?: string;
  reachable?: 'cdn' | 'base64' | 'unknown';
}

export interface TaskDispatchRequestPayload {
  taskId: string;
  /**
   * release202/09 §3.2 — structural run-vs-task signal.
   *   - `'run'`  → chat-dispatch run (`taskId` mirrors the run id). Daemon
   *     injects `PRISMER_RUN_ID` (not `PRISMER_TASK_ID`); the turn closes from
   *     the agent's reply — no `cloud task` op needed.
   *   - `'task'` → kanban task. Daemon injects `PRISMER_TASK_ID`.
   * Optional + forward-compatible: missing → daemon falls back to id-shape
   * (`run_` prefix) and then legacy probe-both.
   */
  kind?: 'run' | 'task';
  /** The run id when `kind === 'run'`. */
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
  timeoutMs?: number;
  context?: TaskDispatchContextEntry[];
  conversationId?: string;
  /**
   * release201/30 §7 — end-to-end trace id, originated by the frontend
   * (`X-Prismer-Trace-Id`) or generated by the cloud middleware when absent.
   * Daemon prefixes its stderr lines with `[trace=${traceId}]` so an
   * operator can grep one id across frontend → cloud → daemon. Optional and
   * forward-compatible: missing means the wire frame predates the field;
   * dispatch.ts falls back to `daemon-fallback-<rand>`.
   */
  traceId?: string;
  /**
   * Channel mode for the originating conversation. Optional and
   * forward-compatible: when missing, daemon renders 'unknown' in the
   * [Channel context] prompt block. See appendChannelContext in
   * daemon/dispatch.ts.
   *   - `direct`: 1:1 DM (no @-mention needed in reply).
   *   - `group`: multi-party room (end reply with `@<recipient>` to
   *     continue the chain).
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
  /** Wave-8 W1: assets cloud wants daemon to fold into agent context. */
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
   * release201/30 — username of the chat sender that triggered this dispatch.
   * Daemon uses this to label the <current_message author="..."> tag inside
   * the XML-wrapped conversation context the sessions-style adapters send.
   *
   * Optional: when missing, daemon falls back to the trigger row's own
   * username (typically the human owner), which is still correct for
   * single-author dispatch flows.
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
   * Envelope-aware adapters call `renderContextEnvelope` (per-adapter
   * module under `sdk/.../adapters/<name>/context-render.ts`) to turn this
   * into their native wire shape. Legacy fields above (`context`,
   * `participants`, `triggerSenderUsername`, `triggerSenderRole`) are still
   * populated for one release window so older adapters keep working.
   *
   * Optional + forward-compatible: missing means the cloud build predates
   * the wiring (or the flag is off); adapter falls back to the legacy XML
   * composer / N-message path.
   */
  contextEnvelope?: ConversationContextEnvelope;
}

export interface TaskDispatchProgressPayload {
  taskId: string;
  progress: number;
  message?: string;
  detail?: Record<string, unknown>;
}

/** Wave-8 W1: how the daemon handled a single AssetRef. */
export type AssetDispatchStrategy =
  | 'inline-text'
  | 'inline-text-truncated'
  | 'uri-only'
  | 'fetched-https'
  | 'error';

export interface AssetDispatchObservation {
  /** AssetRef.assetId for cloud-attached refs; undefined for L5 https fetches. */
  assetId?: string;
  contentHash: string;
  mime: string | null;
  sizeBytes: number | null;
  strategy: AssetDispatchStrategy;
  inlinedBytes?: number;
  error?: string;
  /** L5: original URL the user wrote in the prompt. */
  originalUrl?: string;
  /** L5: post-redirect URL the body was actually downloaded from. */
  finalUrl?: string;
  /** L5: end-to-end fetch duration in ms (DNS + connect + body read). */
  durationMs?: number;
}

/**
 * P1-2 (2026-05-25): per-file artifact rejection record. Surfaced when daemon's
 * `artifacts-watcher` rejects an artifact because its magic bytes don't match
 * the file extension (e.g. agent wrote `report.pdf` with markdown content).
 * Cloud persists these on `IMTask.metadata.outboxRejections` (wire field name
 * kept for the cross-process contract) and prepends a
 * warning section to the next dispatch prompt so the agent can self-correct.
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
   * P1-2 (2026-05-25): files quarantined locally by artifacts-watcher's
   * magic-bytes check during this turn. Cloud writes them onto
   * `IMTask.metadata.outboxRejections` so the next dispatch prompt can warn
   * the agent.
   */
  outboxRejections?: OutboxRejectionRecord[];
}

export interface TaskCancelPayload {
  taskId: string;
  reason?: string;
}

export interface IMWSMessage<T = unknown> {
  type: string;
  payload: T;
  requestId?: string;
  timestamp: number;
}

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

// ─── task.approval.resolve (cloud → daemon) ──────────────────
//
// release201/25 §16.4 A6 — cloud forwards the user's approval choice so
// the daemon can additionally call hermes-native /v1/runs/{id}/approval.
// See src/im/types/im-events.ts (cloud-side mirror) for the full
// rationale; this daemon copy is the wire-side type runner.ts consumes
// off the ws envelope.
export interface TaskApprovalResolvePayload {
  taskId: string;
  approvalId: string;
  agentImUserId: string;
  /** Hermes-native choice (api_server.py:3875 _handle_run_approval). */
  choice: 'once' | 'session' | 'always' | 'deny';
  /** True → hermes resolves every pending approval on the run, not just this one. */
  resolveAll: boolean;
}

// ─── task.clarify.resolve (cloud → daemon) ──────────
//
// release202 — cloud forwards the user's answer to a pending clarify
// question so the daemon can hit hermes-native /v1/runs/{id}/clarify and
// unblock the in-flight run (the daemon holds the dispatch stream open
// across the clarify block; resolving here resumes it in place — unlike
// approval, no re-dispatch is needed). Mirrors TaskApprovalResolvePayload
// but carries the free-form / chosen answer instead of an enum.
export interface TaskClarifyResolvePayload {
  taskId: string;
  agentImUserId: string;
  /** The user's answer (chosen option text or free-form). */
  response: string;
  /** clarify_id carried on the clarify.request progress event. */
  clarifyId: string;
  /** Optional run_id hint (daemon also resolves via run-session registry by taskId). */
  runId?: string;
}

// ─── workspace.clear.daemon-cleanup (cloud → daemon) ──────────
//
// release201/09 §9.4b (2026-05-30) — daemon-side mirror of the cloud event
// runner.ts consumes off the WS envelope. See the cloud copy in
// src/im/types/im-events.ts for the cascade rationale. Tl;dr: cloud rows
// gone first, daemon wipes ~/.hermes/profiles/<n>/memories/{MEMORY,USER}.md
// + sessions/state.db + SOUL.md + ~/.prismer/devices/<did>/agents/<aid>/memory/*
// for any local profile whose agentImUserId appears in the cleared list.
export interface WorkspaceClearDaemonCleanupPayload {
  workspaceId: string;
  agentImUserIds: string[];
  /** ISO-8601 timestamp the cloud cascade completed. */
  clearedAt: string;
}
