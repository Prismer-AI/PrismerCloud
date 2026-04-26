/**
 * Prismer IM — Community Board API
 *
 * Dynamic board management: list, create, update, delete, subscribe, admins.
 * Public: list boards, get board. Authenticated: create, update, delete, subscribe.
 */

import { Hono } from 'hono';
import { authMiddleware } from '../auth/middleware';
import type { ApiResponse } from '../types/index';
import type { CommunityBoardService } from '../services/community-board.service';
import type { RateLimiterService } from '../services/rate-limiter.service';

export function createCommunityBoardRouter(
  boardService: CommunityBoardService,
  rateLimiter?: RateLimiterService,
) {
  const router = new Hono();

  // ─── Public ────────────────────────────────────────────────

  router.get('/', async (c) => {
    try {
      const boards = await boardService.listBoards();
      return c.json<ApiResponse>({ ok: true, data: boards });
    } catch (err: any) {
      return c.json<ApiResponse>(
        { ok: false, error: err.message },
        500,
      );
    }
  });

  router.get('/:slug', async (c) => {
    try {
      const slug = c.req.param('slug');
      const board = await boardService.getBoardBySlug(slug);
      if (!board) {
        return c.json<ApiResponse>({ ok: false, error: 'Board not found' }, 404);
      }
      return c.json<ApiResponse>({ ok: true, data: board });
    } catch (err: any) {
      return c.json<ApiResponse>(
        { ok: false, error: err.message },
        500,
      );
    }
  });

  router.get('/:slug/admins', async (c) => {
    try {
      const slug = c.req.param('slug');
      const board = await boardService.getBoardBySlug(slug);
      if (!board) {
        return c.json<ApiResponse>({ ok: false, error: 'Board not found' }, 404);
      }
      const admins = await boardService.listAdmins(board.id);
      return c.json<ApiResponse>({ ok: true, data: admins });
    } catch (err: any) {
      return c.json<ApiResponse>(
        { ok: false, error: err.message },
        500,
      );
    }
  });

  // ─── Authenticated ─────────────────────────────────────────

  router.post('/', authMiddleware, async (c) => {
    try {
      const user = c.get('user') as any;
      const body = await c.req.json();

      const board = await boardService.createBoard(user.imUserId, {
        slug: body.slug,
        name: body.name,
        description: body.description,
        icon: body.icon,
        rules: body.rules,
      });

      return c.json<ApiResponse>({ ok: true, data: board }, 201);
    } catch (err: any) {
      const status = err.message.includes('slug') ? 400 : 500;
      return c.json<ApiResponse>(
        { ok: false, error: err.message },
        status,
      );
    }
  });

  router.put('/:slug', authMiddleware, async (c) => {
    try {
      const user = c.get('user') as any;
      const slug = c.req.param('slug');
      const body = await c.req.json();

      const updated = await boardService.updateBoard(slug, user.imUserId, body);
      return c.json<ApiResponse>({ ok: true, data: updated });
    } catch (err: any) {
      if (err.name === 'BoardNotFoundError') {
        return c.json<ApiResponse>({ ok: false, error: 'Board not found' }, 404);
      }
      if (err.name === 'BoardPermissionError') {
        return c.json<ApiResponse>({ ok: false, error: err.message }, 403);
      }
      return c.json<ApiResponse>(
        { ok: false, error: err.message },
        500,
      );
    }
  });

  router.delete('/:slug', authMiddleware, async (c) => {
    try {
      const user = c.get('user') as any;
      const slug = c.req.param('slug');
      await boardService.deleteBoard(slug, user.imUserId);
      return c.json<ApiResponse>({ ok: true, data: { deleted: true } });
    } catch (err: any) {
      if (err.name === 'BoardNotFoundError') {
        return c.json<ApiResponse>({ ok: false, error: 'Board not found' }, 404);
      }
      if (err.name === 'BoardPermissionError') {
        return c.json<ApiResponse>({ ok: false, error: err.message }, 403);
      }
      return c.json<ApiResponse>(
        { ok: false, error: err.message },
        500,
      );
    }
  });

  // ─── Subscribe / Unsubscribe ───────────────────────────────

  router.post('/:slug/subscribe', authMiddleware, async (c) => {
    try {
      const user = c.get('user') as any;
      const slug = c.req.param('slug');
      const result = await boardService.subscribe(slug, user.imUserId);
      return c.json<ApiResponse>({ ok: true, data: result });
    } catch (err: any) {
      if (err.name === 'BoardNotFoundError') {
        return c.json<ApiResponse>({ ok: false, error: 'Board not found' }, 404);
      }
      return c.json<ApiResponse>(
        { ok: false, error: err.message },
        500,
      );
    }
  });

  router.get('/:slug/subscribed', authMiddleware, async (c) => {
    try {
      const user = c.get('user') as any;
      const slug = c.req.param('slug');
      const subscribed = await boardService.isSubscribed(slug, user.imUserId);
      return c.json<ApiResponse>({ ok: true, data: { subscribed } });
    } catch (err: any) {
      return c.json<ApiResponse>(
        { ok: false, error: err.message },
        500,
      );
    }
  });

  // ─── Admin Management ──────────────────────────────────────

  router.post('/:slug/admins', authMiddleware, async (c) => {
    try {
      const user = c.get('user') as any;
      const slug = c.req.param('slug');
      const { userId } = await c.req.json();

      const admin = await boardService.addModerator(slug, user.imUserId, userId);
      return c.json<ApiResponse>({ ok: true, data: admin }, 201);
    } catch (err: any) {
      if (err.name === 'BoardPermissionError') {
        return c.json<ApiResponse>({ ok: false, error: err.message }, 403);
      }
      return c.json<ApiResponse>(
        { ok: false, error: err.message },
        500,
      );
    }
  });

  router.delete('/:slug/admins/:userId', authMiddleware, async (c) => {
    try {
      const user = c.get('user') as any;
      const slug = c.req.param('slug');
      const targetUserId = c.req.param('userId');

      await boardService.removeModerator(slug, user.imUserId, targetUserId);
      return c.json<ApiResponse>({ ok: true, data: { removed: true } });
    } catch (err: any) {
      if (err.name === 'BoardPermissionError') {
        return c.json<ApiResponse>({ ok: false, error: err.message }, 403);
      }
      return c.json<ApiResponse>(
        { ok: false, error: err.message },
        500,
      );
    }
  });

  return router;
}
