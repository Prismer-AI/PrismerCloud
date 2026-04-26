/**
 * Prismer IM — Room / Channel manager
 *
 * Manages WebSocket connections grouped by conversation (room).
 * Supports Redis pub/sub for multi-instance (multi-Pod) broadcasting.
 *
 * With Redis: local delivery + publish to channel → other Pods deliver locally.
 * Without Redis: pure in-memory (single-instance mode).
 */

import crypto from 'node:crypto';
import type Redis from 'ioredis';
import type { Transport } from './transport';
import type { WSMessage } from '../types/index';
import type { AckTracker } from './ack-tracker';

const CHANNEL = 'im:broadcast';

interface RedisBroadcast {
  src: string;
  scope: 'room' | 'user' | 'global';
  target?: string;
  exclude?: string;
  event: WSMessage;
}

export interface ConnectedClient {
  transport: Transport;
  userId: string;
  username: string;
  connectedAt: number;
}

export class RoomManager {
  /** conversationId → Set<userId> */
  private rooms = new Map<string, Set<string>>();
  /** userId → Set<ConnectedClient> (one user can have multiple connections) */
  private clients = new Map<string, Set<ConnectedClient>>();

  /** Unique ID for this process instance (used to skip own Redis messages) */
  private instanceId = crypto.randomUUID();
  private redis?: Redis;
  private subscriber?: Redis;
  private ackTracker?: AckTracker;

  constructor(redis?: Redis) {
    if (!redis) return;

    if (redis.status === 'ready') {
      this.setupRedis(redis);
    } else {
      redis.once('connect', () => this.setupRedis(redis));
    }
  }

  private setupRedis(redis: Redis): void {
    this.redis = redis;
    this.subscriber = redis.duplicate();
    this.subscriber.subscribe(CHANNEL);
    this.subscriber.on('message', (_ch: string, raw: string) => {
      try {
        const msg: RedisBroadcast = JSON.parse(raw);
        if (msg.src === this.instanceId) return;
        this.deliverLocally(msg);
      } catch {
        /* malformed message — ignore */
      }
    });
    console.log(`[RoomManager] Redis pub/sub ready (instance: ${this.instanceId.slice(0, 8)})`);
  }

  /**
   * Attach an AckTracker to wrap outbound messages with ackId.
   * Messages that require ACK will have ackId injected into their payload.
   */
  setAckTracker(tracker: AckTracker): void {
    this.ackTracker = tracker;
  }

  // ─── Client management (unchanged) ─────────────────────────

  private static readonly MAX_CONNECTIONS_PER_USER = 5;

  addClient(client: ConnectedClient): void {
    const existing = this.clients.get(client.userId);
    if (existing) {
      // Evict oldest connection if at limit
      if (existing.size >= RoomManager.MAX_CONNECTIONS_PER_USER) {
        let oldest: ConnectedClient | null = null;
        for (const c of existing) {
          if (!oldest || c.connectedAt < oldest.connectedAt) oldest = c;
        }
        if (oldest) {
          oldest.transport.send(
            JSON.stringify({ type: 'error', data: { message: 'Connection replaced by newer client' } }),
          );
          oldest.transport.close();
          existing.delete(oldest);
        }
      }
      existing.add(client);
    } else {
      this.clients.set(client.userId, new Set([client]));
    }
  }

  removeClient(client: ConnectedClient): void {
    const existing = this.clients.get(client.userId);
    if (existing) {
      existing.delete(client);
      if (existing.size === 0) {
        this.clients.delete(client.userId);
        for (const [, members] of this.rooms) {
          members.delete(client.userId);
        }
        // Clean up empty rooms
        for (const [roomId, members] of this.rooms) {
          if (members.size === 0) this.rooms.delete(roomId);
        }
      }
    }
  }

  joinRoom(conversationId: string, userId: string): void {
    const room = this.rooms.get(conversationId);
    if (room) {
      room.add(userId);
    } else {
      this.rooms.set(conversationId, new Set([userId]));
    }
  }

  leaveRoom(conversationId: string, userId: string): void {
    const room = this.rooms.get(conversationId);
    if (room) {
      room.delete(userId);
      if (room.size === 0) this.rooms.delete(conversationId);
    }
  }

  getRoomMembers(conversationId: string): Set<string> {
    return this.rooms.get(conversationId) ?? new Set();
  }

  getClientConnections(userId: string): Set<ConnectedClient> {
    return this.clients.get(userId) ?? new Set();
  }

  isOnline(userId: string): boolean {
    const conns = this.clients.get(userId);
    return !!conns && conns.size > 0;
  }

  // ─── Broadcasting (local + Redis pub/sub) ───────────────────

  /**
   * Send an event to all clients in a room (local + cross-Pod).
   */
  broadcastToRoom(conversationId: string, event: WSMessage, excludeUserId?: string): void {
    this.localBroadcastToRoom(conversationId, event, excludeUserId);
    this.publish({ scope: 'room', target: conversationId, exclude: excludeUserId, event });
  }

  /**
   * Send an event to a specific user's connections (local + cross-Pod).
   */
  sendToUser(userId: string, event: WSMessage): void {
    this.localSendToUser(userId, event);
    this.publish({ scope: 'user', target: userId, event });
  }

  /**
   * Broadcast an event to ALL connected clients (local + cross-Pod).
   */
  broadcastGlobal(event: WSMessage): void {
    this.localBroadcastGlobal(event);
    this.publish({ scope: 'global', event });
  }

  // ─── Local delivery (same Pod only) ─────────────────────────

  private localBroadcastToRoom(conversationId: string, event: WSMessage, excludeUserId?: string): void {
    const members = this.rooms.get(conversationId);
    if (!members) return;

    for (const userId of members) {
      if (userId === excludeUserId) continue;
      const connections = this.clients.get(userId);
      if (!connections) continue;

      // If ACK tracker is attached, wrap the event with an ackId per user
      let payload: string;
      if (this.ackTracker) {
        const ackId = this.ackTracker.track(userId, event as unknown as Record<string, unknown>);
        payload = ackId ? JSON.stringify({ ...event, ackId }) : JSON.stringify(event);
      } else {
        payload = JSON.stringify(event);
      }

      for (const client of connections) {
        if (client.transport.readyState === 1) {
          client.transport.send(payload);
        }
      }
    }
  }

  private localSendToUser(userId: string, event: WSMessage): void {
    const connections = this.clients.get(userId);
    if (!connections) return;

    // If ACK tracker is attached, wrap the event with an ackId
    let payload: string;
    if (this.ackTracker) {
      const ackId = this.ackTracker.track(userId, event as unknown as Record<string, unknown>);
      payload = ackId ? JSON.stringify({ ...event, ackId }) : JSON.stringify(event);
    } else {
      payload = JSON.stringify(event);
    }

    for (const client of connections) {
      if (client.transport.readyState === 1) {
        client.transport.send(payload);
      }
    }
  }

  private localBroadcastGlobal(event: WSMessage): void {
    const payload = JSON.stringify(event);
    for (const connections of this.clients.values()) {
      for (const client of connections) {
        if (client.transport.readyState === 1) {
          client.transport.send(payload);
        }
      }
    }
  }

  // ─── Redis pub/sub ──────────────────────────────────────────

  private deliverLocally(msg: RedisBroadcast): void {
    switch (msg.scope) {
      case 'room':
        this.localBroadcastToRoom(msg.target!, msg.event, msg.exclude);
        break;
      case 'user':
        this.localSendToUser(msg.target!, msg.event);
        break;
      case 'global':
        this.localBroadcastGlobal(msg.event);
        break;
    }
  }

  private publish(msg: Omit<RedisBroadcast, 'src'>): void {
    if (!this.redis || this.redis.status !== 'ready') return;
    try {
      this.redis.publish(CHANNEL, JSON.stringify({ ...msg, src: this.instanceId }));
    } catch {
      /* Redis unavailable — local delivery only */
    }
  }

  // ─── Stats ──────────────────────────────────────────────────

  get onlineCount(): number {
    return this.clients.size;
  }

  getStats() {
    let totalConnections = 0;
    for (const conns of this.clients.values()) {
      totalConnections += conns.size;
    }
    return {
      onlineUsers: this.clients.size,
      totalConnections,
      activeRooms: this.rooms.size,
    };
  }
}
