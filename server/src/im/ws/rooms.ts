/**
 * Prismer IM — Room / Channel manager
 *
 * Manages WebSocket connections grouped by conversation (room).
 * Supports Redis pub/sub for multi-instance (multi-Pod) broadcasting.
 *
 * With Redis: local delivery + publish to channel → other Pods deliver locally.
 * Without Redis: pure in-memory (single-instance mode).
 *
 * Wave-4 E3 (§4.5): cross-Pod unicast routes via `Backplane.sendToPod`
 * instead of fan-out pub/sub. `im:user:<userId>:pods` Redis SET tracks
 * which Pods a user is connected to; sendToUser queries it and dispatches
 * via backplane to each remote Pod (or local-only if user is on this Pod).
 */

import crypto from 'node:crypto';
import type Redis from 'ioredis';
import type { Transport } from './transport';
import type { WSMessage } from '../types/index';
import type { AckTracker } from './ack-tracker';
import type { Backplane } from '../backplane';
import { getPodId, userPodsKey } from '../backplane';

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
  /** Per-Pod ID (env POD_ID / HOSTNAME). Used by §4.5 cross-Pod unicast. */
  private podId = getPodId();
  private redis?: Redis;
  private subscriber?: Redis;
  private ackTracker?: AckTracker;
  /** §4.5 Backplane — cross-Pod unicast via per-Pod streams. */
  private backplane?: Backplane;
  /** Hook fired on local sendToUser — wired by handler.ts for persistent ack. */
  private onLocalSendToUser?: (userId: string, event: WSMessage) => void;

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

  /**
   * §4.5 — attach the Backplane for cross-Pod unicast. When set,
   * `sendToUser` queries `im:user:<userId>:pods` and forwards via
   * `backplane.sendToPod` to remote Pods. Required for multi-instance
   * deployments; optional for single-Pod dev (memory-backplane fallback).
   */
  setBackplane(backplane: Backplane): void {
    this.backplane = backplane;
  }

  /**
   * Get this Pod's ID — used by handler.ts to record SADD on connect
   * and SREM on disconnect via {@link onClientConnected} / {@link onClientDisconnected}.
   */
  getPodId(): string {
    return this.podId;
  }

  /**
   * Hook for handler.ts — called on every local (this-Pod) sendToUser
   * dispatch, BEFORE serialization. Used by the WS handler to mirror
   * high-priority events into the persistent ack DB. Pure side-channel —
   * does not affect delivery.
   */
  setLocalSendHook(hook: (userId: string, event: WSMessage) => void): void {
    this.onLocalSendToUser = hook;
  }

  /**
   * §4.5 — record this Pod in the user's pod-membership set. Idempotent
   * SADD; safe to call on every WS authenticate.
   */
  async onClientConnected(userId: string): Promise<void> {
    if (!this.redis || this.redis.status !== 'ready') return;
    try {
      await this.redis.sadd(userPodsKey(userId), this.podId);
      // Optional TTL refresh — 1h is plenty since we re-SADD on every auth.
      await this.redis.expire(userPodsKey(userId), 3600);
    } catch (err) {
      // Non-fatal — local delivery still works.
      console.warn('[RoomManager] onClientConnected SADD failed:', (err as Error).message);
    }
  }

  /**
   * §4.5 — remove this Pod from the user's pod-membership set, but only
   * if this was the user's LAST connection on this Pod. Caller (handler.ts)
   * must check `isOnline(userId)` AFTER removeClient and pass the result.
   */
  async onClientDisconnected(userId: string, wasLastConn: boolean): Promise<void> {
    if (!wasLastConn) return;
    if (!this.redis || this.redis.status !== 'ready') return;
    try {
      await this.redis.srem(userPodsKey(userId), this.podId);
    } catch (err) {
      console.warn('[RoomManager] onClientDisconnected SREM failed:', (err as Error).message);
    }
  }

  /**
   * §4.5 — register this Pod's inbound channel handler. Called once at
   * startup by server.ts. Incoming payloads are JSON
   * `{targetUserId: string, event: WSMessage}` and get delivered locally
   * (the sending Pod has already verified the user is NOT on its own Pod
   * before unicasting).
   */
  async registerPodChannel(): Promise<void> {
    if (!this.backplane) return;
    await this.backplane.registerPodChannel(this.podId, (raw) => {
      try {
        const { targetUserId, event } = JSON.parse(raw) as { targetUserId: string; event: WSMessage };
        if (!targetUserId || !event) return;
        // Deliver to local connections only; never re-publish.
        this.localSendToUser(targetUserId, event, { skipBackplane: true });
      } catch (err) {
        console.warn('[RoomManager] pod-channel inbound parse error:', (err as Error).message);
      }
    });
    console.log(`[RoomManager] pod channel registered: pod=${this.podId}`);
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
   *
   * §4.5: cross-Pod fan-out is unicast via the Backplane when available.
   * Falls back to legacy Redis pub/sub if no backplane is wired (transition
   * period — eventually pub/sub can be removed once all Pods are E3-aware).
   */
  sendToUser(userId: string, event: WSMessage): void {
    this.localSendToUser(userId, event);

    if (this.backplane && this.redis && this.redis.status === 'ready') {
      // Async — never block the caller; deliver out-of-band via per-Pod streams.
      void this.crossPodSendToUser(userId, event).catch((err) =>
        console.warn('[RoomManager] crossPodSendToUser failed:', (err as Error).message),
      );
    } else {
      // Legacy path: broadcast pub/sub. Every Pod receives + filters by userId.
      this.publish({ scope: 'user', target: userId, event });
    }
  }

  /**
   * §4.5 unicast fan-out via Backplane streams.
   * Reads `im:user:<userId>:pods` (SET maintained by onClientConnected /
   * onClientDisconnected) and posts to each remote Pod's queue.
   *
   * Skips ME — we already delivered locally above.
   */
  private async crossPodSendToUser(userId: string, event: WSMessage): Promise<void> {
    if (!this.backplane || !this.redis) return;
    let pods: string[] = [];
    try {
      pods = await this.redis.smembers(userPodsKey(userId));
    } catch (err) {
      console.warn('[RoomManager] SMEMBERS failed:', (err as Error).message);
      return;
    }
    const remote = pods.filter((p) => p && p !== this.podId);
    if (remote.length === 0) return;

    const payload = JSON.stringify({ targetUserId: userId, event });
    await Promise.all(
      remote.map((p) =>
        this.backplane!.sendToPod(p, payload).catch((err) =>
          console.warn(`[RoomManager] sendToPod ${p} failed:`, (err as Error).message),
        ),
      ),
    );
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

  private localSendToUser(userId: string, event: WSMessage, opts?: { skipBackplane?: boolean }): void {
    const connections = this.clients.get(userId);
    if (!connections) return;

    // If ACK tracker is attached, wrap the event with an ackId
    let payload: string;
    let trackedEvent: WSMessage = event;
    if (this.ackTracker) {
      const ackId = this.ackTracker.track(userId, event as unknown as Record<string, unknown>);
      if (ackId) {
        trackedEvent = { ...event, ackId } as WSMessage;
        payload = JSON.stringify(trackedEvent);
      } else {
        payload = JSON.stringify(event);
      }
    } else {
      payload = JSON.stringify(event);
    }

    // Persistent-ack mirror hook (handler.ts wires this on startup).
    // skipBackplane=true → we're delivering an inbound forward from another
    // Pod; the originating Pod already persisted. Avoid double-write.
    if (this.onLocalSendToUser && !opts?.skipBackplane) {
      try {
        this.onLocalSendToUser(userId, trackedEvent);
      } catch (err) {
        console.warn('[RoomManager] onLocalSendToUser hook error:', (err as Error).message);
      }
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
        // Inbound from legacy pub/sub — originating Pod already mirrored
        // the event to im_ws_acks, skip the local hook.
        this.localSendToUser(msg.target!, msg.event, { skipBackplane: true });
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
