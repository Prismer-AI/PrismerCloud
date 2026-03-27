/**
 * Prismer IM — SSE Sync Stream
 *
 * Real-time sync event push via Server-Sent Events.
 * Clients connect, catch up from their cursor, then receive
 * new events in real-time via Redis pub/sub.
 *
 * GET /api/im/sync/stream?token=<JWT>&since=<cursor>
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type Redis from 'ioredis';
import { verifyToken } from '../auth/jwt';
import type { SyncService } from '../services/sync.service';

const SYNC_CHANNEL_PREFIX = 'im:sync:';
const HEARTBEAT_INTERVAL = 25_000;

export interface SyncStreamDeps {
  redis: Redis;
  syncService: SyncService;
}

export function createSyncStreamRouter(deps: SyncStreamDeps): Hono {
  const router = new Hono();

  /**
   * GET /stream — SSE sync stream
   *
   * Query params:
   *   token  — JWT auth token
   *   since  — cursor (auto-increment ID), default 0
   */
  router.get('/stream', (c) => {
    const token = c.req.query('token');
    if (!token) {
      return c.json({ ok: false, error: 'Token required (?token=<JWT>)' }, 401);
    }

    let payload;
    try {
      payload = verifyToken(token);
    } catch {
      return c.json({ ok: false, error: 'Invalid or expired token' }, 401);
    }

    const userId = payload.sub;
    const since = parseInt(c.req.query('since') ?? '0', 10);

    return streamSSE(c, async (stream) => {
      let cursor = since;
      let subscriber: Redis | null = null;

      // Phase 1: Catch up — send all events since cursor
      try {
        let hasMore = true;
        while (hasMore) {
          const result = await deps.syncService.getEvents(cursor, 100, userId);
          for (const event of result.events) {
            await stream.writeSSE({
              data: JSON.stringify(event),
              event: 'sync',
              id: String(event.seq),
            });
          }
          cursor = result.cursor;
          hasMore = result.hasMore;
        }

        // Send caught-up marker
        await stream.writeSSE({
          data: JSON.stringify({ cursor }),
          event: 'caught_up',
        });
      } catch (err) {
        console.error('[SyncStream] Catch-up error:', err);
        await stream.writeSSE({
          data: JSON.stringify({ error: 'Catch-up failed' }),
          event: 'error',
        });
        return;
      }

      // Phase 2: Subscribe to Redis for real-time events
      try {
        subscriber = deps.redis.duplicate();
        const channel = `${SYNC_CHANNEL_PREFIX}${userId}`;
        await subscriber.subscribe(channel);

        subscriber.on('message', async (_ch: string, raw: string) => {
          try {
            const event = JSON.parse(raw);
            // Only forward events newer than our cursor
            if (event.seq > cursor) {
              await stream.writeSSE({
                data: raw,
                event: 'sync',
                id: String(event.seq),
              });
              cursor = event.seq;
            }
          } catch {
            // Ignore parse errors
          }
        });
      } catch (err) {
        console.error('[SyncStream] Redis subscribe error:', err);
        // Fall back to polling-like behavior — no real-time, but catch-up worked
      }

      // Phase 3: Heartbeat to keep connection alive
      const heartbeat = setInterval(async () => {
        try {
          await stream.writeSSE({ data: '', event: 'heartbeat' });
        } catch {
          clearInterval(heartbeat);
        }
      }, HEARTBEAT_INTERVAL);

      // Cleanup on disconnect
      stream.onAbort(() => {
        clearInterval(heartbeat);
        if (subscriber) {
          subscriber.unsubscribe().catch(() => {});
          subscriber.disconnect();
        }
      });

      // Keep the stream alive — wait for abort
      await new Promise<void>((resolve) => {
        stream.onAbort(resolve);
      });

      clearInterval(heartbeat);
      if (subscriber) {
        subscriber.unsubscribe().catch(() => {});
        subscriber.disconnect();
      }
    });
  });

  return router;
}
