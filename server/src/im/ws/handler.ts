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
import type { TaskService } from '../services/task.service';
import { MemoryService } from '../services/memory.service';
import type {
  WSMessage,
  AgentHostDeclarePayload,
  AgentStatusChangedPayload,
  TaskDispatchProgressPayload,
  TaskDispatchReplyPayload,
} from '../types/index';
import type { AssetDispatchObservation } from '../types/im-events';
import { computeProfilesToSync } from './v19x-helpers';
import prisma from '../db';
import { createModuleLogger } from '../../lib/logger';
import { isDaemonForgotten } from '../services/runtime-binding.service';
import { generateIMUserId } from '../utils/id-gen';

const log = createModuleLogger('WS');
const DAEMON_ROUTE_PREFIX = 'daemon:';
const rememberPattern = /\bremember\s+(?:that\s+)?(.{4,800})|(?:记住|请记住|帮我记住)[:：]?\s*(.{2,800})/i;

function daemonRouteKey(daemonId: string): string {
  return `${DAEMON_ROUTE_PREFIX}${daemonId}`;
}

export interface WebSocketDeps {
  redis: Redis;
  rooms: RoomManager;
  messageService: MessageService;
  conversationService: ConversationService;
  presenceService: PresenceService;
  agentService: AgentService;
  streamService: StreamService;
  /** Optional in test environments; required for v1.9.x daemon protocol. */
  taskService?: TaskService;
}

export function setupWebSocket(wss: WebSocketServer, deps: WebSocketDeps): void {
  const { rooms, messageService, conversationService, presenceService, agentService, streamService, taskService } =
    deps;
  const memoryService = new MemoryService();

  // Shared ACK tracker for all connections on this Pod
  const ackTracker = new AckTracker();
  rooms.setAckTracker(ackTracker);

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    let client: ConnectedClient | null = null;
    let authTimeout: ReturnType<typeof setTimeout>;

    /**
     * Set of agent imUserIds the daemon on this connection has declared as
     * hosting (via `agent.host.declare`). Used to validate inbound
     * `task.dispatch.progress` / `task.dispatch.reply` messages — daemon
     * can only report on its own agents' tasks. Empty set for non-daemon
     * (mobile, web) connections — they never call task.dispatch.* anyway.
     */
    const declaredAgents = new Set<string>();
    let declaredDaemonId: string | null = null;
    let declaredWorkspaceId: string | null = null;

    /**
     * `agent.host.declare` is sent on first reconnect AND every 30s as a
     * heartbeat (see runtime/daemon/runner.ts). We only want to fire
     * `redispatchPending` on the first declare per WS connection — if it
     * fires on every heartbeat the cloud pushes the same pending tasks
     * back to the daemon every 30s, multiplying network traffic and
     * (worse) re-running tasks that the daemon already executed and is
     * waiting to flush a `task.dispatch.reply` for.
     */
    let didRedispatch = false;

    /**
     * "Shadow" ConnectedClient entries registered under each declared
     * agent's imUserId and this runtime's `daemon:<daemonId>` route so
     * task.service reaches the same physical socket. Tracked here so the
     * `close` handler can remove them (RoomManager keys by userId, not by
     * transport, so we have to clean up explicitly).
     */
    const shadowClients: ConnectedClient[] = [];

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
        // Tear down per-agent shadow registrations so RoomManager doesn't
        // route to a closed socket on the next dispatch.
        for (const shadow of shadowClients) {
          rooms.removeClient(shadow);
        }
        if (shadowClients.length > 0) {
          console.log(
            `[WS] Disconnected: ${client.username} (${client.userId}) + ${shadowClients.length} shadow route(s)`,
          );
          shadowClients.length = 0;
        } else {
          console.log(`[WS] Disconnected: ${client.username} (${client.userId})`);
        }
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
        // ─── v1.9.x daemon protocol (Track C m2) ───
        'agent.host.declare': () => handleAgentHostDeclare(payload as AgentHostDeclarePayload, requestId),
        'agent.status.changed': () => handleAgentStatusChanged(payload as AgentStatusChangedPayload),
        'task.dispatch.progress': () => handleTaskDispatchProgress(payload as TaskDispatchProgressPayload),
        'task.dispatch.reply': () => handleTaskDispatchReply(payload as TaskDispatchReplyPayload, requestId),
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

    /**
     * Authenticate the WS connection. Supports two token shapes:
     *   • `sk-prismer-*` — daemon API key. Resolves the cloud user via
     *     `pc_api_keys` (SHA-256 lookup), then maps to the human IMUser
     *     via `IMUser.userId` field. Daemon connections always bind under
     *     the human's IMUser id; per-agent routing happens through the
     *     `declaredAgents` shadow registrations in handleAgentHostDeclare.
     *   • Anything else — JWT (existing 1.8.2 path for mobile/web).
     */
    function tryAuthenticate(token: string, requestId?: string): void {
      if (token.startsWith('sk-prismer-')) {
        // Async path; fire-and-forget but surface errors via WS.
        tryAuthenticateApiKey(token, requestId).catch((err) => {
          console.error('[WS] API key auth error:', (err as Error).message);
          ws.send(JSON.stringify(ServerEvents.error('Auth error', 'AUTH_FAILED', requestId)));
        });
        return;
      }

      try {
        const payload = verifyToken(token);
        completeAuthentication({ userId: payload.sub, username: payload.username, requestId });
      } catch (err) {
        ws.send(JSON.stringify(ServerEvents.error('Invalid token', 'AUTH_FAILED', requestId)));
      }
    }

    /**
     * Resolve an `sk-prismer-*` token to its IMUser cuid. Validation:
     *   1. SHA-256 hash lookup in pc_api_keys (status='ACTIVE') →
     *      cloud user id (numeric).
     *   2. IMUser lookup by `userId === String(cloudUserId)` AND
     *      `role === 'human'`. Multiple agent IMUsers can share a userId,
     *      but the daemon binds under the human owner's IMUser; agent-level
     *      routing is via shadow connections in handleAgentHostDeclare.
     */
    async function tryAuthenticateApiKey(token: string, requestId?: string): Promise<void> {
      const { validateApiKeyFromDb } = await import('../../lib/db-api-keys');
      const result = await validateApiKeyFromDb(token);
      if (!result) {
        ws.send(JSON.stringify(ServerEvents.error('Invalid API key', 'AUTH_FAILED', requestId)));
        return;
      }

      let humanImUser = await prisma.iMUser.findFirst({
        where: {
          role: 'human',
          OR: [{ numericId: result.userId }, { userId: String(result.userId) }],
        },
        select: { id: true, username: true },
      });
      if (!humanImUser) {
        // Mirror the HTTP path: if a daemon races ahead of /register or
        // /me on a brand-new cloud account, auto-create the human IMUser
        // here instead of bouncing the WS connection. Without this fix,
        // first-boot hits a deterministic AUTH_FAILED loop until the
        // daemon happens to retry after the HTTP-side ensureIMUser fires.
        const fallbackUsername = `user-${String(result.userId)}`;
        const { generateUserId } = await import('../utils/id-gen');
        try {
          const created = await prisma.iMUser.create({
            data: {
              id: generateUserId(),
              username: fallbackUsername,
              displayName: fallbackUsername,
              role: 'human',
              userId: String(result.userId),
              numericId: result.userId,
              metadata: JSON.stringify({ autoCreated: true, source: 'ws-api-key' }),
            },
            select: { id: true, username: true },
          });
          humanImUser = created;
          console.log(`[Auth] Auto-created human IMUser ${created.id} for cloud user ${result.userId} (WS path)`);
        } catch (err) {
          // Race: someone else (HTTP middleware) just created it. Retry the lookup once.
          humanImUser = await prisma.iMUser.findFirst({
            where: {
              role: 'human',
              OR: [{ numericId: result.userId }, { userId: String(result.userId) }],
            },
            select: { id: true, username: true },
          });
          if (!humanImUser) {
            ws.send(
              JSON.stringify(
                ServerEvents.error(
                  `API key valid but failed to provision IM user: ${(err as Error).message}`,
                  'NO_IMUSER_LINKED',
                  requestId,
                ),
              ),
            );
            return;
          }
        }
      }

      completeAuthentication({
        userId: humanImUser.id,
        username: humanImUser.username,
        requestId,
      });
    }

    /**
     * Common path for both JWT and API-key auth. Registers the connection,
     * marks online, sends `authenticated` ack, delivers any unacked
     * messages, and auto-joins conversations.
     */
    function completeAuthentication(args: { userId: string; username: string; requestId?: string }) {
      clearTimeout(authTimeout);
      client = {
        transport: new WebSocketTransport(ws),
        userId: args.userId,
        username: args.username,
        connectedAt: Date.now(),
      };
      rooms.addClient(client);
      presenceService.setOnline(args.userId);
      ws.send(JSON.stringify(ServerEvents.authenticated(args.userId, args.requestId)));
      console.log(`[WS] Authenticated: ${args.username} (${args.userId})`);
      deliverUnackedMessages(args.userId);
      autoJoinConversations(args.userId);
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

    // ═════════════════════════════════════════════════════════
    // v1.9.x daemon protocol handlers (Track C m2)
    //
    // Auth note: m2 still uses the JWT path; daemons authenticate over WS
    // with API key in m3 (extending tryAuthenticate for `sk-prismer-`
    // tokens). For now `client.userId` is the cloud user — for declared
    // agents we trust the daemon's claim that they're hosted by this user
    // and rely on Track A's PATCH /agents/:id ACL elsewhere to keep the
    // IMAgentCard.imUserId ↔ owner relationship clean.
    // ═════════════════════════════════════════════════════════

    /**
     * Handshake message after a daemon WS connects. Reconciles the IMAgent
     * cards (status='online' for declared, 'offline' for cloud-known but
     * not declared), computes which AgentProfiles are stale on the daemon,
     * and replies with `host.acked`. Then triggers a re-dispatch of any
     * tasks that were pending while the daemon was offline.
     */
    async function handleAgentHostDeclare(payload: AgentHostDeclarePayload, requestId?: string) {
      if (!client) return;

      const userId = client.userId;

      // Resolve the connected human's cloud-user link so we can verify
      // ownership of declared agents. Both human IMUser and its agent
      // IMUsers share `userId` field (= cloud pc_users.id as string).
      const owner = await prisma.iMUser.findUnique({
        where: { id: userId },
        select: { userId: true, role: true },
      });
      if (!owner) {
        ws.send(JSON.stringify(ServerEvents.error('Connected user not found', 'NO_USER', requestId)));
        return;
      }

      // Resolve workspace before accepting the daemon declaration. A local
      // daemon forgotten from this workspace must not register shadow routes,
      // stamp agent metadata, or refresh runtime presence.
      const workspace = await prisma.iMWorkspace.findFirst({
        where: { ownerImUserId: userId, isDefault: true, deletedAt: null },
        select: { id: true, updatedAt: true, metadata: true },
      });
      const workspaceId = workspace?.id ?? '';
      if (workspace && isDaemonForgotten(workspace.metadata, payload.daemonId)) {
        for (const shadow of shadowClients) rooms.removeClient(shadow);
        shadowClients.length = 0;
        declaredAgents.clear();
        declaredDaemonId = null;
        declaredWorkspaceId = null;
        log.warn({ workspaceId, daemonId: payload.daemonId }, 'agent.host.declare rejected for forgotten daemon');
        ws.send(JSON.stringify(ServerEvents.error('Daemon forgotten from workspace', 'DAEMON_FORGOTTEN', requestId)));
        return;
      }

      // Verify each declared agent IMUser belongs to the same cloud user
      // and is role='agent'. Invalid/stale local rows are ignored one by
      // one: a daemon may have old local SQLite rows from another account,
      // but that must not prevent the physical device from declaring online
      // for its current API-key owner. A fresh daemon also legitimately
      // declares zero agents before the workspace installs the first one.
      const candidateIds = payload.agents.map((a) => a.imUserId);
      const verifiedAgents = await prisma.iMUser.findMany({
        where: { id: { in: candidateIds }, role: 'agent' },
        select: { id: true, userId: true },
      });
      type VerifiedAgent = (typeof verifiedAgents)[number];
      const verifiedById = new Map<string, VerifiedAgent>(verifiedAgents.map((a: VerifiedAgent) => [a.id, a]));
      const ownedAgents = payload.agents.filter((candidate) => {
        const v = verifiedById.get(candidate.imUserId);
        if (!v || v.userId !== owner.userId) {
          console.warn(
            `[WS] Ignoring host declaration for agent ${candidate.imUserId} not owned by user ${owner.userId}`,
          );
          return false;
        }
        return true;
      });
      const cards = await prisma.iMAgentCard.findMany({
        where: { imUserId: { in: ownedAgents.map((a) => a.imUserId) } },
        select: { imUserId: true, metadata: true },
      });
      type AgentCardBinding = { imUserId: string; metadata: string };
      const cardByAgentId = new Map(
        (cards as AgentCardBinding[]).map((card: AgentCardBinding) => [card.imUserId, card]),
      );
      const validAgents = ownedAgents.filter((candidate) => {
        const card = cardByAgentId.get(candidate.imUserId);
        let metadata: Record<string, unknown> = {};
        try {
          metadata = card?.metadata ? (JSON.parse(card.metadata) as Record<string, unknown>) : {};
        } catch {
          metadata = {};
        }
        const boundDaemonId = typeof metadata.daemonId === 'string' ? metadata.daemonId.trim() : '';
        if (boundDaemonId && boundDaemonId !== payload.daemonId) {
          console.warn(
            `[WS] Ignoring host declaration for agent ${candidate.imUserId} on ${payload.daemonId}; bound to ${boundDaemonId}`,
          );
          return false;
        }
        return true;
      });
      const declaredAgentIds = new Set(validAgents.map((a) => a.imUserId));

      // Stash on the connection so subsequent task.dispatch.* events can be
      // validated. Refresh-on-redeclare semantics — the latest declare wins.
      // Drop any prior shadow connections first; we'll add fresh ones below.
      for (const shadow of shadowClients) rooms.removeClient(shadow);
      shadowClients.length = 0;
      declaredAgents.clear();
      declaredDaemonId = payload.daemonId;
      declaredWorkspaceId = workspaceId || null;
      for (const id of declaredAgentIds) declaredAgents.add(id);

      const daemonShadow: ConnectedClient = {
        transport: client.transport,
        userId: daemonRouteKey(payload.daemonId),
        username: `daemon:${payload.daemonId}`,
        connectedAt: client.connectedAt,
      };
      rooms.addClient(daemonShadow);
      shadowClients.push(daemonShadow);

      // Register a shadow ConnectedClient under each declared agent's
      // imUserId so `rooms.sendToUser(agentImUserId, ...)` from
      // task.service reaches the same physical socket. Each shadow shares
      // the underlying transport. Auto-join each agent into the rooms it
      // participates in — without this, broadcastToRoom() never reaches
      // the daemon when a message arrives mentioning the agent.
      for (const agentId of declaredAgentIds) {
        const shadow: ConnectedClient = {
          transport: client.transport,
          userId: agentId,
          username: `agent:${agentId}`,
          connectedAt: client.connectedAt,
        };
        rooms.addClient(shadow);
        shadowClients.push(shadow);
        try {
          const parts = await conversationService.listByUser(agentId);
          for (const p of parts) {
            rooms.joinRoom(p.conversation.id, agentId);
          }
        } catch (err) {
          // Roll back the shadow registration on auto-join failure. Otherwise
          // the shadow lives in `rooms.clients[agentId]` (sendToUser keeps
          // working) but never appears in any room (broadcastToRoom can't
          // reach it). That asymmetry is the worst diagnostic shape: tasks
          // dispatch fine, group @-mentions never land.
          rooms.removeClient(shadow);
          shadowClients.pop();
          declaredAgents.delete(agentId);
          const errMsg = (err as Error).message;
          log.error(
            { err, agentId, userId: client.userId },
            `shadow agent auto-join failed for ${agentId} (declare aborted): ${errMsg}`,
          );
          ws.send(
            JSON.stringify(
              ServerEvents.error(
                `auto-join failed for shadow agent ${agentId}: ${errMsg}`,
                'SHADOW_JOIN_FAILED',
                requestId,
              ),
            ),
          );
          return;
        }
      }

      // 1. Reconcile IMAgentCard status + stamp daemonId into metadata.
      // The runtime endpoint (`workspace-runtime.ts::buildSnapshot`) groups
      // agents under `metadata.daemonId` to render the LeftRail tree. Without
      // stamping here, daemon-declared agents land in the `__unbound__`
      // bucket forever — the daemon is correctly heartbeating but the UI
      // (and CHECKPOINTS §1.4 evidence) never shows the device.
      const newlyDeclared: { imUserId: string; runtimeInstallationId: string | null; agentLabel: string }[] = [];
      for (const declared of validAgents) {
        const card = await prisma.iMAgentCard
          .findFirst({
            where: { imUserId: declared.imUserId },
            select: { metadata: true, name: true, imUser: { select: { displayName: true, username: true } } },
          })
          .catch(() => null);

        let mergedMetadata: string | undefined;
        let isFirstDeclare = false;
        let runtimeInstallationId: string | null = null;
        if (card) {
          let meta: Record<string, unknown> = {};
          try {
            meta = card.metadata ? (JSON.parse(card.metadata) as Record<string, unknown>) : {};
          } catch {
            /* malformed metadata — restamp from scratch */
          }
          if (meta.daemonId !== payload.daemonId) {
            meta.daemonId = payload.daemonId;
            mergedMetadata = JSON.stringify(meta);
            // Wave-8 W9 — first declaration for this (agent, daemon) pair
            // (or after a re-stamp). Heartbeat redeclares (every 30s) skip
            // the metadata update and won't trigger this branch, so the
            // Bell row only fires on a genuine first declare.
            isFirstDeclare = true;
          }
          if (typeof meta.runtimeInstallationId === 'string') runtimeInstallationId = meta.runtimeInstallationId;
        }

        await prisma.iMAgentCard
          .updateMany({
            where: { imUserId: declared.imUserId },
            data: {
              status: 'online',
              lastHeartbeat: new Date(),
              ...(mergedMetadata ? { metadata: mergedMetadata } : {}),
            },
          })
          .catch((err: unknown) =>
            console.warn('[WS] agent.host.declare update online failed:', (err as Error)?.message),
          );

        if (isFirstDeclare) {
          newlyDeclared.push({
            imUserId: declared.imUserId,
            runtimeInstallationId,
            agentLabel: card?.imUser?.displayName ?? card?.name ?? card?.imUser?.username ?? 'Hosted agent',
          });
        }
      }

      // (Wave-8 W9 emit happens once the workspace lookup completes a few
      // statements below — see `// 3. Resolve workspace`.)

      // 2. Compute profilesToSync — pure helper (see v19x-helpers.ts).
      const cloudProfiles = await prisma.iMAgentProfile.findMany({
        where: {
          agentImUserId: { in: Array.from(declaredAgentIds) },
          deletedAt: null,
        },
        select: { id: true, agentImUserId: true, version: true },
      });
      const profilesToSync = computeProfilesToSync(payload.agents, cloudProfiles);

      // 3. Resolve workspace — v1.9.x is 1:1 user ↔ default Personal
      // workspace; Track A's m1 backfill guarantees one exists for every
      // human user. Agents (role='agent') don't own workspaces; they live
      // inside their human owner's. The current WS connection is the
      // daemon authenticating as the cloud user (mapped to the human
      // imUserId), so look up by ownerImUserId === userId.
      // Wave-8 W9 — emit Bell notifications for first-time agent declarations
      // detected above. We defer until here because the emit needs the
      // resolved workspaceId (the Bell row carries it as the routing target).
      if (newlyDeclared.length > 0 && workspaceId) {
        try {
          const { emitRuntimeAgentDeclaredNotification } = await import('../../lib/notification-emitter');
          for (const declared of newlyDeclared) {
            if (!declared.runtimeInstallationId) continue; // pre-W5 daemons (no install metadata) — skip
            void emitRuntimeAgentDeclaredNotification({
              ownerImUserId: userId,
              workspaceId,
              runtimeInstallationId: declared.runtimeInstallationId,
              daemonId: payload.daemonId,
              agentImUserId: declared.imUserId,
              agentLabel: declared.agentLabel,
            });
          }
        } catch (err) {
          log.warn(
            { err, userId, agentCount: newlyDeclared.length },
            `runtime_agent_declared emit failed: ${(err as Error).message}`,
          );
        }
      }

      if (workspaceId) {
        if (!payload.daemonId) {
          log.warn({ workspaceId }, 'host.declare missing daemonId — skipping device presence + container upsert');
        } else {
          await deps.redis.sadd(`runtime:devices:${workspaceId}`, payload.daemonId).catch((err: unknown) => {
            log.warn({ err, workspaceId, daemonId: payload.daemonId }, 'runtime device presence set add failed');
          });
          const presencePayload = JSON.stringify({
            daemonId: payload.daemonId,
            deviceId: payload.daemonId,
            name: `Daemon ${payload.daemonId.slice(0, 8)}`,
            lastSeenAt: Date.now(),
            hostedAgents: validAgents.length,
            daemonVersion: payload.daemonVersion ?? null,
          });
          const presenceKey = `runtime:device:${workspaceId}:${payload.daemonId}`;
          await deps.redis.set(presenceKey, presencePayload, 'EX', 90).catch((err: unknown) => {
            log.warn({ err, workspaceId, daemonId: payload.daemonId }, 'runtime device presence write failed');
          });

          // Upsert im_containers row so device capacity checks at agent.register
          // find this daemon (they query MySQL im_containers, not Redis).
          // Fire-and-forget: a failed upsert does NOT block the host.acked
          // reply — the daemon stays connected and Redis presence works. But
          // agent.register will fail with UNKNOWN_DAEMON if the row is absent,
          // so log at ERROR level when it happens.
          // agentImUserId is varchar(30) in MySQL; daemonId can be longer, so
          // we use the last 30 chars as the lookup key. register.ts matches
          // by BOTH agentImUserId AND daemonId (OR) so the full daemonId
          // column handles finding the device even with truncation.
          const containerImUserId = payload.daemonId.slice(-30);

          // Also store a presence key for the runtime-instance alias
          // (container:<agentImUserId>) so that agent.register which looks up
          // by container:xxx format can find this daemon.
          const aliasKey = `runtime:device:${workspaceId}:container:${containerImUserId}`;
          if (aliasKey !== presenceKey) {
            await deps.redis.set(aliasKey, presencePayload, 'EX', 90).catch(() => {
              /* best-effort alias key */
            });
          }

          const containerId = generateIMUserId('container');
          await prisma.iMContainer
            .upsert({
              where: { podName: `daemon:${containerImUserId}` },
              create: {
                id: containerId,
                workspaceId,
                tenantId: userId,
                agentImUserId: containerImUserId,
                podName: `daemon:${containerImUserId}`,
                namespace: 'default',
                image: 'prismer-daemon:local',
                imageTag: 'local',
                status: 'running',
                runtimeKind: 'docker',
                deviceType: 'local',
                daemonId: payload.daemonId,
                maxAgents: 3,
                cpuRequest: '250m',
                cpuLimit: '2000m',
                memoryRequest: '2Gi',
                memoryLimit: '4Gi',
                startedAt: new Date(),
              },
              update: {
                status: 'running',
                daemonId: payload.daemonId,
                // Intentionally NOT updating startedAt — heartbeat redeclares
                // (every 30s) must not reset the original boot timestamp.
                stoppedAt: null,
              },
            })
            .catch((err: unknown) => {
              log.error(
                { err, workspaceId, daemonId: payload.daemonId, msg: (err as Error).message },
                'im_containers upsert failed — subsequent agent.register calls will fail with UNKNOWN_DAEMON',
              );
            });
        }
      }

      // 4. ACK
      ws.send(
        JSON.stringify(
          ServerEvents.hostAcked(
            {
              workspaceId,
              syncCursor: {
                workspaces: workspace ? workspace.updatedAt.getTime() : 0,
                agent_profiles: 0, // Track A m2/m3 fills cursor semantics
              },
              profilesToSync,
            },
            requestId,
          ),
        ),
      );

      // 5. Re-dispatch tasks that accumulated while the daemon was offline.
      // Fire-and-forget — don't block the ACK reply on this. Only on the
      // FIRST declare for this WS connection: heartbeat redeclares fire
      // every 30s and re-emitting all pending tasks each time would (a)
      // dominate the WS and (b) collide with the daemon's per-taskId
      // dedupe map, which would itself slow-leak entries. Retry once on
      // transient DB blips.
      if (taskService && !didRedispatch) {
        didRedispatch = true;
        const tryRedispatch = async (attempt: number): Promise<void> => {
          try {
            await taskService.redispatchPending(userId);
          } catch (err) {
            const msg = (err as Error).message;
            if (attempt < 1) {
              log.warn({ err, userId, attempt: attempt + 1 }, `redispatchPending failed (retrying in 5s): ${msg}`);
              setTimeout(() => void tryRedispatch(attempt + 1), 5_000);
            } else {
              log.error(
                { err, userId },
                `redispatchPending FAILED after retries — pending tasks will wait for next reconnect: ${msg}`,
              );
            }
          }
        };
        void tryRedispatch(0);
      }

      console.log(
        `[WS] agent.host.declare from ${client.username}: ${validAgents.length}/${payload.agents.length} agents, ${profilesToSync.length} profiles to sync`,
      );
    }

    /**
     * Daemon-emitted status change for a hosted agent. Updates the
     * IMAgentCard and broadcasts to the user's other WS connections (mobile
     * UI). Note: the broadcast goes to the **human owner's** imUserId so
     * mobile sees it; the daemon (which sent this) won't echo back because
     * it's keyed under the agent's imUserId, not the human's.
     */
    async function handleAgentStatusChanged(payload: AgentStatusChangedPayload) {
      if (!client) return;

      // Validate: the daemon can only change status of agents it declared
      // it hosts. Stops cross-tenant tampering.
      if (!declaredAgents.has(payload.agentImUserId)) {
        console.warn(`[WS] agent.status.changed for undeclared agent ${payload.agentImUserId} — ignored`);
        return;
      }

      // Update agent card.
      await prisma.iMAgentCard
        .updateMany({
          where: { imUserId: payload.agentImUserId },
          data: {
            status: payload.status,
            lastHeartbeat: new Date(),
          },
        })
        .catch((err: unknown) => console.warn('[WS] agent.status.changed update failed:', (err as Error)?.message));

      // Broadcast to the human owner's WS connections so mobile/web UI
      // refresh. We deliberately don't broadcastGlobal — see CLAUDE.md /
      // session-C-prompt §m2: must scope to user.
      rooms.sendToUser(client.userId, ServerEvents.agentStatusChanged(payload));
    }

    /**
     * Resolve the agent imUserId that owns a task and confirm the daemon
     * on this connection actually hosts it. Returns null on any mismatch
     * — caller should drop the message silently (daemon could be racing
     * with cancellation, no point shouting).
     */
    async function resolveDeclaredAssignee(taskId: string): Promise<string | null> {
      if (await isDeclaredDaemonForgotten()) {
        console.warn(
          `[WS] task.dispatch.* for task ${taskId} rejected — daemon ${declaredDaemonId ?? '(none)'} forgotten from workspace ${declaredWorkspaceId ?? '(unknown)'}`,
        );
        return null;
      }
      const task = await prisma.iMTask
        .findUnique({ where: { id: taskId }, select: { assigneeId: true } })
        .catch(() => null);
      if (!task?.assigneeId) return null;
      if (declaredAgents.has(task.assigneeId)) {
        return task.assigneeId;
      }
      if (declaredDaemonId) {
        const card = await prisma.iMAgentCard
          .findUnique({ where: { imUserId: task.assigneeId }, select: { metadata: true } })
          .catch(() => null);
        try {
          const meta = card?.metadata ? (JSON.parse(card.metadata) as { daemonId?: unknown }) : {};
          if (meta.daemonId === declaredDaemonId) return task.assigneeId;
        } catch {
          /* fall through to warning */
        }
      }
      {
        console.warn(
          `[WS] task.dispatch.* for task ${taskId} — assignee ${task.assigneeId} not bound to daemon ${declaredDaemonId ?? '(none)'}`,
        );
        return null;
      }
    }

    async function resolveDeclaredRun(taskId: string): Promise<{
      assigneeId: string;
      conversationId: string | null;
      metadata: string | null;
    } | null> {
      const run = await prisma.iMTaskRun
        .findUnique({ where: { id: taskId }, select: { assigneeId: true, conversationId: true, metadata: true } })
        .catch(() => null);
      if (!run?.assigneeId) return null;
      if (declaredAgents.has(run.assigneeId)) {
        return { assigneeId: run.assigneeId, conversationId: run.conversationId, metadata: run.metadata };
      }
      if (declaredDaemonId) {
        const card = await prisma.iMAgentCard
          .findUnique({ where: { imUserId: run.assigneeId }, select: { metadata: true } })
          .catch(() => null);
        try {
          const meta = card?.metadata ? (JSON.parse(card.metadata) as { daemonId?: unknown }) : {};
          if (meta.daemonId === declaredDaemonId) {
            return { assigneeId: run.assigneeId, conversationId: run.conversationId, metadata: run.metadata };
          }
        } catch {
          /* fall through to warning */
        }
      }
      console.warn(
        `[WS] task.dispatch.* for run ${taskId} — assignee ${run.assigneeId} not bound to daemon ${declaredDaemonId ?? '(none)'}`,
      );
      return null;
    }

    async function resolveRuntimeDaemon(taskId: string): Promise<string | null> {
      if (!declaredDaemonId) {
        console.warn(`[WS] runtime task.dispatch.* for task ${taskId} without declared daemon — ignored`);
        return null;
      }
      if (await isDeclaredDaemonForgotten()) {
        console.warn(
          `[WS] runtime task.dispatch.* for task ${taskId} rejected — daemon ${declaredDaemonId} forgotten from workspace ${declaredWorkspaceId ?? '(unknown)'}`,
        );
        return null;
      }
      const task = await prisma.iMTask
        .findUnique({ where: { id: taskId }, select: { runtimeRoute: true, metadata: true } })
        .catch(() => null);
      if (!task || task.runtimeRoute !== 'shell') return null;
      let meta: Record<string, unknown> = {};
      try {
        meta = JSON.parse(task.metadata ?? '{}') as Record<string, unknown>;
      } catch {
        meta = {};
      }
      const execution =
        meta.execution && typeof meta.execution === 'object' && !Array.isArray(meta.execution)
          ? (meta.execution as Record<string, unknown>)
          : {};
      const targetDaemonId = typeof execution.targetDaemonId === 'string' ? execution.targetDaemonId : '';
      if (targetDaemonId !== declaredDaemonId) {
        console.warn(
          `[WS] runtime task.dispatch.* for task ${taskId} — daemon ${declaredDaemonId} does not match target ${targetDaemonId}`,
        );
        return null;
      }
      return declaredDaemonId;
    }

    async function isDeclaredDaemonForgotten(): Promise<boolean> {
      if (!declaredDaemonId || !declaredWorkspaceId) return false;
      const workspace = await prisma.iMWorkspace
        .findFirst({
          where: { id: declaredWorkspaceId, deletedAt: null },
          select: { metadata: true },
        })
        .catch(() => null);
      return workspace ? isDaemonForgotten(workspace.metadata, declaredDaemonId) : false;
    }

    /**
     * Daemon reports task progress. The numeric `progress` (0..1) and
     * `detail` ride along in `metadata` — `TaskProgressInput` only types
     * `message` and `metadata`, so we serialize the rest in there.
     */
    async function handleTaskDispatchProgress(payload: TaskDispatchProgressPayload) {
      if (!client || !taskService) return;
      const daemonId = await resolveRuntimeDaemon(payload.taskId);
      if (daemonId) {
        try {
          await taskService.reportRuntimeProgress(payload.taskId, daemonId, {
            message: payload.message,
            metadata: {
              progress: payload.progress,
              ...(payload.detail ?? {}),
            },
          });
        } catch (err) {
          console.warn('[WS] runtime task.dispatch.progress failed:', (err as Error).message);
        }
        return;
      }
      const agentId = await resolveDeclaredAssignee(payload.taskId);
      if (agentId) {
        try {
          await taskService.reportProgress(payload.taskId, agentId, {
            message: payload.message,
            metadata: {
              progress: payload.progress,
              ...(payload.detail ?? {}),
            },
          });
        } catch (err) {
          console.warn('[WS] task.dispatch.progress failed:', (err as Error).message);
        }
        return;
      }
      // Run-style chat dispatch path. Daemon protocol uses the same
      // task.dispatch.progress wire whether the dispatch came from a
      // board task or a run; the lookup falls through here when payload
      // .taskId names a run.id. Without this the typing-dot row in
      // im-channel.tsx never advances past 'assigned'.
      const run = await resolveDeclaredRun(payload.taskId);
      if (!run) return;
      try {
        await taskService.reportRunProgress(payload.taskId, run.assigneeId, {
          message: payload.message,
          progress: typeof payload.progress === 'number' ? payload.progress : null,
          detail: payload.detail,
        });
      } catch (err) {
        console.warn('[WS] run task.dispatch.progress failed:', (err as Error).message);
      }
    }

    /**
     * Daemon reports task completion. Success → completeTask; failure →
     * failTask. Error code / assetIds ride in metadata since the
     * TaskCompleteInput / TaskFailInput shapes don't have first-class
     * fields for them.
     */
    async function handleTaskDispatchReply(payload: TaskDispatchReplyPayload, _requestId?: string) {
      console.log(
        `[WS] task.dispatch.reply task=${payload.taskId} ok=${payload.ok} outputLen=${payload.output?.length ?? 0}`,
      );
      if (!client || !taskService) {
        console.warn(`[WS] task.dispatch.reply skipped: client=${!!client} taskService=${!!taskService}`);
        return;
      }
      const daemonId = await resolveRuntimeDaemon(payload.taskId);
      if (daemonId) {
        try {
          if (payload.ok) {
            await taskService.completeRuntimeTask(payload.taskId, daemonId, {
              result: {
                output: payload.output,
                assetIds: payload.assetIds,
                metrics: payload.metrics,
              },
            });
          } else {
            await taskService.failRuntimeTask(payload.taskId, daemonId, {
              error: payload.error?.message ?? 'unknown',
              metadata: {
                errorCode: payload.error?.code,
              },
            });
          }
        } catch (err) {
          console.warn('[WS] runtime task.dispatch.reply failed:', (err as Error).message);
        }
        return;
      }
      const run = await resolveDeclaredRun(payload.taskId);
      if (run) {
        try {
          if (payload.ok) {
            await taskService.updateTaskRun(payload.taskId, run.assigneeId, {
              status: 'completed',
              output: {
                output: payload.output,
                assetIds: payload.assetIds,
                metrics: payload.metrics,
              },
            });

            const output = (payload.output ?? '').trim();
            const attachments = await buildAgentReplyAttachments(payload.assetIds);
            // Post when EITHER text or attachments are present. File-only
            // replies ("send the report to me" → daemon-collected files,
            // empty text) used to be silently dropped because the legacy
            // gate only checked `output`.
            if (run.conversationId && (output || attachments) && messageService) {
              let triggerMessageId: string | undefined;
              let runHopCount: number | undefined;
              let runConversationType: 'direct' | 'group' | undefined;
              // Sequential @-mention cursor (v1.9.x). When a single human
              // message @-mentions multiple agents (`@A @B X`), the dispatch
              // path sends only to A and stamps the rest into
              // `run.metadata.pendingMentionTargets`. We pop the head off
              // here AFTER A's reply is posted, then dispatch the next
              // target using the just-posted reply as its trigger — so B
              // sees A's response as context. See
              // message.service.ts §dispatchPendingMention.
              let pendingMentionTargets: string[] = [];
              try {
                const meta = run.metadata ? (JSON.parse(run.metadata) as Record<string, unknown>) : {};
                triggerMessageId = typeof meta.triggerMessageId === 'string' ? meta.triggerMessageId : undefined;
                runHopCount =
                  typeof meta.hopCount === 'number' && Number.isFinite(meta.hopCount) ? meta.hopCount : undefined;
                runConversationType =
                  meta.conversationType === 'direct' || meta.conversationType === 'group'
                    ? meta.conversationType
                    : undefined;
                // Defensive: malformed metadata (not an array of strings)
                // → treat as empty, no fan-out. The chain terminates rather
                // than crashing the reply path.
                if (Array.isArray(meta.pendingMentionTargets)) {
                  pendingMentionTargets = meta.pendingMentionTargets.filter(
                    (v): v is string => typeof v === 'string' && v.length > 0,
                  );
                }
              } catch {
                triggerMessageId = undefined;
                runHopCount = undefined;
                runConversationType = undefined;
                pendingMentionTargets = [];
              }
              const replyMetadata: Record<string, unknown> = {
                kind: 'agent_reply',
                taskId: payload.taskId,
              };
              if (triggerMessageId) replyMetadata.triggerMessageId = triggerMessageId;
              if (attachments) replyMetadata.attachments = attachments;
              // Propagate hopCount so downstream @-mentions in the reply
              // are bounded by MAX_AGENT_HOPS (see message.service.ts).
              if (typeof runHopCount === 'number') replyMetadata.hopCount = runHopCount;
              // Propagate conversationType so an @-mention in the reply
              // (e.g. agent → @other_agent) preserves the channel context
              // when it triggers the next dispatch hop.
              if (runConversationType) replyMetadata.conversationType = runConversationType;
              // NOTE: pendingMentionTargets is INTERNAL — never propagated
              // onto reply metadata. It lives only on task_run.metadata
              // and is consumed here in the WS handler.
              const replyResult = await messageService.send({
                conversationId: run.conversationId,
                senderId: run.assigneeId,
                type: 'text',
                content:
                  output ||
                  (attachments ? `📎 Sent ${attachments.length} file${attachments.length === 1 ? '' : 's'}` : ''),
                metadata: replyMetadata,
              });

              // Sequential mention fan-out: dispatch the next target with
              // the just-posted reply as the trigger message. The new
              // task_run inherits one-shorter `pendingMentionTargets` so
              // the recursion bottoms out when the queue is exhausted.
              // hopCount increments — pending-mention fan-out is treated
              // as a hop just like a direct @-mention, so MAX_AGENT_HOPS
              // still caps the chain length.
              if (pendingMentionTargets.length > 0) {
                const [nextUserId, ...rest] = pendingMentionTargets;
                try {
                  const nextUser = await prisma.iMUser.findUnique({
                    where: { id: nextUserId },
                    select: { id: true, username: true, displayName: true, role: true, agentType: true },
                  });
                  if (nextUser) {
                    const nextHop = (runHopCount ?? 0) + 1;
                    // Defer to messageService for the actual dispatch so
                    // it reuses the same context-building + profile
                    // resolution as the initial @-mention path. The
                    // role-changed-between-dispatches edge case (e.g.
                    // agent demoted to human) is handled inside
                    // dispatchPendingMention — it logs and terminates
                    // the chain rather than fan out to a human target.
                    await messageService.dispatchPendingMention(
                      replyResult.message.id,
                      {
                        userId: nextUser.id,
                        username: nextUser.username,
                        displayName: nextUser.displayName,
                        role: nextUser.role,
                        agentType: nextUser.agentType ?? undefined,
                      },
                      rest,
                      nextHop,
                      runConversationType,
                    );
                  } else {
                    log.warn(
                      { taskId: payload.taskId, nextUserId },
                      `pending mention chain: target user ${nextUserId} not found — chain terminates`,
                    );
                  }
                } catch (chainErr) {
                  // Fan-out failure must not break the run-completion
                  // flow. Log so an operator can see why the chain
                  // stopped; the prior agents' replies are already in
                  // the conversation, so the user is not left in silence.
                  log.warn(
                    { err: chainErr, taskId: payload.taskId, nextUserId: pendingMentionTargets[0] },
                    `pending mention dispatch failed: ${(chainErr as Error).message}`,
                  );
                }
              }
            }
          } else {
            await taskService.updateTaskRun(payload.taskId, run.assigneeId, {
              status: 'failed',
              error: payload.error?.message ?? 'unknown',
              metadata: { errorCode: payload.error?.code },
            });
            // Why: without this, the UI shows a "thinking…" indicator that
            // simply disappears when the run fails — no error feedback to the
            // user, no way to know dispatch died. Surface the error as a
            // system_event message in the same conversation so the operator
            // sees adapter_dispatch_failed / task_cancelled / etc. and can
            // act. Posted as the agent itself so it threads with the chat;
            // metadata.kind='task_status_event' lets the UI render it as a
            // muted system row (existing W7 pattern).
            if (run.conversationId && messageService) {
              const errMsg = payload.error?.message ?? 'unknown error';
              const errCode = payload.error?.code ?? 'adapter_dispatch_failed';
              try {
                await messageService.send({
                  conversationId: run.conversationId,
                  senderId: run.assigneeId,
                  type: 'system_event',
                  content: `⚠️ Agent failed: ${errMsg}`,
                  metadata: {
                    kind: 'task_status_event',
                    status: 'failed',
                    taskId: payload.taskId,
                    errorCode: errCode,
                  },
                });
              } catch (postErr) {
                console.warn('[WS] failed to post run-failure system message:', (postErr as Error).message);
              }
            }
          }
        } catch (err) {
          console.warn('[WS] run task.dispatch.reply failed:', (err as Error).message);
        }
        return;
      }
      const agentId = await resolveDeclaredAssignee(payload.taskId);
      if (!agentId) {
        console.warn(`[WS] task.dispatch.reply: no declared agent for task ${payload.taskId}`);
        return;
      }

      // Wave-8 W1: merge daemon-side asset observability into the task
      // record BEFORE we settle the task — so a downstream consumer (UI,
      // e2e, retry worker) reading the task's metadata after `completed`
      // already sees `observability.assets.{resolved,strategies}`. We
      // don't fail the dispatch on observability merge errors.
      if (payload.assetObservability && payload.assetObservability.length > 0) {
        await mergeAssetObservability(payload.taskId, payload.assetObservability);
      }

      try {
        if (payload.ok) {
          await taskService.completeTask(payload.taskId, agentId, {
            result: {
              output: payload.output,
              assetIds: payload.assetIds,
              metrics: payload.metrics,
            },
          });

          // Multi-agent collab: when a mention-driven task completes, post
          // the agent's output back to the originating conversation as a
          // chat message authored by the agent. Without this the LLM reply
          // dies inside the task store and downstream @-mentions never
          // chain. Only fires when output is non-empty + task has a
          // conversationId (i.e. came from @-mention dispatch).
          const taskRow = await prisma.iMTask.findUnique({
            where: { id: payload.taskId },
            select: { conversationId: true, metadata: true },
          });
          const output = (payload.output ?? '').trim();
          const attachments = await buildAgentReplyAttachments(payload.assetIds);
          if (taskRow?.conversationId && (output || attachments) && messageService) {
            const conversationId = taskRow.conversationId;
            let triggerMessageId: string | undefined;
            let taskHopCount: number | undefined;
            let taskConversationType: 'direct' | 'group' | undefined;
            let existingTaskMetadata: Record<string, unknown> = {};
            try {
              existingTaskMetadata = JSON.parse(taskRow.metadata ?? '{}') as Record<string, unknown>;
              triggerMessageId = existingTaskMetadata.triggerMessageId as string | undefined;
              const rawHop = existingTaskMetadata.hopCount;
              taskHopCount = typeof rawHop === 'number' && Number.isFinite(rawHop) ? rawHop : undefined;
              const rawConvType = existingTaskMetadata.conversationType;
              taskConversationType = rawConvType === 'direct' || rawConvType === 'group' ? rawConvType : undefined;
            } catch {
              triggerMessageId = undefined;
              taskHopCount = undefined;
              taskConversationType = undefined;
            }
            try {
              const replyMetadata: Record<string, unknown> = {
                kind: 'agent_reply',
                taskId: payload.taskId,
              };
              if (triggerMessageId) replyMetadata.triggerMessageId = triggerMessageId;
              if (attachments) replyMetadata.attachments = attachments;
              // Propagate hopCount so downstream @-mentions in the reply
              // are bounded by MAX_AGENT_HOPS (see message.service.ts).
              if (typeof taskHopCount === 'number') replyMetadata.hopCount = taskHopCount;
              // Propagate conversationType so an @-mention in the reply
              // (agent → @other_agent) preserves the channel context for
              // the next dispatch hop.
              if (taskConversationType) replyMetadata.conversationType = taskConversationType;
              await messageService.send({
                conversationId,
                senderId: agentId,
                type: 'text',
                content:
                  output ||
                  (attachments ? `📎 Sent ${attachments.length} file${attachments.length === 1 ? '' : 's'}` : ''),
                metadata: replyMetadata,
              });
              await maybeWriteSessionMemory({
                taskId: payload.taskId,
                agentId,
                triggerMessageId,
                conversationId,
                existingTaskMetadata,
              });
            } catch (postErr) {
              // Critical: task is marked completed but the agent's reply
              // failed to land in the conversation. Without surfacing this
              // the user sees their @-mention go unanswered. Record on the
              // task and post a system_event so downstream consumers (UI,
              // webhooks, retry workers) have something to act on.
              const errMsg = (postErr as Error).message;
              log.error({ err: postErr, taskId: payload.taskId, conversationId }, `agent_reply post failed: ${errMsg}`);
              try {
                const prevMeta = JSON.parse(taskRow.metadata ?? '{}');
                await prisma.iMTask.update({
                  where: { id: payload.taskId },
                  data: {
                    metadata: JSON.stringify({
                      ...prevMeta,
                      replyPostError: errMsg,
                      replyPostFailedAt: new Date().toISOString(),
                    }),
                  },
                });
              } catch (metaErr) {
                log.error(
                  { err: metaErr, taskId: payload.taskId },
                  `failed to record replyPostError on task: ${(metaErr as Error).message}`,
                );
              }
              try {
                await messageService.send({
                  conversationId,
                  senderId: agentId,
                  type: 'system_event',
                  content: `Agent reply post failed: ${errMsg}`,
                  metadata: {
                    kind: 'agent_reply_post_failed',
                    taskId: payload.taskId,
                    triggerMessageId,
                  },
                });
              } catch (sysErr) {
                log.error(
                  { err: sysErr, taskId: payload.taskId },
                  `failed to post agent_reply_post_failed system_event: ${(sysErr as Error).message}`,
                );
              }
            }
          }
        } else {
          await taskService.failTask(payload.taskId, agentId, {
            error: payload.error?.message ?? 'unknown',
            metadata: {
              errorCode: payload.error?.code,
            },
          });
        }
      } catch (err) {
        console.warn('[WS] task.dispatch.reply failed:', (err as Error).message);
      }
    }

    async function maybeWriteSessionMemory(input: {
      taskId: string;
      agentId: string;
      triggerMessageId?: string;
      conversationId: string;
      existingTaskMetadata: Record<string, unknown>;
    }): Promise<void> {
      const startedAt = Date.now();
      if (!input.triggerMessageId) return;
      const trigger = await prisma.iMMessage
        .findUnique({
          where: { id: input.triggerMessageId },
          select: { id: true, content: true, senderId: true },
        })
        .catch(() => null);
      const content = trigger?.content?.trim() ?? '';
      const match = rememberPattern.exec(content);
      const fact = (match?.[1] ?? match?.[2] ?? '').trim();
      if (!fact) return;

      const ownerId = trigger?.senderId ?? '';
      if (!ownerId) return;
      // memory layer became workspace-scoped post-W1; need conversation's
      // workspaceId to write a session memory.
      const conv = await prisma.iMConversation
        .findUnique({ where: { id: input.conversationId }, select: { workspaceId: true } })
        .catch(() => null);
      const memWorkspaceId = conv?.workspaceId ?? '';
      if (!memWorkspaceId) return;
      const path = `agents/${input.agentId}/sessions/${input.conversationId}/memory.md`;
      const now = new Date().toISOString();
      let writeStatus: Record<string, unknown>;
      try {
        const memory = await memoryService.writeMemoryFile(
          memWorkspaceId,
          ownerId,
          'agent',
          path,
          `# Session Memory\n\n- ${fact}\n`,
          'global',
          'fact',
          `Remembered from session ${input.conversationId}`,
        );
        writeStatus = {
          status: 'written',
          memoryId: memory.id,
          path: memory.path,
          durationMs: Date.now() - startedAt,
          at: now,
        };
        log.info(
          { taskId: input.taskId, agentId: input.agentId, ownerId, memoryId: memory.id },
          `memory.write completed from session trigger`,
        );
      } catch (err) {
        writeStatus = {
          status: 'failed',
          error: (err as Error).message,
          durationMs: Date.now() - startedAt,
          at: now,
        };
        log.warn(
          { err, taskId: input.taskId, agentId: input.agentId, ownerId },
          'memory.write failed from session trigger',
        );
      }

      const previousObs =
        input.existingTaskMetadata.observability &&
        typeof input.existingTaskMetadata.observability === 'object' &&
        !Array.isArray(input.existingTaskMetadata.observability)
          ? (input.existingTaskMetadata.observability as Record<string, unknown>)
          : {};
      const previousMemory =
        previousObs.memory && typeof previousObs.memory === 'object' && !Array.isArray(previousObs.memory)
          ? (previousObs.memory as Record<string, unknown>)
          : {};
      await prisma.iMTask
        .update({
          where: { id: input.taskId },
          data: {
            metadata: JSON.stringify({
              ...input.existingTaskMetadata,
              observability: {
                ...previousObs,
                memory: {
                  ...previousMemory,
                  write: writeStatus,
                },
                lastSyncedAt: now,
              },
            }),
          },
        })
        .catch((err: unknown) => {
          log.warn({ err, taskId: input.taskId }, 'failed to stamp memory.write observability on task');
        });
    }
  });
}

/**
 * Wave-8 W1: merge daemon-side asset observations into a task's metadata.
 *
 * Cloud already wrote `observability.assets.requested` + `requestedRefs`
 * at dispatch time (see TaskService.recordAssetRequestObservability).
 * Here we add the daemon's verdict — which strategy each asset took, and
 * how many of them actually became part of the prompt (`resolved`). e2e
 * specs assert on `observability.assets.resolved` ≥ 1.
 *
 * Failure of this merge is non-fatal — the task is allowed to settle
 * regardless. Observability is supposed to make silent failures visible,
 * not become the new silent failure.
 */
/**
 * Build the `attachments` array for an `agent_reply` chat message from the
 * `task.dispatch.reply.assetIds` returned by the daemon. Cloud has the
 * authoritative IMAsset metadata (mime / kind / sizeBytes), so we hydrate
 * here instead of forwarding raw IDs and forcing the client to round-trip
 * for every thumbnail.
 *
 * Shape matches `parseAttachmentsFromMetadata` in
 * src/app/workspace/components/im-channel.tsx — `MessageAssetAttachment`
 * accepts both the singular `metadata.asset` (legacy user→agent path) and
 * plural `metadata.attachments[]` (this path). Title falls back to the
 * IMAsset.metadata.title set by the producer (OutboxWatcher, etc).
 *
 * Returns undefined when the input is empty or no assets resolved — caller
 * decides whether to omit the field entirely from the message metadata.
 */
async function buildAgentReplyAttachments(
  assetIds: readonly string[] | undefined,
): Promise<Array<Record<string, unknown>> | undefined> {
  if (!Array.isArray(assetIds) || assetIds.length === 0) return undefined;
  const dedup = Array.from(new Set(assetIds.filter((id): id is string => typeof id === 'string' && id.length > 0)));
  if (dedup.length === 0) return undefined;
  const rows = await prisma.iMAsset
    .findMany({
      where: { id: { in: dedup }, deletedAt: null },
      select: { id: true, mime: true, kind: true, sizeBytes: true, metadata: true },
    })
    .catch(
      () =>
        [] as Array<{
          id: string;
          mime: string | null;
          kind: string;
          sizeBytes: bigint | null;
          metadata: string | null;
        }>,
    );
  type AssetRow = { id: string; mime: string | null; kind: string; sizeBytes: bigint | null; metadata: string | null };
  const byId = new Map<string, AssetRow>(rows.map((r: AssetRow) => [r.id, r]));
  const out: Array<Record<string, unknown>> = [];
  for (const id of dedup) {
    const row = byId.get(id);
    if (!row) {
      log.warn({ assetId: id }, `agent_reply attachment: assetId ${id} not found in im_assets — dropping`);
      continue;
    }
    let title: string | null = null;
    try {
      const meta = row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : {};
      if (typeof meta.title === 'string' && meta.title) title = meta.title;
    } catch {
      // best-effort — metadata blob is owner-controlled
    }
    out.push({
      id,
      title: title ?? `[${row.kind}]`,
      mime: row.mime,
      kind: row.kind,
      sizeBytes: row.sizeBytes != null ? Number(row.sizeBytes) : null,
    });
  }
  return out.length > 0 ? out : undefined;
}

async function mergeAssetObservability(taskId: string, observations: AssetDispatchObservation[]): Promise<void> {
  try {
    const row = await prisma.iMTask.findUnique({
      where: { id: taskId },
      select: { metadata: true },
    });
    if (!row) return;
    let prev: Record<string, unknown> = {};
    try {
      prev = JSON.parse(row.metadata ?? '{}');
    } catch {
      prev = {};
    }
    const observability = (
      prev.observability && typeof prev.observability === 'object'
        ? { ...(prev.observability as Record<string, unknown>) }
        : {}
    ) as Record<string, unknown>;
    const assets = (
      observability.assets && typeof observability.assets === 'object'
        ? { ...(observability.assets as Record<string, unknown>) }
        : {}
    ) as Record<string, unknown>;
    const resolved = observations.filter((o) => o.strategy !== 'error').length;
    assets.strategies = observations;
    assets.resolved = resolved;
    observability.assets = assets;
    await prisma.iMTask.update({
      where: { id: taskId },
      data: { metadata: JSON.stringify({ ...prev, observability }) },
    });
  } catch (err) {
    log.warn(
      { err, taskId, count: observations.length },
      `failed to merge asset observability: ${(err as Error).message}`,
    );
  }
}
