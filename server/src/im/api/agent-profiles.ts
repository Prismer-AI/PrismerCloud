/**
 * Prismer IM — Agent Profiles API (v1.9.x Track A m1)
 *
 * AgentProfile = adapter-local config instance (cwd / model / MCP / env / prompt).
 * 1 IMUser (agent) → many AgentProfiles. What OpenClaw / Hermes call "workspace"
 * maps to this concept; do not confuse with IMWorkspace.
 *
 * See docs/refactor/02-workspace-data-model.md and docs/refactor/05-adapter-contract.md.
 *
 * Endpoints:
 *   GET    /agent_profiles?agentId=...   — list profiles for an agent
 *   POST   /agent_profiles               — create
 *   GET    /agent_profiles/sync          — daemon delta sync (?since=<ISO>)
 *   GET    /agent_profiles/:id
 *   PATCH  /agent_profiles/:id           — bumps version (optimistic lock)
 *   DELETE /agent_profiles/:id           — soft delete
 */

import { Hono } from 'hono';
import { authMiddleware } from '../auth/middleware';
import prisma from '../db';
import type { ApiResponse } from '../types/index';
import { ServerEvents } from '../ws/events';
import type { RoomManager } from '../ws/rooms';

interface AgentProfileDTO {
  id: string;
  workspaceId: string;
  agentImUserId: string;
  agentUsername: string;
  adapterName: string;
  name: string;
  config: Record<string, unknown>;
  version: number;
  createdAt: string;
  updatedAt: string;
}

type AgentProfileRowWithAgent = {
  id: string;
  workspaceId: string;
  agentImUserId: string;
  adapterName: string;
  name: string;
  config: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

function toDTO(row: AgentProfileRowWithAgent, agentUsername: string): AgentProfileDTO {
  let config: Record<string, unknown> = {};
  try {
    config = row.config ? JSON.parse(row.config) : {};
  } catch {
    config = {};
  }
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    agentImUserId: row.agentImUserId,
    agentUsername,
    adapterName: row.adapterName,
    name: row.name,
    config,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Batch-resolve agent usernames for a list of profile rows.
 * Returns a Map of agentImUserId → username (falls back to the id if not found).
 */
async function resolveAgentUsernames(agentImUserIds: string[]): Promise<Map<string, string>> {
  const unique = Array.from(new Set(agentImUserIds));
  if (unique.length === 0) return new Map();
  const users = await prisma.iMUser.findMany({
    where: { id: { in: unique } },
    select: { id: true, username: true },
  });
  const map = new Map<string, string>();
  for (const u of users) map.set(u.id, u.username);
  // Fallback for any missing id → use the id itself (defensive; FK should guarantee existence)
  for (const id of unique) if (!map.has(id)) map.set(id, id);
  return map;
}

/**
 * Verify the caller owns the workspace. Returns the workspace row on success,
 * or null if the workspace doesn't exist or doesn't belong to the caller.
 */
async function loadOwnedWorkspace(workspaceId: string, callerImUserId: string) {
  const ws = await prisma.iMWorkspace.findFirst({
    where: { id: workspaceId, deletedAt: null },
    select: { id: true, ownerImUserId: true },
  });
  if (!ws || ws.ownerImUserId !== callerImUserId) return null;
  return ws;
}

export function createAgentProfilesRouter(rooms?: RoomManager) {
  const router = new Hono();

  router.use('*', authMiddleware);

  // GET /agent_profiles?agentId=...&workspaceId=...
  router.get('/', async (c) => {
    const user = c.get('user');
    const agentId = c.req.query('agentId');
    const workspaceId = c.req.query('workspaceId');
    if (!agentId && !workspaceId) {
      return c.json<ApiResponse>({ ok: false, error: 'agentId or workspaceId is required' }, 400);
    }

    if (workspaceId) {
      const ws = await loadOwnedWorkspace(workspaceId, user.imUserId);
      if (!ws) return c.json<ApiResponse>({ ok: false, error: 'Workspace not found' }, 404);
    }

    const rows = await prisma.iMAgentProfile.findMany({
      where: {
        deletedAt: null,
        ...(agentId ? { agentImUserId: agentId } : {}),
        ...(workspaceId ? { workspaceId } : {}),
        // owner check via workspace join
        workspace: { ownerImUserId: user.imUserId, deletedAt: null },
      },
      orderBy: { updatedAt: 'desc' },
    });
    const usernameMap = await resolveAgentUsernames(rows.map((r: AgentProfileRowWithAgent) => r.agentImUserId));
    return c.json<ApiResponse<AgentProfileDTO[]>>({
      ok: true,
      data: rows.map((r: AgentProfileRowWithAgent) => toDTO(r, usernameMap.get(r.agentImUserId) ?? r.agentImUserId)),
    });
  });

  // POST /agent_profiles
  router.post('/', async (c) => {
    const user = c.get('user');
    let body: {
      workspaceId?: string;
      agentImUserId?: string;
      adapterName?: string;
      name?: string;
      config?: Record<string, unknown>;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Invalid JSON body' }, 400);
    }

    const { workspaceId, agentImUserId, adapterName, name } = body;
    if (!workspaceId || !agentImUserId || !adapterName || !name) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: 'workspaceId, agentImUserId, adapterName, name are all required',
        },
        400,
      );
    }

    const ws = await loadOwnedWorkspace(workspaceId, user.imUserId);
    if (!ws) return c.json<ApiResponse>({ ok: false, error: 'Workspace not found' }, 404);

    // Hermes adapter: each agent must have its OWN profileDir / port /
    // SOUL.md / MCP env. Sharing them (the previous "force one apiKey across
    // workspace" hack) caused the SOUL.md race + the MCP-as-Tom senderId
    // bug — see MIGRATION-per-agent-profile.sql for the data migration that
    // backfilled existing rows. Now stamp per-agent defaults at create time:
    //   hermesProfileName = agent.username
    //   port              = 8642 + CRC32(username) % 1000 (deterministic, low collision)
    // Caller may still override either via body.config.
    const incomingConfig: Record<string, unknown> = { ...(body.config ?? {}) };
    if (adapterName === 'hermes' && agentImUserId) {
      const needsProfileName =
        typeof incomingConfig.hermesProfileName !== 'string' ||
        incomingConfig.hermesProfileName === 'default' ||
        !incomingConfig.hermesProfileName;
      const needsPort = typeof incomingConfig.port !== 'number' || incomingConfig.port === 8642;
      if (needsProfileName || needsPort) {
        const agentRow = await prisma.iMUser.findUnique({
          where: { id: agentImUserId },
          select: { username: true },
        });
        if (agentRow?.username) {
          if (needsProfileName) incomingConfig.hermesProfileName = agentRow.username;
          if (needsPort) {
            // Stable per-username hash → 8642..9641
            let h = 0;
            for (let i = 0; i < agentRow.username.length; i++) {
              h = (h * 31 + agentRow.username.charCodeAt(i)) | 0;
            }
            incomingConfig.port = 8642 + (Math.abs(h) % 1000);
          }
        }
      }
    }

    try {
      const created = await prisma.iMAgentProfile.create({
        data: {
          workspaceId,
          agentImUserId,
          adapterName,
          name,
          config: JSON.stringify(incomingConfig),
        },
      });
      rooms?.sendToUser(
        user.imUserId,
        ServerEvents.agentProfileChanged({ profileId: created.id, version: created.version }),
      );
      const agent = await prisma.iMUser.findUnique({
        where: { id: created.agentImUserId },
        select: { username: true },
      });
      return c.json<ApiResponse<AgentProfileDTO>>(
        { ok: true, data: toDTO(created, agent?.username ?? created.agentImUserId) },
        201,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Unique') || msg.includes('UNIQUE')) {
        return c.json<ApiResponse>(
          { ok: false, error: 'A profile with this name already exists for this agent in this workspace' },
          409,
        );
      }
      return c.json<ApiResponse>({ ok: false, error: msg }, 500);
    }
  });

  // GET /agent_profiles/sync — daemon delta sync (registered before /:id)
  router.get('/sync', async (c) => {
    const user = c.get('user');
    const sinceParam = c.req.query('since');
    const sinceDate = sinceParam ? new Date(sinceParam) : null;
    if (sinceParam && (!sinceDate || isNaN(sinceDate.getTime()))) {
      return c.json<ApiResponse>({ ok: false, error: 'since must be a valid ISO timestamp' }, 400);
    }
    const rows = await prisma.iMAgentProfile.findMany({
      where: {
        workspace: { ownerImUserId: user.imUserId, deletedAt: null },
        ...(sinceDate ? { updatedAt: { gt: sinceDate } } : {}),
      },
      orderBy: { updatedAt: 'asc' },
    });
    const cursor = rows.length > 0 ? rows[rows.length - 1].updatedAt.toISOString() : (sinceParam ?? null);
    const usernameMap = await resolveAgentUsernames(rows.map((r: AgentProfileRowWithAgent) => r.agentImUserId));
    return c.json<ApiResponse<{ items: AgentProfileDTO[]; cursor: string | null }>>({
      ok: true,
      data: {
        items: rows.map((r: AgentProfileRowWithAgent) => toDTO(r, usernameMap.get(r.agentImUserId) ?? r.agentImUserId)),
        cursor,
      },
    });
  });

  // GET /agent_profiles/:id
  router.get('/:id', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const row = await prisma.iMAgentProfile.findFirst({
      where: { id, deletedAt: null, workspace: { ownerImUserId: user.imUserId } },
    });
    if (!row) return c.json<ApiResponse>({ ok: false, error: 'Profile not found' }, 404);
    const agent = await prisma.iMUser.findUnique({
      where: { id: row.agentImUserId },
      select: { username: true },
    });
    return c.json<ApiResponse<AgentProfileDTO>>({
      ok: true,
      data: toDTO(row, agent?.username ?? row.agentImUserId),
    });
  });

  // PATCH /agent_profiles/:id
  router.patch('/:id', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const row = await prisma.iMAgentProfile.findFirst({
      where: { id, deletedAt: null, workspace: { ownerImUserId: user.imUserId } },
    });
    if (!row) return c.json<ApiResponse>({ ok: false, error: 'Profile not found' }, 404);

    let body: {
      name?: string;
      config?: Record<string, unknown>;
      version?: number; // optional optimistic-lock guard
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Invalid JSON body' }, 400);
    }

    if (typeof body.version === 'number' && body.version !== row.version) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: { code: 'version_conflict', message: `Profile is at version ${row.version}` },
          meta: { currentVersion: row.version },
        },
        409,
      );
    }

    const data: Record<string, unknown> = { version: { increment: 1 } };
    if (typeof body.name === 'string' && body.name.trim()) data.name = body.name.trim();
    if (body.config && typeof body.config === 'object') data.config = JSON.stringify(body.config);
    if (Object.keys(data).length === 1) {
      // only version increment with no other fields → reject
      return c.json<ApiResponse>({ ok: false, error: 'No updatable fields supplied' }, 400);
    }

    const updated = await prisma.iMAgentProfile.update({ where: { id }, data });
    rooms?.sendToUser(
      user.imUserId,
      ServerEvents.agentProfileChanged({ profileId: updated.id, version: updated.version }),
    );
    const agent = await prisma.iMUser.findUnique({
      where: { id: updated.agentImUserId },
      select: { username: true },
    });
    return c.json<ApiResponse<AgentProfileDTO>>({
      ok: true,
      data: toDTO(updated, agent?.username ?? updated.agentImUserId),
    });
  });

  // DELETE /agent_profiles/:id — soft delete
  router.delete('/:id', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const row = await prisma.iMAgentProfile.findFirst({
      where: { id, deletedAt: null, workspace: { ownerImUserId: user.imUserId } },
    });
    if (!row) return c.json<ApiResponse>({ ok: false, error: 'Profile not found' }, 404);
    const deleted = await prisma.iMAgentProfile.update({
      where: { id },
      data: { deletedAt: new Date(), version: { increment: 1 } },
    });
    rooms?.sendToUser(
      user.imUserId,
      ServerEvents.agentProfileChanged({ profileId: deleted.id, version: deleted.version }),
    );
    return c.json<ApiResponse>({ ok: true });
  });

  return router;
}
