/**
 * Prismer IM — Skill Draft API (release201/07 skill-authoring engine)
 *
 * Endpoints:
 *   POST   /api/im/skills/draft                  — create a draft from manifest v1
 *   PATCH  /api/im/skills/:id/draft              — incremental file ops on a draft
 *   POST   /api/im/skills/:id/draft/regenerate   — request a regeneration session
 *   GET    /api/im/skills/draft/:id              — show a single draft (manifest + history)
 *   GET    /api/im/skills/drafts                 — list drafts for a workspace
 *
 * Authentication: all routes require an authenticated user (JWT or API key);
 * actor identity drives ownership checks inside SkillDraftService.
 *
 * Design: docs/release201/07-skill-authoring-engine.md §5 endpoints.
 */

import { Hono } from 'hono';
import { authMiddleware } from '../auth/middleware';
import type { ApiResponse } from '../types/index';
import { SkillDraftService, SkillDraftError } from '../services/skill-draft.service';

export function createSkillDraftRouter(skillDraftService: SkillDraftService) {
  const router = new Hono();

  /**
   * POST /api/im/skills/draft
   *
   * Body:
   *   {
   *     slug, name, description,
   *     workspaceId, ownerAgentId,
   *     files: [{ path, content? | contentBase64? }],
   *     metadata?: { authoring?: { sourceKind, sourceRefs, sessionId, ... } }
   *   }
   *
   * Returns: { id, slug, manifestRevision, reviewTaskId, validationWarnings }
   */
  router.post('/draft', authMiddleware, async (c) => {
    const user = c.get('user');
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Invalid JSON body' }, 400);
    }

    // Default ownerAgentId to the authenticated user when not supplied.
    const ownerAgentId = body.ownerAgentId || user.imUserId;

    try {
      const result = await skillDraftService.createDraft({
        slug: body.slug,
        name: body.name,
        description: body.description,
        workspaceId: body.workspaceId,
        ownerAgentId,
        files: Array.isArray(body.files) ? body.files : [],
        metadata: body.metadata,
      });
      return c.json<ApiResponse>({ ok: true, data: result }, 201);
    } catch (err) {
      if (err instanceof SkillDraftError) {
        return c.json<ApiResponse>(
          { ok: false, error: err.message, code: err.gate ? `gate:${err.gate}` : undefined } as any,
          err.statusCode as any,
        );
      }
      const e = err as { code?: string; message?: string };
      if (e?.code === 'P2002') {
        return c.json<ApiResponse>({ ok: false, error: 'A skill with this slug already exists' }, 409);
      }
      console.error('[SkillsDraft] create failed', { err: e?.message });
      return c.json<ApiResponse>({ ok: false, error: 'Skill draft create failed' }, 500);
    }
  });

  /**
   * PATCH /api/im/skills/:id/draft
   *
   * Body: { files: [{ path, op: 'add'|'update'|'delete', content? | contentBase64? }], reason? }
   * Returns: { id, manifestRevision }
   */
  router.patch('/:id/draft', authMiddleware, async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Invalid JSON body' }, 400);
    }

    try {
      const result = await skillDraftService.patchDraft(id, user.imUserId, {
        files: Array.isArray(body.files) ? body.files : [],
        reason: body.reason,
      });
      return c.json<ApiResponse>({ ok: true, data: result });
    } catch (err) {
      if (err instanceof SkillDraftError) {
        return c.json<ApiResponse>({ ok: false, error: err.message } as any, err.statusCode as any);
      }
      console.error('[SkillsDraft] patch failed', { err: (err as Error).message });
      return c.json<ApiResponse>({ ok: false, error: 'Skill draft patch failed' }, 500);
    }
  });

  /**
   * POST /api/im/skills/:id/draft/regenerate
   *
   * Body: { reason: string, newSources?: [{ kind, ref }] }
   * Returns: { id, sessionId, manifestRevision }
   */
  router.post('/:id/draft/regenerate', authMiddleware, async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Invalid JSON body' }, 400);
    }
    if (!body.reason || typeof body.reason !== 'string') {
      return c.json<ApiResponse>({ ok: false, error: 'reason is required' }, 400);
    }

    try {
      const result = await skillDraftService.regenerateDraft(id, user.imUserId, {
        reason: body.reason,
        newSources: Array.isArray(body.newSources) ? body.newSources : undefined,
      });
      return c.json<ApiResponse>({ ok: true, data: result });
    } catch (err) {
      if (err instanceof SkillDraftError) {
        return c.json<ApiResponse>({ ok: false, error: err.message } as any, err.statusCode as any);
      }
      return c.json<ApiResponse>({ ok: false, error: 'Skill draft regenerate failed' }, 500);
    }
  });

  /**
   * GET /api/im/skills/draft/:id — fetch single draft detail (manifest + history).
   */
  router.get('/draft/:id', authMiddleware, async (c) => {
    const id = c.req.param('id');
    const draft = await skillDraftService.getDraft(id);
    if (!draft) {
      return c.json<ApiResponse>({ ok: false, error: 'Draft not found' }, 404);
    }
    return c.json<ApiResponse>({ ok: true, data: draft });
  });

  /**
   * GET /api/im/skills/drafts?workspaceId=... — list workspace drafts.
   */
  router.get('/drafts', authMiddleware, async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) {
      return c.json<ApiResponse>({ ok: false, error: 'workspaceId query param is required' }, 400);
    }
    const drafts = await skillDraftService.listDrafts(workspaceId);
    return c.json<ApiResponse>({ ok: true, data: drafts });
  });

  return router;
}
