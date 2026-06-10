/**
 * Prismer IM — ACP Role Template API
 */

import { Hono } from 'hono';
import { authMiddleware } from '../auth/middleware';
import type { ApiResponse } from '../types/index';
import type { RoleTemplateService } from '../services/role-template.service';
import prisma from '../db';

function adminOnly() {
  return async (c: any, next: any) => {
    const user = c.get('user');
    if (!user || user.role !== 'admin') {
      return c.json({ ok: false, error: 'Admin access required' } as ApiResponse, 403);
    }
    return next();
  };
}

async function canApplyToAgent(user: { imUserId: string; role?: string }, agentId: string, workspaceId?: string) {
  if (user.role === 'admin') return true;
  const profileWhere: Record<string, unknown> = { agentImUserId: agentId, deletedAt: null };
  if (workspaceId) profileWhere.workspaceId = workspaceId;
  const profile = await prisma.iMAgentProfile.findFirst({
    where: profileWhere,
    select: { workspaceId: true },
    orderBy: { updatedAt: 'desc' },
  });
  if (!profile) return false;
  const workspace = await prisma.iMWorkspace.findFirst({
    where: { id: profile.workspaceId, deletedAt: null, ownerImUserId: user.imUserId },
    select: { id: true },
  });
  return Boolean(workspace);
}

export function createRoleTemplatesRouter(roleTemplateService: RoleTemplateService) {
  const router = new Hono();

  router.get('/', async (c) => {
    const category = c.req.query('category') || undefined;
    const agentType = c.req.query('agentType') || c.req.query('agent_type') || undefined;
    const status = c.req.query('status') || undefined;
    const data = await roleTemplateService.list({ category, agentType, status });
    return c.json<ApiResponse>({ ok: true, data });
  });

  router.get('/:slugOrId', async (c) => {
    const template = await roleTemplateService.get(c.req.param('slugOrId'));
    if (!template) return c.json<ApiResponse>({ ok: false, error: 'Role template not found' }, 404);
    return c.json<ApiResponse>({ ok: true, data: template });
  });

  router.post('/', authMiddleware, adminOnly(), async (c) => {
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Invalid JSON body' }, 400);
    }

    if (!body.slug && !body.name && !body.displayName) {
      return c.json<ApiResponse>({ ok: false, error: 'slug or name/displayName is required' }, 400);
    }

    try {
      const data = await roleTemplateService.create(body);
      return c.json<ApiResponse>({ ok: true, data }, 201);
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (e.code === 'P2002') {
        return c.json<ApiResponse>({ ok: false, error: 'Role template slug already exists' }, 409);
      }
      return c.json<ApiResponse>({ ok: false, error: e.message || 'Role template create failed' }, 500);
    }
  });

  router.patch('/:slugOrId', authMiddleware, adminOnly(), async (c) => {
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Invalid JSON body' }, 400);
    }

    const data = await roleTemplateService.update(c.req.param('slugOrId'), body);
    if (!data) return c.json<ApiResponse>({ ok: false, error: 'Role template not found' }, 404);
    return c.json<ApiResponse>({ ok: true, data });
  });

  router.post('/:slugOrId/apply', authMiddleware, async (c) => {
    const user = c.get('user');
    const body = await c.req.json().catch(() => ({}));
    const agentId = body.agentId || body.agentImUserId;
    if (!agentId) {
      return c.json<ApiResponse>({ ok: false, error: 'agentId is required' }, 400);
    }
    if (!(await canApplyToAgent(user, agentId, body.workspaceId))) {
      return c.json<ApiResponse>({ ok: false, error: 'Admin or workspace owner access required' }, 403);
    }

    try {
      const data = await roleTemplateService.applyToAgent(agentId, c.req.param('slugOrId'), body.workspaceId);
      return c.json<ApiResponse>({ ok: true, data });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message === 'Role template not found' ? 404 : 500;
      return c.json<ApiResponse>({ ok: false, error: message }, status as any);
    }
  });

  return router;
}
