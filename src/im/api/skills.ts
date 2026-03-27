/**
 * Prismer IM — Skill Catalog API
 *
 * Public endpoints for browsing the skill catalog.
 * Admin endpoints for sync/import (auth required).
 *
 * @see docs/SKILL-EVOLUTION.md
 */

import { Hono } from 'hono';
import { authMiddleware } from '../auth/middleware';
import type { SkillService } from '../services/skill.service';
import type { ApiResponse } from '../types/index';

export function createSkillsRouter(skillService: SkillService) {
  const router = new Hono();

  // ─── Public Endpoints (no auth) ────────────────────────────

  /**
   * GET /api/skills/search — Browse and search skills
   * Query: ?query=timeout&category=devops-and-cloud&source=awesome-openclaw&sort=most_installed&page=1&limit=20
   */
  router.get('/search', async (c) => {
    const query = c.req.query('query') || undefined;
    const category = c.req.query('category') || undefined;
    const source = c.req.query('source') || undefined;
    const compatibility = c.req.query('compatibility') || undefined;
    const sort = (c.req.query('sort') || 'most_installed') as
      | 'newest'
      | 'most_installed'
      | 'most_starred'
      | 'name'
      | 'relevance';
    const page = parseInt(c.req.query('page') || '1', 10);
    const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 100);

    const result = await skillService.search({ query, category, source, compatibility, sort, page, limit });
    return c.json<ApiResponse>({
      ok: true,
      data: result.skills,
      meta: { total: result.total, page, limit },
    });
  });

  /**
   * GET /api/skills/stats — Catalog statistics
   */
  router.get('/stats', async (c) => {
    const stats = await skillService.getStats();
    return c.json<ApiResponse>({ ok: true, data: stats });
  });

  /**
   * GET /api/skills/categories — List categories with counts
   */
  router.get('/categories', async (c) => {
    const categories = await skillService.getCategories();
    return c.json<ApiResponse>({ ok: true, data: categories });
  });

  /**
   * GET /api/skills/trending — Trending skills (weighted score + recency)
   * Query: ?limit=20
   */
  router.get('/trending', async (c) => {
    const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 100);
    const skills = await skillService.getTrending(limit);
    return c.json<ApiResponse>({ ok: true, data: skills });
  });

  /**
   * GET /api/skills/installed — List agent's installed skills (auth required)
   * NOTE: Must be registered BEFORE the /:slugOrId catch-all route
   */
  router.get('/installed', authMiddleware, async (c) => {
    const user = c.get('user');
    const data = await skillService.getInstalledSkills(user.imUserId);
    return c.json<ApiResponse>({ ok: true, data });
  });

  /**
   * GET /api/skills/:id/related — Get related skills (same category)
   * Query: ?limit=5
   * NOTE: Must be registered BEFORE the catch-all /:slugOrId route
   */
  router.get('/:id/related', async (c) => {
    const id = c.req.param('id')!;
    const limit = Math.min(parseInt(c.req.query('limit') || '5', 10), 20);
    const skills = await skillService.getRelated(id, limit);
    return c.json<ApiResponse>({ ok: true, data: skills });
  });

  /**
   * GET /api/skills/:idOrSlug/content — Get skill content for download/install
   * Auth required to track access.
   */
  router.get('/:idOrSlug/content', authMiddleware, async (c) => {
    const idOrSlug = c.req.param('idOrSlug')!;
    const data = await skillService.getSkillContent(idOrSlug);
    if (!data) {
      return c.json<ApiResponse>({ ok: false, error: 'Skill not found' }, 404);
    }
    return c.json<ApiResponse>({ ok: true, data });
  });

  /**
   * GET /api/skills/:slugOrId — Skill detail by slug or ID
   */
  router.get('/:slugOrId', async (c) => {
    const slugOrId = c.req.param('slugOrId')!;

    // Skip if it looks like a sub-route that should be handled elsewhere
    if (['search', 'stats', 'categories', 'trending', 'import', 'sync', 'installed'].includes(slugOrId)) {
      return c.json<ApiResponse>({ ok: false, error: 'Not found' }, 404);
    }

    // Try by slug first, then by ID
    let skill = await skillService.getBySlug(slugOrId);
    if (!skill) {
      skill = await skillService.getById(slugOrId);
    }
    if (!skill) {
      return c.json<ApiResponse>({ ok: false, error: 'Skill not found' }, 404);
    }
    return c.json<ApiResponse>({ ok: true, data: skill });
  });

  // ─── Admin Endpoints (auth required) ───────────────────────

  /**
   * POST /api/skills/import — Bulk import skills
   * Body: { skills: Array<{ name, description, category, author?, source, sourceUrl?, sourceId, tags? }> }
   */
  router.post('/import', authMiddleware, async (c) => {
    const body = await c.req.json();
    if (!body.skills || !Array.isArray(body.skills)) {
      return c.json<ApiResponse>({ ok: false, error: 'skills array is required' }, 400);
    }
    if (body.skills.length > 5000) {
      return c.json<ApiResponse>({ ok: false, error: 'Max 5000 skills per import' }, 400);
    }

    const result = await skillService.bulkImport(body.skills);
    return c.json<ApiResponse>({ ok: true, data: result });
  });

  /**
   * POST /api/skills/sync/raw — Import from raw-skills.json format
   * Body: { skills: Array<{ name, description, category, url }> }
   */
  router.post('/sync/raw', authMiddleware, async (c) => {
    const body = await c.req.json();
    if (!body.skills || !Array.isArray(body.skills)) {
      return c.json<ApiResponse>({ ok: false, error: 'skills array is required' }, 400);
    }

    const result = await skillService.importFromRawSkills(body.skills);
    return c.json<ApiResponse>({ ok: true, data: result });
  });

  /**
   * POST /api/skills — Create a skill (community submission)
   */
  router.post('/', authMiddleware, async (c) => {
    const user = c.get('user');
    const body = await c.req.json();

    if (!body.name || !body.description || !body.category) {
      return c.json<ApiResponse>({ ok: false, error: 'name, description, and category are required' }, 400);
    }

    const skill = await skillService.create({
      name: body.name,
      description: body.description,
      category: body.category,
      tags: body.tags,
      author: body.author || user.username || 'anonymous',
      content: body.content,
      sourceUrl: body.sourceUrl,
    });

    return c.json<ApiResponse>({ ok: true, data: skill }, 201);
  });

  /**
   * PATCH /api/skills/:id — Update a skill
   */
  router.patch('/:id', authMiddleware, async (c) => {
    const id = c.req.param('id')!;
    const body = await c.req.json();

    const skill = await skillService.update(id, body);
    if (!skill) {
      return c.json<ApiResponse>({ ok: false, error: 'Skill not found' }, 404);
    }
    return c.json<ApiResponse>({ ok: true, data: skill });
  });

  /**
   * DELETE /api/skills/:id — Deprecate a skill (soft delete)
   */
  router.delete('/:id', authMiddleware, async (c) => {
    const id = c.req.param('id')!;
    const result = await skillService.deprecate(id);
    if (!result) {
      return c.json<ApiResponse>({ ok: false, error: 'Skill not found' }, 404);
    }
    return c.json<ApiResponse>({ ok: true });
  });

  /**
   * POST /api/skills/:idOrSlug/install — Install a skill for the authenticated agent
   * Creates agent-skill record, optionally creates a Gene from skill signals+strategy.
   */
  router.post('/:idOrSlug/install', authMiddleware, async (c) => {
    const user = c.get('user');
    const idOrSlug = c.req.param('idOrSlug')!;

    try {
      const result = await skillService.installSkill(user.imUserId, idOrSlug);
      return c.json<ApiResponse>({ ok: true, data: result });
    } catch (err: any) {
      if (err.message === 'Skill not found') {
        return c.json<ApiResponse>({ ok: false, error: 'Skill not found' }, 404);
      }
      return c.json<ApiResponse>({ ok: false, error: err.message }, 500);
    }
  });

  /**
   * DELETE /api/skills/:idOrSlug/install — Uninstall a skill for the authenticated agent
   */
  router.delete('/:idOrSlug/install', authMiddleware, async (c) => {
    const user = c.get('user');
    const idOrSlug = c.req.param('idOrSlug')!;
    const result = await skillService.uninstallSkill(user.imUserId, idOrSlug);
    return c.json<ApiResponse>({ ok: true, data: { uninstalled: result } });
  });

  /**
   * POST /api/skills/:id/star — Star a skill (increment stars)
   */
  router.post('/:id/star', authMiddleware, async (c) => {
    const id = c.req.param('id')!;
    try {
      await skillService.recordStar(id);
      return c.json<ApiResponse>({ ok: true });
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Skill not found' }, 404);
    }
  });

  return router;
}
