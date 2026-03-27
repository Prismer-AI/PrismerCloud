/**
 * Prismer IM — Sync API
 *
 * GET /api/im/sync — Incremental sync endpoint for offline-first SDK clients.
 * Clients poll with a cursor to receive events since their last sync.
 */

import { Hono } from 'hono';
import { authMiddleware } from '../auth/middleware';
import { SyncService } from '../services/sync.service';
import type { ApiResponse } from '../types/index';

export function createSyncRouter(syncService: SyncService) {
  const router = new Hono();

  /**
   * GET /api/im/sync — Get sync events since a cursor.
   *
   * Query parameters:
   *   since — cursor (last seen seq number, default 0)
   *   limit — max events to return (1-500, default 100)
   *
   * Returns: { events, cursor, hasMore }
   */
  router.get('/', authMiddleware, async (c) => {
    const user = c.get('user');
    const since = parseInt(c.req.query('since') ?? '0', 10);
    const limit = Math.min(parseInt(c.req.query('limit') ?? '100', 10), 500);

    try {
      const result = await syncService.getEvents(since, limit, user.imUserId);
      return c.json<ApiResponse>({ ok: true, data: result });
    } catch (err) {
      console.error('[SyncService] Error:', err);
      return c.json<ApiResponse>({ ok: false, error: 'Sync failed' }, 500);
    }
  });

  return router;
}
