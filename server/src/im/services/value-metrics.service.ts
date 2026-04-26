/**
 * Value Metrics Service
 *
 * Computes token savings, money saved, CO2 reduced, dev hours saved
 * for agents and creators. Runs daily via scheduler.
 */

import prisma from '../db';
import { createModuleLogger } from '../../lib/logger';

const log = createModuleLogger('ValueMetrics');

// --- Constants ---

/** Claude Sonnet pricing: ~$3 input + $15 output per 1M tokens, blended ~$9/1M */
const PRICE_PER_1K_TOKENS = 0.009;
/** GPU carbon intensity: ~0.0003 kg CO2 per 1k tokens (datacenter average) */
const CO2_PER_1K_TOKENS = 0.0003;
/** Average dev time per retry attempt: 8 minutes */
const MINUTES_PER_RETRY = 8;
/** Cold-start baseline: estimated tokens consumed without gene guidance.
 *  Used when im_token_baselines is empty (no costCredits data yet).
 *  This bootstrap value is replaced once real cost data flows in. */
const DEFAULT_BASELINE_TOKENS = 500;

// --- Token Baseline ---

export async function computeTokenBaselines(): Promise<number> {
  // Primary: capsules without gene guidance (geneId='none' or empty) as baseline
  const noGeneCapsules = await prisma.iMEvolutionCapsule.findMany({
    where: {
      scope: 'global',
      outcome: { in: ['success', 'failed'] },
      OR: [{ geneId: 'none' }, { geneId: '' }],
    },
    select: { signalKey: true, costCredits: true },
    take: 100000,
  });

  // Fallback: if no baseline capsules exist, use ALL capsules with a 1.5x multiplier
  // (gene-guided capsules are more efficient, so we inflate to approximate no-gene cost)
  const FALLBACK_MULTIPLIER = 1.5;
  let capsules = noGeneCapsules;
  let usingFallback = false;

  if (capsules.length === 0) {
    capsules = await prisma.iMEvolutionCapsule.findMany({
      where: {
        scope: 'global',
        outcome: { in: ['success', 'failed'] },
        costCredits: { gt: 0 },
      },
      select: { signalKey: true, costCredits: true },
      take: 100000,
    });
    usingFallback = true;
  }

  // Group by signalKey and compute average
  const groups = new Map<string, { total: number; count: number }>();
  for (const c of capsules) {
    const key = c.signalKey || 'unknown';
    const g = groups.get(key) || { total: 0, count: 0 };
    g.total += c.costCredits;
    g.count += 1;
    groups.set(key, g);
  }

  let upsertCount = 0;
  for (const [signalKey, { total, count }] of groups) {
    if (count < 2) continue; // Relaxed from 3 to 2 for fallback mode
    let avgTokensNoGene = total / count;
    if (usingFallback) avgTokensNoGene *= FALLBACK_MULTIPLIER;
    await prisma.iMTokenBaseline.upsert({
      where: { signalKey },
      create: { signalKey, avgTokensNoGene, sampleCount: count },
      update: { avgTokensNoGene, sampleCount: count },
    });
    upsertCount++;
  }

  log.info(`Token baselines computed: ${upsertCount} signal keys${usingFallback ? ' (fallback mode)' : ''}`);
  return upsertCount;
}

// --- Value Metrics Computation ---

interface AgentValueMetrics {
  agentId: string;
  tokenSaved: number;
  moneySaved: number;
  co2Reduced: number;
  devHoursSaved: number;
  errorPatterns: number;
  agentsHelped: number; // only for creators
  adoptionCount: number; // only for creators
}

export async function computeValueMetrics(
  period: 'weekly' | 'monthly' | 'alltime',
): Promise<{ agents: number; creators: number }> {
  const since =
    period === 'weekly'
      ? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      : period === 'monthly'
        ? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
        : new Date(0);
  const now = new Date();

  // Load all baselines
  const baselines = await prisma.iMTokenBaseline.findMany();
  const baselineMap = new Map<string, number>(baselines.map((b: any) => [b.signalKey, b.avgTokensNoGene]));

  // Compute global average baseline as fallback for signalKeys without dedicated baseline
  const baselineValues = baselines.map((b: any) => b.avgTokensNoGene as number).filter((v: number) => v > 0);
  const globalAvgBaseline =
    baselineValues.length > 0
      ? baselineValues.reduce((a: number, b: number) => a + b, 0) / baselineValues.length
      : DEFAULT_BASELINE_TOKENS;

  // Load successful capsules with gene guidance
  const capsules = await prisma.iMEvolutionCapsule.findMany({
    where: {
      createdAt: { gte: since },
      scope: 'global',
      outcome: 'success',
      geneId: { not: 'none' },
    },
    select: {
      ownerAgentId: true,
      geneId: true,
      signalKey: true,
      costCredits: true,
    },
    take: 100000,
  });

  // Load gene ownership for cross-agent filtering
  const geneIds = [...new Set(capsules.map((c: any) => c.geneId))];
  const genes = await prisma.iMGene.findMany({
    where: { id: { in: geneIds } },
    select: { id: true, ownerAgentId: true },
  });
  const geneOwnerMap = new Map<string, string>(genes.map((g: any) => [g.id, g.ownerAgentId]));

  // Load agent->user mapping for same-owner detection
  const agentIds = [...new Set(capsules.map((c: any) => c.ownerAgentId))];
  const users = await prisma.iMUser.findMany({
    where: { id: { in: agentIds } },
    select: { id: true, username: true },
  });
  const agentUserMap = new Map<string, string>(users.map((u: any) => [u.id, u.username]));

  // --- Agent metrics ---
  const agentMetrics = new Map<string, AgentValueMetrics>();
  for (const c of capsules) {
    const baseline = baselineMap.get(c.signalKey) || globalAvgBaseline;
    if (baseline <= 0) continue;

    const tokenSaved = Math.max(0, baseline - c.costCredits);
    const m = agentMetrics.get(c.ownerAgentId) || {
      agentId: c.ownerAgentId,
      tokenSaved: 0,
      moneySaved: 0,
      co2Reduced: 0,
      devHoursSaved: 0,
      errorPatterns: 0,
      agentsHelped: 0,
      adoptionCount: 0,
    };
    m.tokenSaved += tokenSaved;
    agentMetrics.set(c.ownerAgentId, m);
  }

  // Compute derived metrics and error patterns per agent
  for (const [agentId, m] of agentMetrics) {
    m.moneySaved = (m.tokenSaved / 1000) * PRICE_PER_1K_TOKENS;
    m.co2Reduced = (m.tokenSaved / 1000) * CO2_PER_1K_TOKENS;
    // Dev hours: count of successful gene-guided capsules x avoided retries
    const agentCapsules = capsules.filter((c: any) => c.ownerAgentId === agentId);
    m.devHoursSaved = (agentCapsules.length * MINUTES_PER_RETRY) / 60;
    // Distinct error patterns solved
    const patterns = new Set(agentCapsules.map((c: any) => c.signalKey));
    m.errorPatterns = patterns.size;
  }

  // Rank agents by moneySaved
  const sortedAgents = [...agentMetrics.values()].sort((a, b) => b.moneySaved - a.moneySaved);
  const totalAgents = sortedAgents.length;

  // Get previous period values for growth rate
  const prevMetrics = await prisma.iMValueMetrics.findMany({
    where: { entityType: 'agent', period },
    orderBy: { snapshotDate: 'desc' },
    take: totalAgents,
    select: { entityId: true, moneySaved: true },
  });
  const prevMap = new Map<string, number>(prevMetrics.map((p: any) => [p.entityId, p.moneySaved]));

  // Write agent metrics
  const agentRows = sortedAgents.slice(0, 200).map((m, i) => {
    const prev = prevMap.get(m.agentId);
    const growthRate = prev && prev > 0 ? (m.moneySaved - prev) / prev : null;
    return {
      entityType: 'agent' as const,
      entityId: m.agentId,
      period,
      snapshotDate: now,
      tokenSaved: m.tokenSaved,
      moneySaved: m.moneySaved,
      co2Reduced: m.co2Reduced,
      devHoursSaved: m.devHoursSaved,
      errorPatterns: m.errorPatterns,
      agentsHelped: 0,
      adoptionCount: 0,
      rankByValue: i + 1,
      rankByImpact: null as number | null,
      percentile: totalAgents > 0 ? Math.round(((totalAgents - i) / totalAgents) * 1000) / 10 : null,
      prevPeriodValue: prev ?? null,
      growthRate,
      scope: 'global',
    };
  });

  // --- Creator metrics ---
  // Load gene freshness for decay
  const geneLastUsed = await prisma.iMGene.findMany({
    where: { id: { in: geneIds } },
    select: { id: true, lastUsedAt: true },
  });
  const lastUsedMap = new Map<string, Date | null>(geneLastUsed.map((g: any) => [g.id, g.lastUsedAt]));
  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

  // Group capsules by gene creator, filtering self-use and same-owner
  const creatorMetrics = new Map<string, AgentValueMetrics>();
  for (const c of capsules) {
    const geneOwner = geneOwnerMap.get(c.geneId);
    if (!geneOwner) continue;
    // Anti-cheat: skip self-use
    if (c.ownerAgentId === geneOwner) continue;
    // Anti-cheat: skip same-owner
    const capsuleUser = agentUserMap.get(c.ownerAgentId);
    const geneUser = agentUserMap.get(geneOwner);
    if (capsuleUser && geneUser && capsuleUser === geneUser) continue;

    const baseline = baselineMap.get(c.signalKey) || globalAvgBaseline;
    if (baseline <= 0) continue;

    // Freshness decay: if gene hasn't been used in 30+ days, halve its contribution
    let decayFactor = 1.0;
    const lastUsed = lastUsedMap.get(c.geneId);
    if (lastUsed && Date.now() - lastUsed.getTime() > THIRTY_DAYS) {
      decayFactor = 0.5;
    }
    const tokenSaved = Math.max(0, baseline - c.costCredits) * decayFactor;

    const m = creatorMetrics.get(geneOwner) || {
      agentId: geneOwner,
      tokenSaved: 0,
      moneySaved: 0,
      co2Reduced: 0,
      devHoursSaved: 0,
      errorPatterns: 0,
      agentsHelped: 0,
      adoptionCount: 0,
    };
    m.tokenSaved += tokenSaved;
    m.adoptionCount += 1;
    creatorMetrics.set(geneOwner, m);
  }

  // Compute unique agents helped per creator
  for (const [creatorId, m] of creatorMetrics) {
    const helpedAgents = new Set(
      capsules
        .filter((c: any) => {
          const owner = geneOwnerMap.get(c.geneId);
          return owner === creatorId && c.ownerAgentId !== creatorId;
        })
        .map((c: any) => c.ownerAgentId),
    );
    m.agentsHelped = helpedAgents.size;
    m.moneySaved = (m.tokenSaved / 1000) * PRICE_PER_1K_TOKENS;
    m.co2Reduced = (m.tokenSaved / 1000) * CO2_PER_1K_TOKENS;
    m.devHoursSaved = (m.adoptionCount * MINUTES_PER_RETRY) / 60;
    const patterns = new Set(
      capsules.filter((c: any) => geneOwnerMap.get(c.geneId) === creatorId).map((c: any) => c.signalKey),
    );
    m.errorPatterns = patterns.size;
  }

  const sortedCreators = [...creatorMetrics.values()].sort(
    (a, b) => b.agentsHelped * b.moneySaved - a.agentsHelped * a.moneySaved,
  );
  const totalCreators = sortedCreators.length;

  const creatorRows = sortedCreators.slice(0, 200).map((m, i) => ({
    entityType: 'creator' as const,
    entityId: m.agentId,
    period,
    snapshotDate: now,
    tokenSaved: m.tokenSaved,
    moneySaved: m.moneySaved,
    co2Reduced: m.co2Reduced,
    devHoursSaved: m.devHoursSaved,
    errorPatterns: m.errorPatterns,
    agentsHelped: m.agentsHelped,
    adoptionCount: m.adoptionCount,
    rankByValue: null as number | null,
    rankByImpact: i + 1,
    percentile: totalCreators > 0 ? Math.round(((totalCreators - i) / totalCreators) * 1000) / 10 : null,
    prevPeriodValue: null as number | null,
    growthRate: null as number | null,
    scope: 'global',
  }));

  // Batch write
  const allRows = [...agentRows, ...creatorRows];
  if (allRows.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await prisma.iMValueMetrics.createMany({ data: allRows as any[] });
  }

  log.info(`Computed: ${agentRows.length} agents, ${creatorRows.length} creators (${period})`);

  // Fire-and-forget: prune expired value metrics to prevent unbounded growth
  pruneExpiredValueMetrics(period).catch((err) => log.error({ err }, 'Prune failed'));

  return { agents: agentRows.length, creators: creatorRows.length };
}

// --- TTL Cleanup ---

/**
 * Prune expired value metrics to prevent unbounded table growth.
 * - weekly: delete snapshots older than 90 days
 * - monthly: delete snapshots older than 365 days
 * - alltime: keep only the latest snapshot per entityType+entityId
 */
async function pruneExpiredValueMetrics(period: 'weekly' | 'monthly' | 'alltime'): Promise<void> {
  if (period === 'weekly') {
    const cutoff = new Date(Date.now() - 90 * 86400_000);
    const deleted = await prisma.iMValueMetrics.deleteMany({
      where: { period: 'weekly', snapshotDate: { lt: cutoff } },
    });
    if (deleted.count > 0) {
      log.info(`Pruned ${deleted.count} weekly snapshots older than 90 days`);
    }
  } else if (period === 'monthly') {
    const cutoff = new Date(Date.now() - 365 * 86400_000);
    const deleted = await prisma.iMValueMetrics.deleteMany({
      where: { period: 'monthly', snapshotDate: { lt: cutoff } },
    });
    if (deleted.count > 0) {
      log.info(`Pruned ${deleted.count} monthly snapshots older than 365 days`);
    }
  } else if (period === 'alltime') {
    // For alltime: keep only the latest record per entityType+entityId
    // Step 1: find the latest snapshot ID for each entity
    const allAlltime = await prisma.iMValueMetrics.findMany({
      where: { period: 'alltime' },
      orderBy: { snapshotDate: 'desc' },
      select: { id: true, entityType: true, entityId: true, snapshotDate: true },
    });

    // Build set of IDs to keep (latest per entityType+entityId)
    const keepIds = new Set<number>();
    const seen = new Set<string>();
    for (const row of allAlltime) {
      const key = `${row.entityType}:${row.entityId}`;
      if (!seen.has(key)) {
        seen.add(key);
        keepIds.add(row.id);
      }
    }

    // Step 2: delete all alltime records not in the keep set
    const deleteIds = allAlltime.filter((r: any) => !keepIds.has(r.id)).map((r: any) => r.id);
    if (deleteIds.length > 0) {
      // Batch delete in chunks of 500 to avoid overly large IN clauses
      for (let i = 0; i < deleteIds.length; i += 500) {
        const chunk = deleteIds.slice(i, i + 500);
        await prisma.iMValueMetrics.deleteMany({
          where: { id: { in: chunk } },
        });
      }
      log.info(`Pruned ${deleteIds.length} stale alltime snapshots`);
    }
  }
}

// --- Global Aggregates (for Hero section) ---

export async function getGlobalValueStats(): Promise<{
  totalTokenSaved: number;
  totalMoneySaved: number;
  totalCo2Reduced: number;
  totalDevHoursSaved: number;
}> {
  const result = await prisma.iMValueMetrics.aggregate({
    where: { entityType: 'agent', period: 'alltime' },
    _sum: {
      tokenSaved: true,
      moneySaved: true,
      co2Reduced: true,
      devHoursSaved: true,
    },
  });

  return {
    totalTokenSaved: result._sum.tokenSaved || 0,
    totalMoneySaved: result._sum.moneySaved || 0,
    totalCo2Reduced: result._sum.co2Reduced || 0,
    totalDevHoursSaved: result._sum.devHoursSaved || 0,
  };
}

// --- Benchmark Data (for FOMO) ---

export async function getBenchmarkData(agentId?: string): Promise<{
  networkAvg: { tokenWastePerDay: number; moneyWastePerMonth: number; crashesAvoided7d: number };
  top10Avg: { errRate: number; tokenSavedPerDay: number; moneySavedPerMonth: number };
  userAgent?: {
    agentId: string;
    currentErr: number | null;
    estimatedWaste30d: number;
    potentialSaving: number;
  };
}> {
  // Network averages from baselines
  const baselines = await prisma.iMTokenBaseline.findMany();
  const avgWaste =
    baselines.length > 0 ? baselines.reduce((s: number, b: any) => s + b.avgTokensNoGene, 0) / baselines.length : 5000;
  const tokenWastePerDay = avgWaste * 10; // ~10 errors per day estimate
  const moneyWastePerMonth = ((tokenWastePerDay * 30) / 1000) * PRICE_PER_1K_TOKENS;

  // Top 10 from latest snapshot
  const top10 = await prisma.iMValueMetrics.findMany({
    where: { entityType: 'agent', period: 'weekly', rankByValue: { lte: 10 } },
    orderBy: { snapshotDate: 'desc' },
    take: 10,
  });
  const avgTop10Saved = top10.length > 0 ? top10.reduce((s: number, t: any) => s + t.tokenSaved, 0) / top10.length : 0;

  // Crashes avoided (from top 10 capsule counts)
  const top10Capsules = await prisma.iMEvolutionCapsule.count({
    where: {
      createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
      outcome: 'success',
      ownerAgentId: { in: top10.map((t: any) => t.entityId) },
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any = {
    networkAvg: {
      tokenWastePerDay: Math.round(tokenWastePerDay),
      moneyWastePerMonth: Math.round(moneyWastePerMonth * 100) / 100,
      crashesAvoided7d: top10Capsules,
    },
    top10Avg: {
      errRate: 0.58,
      tokenSavedPerDay: Math.round(avgTop10Saved / 7),
      moneySavedPerMonth: Math.round((((avgTop10Saved / 7) * 30) / 1000) * PRICE_PER_1K_TOKENS * 100) / 100,
    },
  };

  // User agent comparison if provided
  if (agentId) {
    const userMetrics = await prisma.iMValueMetrics.findFirst({
      where: { entityType: 'agent', entityId: agentId, period: 'weekly' },
      orderBy: { snapshotDate: 'desc' },
    });
    const edge = await prisma.iMEvolutionEdge.findMany({
      where: { ownerAgentId: agentId, scope: 'global' },
      select: { successCount: true, failureCount: true },
    });
    const totalS = edge.reduce((s: number, e: any) => s + e.successCount, 0);
    const totalF = edge.reduce((s: number, e: any) => s + e.failureCount, 0);
    const currentErr = totalS + totalF > 0 ? totalS / (totalS + totalF) : null;

    result.userAgent = {
      agentId,
      currentErr,
      estimatedWaste30d: moneyWastePerMonth - (userMetrics?.moneySaved || 0),
      potentialSaving: avgTop10Saved > 0 ? Math.min(0.73, avgTop10Saved / (avgTop10Saved + avgWaste * 30)) : 0.5,
    };
  }

  return result;
}
