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
