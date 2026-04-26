/**
 * Evolution Sub-module: Metrics Collection
 *
 * collectMetrics() and all north-star indicator calculation logic,
 * getMetricsComparison().
 */

import prisma from '../db';

// ===== Metrics Collection (§8 North Star Indicators) =====

/**
 * Collect north-star metrics for a given time window and mode.
 * Writes a snapshot row to im_evolution_metrics.
 */
export async function collectMetrics(
  windowHours: number = 1,
  mode: 'standard' | 'hypergraph' = 'standard',
): Promise<{
  ssr: number | null;
  cs: number | null;
  rp: number | null;
  regp: number | null;
  gd: number | null;
  er: number | null;
  totalCapsules: number;
  successCapsules: number;
}> {
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);
  const windowLabel = windowHours <= 1 ? '1h' : windowHours <= 24 ? '24h' : '7d';

  // 1. Capsule counts
  const capsules = await prisma.iMEvolutionCapsule.findMany({
    where: { createdAt: { gte: since }, mode, scope: 'global', outcome: { in: ['success', 'failed'] } },
    select: { outcome: true, geneId: true, ownerAgentId: true },
  });
  const total = capsules.length;
  const success = capsules.filter((c: { outcome: string }) => c.outcome === 'success').length;
  const ssr = total > 0 ? success / total : null;

  // 2. Gene diversity (1 - HHI)
  const geneCounts = new Map<string, number>();
  for (const c of capsules) {
    geneCounts.set(c.geneId, (geneCounts.get(c.geneId) || 0) + 1);
  }
  let hhi = 0;
  if (total > 0) {
    for (const count of geneCounts.values()) {
      const share = count / total;
      hhi += share * share;
    }
  }
  const gd = total > 0 ? Math.round((1 - hhi) * 1000) / 1000 : null;

  // 3. Routing precision (capsules with coverage_level ≥ 1)
  const edges = await prisma.iMEvolutionEdge.findMany({
    where: { mode, scope: 'global', updatedAt: { gte: since } },
    select: { coverageLevel: true, successCount: true, failureCount: true },
  });
  const preciseEdges = edges.filter((e: { coverageLevel: number }) => e.coverageLevel >= 1).length;
  const rp = edges.length > 0 ? preciseEdges / edges.length : null;

  // 4. Exploration rate
  const allEdges = await prisma.iMEvolutionEdge.findMany({
    where: { mode, scope: 'global' },
    select: { successCount: true, failureCount: true },
  });
  const exploringCount = allEdges.filter(
    (e: { successCount: number; failureCount: number }) => e.successCount + e.failureCount < 10,
  ).length;
  const er = allEdges.length > 0 ? exploringCount / allEdges.length : null;

  // 5. Unique counts
  const uniqueGenes = geneCounts.size;
  const uniqueAgents = new Set(capsules.map((c: { ownerAgentId: string }) => c.ownerAgentId)).size;

  // 6. Convergence Speed (CS): capsules needed for an agent to reach SSR ≥ 0.7
  // Per-agent: count capsules from first to the point where running SSR crosses 0.7
  let cs: number | null = null;
  if (uniqueAgents > 0) {
    const agentIds = [...new Set(capsules.map((c: { ownerAgentId: string }) => c.ownerAgentId))];
    const speeds: number[] = [];
    for (const aid of agentIds.slice(0, 10)) {
      // Sample up to 10 agents for performance
      const agentCapsules = await prisma.iMEvolutionCapsule.findMany({
        where: { ownerAgentId: aid, mode, scope: 'global', outcome: { in: ['success', 'failed'] } },
        orderBy: { createdAt: 'asc' },
        select: { outcome: true },
        take: 200,
      });
      let running = 0;
      for (let i = 0; i < agentCapsules.length; i++) {
        if (agentCapsules[i].outcome === 'success') running++;
        const rate = running / (i + 1);
        if (rate >= 0.7 && i >= 4) {
          // min 5 capsules for statistical stability
          speeds.push(i + 1);
          break;
        }
      }
    }
    if (speeds.length > 0) {
      cs = Math.round(speeds.reduce((a, b) => a + b, 0) / speeds.length);
    }
  }

  // 7. Regret Proxy (RegP): 1 - (SSR_actual / SSR_oracle)
  // Oracle = per capsule, the best gene for that signalType historically
  let regp: number | null = null;
  if (total >= 20) {
    // Need enough data for oracle to be meaningful
    // Build oracle: best gene SSR per signalType
    const allEdgesForOracle = await prisma.iMEvolutionEdge.findMany({
      where: { mode, scope: 'global' },
      select: { signalType: true, geneId: true, successCount: true, failureCount: true },
    });
    const oracleBySignalType = new Map<string, number>();
    for (const e of allEdgesForOracle) {
      const st = e.signalType || 'unknown';
      const n = e.successCount + e.failureCount;
      if (n < 3) continue; // need minimum data
      const rate = e.successCount / n;
      if (rate > (oracleBySignalType.get(st) ?? 0)) {
        oracleBySignalType.set(st, rate);
      }
    }
    // Compute regret: for each failed capsule, if oracle gene would have succeeded
    const recentCapsules = await prisma.iMEvolutionCapsule.findMany({
      where: { createdAt: { gte: since }, mode, scope: 'global', outcome: { in: ['success', 'failed'] } },
      select: { outcome: true, signalKey: true, geneId: true },
      take: 500,
    });
    let regretSum = 0;
    let regretCount = 0;
    for (const c of recentCapsules) {
      const signalType = c.signalKey.split('|')[0]; // coarse type
      const oracleSSR = oracleBySignalType.get(signalType);
      if (oracleSSR !== undefined && c.outcome === 'failed') {
        regretSum += oracleSSR; // regret = oracle could have succeeded with this probability
      }
      regretCount++;
    }
    regp = regretCount > 0 ? Math.round((regretSum / regretCount) * 1000) / 1000 : null;
  }

  // Write snapshot
  await prisma.iMEvolutionMetrics.create({
    data: {
      window: windowLabel,
      mode,
      scope: 'global',
      ssr,
      cs,
      rp,
      regp,
      gd,
      er,
      totalCapsules: total,
      successCapsules: success,
      uniqueGenesUsed: uniqueGenes,
      uniqueAgents: uniqueAgents,
    },
  });

  return { ssr, cs, rp, regp, gd, er, totalCapsules: total, successCapsules: success };
}

/**
 * Get latest metrics comparison between modes.
 */
export async function getMetricsComparison(): Promise<{
  standard: Record<string, unknown> | null;
  hypergraph: Record<string, unknown> | null;
  verdict: string;
}> {
  const [std, hyper] = await Promise.all([
    prisma.iMEvolutionMetrics.findFirst({
      where: { mode: 'standard', scope: 'global' },
      orderBy: { ts: 'desc' },
    }),
    prisma.iMEvolutionMetrics.findFirst({
      where: { mode: 'hypergraph', scope: 'global' },
      orderBy: { ts: 'desc' },
    }),
  ]);

  let verdict = 'insufficient_data';
  if (std && hyper && std.totalCapsules >= 200 && hyper.totalCapsules >= 200) {
    if (hyper.ssr !== null && std.ssr !== null) {
      const delta = hyper.ssr - std.ssr;
      verdict = delta > 0.05 ? 'hypergraph_better' : delta < -0.05 ? 'standard_better' : 'no_significant_difference';
    }
  }

  return {
    standard: std as Record<string, unknown> | null,
    hypergraph: hyper as Record<string, unknown> | null,
    verdict,
  };
}
