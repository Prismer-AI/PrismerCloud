/**
 * Prismer IM — Remote (paired daemon / desktop) API.
 *
 * GET /api/im/remote/bindings — list daemons paired to the current user.
 *
 * Wave-7 ζ surfaced this as a missing endpoint that mobile (luminmobile)
 * calls on app launch to populate the "Paired devices" section. The cloud
 * has no first-class IMDesktopBinding model yet (see workspace-runtime.ts
 * §Task 8 note); in the meantime we derive distinct daemons from
 * IMAgentCard.metadata.daemonId — the same source the
 * /api/im/workspaces/:wsId/runtime endpoint uses for its `devices` array.
 *
 * If a daemon is paired but has no agents registered yet, it currently
 * returns an empty bindings list. Mobile can fall back to
 * /api/im/workspaces/:wsId/runtime for an authoritative live view.
 */

import { Hono } from 'hono';
import { authMiddleware } from '../auth/middleware';
import prisma from '../db';
import type { ApiResponse } from '../types/index';
import { isDaemonForgotten } from '../services/runtime-binding.service';

export function createRemoteRouter() {
  const router = new Hono();
  router.use('*', authMiddleware);

  router.get('/bindings', async (c) => {
    const authUser = c.get('user');

    const caller = await prisma.iMUser.findUnique({
      where: { id: authUser.imUserId },
      select: { userId: true },
    });
    const ownerCloudUserId = caller?.userId ?? null;
    if (!ownerCloudUserId) {
      return c.json<ApiResponse>({ ok: true, data: [] });
    }

    // Find every IMAgentCard whose owner IMUser is mine, and bucket by
    // metadata.daemonId. One bucket = one paired daemon.
    const cards = await prisma.iMAgentCard.findMany({
      where: { imUser: { userId: ownerCloudUserId } },
      include: {
        imUser: { select: { displayName: true, username: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    type CardRow = (typeof cards)[number] & { workspaceId: string; metadata: string };
    const cardRows = cards as CardRow[];
    const workspaceIds = [...new Set(cardRows.map((card: CardRow) => card.workspaceId).filter(Boolean))];
    const workspaces = await prisma.iMWorkspace.findMany({
      where: { id: { in: workspaceIds }, deletedAt: null },
      select: { id: true, metadata: true },
    });
    const workspaceMetadata = new Map<string, string>(
      workspaces.map((ws: { id: string; metadata: string }) => [ws.id, ws.metadata]),
    );

    interface BindingRow {
      daemonId: string;
      deviceName: string;
      agentCount: number;
      lastHeartbeat: Date | null;
      sampleAgents: Array<{ id: string; name: string }>;
    }
    const buckets = new Map<string, BindingRow>();

    for (const card of cardRows) {
      let daemonId: string | null = null;
      try {
        const meta = JSON.parse(card.metadata || '{}') as { daemonId?: string };
        daemonId = meta.daemonId ?? null;
      } catch {
        /* ignore malformed metadata */
      }
      if (!daemonId) continue;
      const metadata = workspaceMetadata.get(card.workspaceId) ?? null;
      if (isDaemonForgotten(metadata, daemonId)) continue;

      const existing = buckets.get(daemonId);
      const agentInfo = {
        id: card.imUserId,
        name: card.imUser.displayName || card.imUser.username || card.name,
      };
      if (existing) {
        existing.agentCount += 1;
        if (existing.sampleAgents.length < 3) existing.sampleAgents.push(agentInfo);
        if (card.lastHeartbeat && (!existing.lastHeartbeat || card.lastHeartbeat > existing.lastHeartbeat)) {
          existing.lastHeartbeat = card.lastHeartbeat;
        }
      } else {
        buckets.set(daemonId, {
          daemonId,
          // Use first 8 chars of daemonId as friendly fallback. The cloud
          // doesn't currently persist a per-daemon "deviceName" — Wave-2b
          // pairing wrote it into pc_api_keys.label, but that's outside the
          // IM Prisma reach. Mobile can rename via Settings later.
          deviceName: `Daemon ${daemonId.slice(0, 8)}`,
          agentCount: 1,
          lastHeartbeat: card.lastHeartbeat,
          sampleAgents: [agentInfo],
        });
      }
    }

    const data = [...buckets.values()].map((b) => ({
      ...b,
      lastHeartbeat: b.lastHeartbeat ? b.lastHeartbeat.toISOString() : null,
    }));

    return c.json<ApiResponse>({ ok: true, data });
  });

  return router;
}
