/**
 * Prismer IM — bulk agent device move API.
 *
 *   POST /workspaces/:wsId/agent-device-moves
 *     body: { sourceDaemonId, targetDaemonId?, targetRuntimeInstallationId?, dryRun?, includeCeo?, reason? }
 */

import { Hono } from 'hono';
import prisma from '../db';
import { authMiddleware } from '../auth/middleware';
import { AgentDeviceMoveError, AgentDeviceMoveService } from '../services/agent-device-move.service';
import type { SyncService } from '../services/sync.service';
import type { ApiResponse } from '../types/index';

interface CreateAgentDeviceMoveRouterDeps {
  syncService?: SyncService;
}

type MoveBody = {
  sourceDaemonId?: unknown;
  targetDaemonId?: unknown;
  targetRuntimeInstallationId?: unknown;
  dryRun?: unknown;
  includeCeo?: unknown;
  install?: unknown;
  reason?: unknown;
};

export function createAgentDeviceMovesRouter(deps: CreateAgentDeviceMoveRouterDeps = {}) {
  const router = new Hono();
  const service = new AgentDeviceMoveService(prisma, deps.syncService);

  router.use('/workspaces/*', authMiddleware);

  router.post('/workspaces/:wsId/agent-device-moves', async (c) => {
    const user = c.get('user');
    const workspaceId = c.req.param('wsId').trim();
    if (!workspaceId) {
      return c.json<ApiResponse>(
        { ok: false, error: { code: 'WORKSPACE_ID_REQUIRED', message: 'workspaceId is required' } },
        400,
      );
    }

    let body: MoveBody;
    try {
      body = (await c.req.json()) as MoveBody;
    } catch {
      return c.json<ApiResponse>({ ok: false, error: { code: 'INVALID_JSON', message: 'Invalid JSON body' } }, 400);
    }

    try {
      const result = await service.move({
        workspaceId,
        actorImUserId: user.imUserId,
        sourceDaemonId: asTrimmedString(body.sourceDaemonId) ?? '',
        targetDaemonId: asTrimmedString(body.targetDaemonId),
        targetRuntimeInstallationId: asTrimmedString(body.targetRuntimeInstallationId),
        dryRun: body.dryRun === true,
        includeCeo: body.includeCeo === undefined ? undefined : body.includeCeo === true,
        install: body.install === undefined ? undefined : body.install === true,
        reason: asTrimmedString(body.reason),
      });

      c.header('Cache-Control', 'no-store');
      return c.json<ApiResponse<typeof result>>({ ok: true, data: result });
    } catch (err) {
      c.header('Cache-Control', 'no-store');
      if (err instanceof AgentDeviceMoveError) {
        return c.json<ApiResponse>(
          { ok: false, error: { code: err.code, message: err.message } },
          err.status as 400 | 403 | 404 | 409 | 500,
        );
      }
      return c.json<ApiResponse>(
        {
          ok: false,
          error: {
            code: 'AGENT_DEVICE_MOVE_FAILED',
            message: err instanceof Error ? err.message : String(err),
          },
        },
        500,
      );
    }
  });

  return router;
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}
