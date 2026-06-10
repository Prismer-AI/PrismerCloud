/**
 * Prismer IM — Sync API
 *
 * GET /api/im/sync — Incremental sync endpoint for offline-first SDK clients.
 *   Clients poll with an id-based cursor to receive events since their last
 *   sync (legacy global-id contract).
 *
 * GET /api/im/sync/events — v2.0 §4.1 gap-fill endpoint.
 *   Returns events for ONE conversation with `boundarySeq > afterSeq` so
 *   the front-end `useReconciledStream` hook can self-heal a detected gap
 *   from the SSE stream.
 */

import { Hono } from 'hono';
import { authMiddleware } from '../auth/middleware';
import { SyncService } from '../services/sync.service';
import type { ApiResponse } from '../types/index';
import prisma from '../db';

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

  /**
   * GET /api/im/sync/events — v2.0 §4.1 per-conversation gap fill.
   *
   * Query parameters:
   *   conversationId — REQUIRED. Conversation to gap-fill.
   *   afterSeq       — Last seen boundarySeq (default 0). Returns events
   *                    with boundarySeq > afterSeq, ordered ASC.
   *   limit          — Max events (1-500, default 200).
   *
   * Returns:
   *   {
   *     events: Array<{
   *       id: number;
   *       type: string;
   *       data: any;
   *       conversationId: string;
   *       boundarySeq: number;
   *       at: string;       // ISO timestamp
   *     }>;
   *     hasMore: boolean;
   *     cursor: number;     // boundarySeq of last event in this batch
   *   }
   *
   * 403 if the caller is not a participant in the conversation.
   */
  router.get('/events', authMiddleware, async (c) => {
    const user = c.get('user');
    const conversationId = c.req.query('conversationId');
    const afterSeq = parseInt(c.req.query('afterSeq') ?? '0', 10);
    const limit = Math.min(parseInt(c.req.query('limit') ?? '200', 10), 500);

    if (!conversationId) {
      return c.json<ApiResponse>({ ok: false, error: 'conversationId is required' }, 400);
    }
    if (!Number.isFinite(afterSeq) || afterSeq < 0) {
      return c.json<ApiResponse>({ ok: false, error: 'afterSeq must be a non-negative integer' }, 400);
    }

    // Participant check — same surface as POST/GET /messages/:cid.
    const participant = await prisma.iMParticipant.findFirst({
      where: { conversationId, imUserId: user.imUserId, leftAt: null },
      select: { id: true },
    });
    if (!participant) {
      return c.json<ApiResponse>({ ok: false, error: 'Not a participant' }, 403);
    }

    try {
      const result = await syncService.getEventsByConversation(conversationId, afterSeq, limit);
      return c.json<ApiResponse>({ ok: true, data: result });
    } catch (err) {
      console.error('[SyncService] /events error:', err);
      return c.json<ApiResponse>({ ok: false, error: 'gap-fill failed' }, 500);
    }
  });

  return router;
}
