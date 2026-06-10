/**
 * Prismer IM — Agent Pack registry API.
 */

import { Hono } from 'hono';
import { authMiddleware } from '../auth/middleware';
import type { ApiResponse } from '../types/index';
import { AgentLifecycleError, AgentSpecService } from '../services/agent-spec.service';

export function createAgentPacksRouter(agentSpecService = new AgentSpecService()) {
  const router = new Hono();

  // eslint-disable-next-line custom/no-wildcard-sub-router-middleware -- mounted at /agent-packs in routes.ts; wildcard scoped to that prefix
  router.use('*', authMiddleware);

  router.get('/', async (c) => {
    const data = await agentSpecService.listPackages({
      q: c.req.query('q') || undefined,
      curatedQuality: c.req.query('curatedQuality') || c.req.query('quality') || undefined,
      license: c.req.query('license') || undefined,
      publisherDid: c.req.query('publisherDid') || undefined,
      cursor: c.req.query('cursor') || undefined,
      limit: parsePositiveInt(c.req.query('limit'), 50),
    });
    return c.json<ApiResponse>({ ok: true, data });
  });

  router.post('/:packId/fork', async (c) => {
    const user = c.get('user');
    const packId = c.req.param('packId');
    const body = await c.req.json().catch(() => ({}));
    const targetWorkspaceId = body.targetWorkspaceId;
    if (typeof targetWorkspaceId !== 'string' || !targetWorkspaceId.trim()) {
      return c.json<ApiResponse>(
        { ok: false, error: { code: 'VALIDATION_FAILED', message: 'targetWorkspaceId is required' } },
        400,
      );
    }
    if (!(await agentSpecService.canUseWorkspace(user, targetWorkspaceId, 'create'))) {
      return c.json<ApiResponse>({ ok: false, error: { code: 'FORBIDDEN', message: 'Forbidden' } }, 403);
    }

    try {
      const data = await agentSpecService.forkPackage(packId, user, {
        targetWorkspaceId,
        displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
        identityOptions: body.identityOptions && typeof body.identityOptions === 'object' ? body.identityOptions : undefined,
      });
      return c.json<ApiResponse>({ ok: true, data }, 201);
    } catch (err) {
      return mapAgentLifecycleError(c, err);
    }
  });

  router.delete('/:packId', async (c) => {
    const user = c.get('user');
    try {
      const data = await agentSpecService.deletePackage(c.req.param('packId'), user);
      return c.json<ApiResponse>({ ok: true, data });
    } catch (err) {
      return mapAgentLifecycleError(c, err);
    }
  });

  return router;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = raw ? Number(raw) : fallback;
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function mapAgentLifecycleError(c: any, err: unknown) {
  if (err instanceof AgentLifecycleError) {
    return c.json(
      { ok: false, error: { code: err.code, message: err.message } },
      err.status as any,
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return c.json({ ok: false, error: { code: 'AGENT_PACK_FAILED', message } }, 500);
}
