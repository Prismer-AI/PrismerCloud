/**
 * Prismer IM — Workspace runtime aggregate + SSE stream (Cloud 2.5)
 *
 *   GET /workspaces/:wsId/runtime         — devices + agents snapshot
 *   GET /workspaces/:wsId/runtime/events  — SSE stream of agent.heartbeat events
 *
 * Agent-to-daemon ownership is resolved from im_agent_bindings.boundDaemonId.
 * IMAgentCard.metadata.daemonId is retained only as a legacy fallback for
 * agents that do not yet have a binding row.
 */

import { Hono } from 'hono';
import type Redis from 'ioredis';
import { authMiddleware } from '../auth/middleware';
import prisma from '../db';
import type { ApiResponse } from '../types/index';
import {
  addForgottenDaemonId,
  getForgottenDaemonIds,
  removeForgottenDaemonId,
} from '../services/runtime-binding.service';

interface PresencePayload {
  status: 'online' | 'busy' | 'idle' | 'offline';
  load?: number | null;
  activeConversations?: number | null;
  deviceId?: string | null;
  currentTaskId?: string | null;
  version?: string | null;
  lastHeartbeat: number;
}

interface RuntimeAgent {
  id: string;
  name: string;
  status: PresencePayload['status'];
  currentTaskId: string | null;
  version: string | null;
  lastHeartbeat: string | null;
  authoritativeDaemonId?: string;
  projectedDaemonId?: string;
  bindingMismatch?: boolean;
}

interface RuntimeDevice {
  deviceId: string;
  name: string;
  lastSeenAt: string | null;
  agents: RuntimeAgent[];
  /**
   * Wave-8 W5 — daemon plane readiness collapsed from heartbeat freshness.
   *   connected — lastSeenAt within HEARTBEAT_FRESH_MS
   *   stale     — lastSeenAt older than HEARTBEAT_FRESH_MS but a device row exists
   *   offline   — no heartbeat recorded
   */
  daemonStatus: 'connected' | 'stale' | 'offline';
  /**
   * Wave 5 F5 (§4.8.1, E4 hand-off) — daemon-reported transport probe.
   * Joined from `im_containers` by daemonId so the DevicesPanel can render
   * a "Recommended Transport" pill without a separate per-daemon diagnose
   * round-trip. `null` when the daemon has never sent a transport-report
   * (legacy row / not-yet-paired daemon).
   */
  transport: 'ws' | 'http' | 'both' | null;
  gatewayIsPrivate: boolean | null;
  lastProbeAt: string | null;
}

/** Mirrors `ONLINE_WINDOW_MS` in workspace/components/runtime-manager.tsx. */
const HEARTBEAT_FRESH_MS = 90_000;

interface RuntimeDevicePresence {
  daemonId?: string;
  deviceId?: string;
  name?: string;
  lastSeenAt?: number;
  hostedAgents?: number;
  daemonVersion?: string | null;
}

interface RuntimeSnapshot {
  workspaceId: string;
  devices: RuntimeDevice[];
}

export function createWorkspaceRuntimeRouter(redis: Redis) {
  const router = new Hono();
  // eslint-disable-next-line custom/no-wildcard-sub-router-middleware -- mounted at /workspaces (nested /:wsId/runtime) in routes.ts; wildcard scoped to that prefix
  router.use('*', authMiddleware);

  router.get('/:wsId/runtime', async (c) => {
    const user = c.get('user');
    const wsId = c.req.param('wsId');
    const ws = await prisma.iMWorkspace.findFirst({
      where: { id: wsId, deletedAt: null },
      select: { id: true, ownerImUserId: true },
    });
    if (!ws || ws.ownerImUserId !== user.imUserId) {
      return c.json<ApiResponse>({ ok: false, error: 'Workspace not found' }, 404);
    }
    const snapshot = await buildSnapshot(wsId, redis);
    // No client cache: this endpoint is mutation-driven (agent register +
    // device pair refresh) and the page polls it every 5s. A 5s max-age
    // races with the post-mutation reload — the browser serves stale data
    // and the LeftRail tree never sees the new agent until the next user
    // gesture. Until SSE `/runtime/events` is wired everywhere, force fresh.
    c.header('Cache-Control', 'no-store');
    return c.json<ApiResponse<RuntimeSnapshot>>({ ok: true, data: snapshot });
  });

  router.get('/:wsId/runtime/devices/:daemonId/logs', async (c) => {
    const user = c.get('user');
    const wsId = c.req.param('wsId');
    const daemonId = decodeURIComponent(c.req.param('daemonId')).trim();
    if (!daemonId) {
      return c.json<ApiResponse>({ ok: false, error: 'invalid_daemon_id' }, 400);
    }

    const ws = await prisma.iMWorkspace.findFirst({
      where: { id: wsId, deletedAt: null },
      select: { id: true, ownerImUserId: true, metadata: true },
    });
    if (!ws || ws.ownerImUserId !== user.imUserId) {
      return c.json<ApiResponse>({ ok: false, error: 'Workspace not found' }, 404);
    }
    if (isDaemonForgottenForMetadata(ws.metadata, daemonId)) {
      return c.json<ApiResponse>({ ok: false, error: 'Daemon binding has been removed' }, 410);
    }

    // K8S device path: redirect to the existing SSE-streaming logs endpoint
    // at `/api/sandboxes/:id/logs` (Next.js route, src/app/api/sandboxes/
    // [id]/logs/route.ts). That route is poll-and-diff SSE which is what
    // the workspace UI's runtime-manager.tsx streamLogs() consumer expects
    // (Authorization Bearer + SSE `data:` frames). 307 Temporary Redirect
    // preserves both method and Authorization header (per HTTP spec).
    //
    // Lookup by daemonId, prefer non-stopped non-local row (matches the
    // T11 dup-row guard + commit c286b1dc semantics: K8S row is canonical
    // when both exist).
    const container = (await prisma.iMContainer.findFirst({
      where: { workspaceId: wsId, daemonId, stoppedAt: null },
      orderBy: [{ deviceType: 'desc' }, { createdAt: 'desc' }], // 'k8s' > 'local' alphabetically descending
      select: { id: true, podName: true, deviceType: true, status: true, runtimeKind: true },
    })) as { id: string; podName: string; deviceType: string; status: string; runtimeKind: string } | null;

    const isK8sDevice = container && (container.deviceType === 'k8s' || container.runtimeKind === 'k8s');
    if (isK8sDevice && container) {
      // Pass through any query string (?tail=, ?timestamps=).
      const inboundUrl = new URL(c.req.url);
      const search = inboundUrl.search ? inboundUrl.search : '';
      const redirectTarget = `/api/sandboxes/${encodeURIComponent(container.id)}/logs${search}`;
      return c.redirect(redirectTarget, 307);
    }

    // Local daemon: still 501 (no transport channel). TODO(runtime-control-
    // plane): independent device observability channel over daemon WS
    // (e.g. runtime.logs.tail) — deferred per the agent IM/task/board
    // closure release block.
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          'Local daemon logs are not available through the cloud API. Use the terminal panel for command output or run `prismer daemon logs` on the linked machine.',
      },
      501,
    );
  });

  router.post('/:wsId/runtime/bindings/:daemonId/forget', async (c) => {
    const user = c.get('user');
    const wsId = c.req.param('wsId');
    const daemonId = c.req.param('daemonId').trim();
    if (!daemonId) {
      return c.json<ApiResponse>({ ok: false, error: 'invalid_daemon_id' }, 400);
    }

    const ws = await prisma.iMWorkspace.findFirst({
      where: { id: wsId, deletedAt: null },
      select: { id: true, ownerImUserId: true, metadata: true },
    });
    if (!ws || ws.ownerImUserId !== user.imUserId) {
      return c.json<ApiResponse>({ ok: false, error: 'Workspace not found' }, 404);
    }

    const nextMetadata = addForgottenDaemonId(ws.metadata, daemonId);
    if (nextMetadata !== ws.metadata) {
      await prisma.iMWorkspace.update({
        where: { id: ws.id },
        data: { metadata: nextMetadata },
      });
    }
    await redis.del(`runtime:device:${wsId}:${daemonId}`).catch(() => {});
    await redis.srem(`runtime:devices:${wsId}`, daemonId).catch(() => {});
    await prisma.iMContainer
      .updateMany({
        where: { workspaceId: wsId, taskId: null, daemonId },
        data: { status: 'stopped', stoppedAt: new Date() },
      })
      .catch(() => {});

    return c.json<ApiResponse>({ ok: true, data: { workspaceId: wsId, daemonId, forgotten: true } });
  });

  router.post('/:wsId/runtime/bindings/:daemonId/restore', async (c) => {
    const user = c.get('user');
    const wsId = c.req.param('wsId');
    const daemonId = c.req.param('daemonId').trim();
    if (!daemonId) {
      return c.json<ApiResponse>({ ok: false, error: 'invalid_daemon_id' }, 400);
    }

    const ws = await prisma.iMWorkspace.findFirst({
      where: { id: wsId, deletedAt: null },
      select: { id: true, ownerImUserId: true, metadata: true },
    });
    if (!ws || ws.ownerImUserId !== user.imUserId) {
      return c.json<ApiResponse>({ ok: false, error: 'Workspace not found' }, 404);
    }

    const nextMetadata = removeForgottenDaemonId(ws.metadata, daemonId);
    if (nextMetadata !== ws.metadata) {
      await prisma.iMWorkspace.update({
        where: { id: ws.id },
        data: { metadata: nextMetadata },
      });
    }

    return c.json<ApiResponse>({ ok: true, data: { workspaceId: wsId, daemonId, forgotten: false } });
  });

  router.get('/:wsId/runtime/events', async (c) => {
    const user = c.get('user');
    const wsId = c.req.param('wsId');
    const ws = await prisma.iMWorkspace.findFirst({
      where: { id: wsId, deletedAt: null },
      select: { id: true, ownerImUserId: true },
    });
    if (!ws || ws.ownerImUserId !== user.imUserId) {
      return c.json<ApiResponse>({ ok: false, error: 'Workspace not found' }, 404);
    }

    const sub = redis.duplicate();
    const watch = new Set(await listWorkspaceAgentImUserIds(wsId));

    const stream = new ReadableStream({
      async start(controller) {
        await sub.subscribe('presence:agent:changes');
        const initial = `event: snapshot\ndata: ${JSON.stringify(await buildSnapshot(wsId, redis))}\n\n`;
        controller.enqueue(new TextEncoder().encode(initial));

        sub.on('message', (_channel, message) => {
          try {
            const evt = JSON.parse(message) as { userId: string } & PresencePayload;
            if (!watch.has(evt.userId)) return;
            const data = `event: agent.heartbeat\ndata: ${JSON.stringify(evt)}\n\n`;
            controller.enqueue(new TextEncoder().encode(data));
          } catch {
            /* skip malformed */
          }
        });

        const ping = setInterval(() => {
          try {
            controller.enqueue(new TextEncoder().encode(': ping\n\n'));
          } catch {
            /* closed */
          }
        }, 25_000);

        c.req.raw.signal.addEventListener('abort', () => {
          clearInterval(ping);
          sub.unsubscribe('presence:agent:changes').catch(() => {});
          sub.disconnect();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        });
      },
      cancel() {
        sub.disconnect();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  });

  return router;
}

async function listWorkspaceAgentImUserIds(wsId: string): Promise<string[]> {
  const cards = await prisma.iMAgentCard.findMany({
    where: { workspaceId: wsId },
    select: { imUserId: true },
  });
  return cards.map((c: { imUserId: string }) => c.imUserId);
}

interface AgentBindingProjection {
  boundDaemonId: string;
}

export async function buildSnapshot(wsId: string, redis: Redis): Promise<RuntimeSnapshot> {
  const forgottenDaemonIds = await loadForgottenDaemonIds(wsId);
  const groups = await loadRuntimeDevicePresence(wsId, redis, forgottenDaemonIds);
  const cards = await prisma.iMAgentCard.findMany({
    where: { workspaceId: wsId },
    include: { imUser: { select: { displayName: true, username: true } } },
  });
  if (cards.length === 0) return snapshotFromGroups(wsId, groups, await loadTransportByDaemonId(wsId, groups));

  const pipeline = redis.pipeline();
  for (const card of cards) pipeline.get(`presence:agent:${card.imUserId}`);
  const presenceResults = (await pipeline.exec()) ?? [];
  const presenceByUserId = new Map<string, PresencePayload | null>();
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    const [err, raw] = presenceResults[i] as [Error | null, string | null];
    if (!err && raw) {
      try {
        presenceByUserId.set(card.imUserId, JSON.parse(raw));
      } catch {
        presenceByUserId.set(card.imUserId, null);
      }
    } else {
      presenceByUserId.set(card.imUserId, null);
    }
  }
  const bindingByAgentImUserId = await loadAgentBindingsByAgentImUserId(
    cards.map((card: { imUserId: string }) => card.imUserId),
  );

  for (const card of cards) {
    const presence = presenceByUserId.get(card.imUserId) ?? null;
    const projectedDaemonId = firstNonEmptyString(presence?.deviceId, legacyMetadataDaemonId(card.metadata));
    const authoritativeDaemonId = firstNonEmptyString(
      bindingByAgentImUserId.get(card.imUserId)?.boundDaemonId,
      legacyMetadataDaemonId(card.metadata),
      presence?.deviceId,
    );
    const bindingMismatch =
      Boolean(bindingByAgentImUserId.has(card.imUserId)) &&
      Boolean(projectedDaemonId) &&
      Boolean(authoritativeDaemonId) &&
      projectedDaemonId !== authoritativeDaemonId;

    if (authoritativeDaemonId && forgottenDaemonIds.has(authoritativeDaemonId)) continue;
    const deviceId = authoritativeDaemonId;
    const groupKey = deviceId ?? '__unbound__';
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        deviceId: groupKey,
        name: groupKey === '__unbound__' ? 'Unbound agents' : `Daemon ${groupKey.slice(0, 8)}`,
        lastSeenAt: null,
        agents: [],
      };
      groups.set(groupKey, group);
    }
    const lastHb = presence?.lastHeartbeat ?? card.lastHeartbeat?.getTime() ?? null;
    if (lastHb && (!group.lastSeenAt || lastHb > group.lastSeenAt)) group.lastSeenAt = lastHb;

    group.agents.push({
      id: card.imUserId,
      name: card.imUser.displayName || card.imUser.username || card.name,
      status: presence?.status ?? (card.status as PresencePayload['status']),
      currentTaskId: presence?.currentTaskId ?? null,
      version: presence?.version ?? null,
      lastHeartbeat: lastHb ? new Date(lastHb).toISOString() : null,
      ...(authoritativeDaemonId ? { authoritativeDaemonId } : {}),
      ...(projectedDaemonId ? { projectedDaemonId } : {}),
      ...(bindingMismatch ? { bindingMismatch } : {}),
    });
  }

  return snapshotFromGroups(wsId, groups, await loadTransportByDaemonId(wsId, groups));
}

async function loadAgentBindingsByAgentImUserId(agentImUserIds: string[]): Promise<Map<string, AgentBindingProjection>> {
  const out = new Map<string, AgentBindingProjection>();
  if (agentImUserIds.length === 0) return out;
  try {
    const rows = (await prisma.iMAgentBinding.findMany({
      where: { agentImUserId: { in: agentImUserIds } },
      select: { agentImUserId: true, boundDaemonId: true },
    })) as Array<{ agentImUserId: string; boundDaemonId: string | null }>;
    for (const row of rows) {
      const boundDaemonId = row.boundDaemonId?.trim();
      if (boundDaemonId) out.set(row.agentImUserId, { boundDaemonId });
    }
  } catch {
    // Legacy/dev schemas may not have im_agent_bindings yet. In that case the
    // snapshot keeps the historical metadata/presence projection.
  }
  return out;
}

function legacyMetadataDaemonId(metadata: string | null | undefined): string | null {
  if (!metadata) return null;
  try {
    const meta = JSON.parse(metadata) as { daemonId?: unknown };
    return typeof meta.daemonId === 'string' && meta.daemonId.trim() ? meta.daemonId.trim() : null;
  } catch {
    return null;
  }
}

function firstNonEmptyString(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed) return trimmed;
  }
  return null;
}

/**
 * Wave 5 F5 — pull each daemon's transport probe (E4 §4.8.1) off the
 * `im_containers` row so the devices snapshot can render the
 * "Recommended Transport" pill without an extra round-trip per device.
 * Returns a map keyed by `deviceId` (== `daemonId` in the snapshot).
 */
async function loadTransportByDaemonId(
  wsId: string,
  groups: Map<string, { deviceId: string }>,
): Promise<Map<string, { transport: 'ws' | 'http' | 'both' | null; gatewayIsPrivate: boolean | null; lastProbeAt: string | null }>> {
  const out = new Map<
    string,
    { transport: 'ws' | 'http' | 'both' | null; gatewayIsPrivate: boolean | null; lastProbeAt: string | null }
  >();
  const ids = [...groups.values()].map((g) => g.deviceId).filter((id) => id && id !== '__unbound__');
  if (ids.length === 0) return out;
  try {
    const containers = await prisma.iMContainer.findMany({
      where: { workspaceId: wsId, daemonId: { in: ids } },
      select: { daemonId: true, transport: true, gatewayIsPrivate: true, lastProbeAt: true },
    });
    for (const c of containers) {
      if (!c.daemonId) continue;
      const t = c.transport;
      const transport: 'ws' | 'http' | 'both' | null =
        t === 'ws' || t === 'http' || t === 'both' ? t : null;
      out.set(c.daemonId, {
        transport,
        gatewayIsPrivate: c.gatewayIsPrivate ?? null,
        lastProbeAt: c.lastProbeAt ? c.lastProbeAt.toISOString() : null,
      });
    }
  } catch {
    // best-effort enrichment; if the join fails (schema drift) the snapshot
    // still returns devices, the pill just shows "Probing…".
  }
  return out;
}

async function loadRuntimeDevicePresence(
  wsId: string,
  redis: Redis,
  forgottenDaemonIds: Set<string>,
): Promise<Map<string, { deviceId: string; name: string; lastSeenAt: number | null; agents: RuntimeAgent[] }>> {
  const groups = new Map<
    string,
    { deviceId: string; name: string; lastSeenAt: number | null; agents: RuntimeAgent[] }
  >();
  const ids = await redis.smembers(`runtime:devices:${wsId}`).catch(() => []);
  if (ids.length === 0) return groups;

  const pipeline = redis.pipeline();
  for (const id of ids) pipeline.get(`runtime:device:${wsId}:${id}`);
  const results = (await pipeline.exec()) ?? [];
  await Promise.all(
    ids.map(async (id, index) => {
      const [err, raw] = results[index] as [Error | null, string | null];
      if (err || !raw) {
        await redis.srem(`runtime:devices:${wsId}`, id).catch(() => {});
        return;
      }
      try {
        const presence = JSON.parse(raw) as RuntimeDevicePresence;
        const deviceId = presence.deviceId ?? presence.daemonId ?? id;
        if (forgottenDaemonIds.has(deviceId)) {
          await redis.del(`runtime:device:${wsId}:${id}`).catch(() => {});
          await redis.srem(`runtime:devices:${wsId}`, id).catch(() => {});
          return;
        }
        groups.set(deviceId, {
          deviceId,
          name: presence.name ?? `Daemon ${deviceId.slice(0, 8)}`,
          lastSeenAt: typeof presence.lastSeenAt === 'number' ? presence.lastSeenAt : null,
          agents: [],
        });
      } catch {
        await redis.srem(`runtime:devices:${wsId}`, id).catch(() => {});
      }
    }),
  );
  return groups;
}

async function loadForgottenDaemonIds(wsId: string): Promise<Set<string>> {
  const ws = await prisma.iMWorkspace.findFirst({
    where: { id: wsId, deletedAt: null },
    select: { metadata: true },
  });
  if (!ws) return new Set();
  return new Set(getForgottenDaemonIds(ws.metadata));
}

function isDaemonForgottenForMetadata(metadata: string | null | undefined, daemonId: string): boolean {
  return new Set(getForgottenDaemonIds(metadata)).has(daemonId);
}

function snapshotFromGroups(
  workspaceId: string,
  groups: Map<string, { deviceId: string; name: string; lastSeenAt: number | null; agents: RuntimeAgent[] }>,
  transportByDaemonId: Map<
    string,
    { transport: 'ws' | 'http' | 'both' | null; gatewayIsPrivate: boolean | null; lastProbeAt: string | null }
  > = new Map(),
): RuntimeSnapshot {
  const now = Date.now();
  return {
    workspaceId,
    devices: [...groups.values()].map((g) => {
      const probe = transportByDaemonId.get(g.deviceId) ?? null;
      return {
        deviceId: g.deviceId,
        name: g.name,
        lastSeenAt: g.lastSeenAt ? new Date(g.lastSeenAt).toISOString() : null,
        agents: g.agents,
        // Synthetic group with no real device row (deviceId === '__unbound__'
        // or no lastSeenAt) reports `offline` so the UI can flag agents that
        // declared themselves but lack an associated daemon presence.
        daemonStatus:
          !g.lastSeenAt || g.deviceId === '__unbound__'
            ? 'offline'
            : now - g.lastSeenAt <= HEARTBEAT_FRESH_MS
              ? 'connected'
              : 'stale',
        transport: probe?.transport ?? null,
        gatewayIsPrivate: probe?.gatewayIsPrivate ?? null,
        lastProbeAt: probe?.lastProbeAt ?? null,
      };
    }),
  };
}
