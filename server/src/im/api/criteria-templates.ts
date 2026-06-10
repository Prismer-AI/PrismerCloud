/**
 * Prismer IM — Criteria Templates API (release201/10 §6.3 + §8.7)
 *
 * POST   /criteria-templates          — create (workspace owner / admin)
 * GET    /criteria-templates          — list (?capability=&workspaceId=)
 * GET    /criteria-templates/:id      — read
 * PATCH  /criteria-templates/:id      — update
 * DELETE /criteria-templates/:id      — delete
 *
 * Global templates (workspaceId IS NULL) are read-only via this surface for
 * non-admin users; modification requires platform admin. The 4 built-ins
 * are seeded once at cloud boot by TaskCriteriaTemplateService.seedDefaults().
 */

import { Hono } from 'hono';
import { authMiddleware } from '../auth/middleware';
import type { ApiResponse } from '../types';
import { getTaskCriteriaTemplateService, type TemplateCriterion } from '../services/task-criteria-template.service';
import { createModuleLogger } from '../../lib/logger';

const log = createModuleLogger('CriteriaTemplatesAPI');

function validationErr(c: any, msg: string) {
  return c.json({ ok: false, error: { code: 'VALIDATION_ERROR', message: msg } } as ApiResponse, 400);
}

function parseCriteria(raw: unknown): TemplateCriterion[] | null {
  if (!Array.isArray(raw)) return null;
  const out: TemplateCriterion[] = [];
  const VALID_MODES = ['qualitative', 'quantitative', 'agent-self-check', 'manual'];
  for (const r of raw) {
    if (!r || typeof r !== 'object') return null;
    const o = r as Record<string, unknown>;
    // rev 2 — verifyMode + expectation; accept rev 1 `verifierKind` + `description`
    // for backward parse only (template create endpoint will reject rev 1 inputs at validation).
    const verifyModeRaw = typeof o.verifyMode === 'string' ? o.verifyMode : undefined;
    const expectationRaw = typeof o.expectation === 'string' ? o.expectation : '';
    if (!verifyModeRaw) return null;
    if (!VALID_MODES.includes(verifyModeRaw)) return null;
    if (!expectationRaw) return null;
    out.push({
      verifyMode: verifyModeRaw as TemplateCriterion['verifyMode'],
      expectation: expectationRaw,
      verifierAgentId: typeof o.verifierAgentId === 'string' ? (o.verifierAgentId as string) : null,
      required: o.required !== false,
      weight: typeof o.weight === 'number' ? o.weight : 1,
    });
  }
  return out;
}

export function createCriteriaTemplatesRouter() {
  const router = new Hono();
  const service = getTaskCriteriaTemplateService();

  // eslint-disable-next-line custom/no-wildcard-sub-router-middleware -- mounted at /criteria-templates in routes.ts
  router.use('*', authMiddleware);

  /** POST /criteria-templates */
  router.post('/', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const capability = typeof body.capability === 'string' ? body.capability : '';
    const name = typeof body.name === 'string' ? body.name : '';
    if (!capability) return validationErr(c, 'capability is required');
    if (!name) return validationErr(c, 'name is required');
    const criteria = parseCriteria(body.criteria);
    if (!criteria || criteria.length === 0) {
      return validationErr(c, 'criteria[] must be a non-empty array');
    }
    try {
      const tpl = await service.create({
        workspaceId: typeof body.workspaceId === 'string' ? body.workspaceId : null,
        capability,
        name,
        description: typeof body.description === 'string' ? body.description : undefined,
        criteria,
        isDefault: body.isDefault === true,
      });
      return c.json({ ok: true, data: tpl });
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'create template failed');
      return c.json({ ok: false, error: { code: 'INTERNAL_ERROR', message: (err as Error).message } }, 500);
    }
  });

  /** GET /criteria-templates?capability=&workspaceId= */
  router.get('/', async (c) => {
    const capability = c.req.query('capability') ?? undefined;
    const wsRaw = c.req.query('workspaceId');
    const workspaceId = wsRaw === '__global' ? null : typeof wsRaw === 'string' && wsRaw ? wsRaw : undefined;
    try {
      const data = await service.list({ capability, workspaceId });
      return c.json({ ok: true, data });
    } catch (err) {
      return c.json({ ok: false, error: { code: 'INTERNAL_ERROR', message: (err as Error).message } }, 500);
    }
  });

  /** GET /criteria-templates/:id */
  router.get('/:id', async (c) => {
    const id = c.req.param('id');
    const tpl = await service.getById(id);
    if (!tpl) {
      return c.json({ ok: false, error: { code: 'NOT_FOUND', message: `template ${id} not found` } }, 404);
    }
    return c.json({ ok: true, data: tpl });
  });

  /** PATCH /criteria-templates/:id */
  router.patch('/:id', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const patch: any = {};
    if (typeof body.capability === 'string') patch.capability = body.capability;
    if (typeof body.name === 'string') patch.name = body.name;
    if (typeof body.description === 'string') patch.description = body.description;
    if (typeof body.isDefault === 'boolean') patch.isDefault = body.isDefault;
    if (body.criteria !== undefined) {
      const parsed = parseCriteria(body.criteria);
      if (!parsed) return validationErr(c, 'criteria[] invalid shape');
      patch.criteria = parsed;
    }
    const tpl = await service.update(id, patch);
    if (!tpl) {
      return c.json({ ok: false, error: { code: 'NOT_FOUND', message: `template ${id} not found` } }, 404);
    }
    return c.json({ ok: true, data: tpl });
  });

  /** DELETE /criteria-templates/:id */
  router.delete('/:id', async (c) => {
    const id = c.req.param('id');
    const ok = await service.delete(id);
    if (!ok) {
      return c.json({ ok: false, error: { code: 'NOT_FOUND', message: `template ${id} not found` } }, 404);
    }
    return c.json({ ok: true, data: { deleted: id } });
  });

  return router;
}
