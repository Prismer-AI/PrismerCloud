/**
 * Prismer IM — Runtime Diagnose API (v2.0 §4.8.1, Wave 4-E4)
 *
 *   GET /runtime/diagnose?daemonId=<id>
 *     → ad-hoc reachability snapshot for the named daemon, intended for
 *       the upcoming `prismer status` CLI surface (Wave 5) and any UI
 *       widget that wants to render "why the dispatch failed".
 *
 *   Body:
 *     {
 *       daemonId,
 *       wsAlive,              // shadow client currently registered?
 *       lastHeartbeatAt,      // Redis presence key (best-effort)
 *       gatewayUrl,           // im_containers.gatewayUrl (null when unknown)
 *       gatewayIsPrivate,     // RFC1918 / link-local? (daemon-reported, falls
 *                             //   back to cloud-side detection)
 *       transport,            // daemon-reported preferred transport ('ws'|'http'|'both'|null)
 *       lastProbeAt,          // daemon's last transport-probe report timestamp
 *       httpReachable,        // HEAD /healthz probe result (1.5s timeout)
 *       httpLatencyMs,        // probe RTT (when reachable)
 *       recommendedTransport, // 'ws' | 'http' | 'unreachable'
 *     }
 *
 * Auth: workspace owner / active orchestrator / cloud admin (mirrors
 * daemon-health.ts).
 *
 * Distinct from `/daemons/:daemonId/health`:
 *   - /health is the operator-facing "is this daemon alive and how busy is it"
 *     dashboard view (bindings, queue size, last successful dispatch).
 *   - /runtime/diagnose is the dispatcher-facing "which transport should I use
 *     to reach this daemon RIGHT NOW" probe. It is read by automation
 *     (cookbook scripts, the dispatch path on failure) AND humans (CLI/UI).
 */

import { Hono } from 'hono';
import type Redis from 'ioredis';
import prisma from '../db';
import { authMiddleware } from '../auth/middleware';
import type { ApiResponse } from '../types/index';
import type { RoomManager } from '../ws/rooms';
import { isPrivateIpToCloud, probeHttpReachable } from '../services/ws-rpc.service';

interface CreateRuntimeDiagnoseRouterDeps {
  redis: Redis;
  rooms: RoomManager;
}

function daemonRouteKey(daemonId: string): string {
  return `daemon:${daemonId}`;
}

const HEARTBEAT_FRESH_MS = 90_000;
const PROBE_TIMEOUT_MS = 1_500;

export function createRuntimeDiagnoseRouter(deps: CreateRuntimeDiagnoseRouterDeps) {
  const router = new Hono();
  // Wave 5 F1: path-specific middleware to avoid leaking onto sibling routes
  // (e.g. /dispatch/*) when this router is mounted at app root `/`.
  router.use('/runtime/*', authMiddleware);

  router.get('/runtime/diagnose', async (c) => {
    const user = c.get('user');
    const daemonId = (c.req.query('daemonId') ?? '').trim();
    if (!daemonId) {
      return c.json<ApiResponse>({ ok: false, error: 'daemonId query is required' }, 400);
    }

    const container = await prisma.iMContainer.findFirst({
      where: { daemonId },
      orderBy: [{ deviceType: 'desc' }, { createdAt: 'desc' }],
      select: {
        id: true,
        workspaceId: true,
        gatewayUrl: true,
        transport: true,
        gatewayIsPrivate: true,
        lastProbeAt: true,
        status: true,
      },
    });
    if (!container) {
      return c.json<ApiResponse>({ ok: false, error: 'daemon_not_found' }, 404);
    }

    const ws = await prisma.iMWorkspace.findFirst({
      where: { id: container.workspaceId, deletedAt: null },
      select: { id: true, ownerImUserId: true, orchestratorAgentId: true, orchestratorRevokedAt: true },
    });
    if (!ws) {
      return c.json<ApiResponse>({ ok: false, error: 'workspace_not_found' }, 404);
    }
    const isOwner = ws.ownerImUserId === user.imUserId;
    const isActiveOrchestrator =
      ws.orchestratorAgentId === user.imUserId && ws.orchestratorRevokedAt === null;
    const isAdmin = user.role === 'admin';
    if (!isOwner && !isActiveOrchestrator && !isAdmin) {
      return c.json<ApiResponse>({ ok: false, error: 'Forbidden' }, 403);
    }

    // wsAlive — shadow client registered on this Pod's RoomManager?
    const wsAlive = deps.rooms.getClientConnections(daemonRouteKey(daemonId)).size > 0;

    // lastHeartbeatAt — Redis presence key (set on every host.declare).
    const presenceKey = `runtime:device:${ws.id}:${daemonId}`;
    let lastHeartbeatAt: string | null = null;
    let heartbeatFresh = false;
    try {
      const raw = await deps.redis.get(presenceKey).catch(() => null);
      if (raw) {
        const parsed = JSON.parse(raw) as { lastSeenAt?: number };
        if (typeof parsed.lastSeenAt === 'number') {
          lastHeartbeatAt = new Date(parsed.lastSeenAt).toISOString();
          heartbeatFresh = Date.now() - parsed.lastSeenAt < HEARTBEAT_FRESH_MS;
        }
      }
    } catch {
      /* best-effort */
    }

    // HTTP reachability — HEAD /healthz with short timeout. Skipped when
    // gatewayUrl is private/missing (cloud can't dial it anyway).
    const gatewayIsPrivate =
      container.gatewayIsPrivate ??
      (container.gatewayUrl ? isPrivateIpToCloud(container.gatewayUrl) : true);
    let httpReachable = false;
    let httpLatencyMs: number | null = null;
    let httpError: string | null = null;
    if (container.gatewayUrl && !gatewayIsPrivate) {
      const probe = await probeHttpReachable(container.gatewayUrl, PROBE_TIMEOUT_MS);
      httpReachable = probe.reachable;
      httpLatencyMs = probe.latencyMs;
      httpError = probe.error ?? null;
    }

    let recommendedTransport: 'ws' | 'http' | 'unreachable';
    if (wsAlive) recommendedTransport = 'ws';
    else if (httpReachable) recommendedTransport = 'http';
    else recommendedTransport = 'unreachable';

    c.header('Cache-Control', 'no-store');
    return c.json<
      ApiResponse<{
        daemonId: string;
        workspaceId: string;
        containerStatus: string;
        wsAlive: boolean;
        lastHeartbeatAt: string | null;
        heartbeatFresh: boolean;
        gatewayUrl: string | null;
        gatewayIsPrivate: boolean;
        transport: string | null;
        lastProbeAt: string | null;
        httpReachable: boolean;
        httpLatencyMs: number | null;
        httpError: string | null;
        recommendedTransport: 'ws' | 'http' | 'unreachable';
      }>
    >({
      ok: true,
      data: {
        daemonId,
        workspaceId: ws.id,
        containerStatus: container.status,
        wsAlive,
        lastHeartbeatAt,
        heartbeatFresh,
        gatewayUrl: container.gatewayUrl ?? null,
        gatewayIsPrivate,
        transport: container.transport ?? null,
        lastProbeAt: container.lastProbeAt ? container.lastProbeAt.toISOString() : null,
        httpReachable,
        httpLatencyMs,
        httpError,
        recommendedTransport,
      },
    });
  });

  /**
   * POST /runtime/transport-report
   *
   * Daemon startup transport-probe report. Updates `im_containers.transport
   * / gatewayIsPrivate / lastProbeAt`. Auth: API key (the daemon's own
   * sk-prismer-* token) — same auth surface used by other daemon endpoints.
   * The container row is located by the daemon's declared `daemonId` so the
   * report is scoped to that daemon's workspace.
   *
   * Body:
   *   {
   *     daemonId: string,
   *     transport: 'ws' | 'http' | 'both',
   *     gatewayUrl?: string | null,   // null when daemon has no inbound HTTP server
   *     gatewayIsPrivate: boolean,    // daemon's own assessment (it knows its local IPs)
   *   }
   */
  router.post('/runtime/transport-report', async (c) => {
    const user = c.get('user');
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'invalid_body' }, 400);
    }
    const daemonId = typeof body.daemonId === 'string' ? body.daemonId.trim() : '';
    const transport = typeof body.transport === 'string' ? body.transport.trim() : '';
    if (!daemonId) {
      return c.json<ApiResponse>({ ok: false, error: 'daemonId required' }, 400);
    }
    if (transport !== 'ws' && transport !== 'http' && transport !== 'both') {
      return c.json<ApiResponse>(
        { ok: false, error: "transport must be 'ws' | 'http' | 'both'" },
        400,
      );
    }
    const gatewayUrl =
      typeof body.gatewayUrl === 'string' && body.gatewayUrl.trim()
        ? body.gatewayUrl.trim()
        : null;
    const gatewayIsPrivate =
      typeof body.gatewayIsPrivate === 'boolean'
        ? body.gatewayIsPrivate
        : gatewayUrl
        ? isPrivateIpToCloud(gatewayUrl)
        : true;

    const container = await prisma.iMContainer.findFirst({
      where: { daemonId },
      select: { id: true, workspaceId: true },
    });
    if (!container) {
      return c.json<ApiResponse>({ ok: false, error: 'daemon_not_found' }, 404);
    }
    const ws = await prisma.iMWorkspace.findFirst({
      where: { id: container.workspaceId, deletedAt: null },
      select: { ownerImUserId: true },
    });
    if (!ws) {
      return c.json<ApiResponse>({ ok: false, error: 'workspace_not_found' }, 404);
    }
    // Authorization: the API key behind this request must own the workspace
    // the daemon's container belongs to. We do NOT allow orchestrator agents
    // to write the report — only the human daemon-owner. (Admin override
    // kept for support tooling.)
    if (user.imUserId !== ws.ownerImUserId && user.role !== 'admin') {
      return c.json<ApiResponse>({ ok: false, error: 'Forbidden' }, 403);
    }

    const now = new Date();
    await prisma.iMContainer.update({
      where: { id: container.id },
      data: {
        transport,
        gatewayIsPrivate,
        lastProbeAt: now,
        ...(gatewayUrl ? { gatewayUrl } : {}),
      },
    });

    console.log(
      `[RuntimeDiagnose] transport-report daemon=${daemonId} transport=${transport} private=${gatewayIsPrivate} gateway=${gatewayUrl ?? 'null'}`,
    );

    return c.json<ApiResponse<{ daemonId: string; recordedAt: string }>>({
      ok: true,
      data: { daemonId, recordedAt: now.toISOString() },
    });
  });

  return router;
}
