/**
 * Prismer IM — Sync Service
 *
 * Manages sync events for offline-first SDK clients.
 * Writes events when messages/conversations change,
 * and serves them via cursor-based incremental sync.
 *
 * Supports real-time push via Redis pub/sub for SSE sync/stream.
 */

import type Redis from 'ioredis';
import prisma from '../db';

const SYNC_CHANNEL_PREFIX = 'im:sync:';

export class SyncService {
  private redis?: Redis;

  /** Attach Redis for real-time event push to SSE clients. */
  setRedis(redis: Redis): void {
    this.redis = redis;
  }

  /**
   * Write a sync event after a message or conversation mutation.
   * Publishes to Redis channel for SSE subscribers.
   */
  async writeEvent(
    type: string,
    data: Record<string, unknown>,
    conversationId: string | null,
    imUserId: string,
  ): Promise<void> {
    const record = await prisma.iMSyncEvent.create({
      data: {
        type,
        data: JSON.stringify(data),
        conversationId,
        imUserId,
      },
    });

    // Publish to Redis for SSE sync/stream subscribers
    if (this.redis) {
      const event = {
        seq: record.id,
        type,
        data,
        conversationId,
        at: record.createdAt.toISOString(),
      };
      this.redis.publish(
        `${SYNC_CHANNEL_PREFIX}${imUserId}`,
        JSON.stringify(event),
      ).catch(() => { /* non-fatal */ });
    }
  }

  /**
   * Get sync events after a cursor (auto-increment ID).
   * Only returns events for conversations the user participates in.
   */
  async getEvents(
    since: number,
    limit: number,
    imUserId: string,
  ): Promise<{
    events: Array<{ seq: number; type: string; data: any; conversationId: string | null; at: string }>;
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
      events: batch.map((e: { id: number; type: string; data: string; conversationId: string | null; createdAt: Date }) => ({
        seq: e.id,
        type: e.type,
        data: JSON.parse(e.data),
        conversationId: e.conversationId,
        at: e.createdAt.toISOString(),
      })),
      cursor,
      hasMore,
    };
  }
}
