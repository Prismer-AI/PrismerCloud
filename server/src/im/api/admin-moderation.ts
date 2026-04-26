/**
 * Prismer IM — Admin Moderation API
 *
 * All endpoints require admin role.
 *
 * Reports:
 *   GET    /admin/moderation/reports         — List reports (filterable)
 *   PATCH  /admin/moderation/reports/:id     — Resolve report (upheld/dismissed)
 *
 * Users:
 *   GET    /admin/moderation/users           — List users for moderation
 *   PATCH  /admin/moderation/users/:id/ban   — Ban/unban user
 *
 * Content:
 *   GET    /admin/moderation/content         — List content (genes + skills)
 *   PATCH  /admin/moderation/content/:id     — Update content (quarantine/restore/score)
 *   POST   /admin/moderation/content/batch   — Batch operations
 */

import { Hono } from 'hono';
import { authMiddleware } from '../auth/middleware';
import type { ApiResponse } from '../types/index';
import type { ReportService } from '../services/report.service';
import type { CreditService } from '../services/credit.service';
import {
  quarantineGene,
  quarantineSkill,
  restoreGene,
  restoreSkill,
  setScore,
} from '../services/quality-score.service';
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

export function createModerationRouter(reportService: ReportService, creditService: CreditService) {
  const router = new Hono();
  router.use('*', authMiddleware);
  router.use('*', adminGuard());

  // ── Reports ─────────────────────────────────────────────────────

  router.get('/reports', async (c) => {
    const status = c.req.query('status') || undefined;
    const page = parseInt(c.req.query('page') || '1', 10);
    const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 50);
    const result = await reportService.listReports({ status, page, limit });
    return c.json<ApiResponse>({ ok: true, data: result.reports, meta: { total: result.total, page, limit } });
  });

  router.patch('/reports/:id', async (c) => {
    const id = c.req.param('id');
    const { decision } = await c.req.json();
    const admin = c.get('user') as any;

    if (!['upheld', 'dismissed'].includes(decision)) {
      return c.json<ApiResponse>({ ok: false, error: 'decision must be "upheld" or "dismissed"' }, 400);
    }

    try {
      await reportService.resolveReport(id, decision, admin.imUserId);
      return c.json<ApiResponse>({ ok: true, data: { id, decision } });
    } catch (err: any) {
      return c.json<ApiResponse>({ ok: false, error: err.message }, 400);
    }
  });

  // ── Users ───────────────────────────────────────────────────────

  router.get('/users', async (c) => {
    const search = c.req.query('search') || '';
    const filter = c.req.query('filter') || '';
    const page = parseInt(c.req.query('page') || '1', 10);
    const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 50);

    const where: any = {};
    if (search) {
      where.OR = [{ username: { contains: search } }, { displayName: { contains: search } }, { id: search }];
    }
    if (filter === 'banned') where.banned = true;
    if (filter === 'report-banned') where.reportBanUntil = { gt: new Date() };

    const [users, total] = await Promise.all([
      prisma.iMUser.findMany({
        where,
        select: {
          id: true,
          username: true,
          displayName: true,
          role: true,
          banned: true,
          bannedAt: true,
          banReason: true,
          reportBanUntil: true,
          quarantineCount: true,
          publishCount: true,
          trustTier: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.iMUser.count({ where }),
    ]);

    const enriched = await Promise.all(
      users.map(async (u: (typeof users)[number]) => {
        const balance = await creditService
          .getBalance(u.id)
          .then((b) => b.balance)
          .catch(() => 0);
        return { ...u, balance };
      }),
    );

    return c.json<ApiResponse>({ ok: true, data: enriched, meta: { total, page, limit } });
  });

  router.patch('/users/:id/ban', async (c) => {
    const userId = c.req.param('id');
    const { banned, reason } = await c.req.json();

    if (typeof banned !== 'boolean') {
      return c.json<ApiResponse>({ ok: false, error: 'banned must be boolean' }, 400);
    }

    await prisma.iMUser.update({
      where: { id: userId },
      data: {
        banned,
        bannedAt: banned ? new Date() : null,
        banReason: banned ? reason || 'Banned by admin' : null,
      },
    });

    return c.json<ApiResponse>({ ok: true, data: { userId, banned } });
  });

  // ── Content ─────────────────────────────────────────────────────

  router.get('/content', async (c) => {
    const type = c.req.query('type') || 'all';
    const filter = c.req.query('filter') || '';
    const search = c.req.query('search') || '';
    const page = parseInt(c.req.query('page') || '1', 10);
    const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 50);

    const items: any[] = [];
    let total = 0;

    if (type === 'all' || type === 'gene') {
      const geneWhere: any = {};
      if (filter === 'published') geneWhere.visibility = { in: ['published', 'canary'] };
      if (filter === 'quarantined') geneWhere.visibility = 'quarantined';
      if (filter === 'low-score') geneWhere.qualityScore = { lt: 0.01 };
      if (search) geneWhere.title = { contains: search };

      const [genes, geneCount] = await Promise.all([
        prisma.iMGene.findMany({
          where: geneWhere,
          select: {
            id: true,
            title: true,
            category: true,
            visibility: true,
            qualityScore: true,
            ownerAgentId: true,
            successCount: true,
            failureCount: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: type === 'all' ? Math.floor(limit / 2) : limit,
          skip: type === 'all' ? 0 : (page - 1) * limit,
        }),
        prisma.iMGene.count({ where: geneWhere }),
      ]);

      items.push(...genes.map((g: (typeof genes)[number]) => ({ ...g, contentType: 'gene' as const })));
      total += geneCount;
    }

    if (type === 'all' || type === 'skill') {
      const skillWhere: any = {};
      if (filter === 'published') skillWhere.status = 'active';
      if (filter === 'quarantined') skillWhere.status = 'deprecated';
      if (filter === 'low-score') skillWhere.qualityScore = { lt: 0.01 };
      if (search) skillWhere.name = { contains: search };

      const [skills, skillCount] = await Promise.all([
        prisma.iMSkill.findMany({
          where: skillWhere,
          select: {
            id: true,
            name: true,
            category: true,
            status: true,
            qualityScore: true,
            author: true,
            installs: true,
            stars: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: type === 'all' ? Math.floor(limit / 2) : limit,
          skip: type === 'all' ? 0 : (page - 1) * limit,
        }),
        prisma.iMSkill.count({ where: skillWhere }),
      ]);

      items.push(...skills.map((s: (typeof skills)[number]) => ({ ...s, contentType: 'skill' as const })));
      total += skillCount;
    }

    return c.json<ApiResponse>({ ok: true, data: items, meta: { total, page, limit } });
  });

  router.patch('/content/:id', async (c) => {
    const id = c.req.param('id');
    const { action, contentType, score } = await c.req.json();

    if (!['gene', 'skill'].includes(contentType)) {
      return c.json<ApiResponse>({ ok: false, error: 'contentType must be "gene" or "skill"' }, 400);
    }

    try {
      if (action === 'quarantine') {
        if (contentType === 'gene') await quarantineGene(id);
        else await quarantineSkill(id);
      } else if (action === 'restore') {
        const restoreScore = typeof score === 'number' ? score : 0.01;
        if (contentType === 'gene') await restoreGene(id, restoreScore);
        else await restoreSkill(id, restoreScore);
      } else if (action === 'set-score') {
        if (typeof score !== 'number') {
          return c.json<ApiResponse>({ ok: false, error: 'score required for set-score action' }, 400);
        }
        await setScore(contentType, id, score);
      } else {
        return c.json<ApiResponse>({ ok: false, error: 'action must be quarantine, restore, or set-score' }, 400);
      }
      return c.json<ApiResponse>({ ok: true, data: { id, action, contentType } });
    } catch (err: any) {
      return c.json<ApiResponse>({ ok: false, error: err.message }, 400);
    }
  });

  router.post('/content/batch', async (c) => {
    const { action, contentType, ids } = await c.req.json();

    if (!Array.isArray(ids) || ids.length === 0) {
      return c.json<ApiResponse>({ ok: false, error: 'ids array required' }, 400);
    }
    if (!['quarantine', 'restore'].includes(action)) {
      return c.json<ApiResponse>({ ok: false, error: 'action must be quarantine or restore' }, 400);
    }
    if (!['gene', 'skill'].includes(contentType)) {
      return c.json<ApiResponse>({ ok: false, error: 'contentType must be gene or skill' }, 400);
    }

    let processed = 0;
    for (const id of ids) {
      try {
        if (action === 'quarantine') {
          if (contentType === 'gene') await quarantineGene(id);
          else await quarantineSkill(id);
        } else {
          if (contentType === 'gene') await restoreGene(id, 0.01);
          else await restoreSkill(id, 0.01);
        }
        processed++;
      } catch {
        /* skip failed items */
      }
    }

    return c.json<ApiResponse>({ ok: true, data: { processed, total: ids.length } });
  });

  return router;
}
