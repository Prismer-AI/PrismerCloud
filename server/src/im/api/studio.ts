/**
 * Prismer IM — Skill Studio BFF (release201/13 §3.9, 13-P1)
 *
 * Aggregates data for the /evolution → Studio surface. Each endpoint fans
 * out across existing services and returns a single payload. Avoids the
 * client-side N+1 the legacy WorkspaceTab path produced.
 *
 * Phase 1 ships overview / profile / installed. Authoring / lifecycle /
 * evolution / metrics arrive once 07 / 08 / 11 land (13-P2 / 13-P3).
 */

import { Hono } from 'hono';
import { authMiddleware } from '../auth/middleware';
import prisma from '../db';
import type { ApiResponse } from '../types/index';
import { WorkspaceViewService } from '../services/workspace-view.service';
import { AgentSkillService } from '../services/agent-skill.service';
import type { SkillService } from '../services/skill.service';
import { getCapsules as evolutionGetCapsules } from '../services/evolution-report';
import { loadGenes as evolutionLoadGenes } from '../services/evolution-lifecycle';

const STUDIO_CACHE_HEADER = 'private, max-age=30';

export function createStudioRouter(skillService?: SkillService) {
  const router = new Hono();
  const workspaceView = new WorkspaceViewService();
  const agentSkillService = skillService ? new AgentSkillService(skillService) : null;

  // eslint-disable-next-line custom/no-wildcard-sub-router-middleware -- mounted at /studio in routes.ts
  router.use('*', authMiddleware);

  // ─── helpers ────────────────────────────────────────────────────────

  /**
   * Resolve a default agent for the caller. Strategy: caller's own agent card
   * (imUserId is itself an agent) → first agent card in caller's default
   * workspace → null. Returns the IMUser id (agent imUserId), not the
   * IMAgentCard.id.
   */
  async function resolveDefaultAgentId(userImUserId: string): Promise<string | null> {
    // 1. Caller is themself an agent? (When a daemon API key is the actor.)
    const selfCard = await prisma.iMAgentCard.findUnique({
      where: { imUserId: userImUserId },
      select: { imUserId: true },
    });
    if (selfCard) return selfCard.imUserId;

    // 2. Find any agent card owned by the caller via workspace ownership.
    const workspace = await prisma.iMWorkspace.findFirst({
      where: { ownerImUserId: userImUserId, deletedAt: null },
      select: { id: true, orchestratorAgentId: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!workspace) return null;
    if (workspace.orchestratorAgentId) {
      const orch = await prisma.iMAgentCard.findFirst({
        where: { imUserId: workspace.orchestratorAgentId },
        select: { imUserId: true },
      });
      if (orch) return orch.imUserId;
    }
    const fallback = await prisma.iMAgentCard.findFirst({
      where: { workspaceId: workspace.id },
      select: { imUserId: true },
      orderBy: { createdAt: 'asc' },
    });
    return fallback?.imUserId ?? null;
  }

  /**
   * Resolve a workspace the caller can read. If `workspaceId` is given, verify
   * ownership / membership; otherwise pick their default workspace.
   */
  async function resolveWorkspaceId(userImUserId: string, requestedId?: string): Promise<string | null> {
    if (requestedId) {
      const ws = await prisma.iMWorkspace.findFirst({
        where: {
          id: requestedId,
          deletedAt: null,
          OR: [{ ownerImUserId: userImUserId }, { members: { some: { memberImUserId: userImUserId } } }],
        },
        select: { id: true },
      });
      return ws?.id ?? null;
    }
    const ws = await prisma.iMWorkspace.findFirst({
      where: { ownerImUserId: userImUserId, deletedAt: null },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    return ws?.id ?? null;
  }

  /**
   * Permission for inspecting an agent's profile / installed skills.
   * - Caller is the agent themself.
   * - Caller owns the workspace the agent lives in.
   * - Caller is a workspace member.
   */
  async function canInspectAgent(callerImUserId: string, agentImUserId: string): Promise<boolean> {
    if (callerImUserId === agentImUserId) return true;
    const card = await prisma.iMAgentCard.findUnique({
      where: { imUserId: agentImUserId },
      select: { workspaceId: true },
    });
    if (!card?.workspaceId) return false;
    const ws = await prisma.iMWorkspace.findFirst({
      where: {
        id: card.workspaceId,
        deletedAt: null,
        OR: [{ ownerImUserId: callerImUserId }, { members: { some: { memberImUserId: callerImUserId } } }],
      },
      select: { id: true },
    });
    return !!ws;
  }

  // ─── GET /studio/overview ──────────────────────────────────────────
  router.get('/overview', async (c) => {
    const user = c.get('user');
    const workspaceId = await resolveWorkspaceId(user.imUserId, c.req.query('workspaceId') || undefined);

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const skillWhere = workspaceId ? { workspaceId } : { workspaceId: null };

    const [drafts, inEval, pendingReview, publishedThisWeek, recentLifecycle] = await Promise.all([
      prisma.iMSkill.count({ where: { ...skillWhere, status: 'draft' } }),
      prisma.iMSkill.count({ where: { ...skillWhere, status: 'eval' } }),
      prisma.iMSkill.count({ where: { ...skillWhere, status: 'review' } }),
      prisma.iMSkill.count({
        where: { ...skillWhere, status: 'active', publishedAt: { gte: sevenDaysAgo } },
      }),
      prisma.iMSkill.findMany({
        where: skillWhere,
        select: { id: true, slug: true, name: true, status: true, updatedAt: true },
        orderBy: { updatedAt: 'desc' },
        take: 5,
      }),
    ]);

    // Authoring activity surface: not yet a separate event table — surface
    // the same skill-level mutations until release201/07 lands.
    const recentActivity = (recentLifecycle as any[]).slice(0, 3).map((s: any) => ({
      type: 'skill.updated',
      skillSlug: s.slug,
      timestamp: s.updatedAt.toISOString(),
      summary: `${s.name} → ${s.status}`,
    }));

    c.header('Cache-Control', STUDIO_CACHE_HEADER);
    return c.json<ApiResponse>({
      ok: true,
      data: {
        workspaceId,
        counts: { drafts, inEval, pendingReview, publishedThisWeek },
        recentLifecycle: (recentLifecycle as any[]).map((s: any) => ({
          skillId: s.id,
          slug: s.slug,
          name: s.name,
          status: s.status,
          updatedAt: s.updatedAt.toISOString(),
        })),
        recentActivity,
      },
    });
  });

  // ─── GET /studio/profile ───────────────────────────────────────────
  router.get('/profile', async (c) => {
    const user = c.get('user');
    const requestedAgentId = c.req.query('agentId') || undefined;
    const agentId = requestedAgentId ?? (await resolveDefaultAgentId(user.imUserId));

    if (!agentId) {
      return c.json<ApiResponse>({
        ok: true,
        data: {
          agentId: null,
          identity: null,
          personality: null,
          credits: null,
          workspaces: [],
        },
      });
    }

    if (!(await canInspectAgent(user.imUserId, agentId))) {
      return c.json<ApiResponse>({ ok: false, error: 'Not authorized for this agent' }, 403);
    }

    const view = await workspaceView.getView(agentId, 'global', ['identity', 'personality', 'credits']);

    const card = await prisma.iMAgentCard.findUnique({
      where: { imUserId: agentId },
      select: { workspaceId: true },
    });
    const workspaces = card?.workspaceId
      ? await prisma.iMWorkspace.findMany({
          where: { id: card.workspaceId, deletedAt: null },
          select: { id: true, name: true },
        })
      : [];

    c.header('Cache-Control', STUDIO_CACHE_HEADER);
    return c.json<ApiResponse>({
      ok: true,
      data: {
        agentId,
        identity: view.identity ?? null,
        personality: view.personality
          ? {
              rigor: view.personality.rigor,
              creativity: view.personality.creativity,
              risk_tolerance: view.personality.risk_tolerance,
              soul: view.personality.soul,
            }
          : null,
        credits: view.credits ?? null,
        workspaces: (workspaces as any[]).map((w: any) => ({ workspaceId: w.id, name: w.name })),
      },
    });
  });

  // ─── GET /studio/installed ─────────────────────────────────────────
  router.get('/installed', async (c) => {
    const user = c.get('user');
    const requestedWorkspaceId = c.req.query('workspaceId') || undefined;
    const requestedAgentId = c.req.query('agentId') || undefined;

    const workspaceId = await resolveWorkspaceId(user.imUserId, requestedWorkspaceId);

    // Agent list — all agents in the workspace (or just the caller's own agent
    // when no workspace is resolved).
    const agentCards = workspaceId
      ? await prisma.iMAgentCard.findMany({
          where: { workspaceId },
          select: {
            imUserId: true,
            name: true,
            agentType: true,
            status: true,
            capabilities: true,
            workspaceId: true,
            imUser: { select: { username: true, displayName: true } },
          },
          orderBy: { createdAt: 'asc' },
        })
      : await prisma.iMAgentCard.findMany({
          where: { imUserId: user.imUserId },
          select: {
            imUserId: true,
            name: true,
            agentType: true,
            status: true,
            capabilities: true,
            workspaceId: true,
            imUser: { select: { username: true, displayName: true } },
          },
        });

    const agents = (agentCards as any[]).map((card: any) => {
      let capabilities: string[] = [];
      try {
        capabilities = JSON.parse(card.capabilities || '[]');
      } catch {
        /* swallow */
      }
      return {
        agentId: card.imUserId,
        username: card.imUser?.username ?? card.imUserId,
        displayName: card.imUser?.displayName ?? card.name,
        agentType: card.agentType,
        status: card.status,
        workspaceId: card.workspaceId,
        capabilities,
      };
    });

    // Active agent — caller's choice if valid, otherwise first agent.
    let activeAgentId: string | null = null;
    if (requestedAgentId && agents.some((a: { agentId: string }) => a.agentId === requestedAgentId)) {
      activeAgentId = requestedAgentId;
    } else if (agents.length > 0) {
      activeAgentId = agents[0].agentId;
    }

    // Permission check on active agent before listing its skills.
    if (activeAgentId && !(await canInspectAgent(user.imUserId, activeAgentId))) {
      activeAgentId = null;
    }

    let skills: Array<{
      skillId: string;
      slug: string;
      name: string;
      version: string | null;
      status: string;
      installedAt: string;
      lastInvokedAt: string | null;
      fromGene: boolean;
    }> = [];

    if (activeAgentId && agentSkillService) {
      // Delegate to the same service the GET /:agentId/skills endpoint uses
      // (release201/13 §3.4 P0-3 — reuse, don't duplicate the SQL).
      const entries = await agentSkillService.listAgentSkills(
        activeAgentId,
        workspaceId ?? undefined,
        false, // includeInactive
      );
      skills = (entries as any[]).map((entry: any) => {
        const row = entry.agentSkill;
        const meta = entry.skill;
        return {
          skillId: row.skillId,
          slug: meta?.slug ?? row.skillId,
          name: meta?.name ?? row.skillId,
          version: row.version ?? null,
          status: row.status,
          installedAt: row.installedAt.toISOString(),
          lastInvokedAt: row.lastSyncedAt ? row.lastSyncedAt.toISOString() : null,
          fromGene: !!row.geneId,
        };
      });
    }

    c.header('Cache-Control', STUDIO_CACHE_HEADER);
    return c.json<ApiResponse>({
      ok: true,
      data: {
        workspaceId,
        agents,
        activeAgentId,
        skills,
      },
    });
  });

  // ─── GET /studio/evolution/capsules ────────────────────────────────
  //
  // release201/13 §3.6 + §11 13-P3 (reviewer P1-2 / 13-D14).
  //
  // Workspace-owner-scoped capsule listing for ANY agent the caller can
  // inspect. The existing `/api/im/evolution/capsules` path is auth-user-
  // scoped — i.e. it shows the caller's own capsules. Studio needs the
  // workspace owner / orchestrator to be able to drill into a contributor
  // agent's capsules. We don't reuse the old path (avoids polluting its
  // permission model); §0.2.4 forbids it explicitly.
  router.get('/evolution/capsules', async (c) => {
    const user = c.get('user');
    const agentId = c.req.query('agentId');
    if (!agentId) {
      return c.json<ApiResponse>({ ok: false, error: 'agentId is required' }, 400);
    }
    if (!(await canInspectAgent(user.imUserId, agentId))) {
      return c.json<ApiResponse>({ ok: false, error: 'Not authorized for this agent' }, 403);
    }
    const page = Math.max(1, parseInt(c.req.query('page') || '1', 10) || 1);
    const limit = Math.max(1, Math.min(parseInt(c.req.query('limit') || '20', 10) || 20, 50));
    const scope = c.req.query('scope') || 'global';

    const result = await evolutionGetCapsules(agentId, page, limit, scope);

    c.header('Cache-Control', STUDIO_CACHE_HEADER);
    return c.json<ApiResponse>({
      ok: true,
      data: {
        agentId,
        capsules: result.capsules,
        total: result.total,
        page,
        limit,
      },
    });
  });

  // ─── GET /studio/evolution/genes ───────────────────────────────────
  //
  // Same scoping rules as `/evolution/capsules`. Surfaces the gene catalog
  // the target agent has authored or imported. release201/13 §3.6 ties this
  // to the per-agent Evolution tab (capsule → gene → distilled skill path).
  router.get('/evolution/genes', async (c) => {
    const user = c.get('user');
    const agentId = c.req.query('agentId');
    if (!agentId) {
      return c.json<ApiResponse>({ ok: false, error: 'agentId is required' }, 400);
    }
    if (!(await canInspectAgent(user.imUserId, agentId))) {
      return c.json<ApiResponse>({ ok: false, error: 'Not authorized for this agent' }, 403);
    }
    const signalsParam = c.req.query('signals');
    let genes = await evolutionLoadGenes(agentId, 'global');
    if (signalsParam) {
      const filter = signalsParam
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      genes = genes.filter((g: any) => {
        const matches = Array.isArray(g.signals_match) ? g.signals_match : [];
        return matches.some((tag: any) => filter.includes(tag?.type ?? tag));
      });
    }

    // Distilled-skill linkage — surface which IMAgentSkill rows were sourced
    // from this agent's genes (geneId IS NOT NULL). Lets the UI annotate genes
    // with "exported as skill" badges without an extra round-trip.
    const distilled = await prisma.iMAgentSkill.findMany({
      where: { agentId, geneId: { not: null } },
      select: { geneId: true, skillId: true, status: true, installedAt: true },
    });

    c.header('Cache-Control', STUDIO_CACHE_HEADER);
    return c.json<ApiResponse>({
      ok: true,
      data: {
        agentId,
        genes,
        distilled: (distilled as any[]).map((row: any) => ({
          geneId: row.geneId,
          skillId: row.skillId,
          status: row.status,
          installedAt: row.installedAt.toISOString(),
        })),
      },
    });
  });

  return router;
}
