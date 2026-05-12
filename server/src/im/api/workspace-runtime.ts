/**
 * Prismer IM — Workspace runtime aggregate + SSE stream (Cloud 2.5)
 *
 *   GET /workspaces/:wsId/runtime         — devices + agents snapshot
 *   GET /workspaces/:wsId/runtime/events  — SSE stream of agent.heartbeat events
 *
 * Devices inferred from IMAgentCard.metadata.daemonId (or presence.deviceId).
 * No IMDesktopBinding model in this session; see plan §Task 8.
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

async function buildSnapshot(wsId: string, redis: Redis): Promise<RuntimeSnapshot> {
  const forgottenDaemonIds = await loadForgottenDaemonIds(wsId);
  const groups = await loadRuntimeDevicePresence(wsId, redis, forgottenDaemonIds);
  const cards = await prisma.iMAgentCard.findMany({
    where: { workspaceId: wsId },
    include: { imUser: { select: { displayName: true, username: true } } },
  });
  if (cards.length === 0) return snapshotFromGroups(wsId, groups);

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

  for (const card of cards) {
    const presence = presenceByUserId.get(card.imUserId) ?? null;
    let deviceId = presence?.deviceId ?? null;
    if (!deviceId) {
      try {
        const meta = JSON.parse(card.metadata || '{}') as { daemonId?: string };
        deviceId = meta.daemonId ?? null;
      } catch {
        /* leave null */
      }
    }
    if (deviceId && forgottenDaemonIds.has(deviceId)) continue;
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
    });
  }

  return snapshotFromGroups(wsId, groups);
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

function snapshotFromGroups(
  workspaceId: string,
  groups: Map<string, { deviceId: string; name: string; lastSeenAt: number | null; agents: RuntimeAgent[] }>,
): RuntimeSnapshot {
  const now = Date.now();
  return {
    workspaceId,
    devices: [...groups.values()].map((g) => ({
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
    })),
  };
}
