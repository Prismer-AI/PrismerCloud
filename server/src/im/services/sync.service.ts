/**
 * Prismer IM — Sync Service
 *
 * Manages sync events for offline-first SDK clients.
 * Writes events when messages/conversations change,
 * and serves them via cursor-based incremental sync.
 *
 * v2.0 §4.1 reliability rework
 *  - `writeEvent` allocates a per-conversation monotonic `boundarySeq` inside
 *    the caller's transaction (when `conversationId` is provided AND a
 *    `tx` client is passed). Allocation uses MySQL `LAST_INSERT_ID(1)` on the
 *    `im_conversation_seq` counter table — must run inside a tx (per-session
 *    state, see §4.1 Critical Invariant).
 *  - Redis publish is NO LONGER inline. The row is written with
 *    `publishedAt = NULL`; the `SyncPublisher` worker scans pending rows and
 *    publishes via `publishPending` below. This breaks the fire-and-forget
 *    pattern so a publish failure no longer silently loses an event.
 *  - The published payload still ships the legacy `seq` field (= row.id) so
 *    existing subscribers don't break; `boundarySeq` is added alongside for
 *    new clients to gap-detect per-conversation.
 */

import type Redis from 'ioredis';
import prisma from '../db';

const SYNC_CHANNEL_PREFIX = 'im:sync:';

/** Prisma transaction client surface we touch (kept loose since `prisma` is `any`). */
type TxClient = {
  $executeRaw: (...args: any[]) => Promise<any>;
  $queryRaw: <T>(...args: any[]) => Promise<T>;
  iMSyncEvent: {
    create: (args: any) => Promise<any>;
  };
};

/**
 * Atomically allocate the next per-conversation seq.
 *
 * MUST run inside `prisma.$transaction` — `LAST_INSERT_ID` is per-session
 * state. See §4.1 Critical Invariant and `scripts/exp-seq2.ts` reviewer
 * experiment (no-tx mode produces 167/200 dup + 167/200 gap).
 *
 * The INSERT path uses `LAST_INSERT_ID(1)` explicitly (not literal `1`) so
 * the first-insert path populates the session slot — otherwise the first
 * call would return 0 instead of 1.
 */
export async function nextConversationSeq(tx: TxClient, conversationId: string): Promise<bigint> {
  // $executeRaw with template-tag form for parameter binding safety.
  await tx.$executeRaw`
    INSERT INTO im_conversation_seq (conversationId, seq)
    VALUES (${conversationId}, LAST_INSERT_ID(1))
    ON DUPLICATE KEY UPDATE seq = LAST_INSERT_ID(seq + 1)
  `;
  const rows = await tx.$queryRaw<Array<{ seq: bigint | number }>>`SELECT LAST_INSERT_ID() AS seq`;
  const raw = rows?.[0]?.seq;
  // MySQL driver may surface BIGINT as number for small values; normalise.
  if (typeof raw === 'bigint') return raw;
  if (typeof raw === 'number') return BigInt(raw);
  return BigInt(String(raw ?? 0));
}

export class SyncService {
  private redis?: Redis;

  /** Attach Redis for real-time event push to SSE clients. */
  setRedis(redis: Redis): void {
    this.redis = redis;
  }

  /** Underlying Redis handle (used by publisher worker — no caller else). */
  getRedis(): Redis | undefined {
    return this.redis;
  }

  /**
   * Write a sync event row.
   *
   * Two modes:
   *   1. `tx` + `conversationId` → allocates per-conversation `boundarySeq`
   *      in the same transaction. Used by message.service.sendMessage and
   *      any other path that needs per-conversation gap detection.
   *   2. No `tx` (or no `conversationId`) → fallback path; boundarySeq stays
   *      NULL. Subscribers without seq will fall back to id-based ordering.
   *
   * Either way, `publishedAt` is left NULL; the SyncPublisher worker
   * (sync-publisher.service.ts) fans out to Redis.
   */
  async writeEvent(
    type: string,
    data: Record<string, unknown>,
    conversationId: string | null,
    imUserId: string,
    tx?: TxClient,
  ): Promise<void> {
    if (tx && conversationId) {
      const boundarySeq = await nextConversationSeq(tx, conversationId);
      await tx.iMSyncEvent.create({
        data: {
          type,
          data: JSON.stringify(data),
          conversationId,
          imUserId,
          boundarySeq,
          // publishedAt left NULL — publisher worker handles fan-out
        },
      });
      return;
    }

    // Fallback (no tx OR no conversationId) — write without per-conv seq.
    await prisma.iMSyncEvent.create({
      data: {
        type,
        data: JSON.stringify(data),
        conversationId,
        imUserId,
      },
    });
  }

  /**
   * Publish one persisted sync_event row to all per-recipient Redis channels.
   *
   * Called by the SyncPublisher worker. Caller is responsible for stamping
   * `publishedAt` after this resolves and incrementing `publishRetries` on
   * failure.
   */
  async publishPending(record: {
    id: number;
    type: string;
    data: string;
    conversationId: string | null;
    boundarySeq: bigint | number | null;
    imUserId: string;
    createdAt: Date;
  }): Promise<void> {
    if (!this.redis) {
      throw new Error('Redis not configured');
    }

    const event = {
      // Legacy field — id-based cursor. Existing subscribers depend on this.
      seq: record.id,
      // v2.0 §4.1: per-conversation monotonic seq for gap detection.
      boundarySeq: record.boundarySeq != null ? Number(record.boundarySeq) : null,
      type: record.type,
      data: JSON.parse(record.data),
      conversationId: record.conversationId,
      at: record.createdAt.toISOString(),
    };
    const payload = JSON.stringify(event);

    // Fan out per-recipient. Author + every conversation participant gets a
    // copy (D-γ-2 acceptance contract — admintest2 must see admintest1's
    // message even though only admintest1's userId is on the row).
    const recipientIds = new Set<string>([record.imUserId]);
    if (record.conversationId) {
      const participants = await prisma.iMParticipant.findMany({
        where: { conversationId: record.conversationId, leftAt: null },
        select: { imUserId: true },
      });
      for (const p of participants) recipientIds.add(p.imUserId);
    }

    await Promise.all([...recipientIds].map((rid) => this.redis!.publish(`${SYNC_CHANNEL_PREFIX}${rid}`, payload)));
  }

  /**
   * Get sync events after a cursor (auto-increment ID).
   * Only returns events for conversations the user participates in.
   *
   * Used by the legacy id-based catch-up endpoint (GET /sync).
   */
  async getEvents(
    since: number,
    limit: number,
    imUserId: string,
  ): Promise<{
    events: Array<{
      seq: number;
      boundarySeq: number | null;
      type: string;
      data: any;
      conversationId: string | null;
      at: string;
    }>;
    cursor: number;
    hasMore: boolean;
  }> {
    // Get conversations the user is part of
    const participations = await prisma.iMParticipant.findMany({
      where: { imUserId, leftAt: null },
      select: { conversationId: true },
    });
    const convIds = participations.map((p: { conversationId: string }) => p.conversationId);

    const events = await prisma.iMSyncEvent.findMany({
      where: {
        id: { gt: since },
        OR: [
          { conversationId: { in: convIds } },
          { imUserId }, // User's own events (always visible)
        ],
      },
      orderBy: { id: 'asc' },
      take: limit + 1,
    });

    const hasMore = events.length > limit;
    const batch = hasMore ? events.slice(0, limit) : events;
    const cursor = batch.length > 0 ? batch[batch.length - 1].id : since;

    return {
      events: batch.map(
        (e: {
          id: number;
          type: string;
          data: string;
          conversationId: string | null;
          boundarySeq: bigint | number | null;
          createdAt: Date;
        }) => ({
          seq: e.id,
          boundarySeq: e.boundarySeq != null ? Number(e.boundarySeq) : null,
          type: e.type,
          data: JSON.parse(e.data),
          conversationId: e.conversationId,
          at: e.createdAt.toISOString(),
        }),
      ),
      cursor,
      hasMore,
    };
  }

  /**
   * v2.0 §4.1 — per-conversation gap-fill endpoint backend.
   *
   * Returns events for ONE conversation with `boundarySeq > afterSeq`,
   * ordered by boundarySeq ASC. Used by `useReconciledStream` when the
   * client detects a seq gap from SSE.
   *
   * Caller must already have authorised participation (see api/sync.ts).
   */
  async getEventsByConversation(
    conversationId: string,
    afterSeq: number,
    limit: number,
  ): Promise<{
    events: Array<{
      id: number;
      boundarySeq: number;
      type: string;
      data: any;
      conversationId: string;
      at: string;
    }>;
    hasMore: boolean;
    cursor: number;
  }> {
    const events = await prisma.iMSyncEvent.findMany({
      where: {
        conversationId,
        boundarySeq: { gt: BigInt(afterSeq) },
      },
      orderBy: { boundarySeq: 'asc' },
      take: limit + 1,
    });

    const hasMore = events.length > limit;
    const batch = hasMore ? events.slice(0, limit) : events;
    const last = batch[batch.length - 1];
    const cursor = last ? Number(last.boundarySeq) : afterSeq;

    return {
      events: batch.map(
        (e: {
          id: number;
          type: string;
          data: string;
          conversationId: string | null;
          boundarySeq: bigint | number | null;
          createdAt: Date;
        }) => ({
          id: e.id,
          boundarySeq: Number(e.boundarySeq ?? 0),
          type: e.type,
          data: JSON.parse(e.data),
          conversationId: e.conversationId as string,
          at: e.createdAt.toISOString(),
        }),
      ),
      hasMore,
      cursor,
    };
  }
}
