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
import type { SkillService } from '../services/skill.service';
import { AgentSkillError, AgentSkillService } from '../services/agent-skill.service';
import { BuiltInSkillService } from '../services/built-in-skill.service';
import { requireAgentToolAllowed } from '../security/mcp-allowlist';
import { AgentLifecycleError, AgentSpecService } from '../services/agent-spec.service';

export function createAgentsRouter(
  agentService: AgentService,
  agentRegistry: AgentRegistry,
  presenceService: PresenceService,
  rooms?: RoomManager, // optional for backward compat; required for rename broadcast
  skillService?: SkillService,
) {
  const router = new Hono();
  const agentSkillService = skillService ? new AgentSkillService(skillService) : null;
  const agentSpecService = new AgentSpecService();

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
      // Bug Z1.b (v2.0.7 R3.E cookbook real-run): mirror Z1 同款 $transaction
      // (auth/middleware.ts:60 ensureDefaultWorkspace)。workspace + owner
      // im_workspace_members 行同事务写入，否则 owner agent 注册 auto-create
      // 出的 ws 缺 member row，任何后续 task / member 查询都会 403/404。
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- interactive tx client typing matches workspace-member.service pattern
      const ws = await prisma.$transaction(async (tx: any) => {
        const newWs = await tx.iMWorkspace.create({
          data: {
            ownerImUserId: user.imUserId,
            name: 'Personal',
            slug: 'personal',
            isDefault: true,
          },
          select: { id: true },
        });
        await tx.iMWorkspaceMember.create({
          data: {
            workspaceId: newWs.id,
            memberImUserId: user.imUserId,
            role: 'owner',
          },
        });
        return newWs;
      });
      workspaceId = ws.id;
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
    const workspaceId = c.req.query('workspaceId') || c.req.header('X-IM-Workspace') || undefined;

    const agents = await agentRegistry.discover({
      agentType,
      capability,
      onlineOnly,
      workspaceId,
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
   * GET /api/agents/:agentId/skills — List skills installed to an agent.
   */
  router.get('/:agentId/skills', authMiddleware, async (c) => {
    if (!agentSkillService) {
      return c.json<ApiResponse>({ ok: false, error: 'Agent skill service unavailable' }, 503);
    }
    const user = c.get('user');
    const agentId = c.req.param('agentId');
    const workspaceId = c.req.query('workspaceId') || undefined;
    if (!(await canManageAgentSkills(user, agentId, workspaceId))) {
      return c.json<ApiResponse>({ ok: false, error: 'Admin, workspace owner, or agent token required' }, 403);
    }
    const includeInactive = c.req.query('includeInactive') === 'true';
    const data = await agentSkillService.listAgentSkills(agentId, workspaceId, includeInactive);
    return c.json<ApiResponse>({ ok: true, data });
  });

  /**
   * GET /api/agents/:agentId/skills/pending — List daemon sync work.
   */
  router.get('/:agentId/skills/pending', authMiddleware, async (c) => {
    if (!agentSkillService) {
      return c.json<ApiResponse>({ ok: false, error: 'Agent skill service unavailable' }, 503);
    }
    const user = c.get('user');
    const agentId = c.req.param('agentId');
    const workspaceId = c.req.query('workspaceId') || undefined;
    if (!(await canManageAgentSkills(user, agentId, workspaceId))) {
      return c.json<ApiResponse>({ ok: false, error: 'Admin, workspace owner, or agent token required' }, 403);
    }
    const data = await agentSkillService.listPendingAgentSkills(agentId, workspaceId);
    return c.json<ApiResponse>({ ok: true, data });
  });

  /**
   * POST /api/agents/:agentId/skills — Install a skill to an agent.
   * Body: { skillId | slug, workspaceId?, config?, version? }
   */
  router.post('/:agentId/skills', authMiddleware, async (c) => {
    if (!agentSkillService) {
      return c.json<ApiResponse>({ ok: false, error: 'Agent skill service unavailable' }, 503);
    }
    const user = c.get('user');
    const agentId = c.req.param('agentId');
    const body = await c.req.json().catch(() => ({}));
    const workspaceId = body.workspaceId || body.workspace_id || undefined;
    if (!(await canManageAgentSkills(user, agentId, workspaceId))) {
      return c.json<ApiResponse>({ ok: false, error: 'Admin, workspace owner, or agent token required' }, 403);
    }
    const denied = await requireAgentToolAllowed(c, 'prismer.skill.install', workspaceId);
    if (denied) return denied;

    const skillIdOrSlug = body.skillId || body.skill_id || body.slug || body.skillSlug;
    if (!skillIdOrSlug) {
      return c.json<ApiResponse>({ ok: false, error: 'skillId or slug is required' }, 400);
    }

    try {
      const data = await agentSkillService.installSkillToAgent(agentId, skillIdOrSlug, {
        workspaceId,
        config: body.config,
        version: body.version,
      });
      return c.json<ApiResponse>({ ok: true, data }, 201);
    } catch (err: any) {
      if (err?.message === 'Skill not found') {
        return c.json<ApiResponse>({ ok: false, error: 'Skill not found' }, 404);
      }
      return c.json<ApiResponse>({ ok: false, error: err?.message ?? String(err) }, 500);
    }
  });

  /**
   * DELETE /api/agents/:agentId/skills — Uninstall or disable a skill.
   * Built-ins are disabled, not deleted.
   */
  router.delete('/:agentId/skills', authMiddleware, async (c) => {
    if (!agentSkillService) {
      return c.json<ApiResponse>({ ok: false, error: 'Agent skill service unavailable' }, 503);
    }
    const user = c.get('user');
    const agentId = c.req.param('agentId');
    const body = await c.req.json().catch(() => ({}));
    const workspaceId = body.workspaceId || body.workspace_id || c.req.query('workspaceId') || undefined;
    if (!(await canManageAgentSkills(user, agentId, workspaceId))) {
      return c.json<ApiResponse>({ ok: false, error: 'Admin, workspace owner, or agent token required' }, 403);
    }
    const denied = await requireAgentToolAllowed(c, 'prismer.skill.uninstall', workspaceId);
    if (denied) return denied;

    const skillIdOrSlug =
      body.skillId || body.skill_id || body.slug || body.skillSlug || c.req.query('skillId') || c.req.query('slug');
    if (!skillIdOrSlug) {
      return c.json<ApiResponse>({ ok: false, error: 'skillId or slug is required' }, 400);
    }

    const data = await agentSkillService.uninstallSkillFromAgent(agentId, skillIdOrSlug, workspaceId);
    const status = data.status === 'not_found' ? 404 : 200;
    return c.json<ApiResponse>(
      { ok: status === 200, data, ...(status === 404 ? { error: 'Skill not found' } : {}) },
      status as any,
    );
  });

  /**
   * DELETE /api/agents/:agentId/skills/:skillId — Path form for clients that
   * cannot send a JSON body with DELETE.
   */
  router.delete('/:agentId/skills/:skillId', authMiddleware, async (c) => {
    if (!agentSkillService) {
      return c.json<ApiResponse>({ ok: false, error: 'Agent skill service unavailable' }, 503);
    }
    const user = c.get('user');
    const agentId = c.req.param('agentId');
    const skillId = c.req.param('skillId');
    const workspaceId = c.req.query('workspaceId') || undefined;
    if (!(await canManageAgentSkills(user, agentId, workspaceId))) {
      return c.json<ApiResponse>({ ok: false, error: 'Admin, workspace owner, or agent token required' }, 403);
    }
    const denied = await requireAgentToolAllowed(c, 'prismer.skill.uninstall', workspaceId);
    if (denied) return denied;
    const data = await agentSkillService.uninstallSkillFromAgent(agentId, skillId, workspaceId);
    const status = data.status === 'not_found' ? 404 : 200;
    return c.json<ApiResponse>(
      { ok: status === 200, data, ...(status === 404 ? { error: 'Skill not found' } : {}) },
      status as any,
    );
  });

  /**
   * PATCH /api/agents/:agentId/skills/:skillId — Update agent-skill config.
   *
   * release201/13 §3.4 + §11 13-P2 (reviewer P0-3 / 13-D12):
   *   Body { config: Record<string, unknown> }.
   *   Validation against IMSkill.executableJson.configSchema is service-layer.
   *   Caller must own the workspace, own the agent, or be admin — same gate
   *   as install/uninstall (see `canManageAgentSkills`).
   */
  router.patch('/:agentId/skills/:skillId', authMiddleware, async (c) => {
    if (!agentSkillService) {
      return c.json<ApiResponse>({ ok: false, error: 'Agent skill service unavailable' }, 503);
    }
    const user = c.get('user');
    const agentId = c.req.param('agentId');
    const skillId = c.req.param('skillId');
    const body = await c.req.json().catch(() => ({}));
    const workspaceId = body.workspaceId || body.workspace_id || c.req.query('workspaceId') || undefined;

    if (!(await canManageAgentSkills(user, agentId, workspaceId))) {
      return c.json<ApiResponse>({ ok: false, error: 'Admin, workspace owner, or agent token required' }, 403);
    }

    const config = body.config ?? body.skillConfig ?? body.values;
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      return c.json<ApiResponse>({ ok: false, error: 'config must be a JSON object' }, 400);
    }

    try {
      const data = await agentSkillService.updateSkillConfig(agentId, skillId, config as Record<string, unknown>, {
        workspaceId,
      });
      return c.json<ApiResponse>({ ok: true, data });
    } catch (err: any) {
      const status = typeof err?.statusCode === 'number' ? err.statusCode : 500;
      return c.json<ApiResponse>({ ok: false, error: err?.message ?? String(err) }, status as any);
    }
  });

  /**
   * POST /api/agents/:agentId/skills/ack — Daemon sync acknowledgement.
   *
   * F15 (2026-05-20): K8S sandbox pods run the daemon with the workspace's
   * runtime API key (PRISMER_API_KEY env). That key resolves to the
   * workspace OWNER (a human IM user), not to any agent. The daemon needs
   * to ack skill sync on behalf of the hosted agents it hosts — under the
   * pre-F15 check `user.imUserId !== agentId`, that path always 403'd and
   * profile sync silently failed (every skill ack 20× HTTP 403 in test
   * env). Symptom: agent dispatched, skill profile incomplete, Hermes ran
   * with broken profile → emitted SSE `run.cancelled` → user sees agent
   * "not responding". See evidence: f15-skill-ack-auth-2026-05-20.md.
   *
   * Auth modes (env `SKILL_ACK_AUTH_MODE`):
   *   workspace-member (default) — agent self, admin, workspace owner,
   *                                or workspace member can ack
   *   workspace-owner            — agent self, admin, or workspace owner only
   *   agent-only                 — agent self or admin only (pre-F15 behaviour)
   */
  router.post('/:agentId/skills/ack', authMiddleware, async (c) => {
    if (!agentSkillService) {
      return c.json<ApiResponse>({ ok: false, error: 'Agent skill service unavailable' }, 503);
    }
    const user = c.get('user');
    const agentId = c.req.param('agentId');
    const body = await c.req.json().catch(() => ({}));

    const authMode = (process.env.SKILL_ACK_AUTH_MODE ?? 'workspace-member') as
      | 'workspace-member'
      | 'workspace-owner'
      | 'agent-only';

    const isAgentSelf = user.imUserId === agentId;
    const isAdmin = user.role === 'admin';
    let allowed = isAgentSelf || isAdmin;

    if (!allowed && authMode !== 'agent-only') {
      const agentCard = await prisma.iMAgentCard.findUnique({
        where: { imUserId: agentId },
        select: { workspaceId: true },
      });
      if (agentCard?.workspaceId) {
        const ws = await prisma.iMWorkspace.findUnique({
          where: { id: agentCard.workspaceId },
          select: { ownerImUserId: true },
        });
        if (ws?.ownerImUserId === user.imUserId) {
          allowed = true;
        } else if (authMode === 'workspace-member' && ws) {
          const member = await prisma.iMWorkspaceMember.findUnique({
            where: {
              workspaceId_memberImUserId: {
                workspaceId: agentCard.workspaceId,
                memberImUserId: user.imUserId,
              },
            },
            select: { memberImUserId: true },
          });
          allowed = Boolean(member);
        }
      }
    }

    if (!allowed) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: `Forbidden under SKILL_ACK_AUTH_MODE=${authMode} — caller is not the agent, admin, or workspace member`,
        },
        403,
      );
    }

    try {
      const data = await agentSkillService.ackAgentSkill(agentId, body);
      return c.json<ApiResponse>({ ok: true, data });
    } catch (err) {
      if (err instanceof AgentSkillError) {
        return c.json<ApiResponse>({ ok: false, error: err.message }, err.statusCode as any);
      }
      const message = err instanceof Error ? err.message : String(err);
      return c.json<ApiResponse>({ ok: false, error: message }, 500);
    }
  });

  /**
   * POST /api/agents/:agentId/skills/install-builtins — backfill built-in
   * skills for an agent that missed the auto-install at register time.
   *
   * F19 (2026-05-20): `BuiltInSkillService.installAllBuiltInsToAgent` was
   * only invoked from agent register paths (`api/register.ts:781`,
   * `services/agent.service.ts:97`), and the latter is gated on
   * `if (!existingCard)`. Agents created BEFORE the built-in catalog
   * landed (or via early ACP flows that bypassed `agent.service.ts`)
   * therefore have zero `im_agent_skills` rows. Observed in test env:
   * CEO / COO / CMO agents had 0 skills while Engineer (created later
   * via the post-builtin flow) had the full 20.
   *
   * No daemon-side workaround is sustainable — the daemon doesn't know
   * the catalog. Cloud endpoint that the operator (or daemon's
   * skill-sync) can call to repair.
   *
   * Reuses the `/skills/ack` 3-mode auth (SKILL_ACK_AUTH_MODE).
   */
  router.post('/:agentId/skills/install-builtins', authMiddleware, async (c) => {
    if (!agentSkillService) {
      return c.json<ApiResponse>({ ok: false, error: 'Agent skill service unavailable' }, 503);
    }
    const user = c.get('user');
    const agentId = c.req.param('agentId');
    const authMode = (process.env.SKILL_ACK_AUTH_MODE ?? 'workspace-member') as
      | 'workspace-member'
      | 'workspace-owner'
      | 'agent-only';

    const isAgentSelf = user.imUserId === agentId;
    const isAdmin = user.role === 'admin';
    let allowed = isAgentSelf || isAdmin;
    let workspaceId: string | null = null;

    if (!allowed && authMode !== 'agent-only') {
      const agentCard = await prisma.iMAgentCard.findUnique({
        where: { imUserId: agentId },
        select: { workspaceId: true },
      });
      if (agentCard?.workspaceId) {
        workspaceId = agentCard.workspaceId;
        const ws = await prisma.iMWorkspace.findUnique({
          where: { id: agentCard.workspaceId },
          select: { ownerImUserId: true },
        });
        if (ws?.ownerImUserId === user.imUserId) {
          allowed = true;
        } else if (authMode === 'workspace-member' && ws) {
          const member = await prisma.iMWorkspaceMember.findUnique({
            where: {
              workspaceId_memberImUserId: {
                workspaceId: agentCard.workspaceId,
                memberImUserId: user.imUserId,
              },
            },
            select: { memberImUserId: true },
          });
          allowed = Boolean(member);
        }
      }
    } else if (allowed) {
      // Still need the workspaceId for installAllBuiltInsToAgent.
      const agentCard = await prisma.iMAgentCard.findUnique({
        where: { imUserId: agentId },
        select: { workspaceId: true },
      });
      workspaceId = agentCard?.workspaceId ?? null;
    }

    if (!allowed) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: `Forbidden under SKILL_ACK_AUTH_MODE=${authMode} — caller is not the agent, admin, or workspace member`,
        },
        403,
      );
    }

    // 2026-05-29 — built-in skills are a global catalog (BuiltInSkillService
    // .upsertBuiltInSkills accepts `_workspaceId?: string | null` and ignores
    // it; installSkillToAgent's workspaceId is optional). The previous 404
    // here blocked daemon-local agents (created via `prismer pair` / agent
    // register) whose IMAgentCard.workspaceId was never populated — which is
    // exactly the daemon-side backfill path the skill-sync CLI relies on. We
    // log the missing workspace once and pass `null` through so the install
    // proceeds; the per-row workspaceId on im_agent_skills stays null too,
    // which is fine for category=built-in. See release201/09 §9.3.2a Phase 2
    // candidate "host-mode agent backfill 404 → endpoint tolerance".
    if (!workspaceId) {
      console.log(
        `[install-builtins] agent ${agentId.slice(-8)} has no workspaceId; falling back to global built-in catalog`,
      );
    }

    try {
      const builtInService = new BuiltInSkillService(agentSkillService);
      const installed = await builtInService.installAllBuiltInsToAgent(agentId, workspaceId);
      return c.json<ApiResponse>({
        ok: true,
        data: { agentId, workspaceId, installed: installed.length },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json<ApiResponse>({ ok: false, error: message }, 500);
    }
  });

  // release201/09 §9.7.2 Phase 3 — agent quiesce endpoints (pause/resume).
  //
  // POST /api/im/agents/:id/pause   → IMAgentBinding.pausedAt = NOW();
  //                                    cloud dispatch loop SKIPs paused agent.
  // POST /api/im/agents/:id/resume  → IMAgentBinding.pausedAt = NULL.
  //
  // Auth: workspace owner OR active orchestrator OR admin. Same matrix as
  // /api/im/agent-bindings/:id/rebind (intentional — pause is a "soft rebind
  // preparation" + admin transfer move). Both endpoints are idempotent.
  //
  // 404 when no IMAgentBinding row exists (agent never declared by a
  // daemon); transfer cannot proceed without a binding row, so this is a
  // contract requirement rather than a silently-tolerated case.
  const pauseAuthCheck = async (
    c: any,
    agentImUserId: string,
  ): Promise<{ ok: true } | { ok: false; status: 403 | 404; error: string }> => {
    const user = c.get('user');
    const card = await prisma.iMAgentCard.findFirst({
      where: { imUserId: agentImUserId },
      select: { workspaceId: true },
    });
    if (!card?.workspaceId) return { ok: false, status: 404, error: 'Agent not found or has no workspace' };
    const ws = await prisma.iMWorkspace.findFirst({
      where: { id: card.workspaceId, deletedAt: null },
      select: { id: true, ownerImUserId: true, orchestratorAgentId: true, orchestratorRevokedAt: true },
    });
    if (!ws) return { ok: false, status: 404, error: 'Workspace not found' };
    const isOwner = ws.ownerImUserId === user.imUserId;
    const isActiveOrchestrator = ws.orchestratorAgentId === user.imUserId && ws.orchestratorRevokedAt === null;
    const isAdmin = user.role === 'admin';
    if (!isOwner && !isActiveOrchestrator && !isAdmin) {
      return { ok: false, status: 403, error: 'Forbidden' };
    }
    return { ok: true };
  };

  router.post('/:id/pause', authMiddleware, async (c) => {
    const agentImUserId = c.req.param('id');
    const auth = await pauseAuthCheck(c, agentImUserId);
    if (!auth.ok) return c.json<ApiResponse>({ ok: false, error: auth.error }, auth.status);
    const binding = await prisma.iMAgentBinding.findUnique({ where: { agentImUserId } });
    if (!binding) {
      return c.json<ApiResponse>(
        { ok: false, error: 'No binding row exists; agent has never been declared by a daemon' },
        404,
      );
    }
    if (binding.pausedAt) {
      // Idempotent — already paused; return current state.
      return c.json<ApiResponse>({
        ok: true,
        data: { agentImUserId, pausedAt: binding.pausedAt.toISOString(), alreadyPaused: true },
      });
    }
    const now = new Date();
    const updated = await prisma.iMAgentBinding.update({
      where: { agentImUserId },
      data: { pausedAt: now },
    });
    return c.json<ApiResponse>({
      ok: true,
      data: { agentImUserId, pausedAt: updated.pausedAt!.toISOString(), alreadyPaused: false },
    });
  });

  router.post('/:id/resume', authMiddleware, async (c) => {
    const agentImUserId = c.req.param('id');
    const auth = await pauseAuthCheck(c, agentImUserId);
    if (!auth.ok) return c.json<ApiResponse>({ ok: false, error: auth.error }, auth.status);
    const binding = await prisma.iMAgentBinding.findUnique({ where: { agentImUserId } });
    if (!binding) {
      return c.json<ApiResponse>(
        { ok: false, error: 'No binding row exists; agent has never been declared by a daemon' },
        404,
      );
    }
    if (!binding.pausedAt) {
      // Idempotent — not paused; ok.
      return c.json<ApiResponse>({ ok: true, data: { agentImUserId, resumed: false } });
    }
    await prisma.iMAgentBinding.update({
      where: { agentImUserId },
      data: { pausedAt: null },
    });
    return c.json<ApiResponse>({ ok: true, data: { agentImUserId, resumed: true } });
  });

  router.get('/:agentId/spec', authMiddleware, async (c) => {
    const user = c.get('user');
    const agentId = c.req.param('agentId');
    if (!(await agentSpecService.canAccessAgent(user, agentId, 'read'))) {
      return c.json<ApiResponse>({ ok: false, error: { code: 'FORBIDDEN', message: 'Forbidden' } as any }, 403);
    }
    try {
      const data = await agentSpecService.buildSpec(agentId, c.req.query('workspaceId') || undefined);
      return c.json<ApiResponse>({ ok: true, data });
    } catch (err) {
      return mapAgentLifecycleError(c, err);
    }
  });

  router.post('/:agentId/snapshot', authMiddleware, async (c) => {
    const user = c.get('user');
    const agentId = c.req.param('agentId');
    if (!(await agentSpecService.canAccessAgent(user, agentId, 'write'))) {
      return c.json<ApiResponse>({ ok: false, error: { code: 'FORBIDDEN', message: 'Forbidden' } as any }, 403);
    }
    const body = await c.req.json().catch(() => ({}));
    try {
      const data = await agentSpecService.snapshot(agentId, user, {
        includeMemory: Boolean(body.includeMemory),
        label: typeof body.label === 'string' ? body.label : undefined,
        metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : undefined,
      });
      return c.json<ApiResponse>({ ok: true, data }, 201);
    } catch (err) {
      return mapAgentLifecycleError(c, err);
    }
  });

  router.get('/:agentId/snapshots', authMiddleware, async (c) => {
    const user = c.get('user');
    const agentId = c.req.param('agentId');
    if (!(await agentSpecService.canAccessAgent(user, agentId, 'read'))) {
      return c.json<ApiResponse>({ ok: false, error: { code: 'FORBIDDEN', message: 'Forbidden' } as any }, 403);
    }
    try {
      const data = await agentSpecService.listSnapshots(
        agentId,
        c.req.query('cursor') || undefined,
        parsePositiveInt(c.req.query('limit'), 50),
      );
      return c.json<ApiResponse>({ ok: true, data });
    } catch (err) {
      return mapAgentLifecycleError(c, err);
    }
  });

  router.post('/:agentId/restore', authMiddleware, async (c) => {
    const user = c.get('user');
    const agentId = c.req.param('agentId');
    if (!(await agentSpecService.canAccessAgent(user, agentId, 'write'))) {
      return c.json<ApiResponse>({ ok: false, error: { code: 'FORBIDDEN', message: 'Forbidden' } as any }, 403);
    }
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.snapshotId !== 'string' || !body.snapshotId.trim()) {
      return c.json<ApiResponse>(
        { ok: false, error: { code: 'VALIDATION_FAILED', message: 'snapshotId is required' } as any },
        400,
      );
    }
    try {
      const data = await agentSpecService.restore(agentId, user, {
        snapshotId: body.snapshotId,
        overrideMemory: Boolean(body.overrideMemory),
      });
      return c.json<ApiResponse>({ ok: true, data });
    } catch (err) {
      return mapAgentLifecycleError(c, err);
    }
  });

  router.post('/:agentId/publish', authMiddleware, async (c) => {
    const user = c.get('user');
    const agentId = c.req.param('agentId');
    if (!(await agentSpecService.canAccessAgent(user, agentId, 'publish'))) {
      return c.json<ApiResponse>({ ok: false, error: { code: 'FORBIDDEN', message: 'Forbidden' } as any }, 403);
    }
    const body = await c.req.json().catch(() => ({}));
    try {
      const data = await agentSpecService.publish(agentId, user, {
        slug: typeof body.slug === 'string' ? body.slug : undefined,
        version: typeof body.version === 'string' ? body.version : undefined,
        license: typeof body.license === 'string' ? body.license : undefined,
        metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : undefined,
        stripMemory: body.stripMemory !== false,
      });
      return c.json<ApiResponse>({ ok: true, data }, 201);
    } catch (err) {
      return mapAgentLifecycleError(c, err);
    }
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
   *
   * F15 (2026-05-20): caller-auth was `user.imUserId !== userId` strict —
   * fine when an agent posts its own heartbeat using the agent's token, but
   * when a daemon (in K8S sandbox) holds a workspace runtime API key (= ws
   * owner identity) and wants to forward heartbeats over HTTP on behalf of
   * its hosted agents, the strict check 403s. Currently daemons heartbeat
   * via WS host.declare so this HTTP path is unused, but extending the same
   * mode-gated check we added for `/skills/ack` keeps the surface
   * consistent.
   *
   * The post-auth `user.role !== 'agent'` guard below still applies for the
   * agent-self case (since human/admin users have no IMAgentCard and the
   * underlying agentService.heartbeat would P2025). When ws-owner or ws-
   * member acts on behalf of `userId`, that role check is bypassed because
   * the *target* agent's IMAgentCard is what gets updated.
   */
  router.post("/:userId/heartbeat", authMiddleware, async (c) => {
    const user = c.get("user");
    const userId = c.req.param("userId")!;

    const authMode = (process.env.AGENT_PROXY_AUTH_MODE ?? 'workspace-member') as
      | 'workspace-member'
      | 'workspace-owner'
      | 'agent-only';

    const isAgentSelf = user.imUserId === userId;
    const isAdmin = user.role === 'admin';
    let allowed = isAgentSelf || isAdmin;

    if (!allowed && authMode !== 'agent-only') {
      const agentCard = await prisma.iMAgentCard.findUnique({
        where: { imUserId: userId },
        select: { workspaceId: true },
      });
      if (agentCard?.workspaceId) {
        const ws = await prisma.iMWorkspace.findUnique({
          where: { id: agentCard.workspaceId },
          select: { ownerImUserId: true },
        });
        if (ws?.ownerImUserId === user.imUserId) {
          allowed = true;
        } else if (authMode === 'workspace-member' && ws) {
          const member = await prisma.iMWorkspaceMember.findUnique({
            where: {
              workspaceId_memberImUserId: {
                workspaceId: agentCard.workspaceId,
                memberImUserId: user.imUserId,
              },
            },
            select: { memberImUserId: true },
          });
          allowed = Boolean(member);
        }
      }
    }

    if (!allowed) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: `Forbidden under AGENT_PROXY_AUTH_MODE=${authMode} — caller is not the agent, admin, or workspace member`,
        },
        403,
      );
    }

    // The target user must still be an agent — humans/admins have no
    // IMAgentCard and agentService.heartbeat does iMAgentCard.update which
    // throws P2025 → 500 for non-agents. When `isAgentSelf` we can read
    // `user.role`; otherwise (proxy) re-derive role from the URL userId.
    let targetIsAgent = isAgentSelf && user.role === 'agent';
    if (!targetIsAgent && !isAgentSelf) {
      const target = await prisma.iMUser.findUnique({ where: { id: userId }, select: { role: true } });
      targetIsAgent = target?.role === 'agent';
    }
    if (!targetIsAgent) {
      return c.json<ApiResponse>({ ok: false, error: 'Heartbeat target is not an agent user' }, 403);
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

    const { deletedProfileIds } = await agentService.unregister(userId);
    for (const profileId of deletedProfileIds) {
      rooms?.sendToUser(user.imUserId, ServerEvents.agentProfileChanged({ profileId, version: Date.now() }));
    }
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

async function canManageAgentSkills(
  actor: { imUserId: string; role?: string },
  agentId: string,
  workspaceId?: string,
): Promise<boolean> {
  if (actor.role === 'admin' || actor.imUserId === agentId) return true;
  const caller = await prisma.iMUser.findUnique({ where: { id: actor.imUserId }, select: { userId: true } });
  const target = await prisma.iMUser.findUnique({ where: { id: agentId }, select: { role: true, userId: true } });
  if (caller?.userId && target?.role === 'agent' && target.userId === caller.userId) return true;

  const profileWhere: Record<string, unknown> = { agentImUserId: agentId, deletedAt: null };
  if (workspaceId) profileWhere.workspaceId = workspaceId;
  const profile = await prisma.iMAgentProfile.findFirst({
    where: profileWhere,
    select: { workspaceId: true },
    orderBy: { updatedAt: 'desc' },
  });
  if (!profile) return false;
  const workspace = await prisma.iMWorkspace.findFirst({
    where: { id: profile.workspaceId, deletedAt: null, ownerImUserId: actor.imUserId },
    select: { id: true },
  });
  return Boolean(workspace);
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = raw ? Number(raw) : fallback;
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function mapAgentLifecycleError(c: any, err: unknown) {
  if (err instanceof AgentLifecycleError) {
    return c.json({ ok: false, error: { code: err.code, message: err.message } as any }, err.status as any);
  }
  const message = err instanceof Error ? err.message : String(err);
  return c.json({ ok: false, error: { code: 'AGENT_LIFECYCLE_FAILED', message } as any }, 500);
}
