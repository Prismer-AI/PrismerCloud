// MUST sync with sdk/prismer/src/types/im-events.ts
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
// T-P0-6 (spec 11 T3-2) — second drift, caught by `runtime210/06` §T-P0-6 and
// closed here: `TaskDispatchRequestPayload` had fallen 9 fields behind the
// cloud/a runtime (`kind`, `runId`, `traceId`, `triggerSenderUsername`,
// `triggerSenderRole`, `contextEnvelope`, `workdir`, `identityContext`,
// `interimReply`), `TaskDispatchContextEntry` was missing `attachedAssets`,
// `AssetRef` was missing `cdnUrl` / `filename`, and `IdentitySection` +
// `ConversationContextEnvelope` were absent entirely (now mirrored in
// `./conversation-envelope.ts` + the `./asset-ref.ts` leaf). The compile-time
// `Equal<CloudReq, SDKReq>` assertion in
// `scripts/contract-tests/task-dispatch-context-window.spec.ts` only becomes
// TRUE with this sync — it had been a false green because the spec runs under
// `tsx`, which does not type-check.
//
// AgentStatus enum is duplicated locally (not re-exported from cloud) because
// the SDK is shipped as an independent npm package with no dependency on the
// Next.js app.

import type { AssetRef } from './asset-ref';
import type { ConversationContextEnvelope } from './conversation-envelope';

// `AssetRef` is a shared leaf wire type (the envelope imports it too). It is
// re-exported here so existing `from './types/im-events'` consumers keep
// compiling unchanged — mirrors src/im/types/im-events.ts:39-40.
export type { AssetRef } from './asset-ref';

/** Local mirror of `../types.ts` ContentBlockInput to keep this wire leaf acyclic. */
export type DispatchContentBlockText = { kind: 'text'; text: string };
export type DispatchContentBlockImage = { kind: 'image'; assetId: string; mediaType: string; alt?: string };
export type DispatchContentBlockAudio = { kind: 'audio'; assetId: string; mediaType: string; durationMs?: number };
export type DispatchContentBlockVideo = {
  kind: 'video';
  assetId: string;
  mediaType: string;
  durationMs?: number;
  thumbnailUrl?: string;
};
export type DispatchContentBlockFile = { kind: 'file'; assetId: string; mediaType: string; filename: string };
export type DispatchContentBlockToolUse = {
  kind: 'tool_use';
  toolCallId: string;
  toolName: string;
  inputJson: unknown;
};
export type DispatchContentBlockReasoning = { kind: 'reasoning'; text: string; redacted?: boolean };
export type DispatchContentBlockPkfInput = { kind: 'pkf'; source: string; title?: string };
export type DispatchContentBlockToolResultInput = {
  kind: 'tool_result';
  toolCallId: string;
  output: DispatchContentBlockInput[];
};
export type DispatchContentBlockInput =
  | DispatchContentBlockText
  | DispatchContentBlockImage
  | DispatchContentBlockAudio
  | DispatchContentBlockVideo
  | DispatchContentBlockFile
  | DispatchContentBlockToolUse
  | DispatchContentBlockToolResultInput
  | DispatchContentBlockReasoning
  | DispatchContentBlockPkfInput;

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
  /** Optional explicit workspace for local daemons without an IMContainer row. */
  workspaceId?: string;
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
  /** Wave-8 W1: hydrated metadata for the same attachments. */
  attachedAssets?: Array<{
    id: string;
    mime?: string;
    filename?: string;
    sizeBytes?: number;
  }>;
}

/**
 * spec 11 T4-2 — hand-maintained mirror of the cloud canon
 * (`src/im/types/im-events.ts`), which is the source of truth for this
 * dispatch face. The field-NAME set (incl. `?`; field TYPES are NOT in the
 * nail's scope) MUST match canon — no exceptions on this side. Drift is
 * nailed by `scripts/__tests__/dispatch-wire-mirror-parity.test.ts` (T0 CI
 * tier) and by the CI-wirable `scripts/check-envelope-mirror.ts`.
 */
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
  /**
   * release203/06 §3.7 (block 1) / release203/09 §7.3 — repo-scoped code-agent
   * workdir. Populated by cloud (TaskService.resolveDispatchWorkdir) ONLY for
   * dispatches whose target adapter is a code agent (claude-code / codex /
   * opencode) AND whose conversation or agent profile is bound to a persistent
   * IMWorkdir. The daemon consumes it: for those adapters it materializes the
   * folder (`ensureWorkdir`, re-clones on ephemeral pods) and points the
   * adapter cwd at `cwd` (persistent) instead of the per-task scratch dir, so
   * codex thread resume / claude-code session resume + the repo files survive
   * across turns.
   *
   * Optional + forward-compatible + purely additive: missing → daemon keeps the
   * legacy per-task scratch behavior. Mirror of the SDK runtime wire type
   * (`sdk/prismer/src/types/im-events.ts`).
   */
  workdir?: {
    id: string;
    cwd: string;
    source: 'clone' | 'init' | 'host-pick' | 'container-pick';
    sourceRef?: string;
  };
  /**
   * release203/11 §2.2 (Slice A) — canonical IDENTITY/USER/scope context,
   * composed CLOUD-side (only cloud knows the displayName / peer names /
   * workspace+project names) and merged DAEMON-side into each adapter's native
   * identity slot. Fixes the "who are you?" regression: a净身 coding agent has
   * an empty `config.systemPrompt`, so without this it answers as generic
   * Claude. Each line is a short pre-rendered string; daemon decides the final
   * render order. Empty/omitted lines mean "unknown" and are dropped daemon-side.
   */
  identityContext?: {
    identity: string;
    user: string;
    scope: string;
    /**
     * product204/07 Phase C — identityContext 分段注册制 (D6). Named sections
     * composed cloud-side by a compile-time provider table (see
     * task.service.ts::IDENTITY_SECTION_PROVIDERS) and rendered daemon-side in
     * ascending `order` AFTER the legacy identity/user/scope triple (the
     * triple is semantically the implicit order-10 section and stays as-is
     * for old-daemon compat). Purely additive: old daemons ignore the field
     * (version-skew safe); absent → wire frame byte-identical to before.
     *
     * Fixed order table (07 Phase C 落点设计): 15 fact-discipline (product205/12) ·
     * 16 org-collaboration (organization/04) · 18 deputy-binding (bugfix211/B) ·
     * 20 platform-directives (07) · 30 config-directives (09, reserved) ·
     * 40 per-turn-voice (03, reserved).
     *
     * D6 red line: this is per-dispatch dynamic envelope injection ONLY —
     * never persisted to AGENTS.md / SOUL.md / any file.
     */
    sections?: IdentitySection[];
  };
  /**
   * S6/M1 — capability bit. Only a cloud that understands multi-frame replies
   * sets this (chat agent-run dispatches). Legacy clouds never carry it, so the
   * daemon must never send interim frames on their behalf — "legacy cloud only
   * ever sees the final frame" is carried by THIS field, not by the frames.
   */
  interimReply?: boolean;
}

/**
 * product204/07 Phase C — one named identityContext section. `content` is a
 * cloud-rendered plain-text block carrying its own `## ` heading; the daemon
 * does no templating, only order-sort + trim + join. Mirror of the SDK
 * runtime wire type (`sdk/prismer/src/types/im-events.ts`).
 */
export interface IdentitySection {
  /** kebab-case, globally unique ('platform-directives' | 'config-directives' | 'per-turn-voice' | 'org-collaboration' | …). */
  id: string;
  /** Owning design doc / section that introduced the section. */
  owner: '07' | '09' | '03' | 'product205/12' | 'bugfix211/B' | 'organization/04';
  /** Render order; ascending. The legacy identity/user/scope triple is the implicit 10. */
  order: number;
  /** Cloud-rendered block (own `## ` heading included). Trimmed before render. */
  content: string;
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

export interface TaskDurabilityPageReceipt {
  pageId: string;
  path: string;
  version: number;
  contentHash: string;
  authority?: 'cloud' | 'outbox';
  authorityEventId?: string;
}

export interface TaskDurabilityResult {
  commitKey: string;
  postTurnKey: string;
  canonicalTurnId: string;
  conversationId?: string;
  runId?: string;
  messageId?: string;
  profileId?: string;
  profileName?: string;
  model?: string;
  provider?: string;
  targetPageKey?: string;
  normalizedContentHash?: string;
  state:
    | 'persisted'
    | 'skipped_not_durable'
    | 'skipped_duplicate'
    | 'retryable_failure'
    | 'terminal_failure';
  receipts: TaskDurabilityPageReceipt[];
  error?: { code: string; message: string };
  timeoutMs: number;
  replyCommittedAt: number;
  duplicateOf?: {
    state: 'persisted' | 'skipped_not_durable' | 'retryable_failure' | 'terminal_failure';
    receipts: TaskDurabilityPageReceipt[];
    replyCommittedAt: number;
  };
}

export interface TaskDispatchReplyPayload {
  taskId: string;
  ok: boolean;
  output?: string;
  /** Markdown projection remains in output; rich PKF rides beside it. */
  contentBlocks?: DispatchContentBlockInput[];
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
  /** PKF 209 Phase 1: bounded pre-reply authoritative Memory outcome. */
  durability?: TaskDurabilityResult;
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
