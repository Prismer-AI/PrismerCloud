/**
 * Prismer IM — WebSocket event definitions
 *
 * Typed event builders for both client→server and server→client messages.
 */

import type {
  WSMessage,
  AssetAttachment,
  WSClientEventType,
  WSServerEventType,
  MessageType,
  MessageMetadata,
  PresenceStatus,
  AgentStatus,
  AgentCapability,
  // v1.9.x daemon protocol payloads (Track C)
  AgentHostDeclarePayload,
  HostAckedPayload,
  AgentStatusChangedPayload,
  TaskDispatchRequestPayload,
  TaskDispatchProgressPayload,
  TaskDispatchReplyPayload,
  TaskCancelPayload,
  // v1.9.x schema-derived broadcasts (Track C, schema from Track A)
  AgentChangedPayload,
  WorkspaceChangedPayload,
  AgentProfileChangedPayload,
  WorkspaceFileChangedPayload,
  AssetChangedPayload,
  ApprovalRequestedPayload,
  ApprovalDecidedPayload,
  TaskApprovalResolvePayload,
  WorkspaceClearDaemonCleanupPayload,
} from '../types/index';

// ─── Helpers ─────────────────────────────────────────────────

function makeEvent<T>(type: WSServerEventType, payload: T, requestId?: string): WSMessage<T> {
  return { type, payload, requestId, timestamp: Date.now() };
}

// ─── Server → Client events ─────────────────────────────────

export const ServerEvents = {
  authenticated(userId: string, requestId?: string) {
    return makeEvent('authenticated', { userId }, requestId);
  },

  error(message: string, code?: string, requestId?: string) {
    return makeEvent('error', { message, code }, requestId);
  },

  messageNew(msg: {
    id: string;
    conversationId: string;
    senderId: string;
    type: MessageType;
    content: string;
    metadata: MessageMetadata;
    attachments?: AssetAttachment[] | null;
    parentId?: string;
    createdAt: string;
  }) {
    return makeEvent('message.new', msg);
  },

  messageUpdated(msg: {
    id: string;
    conversationId: string;
    content?: string;
    metadata?: MessageMetadata;
    status?: string;
    // release202/09 P5#3 (A2) — attach-to-existing-message rides this event so
    // the client patches the new attachment in-place (im-channel.tsx handles
    // `message.updated` identically to `message.edit`).
    type?: MessageType;
    attachments?: AssetAttachment[] | null;
  }) {
    return makeEvent('message.updated', msg);
  },

  messageEdit(msg: {
    id: string;
    conversationId: string;
    content: string;
    type: string;
    editedAt: string;
    editedBy: string;
    metadata?: MessageMetadata;
  }) {
    return makeEvent('message.edit', msg);
  },

  /** v1.8.2: Reaction add/remove on a message. Distinct from message.edit (which signals content change). */
  messageReaction(data: {
    messageId: string;
    conversationId: string;
    emoji: string;
    userId: string;
    action: 'add' | 'remove';
    /** Full reaction state after the change: { emoji: [userId, ...] } */
    reactions: Record<string, string[]>;
  }) {
    return makeEvent('message.reaction', data);
  },

  messageDelivered(data: { conversationId: string; messageIds: string[]; deliveredBy: string; deliveredAt: string }) {
    return makeEvent('message.delivered', data);
  },

  messageRead(data: { conversationId: string; readBy: string; readAt: string; lastReadMessageId?: string }) {
    return makeEvent('message.read', data);
  },

  messageDeleted(data: { id: string; conversationId: string }) {
    return makeEvent('message.deleted', data);
  },

  streamChunk(data: { streamId: string; conversationId: string; senderId: string; chunk: string; index: number }) {
    return makeEvent('message.stream.chunk', data);
  },

  streamEnd(data: { streamId: string; conversationId: string; messageId: string; finalContent: string }) {
    return makeEvent('message.stream.end', data);
  },

  typingIndicator(data: { conversationId: string; userId: string; isTyping: boolean }) {
    return makeEvent('typing.indicator', data);
  },

  presenceChanged(data: { userId: string; status: PresenceStatus; lastSeen: number }) {
    return makeEvent('presence.changed', data);
  },

  conversationUpdated(data: { id: string; title?: string; status?: string }) {
    return makeEvent('conversation.updated', data);
  },

  participantJoined(data: { conversationId: string; userId: string; role: string }) {
    return makeEvent('participant.joined', data);
  },

  participantLeft(data: { conversationId: string; userId: string }) {
    return makeEvent('participant.left', data);
  },

  agentRegistered(data: { agentId: string; name: string; capabilities: AgentCapability[] }) {
    return makeEvent('agent.registered', data);
  },

  agentStatus(data: { agentId: string; status: AgentStatus; load?: number }) {
    return makeEvent('agent.status', data);
  },

  contactRequest(data: {
    requestId: string;
    fromUserId: string;
    toUserId: string;
    fromUsername?: string;
    fromDisplayName?: string;
    reason?: string;
    source?: string;
  }) {
    return makeEvent('contact.request', { ...data, createdAt: new Date().toISOString() });
  },

  contactAccepted(data: {
    fromUserId: string;
    toUserId: string;
    conversationId: string;
    username?: string;
    displayName?: string;
  }) {
    return makeEvent('contact.accepted', { ...data, acceptedAt: new Date().toISOString() });
  },

  contactRejected(data: { fromUserId: string; toUserId: string; requestId: string }) {
    return makeEvent('contact.rejected', { ...data, rejectedAt: new Date().toISOString() });
  },

  contactCancelled(data: { fromUserId: string; toUserId: string; requestId: string }) {
    return makeEvent('contact.cancelled', { ...data, cancelledAt: new Date().toISOString() });
  },

  contactRemoved(data: { userId: string; removedUserId: string }) {
    return makeEvent('contact.removed', { ...data, removedAt: new Date().toISOString() });
  },

  contactBlocked(data: { userId: string; blockedUserId: string }) {
    return makeEvent('contact.blocked', { ...data, blockedAt: new Date().toISOString() });
  },

  /** Someone replied to your community post */
  communityReply(data: { postId: string; postTitle: string; commentId: string; actorId: string }) {
    return makeEvent('community.reply', data);
  },

  /** Someone upvoted your post or comment */
  communityVote(data: {
    targetType: 'post' | 'comment';
    targetId: string;
    postId: string;
    postTitle: string;
    actorId: string;
    value: 1 | -1;
  }) {
    return makeEvent('community.vote', data);
  },

  /** Your comment was marked best answer */
  communityAnswerAccepted(data: { postId: string; postTitle: string; commentId: string; actorId: string }) {
    return makeEvent('community.answer.accepted', data);
  },

  /** Reserved: @mention in community content */
  communityMention(data: { postId?: string; commentId?: string; actorId: string; snippet: string }) {
    return makeEvent('community.mention', data);
  },

  reconnectAck(data: { userId: string; undeliveredCount: number; syncAdvised: boolean }, requestId?: string) {
    return makeEvent('reconnect.ack', data, requestId);
  },

  pong(requestId?: string) {
    return makeEvent('pong', {}, requestId);
  },

  // ─── v1.9.x daemon protocol (Track C) ────────────────────

  /** ACK reply to `agent.host.declare`. requestId echoes the originating declare. */
  hostAcked(data: HostAckedPayload, requestId?: string): WSMessage<HostAckedPayload> {
    return makeEvent('host.acked', data, requestId);
  },

  /**
   * Cloud → daemon: dispatch a task to be executed.
   * Agent work is sent via `rooms.sendToUser(agentImUserId, ...)`. Runtime
   * shell work is sent via `rooms.sendToUser("daemon:<daemonId>", ...)`.
   * requestId is required so the daemon's `task.dispatch.reply` can be
   * correlated.
   */
  taskDispatchRequest(data: TaskDispatchRequestPayload, requestId: string): WSMessage<TaskDispatchRequestPayload> {
    return makeEvent('task.dispatch.request', data, requestId);
  },

  /** Cloud → daemon: cancel a running task. */
  taskCancel(data: TaskCancelPayload): WSMessage<TaskCancelPayload> {
    return makeEvent('task.cancel', data);
  },

  approvalRequested(data: ApprovalRequestedPayload): WSMessage<ApprovalRequestedPayload> {
    return makeEvent('approval.requested', data);
  },

  approvalDecided(data: ApprovalDecidedPayload): WSMessage<ApprovalDecidedPayload> {
    return makeEvent('approval.decided', data);
  },

  /**
   * Cloud → daemon: forward the user's approval choice so daemon can
   * additionally call hermes-native POST /v1/runs/{runId}/approval and
   * keep hermes-internal state in sync with the cloud-side decision.
   * See release201/25 §16.4 A6 + TaskApprovalResolvePayload comment for
   * the rationale.
   */
  taskApprovalResolve(data: TaskApprovalResolvePayload): WSMessage<TaskApprovalResolvePayload> {
    return makeEvent('task.approval.resolve', data);
  },

  /**
   * Cloud → daemon: final step of workspace clear cascade. After cloud
   * Prisma rows are gone, cloud fans out to every daemon that hosted any
   * agent in the cleared workspace so each daemon wipes the local hermes
   * profile memories + per-agent memory dir (release201/09 §9.4b).
   */
  workspaceClearDaemonCleanup(
    data: WorkspaceClearDaemonCleanupPayload,
  ): WSMessage<WorkspaceClearDaemonCleanupPayload> {
    return makeEvent('workspace.clear.daemon-cleanup', data);
  },

  /**
   * Cloud → user: agent status change broadcast.
   * Sent after the cloud handler writes im_agent_cards.status, so other WS
   * connections of the same human owner (mobile, web) update their UI.
   */
  agentStatusChanged(data: AgentStatusChangedPayload): WSMessage<AgentStatusChangedPayload> {
    return makeEvent('agent.status.changed', data);
  },

  // ─── Schema-derived broadcasts (Track C / schema from Track A) ───

  /**
   * Cloud → user: emitted by `PATCH /api/im/agents/:userId` after a successful
   * rename. `fields` is partial — only changed columns are present.
   */
  agentChanged(data: AgentChangedPayload): WSMessage<AgentChangedPayload> {
    return makeEvent('agent.changed', data);
  },

  /**
   * Cloud → user: emitted when an `im_workspaces` row is created/updated.
   * Daemon should refresh its local mirror via `GET /api/im/workspaces/:id`.
   */
  workspaceChanged(data: WorkspaceChangedPayload): WSMessage<WorkspaceChangedPayload> {
    return makeEvent('workspace.changed', data);
  },

  /**
   * Cloud → user: emitted when an `im_agent_profiles` row is created/updated.
   * `version` is the optimistic-lock counter; daemon compares against its
   * mirror to decide if a refetch is necessary.
   */
  agentProfileChanged(data: AgentProfileChangedPayload): WSMessage<AgentProfileChangedPayload> {
    return makeEvent('agent_profile.changed', data);
  },

  /**
   * Cloud → user: emitted on `im_workspace_files` create/update/delete.
   * Daemon updates only the path → asset mapping (`workspace_files_mirror`)
   * — bytes remain lazy-fetched.
   */
  workspaceFileChanged(data: WorkspaceFileChangedPayload): WSMessage<WorkspaceFileChangedPayload> {
    return makeEvent('workspace_file.changed', data);
  },

  /**
   * Cloud → user: emitted on im_assets create/update/delete. Daemon refreshes
   * its asset metadata index via /api/im/assets/index.
   */
  assetChanged(data: AssetChangedPayload): WSMessage<AssetChangedPayload> {
    return makeEvent('asset.changed', data);
  },

  /**
   * Cloud → user/agent: page soft-deleted, archived, or visibility-shifted.
   * Daemon clears the affected pageId from its local mirror and refetches via
   * GET /memory/pages/:id (which will return 404 for soft-deleted pages, or
   * the new visibility for changed ones). Reason field documents the cause.
   */
  memoryInvalidate(data: MemoryInvalidatePayload): WSMessage<MemoryInvalidatePayload> {
    return makeEvent('memory.invalidate', data);
  },

  /**
   * v2.0.8 P0 (doc 21 §5) — coarse-grained "agent dispatch in-flight"
   * signal for AgentStateStrip's `N 活跃 / total` counter.
   *
   * Three fire points:
   *   - `received` — emitted right after task.service.dispatchTaskRun pushes
   *     the WS task.dispatch.request to the daemon. The strip flips the
   *     agent's ring from idle → working without waiting for the daemon's
   *     first phase_change step (which can take ~1s on cold pods).
   *   - `started` — emitted when the daemon's TaskStepRecorder records its
   *     first phase_change step. The strip can show "thinking" in the
   *     agent tooltip if it wants finer detail.
   *   - `completed` / `failed` — emitted from task.dispatch.reply handler
   *     after taskService.updateTaskRun. `failed` also covers lie-guard
   *     interception (see doc 21 §3).
   *
   * Non-persistent — no DB write. Fan-out via SyncService so multiple
   * tabs / mobile UIs of the same human owner stay in sync. If a Pod
   * dies between `received` and `completed`, the strip's count is
   * temporarily off; the cleanup paths (task heartbeat reaper at 45s,
   * page-load hydration) reconcile it back.
   */
  dispatchLifecycle(data: DispatchLifecyclePayload): WSMessage<DispatchLifecyclePayload> {
    return makeEvent('dispatch.lifecycle', data);
  },
};

export interface MemoryInvalidatePayload {
  workspaceId: string;
  pageIds: string[];
  reason: 'soft_delete' | 'archive' | 'visibility_changed' | 'promoted' | 'html_updated';
  createdAt: string;
}

/**
 * v2.0.8 P0 (doc 21 §5) — dispatch in-flight lifecycle payload.
 *
 * `dispatchId` is the IMTaskRun id of the run that backs this @-mention.
 * `agentImUserId` is the assignee — every UI client that observes the
 * agent (whether the conversation is open or not) increments/decrements
 * its in-flight counter so the AgentStateStrip stays accurate across
 * sessions. `lifecycle='failed'` carries `errorCode` for the strip's red
 * failure state; `received` / `started` / `completed` leave it null.
 */
export interface DispatchLifecyclePayload {
  workspaceId: string;
  conversationId: string;
  agentImUserId: string;
  dispatchId: string;
  lifecycle: 'received' | 'started' | 'completed' | 'failed';
  errorCode?: string;
  occurredAt: number;
}

// ─── v1.9.x daemon → cloud payload aliases ───────────────────
//
// Re-exporting under the events.ts surface so handler.ts can import client
// payload types from a single module, matching the existing 1.8.2 pattern
// (e.g. `MessageSendPayload` lives here too).

export type {
  AgentHostDeclarePayload,
  AgentStatusChangedPayload,
  TaskDispatchProgressPayload,
  TaskDispatchReplyPayload,
} from '../types/index';

// ─── Client → Server payload types ──────────────────────────

export interface AuthenticatePayload {
  token: string;
}

export interface MessageSendPayload {
  conversationId: string;
  type?: MessageType;
  content: string;
  metadata?: MessageMetadata;
  attachments?: AssetAttachment[] | null;
  parentId?: string;
}

export interface StreamStartPayload {
  conversationId: string;
  streamId: string;
  type?: MessageType;
  metadata?: MessageMetadata;
}

export interface StreamChunkPayload {
  streamId: string;
  chunk: string;
  index: number;
}

export interface StreamEndPayload {
  streamId: string;
  finalContent?: string;
}

export interface TypingPayload {
  conversationId: string;
}

export interface PresenceUpdatePayload {
  status: PresenceStatus;
}

export interface ConversationJoinPayload {
  conversationId: string;
}

export interface AgentHeartbeatPayload {
  status: AgentStatus;
  load?: number;
  activeConversations?: number;
}

/**
 * Task-level phase heartbeat (v2.0 §4.2 Track B-1).
 *
 * Daemon pushes per-task heartbeats every ~15s so the cloud-side
 * `sweepStuckPhases` reaper can flag silent stalls (no heartbeat for >45s)
 * without touching the canonical `status` column.
 *
 * `currentPhase` is daemon-defined free-form string (e.g. 'thinking',
 * 'tool_use', 'reasoning', 'responding', 'waiting_user', 'waiting_dep').
 * Per Q1 A (2026-05-21) cloud only stores the value; semantics live in the
 * daemon runtime / SKILL.md frontmatter, not in cloud schema.
 *
 * `heartbeatVersion` is monotonically increasing within a (daemon, task)
 * pair; the cloud uses it for last-write-wins reconciliation when two
 * heartbeats race (e.g. daemon retry after WS reconnect).
 */
export interface TaskHeartbeatPayload {
  taskId: string;
  heartbeatVersion: number;
  currentPhase: string;
  /** ISO timestamp of the daemon's most recent observable step (LLM token /
   * tool-call boundary). Optional — informational only. */
  lastStepAt?: string | number;
}

export interface AgentCapabilityDeclarePayload {
  capabilities: AgentCapability[];
}

/**
 * Per-task observable step append (v2.0 §4.4 / Gap C-④).
 *
 * Daemon's StepRecorder (`sdk/prismer-cloud/runtime/src/daemon/step-recorder.ts`)
 * pushes one of these per phase change / tool call / tool result /
 * reasoning chunk / progress / error. seq is daemon-allocated and
 * monotonically increasing per `taskRunId` (cloud MUST NOT renumber).
 *
 * Server-side handling: write `im_task_run_steps` row + emit
 * `task.step.appended` IMSyncEvent so the front-end InlineActivityStream
 * (P4c — Wave 4) can render in real time. Duplicate `(taskRunId, seq)` is
 * idempotently ignored (daemon may resend after WS reconnect race).
 *
 * Note: wire field is `step.payload` (object), DB column is `payloadJson`
 * (JSON). The recorder service does the rename on persist.
 */
export type TaskStepKind = 'phase_change' | 'tool_call' | 'tool_result' | 'reasoning_chunk' | 'progress' | 'error';

export interface TaskStepFrame {
  seq: number;
  kind: TaskStepKind | string;
  payload: Record<string, unknown>;
  /** Daemon wall-clock ms (Date.now()). */
  occurredAt: number;
  /** Optional duration of the step in ms (e.g. tool call latency). */
  durationMs?: number;
}

export interface TaskStepAppendPayload {
  taskRunId: string;
  step: TaskStepFrame;
}

// ─── ACK / Reconnect payloads ────────────────────────────────

export interface AckPayload {
  ackId: string;
}

export interface ReconnectPayload {
  lastEventTime?: number; // Timestamp of last received event
  lastSyncCursor?: number; // Last sync cursor for /sync recovery
}
