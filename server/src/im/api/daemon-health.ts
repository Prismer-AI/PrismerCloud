/**
 * Prismer IM — Daemon Health API (v2.0 §4.8.2, Wave 2-B2)
 *
 *   GET /daemons/:daemonId/health
 *     → snapshot of daemon liveness:
 *         lastHeartbeatAt        (from Redis presence key OR im_containers)
 *         lastSuccessfulDispatch (max(im_agent_bindings.lastDispatchAt) for agents bound to this daemon)
 *         taskQueueSize          (count of im_tasks rows assigned to bound agents with status running/pending/dispatching)
 *         wsConnected            (rooms.getClientConnections has at least one socket)
 *         agents                 (list of bound agent ids + names + workspaceId)
 *
 * Auth: actor must own a workspace that the daemon hosts (im_containers row),
 * be that workspace's active orchestrator, or be a cloud admin.
 *
 * This endpoint is read-only and rate-limit-friendly (the /:wsId/runtime endpoint
 * polls every 5s and we want a similar refresh cadence here without breaking
 * MySQL).
 */

import { Hono } from 'hono';
import type Redis from 'ioredis';
import prisma from '../db';
import { authMiddleware } from '../auth/middleware';
import { isCurrentlyContested } from '../services/agent-binding.service';
import type { ApiResponse } from '../types/index';
import type { RoomManager } from '../ws/rooms';

interface CreateDaemonHealthRouterDeps {
  redis: Redis;
  rooms: RoomManager;
}

const HEARTBEAT_FRESH_MS = 90_000;

function daemonRouteKey(daemonId: string): string {
  // Mirror src/im/services/task.service.ts:69 — kept inline to avoid coupling
  // a thin read-only route to TaskService's internal shape.
  return `daemon:${daemonId}`;
}

export function createDaemonHealthRouter(deps: CreateDaemonHealthRouterDeps) {
  const router = new Hono();
  // Wave 5 F1: see agent-bindings.ts for the rationale on path-specific
  // middleware. Mount-at-`/` sub-routers must not use `*` or they leak.
  router.use('/daemons/*', authMiddleware);

  router.get('/daemons/:daemonId/health', async (c) => {
    const user = c.get('user');
    const daemonId = decodeURIComponent(c.req.param('daemonId')).trim();
    if (!daemonId) {
      return c.json<ApiResponse>({ ok: false, error: 'invalid_daemon_id' }, 400);
    }

    // Locate the daemon's container row — workspaces are scoped through it.
    const container = await prisma.iMContainer.findFirst({
      where: { daemonId },
      orderBy: [{ deviceType: 'desc' }, { createdAt: 'desc' }],
      select: {
        id: true,
        workspaceId: true,
        deviceType: true,
        runtimeKind: true,
        status: true,
        podName: true,
        stoppedAt: true,
        startedAt: true,
      },
    });
    if (!container) {
      return c.json<ApiResponse>({ ok: false, error: 'Daemon not found' }, 404);
    }

    const ws = await prisma.iMWorkspace.findFirst({
      where: { id: container.workspaceId, deletedAt: null },
      select: { id: true, ownerImUserId: true, orchestratorAgentId: true, orchestratorRevokedAt: true },
    });
    if (!ws) {
      return c.json<ApiResponse>({ ok: false, error: 'Workspace not found' }, 404);
    }
    const isOwner = ws.ownerImUserId === user.imUserId;
    const isActiveOrchestrator = ws.orchestratorAgentId === user.imUserId && ws.orchestratorRevokedAt === null;
    const isAdmin = user.role === 'admin';
    if (!isOwner && !isActiveOrchestrator && !isAdmin) {
      return c.json<ApiResponse>({ ok: false, error: 'Forbidden' }, 403);
    }

    // Liveness: Redis presence key set on host.declare (see handler.ts ~860)
    const presenceKey = `runtime:device:${ws.id}:${daemonId}`;
    let lastHeartbeatAt: string | null = null;
    let presenceFresh = false;
    try {
      const raw = await deps.redis.get(presenceKey).catch(() => null);
      if (raw) {
        const parsed = JSON.parse(raw) as { lastSeenAt?: number };
        if (typeof parsed.lastSeenAt === 'number') {
          lastHeartbeatAt = new Date(parsed.lastSeenAt).toISOString();
          presenceFresh = Date.now() - parsed.lastSeenAt < HEARTBEAT_FRESH_MS;
        }
      }
    } catch {
      /* presence is best-effort */
    }

    // WS connection check: shadow client registered under daemon: route key
    const wsConnected = deps.rooms.getClientConnections(daemonRouteKey(daemonId)).size > 0;

    // Bindings + dispatch stats — read from im_agent_bindings (the v2.0
    // authoritative source). agentImUserId is the only column joinable to
    // both im_agent_cards and im_tasks.
    type BindingRow = {
      agentImUserId: string;
      boundDaemonLabel: string;
      lastHostDeclareAt: Date;
      lastDispatchAt: Date | null;
      contestedSince: Date | null;
    };
    const bindings = (await prisma.iMAgentBinding.findMany({
      where: { boundDaemonId: daemonId },
      select: {
        agentImUserId: true,
        boundDaemonLabel: true,
        lastHostDeclareAt: true,
        lastDispatchAt: true,
        contestedSince: true,
      },
      orderBy: { lastHostDeclareAt: 'desc' },
    })) as BindingRow[];

    const agentIds = bindings.map((b: BindingRow) => b.agentImUserId);
    type CardRow = { imUserId: string; name: string | null; workspaceId: string };
    const cards = agentIds.length
      ? ((await prisma.iMAgentCard.findMany({
          where: { imUserId: { in: agentIds } },
          select: { imUserId: true, name: true, workspaceId: true },
        })) as CardRow[])
      : ([] as CardRow[]);
    const nameById = new Map<string, string>(cards.map((c: CardRow) => [c.imUserId, c.name ?? c.imUserId]));

    // Task queue size = pending/running tasks across all bound agents
    let taskQueueSize = 0;
    if (agentIds.length > 0) {
      try {
        taskQueueSize = await prisma.iMTask.count({
          where: {
            assigneeId: { in: agentIds },
            status: { in: ['running', 'pending', 'dispatching'] },
          },
        });
      } catch {
        taskQueueSize = 0;
      }
    }

    let lastSuccessfulDispatch: Date | null = null;
    for (const b of bindings) {
      if (!b.lastDispatchAt) continue;
      if (!lastSuccessfulDispatch || b.lastDispatchAt > lastSuccessfulDispatch) {
        lastSuccessfulDispatch = b.lastDispatchAt;
      }
    }

    c.header('Cache-Control', 'no-store');
    return c.json<
      ApiResponse<{
        daemonId: string;
        workspaceId: string;
        deviceType: string;
        runtimeKind: string;
        containerStatus: string;
        startedAt: string | null;
        stoppedAt: string | null;
        lastHeartbeatAt: string | null;
        heartbeatFresh: boolean;
        wsConnected: boolean;
        lastSuccessfulDispatch: string | null;
        taskQueueSize: number;
        agents: Array<{
          agentImUserId: string;
          name: string;
          lastDispatchAt: string | null;
          contested: boolean;
        }>;
      }>
    >({
      ok: true,
      data: {
        daemonId,
        workspaceId: ws.id,
        deviceType: container.deviceType,
        runtimeKind: container.runtimeKind,
        containerStatus: container.status,
        startedAt: container.startedAt ? container.startedAt.toISOString() : null,
        stoppedAt: container.stoppedAt ? container.stoppedAt.toISOString() : null,
        lastHeartbeatAt,
        heartbeatFresh: presenceFresh,
        wsConnected,
        lastSuccessfulDispatch: lastSuccessfulDispatch ? lastSuccessfulDispatch.toISOString() : null,
        taskQueueSize,
        agents: bindings.map((b: BindingRow) => ({
          agentImUserId: b.agentImUserId,
          name: nameById.get(b.agentImUserId) ?? b.agentImUserId,
          lastDispatchAt: b.lastDispatchAt ? b.lastDispatchAt.toISOString() : null,
          contested: isCurrentlyContested(b.contestedSince),
        })),
      },
    });
  });

  return router;
}
