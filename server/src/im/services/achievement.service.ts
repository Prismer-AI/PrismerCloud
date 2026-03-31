/**
 * Prismer IM — Achievement Service
 *
 * Manages evolution achievement badges.
 * 6 badges that unlock based on agent activity.
 */

import prisma from '../db';

// ─── Badge Definitions ────────────────────────────────────────

export interface BadgeDef {
  key: string;
  name: string;
  description: string;
  icon: string;
}

export const BADGES: BadgeDef[] = [
  { key: 'first_gene', name: 'Gene Pioneer', description: 'Install your first Gene', icon: '🌱' },
  { key: 'first_execution', name: 'First Strike', description: 'Complete your first Gene execution', icon: '⚡' },
  { key: 'first_publish', name: 'Open Source', description: 'Publish a Gene to the public market', icon: '🧬' },
  { key: 'streak_10', name: 'Reliable', description: '10 consecutive successful executions', icon: '🔥' },
  { key: 'diversity_3', name: 'Generalist', description: 'Use genes from all 3 categories', icon: '🌈' },
  { key: 'gene_adopted', name: 'Influential', description: 'Your published gene was adopted by another agent', icon: '🏆' },
];

export interface UnlockContext {
  event: 'record' | 'publish' | 'import' | 'create';
  outcome?: string;
  geneCategory?: string;
  originalAuthorId?: string;
}

export interface Achievement {
  badgeKey: string;
  badge: BadgeDef;
  unlockedAt: string;
}

// ─── Service ──────────────────────────────────────────────────

export class AchievementService {

  /** Check all badge conditions and unlock any newly earned ones. */
  async checkAndUnlock(agentId: string, ctx: UnlockContext): Promise<string[]> {
    const existing = await prisma.iMEvolutionAchievement.findMany({
      where: { agentId },
      select: { badgeKey: true },
    });
    const has = new Set(existing.map((a: { badgeKey: string }) => a.badgeKey));
    const newlyUnlocked: string[] = [];

    const tryUnlock = async (key: string, metadata?: Record<string, unknown>) => {
      if (has.has(key)) return;
      try {
        await prisma.iMEvolutionAchievement.create({
          data: { agentId, badgeKey: key, metadata: JSON.stringify(metadata || {}) },
        });
        newlyUnlocked.push(key);
        has.add(key);
      } catch {
        // unique constraint — already unlocked (race)
      }
    };

    // first_gene: agent has at least 1 gene
    if (!has.has('first_gene')) {
      const card = await prisma.iMAgentCard.findUnique({ where: { imUserId: agentId } });
      if (card) {
        const genes = JSON.parse(JSON.parse(card.metadata || '{}').genes ? card.metadata : '{"genes":[]}').genes || [];
        if (genes.length > 0) await tryUnlock('first_gene');
      }
    }

    // first_execution: at least 1 capsule
    if (!has.has('first_execution') && ctx.event === 'record') {
      await tryUnlock('first_execution');
    }

    // first_publish: published at least 1 gene
    if (!has.has('first_publish') && ctx.event === 'publish') {
      await tryUnlock('first_publish');
    }

    // gene_adopted: original author gets this when their gene is imported
    if (!has.has('gene_adopted') && ctx.event === 'import' && ctx.originalAuthorId === agentId) {
      await tryUnlock('gene_adopted');
    }

    // streak_10: 10 consecutive successful capsules
    if (!has.has('streak_10') && ctx.event === 'record' && ctx.outcome === 'success') {
      const recent = await prisma.iMEvolutionCapsule.findMany({
        where: { ownerAgentId: agentId },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { outcome: true },
      });
      if (recent.length >= 10 && recent.every((c: { outcome: string }) => c.outcome === 'success')) {
        await tryUnlock('streak_10');
      }
    }

    // diversity_3: used genes from all 3 categories (repair, optimize, innovate)
    if (!has.has('diversity_3') && ctx.event === 'record') {
      const capsules = await prisma.iMEvolutionCapsule.findMany({
        where: { ownerAgentId: agentId },
        select: { geneId: true },
        distinct: ['geneId'],
      });
      // Load agent card to check gene categories
      const card = await prisma.iMAgentCard.findUnique({ where: { imUserId: agentId } });
      if (card) {
        const metadata = JSON.parse(card.metadata || '{}');
        const genes: Array<{ id: string; category: string }> = metadata.genes || [];
        const usedGeneIds = new Set(capsules.map((c: { geneId: string }) => c.geneId));
        const categories = new Set<string>();
        for (const g of genes) {
          if (usedGeneIds.has(g.id)) categories.add(g.category);
        }
        if (categories.has('repair') && categories.has('optimize') && categories.has('innovate')) {
          await tryUnlock('diversity_3');
        }
      }
    }

    return newlyUnlocked;
  }

  /** Get all achievements for an agent. */
  async getAchievements(agentId: string): Promise<Achievement[]> {
    const rows = await prisma.iMEvolutionAchievement.findMany({
      where: { agentId },
      orderBy: { unlockedAt: 'asc' },
    });
    return rows.map((r: { badgeKey: string; unlockedAt: Date }) => ({
      badgeKey: r.badgeKey,
      badge: BADGES.find(b => b.key === r.badgeKey) || { key: r.badgeKey, name: r.badgeKey, description: '', icon: '🏅' },
      unlockedAt: r.unlockedAt.toISOString(),
    }));
  }

  /** Get leaderboard: agents sorted by achievement count + capsule count. */
  async getLeaderboard(limit: number = 20): Promise<Array<{
    agentId: string;
    agentName: string;
    badges: string[];
    badgeCount: number;
    capsuleCount: number;
    score: number;
  }>> {
    // Get all achievements grouped by agent
    const allAchievements = await prisma.iMEvolutionAchievement.findMany({
      select: { agentId: true, badgeKey: true },
    });
    const agentBadges = new Map<string, string[]>();
    for (const a of allAchievements) {
      const list = agentBadges.get(a.agentId) || [];
      list.push(a.badgeKey);
      agentBadges.set(a.agentId, list);
    }

    // Get capsule counts per agent
    const capsuleCounts = await prisma.iMEvolutionCapsule.groupBy({
      by: ['ownerAgentId'],
      _count: { id: true },
    });
    const capMap = new Map<string, number>(
      capsuleCounts.map((c: { ownerAgentId: string; _count: { id: number } }) =>
        [c.ownerAgentId, c._count.id] as [string, number])
    );

    // Get agent names
    const agentIds = [...new Set([...agentBadges.keys(), ...capMap.keys()])];
    const cards = await prisma.iMAgentCard.findMany({
      where: { imUserId: { in: agentIds } },
      select: { imUserId: true, name: true },
    });
    const nameMap = new Map<string, string>(
      cards.map((c: { imUserId: string; name: string }) => [c.imUserId, c.name] as [string, string])
    );

    // Compute scores: badges * 10 + capsules * 1
    const entries = agentIds.map((id: string) => {
      const badges = agentBadges.get(id) || [];
      const capsuleCount = capMap.get(id) || 0;
      return {
        agentId: id,
        agentName: nameMap.get(id) || id.slice(-8),
        badges,
        badgeCount: badges.length,
        capsuleCount,
        score: badges.length * 10 + capsuleCount,
      };
    });

    entries.sort((a, b) => b.score - a.score);
    return entries.slice(0, limit);
  }
}
