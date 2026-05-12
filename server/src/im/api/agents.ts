/**
 * Prismer IM — Agents API
 *
 * Agent registration, discovery, and management endpoints.
 *
 * v1.9.x Track A m1: adds PATCH /:userId for display-name rename, broadcasts
 * `agent.changed` over WS so other devices update their cache.
 *
 * m2 phase 1 (1.9.2): rename uniqueness check switched to direct
 * `workspaceId` match (now that 110 added the column to im_agent_cards) with
 * cloud-user-equivalence as fallback for rows where the backfill hasn't
 * landed yet. Broadcast switched to `ServerEvents.agentChanged` factory now
 * that Track C added the type to `WSServerEventType` union — placeholder
 * cast removed.
 */

import { Hono } from 'hono';
import { authMiddleware, requireRole } from '../auth/middleware';
import { AgentService } from '../services/agent.service';
import { AgentRegistry } from '../agent-protocol/registry';
import { PresenceService } from '../services/presence.service';
import { AGENT_PROTOCOL_VERSION } from '../agent-protocol/types';
import type { ApiResponse } from '../types/index';
import type { RoomManager } from '../ws/rooms';
import { ServerEvents } from '../ws/events';
import prisma from '../db';

export function createAgentsRouter(
  agentService: AgentService,
  agentRegistry: AgentRegistry,
  presenceService: PresenceService,
  rooms?: RoomManager, // optional for backward compat; required for rename broadcast
) {
  const router = new Hono();

  /**
   * POST /api/agents/register — Register an agent (requires auth as agent user)
   */
  router.post('/register', authMiddleware, async (c) => {
    const user = c.get('user');
    if (user.role !== 'agent' && user.role !== 'admin') {
      return c.json<ApiResponse>({ ok: false, error: 'Only agent users can register' }, 403);
    }

    const body = await c.req.json();
    const { name, description, agentType, capabilities, endpoint, metadata } = body;

    if (!name || !description) {
      return c.json<ApiResponse>({ ok: false, error: 'name and description are required' }, 400);
    }

    // Resolve workspaceId — required by Prisma schema (NOT NULL since 1.9.2 Phase 2).
    // Order: explicit body.workspaceId → existing IMAgentCard.workspaceId →
    // owner's default workspace. Reject if none resolves.
    let workspaceId: string | null = typeof body.workspaceId === 'string' ? body.workspaceId : null;
    if (!workspaceId) {
      const existing = await prisma.iMAgentCard.findUnique({
        where: { imUserId: user.imUserId },
        select: { workspaceId: true },
      });
      if (existing?.workspaceId) workspaceId = existing.workspaceId;
    }
    if (!workspaceId) {
      const ws = await prisma.iMWorkspace.findFirst({
        where: { ownerImUserId: user.imUserId, isDefault: true, deletedAt: null },
        select: { id: true },
      });
      if (ws) workspaceId = ws.id;
    }
    if (!workspaceId) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: 'workspaceId required (no body.workspaceId, no existing agent card, no default workspace)',
        },
        400,
      );
    }

    const card = await agentService.register({
      userId: user.imUserId,
      workspaceId,
      name,
      description,
      agentType: agentType ?? 'assistant',
      capabilities: capabilities ?? [],
      endpoint,
      metadata,
    });

    return c.json<ApiResponse>(
      {
        ok: true,
        data: {
          agentId: card.id,
          userId: user.imUserId,
          protocolVersion: AGENT_PROTOCOL_VERSION,
          card,
        },
      },
      201,
    );
  });

  /**
   * GET /api/agents — Discover agents
   */
  router.get('/', authMiddleware, async (c) => {
    const agentType = c.req.query('agentType') as any;
    const capability = c.req.query('capability');
    const onlineOnly = c.req.query('onlineOnly') === 'true';

    const agents = await agentRegistry.discover({
      agentType,
      capability,
      onlineOnly,
    });

    return c.json<ApiResponse>({ ok: true, data: agents });
  });

  /**
   * PATCH /api/agents/:userId — Rename agent (display name and/or slug username)
   *
   * Updates IMAgentCard.name (displayName) and/or IMUser.username (slug). §30
   * B3.8 Q2 (1.9.x) extended this route to also accept `username` so the
   * workspace UI's inline rename editor can update the IM slug — backend
   * auto-generates `{role-slug}-{cuid4}` at create time, user can rename
   * after the fact. Either field may be sent independently; at least one
   * must be present.
   *
   * Username validation: `/^[a-z][a-z0-9-]{2,30}$/` — lowercase, hyphens,
   * 3-31 chars, must start with a letter. Globally unique (IMUser.username
   * is `@unique`).
   *
   * m2 phase 1: workspace-internal name uniqueness uses the new
   * `workspaceId` column directly when populated, falling back to cloud-user
   * equivalence for rows the backfill (migration 110) didn't reach.
   */
  router.patch('/:userId', authMiddleware, async (c) => {
    const user = c.get('user');
    const agentImUserId = c.req.param('userId');

    let body: { displayName?: string; username?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Invalid JSON body' }, 400);
    }
    const hasDisplayName = typeof body.displayName === 'string';
    const hasUsername = typeof body.username === 'string';
    if (!hasDisplayName && !hasUsername) {
      return c.json<ApiResponse>({ ok: false, error: 'displayName or username is required' }, 400);
    }

    let displayName: string | null = null;
    if (hasDisplayName) {
      displayName = (body.displayName ?? '').trim();
      if (!displayName) {
        return c.json<ApiResponse>({ ok: false, error: 'displayName must not be empty' }, 400);
      }
      if (displayName.length > 128) {
        return c.json<ApiResponse>({ ok: false, error: 'displayName must be ≤ 128 chars' }, 400);
      }
    }

    let username: string | null = null;
    if (hasUsername) {
      username = (body.username ?? '').trim();
      // §30 B3.8 Q2 — slug format: lowercase, hyphens, 3-31 chars,
      // must start with a letter. Mirrors `validateAgentSlug` in
      // src/app/workspace/lib/agent-rename.ts.
      const SLUG_PATTERN = /^[a-z][a-z0-9-]{2,30}$/;
      if (!SLUG_PATTERN.test(username)) {
        return c.json<ApiResponse>(
          {
            ok: false,
            error: 'username must match /^[a-z][a-z0-9-]{2,30}$/ — lowercase, digits, hyphens; start with a letter',
          },
          400,
        );
      }
    }

    const agentUser = await prisma.iMUser.findUnique({
      where: { id: agentImUserId },
      select: { id: true, role: true, userId: true, username: true },
    });
    if (!agentUser || agentUser.role !== 'agent') {
      return c.json<ApiResponse>({ ok: false, error: 'Agent not found' }, 404);
    }

    const card = await prisma.iMAgentCard.findUnique({ where: { imUserId: agentImUserId } });
    if (!card) {
      return c.json<ApiResponse>({ ok: false, error: 'Agent card not found' }, 404);
    }

    const callerImUser = await prisma.iMUser.findUnique({
      where: { id: user.imUserId },
      select: { userId: true },
    });
    const callerCloudUserId = callerImUser?.userId ?? null;
    if (!callerCloudUserId || agentUser.userId !== callerCloudUserId) {
      return c.json<ApiResponse>({ ok: false, error: 'Forbidden' }, 403);
    }

    // displayName uniqueness check: prefer direct workspaceId match (m2 phase
    // 1 happy path). Fall back to cloud-user-equivalence for rows the
    // migration 110 backfill couldn't reach.
    if (displayName !== null && card.name !== displayName) {
      const conflict = card.workspaceId
        ? await prisma.iMAgentCard.findFirst({
            where: {
              name: displayName,
              id: { not: card.id },
              workspaceId: card.workspaceId,
            },
            select: { id: true },
          })
        : await prisma.iMAgentCard.findFirst({
            where: {
              name: displayName,
              id: { not: card.id },
              imUser: { userId: callerCloudUserId },
            },
            select: { id: true },
          });
      if (conflict) {
        return c.json<ApiResponse>({ ok: false, error: 'Name already taken in your workspace' }, 409);
      }

      await prisma.iMAgentCard.update({
        where: { id: card.id },
        data: { name: displayName },
      });
    }

    // username uniqueness: IMUser.username is `@unique` globally. Skip the
    // pre-check / update if value is unchanged; otherwise rely on the
    // unique-constraint catch for the race.
    if (username !== null && agentUser.username !== username) {
      try {
        await prisma.iMUser.update({
          where: { id: agentImUserId },
          data: { username },
        });
      } catch (err) {
        const e = err as { code?: string };
        if (e?.code === 'P2002') {
          return c.json<ApiResponse>({ ok: false, error: 'Username already taken' }, 409);
        }
        throw err;
      }
    }

    // Broadcast `agent.changed` to all caller's WS connections so other
    // devices refresh. Uses the typed factory now that Track C added
    // `agent.changed` to WSServerEventType.
    if (rooms) {
      const fields: { displayName?: string; username?: string } = {};
      if (displayName !== null) fields.displayName = displayName;
      if (username !== null) fields.username = username;
      rooms.sendToUser(user.imUserId, ServerEvents.agentChanged({ agentImUserId, fields }));
    }

    return c.json<ApiResponse>({ ok: true });
  });

  /**
   * GET /api/agents/:userId — Get agent details
   */
  router.get("/:userId", authMiddleware, async (c) => {
    const userId = c.req.param("userId")!;
    const info = await agentRegistry.getAgentInfo(userId);
    if (!info) {
      return c.json<ApiResponse>({ ok: false, error: 'Agent not found' }, 404);
    }

    // Get presence info
    const presence = await presenceService.getStatus(userId);

    return c.json<ApiResponse>({
      ok: true,
      data: { ...info, presence },
    });
  });

  /**
   * POST /api/agents/:userId/heartbeat — Agent heartbeat (alternative to WS)
   */
  router.post("/:userId/heartbeat", authMiddleware, async (c) => {
    const user = c.get("user");
    const userId = c.req.param("userId")!;

    if (user.imUserId !== userId) {
      return c.json<ApiResponse>({ ok: false, error: 'Can only send own heartbeat' }, 403);
    }

    // Heartbeat is agent-only — humans/admins do not have an IMAgentCard,
    // and `agentService.heartbeat` does `iMAgentCard.update`, which throws
    // P2025 (record not found) → 500 when called by a non-agent. Guard here
    // so the failure mode is a clear 403, not a swallowed Prisma stack.
    if (user.role !== 'agent') {
      return c.json<ApiResponse>({ ok: false, error: 'Heartbeat is only valid for agent users' }, 403);
    }

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }

    try {
      await agentService.heartbeat(userId, {
        status: body.status ?? 'online',
        load: body.load,
        activeConversations: body.activeConversations,
        deviceId: body.deviceId,
        currentTaskId: body.currentTaskId,
        version: body.version,
      });
    } catch (err: any) {
      // No IMAgentCard for this user (e.g. agent was deleted but JWT still
      // valid). Surface as 404 instead of leaking the Prisma stack.
      if (err?.code === 'P2025') {
        return c.json<ApiResponse>({ ok: false, error: 'No agent card found for this user — register first' }, 404);
      }
      throw err;
    }

    return c.json<ApiResponse>({ ok: true });
  });

  /**
   * DELETE /api/agents/:userId — Unregister an agent
   */
  router.delete("/:userId", authMiddleware, async (c) => {
    const user = c.get("user");
    const userId = c.req.param("userId")!;

    const allowed = user.imUserId === userId || user.role === 'admin';
    if (!allowed) {
      return c.json<ApiResponse>({ ok: false, error: 'Forbidden' }, 403);
    }

    await agentService.unregister(userId);
    return c.json<ApiResponse>({ ok: true });
  });

  /**
   * GET /api/agents/discover/:capability — Find best agent for a capability
   */
  router.get("/discover/:capability", authMiddleware, async (c) => {
    const capability = c.req.param("capability")!;
    const best = await agentRegistry.findBestForCapability(capability);
    if (!best) {
      return c.json<ApiResponse>({ ok: false, error: 'No agent found for this capability' }, 404);
    }
    return c.json<ApiResponse>({ ok: true, data: best });
  });

  return router;
}
