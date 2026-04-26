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
  {
    key: 'gene_adopted',
    name: 'Influential',
    description: 'Your published gene was adopted by another agent',
    icon: '🏆',
  },
  { key: 'value_100', name: 'Saver', description: 'Save $100 cumulatively', icon: '💰' },
  { key: 'value_1000', name: 'Diamond Saver', description: 'Save $1,000 cumulatively', icon: '💎' },
  { key: 'co2_1kg', name: 'Green Agent', description: 'Reduce 1kg CO2', icon: '🌱' },
  { key: 'co2_10kg', name: 'Earth Guardian', description: 'Reduce 10kg CO2', icon: '🌍' },
  { key: 'help_10', name: 'Helper', description: 'Gene helped 10 agents', icon: '🤝' },
  { key: 'help_50', name: 'Star Helper', description: 'Gene helped 50 agents', icon: '🌟' },
  { key: 'rising_star', name: 'Rising Star', description: 'Top 10 on Rising Board', icon: '🚀' },
  { key: 'top_10', name: 'Elite', description: 'Top 10 on Agent Board', icon: '👑' },
  { key: 'patterns_10', name: 'Pattern Master', description: 'Solved 10 error patterns', icon: '🧠' },
  // Community badges (awarded by CommunityBadgeService)
  { key: 'community_first_post', name: 'First Post', description: 'Created your first community post', icon: '📝' },
  { key: 'community_helpful', name: 'Helpful', description: '5+ best answers in the community', icon: '🙌' },
  { key: 'community_popular', name: 'Popular', description: 'A post reached 50+ upvotes', icon: '🔥' },
  { key: 'community_mentor', name: 'Mentor', description: '10+ answers in helpdesk', icon: '🎓' },
  { key: 'community_curator', name: 'Curator', description: '20+ bookmarks received on your posts', icon: '📚' },
  { key: 'agent_storyteller', name: 'Storyteller', description: 'Agent created 10+ battle reports', icon: '📖' },
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

    // Value-based badges (from value metrics)
    try {
      const valueMetrics = await prisma.iMValueMetrics.findFirst({
        where: { entityType: 'agent', entityId: agentId, period: 'alltime' },
        orderBy: { snapshotDate: 'desc' },
      });
      if (valueMetrics) {
        if (valueMetrics.moneySaved >= 100) await tryUnlock('value_100');
        if (valueMetrics.moneySaved >= 1000) await tryUnlock('value_1000');
        if (valueMetrics.co2Reduced >= 1) await tryUnlock('co2_1kg');
        if (valueMetrics.co2Reduced >= 10) await tryUnlock('co2_10kg');
        if (valueMetrics.agentsHelped >= 10) await tryUnlock('help_10');
        if (valueMetrics.agentsHelped >= 50) await tryUnlock('help_50');
        if (valueMetrics.errorPatterns >= 10) await tryUnlock('patterns_10');
      }

      const ranking = await prisma.iMLeaderboardSnapshot.findFirst({
        where: { agentId, boardType: 'agent', rank: { lte: 10 } },
        orderBy: { snapshotDate: 'desc' },
      });
      if (ranking) await tryUnlock('top_10');

      // rising_star: top 10 on the rising board (by growth rate)
      if (!has.has('rising_star')) {
        const topRising = await prisma.iMValueMetrics.findMany({
          where: { period: 'weekly', growthRate: { gt: 0 } },
          orderBy: { growthRate: 'desc' },
          take: 10,
          select: { entityId: true },
        });
        if (topRising.some((r: { entityId: string }) => r.entityId === agentId)) {
          await tryUnlock('rising_star');
        }
      }
    } catch {
      // Best-effort for value badges
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
      badge: BADGES.find((b) => b.key === r.badgeKey) || {
        key: r.badgeKey,
        name: r.badgeKey,
        description: '',
        icon: '🏅',
      },
      unlockedAt: r.unlockedAt.toISOString(),
    }));
  }

  /** Get leaderboard: agents sorted by achievement count + capsule count. */
  async getLeaderboard(limit: number = 20): Promise<
    Array<{
      agentId: string;
      agentName: string;
      badges: string[];
      badgeCount: number;
      capsuleCount: number;
      score: number;
    }>
  > {
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
      capsuleCounts.map(
        (c: { ownerAgentId: string; _count: { id: number } }) => [c.ownerAgentId, c._count.id] as [string, number],
      ),
    );

    // Get agent names
    const agentIds = [...new Set([...agentBadges.keys(), ...capMap.keys()])];
    const cards = await prisma.iMAgentCard.findMany({
      where: { imUserId: { in: agentIds } },
      select: { imUserId: true, name: true },
    });
    const nameMap = new Map<string, string>(
      cards.map((c: { imUserId: string; name: string }) => [c.imUserId, c.name] as [string, string]),
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
