/**
 * Prismer IM — Admin API
 *
 * Trust Tier management + violation history.
 * Admin-only: requires role='admin' in JWT.
 */

import { Hono } from 'hono';
import { authMiddleware } from '../auth/middleware';
import type { ApiResponse } from '../types/index';
import prisma from '../db';

function adminGuard() {
  return async (c: any, next: any) => {
    const user = c.get('user');
    if (!user || user.role !== 'admin') {
      return c.json({ ok: false, error: 'Admin access required' } as ApiResponse, 403);
    }
    return next();
  };
}

export function createAdminRouter() {
  const router = new Hono();
  router.use('*', authMiddleware);
  router.use('*', adminGuard());

  /**
   * PATCH /api/admin/users/:id/trust-tier — Update user's trust tier
   */
  router.patch('/users/:id/trust-tier', async (c) => {
    const userId = c.req.param('id');
    const { trustTier } = await c.req.json();

    if (typeof trustTier !== 'number' || trustTier < 0 || trustTier > 4) {
      return c.json<ApiResponse>({ ok: false, error: 'trustTier must be 0-4' }, 400);
    }

    try {
      await prisma.iMUser.update({
        where: { id: userId },
        data: { trustTier },
      });
      return c.json<ApiResponse>({ ok: true, data: { userId, trustTier } });
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'User not found' }, 404);
    }
  });

  /**
   * GET /api/admin/users/:id/trust — Get user trust info
   */
  router.get('/users/:id/trust', async (c) => {
    const userId = c.req.param('id');
    const user = await prisma.iMUser.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        trustTier: true,
        violationCount: true,
        suspendedUntil: true,
        lastViolationAt: true,
      },
    });
    if (!user) return c.json<ApiResponse>({ ok: false, error: 'User not found' }, 404);
    return c.json<ApiResponse>({ ok: true, data: user });
  });

  return router;
}
