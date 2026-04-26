/**
 * Prismer IM — Workspace View Service
 *
 * 8-slot aggregation API for the Workspace tab.
 * Each slot is independently queryable; all slots run in parallel via Promise.all.
 */

import prisma from '../db';
import { getPersonAgentIds } from '../utils/person-agent-ids';
import { createCreditService, type CreditService } from './credit.service';
import type {
  WorkspaceView,
  WorkspaceSlot,
  WorkspaceGene,
  WorkspaceMemoryFile,
  WorkspacePersonality,
  WorkspaceIdentity,
  WorkspaceCatalogEntry,
  WorkspaceTask,
  WorkspaceCredits,
  WorkspaceExtension,
} from '../types/workspace';
import type { PrismerGene } from '../types/index';

const LOG = '[WorkspaceView]';

/** Scope filter: global scope → exact match; workspace scope → include global fallback */
function scopeFilter(scope: string) {
  return scope === 'global' ? 'global' : { in: [scope, 'global'] };
}

export class WorkspaceViewService {
  private creditService: CreditService = createCreditService(prisma);
  /**
   * Get the workspace superset view for an agent within a scope.
   * Only requested slots are fetched; unselected slots are undefined.
   */
  async getView(
    agentId: string,
    scope: string,
    slots: WorkspaceSlot[],
    includeContent = false,
  ): Promise<WorkspaceView> {
    const personAgentIds = await getPersonAgentIds(agentId);

    const view: WorkspaceView = { scope, agentId, personAgentIds };

    const slotSet = new Set(slots);
    const tasks: Promise<void>[] = [];

    if (slotSet.has('genes'))
      tasks.push(
        this.loadGenes(personAgentIds, scope).then((v) => {
          view.genes = v;
        }),
      );
    if (slotSet.has('memory'))
      tasks.push(
        this.loadMemory(personAgentIds, scope, includeContent).then((v) => {
          view.memory = v;
        }),
      );
    if (slotSet.has('personality'))
      tasks.push(
        this.loadPersonality(agentId, personAgentIds, scope).then((v) => {
          view.personality = v;
        }),
      );
    if (slotSet.has('identity'))
      tasks.push(
        this.loadIdentity(agentId).then((v) => {
          view.identity = v;
        }),
      );
    if (slotSet.has('catalog'))
      tasks.push(
        this.loadCatalog(personAgentIds, scope).then((v) => {
          view.catalog = v;
        }),
      );
    if (slotSet.has('tasks'))
      tasks.push(
        this.loadTasks(personAgentIds, scope).then((v) => {
          view.tasks = v;
        }),
      );
    if (slotSet.has('credits'))
      tasks.push(
        this.loadCredits(agentId).then((v) => {
          view.credits = v;
        }),
      );
    if (slotSet.has('extensions'))
      tasks.push(
        this.loadExtensions(personAgentIds, scope, includeContent).then((v) => {
          view.extensions = v;
        }),
      );

    const results = await Promise.allSettled(tasks);
    for (const r of results) {
      if (r.status === 'rejected') {
        console.warn(`${LOG} Slot load failed:`, r.reason?.message || r.reason);
      }
    }
    return view;
  }

  // ── Slot: genes ────────────────────────────────────────────────────

  private async loadGenes(personIds: string[], scope: string): Promise<WorkspaceGene[]> {
    // 1. Fetch genes (limit 100)
    const genes = await prisma.iMGene.findMany({
      where: {
        ownerAgentId: { in: personIds },
        scope: { in: [scope, 'global'] },
        visibility: { not: 'quarantined' },
      },
      take: 100,
      orderBy: { updatedAt: 'desc' },
    });

    if (genes.length === 0) return [];

    const geneIds = genes.map((g: any) => g.id as string);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // 2-6. Parallel sub-queries (all scoped to prevent cross-scope data leakage)
    const scopeWhere = scopeFilter(scope);
    const [edgeCounts, linkCounts, skillOrigins, capsules] = await Promise.all([
      // edgeCount per gene (scoped)
      prisma.iMEvolutionEdge.groupBy({
        by: ['geneId'],
        where: { geneId: { in: geneIds }, scope: scopeWhere },
        _count: { id: true },
      }),
      // linkCount per gene (as source, scoped)
      prisma.iMKnowledgeLink.groupBy({
        by: ['sourceId'],
        where: { sourceType: 'gene', sourceId: { in: geneIds }, scope: scopeWhere },
        _count: { id: true },
      }),
      // skill origin lookup (scoped)
      prisma.iMAgentSkill.findMany({
        where: {
          geneId: { in: geneIds },
          agentId: { in: personIds },
          scope: scopeWhere,
          status: 'active',
        },
        select: { geneId: true, skillId: true },
      }),
      // capsules from last 7 days for trend (scoped)
      prisma.iMEvolutionCapsule.findMany({
        where: {
          geneId: { in: geneIds },
          scope: scopeWhere,
          createdAt: { gte: sevenDaysAgo },
        },
        select: { geneId: true, score: true, outcome: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    // Build lookup maps
    const edgeMap = new Map(edgeCounts.map((e: any) => [e.geneId, e._count.id]));
    const linkMap = new Map(linkCounts.map((l: any) => [l.sourceId, l._count.id]));

    // Skill origin: geneId → skillId
    const skillOriginMap = new Map<string, string>();
    const skillIds = new Set<string>();
    for (const s of skillOrigins) {
      if (s.geneId) {
        skillOriginMap.set(s.geneId, s.skillId);
        skillIds.add(s.skillId);
      }
    }

    // Fetch skill slugs for origin labels
    const skills =
      skillIds.size > 0
        ? await prisma.iMSkill.findMany({
            where: { id: { in: [...skillIds] } },
            select: { id: true, slug: true },
          })
        : [];
    const skillSlugMap = new Map(skills.map((s: any) => [s.id, s.slug]));

    // Capsule analysis per gene: trend + trendData
    const capsulesByGene = new Map<string, typeof capsules>();
    for (const cap of capsules) {
      const list = capsulesByGene.get(cap.geneId) || [];
      list.push(cap);
      capsulesByGene.set(cap.geneId, list);
    }

    return genes.map((gene: any) => {
      const geneCapsules = capsulesByGene.get(gene.id) || [];
      const { recentTrend, trendData } = this.computeTrend(geneCapsules);

      const skillId = skillOriginMap.get(gene.id);
      const skillSlug = skillId ? skillSlugMap.get(skillId) : undefined;

      let origin: WorkspaceGene['origin'] = 'evolved';
      if (skillId) origin = 'from_skill';
      else if (gene.parentId) origin = 'forked';

      const executions = gene.successCount + gene.failureCount;
      const successRate = executions > 0 ? gene.successCount / executions : 0;

      return {
        gene: this.toGeneView(gene),
        origin,
        skillSlug,
        successRate,
        executions,
        breakerState: gene.breakerState as WorkspaceGene['breakerState'],
        edgeCount: edgeMap.get(gene.id) || 0,
        linkCount: linkMap.get(gene.id) || 0,
        recentTrend,
        trendData,
        lastUsedAt: gene.lastUsedAt?.toISOString() || null,
      };
    });
  }

  private computeTrend(capsules: { score: number | null; createdAt: Date }[]): {
    recentTrend: 'up' | 'down' | 'stable';
    trendData: { date: string; score: number }[];
  } {
    // Group by date, compute daily avg score
    const dailyMap = new Map<string, { sum: number; count: number }>();
    for (const cap of capsules) {
      if (cap.score == null) continue;
      const date = cap.createdAt.toISOString().slice(0, 10);
      const entry = dailyMap.get(date) || { sum: 0, count: 0 };
      entry.sum += cap.score;
      entry.count++;
      dailyMap.set(date, entry);
    }

    const trendData = [...dailyMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, { sum, count }]) => ({ date, score: +(sum / count).toFixed(3) }));

    if (trendData.length < 2) return { recentTrend: 'stable', trendData };

    // Compare first-half avg vs second-half avg
    const mid = Math.floor(trendData.length / 2);
    const firstHalf = trendData.slice(0, mid).reduce((s, d) => s + d.score, 0) / mid;
    const secondHalf = trendData.slice(mid).reduce((s, d) => s + d.score, 0) / (trendData.length - mid);
    const diff = secondHalf - firstHalf;

    const recentTrend = diff > 0.05 ? 'up' : diff < -0.05 ? 'down' : 'stable';
    return { recentTrend, trendData };
  }

  private toGeneView(gene: any): PrismerGene {
    const constraints = JSON.parse(gene.constraints || '{}');
    return {
      type: 'Gene',
      id: gene.id,
      category: gene.category,
      title: gene.title,
      description: gene.description,
      visibility: gene.visibility,
      signals_match: [],
      preconditions: JSON.parse(gene.preconditions || '[]'),
      strategy: JSON.parse(gene.strategySteps || '[]'),
      constraints: {
        max_credits: constraints.max_credits ?? 0,
        max_retries: constraints.max_retries ?? 0,
        required_capabilities: constraints.required_capabilities ?? [],
      },
      success_count: gene.successCount,
      failure_count: gene.failureCount,
      last_used_at: gene.lastUsedAt?.toISOString() || null,
      created_by: gene.ownerAgentId,
      parentGeneId: gene.parentId,
      forkCount: gene.forkCount,
      generation: gene.generation,
      qualityScore: gene.qualityScore,
    };
  }

  // ── Slot: memory ──────────────────────────────────────────────────

  private async loadMemory(
    personIds: string[],
    scope: string,
    includeContent: boolean,
  ): Promise<WorkspaceMemoryFile[]> {
    const files = await prisma.iMMemoryFile.findMany({
      where: {
        ownerId: { in: personIds },
        scope: scopeFilter(scope),
        OR: [
          { memoryType: { not: null, notIn: ['soul'] }, NOT: { memoryType: { startsWith: 'ext_' } } },
          { memoryType: null },
        ],
      },
      select: {
        path: true,
        content: includeContent,
        memoryType: true,
        description: true,
        stale: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
    });

    return files.map((f: any) => ({
      path: f.path,
      ...(includeContent ? { content: f.content } : {}),
      memoryType: f.memoryType,
      description: f.description,
      stale: f.stale,
      updatedAt: f.updatedAt.toISOString(),
    }));
  }

  // ── Slot: personality ─────────────────────────────────────────────

  private async loadPersonality(agentId: string, personIds: string[], scope: string): Promise<WorkspacePersonality> {
    const [card, soulFile] = await Promise.all([
      prisma.iMAgentCard.findUnique({ where: { imUserId: agentId }, select: { metadata: true } }),
      prisma.iMMemoryFile.findFirst({
        where: { ownerId: { in: personIds }, scope: scopeFilter(scope), memoryType: 'soul' },
        select: { content: true },
      }),
    ]);

    let personality: Partial<WorkspacePersonality> = {};
    if (card?.metadata) {
      try {
        const meta = JSON.parse(card.metadata);
        if (meta.personality) personality = meta.personality;
      } catch {
        /* invalid JSON */
      }
    }

    return {
      rigor: personality.rigor ?? 0.5,
      creativity: personality.creativity ?? 0.5,
      risk_tolerance: personality.risk_tolerance ?? 0.5,
      soul: soulFile?.content || null,
      statsHistory: personality.statsHistory ?? {},
    };
  }

  // ── Slot: identity ────────────────────────────────────────────────

  private async loadIdentity(agentId: string): Promise<WorkspaceIdentity> {
    const [card, user] = await Promise.all([
      prisma.iMAgentCard.findUnique({
        where: { imUserId: agentId },
        select: { name: true, description: true, agentType: true, capabilities: true, status: true, did: true },
      }),
      prisma.iMUser.findUnique({
        where: { id: agentId },
        select: { displayName: true },
      }),
    ]);

    let capabilities: string[] = [];
    if (card?.capabilities) {
      try {
        capabilities = JSON.parse(card.capabilities);
      } catch {
        /* */
      }
    }

    return {
      agentName: card?.name || agentId,
      displayName: user?.displayName || card?.name || agentId,
      agentType: card?.agentType || 'assistant',
      did: card?.did || null,
      capabilities,
      status: card?.status || 'offline',
    };
  }

  // ── Slot: catalog ─────────────────────────────────────────────────

  private async loadCatalog(personIds: string[], scope: string): Promise<WorkspaceCatalogEntry[]> {
    const records = await prisma.iMAgentSkill.findMany({
      where: {
        agentId: { in: personIds },
        scope: scopeFilter(scope),
        status: 'active',
      },
      orderBy: { installedAt: 'desc' },
    });

    if (records.length === 0) return [];

    const skillIds = records.map((r: any) => r.skillId);
    const skills = await prisma.iMSkill.findMany({
      where: { id: { in: skillIds } },
      select: { id: true, slug: true, name: true },
    });
    const skillMap = new Map<string, any>(skills.map((s: any) => [s.id, s]));

    return records.map((r: any) => {
      const skill = skillMap.get(r.skillId) as any;
      return {
        skillId: r.skillId,
        skillSlug: skill?.slug || r.skillId,
        skillName: skill?.name || r.skillId,
        linkedGeneId: r.geneId || null,
        installedAt: r.installedAt.toISOString(),
        status: r.status,
        version: r.version,
      };
    });
  }

  // ── Slot: tasks ───────────────────────────────────────────────────

  private async loadTasks(personIds: string[], scope: string): Promise<WorkspaceTask[]> {
    const tasks = await prisma.iMTask.findMany({
      where: {
        creatorId: { in: personIds },
        scope: scopeFilter(scope),
        status: { notIn: ['cancelled'] },
      },
      select: { id: true, title: true, status: true, assigneeId: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return tasks.map((t: any) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      assigneeId: t.assigneeId,
      createdAt: t.createdAt.toISOString(),
    }));
  }

  // ── Slot: credits ─────────────────────────────────────────────────

  private async loadCredits(agentId: string): Promise<WorkspaceCredits> {
    try {
      const balance = await this.creditService.getBalance(agentId);
      return {
        balance: balance.balance,
        totalSpent: balance.totalSpent,
        totalEarned: balance.totalEarned,
      };
    } catch {
      return { balance: 0, totalSpent: 0, totalEarned: 0 };
    }
  }

  // ── Slot: extensions ──────────────────────────────────────────────

  private async loadExtensions(
    personIds: string[],
    scope: string,
    includeContent: boolean,
  ): Promise<WorkspaceExtension[]> {
    const files = await prisma.iMMemoryFile.findMany({
      where: {
        ownerId: { in: personIds },
        scope: scopeFilter(scope),
        memoryType: { startsWith: 'ext_' },
      },
      select: {
        path: true,
        content: includeContent,
        memoryType: true,
        description: true,
      },
      orderBy: { updatedAt: 'desc' },
    });

    return files.map((f: any) => ({
      type: f.memoryType || 'ext_unknown',
      path: f.path,
      content: includeContent ? (f.content ?? '') : '',
      metadata: f.description ? { description: f.description } : {},
    }));
  }
}
