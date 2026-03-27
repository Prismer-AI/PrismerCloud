/**
 * Prismer IM — SSE (Server-Sent Events) connection handler
 *
 * Provides a read-only push channel for clients that cannot use WebSocket.
 * Clients connect via GET /sse?token=<JWT> and receive the same server→client
 * events as WebSocket (message.new, typing.indicator, presence.changed, etc.).
 *
 * Client→server actions (sending messages, typing indicators) still go
 * through regular HTTP POST endpoints (/api/im/direct/{id}/messages, etc.).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { verifyToken } from '../auth/jwt';
import { SSETransport } from '../ws/transport';
import { ServerEvents } from '../ws/events';
import type { RoomManager, ConnectedClient } from '../ws/rooms';
import type { ConversationService } from '../services/conversation.service';
import type { PresenceService } from '../services/presence.service';

export interface SSEDeps {
  rooms: RoomManager;
  conversationService: ConversationService;
  presenceService: PresenceService;
}

export function handleSSEConnection(
  req: IncomingMessage,
  res: ServerResponse,
  deps: SSEDeps
): void {
  const url = new URL(req.url || '/', 'http://localhost');
  const token = url.searchParams.get('token');

  if (!token) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Token required (?token=<JWT>)' }));
    return;
  }

  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Invalid or expired token' }));
    return;
  }

  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // Disable nginx/proxy buffering
  });

  const transport = new SSETransport(res);
  const client: ConnectedClient = {
    transport,
    userId: payload.sub,
    username: payload.username,
    connectedAt: Date.now(),
  };

  // Register with RoomManager — broadcasts will automatically reach this client
  deps.rooms.addClient(client);
  deps.presenceService.setOnline(payload.sub);

  // Send authenticated event
  transport.send(JSON.stringify(ServerEvents.authenticated(payload.sub)));

  console.log(`[SSE] Connected: ${payload.username} (${payload.sub})`);

  // Auto-join user's conversations
  deps.conversationService
    .listByUser(payload.sub)
    .then((participations) => {
      for (const p of participations) {
        deps.rooms.joinRoom(p.conversation.id, payload.sub);
      }
    })
    .catch((err) => {
      console.error('[SSE] Error auto-joining conversations:', err);
    });

  // Heartbeat to keep connection alive (every 30s)
  const heartbeat = setInterval(() => {
    if (transport.readyState !== 1) {
      clearInterval(heartbeat);
      return;
    }
    // SSE comment — keeps the connection alive through proxies
    res.write(': heartbeat\n\n');
  }, 30_000);

  // Cleanup on disconnect
  res.on('close', () => {
    clearInterval(heartbeat);
    deps.rooms.removeClient(client);
    deps.presenceService.setOffline(payload.sub);
    console.log(`[SSE] Disconnected: ${payload.username} (${payload.sub})`);
  });
}
