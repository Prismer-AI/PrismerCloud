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
import prisma from '../db';

const SYNC_CHANNEL_PREFIX = 'im:sync:';
const HEARTBEAT_INTERVAL = 25_000;

/**
 * P2 (2026-05-25) — defensive cap on cursor-based replay. A 24h-stale
 * client that requests `since=<very-old-seq>` should not be allowed to
 * paginate through the entire IMSyncEvent table for that user; we drain
 * at most this many events, then drop the connection with a
 * `sync.backfill.truncated` envelope so the client can either reconnect
 * from the newest replayed seq or do a full bootstrap refresh.
 *
 * Don't bump without consulting P2 design — 500 covers ~24h of typical
 * fan-out for an active workspace user.
 */
const BACKFILL_CAP = 500;

export interface SyncStreamDeps {
  redis: Redis;
  syncService: SyncService;
}

async function resolveStreamUserId(payload: {
  sub?: string;
  user_id?: number | string;
  numericId?: number;
  type?: string;
}) {
  const subStr = typeof payload.sub === 'string' ? payload.sub : '';
  const subIsNumeric = subStr.length > 0 && /^\d+$/.test(subStr);

  if (subStr.length > 0 && !subIsNumeric && payload.type !== 'api_key_proxy') {
    return subStr;
  }

  const numericRaw = subIsNumeric ? subStr : (payload.numericId ?? payload.user_id);
  const numericStr = numericRaw == null ? null : String(numericRaw);
  if (!numericStr) return null;

  const imUser = await prisma.iMUser.findFirst({
    where: { userId: numericStr, role: 'human' },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  return imUser?.id ?? null;
}

export function createSyncStreamRouter(deps: SyncStreamDeps): Hono {
  const router = new Hono();

  /**
   * GET /stream — SSE sync stream
   *
   * Query params:
   *   token  — JWT auth token
   *   since  — cursor (IMSyncEvent.id, monotonic per user). Default 0
   *            means "live tail only, no backfill".
   *
   * Reconnect protocol (P2 2026-05-25):
   *   Client persists the last `seq` it saw via `sse-cursor.ts`. On
   *   reconnect it sends `since=<seq>`; cloud replays gap events with
   *   `replayed: true` set on the envelope, then emits a control
   *   envelope `{ type: 'sync.backfill.done', seq, replayed: true }`
   *   and proceeds to live tail. If the gap exceeds BACKFILL_CAP, we
   *   emit `{ type: 'sync.backfill.truncated', ... }` and close the
   *   stream — client must reconnect with the new cursor or do a full
   *   bootstrap refresh.
   */
  router.get('/stream', async (c) => {
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

    const userId = await resolveStreamUserId(payload);
    if (!userId) {
      return c.json({ ok: false, error: 'Token payload missing user identity' }, 401);
    }
    // SSE resume cursor. The browser replays its last-seen IMSyncEvent.id
    // via the `Last-Event-ID` header on a *native* EventSource auto-reconnect
    // (we set `id: <seq>` on every data frame below). The query `since` only
    // rides a freshly-constructed EventSource — a native reconnect reuses the
    // original, frozen URL, so without honoring the header a `since=0`
    // connection re-replays the entire history on every drop (and re-truncates
    // when it exceeds BACKFILL_CAP — an infinite full-replay storm). Prefer
    // the header; a new EventSource sends none, so the query `since` still
    // wins on first connect (and legacy/test clients are unaffected).
    const lastEventIdRaw = c.req.header('Last-Event-ID');
    const lastEventIdSeq = lastEventIdRaw ? parseInt(lastEventIdRaw, 10) : NaN;
    const since = Number.isFinite(lastEventIdSeq)
      ? lastEventIdSeq
      : parseInt(c.req.query('since') ?? '0', 10);

    return streamSSE(c, async (stream) => {
      let cursor = since;
      let subscriber: Redis | null = null;
      let truncated = false;

      // Phase 1: Cursor backfill.
      //
      // Pre-P2 behavior: drain ALL events with `id > since` (any cursor
      // value, including 0 = beginning of time). Kept for back-compat —
      // legacy clients + tests rely on `since=0` meaning "full history".
      //
      // P2 (2026-05-25) additions:
      //   - Cap total replay at BACKFILL_CAP per connect to defend against
      //     a 24h-stale client paginating gigabytes of backlog.
      //   - Mark backfilled envelopes with `replayed: true` so clients can
      //     differentiate from live tail (idempotent handlers can run them
      //     unchanged; UI can choose to render quietly).
      //   - Emit `sync.backfill.done` / `sync.backfill.truncated` control
      //     envelopes so the cursor-persistent client (sse-cursor.ts) can
      //     reset on truncation or no-op on success.
      try {
        let drained = 0;
        let firstReplayedSeq: number | null = null;
        let lastReplayedSeq: number | null = null;
        let hasMore = true;

        while (hasMore && drained < BACKFILL_CAP) {
          const pageLimit = Math.min(100, BACKFILL_CAP - drained);
          const result = await deps.syncService.getEvents(cursor, pageLimit, userId);
          for (const event of result.events) {
            if (firstReplayedSeq === null) firstReplayedSeq = event.seq;
            lastReplayedSeq = event.seq;
            await stream.writeSSE({
              data: JSON.stringify({ ...event, replayed: true }),
              event: 'sync',
              id: String(event.seq),
            });
            drained += 1;
            if (drained >= BACKFILL_CAP) break;
          }
          cursor = result.cursor;
          hasMore = result.hasMore;
        }

        if (drained > 0) {
          if (hasMore && drained >= BACKFILL_CAP) {
            // Client is too stale — let them know and disconnect so they
            // can re-establish from the newest replayed seq (gap still
            // possible above lastReplayedSeq; full bootstrap is safer).
            truncated = true;
            await stream.writeSSE({
              data: JSON.stringify({
                type: 'sync.backfill.truncated',
                oldestSeq: firstReplayedSeq,
                newestSeq: lastReplayedSeq,
                totalSeen: drained,
                replayed: true,
              }),
              event: 'sync',
            });
          } else {
            await stream.writeSSE({
              data: JSON.stringify({
                type: 'sync.backfill.done',
                seq: lastReplayedSeq ?? since,
                replayed: true,
              }),
              event: 'sync',
            });
          }
        }

        if (truncated) {
          // Close out — client will reconnect (with the truncated newestSeq
          // or a refreshed bootstrap cursor) on its own. Don't emit
          // `caught_up`: we aren't, and that signal would mislead the client.
          return;
        }

        // Legacy caught-up marker kept for back-compat with clients that
        // listen for the `caught_up` event. The new `sync.backfill.done`
        // envelope above is the forward-looking protocol.
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
            // v2.0 §4.4.7 — `message.partial` envelopes ride the same
            // per-recipient Redis channel but DO NOT carry a sync cursor seq
            // (they're keyed by per-stream chunkSeq, not boundarySeq). Always
            // forward to the client; never advance `cursor`.
            if (event.type === 'message.partial') {
              await stream.writeSSE({
                data: raw,
                event: 'sync',
              });
              return;
            }
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
