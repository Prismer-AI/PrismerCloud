/**
 * Evolution Sub-module: Public APIs
 *
 * All getPublic*() methods, getStories(), getMapData(),
 * getAllPublicGenes(), aggregatePublicGeneStats(), enrichGenesWithStats().
 */

import prisma from '../db';
import type { PrismerGene, SignalTag } from '../types/index';
import { normalizeSignals } from './evolution-signals';
import { dbGeneToModel, loadSeedGenes } from './evolution-lifecycle';

// ===== Internal Helpers =====

/** In-memory cache for public genes + stats (30s TTL) */
let _publicGenesCache: {
  genes: PrismerGene[];
  stats: Map<string, { success_count: number; failure_count: number }>;
  ts: number;
} | null = null;
const CACHE_TTL = 30_000;

/** Invalidate cache — call after publish/unpublish/import/delete */
export function invalidatePublicGenesCache(): void {
  _publicGenesCache = null;
}

/** Get all public/seed genes — cached 30s to avoid full-table scan per request */
export async function getAllPublicGenes(): Promise<PrismerGene[]> {
  if (_publicGenesCache && Date.now() - _publicGenesCache.ts < CACHE_TTL) {
    return _publicGenesCache.genes;
  }
  const rows = await prisma.iMGene.findMany({
    where: {
      visibility: { in: ['seed', 'published', 'canary'] },
      scope: 'global',
      qualityScore: { gte: 0.005 },
    },
    include: { signalLinks: true },
  });
  const genes = rows.map((r: any) => dbGeneToModel(r));
  // Pre-fetch stats together (avoids second full-scan on every browse call)
  const stats = await _aggregateStats();
  _publicGenesCache = { genes, stats, ts: Date.now() };
  return genes;
}

/** Get cached stats (piggybacked on gene cache) */
async function getCachedStats(): Promise<Map<string, { success_count: number; failure_count: number }>> {
  if (_publicGenesCache && Date.now() - _publicGenesCache.ts < CACHE_TTL) {
    return _publicGenesCache.stats;
  }
  await getAllPublicGenes(); // triggers cache refresh
  return _publicGenesCache!.stats;
}

/** Internal stats aggregation */
async function _aggregateStats(): Promise<Map<string, { success_count: number; failure_count: number }>> {
  const capsules = await prisma.iMEvolutionCapsule.findMany({
    where: { scope: 'global' },
    select: { geneId: true, outcome: true },
  });
  const stats = new Map<string, { success_count: number; failure_count: number }>();
  for (const c of capsules) {
    const baseId = c.geneId.replace(/_imp_[a-z0-9]+$/, '').replace(/_[a-z0-9]{6}$/, '');
    for (const key of [baseId, c.geneId]) {
      const entry = stats.get(key) ?? { success_count: 0, failure_count: 0 };
      if (c.outcome === 'success') entry.success_count++;
      else if (c.outcome === 'failed') entry.failure_count++;
      stats.set(key, entry);
    }
  }
  return stats;
}

/**
 * Aggregate real usage stats — uses 30s cache to avoid full-table scan per request.
 */
export async function aggregatePublicGeneStats(): Promise<
  Map<string, { success_count: number; failure_count: number }>
> {
  return getCachedStats();
}

/**
 * Enrich genes with real aggregate stats from capsules table.
 * Replaces the always-zero success_count/failure_count on seed/published genes.
 */
export function enrichGenesWithStats(
  genes: PrismerGene[],
  stats: Map<string, { success_count: number; failure_count: number }>,
): PrismerGene[] {
  return genes.map((g) => {
    const s = stats.get(g.id);
    if (s && (s.success_count > 0 || s.failure_count > 0)) {
      return { ...g, success_count: s.success_count, failure_count: s.failure_count };
    }
    return g;
  });
}

// ===== Public APIs =====

/** GET /public/stats — Global evolution statistics */
export async function getPublicStats(): Promise<{
  total_genes: number;
  total_capsules: number;
  avg_success_rate: number;
  active_agents: number;
}> {
  const allGenes = await getAllPublicGenes();

  // Query actual capsule counts from im_evolution_capsules table
  const [totalCapsules, totalSuccess, agentCount] = await Promise.all([
    prisma.iMEvolutionCapsule.count({ where: { scope: 'global' } }),
    prisma.iMEvolutionCapsule.count({ where: { outcome: 'success', scope: 'global' } }),
    prisma.iMAgentCard.count(),
  ]);

  return {
    total_genes: allGenes.length,
    total_capsules: totalCapsules,
    avg_success_rate: totalCapsules > 0 ? Math.round((totalSuccess / totalCapsules) * 1000) / 10 : 0,
    active_agents: agentCount,
  };
}

/**
 * GET /public/metrics — Advanced observability metrics.
 * Combines basic stats with 6 derived metrics from the design doc.
 */
export async function getAdvancedMetrics(): Promise<{
  // Basic (from getPublicStats)
  total_genes: number;
  total_capsules: number;
  avg_success_rate: number;
  active_agents: number;
  // Advanced
  evolution_velocity_24h: number; // capsules in last 24h
  evolution_velocity_7d: number; // avg capsules/day over 7d
  gene_diversity_index: number; // 1 - Σ(share_i²) (Herfindahl inverse)
  exploration_rate: number; // % of edges with < 10 observations
  information_gain: number; // KL divergence approximation (this week vs last week)
  surprise_score: number; // low-confidence success rate vs overall
}> {
  const now = new Date();
  const h24Ago = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const d7Ago = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const d14Ago = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

  const [basicStats, capsules24h, capsules7d, allCapsules7d, allCapsulesPrev7d, allEdges] = await Promise.all([
    getPublicStats(),
    prisma.iMEvolutionCapsule.count({ where: { createdAt: { gte: h24Ago }, scope: 'global' } }),
    prisma.iMEvolutionCapsule.count({ where: { createdAt: { gte: d7Ago }, scope: 'global' } }),
    prisma.iMEvolutionCapsule.findMany({
      where: { createdAt: { gte: d7Ago }, scope: 'global' },
      select: { geneId: true, outcome: true },
    }),
    prisma.iMEvolutionCapsule.findMany({
      where: { createdAt: { gte: d14Ago, lt: d7Ago }, scope: 'global' },
      select: { geneId: true, outcome: true },
    }),
    prisma.iMEvolutionEdge.findMany({
      where: { scope: 'global' },
      select: { successCount: true, failureCount: true },
    }),
  ]);

  // Gene Diversity Index: 1 - Σ(share_i²)
  const geneUsage = new Map<string, number>();
  let totalUsage = 0;
  for (const c of allCapsules7d) {
    geneUsage.set(c.geneId, (geneUsage.get(c.geneId) || 0) + 1);
    totalUsage++;
  }
  let herfindahl = 0;
  if (totalUsage > 0) {
    for (const count of geneUsage.values()) {
      const share = count / totalUsage;
      herfindahl += share * share;
    }
  }
  const geneDiversityIndex = totalUsage > 0 ? Math.round((1 - herfindahl) * 1000) / 1000 : 0;

  // Exploration Rate: edges with < 10 observations / total edges
  const totalEdges = allEdges.length;
  const exploringEdges = allEdges.filter((e: any) => e.successCount + e.failureCount < 10).length;
  const explorationRate = totalEdges > 0 ? Math.round((exploringEdges / totalEdges) * 1000) / 10 : 0;

  // Information Gain: KL(this_week || last_week) approximation
  // Compare gene usage distributions between the two weeks
  const prevGeneUsage = new Map<string, number>();
  let prevTotal = 0;
  for (const c of allCapsulesPrev7d) {
    prevGeneUsage.set(c.geneId, (prevGeneUsage.get(c.geneId) || 0) + 1);
    prevTotal++;
  }
  let infoGain = 0;
  if (totalUsage > 0 && prevTotal > 0) {
    const allGeneIds = new Set([...geneUsage.keys(), ...prevGeneUsage.keys()]);
    for (const gid of allGeneIds) {
      const p = (geneUsage.get(gid) || 0.5) / totalUsage; // this week (smoothed)
      const q = (prevGeneUsage.get(gid) || 0.5) / prevTotal; // last week (smoothed)
      if (p > 0 && q > 0) infoGain += p * Math.log(p / q);
    }
  }
  infoGain = Math.round(Math.max(0, infoGain) * 1000) / 1000;

  // Surprise Score: success rate of low-confidence edges vs overall
  const lowConfEdges = allEdges.filter((e: any) => {
    const total = e.successCount + e.failureCount;
    return total > 0 && total < 5;
  });
  const lowConfSuccess = lowConfEdges.reduce((s: number, e: any) => s + e.successCount, 0);
  const lowConfTotal = lowConfEdges.reduce((s: number, e: any) => s + e.successCount + e.failureCount, 0);
  const overallSuccess = allEdges.reduce((s: number, e: any) => s + e.successCount, 0);
  const overallTotal = allEdges.reduce((s: number, e: any) => s + e.successCount + e.failureCount, 0);
  const lowConfRate = lowConfTotal > 0 ? lowConfSuccess / lowConfTotal : 0;
  const overallRate = overallTotal > 0 ? overallSuccess / overallTotal : 0;
  const surpriseScore = overallRate > 0 ? Math.round((lowConfRate / overallRate) * 100) / 100 : 0;

  return {
    ...basicStats,
    evolution_velocity_24h: capsules24h,
    evolution_velocity_7d: Math.round((capsules7d / 7) * 10) / 10,
    gene_diversity_index: geneDiversityIndex,
    exploration_rate: explorationRate,
    information_gain: infoGain,
    surprise_score: surpriseScore,
  };
}

/** GET /public/hot — Hot genes by real usage from capsules table */
export async function getPublicHotGenes(limit: number): Promise<PrismerGene[]> {
  const [allGenes, stats] = await Promise.all([getAllPublicGenes(), aggregatePublicGeneStats()]);
  const enriched = enrichGenesWithStats(allGenes, stats);
  return enriched
    .sort((a, b) => b.success_count + b.failure_count - (a.success_count + a.failure_count))
    .slice(0, limit);
}

/** GET /public/genes — Browse public genes with filter/sort/pagination */
export async function getPublicGenes(opts: {
  category?: string;
  search?: string;
  sort: 'newest' | 'most_used' | 'highest_success' | 'recommended';
  page: number;
  limit: number;
}): Promise<{ genes: PrismerGene[]; total: number }> {
  const [rawGenes, stats] = await Promise.all([getAllPublicGenes(), aggregatePublicGeneStats()]);
  let genes = enrichGenesWithStats(rawGenes, stats);

  // Filter by category (including diagnostic)
  if (opts.category && ['repair', 'optimize', 'innovate', 'diagnostic'].includes(opts.category)) {
    genes = genes.filter((g) => g.category === opts.category);
  }

  // Filter by search — word-split matching + relevance scoring
  let searchWords: string[] = [];
  if (opts.search) {
    searchWords = opts.search.toLowerCase().split(/\s+/).filter(Boolean);
    genes = genes.filter((g) =>
      searchWords.every(
        (w) =>
          g.title?.toLowerCase().includes(w) ||
          (g.description?.toLowerCase() ?? '').includes(w) ||
          g.signals_match.some((s) => s.type.toLowerCase().includes(w)) ||
          g.strategy.some((s) => s.toLowerCase().includes(w)),
      ),
    );
  }

  // Sort — when searching, use relevance-weighted sort within the chosen order
  if (searchWords.length > 0) {
    // Compute relevance score per gene
    const scoreGene = (g: PrismerGene): number => {
      let score = 0;
      for (const w of searchWords) {
        if (g.title?.toLowerCase().includes(w)) score += 10;
        if (g.title?.toLowerCase() === w) score += 20;
        if (g.signals_match.some((s) => s.type.toLowerCase().includes(w))) score += 8;
        if (g.strategy.some((s) => s.toLowerCase().includes(w))) score += 3;
        if ((g.description?.toLowerCase() ?? '').includes(w)) score += 2;
      }
      // Popularity tiebreaker
      score += Math.log10(Math.max(g.success_count + g.failure_count, 1)) * 0.5;
      return score;
    };

    // Sort by relevance first, then by selected sort as tiebreaker
    const relevanceMap = new Map(genes.map((g) => [g.id, scoreGene(g)]));
    switch (opts.sort) {
      case 'most_used':
        genes.sort((a, b) => {
          const rDiff = (relevanceMap.get(b.id) || 0) - (relevanceMap.get(a.id) || 0);
          if (Math.abs(rDiff) > 2) return rDiff; // relevance dominates when significant
          return b.success_count + b.failure_count - (a.success_count + a.failure_count);
        });
        break;
      case 'highest_success':
        genes.sort((a, b) => {
          const rDiff = (relevanceMap.get(b.id) || 0) - (relevanceMap.get(a.id) || 0);
          if (Math.abs(rDiff) > 2) return rDiff;
          const aRate =
            a.success_count + a.failure_count > 0 ? a.success_count / (a.success_count + a.failure_count) : 0;
          const bRate =
            b.success_count + b.failure_count > 0 ? b.success_count / (b.success_count + b.failure_count) : 0;
          return bRate - aRate;
        });
        break;
      case 'recommended': {
        const maxUsage = Math.max(...genes.map((g) => g.success_count + g.failure_count), 1);
        const now = Date.now();
        const DAY_90 = 90 * 24 * 60 * 60 * 1000;
        const COLD_START = 5; // genes need ≥5 executions to reach full weight
        genes.sort((a, b) => {
          const rDiff = (relevanceMap.get(b.id) || 0) - (relevanceMap.get(a.id) || 0);
          if (Math.abs(rDiff) > 2) return rDiff;
          const usageA = a.success_count + a.failure_count;
          const usageB = b.success_count + b.failure_count;
          const dampenA = Math.min(1, (usageA + 0.5) / COLD_START);
          const dampenB = Math.min(1, (usageB + 0.5) / COLD_START);
          const scoreA =
            (((a as any).qualityScore ?? 0.01) * 0.6 +
              (usageA / maxUsage) * 0.3 +
              Math.max(0, 1 - (now - new Date((a as any).createdAt || 0).getTime()) / DAY_90) * 0.1) *
            dampenA;
          const scoreB =
            (((b as any).qualityScore ?? 0.01) * 0.6 +
              (usageB / maxUsage) * 0.3 +
              Math.max(0, 1 - (now - new Date((b as any).createdAt || 0).getTime()) / DAY_90) * 0.1) *
            dampenB;
          return scoreB - scoreA;
        });
        break;
      }
      default: // newest with relevance
        genes.sort((a, b) => (relevanceMap.get(b.id) || 0) - (relevanceMap.get(a.id) || 0));
        break;
    }
  } else {
    // No search — pure sort
    switch (opts.sort) {
      case 'most_used':
        genes.sort((a, b) => b.success_count + b.failure_count - (a.success_count + a.failure_count));
        break;
      case 'highest_success':
        genes.sort((a, b) => {
          const aRate =
            a.success_count + a.failure_count > 0 ? a.success_count / (a.success_count + a.failure_count) : 0;
          const bRate =
            b.success_count + b.failure_count > 0 ? b.success_count / (b.success_count + b.failure_count) : 0;
          return bRate - aRate;
        });
        break;
      case 'recommended': {
        const maxUsage = Math.max(...genes.map((g) => g.success_count + g.failure_count), 1);
        const now = Date.now();
        const DAY_90 = 90 * 24 * 60 * 60 * 1000;
        const COLD_START = 5; // genes need ≥5 executions to reach full weight
        genes.sort((a, b) => {
          const usageA = a.success_count + a.failure_count;
          const usageB = b.success_count + b.failure_count;
          const dampenA = Math.min(1, (usageA + 0.5) / COLD_START);
          const dampenB = Math.min(1, (usageB + 0.5) / COLD_START);
          const scoreA =
            (((a as any).qualityScore ?? 0.01) * 0.6 +
              (usageA / maxUsage) * 0.3 +
              Math.max(0, 1 - (now - new Date((a as any).createdAt || 0).getTime()) / DAY_90) * 0.1) *
            dampenA;
          const scoreB =
            (((b as any).qualityScore ?? 0.01) * 0.6 +
              (usageB / maxUsage) * 0.3 +
              Math.max(0, 1 - (now - new Date((b as any).createdAt || 0).getTime()) / DAY_90) * 0.1) *
            dampenB;
          return scoreB - scoreA;
        });
        break;
      }
      default:
        genes.sort((a, b) => {
          const aTime = (a as any).createdAt ? new Date((a as any).createdAt).getTime() : 0;
          const bTime = (b as any).createdAt ? new Date((b as any).createdAt).getTime() : 0;
          return bTime - aTime;
        });
        break;
    }
  }

  const total = genes.length;
  const start = (opts.page - 1) * opts.limit;
  return { genes: genes.slice(start, start + opts.limit), total };
}

/** GET /public/genes/:id — Gene detail with real stats */
export async function getPublicGeneDetail(geneId: string): Promise<PrismerGene | null> {
  const [allGenes, stats] = await Promise.all([getAllPublicGenes(), aggregatePublicGeneStats()]);
  const enriched = enrichGenesWithStats(allGenes, stats);
  return enriched.find((g) => g.id === geneId) || null;
}

/** GET /public/genes/:geneId/capsules — Recent capsules for a specific gene */
export async function getPublicGeneCapsules(
  geneId: string,
  limit: number,
): Promise<
  Array<{
    outcome: string;
    score: number | null;
    createdAt: Date;
    agentName: string;
  }>
> {
  // Match base geneId and imported variants (e.g. {geneId}_imp_xxx)
  const capsules = await prisma.iMEvolutionCapsule.findMany({
    where: {
      scope: 'global',
      OR: [{ geneId }, { geneId: { startsWith: `${geneId}_imp_` } }, { geneId: { startsWith: `${geneId}_fork_` } }],
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      outcome: true,
      score: true,
      createdAt: true,
      ownerAgentId: true,
    },
  });

  if (capsules.length === 0) return [];

  const agentIds = [...new Set(capsules.map((c: any) => c.ownerAgentId))];
  const cards = await prisma.iMAgentCard.findMany({
    where: { imUserId: { in: agentIds } },
    select: { imUserId: true, name: true },
  });
  const agentNameMap = new Map<string, string>();
  for (const card of cards) {
    agentNameMap.set(card.imUserId, card.name);
  }

  return capsules.map((c: any) => ({
    outcome: c.outcome,
    score: c.score,
    createdAt: c.createdAt,
    agentName: agentNameMap.get(c.ownerAgentId) || 'Unknown Agent',
  }));
}

/** GET /public/genes/:geneId/lineage — Trace gene ancestry and descendants */
export async function getGeneLineage(geneId: string): Promise<{
  gene: PrismerGene;
  ancestors: PrismerGene[];
  descendants: PrismerGene[];
  stats: { totalVariants: number; totalExecutions: number; maxGeneration: number };
} | null> {
  const allGenes = await getAllPublicGenes();

  // Also load private genes from all agents for lineage traversal
  const agents = await prisma.iMAgentCard.findMany({
    select: { metadata: true },
  });
  const allGenesIncludingPrivate: PrismerGene[] = [...allGenes];
  for (const agent of agents) {
    const metadata = JSON.parse(agent.metadata || '{}');
    const genes: PrismerGene[] = metadata.genes || [];
    for (const gene of genes) {
      if (!allGenesIncludingPrivate.find((g) => g.id === gene.id)) {
        allGenesIncludingPrivate.push(gene);
      }
    }
  }

  const gene = allGenesIncludingPrivate.find((g) => g.id === geneId);
  if (!gene) return null;

  // Trace ancestors via parentGeneId chain
  const ancestors: PrismerGene[] = [];
  let currentId = gene.parentGeneId;
  const visited = new Set<string>([geneId]);
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const ancestor = allGenesIncludingPrivate.find((g) => g.id === currentId);
    if (!ancestor) break;
    ancestors.push(ancestor);
    currentId = ancestor.parentGeneId;
  }

  // Find descendants via BFS
  const descendants: PrismerGene[] = [];
  const queue = [geneId];
  const descendantVisited = new Set<string>([geneId]);
  while (queue.length > 0) {
    const parentId = queue.shift()!;
    for (const g of allGenesIncludingPrivate) {
      if (g.parentGeneId === parentId && !descendantVisited.has(g.id)) {
        descendantVisited.add(g.id);
        descendants.push(g);
        queue.push(g.id);
      }
    }
  }

  const allVariants = [gene, ...ancestors, ...descendants];
  const totalExecutions = allVariants.reduce((sum, g) => sum + g.success_count + g.failure_count, 0);
  const maxGeneration = Math.max(...allVariants.map((g) => g.generation || 0));

  return {
    gene,
    ancestors,
    descendants,
    stats: {
      totalVariants: allVariants.length,
      totalExecutions,
      maxGeneration,
    },
  };
}

/** GET /public/feed — Recent evolution events across the ecosystem */
export async function getPublicFeed(limit = 20): Promise<
  Array<{
    type: 'capsule' | 'distill' | 'publish' | 'milestone';
    timestamp: string;
    agentName: string;
    geneTitle: string;
    geneId?: string;
    geneCategory: string;
    signal?: string;
    outcome?: string;
    score?: number;
    detail?: string;
  }>
> {
  type FeedEvent = {
    type: 'capsule' | 'distill' | 'publish' | 'milestone';
    timestamp: string;
    agentName: string;
    geneTitle: string;
    geneId?: string;
    geneCategory: string;
    signal?: string;
    outcome?: string;
    score?: number;
    detail?: string;
  };

  const events: FeedEvent[] = [];

  // Build a lookup of agentId → name from all cards
  const cards = await prisma.iMAgentCard.findMany({
    select: { imUserId: true, name: true, metadata: true },
  });
  const agentNameMap = new Map<string, string>();
  for (const card of cards) {
    agentNameMap.set(card.imUserId, card.name);
  }

  // Build gene lookup from all cards' metadata + seed genes
  const seedGenes = loadSeedGenes();
  const geneLookup = new Map<string, { title: string; category: string }>();
  for (const sg of seedGenes) {
    geneLookup.set(sg.id, { title: sg.title || sg.id, category: sg.category });
  }

  for (const card of cards) {
    const metadata = JSON.parse(card.metadata || '{}');
    const genes: PrismerGene[] = metadata.genes || [];
    const agentName = card.name || 'Unknown Agent';

    // Index this agent's genes
    for (const gene of genes) {
      geneLookup.set(gene.id, { title: gene.title || gene.id, category: gene.category });
    }

    // Published genes → type='publish'
    for (const gene of genes) {
      if (gene.visibility === 'published') {
        events.push({
          type: 'publish',
          timestamp: gene.last_used_at || new Date().toISOString(),
          agentName,
          geneTitle: gene.title || gene.id,
          geneId: gene.id,
          geneCategory: gene.category,
          detail: `Gene published to ecosystem`,
        });
      }
    }

    // last_distill_at → type='distill'
    if (metadata.last_distill_at) {
      events.push({
        type: 'distill',
        timestamp: metadata.last_distill_at,
        agentName,
        geneTitle: 'Distilled Gene',
        geneCategory: 'innovate',
        detail: 'Agent distilled a new gene from successful capsules',
      });
    }

    // Credit milestones (check total success_count thresholds)
    let totalSuccess = 0;
    let latestUsedAt: string | null = null;
    for (const g of genes) {
      totalSuccess += g.success_count || 0;
      if (g.last_used_at && (!latestUsedAt || g.last_used_at > latestUsedAt)) {
        latestUsedAt = g.last_used_at;
      }
    }
    const milestones = [100, 50, 25, 10];
    for (const m of milestones) {
      if (totalSuccess >= m) {
        events.push({
          type: 'milestone',
          timestamp: latestUsedAt || new Date().toISOString(),
          agentName,
          geneTitle: `${m}+ successful executions`,
          geneCategory: 'optimize',
          detail: `Agent reached ${m} successful gene executions`,
        });
        break; // Only report highest milestone
      }
    }
  }

  // Fetch recent capsules from DB for capsule events (exclude 'unmatched' noise)
  const recentCapsules = await prisma.iMEvolutionCapsule.findMany({
    where: { scope: 'global', geneId: { not: 'unmatched' } },
    orderBy: { createdAt: 'desc' },
    take: limit * 2, // fetch extra to account for dedup
  });

  for (const capsule of recentCapsules) {
    const geneInfo = geneLookup.get(capsule.geneId);
    let triggerSignals: string[] = [];
    try {
      triggerSignals = JSON.parse(capsule.triggerSignals || '[]');
    } catch {
      /* ignore */
    }

    events.push({
      type: 'capsule',
      timestamp: capsule.createdAt.toISOString(),
      agentName: agentNameMap.get(capsule.ownerAgentId) || 'Unknown Agent',
      geneTitle: geneInfo?.title || capsule.geneId,
      geneId: capsule.geneId,
      geneCategory: geneInfo?.category || 'repair',
      signal: triggerSignals[0] || undefined,
      outcome: capsule.outcome,
      score: capsule.score ?? undefined,
      detail: capsule.summary || undefined,
    });
  }

  // Synthetic feed from seed genes (ensures feed is never empty)
  if (events.length < limit) {
    for (const sg of seedGenes) {
      events.push({
        type: 'publish',
        timestamp: sg.last_used_at || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
        agentName: 'Prismer Seed',
        geneTitle: sg.title || sg.id,
        geneId: sg.id,
        geneCategory: sg.category,
        detail: `${sg.title || sg.id} added to ecosystem`,
      });
    }
  }

  // Sort by timestamp descending, take limit
  events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return events.slice(0, limit);
}

/** GET /evolution/stories — Recent evolution events for L1 narrative embedding */
export async function getStories(
  limit = 3,
  sinceMinutes = 30,
): Promise<
  Array<{
    id: string;
    timestamp: string;
    agent: { id: string; name: string };
    task: { description: string };
    signal: { key: string; category: string; label: string };
    gene: { id: string; name: string; category: string; strategyPreview: string };
    outcome: 'success' | 'failed';
    effect: {
      actionDescription: string;
      resultSummary: string;
      geneSuccessRateBefore: number;
      geneSuccessRateAfter: number;
      successRateDelta: number;
      isExplorationEvent: boolean;
    };
  }>
> {
  const since = new Date(Date.now() - sinceMinutes * 60 * 1000);
  const capsules = await prisma.iMEvolutionCapsule.findMany({
    where: { createdAt: { gte: since }, outcome: { in: ['success', 'failed'] }, scope: 'global' },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      geneId: true,
      signalKey: true,
      outcome: true,
      ownerAgentId: true,
      createdAt: true,
      summary: true,
    },
  });

  if (capsules.length === 0) return [];

  // Fetch gene + agent info for each capsule
  const geneIds = [...new Set(capsules.map((c: { geneId: string }) => c.geneId))];
  const agentIds = [...new Set(capsules.map((c: { ownerAgentId: string }) => c.ownerAgentId))];
  const [genes, agents] = await Promise.all([
    prisma.iMGene.findMany({ where: { id: { in: geneIds } } }),
    prisma.iMAgentCard.findMany({ where: { imUserId: { in: agentIds } }, select: { imUserId: true, name: true } }),
  ]);
  type GeneRow = {
    id: string;
    title: string | null;
    category: string;
    successCount: number;
    failureCount: number;
    strategy?: unknown;
    [k: string]: unknown;
  };
  const geneMap = new Map((genes as GeneRow[]).map((g) => [g.id, g]));
  const agentMap = new Map(agents.map((a: { imUserId: string; name: string }) => [a.imUserId, a.name]));

  type CapsuleRow = {
    id: string;
    geneId: string;
    signalKey: string | null;
    outcome: string;
    ownerAgentId: string;
    createdAt: Date;
    summary: string | null;
  };
  return (capsules as CapsuleRow[]).map((c) => {
    const gene = geneMap.get(c.geneId);
    const signalKey = c.signalKey || 'unknown';
    const category = signalKey.startsWith('error:') ? 'error' : signalKey.startsWith('task') ? 'task' : 'tag';
    const total = (gene?.successCount ?? 0) + (gene?.failureCount ?? 0);
    const currentRate = total > 0 ? (gene?.successCount ?? 0) / total : 0;
    const prevRate =
      c.outcome === 'success'
        ? total > 1
          ? ((gene?.successCount ?? 1) - 1) / (total - 1)
          : 0
        : total > 1
          ? (gene?.successCount ?? 0) / (total - 1)
          : 0;
    const geneStrategy =
      gene && typeof (gene as Record<string, unknown>).strategy === 'object'
        ? ((gene as Record<string, unknown>).strategy as string[])
        : [];
    return {
      id: c.id,
      timestamp: c.createdAt.toISOString(),
      agent: { id: c.ownerAgentId, name: (agentMap.get(c.ownerAgentId) || c.ownerAgentId) as string },
      task: { description: c.summary || 'Evolution task' },
      signal: { key: signalKey, category, label: signalKey.split(':').slice(1).join(':') || signalKey },
      gene: {
        id: c.geneId,
        name: (gene?.title as string) || c.geneId,
        category: (gene?.category as string) || 'repair',
        strategyPreview: Array.isArray(geneStrategy) ? geneStrategy.slice(0, 2).join(' → ') : '',
      },
      outcome: c.outcome as 'success' | 'failed',
      effect: {
        actionDescription: c.summary || '',
        resultSummary: c.outcome === 'success' ? 'Task completed' : 'Task failed',
        geneSuccessRateBefore: prevRate,
        geneSuccessRateAfter: currentRate,
        successRateDelta: currentRate - prevRate,
        isExplorationEvent: total < 10,
      },
    };
  });
}

/** GET /evolution/map — Aggregated data for the Evolution Map visualization
 *
 * Supports scoped loading via opts:
 * - topN: limit gene count to top N by execution count (default: all)
 * - includeGeneIds: always include these gene IDs even if not in topN
 *   (ensures activity feed items are always zoomable on the map)
 */
export async function getMapData(opts?: { topN?: number; includeGeneIds?: string[] }): Promise<{
  signals: Array<{ key: string; category: string; frequency: number; lastSeen: string | null }>;
  genes: Array<{
    id: string;
    title: string;
    category: string;
    successRate: number;
    totalExecutions: number;
    agentCount: number;
    pqi: number;
  }>;
  edges: Array<{
    signalKey: string;
    geneId: string;
    alpha: number;
    beta: number;
    confidence: number;
    totalObs: number;
    isExploring: boolean;
  }>;
  recentEvents: Array<{
    signalKey: string;
    geneId: string;
    outcome: 'success' | 'failed';
    agentName: string;
    timestamp: string;
    // v0.4.0: traceability fields
    summary?: string;
    score?: number;
    extractionMethod?: string;
    rootCause?: string;
    rawContextPreview?: string;
    geneTitle?: string;
  }>;
  hyperedges: Array<{
    id: string;
    atoms: Array<{ kind: string; value: string; role?: string | null }>;
  }>;
  causalLinks: Array<{
    causeId: string;
    effectId: string;
    strength: number;
    linkType: string;
  }>;
  stats: {
    totalExecutions: number;
    systemSuccessRate: number;
    activeAgents: number;
    explorationRate: number;
    totalSignals: number;
    totalGenes: number;
    totalEdges: number;
    totalHyperedges: number;
    totalCausalLinks: number;
    // Quality metrics
    avgCapsuleQuality: number;
    highQualityCapsules: number;
    lowQualityCapsules: number;
    signalClusters: number;
    geneUtilization: number;
  };
}> {
  // 1. Fetch all data in parallel
  const [allGenes, capsuleStats, allEdges, recentCapsules, agentCount, agentCards] = await Promise.all([
    getAllPublicGenes(),
    aggregatePublicGeneStats(),
    prisma.iMEvolutionEdge.findMany({ where: { scope: 'global' }, orderBy: { updatedAt: 'desc' }, take: 2000 }),
    prisma.iMEvolutionCapsule.findMany({
      where: { scope: 'global' },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        geneId: true,
        signalKey: true,
        outcome: true,
        ownerAgentId: true,
        createdAt: true,
        summary: true,
        score: true,
        metadata: true,
      },
    }),
    prisma.iMAgentCard.count(),
    prisma.iMAgentCard.findMany({ select: { imUserId: true, name: true } }),
  ]);

  // 1.5 Supplement: if includeGeneIds requested genes that aren't in allGenes (e.g. draft visibility),
  // fetch them separately so activity-sidebar clicks always find their gene in the map.
  const existingIds = new Set(allGenes.map((g) => g.id));
  const missingIds = (opts?.includeGeneIds || []).filter((id) => !existingIds.has(id) && id !== 'unmatched');
  if (missingIds.length > 0) {
    const extra = await prisma.iMGene.findMany({
      where: { id: { in: missingIds }, scope: 'global' },
      include: { signalLinks: true },
    });
    for (const r of extra) {
      allGenes.push(dbGeneToModel(r as any));
    }
  }

  const enriched = enrichGenesWithStats(allGenes, capsuleStats);
  const agentNameMap = new Map(agentCards.map((a: { imUserId: string; name: string }) => [a.imUserId, a.name]));

  // 2. Build signal frequency map from edges + gene.signals_match
  const signalFreq = new Map<
    string,
    { freq: number; lastSeen: string | null; edgeCount: number; connectedGenes: Set<string> }
  >();
  for (const gene of enriched) {
    for (const tag of gene.signals_match) {
      const sig = tag.type;
      if (!signalFreq.has(sig))
        signalFreq.set(sig, { freq: 0, lastSeen: null, edgeCount: 0, connectedGenes: new Set() });
      signalFreq.get(sig)!.connectedGenes.add(gene.id);
    }
  }
  for (const edge of allEdges) {
    const parts = edge.signalKey.split('|');
    for (const sig of parts) {
      const existing = signalFreq.get(sig) ?? { freq: 0, lastSeen: null, edgeCount: 0, connectedGenes: new Set() };
      existing.freq += (edge.successCount ?? 0) + (edge.failureCount ?? 0);
      existing.edgeCount++;
      existing.connectedGenes.add(edge.geneId);
      const edgeTime = edge.updatedAt?.toISOString() ?? null;
      if (edgeTime && (!existing.lastSeen || edgeTime > existing.lastSeen)) {
        existing.lastSeen = edgeTime;
      }
      signalFreq.set(sig, existing);
    }
  }

  // 3. Aggregate signals: group signals that connect to the same gene set
  const categorizeSignal = (key: string): string => {
    if (key.startsWith('error:')) return 'error';
    if (key.startsWith('task.') || key.startsWith('task:')) return 'task';
    if (key.startsWith('capability:')) return 'capability';
    if (key.startsWith('perf:')) return 'perf';
    if (key.startsWith('cost:')) return 'cost';
    if (key.startsWith('quality:')) return 'quality';
    if (key.startsWith('security:')) return 'security';
    return 'tag';
  };

  // Semantic signal grouping: merge by gene-level grouping
  const signalEntries = Array.from(signalFreq.entries()).map(([key, info]) => ({
    key,
    category: categorizeSignal(key),
    ...info,
  }));

  // Sort by edge count desc so important signals survive as group representative
  signalEntries.sort((a, b) => b.edgeCount - a.edgeCount);

  const signalRemap = new Map<string, string>();
  const merged = new Map<
    string,
    { keys: string[]; category: string; freq: number; lastSeen: string | null; connectedGenes: Set<string> }
  >();
  const assigned = new Set<string>();

  for (const sig of signalEntries) {
    if (assigned.has(sig.key)) continue;

    // Find unassigned signals in same category that share ≥1 gene
    const group = [sig.key];
    assigned.add(sig.key);
    const groupGenes = new Set(sig.connectedGenes);

    for (const other of signalEntries) {
      if (assigned.has(other.key) || other.category !== sig.category) continue;
      // Check overlap: any shared gene?
      let shared = 0;
      for (const g of other.connectedGenes) {
        if (groupGenes.has(g)) shared++;
      }
      if (shared > 0) {
        group.push(other.key);
        assigned.add(other.key);
        for (const g of other.connectedGenes) groupGenes.add(g);
      }
    }

    // Create group key
    let displayKey: string;
    if (group.length === 1) {
      displayKey = sig.key;
    } else {
      displayKey = `${sig.key} +${group.length - 1}`;
    }

    // Accumulate frequency
    let totalFreq = 0;
    let latestSeen: string | null = null;
    for (const k of group) {
      const info = signalFreq.get(k)!;
      totalFreq += info.freq;
      if (info.lastSeen && (!latestSeen || info.lastSeen > latestSeen)) latestSeen = info.lastSeen;
    }

    merged.set(displayKey, {
      keys: group,
      category: sig.category,
      freq: totalFreq,
      lastSeen: latestSeen,
      connectedGenes: groupGenes,
    });

    for (const k of group) signalRemap.set(k, displayKey);
  }

  const signals: Array<{ key: string; category: string; frequency: number; lastSeen: string | null }> = [];
  for (const [displayKey, group] of merged) {
    signals.push({
      key: displayKey,
      category: group.category,
      frequency: group.freq,
      lastSeen: group.lastSeen,
    });
  }

  // 4. Build gene nodes
  const maxExec = Math.max(...enriched.map((g) => g.success_count + g.failure_count), 1);
  let genes = enriched.map((g) => {
    const total = g.success_count + g.failure_count;
    const successRate = total > 0 ? g.success_count / total : 0;
    const normalizedExec = Math.min(total / maxExec, 1);
    const adoptionRate = 0.5; // simplified for map view
    const pqi = Math.round((successRate * 0.4 + normalizedExec * 0.3 + adoptionRate * 0.2 + 0.5 * 0.1) * 100);
    return {
      id: g.id,
      title:
        g.title ||
        (() => {
          const raw = g.id
            .replace(/^(seed|gene)_/, '')
            .replace(/_v\d+$/, '')
            .replace(/[_]/g, ' ')
            .replace(/\b[a-z0-9]{6,10}$/, '')
            .trim();
          if (!raw) return g.category.charAt(0).toUpperCase() + g.category.slice(1) + ' Strategy';
          return raw
            .split(' ')
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
            .join(' ');
        })(),
      category: g.category,
      successRate,
      totalExecutions: total,
      agentCount: 0, // will be enriched below
      pqi,
    };
  });

  // 4.5 Scoped filtering: topN + includeGeneIds (Step A of viewport loading)
  // Keeps response size bounded while ensuring activity-referenced genes are always present.
  const includeSet = new Set(opts?.includeGeneIds || []);
  const hasTopN = opts?.topN && opts.topN > 0 && genes.length > opts.topN;
  const hasIncludes = includeSet.size > 0;

  if (hasTopN || hasIncludes) {
    const keepSet = new Set<string>();

    // Always include explicitly requested geneIds
    for (const id of includeSet) keepSet.add(id);

    if (hasTopN) {
      // Add top N by execution count
      const sorted = [...genes].sort((a, b) => b.totalExecutions - a.totalExecutions);
      for (const g of sorted.slice(0, opts!.topN!)) keepSet.add(g.id);
    }

    if (hasTopN) {
      // Only filter when topN is set (includeGeneIds alone = full mode + ensure presence)
      const beforeCount = genes.length;
      genes = genes.filter((g) => keepSet.has(g.id));
      if (genes.length < beforeCount) {
        console.log(
          `[EvolutionMap] Scoped: ${beforeCount} → ${genes.length} genes (topN=${opts!.topN}, include=${includeSet.size})`,
        );
      }
    }
  }

  // Count agents per gene from edges
  const geneAgentSet = new Map<string, Set<string>>();
  for (const edge of allEdges) {
    const set = geneAgentSet.get(edge.geneId) ?? new Set();
    set.add(edge.ownerAgentId);
    geneAgentSet.set(edge.geneId, set);
  }
  for (const g of genes) {
    g.agentCount = geneAgentSet.get(g.id)?.size ?? 0;
  }

  // 5. Build edges using REMAPPED (aggregated) signal keys
  const aggregatedSignalKeys = new Set(signals.map((s) => s.key));
  const geneIdSet = new Set(genes.map((g) => g.id));
  const edgeMap = new Map<string, { alpha: number; beta: number }>();

  for (const edge of allEdges) {
    const parts = edge.signalKey.split('|');
    for (const sig of parts) {
      const mappedSig = signalRemap.get(sig) || sig;
      if (!aggregatedSignalKeys.has(mappedSig)) continue;
      const edgeKey = `${mappedSig}→${edge.geneId}`;
      const existing = edgeMap.get(edgeKey) ?? { alpha: 1, beta: 1 };
      existing.alpha += edge.successCount ?? 0;
      existing.beta += edge.failureCount ?? 0;
      edgeMap.set(edgeKey, existing);
    }
  }

  // Seed gene implied edges (signals_match → gene)
  for (const gene of enriched) {
    for (const tag of gene.signals_match) {
      const sig = tag.type;
      const mappedSig = signalRemap.get(sig) || sig;
      if (!aggregatedSignalKeys.has(mappedSig)) continue;
      const edgeKey = `${mappedSig}→${gene.id}`;
      if (!edgeMap.has(edgeKey)) {
        edgeMap.set(edgeKey, { alpha: 1, beta: 1 });
      }
    }
  }

  // Build bimodality + coverage lookup from raw edges
  const edgeBimodality = new Map<string, { bi: number; tsr: number | null; cl: number }>();
  for (const edge of allEdges) {
    const parts = edge.signalKey.split('|');
    for (const sig of parts) {
      const mappedSig = signalRemap.get(sig) || sig;
      const k = `${mappedSig}→${edge.geneId}`;
      if (!edgeBimodality.has(k)) {
        edgeBimodality.set(k, {
          bi: ((edge as Record<string, unknown>).bimodalityIndex as number) ?? 0,
          tsr: ((edge as Record<string, unknown>).taskSuccessRate as number | null) ?? null,
          cl: ((edge as Record<string, unknown>).coverageLevel as number) ?? 0,
        });
      }
    }
  }

  const edges = Array.from(edgeMap.entries())
    .filter(([key]) => {
      const geneId = key.split('→')[1];
      return geneIdSet.has(geneId);
    })
    .map(([key, val]) => {
      const [signalKey, geneId] = key.split('→');
      const totalObs = val.alpha + val.beta - 2;
      const routingWeight = val.alpha / (val.alpha + val.beta);
      const extra = edgeBimodality.get(key);
      return {
        signalKey,
        geneId,
        alpha: val.alpha,
        beta: val.beta,
        confidence: routingWeight,
        routingWeight,
        totalObs,
        isExploring: totalObs < 10,
        bimodalityIndex: extra?.bi ?? 0,
        taskSuccessRate: extra?.tsr ?? undefined,
        coverageLevel: extra?.cl ?? 0,
      };
    });

  // 6. Recent events (with traceability)
  type CapsuleRow = {
    geneId: string;
    signalKey: string;
    outcome: string;
    ownerAgentId: string;
    createdAt: Date;
    summary?: string | null;
    score?: number | null;
    metadata?: string | null;
  };
  const geneNameMap = new Map(enriched.map((g) => [g.id, g.title || g.id]));
  const recentEvents = (recentCapsules as CapsuleRow[])
    .filter((c) => c.outcome === 'success' || c.outcome === 'failed')
    .slice(0, 20)
    .map((c) => {
      // Parse extraction trace from metadata if present
      let extractionMethod: string | undefined;
      let rootCause: string | undefined;
      let rawContextPreview: string | undefined;
      try {
        const meta = JSON.parse(c.metadata || '{}');
        const trace = meta.extraction_trace;
        if (trace) {
          extractionMethod = trace.extraction_method;
          rootCause = trace.root_cause;
          rawContextPreview = trace.raw_context?.slice(0, 200);
        }
      } catch {
        /* ignore */
      }

      return {
        signalKey: c.signalKey,
        geneId: c.geneId,
        outcome: c.outcome as 'success' | 'failed',
        agentName: (agentNameMap.get(c.ownerAgentId) as string) || 'Agent',
        timestamp: c.createdAt.toISOString(),
        summary: c.summary || undefined,
        score: c.score ?? undefined,
        extractionMethod,
        rootCause,
        rawContextPreview,
        geneTitle: geneNameMap.get(c.geneId) || undefined,
      };
    });

  // 7. Hypergraph data (超边: N-ary execution relationships)
  // Graceful degradation: hypergraph tables may not exist in all environments
  let hyperedges: Array<{ id: string; atoms: Array<{ kind: string; value: string; role?: string | null }> }> = [];
  let causalLinks: Array<{ causeId: string; effectId: string; strength: number; linkType: string }> = [];
  try {
    const [hyperedgeAtoms, rawCausalLinks] = await Promise.all([
      prisma.iMHyperedgeAtom.findMany({
        include: { atom: true, hyperedge: true },
        orderBy: { hyperedge: { createdAt: 'desc' } },
        take: 500,
      }),
      prisma.iMCausalLink.findMany({ take: 200 }),
    ]);

    // Group atoms by hyperedge
    const hyperedgeMap = new Map<string, Array<{ kind: string; value: string; role?: string | null }>>();
    for (const ha of hyperedgeAtoms) {
      const arr = hyperedgeMap.get(ha.hyperedgeId) ?? [];
      arr.push({ kind: ha.atom.kind, value: ha.atom.value, role: ha.role });
      hyperedgeMap.set(ha.hyperedgeId, arr);
    }

    hyperedges = Array.from(hyperedgeMap.entries()).map(([id, atoms]) => ({
      id,
      atoms,
    }));
    causalLinks = rawCausalLinks.map(
      (cl: { causeId: string; effectId: string; strength: number; linkType: string }) => ({
        causeId: cl.causeId,
        effectId: cl.effectId,
        strength: cl.strength,
        linkType: cl.linkType,
      }),
    );
  } catch (err) {
    console.error('[EvolutionPublic] Hypergraph query failed (tables may not exist):', (err as Error).message);
  }

  // 8. Stats
  const totalExec = edges.reduce((sum, e) => sum + e.totalObs, 0);
  const totalSuccess = edges.reduce((sum, e) => sum + (e.alpha - 1), 0);
  const exploringEdges = edges.filter((e) => e.isExploring).length;

  return {
    signals,
    genes,
    edges,
    hyperedges,
    causalLinks,
    recentEvents,
    stats: {
      totalExecutions: totalExec,
      systemSuccessRate: totalExec > 0 ? totalSuccess / totalExec : 0,
      activeAgents: agentCount,
      explorationRate: edges.length > 0 ? exploringEdges / edges.length : 1,
      totalSignals: signals.length,
      totalGenes: genes.length,
      totalEdges: edges.length,
      totalHyperedges: hyperedges.length,
      totalCausalLinks: causalLinks.length,
      // Quality metrics
      avgCapsuleQuality: await computeAvgCapsuleQuality(),
      highQualityCapsules: await countCapsulesByQuality(0.6, 1.0),
      lowQualityCapsules: await countCapsulesByQuality(0, 0.2),
      signalClusters: await prisma.iMSignalCluster.count().catch(() => 0),
      geneUtilization:
        genes.length > 0 ? new Set((allEdges as any[]).map((e: any) => e.geneId)).size / genes.length : 0,
    },
  };
}

/** Compute average capsule quality from metadata.capsuleQuality */
async function computeAvgCapsuleQuality(): Promise<number> {
  const recent = await prisma.iMEvolutionCapsule.findMany({
    where: { outcome: { in: ['success', 'failed'] }, scope: 'global' },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: { metadata: true },
  });
  let sum = 0,
    count = 0;
  for (const c of recent) {
    try {
      const meta = JSON.parse(c.metadata || '{}');
      if (typeof meta.capsuleQuality === 'number') {
        sum += meta.capsuleQuality;
        count++;
      }
    } catch {
      /* skip */
    }
  }
  return count > 0 ? Math.round((sum / count) * 100) / 100 : 0;
}

/** Count capsules within a quality range */
async function countCapsulesByQuality(min: number, max: number): Promise<number> {
  const recent = await prisma.iMEvolutionCapsule.findMany({
    where: { outcome: { in: ['success', 'failed'] }, scope: 'global' },
    orderBy: { createdAt: 'desc' },
    take: 200,
    select: { metadata: true },
  });
  let count = 0;
  for (const c of recent) {
    try {
      const meta = JSON.parse(c.metadata || '{}');
      const q = meta.capsuleQuality;
      if (typeof q === 'number' && q >= min && q <= max) count++;
    } catch {
      /* skip */
    }
  }
  return count;
}
