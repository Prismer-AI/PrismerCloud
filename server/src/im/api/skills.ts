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
import { SkillPermissionError, type SkillService } from '../services/skill.service';
import type { RateLimiterService } from '../services/rate-limiter.service';
import { createRateLimitMiddleware } from '../middleware/rate-limit';
import type { ApiResponse } from '../types/index';
import { preinstallRoleTemplateSkills } from '../services/role-template.service';
import prisma from '../db';
import { requireAgentToolAllowed } from '../security/mcp-allowlist';

async function canManageAgentSkills(
  actor: { imUserId: string; role?: string },
  agentId: string,
  workspaceId?: string,
): Promise<boolean> {
  if (actor.role === 'admin' || actor.imUserId === agentId) return true;
  const profileWhere: Record<string, unknown> = { agentImUserId: agentId, deletedAt: null };
  if (workspaceId) profileWhere.workspaceId = workspaceId;
  const profile = await prisma.iMAgentProfile.findFirst({
    where: profileWhere,
    select: { workspaceId: true },
    orderBy: { updatedAt: 'desc' },
  });
  if (!profile) return false;
  const workspace = await prisma.iMWorkspace.findFirst({
    where: { id: profile.workspaceId, deletedAt: null, ownerImUserId: actor.imUserId },
    select: { id: true },
  });
  return Boolean(workspace);
}

export function createSkillsRouter(skillService: SkillService, rateLimiter?: RateLimiterService) {
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
      | 'relevance'
      | 'recommended';
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
   * GET /api/skills/created — List skills created by the authenticated agent
   * NOTE: Must be registered BEFORE the /:slugOrId catch-all route
   */
  router.get('/created', authMiddleware, async (c) => {
    const user = c.get('user');
    const data = await skillService.getCreatedByAgent(user.imUserId);
    return c.json<ApiResponse>({ ok: true, data });
  });

  /**
   * GET /api/skills/installed — List agent's installed skills (auth required)
   * NOTE: Must be registered BEFORE the /:slugOrId catch-all route
   */
  router.get('/installed', authMiddleware, async (c) => {
    const user = c.get('user');
    const agentId = c.req.query('agentId') || user.imUserId;
    const workspaceId = c.req.query('workspaceId') || undefined;
    if (!(await canManageAgentSkills(user, agentId, workspaceId))) {
      return c.json<ApiResponse>({ ok: false, error: 'Admin, workspace owner, or agent token required' }, 403);
    }
    const data = await skillService.getInstalledSkills(agentId, workspaceId);
    return c.json<ApiResponse>({ ok: true, data });
  });

  /**
   * POST /api/skills/preinstall — Install required role-template skills for an agent.
   * Body: { agentId, roleTemplateSlugOrId, workspaceId? }
   */
  router.post('/preinstall', authMiddleware, async (c) => {
    const user = c.get('user');
    const body = await c.req.json().catch(() => ({}));
    const agentId = body.agentId || body.agentImUserId;
    const roleTemplateSlugOrId = body.roleTemplateSlugOrId || body.roleTemplateSlug || body.roleTemplateId;
    if (!agentId || !roleTemplateSlugOrId) {
      return c.json<ApiResponse>({ ok: false, error: 'agentId and roleTemplateSlugOrId are required' }, 400);
    }
    const workspaceId = body.workspaceId || body.workspace_id;
    if (!(await canManageAgentSkills(user, agentId, workspaceId))) {
      return c.json<ApiResponse>({ ok: false, error: 'Admin, workspace owner, or agent token required' }, 403);
    }

    try {
      const data = await preinstallRoleTemplateSkills(agentId, roleTemplateSlugOrId, workspaceId);
      return c.json<ApiResponse>({ ok: true, data });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message === 'Role template not found' ? 404 : 500;
      return c.json<ApiResponse>({ ok: false, error: message }, status as any);
    }
  });

  /**
   * POST /api/skills/admin/reupsert-built-ins — Re-run Built-in skill discovery
   *
   * Re-walks `sdk/prismer-cloud/built-in-skills/` and upserts all SKILL.md
   * (含子目录递归) into im_skills. Required by cookbook step 7 to mutate a
   * file locally and observe the daemon picking up the new merkle without
   * restarting the cloud process.
   *
   * Auth: admin-only (no agent / user scope; deploy-time op).
   * 2026-05-20 §A.7 Phase 1 follow-up (review fix P1-6).
   */
  router.post('/admin/reupsert-built-ins', authMiddleware, async (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') {
      return c.json<ApiResponse>({ ok: false, error: 'Admin only' }, 403);
    }
    try {
      const { BuiltInSkillService } = await import('../services/built-in-skill.service');
      const { AgentSkillService } = await import('../services/agent-skill.service');
      const builtIn = new BuiltInSkillService(new AgentSkillService(skillService));
      const result = await builtIn.upsertBuiltInSkills();
      return c.json<ApiResponse>({ ok: true, data: { skills: result.length } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json<ApiResponse>({ ok: false, error: message }, 500);
    }
  });

  /**
   * GET /api/skills/admin/built-ins — list every built-in skill for catalog governance.
   *
   * release202/09 §P4-b — backend admin "review/enable one-by-one" surface.
   * Built-in predicate: `source='prismer' OR category='built-in'`. Returns the
   * two catalog-governance flags (`isSystem` / `defaultEnabled`) alongside the
   * display fields so `/admin/skills` can split system vs general and toggle the
   * general ones individually.
   *
   * Auth: admin-only (catalog-level governance; same gate as reupsert-built-ins).
   * NOTE: Must be registered BEFORE the catch-all /:slugOrId route.
   */
  router.get('/admin/built-ins', authMiddleware, async (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') {
      return c.json<ApiResponse>({ ok: false, error: 'Admin only' }, 403);
    }
    const rows = await prisma.iMSkill.findMany({
      where: {
        status: { not: 'deprecated' },
        OR: [{ source: 'prismer' }, { category: 'built-in' }],
      },
      select: {
        id: true,
        slug: true,
        name: true,
        description: true,
        category: true,
        isSystem: true,
        defaultEnabled: true,
        status: true,
      },
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
    });
    return c.json<ApiResponse>({ ok: true, data: rows });
  });

  /**
   * PATCH /api/skills/admin/:slugOrId/default-enabled — toggle catalog `defaultEnabled`.
   *
   * release202/09 §P4-b — owner enables general built-ins one at a time. This is
   * catalog-level (does NOT touch per-agent install state). System skills are
   * always-on and the UI disables their toggle, but the endpoint still allows
   * setting them (idempotent) so ops can correct drift.
   *
   * Body: { defaultEnabled: boolean }
   * Auth: admin-only.
   * NOTE: Must be registered BEFORE the catch-all /:slugOrId route.
   */
  router.patch('/admin/:slugOrId/default-enabled', authMiddleware, async (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') {
      return c.json<ApiResponse>({ ok: false, error: 'Admin only' }, 403);
    }
    const slugOrId = c.req.param('slugOrId');
    let body: { defaultEnabled?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Invalid JSON body' }, 400);
    }
    if (typeof body.defaultEnabled !== 'boolean') {
      return c.json<ApiResponse>({ ok: false, error: 'defaultEnabled (boolean) is required' }, 400);
    }

    const existing = await prisma.iMSkill.findFirst({
      where: { OR: [{ slug: slugOrId }, { id: slugOrId }] },
      select: { id: true },
    });
    if (!existing) {
      return c.json<ApiResponse>({ ok: false, error: 'Skill not found' }, 404);
    }

    const updated = await prisma.iMSkill.update({
      where: { id: existing.id },
      data: { defaultEnabled: body.defaultEnabled },
      select: {
        id: true,
        slug: true,
        name: true,
        description: true,
        category: true,
        isSystem: true,
        defaultEnabled: true,
        status: true,
      },
    });
    return c.json<ApiResponse>({ ok: true, data: updated });
  });

  /**
   * GET /api/skills/:id/related — Get related skills (same category)
   * Query: ?limit=5
   * NOTE: Must be registered BEFORE the catch-all /:slugOrId route
   */
  router.get('/:id/related', async (c) => {
    const id = c.req.param('id');
    const limit = Math.min(parseInt(c.req.query('limit') || '5', 10), 20);
    const skills = await skillService.getRelated(id, limit);
    return c.json<ApiResponse>({ ok: true, data: skills });
  });

  /**
   * GET /api/skills/:idOrSlug/content — Get skill content for download/install
   * Auth required to track access.
   */
  router.get('/:idOrSlug/content', authMiddleware, async (c) => {
    const idOrSlug = c.req.param('idOrSlug');
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
    const slugOrId = c.req.param('slugOrId');

    // Skip if it looks like a sub-route that should be handled elsewhere
    if (
      [
        'search',
        'stats',
        'categories',
        'trending',
        'import',
        'sync',
        'installed',
        'created',
        'preinstall',
        'draft',
        'drafts',
        'admin',
      ].includes(slugOrId)
    ) {
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

  // ─── Rate Limiting (write operations) ────────────────────
  if (rateLimiter) {
    router.post('/import', createRateLimitMiddleware(rateLimiter, 'api.write'));
    router.post('/sync/raw', createRateLimitMiddleware(rateLimiter, 'api.write'));
    router.post('/preinstall', createRateLimitMiddleware(rateLimiter, 'api.write'));
    router.post('/', createRateLimitMiddleware(rateLimiter, 'api.write'));
    router.patch('/:id', createRateLimitMiddleware(rateLimiter, 'api.write'));
    router.delete('/:id', createRateLimitMiddleware(rateLimiter, 'api.write'));
    router.post('/:idOrSlug/install', createRateLimitMiddleware(rateLimiter, 'api.write'));
    router.delete('/:idOrSlug/install', createRateLimitMiddleware(rateLimiter, 'api.write'));
    router.post('/:id/star', createRateLimitMiddleware(rateLimiter, 'api.write'));
  }

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
   *
   * Catches Prisma P2002 (unique constraint on slug — derived from name) and
   * returns a clean 409 instead of a 500 text/plain. Closes the Python SDK
   * regression where repeated `evolution.create_skill()` calls with the same
   * `name` collided on `slug` and crashed the route.
   */
  router.post('/', authMiddleware, async (c) => {
    const user = c.get('user');
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Invalid JSON body' }, 400);
    }

    if (!body.name || !body.description || !body.category) {
      return c.json<ApiResponse>({ ok: false, error: 'name, description, and category are required' }, 400);
    }

    try {
      const skill = await skillService.create({
        name: body.name,
        description: body.description,
        category: body.category,
        tags: body.tags,
        author: body.author || user.username || 'anonymous',
        content: body.content,
        sourceUrl: body.sourceUrl,
        signals: Array.isArray(body.signals) ? body.signals : undefined,
        ownerAgentId: user.imUserId,
      });

      return c.json<ApiResponse>({ ok: true, data: skill }, 201);
    } catch (err) {
      const e = err as { code?: string; message?: string };
      // Prisma unique-constraint violation — derived slug already exists.
      if (e?.code === 'P2002') {
        return c.json<ApiResponse>({ ok: false, error: 'A skill with this name already exists (slug collision)' }, 409);
      }
      console.error('[Skills] create failed', { err: e?.message });
      return c.json<ApiResponse>({ ok: false, error: 'Skill create failed' }, 500);
    }
  });

  /**
   * PATCH /api/skills/:id — Update a skill
   */
  router.patch('/:id', authMiddleware, async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const body = await c.req.json();

    try {
      const skill = await skillService.update(id, body, user.imUserId);
      if (!skill) {
        return c.json<ApiResponse>({ ok: false, error: 'Skill not found' }, 404);
      }
      return c.json<ApiResponse>({ ok: true, data: skill });
    } catch (err) {
      if (err instanceof SkillPermissionError) {
        return c.json<ApiResponse>({ ok: false, error: err.message }, 403);
      }
      throw err;
    }
  });

  /**
   * DELETE /api/skills/:id — Deprecate a skill (soft delete)
   */
  router.delete('/:id', authMiddleware, async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    try {
      const result = await skillService.deprecate(id, user.imUserId);
      if (!result) {
        return c.json<ApiResponse>({ ok: false, error: 'Skill not found' }, 404);
      }
      return c.json<ApiResponse>({ ok: true });
    } catch (err) {
      if (err instanceof SkillPermissionError) {
        return c.json<ApiResponse>({ ok: false, error: err.message }, 403);
      }
      throw err;
    }
  });

  /**
   * POST /api/skills/:idOrSlug/install — Install a skill for the authenticated agent
   * Creates agent-skill record, optionally creates a Gene from skill signals+strategy.
   */
  router.post('/:idOrSlug/install', authMiddleware, async (c) => {
    const user = c.get('user');
    const idOrSlug = c.req.param('idOrSlug');

    try {
      const body = await c.req.json().catch(() => ({}));
      const denied = await requireAgentToolAllowed(c, 'prismer.skill.install', body.workspaceId ?? body.workspace_id);
      if (denied) return denied;
      const scope = body.scope || 'global';
      const result = await skillService.installSkill(user.imUserId, idOrSlug, scope);
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
    const idOrSlug = c.req.param('idOrSlug');
    const scope = c.req.query('scope') || 'global';
    const denied = await requireAgentToolAllowed(c, 'prismer.skill.uninstall', c.req.query('workspaceId'));
    if (denied) return denied;
    const result = await skillService.uninstallSkill(user.imUserId, idOrSlug, scope);
    return c.json<ApiResponse>({ ok: true, data: { uninstalled: result } });
  });

  /**
   * POST /api/skills/:id/star — Star a skill (increment stars)
   */
  router.post('/:id/star', authMiddleware, async (c) => {
    const id = c.req.param('id');
    try {
      await skillService.recordStar(id);
      return c.json<ApiResponse>({ ok: true });
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Skill not found' }, 404);
    }
  });

  return router;
}
