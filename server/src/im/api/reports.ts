/**
 * Prismer IM — Report API (user-facing)
 */

import { Hono } from 'hono';
import { authMiddleware } from '../auth/middleware';
import type { ApiResponse } from '../types/index';
import type { ReportService } from '../services/report.service';

export function createReportsRouter(reportService: ReportService) {
  const router = new Hono();

  router.post('/', authMiddleware, async (c) => {
    const user = c.get('user') as any;
    const body = await c.req.json();

    const { targetType, targetId, reason, reasonDetail } = body;
    if (!targetType || !targetId || !reason) {
      return c.json<ApiResponse>({ ok: false, error: 'targetType, targetId, reason are required' }, 400);
    }
    if (!['gene', 'skill'].includes(targetType)) {
      return c.json<ApiResponse>({ ok: false, error: 'targetType must be "gene" or "skill"' }, 400);
    }
    if (!['spam', 'inappropriate', 'misleading', 'broken', 'other'].includes(reason)) {
      return c.json<ApiResponse>({ ok: false, error: 'Invalid reason' }, 400);
    }

    try {
      const result = await reportService.submitReport(user.imUserId, {
        targetType,
        targetId,
        reason,
        reasonDetail,
      });
      return c.json<ApiResponse>({ ok: true, data: result });
    } catch (err: any) {
      const status = err.message.includes('not found')
        ? 404
        : err.message.includes('already reported')
          ? 409
          : err.message.includes('Insufficient') || err.message.includes('suspended') || err.message.includes('banned')
            ? 403
            : 500;
      return c.json<ApiResponse>({ ok: false, error: err.message }, status);
    }
  });

  router.get('/mine', authMiddleware, async (c) => {
    const user = c.get('user') as any;
    const page = parseInt(c.req.query('page') || '1', 10);
    const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 50);
    const result = await reportService.getMyReports(user.imUserId, page, limit);
    return c.json<ApiResponse>({ ok: true, data: result.reports, meta: { total: result.total, page, limit } });
  });

  return router;
}
