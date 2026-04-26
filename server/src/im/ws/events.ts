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
};

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
