// MUST sync with sdk/cloud/src/types/im-events.ts
//
// MIRROR of `sdk/cloud/src/types/im-events.ts`.
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
import type { AssetRef } from './asset-ref.js';
import type { AgentDispatchReplyContentBlockInput } from './content-block.js';
export type { AssetRef } from './asset-ref.js';

export type IMAgentStatus = 'online' | 'busy' | 'idle' | 'offline';

/**
 * release203/08 WS-E (capability-exposure seam) — mirror of the cloud
 * `CodeAgentCapabilityFlags`. Carries the code-agent adapter's
 * `AgentCapabilityFlags` (Paseo) across the declare wire so cloud can
 * feature-gate UI. Only code-agent adapters set it; additive + optional.
 */
export interface CodeAgentCapabilityFlags {
  [capability: string]: boolean | undefined;
  supportsStreaming?: boolean;
  supportsSessionPersistence?: boolean;
  supportsSessionListing?: boolean;
  supportsDynamicModes?: boolean;
  supportsMcpServers?: boolean;
  supportsReasoningStream?: boolean;
  supportsToolInvocations?: boolean;
  supportsRewindConversation?: boolean;
  supportsRewindFiles?: boolean;
  supportsRewindBoth?: boolean;
}

export interface HostedAgentDeclaration {
  imUserId: string;
  name: string;
  adapterName: string;
  capabilities: string[];
  /** release203/08 WS-E — optional code-agent capability flags (additive). */
  capabilityFlags?: CodeAgentCapabilityFlags;
  profiles: Array<{ id: string; version: number }>;
}

export interface AgentHostDeclarePayload {
  daemonId: string;
  /** Optional explicit workspace for local daemons without an IMContainer row. */
  workspaceId?: string;
  daemonVersion: string;
  /**
   * product204/08 §2.3 step 4 (M9 收口) — the version of the runtime bundle
   * ACTUALLY executing this daemon: the OTA-applied bundle when the boot-time
   * resolver handed one out, else the image/npm builtin. Additive on the
   * wire; the cloud stamps it into agent-card metadata so the runtime-skew
   * probe's fleet distribution reads real running versions.
   */
  bundleVersion?: string;
  platform: 'darwin' | 'linux' | 'win32';
  agents: HostedAgentDeclaration[];
  /**
   * desktop204 D204-3 — human-readable device name (config `daemon_label`,
   * else OS hostname). Optional on the wire for backward compatibility, but
   * this daemon ALWAYS sends it: when absent the cloud falls back to guessing
   * from the daemonId string, which is wrong for any non-`daemon-*` id.
   */
  daemonLabel?: string;
  /**
   * desktop204 D204-3 — where this daemon runs. Optional on the wire (legacy
   * daemons omit it → cloud guesses from the daemonId prefix); this daemon
   * always sends it. Persisted to `im_agent_bindings.boundDaemonKind`.
   */
  daemonKind?: 'k8s' | 'local' | 'edge';
  /**
   * product209/16 §8.2/§13.1 — runtime capability claims (e.g.
   * `memory-authority-snapshot-v1`). Additive: legacy daemons omit the field
   * → cloud treats them as legacy (never guesses compatible). Mirror of the
   * cloud wire type (src/im/types/im-events.ts).
   */
  runtimeCapabilities?: string[];
}

/**
 * desktop204 D204-4 / desktop202 doc 14 §2.4 — graceful offline declare
 * (daemon → cloud). Sent on an intentional shutdown AFTER in-flight work is
 * drained and BEFORE the WS closes, so the cloud can mark this daemon's
 * bindings reclaimable immediately instead of waiting out the 3-minute
 * staleness window (during which every task dispatched to the device is a
 * black hole).
 *
 * The cloud REQUIRES `daemonId` to equal the daemonId declared on this same
 * WS connection (`WITHDRAW_DAEMON_MISMATCH` otherwise) — a daemon can only
 * withdraw itself.
 */
export interface AgentHostWithdrawPayload {
  daemonId: string;
  reason: 'user-quit' | 'app-uninstall' | 'transfer-out';
  /** false = in-flight work was aborted and handed back to the cloud to requeue. */
  inflightDrained: boolean;
}

export interface RejectedHostedAgent {
  imUserId: string;
  reason: 'bound-to-other-daemon' | 'not-owned' | 'capacity-exceeded' | 'unknown';
  ownerDaemonId?: string;
}

/**
 * product204 rebind-fix — mirrors the cloud-side type. An agent bound to THIS
 * daemon that it did NOT declare in the round this ACK answers. The daemon
 * must clear its in-memory ownership blacklist, re-sync the listed profiles,
 * and re-declare. See {@link HostAckedPayload.reclaimedAgents}.
 */
export interface ReclaimedAgent {
  imUserId: string;
  profileIds: string[];
}

/**
 * release203/19 #2 — cloud → daemon version-skew directive on `host.acked`.
 * Mirrors the cloud-side type. Present only when the cloud detected this
 * daemon is on a drifted build AND its skew policy is stronger than `warn`:
 *   - `warn`            — never sent (observability only).
 *   - `refuse_dispatch` — stop accepting NEW runs, stay up.
 *   - `drain_respawn`   — finish in-flight runs then exit so the device/k8s
 *                         controller re-pulls the new-image pod.
 * Backward compatible: a daemon that does not understand the field ignores it.
 */
export type DaemonUpgradeDirective = 'warn' | 'refuse_dispatch' | 'drain_respawn';

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
  /**
   * product204 rebind-fix — agents bound to THIS daemon that it did NOT
   * declare this round (blacklisted after a prior `bound-to-other-daemon`
   * rejection, then a rebind transferred ownership here). Daemon clears its
   * ownership blacklist, re-syncs the listed profiles, and re-declares.
   * Absent/empty ⇒ no action. Mirrors the cloud-side type.
   */
  reclaimedAgents?: ReclaimedAgent[];
  /**
   * product204/26 SA-2 — workspace agents this workspace-runtime daemon should
   * ADOPT: role='agent' cards in the daemon's workspace that have no binding
   * row at all (never hosted). Semantically identical to {@link reclaimedAgents}
   * (pull into local store + host + re-declare so cloud's auto-first-declare
   * builds a non-stale binding), differing only in provenance — reclaim is for
   * a rebind-blacklisted agent, adopt is for a server-instantiated agent that
   * has no push channel. Same shape; the daemon merges both into one adoption
   * pass. Absent/empty ⇒ no action. Mirrors the cloud-side type.
   */
  adoptAgents?: ReclaimedAgent[];
  /**
   * release203/19 #2 — version-skew directive. Absent ⇒ no action (common
   * case). See {@link DaemonUpgradeDirective}.
   */
  upgradeDirective?: DaemonUpgradeDirective;
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

/**
 * spec 11 T4-2 — hand-maintained mirror of the cloud canon
 * (`src/im/types/im-events.ts`). The field-NAME set (incl. `?`; field TYPES
 * are NOT in the nail's scope) MUST match canon; the one named exception is
 * the runtime-only `projectId?` below (cloud retired the project dimension —
 * see its field comment). Drift is nailed by
 * `scripts/__tests__/dispatch-wire-mirror-parity.test.ts` (T0 CI tier).
 */
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
  /**
   * release203/06 §3.7 (block 1) — repo-scoped code-agent workdir.
   *
   * Populated by cloud (RS-3) ONLY for dispatches whose target adapter is a
   * code agent (codex / claude-code) and whose conversation/task is bound to a
   * persistent repo. The daemon (RS-2) consumes it: for those adapters it
   * materializes the folder (`ensureWorkdir`) and points the adapter cwd at
   * `cwd` (persistent) instead of the per-task scratch dir, so codex thread
   * resume / claude-code `.claude/projects` session resume + the repo files all
   * survive across turns.
   *
   * Optional + forward-compatible: missing → daemon keeps the legacy per-task
   * scratch behavior (correct for conversational adapters + one-shot tasks).
   *   - `id`        — stable cloud-side workdir row id (observability only).
   *   - `cwd`       — absolute persistent path on the daemon host/container.
   *   - `source`    — how to bring `cwd` into existence (clone / init / pick).
   *   - `sourceRef` — clone URL when `source==='clone'` (ignored otherwise).
   */
  workdir?: {
    id: string;
    cwd: string;
    source: 'clone' | 'init' | 'host-pick' | 'container-pick';
    sourceRef?: string;
  };
  /**
   * release203/11 §2.2 (Slice A) — canonical IDENTITY/USER/scope context,
   * composed CLOUD-side (only cloud knows displayName / peer names / workspace+
   * project names) and merged DAEMON-side into each adapter's native identity
   * slot. Fixes the "who are you?" regression: a净身 coding agent has an empty
   * `config.systemPrompt`, so without this it answers as generic Claude.
   *
   * Each line is a short pre-rendered string; daemon decides the render order.
   * Empty strings mean "unknown" and are filtered out daemon-side.
   *   - identity: "You are {displayName} (@{username}), a {coding|persistence} agent."
   *   - user:     "You are in a {direct|group} conversation with {peers}."
   *   - scope:    "Workspace: {wsName} · Project: {projName|none}"
   *
   * Optional + forward-compatible + purely additive: missing → daemon falls
   * back to the persona / coding SOUL default alone. Mirror of the cloud wire
   * type (`src/im/types/im-events.ts`).
   */
  identityContext?: {
    identity: string;
    user: string;
    scope: string;
    /**
     * product204/07 Phase C — identityContext 分段注册制 (D6). Named sections
     * composed cloud-side; the daemon renders them in ascending `order` AFTER
     * the legacy identity/user/scope triple, joined with '\n\n', into the same
     * native identity slot per adapter. Unknown/extra fields on a section are
     * ignored (version-skew safe); the field itself is optional + additive —
     * old clouds simply never send it. Mirror of the cloud wire type
     * (`src/im/types/im-events.ts`).
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
 * does no templating, only order-sort + trim + join.
 */
export interface IdentitySection {
  /** kebab-case, globally unique ('platform-directives' | 'config-directives' | 'per-turn-voice' | 'org-collaboration' | …). */
  id: string;
  /**
   * Owning doc number ('07' | '09' | '03' | 'product205/12' | 'bugfix211/B' |
   * 'organization/04') — kept loose (cloud side is a closed union; this mirror
   * stays `string` so an old daemon never rejects a section added later).
   */
  owner: string;
  /** Render position; daemon stable-sorts ascending before joining. */
  order: number;
  /** Pre-rendered plain-text section (leads with its own `## ` heading). */
  content: string;
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

/**
 * desktop202/19 §4 L1 — structured LLM routing snapshot the daemon attaches to
 * a dispatch reply so cloud can stamp it onto the reply message's
 * `metadata.llmMetadata` and the UI can render the routing chip. Every field
 * optional; cloud/UI render only what is present (additive, zero-regression).
 *
 * What the daemon may reliably know from the adapter's terminal response:
 *   - `modelUsed` / `providerUsed` / `chainId`
 * Configured profile values are routing intent and must never be projected as
 * evidence of what actually served the turn.
 *
 * What the daemon does NOT fill (decided per-call inside the cloud llm-proxy,
 * which the daemon never sees — agents own their HTTP to the gateway):
 *   - `fallbackReason`  (static/chain fallback fired in the proxy)
 *   - `visionFiltered`  (proxy dropped image parts for a text-only routed model)
 * desktop202/20 fills these CLOUD-side instead: codex/opencode forward the
 * dispatch run id (`x-prismer-task-run-id`), the proxy records the outcome to a
 * shared Redis store keyed by that id, and the reply handler merges it onto
 * `metadata.llmMetadata`. They stay undefined for claude-code (Anthropic proxy
 * has no chain-fallback/vision concept) and hermes (no per-run header key) —
 * documented limitations, not gaps. See docs/desktop202/20.
 */
export interface LlmRoutingMetadata {
  modelUsed?: string;
  providerUsed?: string;
  chainId?: string;
  fallbackReason?: string;
  visionFiltered?: boolean;
}

/**
 * product209 Phase 1 — authoritative Memory durability result frozen before
 * the terminal dispatch reply is emitted.  This is deliberately a structured
 * wire receipt: prose such as "saved to memory" is never evidence.
 */
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
  /**
   * Structured rich reply blocks extracted by the daemon from the adapter's
   * final output. `output` remains the readable Markdown projection for old
   * clients; cloud persists both on the same IMMessage.
   */
  contentBlocks?: AgentDispatchReplyContentBlockInput[];
  error?: { code: string; message: string };
  assetIds?: string[];
  metrics?: { tokensUsed?: number; durationMs?: number };
  /**
   * desktop202/19 §4 L1 — model/provider/chain that served this reply. Daemon
   * fills model/provider/chain from the resolved profile; fallbackReason /
   * visionFiltered are filled CLOUD-side by the llm-proxy routing store and
   * merged in the reply handler (desktop202/20), not by the daemon. Absent →
   * cloud writes no `metadata.llmMetadata` and the UI chip stays absent
   * (back-compat). See LlmRoutingMetadata.
   */
  llmMetadata?: LlmRoutingMetadata;
  /** Wave-8 W1: per-asset handling report. */
  assetObservability?: AssetDispatchObservation[];
  /**
   * P1-2 (2026-05-25): files quarantined locally by artifacts-watcher's
   * magic-bytes check during this turn. Cloud writes them onto
   * `IMTask.metadata.outboxRejections` so the next dispatch prompt can warn
   * the agent.
   */
  outboxRejections?: OutboxRejectionRecord[];
  /** product209 Phase 1: bounded pre-reply authoritative Memory outcome. */
  durability?: TaskDurabilityResult;
  /** S6/M1 — 1-based position in this turn's reply stream; present on every frame of a multi-frame turn. */
  seq?: number;
  /** S6/M1 — false = interim commentary frame (I1 shape); true/absent = terminal frame. */
  final?: boolean;
}

export interface TaskCancelPayload {
  taskId: string;
  reason?: string;
}

// ─── product209/18 Part B — 附件物化（cloud → daemon，两段式上传进度）───────
//
// Cloud 在上传完成后推 `asset.materialize.request`，daemon 拉字节入本地
// asset-cache（幂等，内容寻址），成功/失败都回 `asset.materialize.reply`。
// requestId = assetId（幂等关联）。设计 doc: docs/product209/18。
export interface AssetMaterializeRequestPayload {
  assetId: string;
  contentHash: string;
  workspaceId: string;
}

// ─── product204/36 two-phase OTA (cloud → daemon, user-clicked apply) ───────
//
// Phase 1 = a release is staged cloud-side (im_runtime_releases canary/ga) and
// surfaced in the workspace UI. Phase 2 = the user clicks apply: cloud sends
// `runtime.update.apply` to the bound daemon, which acks with
// `runtime.update.reply` and arms the EXISTING drain_respawn machinery
// (release203/19 #2): reject new dispatches → drain in-flight runs → graceful
// stop + exit(0) → the supervisor (k8s restartPolicy / desktop shell) respawns
// → boot-time OTA applies the staged bundle. The daemon never downloads
// in-band here; apply == drain + respawn, keeping boot-time OTA the single
// swap mechanism.

export interface RuntimeUpdateApplyPayload {
  /** Version the cloud believes it is offering (informational; boot OTA re-resolves). */
  targetVersion?: string;
  /** imUserId of the workspace member who clicked apply (audit trail). */
  requestedBy?: string;
  /** Ordinary forward OTA or an explicitly-authorized lower target. */
  decision?: 'ota' | 'rollback';
}

export interface RuntimeUpdateReplyPayload {
  daemonId: string;
  /** False when the target is stale, missing, or has an invalid direction. */
  accepted: boolean;
  /** Runs in flight at accept time; 0 ⇒ respawn is imminent. */
  inFlight: number;
  /** The version currently executing (so cloud/UI can show from → to). */
  currentVersion: string;
  targetVersion?: string;
  decision?: 'ota' | 'rollback';
  reason?: 'target_missing' | 'up_to_date' | 'downgrade_not_authorized' | 'rollback_direction_invalid' | 'version_unparseable';
}

// ─── release203/08 WS-E control frames (cloud → daemon, WsRpc-correlated) ───
//
// Out-of-band control of a LIVE code-agent session. Cloud resolves the owning
// daemon (same boundDaemonId path as task.cancel) and forwards over the WsRpc
// channel; the daemon looks up the live AdapterService for the target agent
// (servicePool, same as dispatch) and calls setModel / listCommands / revert.
// Each carries `_rpcId` (injected by WsRpcService.invoke) and is answered with
// an `agent.session.reply { _rpcId, ok, data?, error? }` frame.
//
// INTERRUPT is covered by task.cancel (→ session.interrupt(), turn-scoped);
// no separate interrupt frame.

export interface AgentSessionSetModelPayload {
  taskId: string;
  agentImUserId: string;
  modelId: string;
  _rpcId?: string;
}

export interface AgentSessionListCommandsPayload {
  taskId: string;
  agentImUserId: string;
  _rpcId?: string;
}

export interface AgentSessionRewindPayload {
  taskId: string;
  agentImUserId: string;
  messageId: string;
  scope?: 'conversation' | 'files' | 'both';
  _rpcId?: string;
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
    /** IM slug (IMUser.username) — PATCH /agents/:id carries it; the daemon
     *  does not persist it (the local `agents` table has no username column). */
    username?: string;
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
