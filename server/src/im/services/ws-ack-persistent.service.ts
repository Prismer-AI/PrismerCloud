/**
 * Prismer IM — Persistent WS ack tracker
 *
 * Spec: docs/release200/14-messaging-state-machine-reliability.md §4.5
 *
 * Companion to the in-memory `AckTracker` (src/im/ws/ack-tracker.ts).
 * In-memory tracker is the fast path (5s ACK_TIMEOUT, 5min undelivered
 * TTL, Pod-local). This service is the durable path — survives:
 *
 *   • Pod restart  — replay from DB on reconnect
 *   • Pod drift    — user reconnects to a different Pod, still sees pending
 *   • Backplane network split — DB is the source of truth
 *
 * Schema (migration 408 im_ws_acks):
 *   id           cuid
 *   userId       VARCHAR(40)
 *   ackId        VARCHAR(64)
 *   payloadJson  JSON  (the full event payload, includes ackId)
 *   createdAt    DATETIME(3)
 *   ackedAt      DATETIME(3) NULL — null = pending
 *
 * Only HIGH-PRIORITY event types are persisted (see HIGH_PRIORITY_TYPES).
 * Ephemeral / high-frequency events (typing.indicator, presence, stream
 * chunks) are NOT persisted — they're covered by the in-memory tracker
 * only since their value decays quickly.
 *
 * Public API:
 *   trackOutbound(userId, ackId, payload)     → INSERT pending
 *   markAcked(userId, ackId)                   → UPDATE ackedAt
 *   getUnacked(userId, sinceCursor?)           → SELECT pending
 *   cleanupExpired(ttlMs)                      → DELETE old rows
 *
 * Note: We deliberately do NOT cascade in-memory ackTracker.ack() into
 * this service from inside ackTracker.ack — handler.ts wires both
 * explicitly so single-pod tests can still run without DB.
 */

import { randomUUID } from 'node:crypto';
import prisma from '../db';

const log = (msg: string, ...args: unknown[]) => console.log(`[WSAckPersistent] ${msg}`, ...args);
const warn = (msg: string, ...args: unknown[]) => console.warn(`[WSAckPersistent] ${msg}`, ...args);

/**
 * Event types worth persisting. Anything outside this set is NOT written
 * to im_ws_acks — the in-memory tracker covers it.
 *
 * NB: keep in sync with §4.5 (high-priority unacked-on-reconnect replay):
 *   • message.new       — chat content
 *   • task.transitioned — state-machine transitions (B / B1)
 *   • task.dispatch.*   — multi-daemon binding fan-out (B2)
 *   • approval.created  — human-in-the-loop
 *   • memory.*          — durable evo signals worth replaying
 */
const HIGH_PRIORITY_TYPES = new Set<string>([
  'message.new',
  'task.transitioned',
  'task.dispatch.progress',
  'task.dispatch.reply',
  'approval.created',
  'approval.changed',
  'memory.write',
  'memory.recall',
]);

export function isHighPriorityEvent(payload: { type?: string } | Record<string, unknown>): boolean {
  const type = (payload as { type?: string }).type;
  return !!type && HIGH_PRIORITY_TYPES.has(type);
}

/** Default TTL for cleanup — 24h. Longer than in-memory 5min cap. */
export const PERSISTENT_ACK_TTL_MS = 24 * 60 * 60 * 1000;

export class WSAckPersistentService {
  /**
   * Persist an outbound ack-tracked message. Caller MUST have already
   * assigned ackId (typically by in-memory ackTracker.track()).
   *
   * Fire-and-forget: failures are logged but do NOT propagate — the
   * in-memory tracker still works.
   */
  async trackOutbound(userId: string, ackId: string, payload: Record<string, unknown>): Promise<void> {
    if (!isHighPriorityEvent(payload)) return;
    try {
      await prisma.iMWSAck.create({
        data: {
          id: randomUUID().replace(/-/g, '').slice(0, 25),
          userId,
          ackId,
          payloadJson: payload as object,
          // createdAt → default(now())
        },
      });
    } catch (err) {
      warn(`trackOutbound failed userId=${userId} ackId=${ackId}:`, (err as Error).message);
    }
  }

  /**
   * Mark an ack as received. Idempotent — if the row doesn't exist
   * (e.g. ephemeral event that was never persisted), this is a no-op.
   */
  async markAcked(userId: string, ackId: string): Promise<void> {
    try {
      await prisma.iMWSAck.updateMany({
        where: { userId, ackId, ackedAt: null },
        data: { ackedAt: new Date() },
      });
    } catch (err) {
      warn(`markAcked failed userId=${userId} ackId=${ackId}:`, (err as Error).message);
    }
  }

  /**
   * Fetch all pending (un-acked) events for a user since an optional cursor.
   * Used on WS reconnect to replay missed events.
   *
   * @param sinceCursor  ISO datetime; rows with createdAt > cursor returned.
   *                     If omitted, returns ALL pending rows (capped to limit).
   * @param limit        max rows (default 100) — same as in-memory cap.
   */
  async getUnacked(
    userId: string,
    sinceCursor?: Date,
    limit: number = 100,
  ): Promise<Array<{ id: string; ackId: string; payload: Record<string, unknown>; createdAt: Date }>> {
    try {
      const rows = await prisma.iMWSAck.findMany({
        where: {
          userId,
          ackedAt: null,
          ...(sinceCursor ? { createdAt: { gt: sinceCursor } } : {}),
        },
        orderBy: { createdAt: 'asc' },
        take: limit,
      });
      return rows.map(
        (r: { id: string; ackId: string; payloadJson: unknown; createdAt: Date }) => ({
          id: r.id,
          ackId: r.ackId,
          payload: r.payloadJson as Record<string, unknown>,
          createdAt: r.createdAt,
        }),
      );
    } catch (err) {
      warn(`getUnacked failed userId=${userId}:`, (err as Error).message);
      return [];
    }
  }

  /**
   * Cleanup expired rows. Deletes:
   *   • acked rows older than `ttlMs`     (free up acked history)
   *   • pending rows older than `ttlMs`   (give up — client likely gone)
   *
   * Called periodically by SchedulerService (sibling to other cleanup ticks).
   */
  async cleanupExpired(ttlMs: number = PERSISTENT_ACK_TTL_MS): Promise<number> {
    const cutoff = new Date(Date.now() - ttlMs);
    try {
      const res = await prisma.iMWSAck.deleteMany({
        where: { createdAt: { lt: cutoff } },
      });
      if (res.count > 0) log(`cleanup deleted ${res.count} rows older than ${cutoff.toISOString()}`);
      return res.count;
    } catch (err) {
      warn(`cleanupExpired failed:`, (err as Error).message);
      return 0;
    }
  }

  /** Stats for /metrics. */
  async getStats(): Promise<{ pendingCount: number; totalCount: number }> {
    try {
      const [pendingCount, totalCount] = await Promise.all([
        prisma.iMWSAck.count({ where: { ackedAt: null } }),
        prisma.iMWSAck.count(),
      ]);
      return { pendingCount, totalCount };
    } catch {
      return { pendingCount: 0, totalCount: 0 };
    }
  }
}
