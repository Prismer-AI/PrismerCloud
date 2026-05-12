/**
 * Prismer IM — WebSocket event definitions
 *
 * Typed event builders for both client→server and server→client messages.
 */

import type {
  WSMessage,
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
   * Cloud → user/agent: page soft-deleted, archived, or visibility-shifted.
   * Daemon clears the affected pageId from its local mirror and refetches via
   * GET /memory/pages/:id (which will return 404 for soft-deleted pages, or
   * the new visibility for changed ones). Reason field documents the cause.
   */
  memoryInvalidate(data: MemoryInvalidatePayload): WSMessage<MemoryInvalidatePayload> {
    return makeEvent('memory.invalidate', data);
  },
};

export interface MemoryInvalidatePayload {
  workspaceId: string;
  pageIds: string[];
  reason: 'soft_delete' | 'archive' | 'visibility_changed' | 'promoted' | 'html_updated';
  createdAt: string;
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

export interface AgentCapabilityDeclarePayload {
  capabilities: AgentCapability[];
}

// ─── ACK / Reconnect payloads ────────────────────────────────

export interface AckPayload {
  ackId: string;
}

export interface ReconnectPayload {
  lastEventTime?: number; // Timestamp of last received event
  lastSyncCursor?: number; // Last sync cursor for /sync recovery
}
