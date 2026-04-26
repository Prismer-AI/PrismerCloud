/**
 * Prismer IM — WebSocket connection handler
 *
 * Manages the full lifecycle of a WebSocket connection:
 *   authenticate → join rooms → handle events → disconnect
 */

import type { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';
import type Redis from 'ioredis';

import { verifyToken } from '../auth/jwt';
import { config } from '../config';
import { WebSocketTransport } from './transport';
import { RoomManager, type ConnectedClient } from './rooms';
import {
  ServerEvents,
  type AuthenticatePayload,
  type MessageSendPayload,
  type StreamStartPayload,
  type StreamChunkPayload,
  type StreamEndPayload,
  type TypingPayload,
  type PresenceUpdatePayload,
  type ConversationJoinPayload,
  type AgentHeartbeatPayload,
  type AgentCapabilityDeclarePayload,
  type AckPayload,
  type ReconnectPayload,
} from './events';
import { AckTracker } from './ack-tracker';
import { MessageService } from '../services/message.service';
import { ConversationService } from '../services/conversation.service';
import { PresenceService } from '../services/presence.service';
import { AgentService } from '../services/agent.service';
import { StreamService } from '../services/stream.service';
import type { WSMessage } from '../types/index';

export interface WebSocketDeps {
  redis: Redis;
  rooms: RoomManager;
  messageService: MessageService;
  conversationService: ConversationService;
  presenceService: PresenceService;
  agentService: AgentService;
  streamService: StreamService;
}

export function setupWebSocket(wss: WebSocketServer, deps: WebSocketDeps): void {
  const { rooms, messageService, conversationService, presenceService, agentService, streamService } = deps;

  // Shared ACK tracker for all connections on this Pod
  const ackTracker = new AckTracker();
  rooms.setAckTracker(ackTracker);

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    let client: ConnectedClient | null = null;
    let authTimeout: ReturnType<typeof setTimeout>;

    // Require authentication within configured timeout (default 10s)
    authTimeout = setTimeout(() => {
      if (!client) {
        ws.send(JSON.stringify(ServerEvents.error('Authentication timeout')));
        ws.close(4001, 'Authentication timeout');
      }
    }, config.ws.authTimeoutMs);

    // Check for token in query string (for initial connection)
    const url = new URL(req.url || '/', 'http://localhost');
    const queryToken = url.searchParams.get('token');
    if (queryToken) {
      tryAuthenticate(queryToken);
    }

    ws.on('message', (raw: Buffer | string) => {
      try {
        const msg: WSMessage = JSON.parse(raw.toString());
        handleEvent(msg);
      } catch (err) {
        ws.send(JSON.stringify(ServerEvents.error('Invalid JSON')));
      }
    });

    ws.on('close', () => {
      if (client) {
        ackTracker.handleDisconnect(client.userId);
        rooms.removeClient(client);
        presenceService.setOffline(client.userId);
        console.log(`[WS] Disconnected: ${client.username} (${client.userId})`);
      }
    });

    ws.on('error', (err) => {
      console.error('[WS] Error:', err.message);
    });

    // ─── Event router ────────────────────────────────────────

    function handleEvent(msg: WSMessage) {
      const { type, payload, requestId } = msg;

      if (type === 'authenticate') {
        const { token } = payload as AuthenticatePayload;
        tryAuthenticate(token, requestId);
        return;
      }

      if (type === 'ping') {
        ws.send(JSON.stringify(ServerEvents.pong(requestId)));
        return;
      }

      if (type === 'ack') {
        const { ackId } = payload as AckPayload;
        if (ackId) ackTracker.ack(ackId);
        return;
      }

      // All other events require authentication
      if (!client) {
        ws.send(JSON.stringify(ServerEvents.error('Not authenticated', 'AUTH_REQUIRED', requestId)));
        return;
      }

      const handlers: Record<string, () => void | Promise<void>> = {
        'message.send': () => handleMessageSend(payload as MessageSendPayload, requestId),
        'message.stream.start': () => handleStreamStart(payload as StreamStartPayload, requestId),
        'message.stream.chunk': () => handleStreamChunk(payload as StreamChunkPayload),
        'message.stream.end': () => handleStreamEnd(payload as StreamEndPayload, requestId),
        'typing.start': () => handleTyping(payload as TypingPayload, true),
        'typing.stop': () => handleTyping(payload as TypingPayload, false),
        'presence.update': () => handlePresenceUpdate(payload as PresenceUpdatePayload),
        'conversation.join': () => handleConversationJoin(payload as ConversationJoinPayload, requestId),
        'conversation.leave': () => handleConversationLeave(payload as ConversationJoinPayload, requestId),
        'agent.heartbeat': () => handleAgentHeartbeat(payload as AgentHeartbeatPayload),
        'agent.capability.declare': () =>
          handleAgentCapabilityDeclare(payload as AgentCapabilityDeclarePayload, requestId),
        reconnect: () => handleReconnect(payload as ReconnectPayload, requestId),
      };

      const handler = handlers[type as string];
      if (handler) {
        Promise.resolve(handler()).catch((err) => {
          console.error(`[WS] Error handling ${type}:`, err);
          ws.send(JSON.stringify(ServerEvents.error(`Internal error handling ${type}`, 'INTERNAL', requestId)));
        });
      } else {
        ws.send(JSON.stringify(ServerEvents.error(`Unknown event type: ${type}`, 'UNKNOWN_EVENT', requestId)));
      }
    }

    // ─── Authentication ──────────────────────────────────────

    function tryAuthenticate(token: string, requestId?: string) {
      try {
        const payload = verifyToken(token);
        clearTimeout(authTimeout);

        client = {
          transport: new WebSocketTransport(ws),
          userId: payload.sub,
          username: payload.username,
          connectedAt: Date.now(),
        };

        rooms.addClient(client);
        presenceService.setOnline(payload.sub);

        ws.send(JSON.stringify(ServerEvents.authenticated(payload.sub, requestId)));
        console.log(`[WS] Authenticated: ${payload.username} (${payload.sub})`);

        // Deliver any unacked messages from previous connection
        deliverUnackedMessages(payload.sub);

        // Auto-join user's conversations
        autoJoinConversations(payload.sub);
      } catch (err) {
        ws.send(JSON.stringify(ServerEvents.error('Invalid token', 'AUTH_FAILED', requestId)));
      }
    }

    async function autoJoinConversations(userId: string) {
      try {
        const participations = await conversationService.listByUser(userId);
        for (const p of participations) {
          rooms.joinRoom(p.conversation.id, userId);
        }
      } catch (err) {
        console.error('[WS] Error auto-joining conversations:', err);
      }
    }

    // ─── ACK / Reconnect helpers ───────────────────────────────

    function deliverUnackedMessages(userId: string) {
      const undelivered = ackTracker.getUndelivered(userId);
      if (undelivered.length === 0) return;

      console.log(`[WS] Delivering ${undelivered.length} unacked messages to ${userId}`);
      for (const msg of undelivered) {
        const retryPayload = { ...msg.payload, ackId: msg.ackId, isRetry: true };
        ws.send(JSON.stringify(retryPayload));
        // Re-track for ACK on this new connection
        msg.retries++;
        ackTracker.track(userId, retryPayload);
      }
    }

    async function handleReconnect(payload: ReconnectPayload, requestId?: string) {
      if (!client) return;

      // Deliver unacked messages (in case authenticate didn't catch them all)
      deliverUnackedMessages(client.userId);

      // Tell the client to use /sync for any gap beyond what ACK covers
      ws.send(
        JSON.stringify(
          ServerEvents.reconnectAck(
            {
              userId: client.userId,
              undeliveredCount: 0, // Already delivered above
              syncAdvised: true,
            },
            requestId,
          ),
        ),
      );
      console.log(`[WS] Reconnect handled for ${client.username} (${client.userId})`);
    }

    // ─── Message handlers ────────────────────────────────────

    async function handleMessageSend(payload: MessageSendPayload, requestId?: string) {
      if (!client) return;

      const result = await messageService.send({
        conversationId: payload.conversationId,
        senderId: client.userId,
        type: payload.type,
        content: payload.content,
        metadata: payload.metadata,
        parentId: payload.parentId,
      });

      const msg = result.message;
      const routing = result.routing;

      // Build metadata with routing info
      const messageMetadata = msg.metadata ? JSON.parse(msg.metadata) : {};
      if (routing && routing.targets.length > 0) {
        messageMetadata.routeTargets = routing.targets.map((t) => t.userId);
        messageMetadata.routingMode = routing.mode;
      }

      // Broadcast to room
      rooms.broadcastToRoom(
        payload.conversationId,
        ServerEvents.messageNew({
          id: msg.id,
          conversationId: msg.conversationId,
          senderId: msg.senderId,
          type: msg.type as any,
          content: msg.content,
          metadata: messageMetadata,
          parentId: msg.parentId ?? undefined,
          createdAt: msg.createdAt.toISOString(),
        }),
      );
    }

    async function handleStreamStart(payload: StreamStartPayload, requestId?: string) {
      if (!client) return;
      streamService.startStream({
        streamId: payload.streamId,
        conversationId: payload.conversationId,
        senderId: client.userId,
        type: payload.type,
        metadata: payload.metadata,
      });
    }

    function handleStreamChunk(payload: StreamChunkPayload) {
      if (!client) return;
      const stream = streamService.getStream(payload.streamId);
      if (!stream) return;

      streamService.appendChunk(payload.streamId, payload.chunk);

      rooms.broadcastToRoom(
        stream.conversationId,
        ServerEvents.streamChunk({
          streamId: payload.streamId,
          conversationId: stream.conversationId,
          senderId: client.userId,
          chunk: payload.chunk,
          index: payload.index,
        }),
      );
    }

    async function handleStreamEnd(payload: StreamEndPayload, requestId?: string) {
      if (!client) return;
      const result = await streamService.endStream(payload.streamId, payload.finalContent);
      if (!result) return;

      // Persist as a message
      const sendResult = await messageService.send({
        conversationId: result.conversationId,
        senderId: client.userId,
        type: result.type,
        content: result.finalContent,
        metadata: { ...result.metadata, wasStreamed: true, streamId: payload.streamId },
      });

      rooms.broadcastToRoom(
        result.conversationId,
        ServerEvents.streamEnd({
          streamId: payload.streamId,
          conversationId: result.conversationId,
          messageId: sendResult.message.id,
          finalContent: result.finalContent,
        }),
      );
    }

    function handleTyping(payload: TypingPayload, isTyping: boolean) {
      if (!client) return;
      rooms.broadcastToRoom(
        payload.conversationId,
        ServerEvents.typingIndicator({
          conversationId: payload.conversationId,
          userId: client.userId,
          isTyping,
        }),
        client.userId,
      );
    }

    function handlePresenceUpdate(payload: PresenceUpdatePayload) {
      if (!client) return;
      presenceService.setStatus(client.userId, payload.status);
      rooms.broadcastGlobal(
        ServerEvents.presenceChanged({
          userId: client.userId,
          status: payload.status,
          lastSeen: Date.now(),
        }),
      );
    }

    async function handleConversationJoin(payload: ConversationJoinPayload, requestId?: string) {
      if (!client) return;
      rooms.joinRoom(payload.conversationId, client.userId);
    }

    async function handleConversationLeave(payload: ConversationJoinPayload, requestId?: string) {
      if (!client) return;
      rooms.leaveRoom(payload.conversationId, client.userId);
    }

    async function handleAgentHeartbeat(payload: AgentHeartbeatPayload) {
      if (!client) return;
      await agentService.heartbeat(client.userId, {
        status: payload.status,
        load: payload.load,
        activeConversations: payload.activeConversations,
      });
    }

    async function handleAgentCapabilityDeclare(payload: AgentCapabilityDeclarePayload, requestId?: string) {
      if (!client) return;
      await agentService.declareCapabilities(client.userId, payload.capabilities);
      ws.send(
        JSON.stringify(
          ServerEvents.agentRegistered({
            agentId: client.userId,
            name: client.username,
            capabilities: payload.capabilities,
          }),
        ),
      );
    }
  });
}
