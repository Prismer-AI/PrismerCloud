/**
 * Leaderboard Service
 *
 * Computes and stores weekly leaderboard snapshots for three boards:
 * 1. Agent Improvement — ranked by ERR (Error Reduction Rate)
 * 2. Gene Impact — ranked by adopters x avg outcome improvement
 * 3. Contributors — ranked by genes adopted by other agents
 *
 * Uses IM TaskScheduler cron for weekly aggregation.
 */

import prisma from '../db';
import { meetsAgentThreshold } from './anti-cheat.service';

// ===== Types =====

export interface AgentRanking {
  rank: number;
  agentId: string;
  agentName: string;
  ownerUsername: string;
  err: number | null;
  sessionCount: number;
  successRate: number | null;
  geneHitRate: number | null;
  trendData: number[];
  domain: string;
}

export interface GeneRanking {
  rank: number;
  geneId: string;
  geneName: string;
  adopters: number;
  avgImpact: number | null;
  geneCreatorId: string | null;
  domain: string;
}

export interface ContributorRanking {
  rank: number;
  agentId: string;
  agentName: string;
  ownerUsername: string;
  genesPublished: number;
  genesAdopted: number;
  agentsHelped: number;
  agentCount?: number;
}

// ===== Domain Classification =====

// Weighted domain classification: higher-weight keywords are more domain-specific
const DOMAIN_RULES: Record<string, Array<{ kw: string; weight: number }>> = {
  coding: [
    { kw: 'typescript', weight: 3 },
    { kw: 'build_failure', weight: 3 },
    { kw: 'test_failure', weight: 3 },
    { kw: 'compile', weight: 3 },
    { kw: 'lint', weight: 2 },
    { kw: 'syntax', weight: 2 },
    { kw: 'module_not_found', weight: 2 },
    { kw: 'prisma', weight: 2 },
    { kw: 'npm', weight: 2 },
    { kw: 'git', weight: 1 },
    { kw: 'import', weight: 1 },
    { kw: 'build', weight: 1 },
  ],
  research: [
    { kw: 'search', weight: 3 },
    { kw: 'content', weight: 2 },
    { kw: 'parse', weight: 2 },
    { kw: 'extract', weight: 2 },
    { kw: 'fetch', weight: 1 },
    { kw: 'http', weight: 1 },
    { kw: 'api', weight: 1 },
    { kw: 'scrape', weight: 3 },
  ],
  ops: [
    { kw: 'deploy_failure', weight: 3 },
    { kw: 'docker', weight: 3 },
    { kw: 'k8s', weight: 3 },
    { kw: 'pipeline', weight: 2 },
    { kw: 'infra', weight: 2 },
    { kw: 'nginx', weight: 2 },
    { kw: 'ci', weight: 1 },
    { kw: 'cd', weight: 1 },
    { kw: 'server', weight: 1 },
    { kw: 'deploy', weight: 2 },
  ],
};

function classifyDomain(signalKeys: string[]): string {
  const text = signalKeys.join(' ').toLowerCase();
  let bestDomain = 'general';
  let bestScore = 0;

  for (const [domain, rules] of Object.entries(DOMAIN_RULES)) {
    let score = 0;
    for (const { kw, weight } of rules) {
      if (text.includes(kw)) score += weight;
    }
    if (score > bestScore) {
      bestScore = score;
      bestDomain = domain;
    }
  }
  // Require minimum confidence (score >= 2) to classify, otherwise 'general'
  return bestScore >= 2 ? bestDomain : 'general';
}

// ===== Snapshot Computation =====

/**
 * Compute and store leaderboard snapshots for all three boards.
 * Called by IM TaskScheduler weekly cron.
 */
export async function computeLeaderboardSnapshot(
  period: 'weekly' | 'monthly' | 'alltime' = 'weekly',
): Promise<{ agents: number; genes: number; contributors: number }> {
  const since =
    period === 'weekly'
      ? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      : period === 'monthly'
        ? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
        : new Date(0);

  const now = new Date();

  type CapsuleRow = { ownerAgentId: string; outcome: string; geneId: string; signalKey: string; createdAt: Date };
  type EdgeRow = { ownerAgentId: string; geneId: string; successCount: number; failureCount: number };
  type CardRow = { imUserId: string; displayName: string | null };
  type UserRow = { imUserId: string; username: string };
  type GeneRow = { id: string; title: string; ownerAgentId: string | null; qualityScore: number; breakerState: string };

  // --- 1. Agent Improvement Board ---

  // Get all capsules in window
  const capsules: CapsuleRow[] = await prisma.iMEvolutionCapsule.findMany({
    where: { createdAt: { gte: since }, scope: 'global', outcome: { in: ['success', 'failed'] } },
    select: { ownerAgentId: true, outcome: true, geneId: true, signalKey: true, createdAt: true },
    take: 50000,
  });

  // Group by agent
  const agentMap = new Map<string, CapsuleRow[]>();
  for (const c of capsules) {
    const list = agentMap.get(c.ownerAgentId) || [];
    list.push(c);
    agentMap.set(c.ownerAgentId, list);
  }

  // Get all edges for ERR computation
  const edges: EdgeRow[] = await prisma.iMEvolutionEdge.findMany({
    where: { scope: 'global' },
    select: { ownerAgentId: true, geneId: true, successCount: true, failureCount: true },
  });

  // Batch-load all agent cards and users to avoid N+1 queries
  const allAgentIds = [...agentMap.keys()];
  const [agentCards, allUsers] = await Promise.all([
    prisma.iMAgentCard.findMany({
      where: { imUserId: { in: allAgentIds } },
      select: { imUserId: true, name: true },
    }),
    prisma.iMUser.findMany({
      where: { id: { in: allAgentIds } },
      select: { id: true, username: true },
    }),
  ]);
  const cardMap = new Map(
    (agentCards as any[]).map((c) => [c.imUserId, { imUserId: c.imUserId, displayName: c.name }]),
  );
  const userMap = new Map((allUsers as any[]).map((u) => [u.id, { imUserId: u.id, username: u.username }]));

  // Build edge lookup map for O(1) access instead of O(n) find()
  const edgeKey = (agentId: string, geneId: string) => `${agentId}:${geneId}`;
  const edgeLookup = new Map<string, EdgeRow>();
  for (const e of edges) {
    edgeLookup.set(edgeKey(e.ownerAgentId, e.geneId), e);
  }

  const candidateCount = agentMap.size;
  const agentRankings: AgentRanking[] = [];
  for (const [agentId, agentCapsules] of agentMap) {
    const distinctGenes = new Set(agentCapsules.map((c) => c.geneId).filter((g) => g && g !== 'none')).size;
    if (!meetsAgentThreshold(agentCapsules.length, distinctGenes, candidateCount)) continue;

    const successCount = agentCapsules.filter((c) => c.outcome === 'success').length;
    const successRate = successCount / agentCapsules.length;

    // ERR: compare capsules with prior edge data (>=3 history) vs without
    const withHistory = agentCapsules.filter((c) => {
      const edge = edgeLookup.get(edgeKey(agentId, c.geneId));
      return edge && edge.successCount + edge.failureCount >= 3;
    });
    const withoutHistory = agentCapsules.filter((c) => {
      const edge = edgeLookup.get(edgeKey(agentId, c.geneId));
      return !edge || edge.successCount + edge.failureCount < 3;
    });

    let err: number | null = null;
    if (withHistory.length >= 3 && withoutHistory.length >= 3) {
      const rateWith = withHistory.filter((c) => c.outcome === 'success').length / withHistory.length;
      const rateWithout = withoutHistory.filter((c) => c.outcome === 'success').length / withoutHistory.length;
      if (rateWithout > 0) {
        err = Math.round(((rateWith - rateWithout) / rateWithout) * 1000) / 1000;
      }
    }

    // Gene hit rate: capsules with a geneId that came from /analyze
    const withGene = agentCapsules.filter((c) => c.geneId && c.geneId !== 'none').length;
    const geneHitRate = withGene / agentCapsules.length;

    // Domain classification from signal keys
    const signalKeys = agentCapsules.map((c) => c.signalKey);
    const domain = classifyDomain(signalKeys);

    const card = cardMap.get(agentId);
    const user = userMap.get(agentId);

    agentRankings.push({
      rank: 0,
      agentId,
      agentName: card?.displayName || user?.username || agentId,
      ownerUsername: user?.username || '',
      err,
      sessionCount: agentCapsules.length,
      successRate: Math.round(successRate * 1000) / 1000,
      geneHitRate: Math.round(geneHitRate * 1000) / 1000,
      trendData: [], // filled below from prior snapshots
      domain,
    });
  }

  // Fill trendData from prior snapshots (last 4 weeks of ERR values)
  if (agentRankings.length > 0) {
    const trendAgentIds = agentRankings.map((a) => a.agentId);
    const priorSnapshots = await prisma.iMLeaderboardSnapshot.findMany({
      where: {
        boardType: 'agent',
        period,
        agentId: { in: trendAgentIds },
        snapshotDate: { lt: now },
      },
      orderBy: { snapshotDate: 'desc' },
      select: { agentId: true, err: true, snapshotDate: true },
      take: trendAgentIds.length * 4, // up to 4 prior weeks per agent
    });
    const trendMap = new Map<string, number[]>();
    for (const snap of priorSnapshots) {
      const arr = trendMap.get(snap.agentId) || [];
      if (arr.length < 4 && snap.err !== null) {
        arr.push(snap.err);
      }
      trendMap.set(snap.agentId, arr);
    }
    for (const a of agentRankings) {
      const prior = trendMap.get(a.agentId) || [];
      // prior is newest-first, reverse for chronological + append current
      const trend = [...prior.reverse()];
      if (a.err !== null) trend.push(a.err);
      a.trendData = trend;
    }
  }

  // Sort by ERR (highest first), then by session count
  agentRankings.sort((a, b) => {
    if (a.err !== null && b.err !== null) return b.err - a.err;
    if (a.err !== null) return -1;
    if (b.err !== null) return 1;
    return b.sessionCount - a.sessionCount;
  });
  agentRankings.forEach((a, i) => {
    a.rank = i + 1;
  });

  // --- 2. Gene Impact Board ---

  const geneMap = new Map<string, { capsules: CapsuleRow[]; adopters: Set<string> }>();
  for (const c of capsules) {
    if (!c.geneId || c.geneId === 'none') continue;
    const entry = geneMap.get(c.geneId) || { capsules: [], adopters: new Set() };
    entry.capsules.push(c);
    entry.adopters.add(c.ownerAgentId);
    geneMap.set(c.geneId, entry);
  }

  // Batch-load all genes to avoid N+1 in gene + contributor loops
  const allGeneIds = [...geneMap.keys()];
  const allGenes = await prisma.iMGene.findMany({
    where: { id: { in: allGeneIds } },
    select: { id: true, title: true, ownerAgentId: true, qualityScore: true, breakerState: true },
  });
  const geneLookup = new Map<string, GeneRow>((allGenes as GeneRow[]).map((g) => [g.id, g]));

  const geneRankings: GeneRanking[] = [];
  for (const [geneId, { capsules: geneCapsules, adopters }] of geneMap) {
    if (geneCapsules.length < 2) continue;
    const gene = geneLookup.get(geneId);
    if (!gene || gene.qualityScore < 0.3 || gene.breakerState === 'open') continue;

    const successRate = geneCapsules.filter((c) => c.outcome === 'success').length / geneCapsules.length;
    const signalKeys = geneCapsules.map((c) => c.signalKey);
    const domain = classifyDomain(signalKeys);

    geneRankings.push({
      rank: 0,
      geneId,
      geneName: gene?.title || geneId,
      adopters: adopters.size,
      avgImpact: Math.round(successRate * 1000) / 1000,
      geneCreatorId: gene?.ownerAgentId || null,
      domain,
    });
  }

  // Sort by adopters * avgImpact (impact score)
  geneRankings.sort((a, b) => {
    const scoreA = a.adopters * (a.avgImpact || 0);
    const scoreB = b.adopters * (b.avgImpact || 0);
    return scoreB - scoreA;
  });
  geneRankings.forEach((g, i) => {
    g.rank = i + 1;
  });

  // --- 3. Contributor Board (aggregated by HUMAN OWNER, not individual agent) ---

  // Step 1: Collect all gene creator agent IDs
  const creatorAgentIds = new Set<string>();
  for (const gene of allGenes as GeneRow[]) {
    if (gene.ownerAgentId) creatorAgentIds.add(gene.ownerAgentId);
  }

  // Step 2: Batch-load creator agents to find their human owner (userId)
  const creatorAgents =
    creatorAgentIds.size > 0
      ? await prisma.iMUser.findMany({
          where: { id: { in: [...creatorAgentIds] } },
          select: { id: true, username: true, displayName: true, userId: true, role: true },
        })
      : [];
  const agentToOwner = new Map<string, string>();
  for (const a of creatorAgents as any[]) {
    agentToOwner.set(a.id, a.userId || a.id);
  }

  // Step 3: Group contributions by human owner (userId)
  const ownerContribMap = new Map<
    string,
    {
      genesPublished: Set<string>;
      genesAdopted: Set<string>;
      agentsHelped: Set<string>;
      agentIds: Set<string>;
    }
  >();
  for (const [geneId, { adopters }] of geneMap) {
    const gene = geneLookup.get(geneId);
    if (!gene?.ownerAgentId) continue;
    const ownerId = agentToOwner.get(gene.ownerAgentId) || gene.ownerAgentId;
    const entry = ownerContribMap.get(ownerId) || {
      genesPublished: new Set(),
      genesAdopted: new Set(),
      agentsHelped: new Set(),
      agentIds: new Set(),
    };
    entry.genesPublished.add(geneId);
    entry.agentIds.add(gene.ownerAgentId);
    for (const adopterId of adopters) {
      const adopterOwner = agentToOwner.get(adopterId) || adopterId;
      if (adopterOwner !== ownerId) {
        entry.genesAdopted.add(`${geneId}:${adopterId}`);
        entry.agentsHelped.add(adopterId);
      }
    }
    ownerContribMap.set(ownerId, entry);
  }

  // Step 4: Resolve human owner display info
  const ownerIds = [...ownerContribMap.keys()];
  const humanUsers =
    ownerIds.length > 0
      ? await prisma.iMUser.findMany({
          where: { userId: { in: ownerIds }, role: 'human' },
          select: { id: true, username: true, displayName: true, userId: true },
        })
      : [];
  const ownerDisplayMap = new Map<string, { name: string; username: string; imUserId: string }>();
  for (const h of humanUsers as any[]) {
    if (h.userId)
      ownerDisplayMap.set(h.userId, { name: h.displayName || h.username, username: h.username, imUserId: h.id });
  }
  // Fallback: if no human record found, use the first agent's info
  for (const a of creatorAgents as any[]) {
    const ownerId = a.userId || a.id;
    if (!ownerDisplayMap.has(ownerId)) {
      ownerDisplayMap.set(ownerId, { name: a.displayName || a.username, username: a.username, imUserId: a.id });
    }
  }

  const contributorRankings: ContributorRanking[] = [];
  const contributorOwnedAgents = new Map<string, Set<string>>();
  for (const [ownerId, data] of ownerContribMap) {
    if (data.agentsHelped.size === 0) continue;

    const display = ownerDisplayMap.get(ownerId);
    const contribId = display?.imUserId || ownerId;

    contributorRankings.push({
      rank: 0,
      agentId: contribId,
      agentName: display?.name || ownerId,
      ownerUsername: display?.username || '',
      genesPublished: data.genesPublished.size,
      genesAdopted: data.genesAdopted.size,
      agentsHelped: data.agentsHelped.size,
      agentCount: data.agentIds.size,
    });
    contributorOwnedAgents.set(contribId, data.agentIds);
  }

  contributorRankings.sort((a, b) => b.agentsHelped - a.agentsHelped);
  contributorRankings.forEach((c, i) => {
    c.rank = i + 1;
  });

  // --- 4. Write snapshots to DB ---

  interface SnapshotInput {
    period: string;
    domain: string;
    snapshotDate: Date;
    boardType: string;
    agentId: string;
    agentName?: string;
    ownerUsername?: string;
    err?: number | null;
    sessionCount?: number;
    successRate?: number | null;
    geneHitRate?: number | null;
    trendData?: string;
    geneId?: string | null;
    geneName?: string;
    adopters?: number;
    avgImpact?: number | null;
    geneCreatorId?: string | null;
    genesPublished?: number;
    genesAdopted?: number;
    agentsHelped?: number;
    rank: number;
    tokenSaved?: number;
    moneySaved?: number;
    co2Reduced?: number;
    devHoursSaved?: number;
    percentile?: number | null;
    growthRate?: number | null;
    prevRank?: number | null;
  }

  // Load V2 value metrics for all ranked agents/creators
  const rankedAgentIds = agentRankings.slice(0, 100).map((a) => a.agentId);
  const rankedContributorIds = contributorRankings.slice(0, 100).map((c) => c.agentId);
  // P0 fix: include all agent IDs owned by contributors (value metrics keyed by agent ID, not human ID)
  const contribOwnedAgentIds = new Set<string>();
  for (const cId of rankedContributorIds) {
    const agIds = contributorOwnedAgents.get(cId);
    if (agIds) for (const id of agIds) contribOwnedAgentIds.add(id);
  }
  const allEntityIds = [...new Set([...rankedAgentIds, ...rankedContributorIds, ...contribOwnedAgentIds])];

  const valueMetrics =
    allEntityIds.length > 0
      ? await prisma.iMValueMetrics.findMany({
          where: { entityId: { in: allEntityIds }, period },
          orderBy: { snapshotDate: 'desc' },
          select: {
            entityId: true,
            entityType: true,
            tokenSaved: true,
            moneySaved: true,
            co2Reduced: true,
            devHoursSaved: true,
            percentile: true,
            growthRate: true,
          },
        })
      : [];

  const vmAgentMap = new Map<string, (typeof valueMetrics)[0]>();
  const vmCreatorMap = new Map<string, (typeof valueMetrics)[0]>();
  for (const vm of valueMetrics) {
    if (vm.entityType === 'agent' && !vmAgentMap.has(vm.entityId)) vmAgentMap.set(vm.entityId, vm);
    if (vm.entityType === 'creator' && !vmCreatorMap.has(vm.entityId)) vmCreatorMap.set(vm.entityId, vm);
  }

  // Load previous snapshots for prevRank (both agents and contributors)
  const [prevSnapshots, prevContribSnapshots] = await Promise.all([
    rankedAgentIds.length > 0
      ? prisma.iMLeaderboardSnapshot.findMany({
          where: { agentId: { in: rankedAgentIds }, boardType: 'agent', period },
          orderBy: { snapshotDate: 'desc' },
          distinct: ['agentId'],
          select: { agentId: true, rank: true },
        })
      : [],
    rankedContributorIds.length > 0
      ? prisma.iMLeaderboardSnapshot.findMany({
          where: { agentId: { in: rankedContributorIds }, boardType: 'contributor', period },
          orderBy: { snapshotDate: 'desc' },
          distinct: ['agentId'],
          select: { agentId: true, rank: true },
        })
      : [],
  ]);
  const prevRankMap = new Map<string, number>(prevSnapshots.map((s: any) => [s.agentId, s.rank]));
  const prevContribRankMap = new Map<string, number>(prevContribSnapshots.map((s: any) => [s.agentId, s.rank]));

  const rows: SnapshotInput[] = [];

  for (const a of agentRankings.slice(0, 100)) {
    const vm = vmAgentMap.get(a.agentId);
    const totalAgents = agentRankings.length;
    rows.push({
      period,
      domain: a.domain,
      snapshotDate: now,
      boardType: 'agent',
      agentId: a.agentId,
      agentName: a.agentName,
      ownerUsername: a.ownerUsername,
      err: a.err,
      sessionCount: a.sessionCount,
      successRate: a.successRate,
      geneHitRate: a.geneHitRate,
      trendData: JSON.stringify(a.trendData),
      rank: a.rank,
      tokenSaved: vm?.tokenSaved ?? 0,
      moneySaved: vm?.moneySaved ?? 0,
      co2Reduced: vm?.co2Reduced ?? 0,
      devHoursSaved: vm?.devHoursSaved ?? 0,
      percentile:
        vm?.percentile ?? (totalAgents > 0 ? Math.round(((totalAgents - a.rank + 1) / totalAgents) * 1000) / 10 : null),
      growthRate: vm?.growthRate ?? null,
      prevRank: prevRankMap.get(a.agentId) ?? null,
    });
  }

  for (const g of geneRankings.slice(0, 100)) {
    rows.push({
      period,
      domain: g.domain,
      snapshotDate: now,
      boardType: 'gene',
      agentId: '__gene__',
      geneId: g.geneId,
      geneName: g.geneName,
      adopters: g.adopters,
      avgImpact: g.avgImpact,
      geneCreatorId: g.geneCreatorId,
      rank: g.rank,
      trendData: '[]',
      tokenSaved: 0,
      moneySaved: 0,
      co2Reduced: 0,
      devHoursSaved: 0,
    });
  }

  for (const c of contributorRankings.slice(0, 100)) {
    // P0 fix: aggregate value metrics across all owned agent IDs (not human IM user ID)
    const ownedIds = contributorOwnedAgents.get(c.agentId);
    let cTokenSaved = 0,
      cMoneySaved = 0,
      cCo2Reduced = 0,
      cDevHoursSaved = 0;
    let cPercentile: number | null = null,
      cGrowthRate: number | null = null;
    if (ownedIds) {
      for (const agId of ownedIds) {
        const vm = vmCreatorMap.get(agId);
        if (vm) {
          cTokenSaved += vm.tokenSaved;
          cMoneySaved += vm.moneySaved;
          cCo2Reduced += vm.co2Reduced;
          cDevHoursSaved += vm.devHoursSaved;
          if (vm.percentile != null) cPercentile = Math.max(cPercentile ?? 0, vm.percentile);
          if (vm.growthRate != null) cGrowthRate = (cGrowthRate ?? 0) + vm.growthRate;
        }
      }
    }
    const totalContributors = contributorRankings.length;
    rows.push({
      period,
      domain: 'general',
      snapshotDate: now,
      boardType: 'contributor',
      agentId: c.agentId,
      agentName: c.agentName,
      ownerUsername: c.ownerUsername,
      genesPublished: c.genesPublished,
      genesAdopted: c.genesAdopted,
      agentsHelped: c.agentsHelped,
      rank: c.rank,
      trendData: '[]',
      tokenSaved: cTokenSaved,
      moneySaved: cMoneySaved,
      co2Reduced: cCo2Reduced,
      devHoursSaved: cDevHoursSaved,
      percentile:
        cPercentile ??
        (totalContributors > 0 ? Math.round(((totalContributors - c.rank + 1) / totalContributors) * 1000) / 10 : null),
      growthRate: cGrowthRate,
      prevRank: prevContribRankMap.get(c.agentId) ?? null,
    });
  }

  if (rows.length > 0) {
    // SnapshotInput matches the Prisma model shape; cast needed because Prisma
    // generates exact types that don't allow optional fields we intentionally omit per boardType
    await prisma.iMLeaderboardSnapshot.createMany({ data: rows as any[] });
  }

  // Cleanup: delete snapshots older than 90 days to prevent unbounded growth
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  try {
    const deleted = await prisma.iMLeaderboardSnapshot.deleteMany({
      where: { snapshotDate: { lt: cutoff } },
    });
    if (deleted.count > 0) {
      console.log(`[Leaderboard] Pruned ${deleted.count} snapshots older than 90 days`);
    }
  } catch {
    // Best-effort cleanup
  }

  console.log(
    `[Leaderboard] Snapshot computed: ${agentRankings.length} agents, ${geneRankings.length} genes, ${contributorRankings.length} contributors`,
  );

  return {
    agents: agentRankings.length,
    genes: geneRankings.length,
    contributors: contributorRankings.length,
  };
}

// ===== Query Functions (for API endpoints) =====

export async function getAgentLeaderboard(opts: {
  period?: string;
  domain?: string;
  limit?: number;
  offset?: number;
  sort?: string;
}): Promise<AgentRanking[]> {
  const { period = 'weekly', domain, limit = 50, offset = 0, sort } = opts;

  // Get latest snapshot date for this period
  const latest = await prisma.iMLeaderboardSnapshot.findFirst({
    where: { period, boardType: 'agent' },
    orderBy: { snapshotDate: 'desc' },
    select: { snapshotDate: true },
  });
  if (!latest) return [];

  const where: Record<string, unknown> = {
    period,
    boardType: 'agent',
    snapshotDate: latest.snapshotDate,
  };
  if (domain && domain !== 'all') where.domain = domain;

  const agentSortMap: Record<string, Record<string, 'asc' | 'desc'>> = {
    value: { moneySaved: 'desc' },
    success: { successRate: 'desc' },
    growth: { growthRate: 'desc' },
    sessions: { sessionCount: 'desc' },
  };
  const orderBy = sort && agentSortMap[sort] ? agentSortMap[sort] : { rank: 'asc' };

  const rows = await prisma.iMLeaderboardSnapshot.findMany({
    where,
    orderBy,
    skip: offset,
    take: limit,
  });

  // Load badges for all agents in one query
  const agentIds = rows.map((r: any) => r.agentId).filter((id: string) => id && id !== '__gene__');
  const achievements =
    agentIds.length > 0
      ? await prisma.iMEvolutionAchievement.findMany({
          where: { agentId: { in: agentIds } },
          select: { agentId: true, badgeKey: true },
        })
      : [];
  const badgeMap = new Map<string, string[]>();
  for (const a of achievements as any[]) {
    const list = badgeMap.get(a.agentId) || [];
    list.push(a.badgeKey);
    badgeMap.set(a.agentId, list);
  }

  return rows.map((r: any) => ({
    rank: r.rank,
    prevRank: r.prevRank ?? null,
    rankChange: r.prevRank != null ? r.prevRank - r.rank : null,
    agentId: r.agentId,
    agentName: r.agentName,
    ownerUsername: r.ownerUsername,
    err: r.err,
    sessionCount: r.sessionCount,
    successRate: r.successRate,
    geneHitRate: r.geneHitRate,
    trendData: JSON.parse(r.trendData || '[]'),
    domain: r.domain,
    value: {
      tokenSaved: r.tokenSaved || 0,
      moneySaved: r.moneySaved || 0,
      co2Reduced: r.co2Reduced || 0,
      devHoursSaved: r.devHoursSaved || 0,
    },
    badges: badgeMap.get(r.agentId) || [],
    percentile: r.percentile ?? null,
    growthRate: r.growthRate ?? null,
  }));
}

/**
 * Single agent row for Workspace /profile: no list limit — picks best rank if multiple domain rows exist.
 * If absent from snapshot (e.g. below top-100 or anti-cheat filtered), falls back to value_metrics + card when available.
 */
export async function getAgentLeaderboardEntry(
  agentId: string,
  opts: { period?: string; domain?: string } = {},
): Promise<{
  rank: number | null;
  prevRank: number | null;
  rankChange: number | null;
  agentId: string;
  agentName: string;
  ownerUsername: string;
  err: number | null;
  sessionCount: number;
  successRate: number | null;
  geneHitRate: number | null;
  trendData: number[];
  domain: string;
  value: { tokenSaved: number; moneySaved: number; co2Reduced: number; devHoursSaved: number };
  badges: string[];
  percentile: number | null;
  growthRate: number | null;
} | null> {
  const period = opts.period || 'weekly';
  const domain = opts.domain;

  const achievements = await prisma.iMEvolutionAchievement.findMany({
    where: { agentId },
    select: { badgeKey: true },
  });
  const badges = (achievements as { badgeKey: string }[]).map((a) => a.badgeKey);

  const latest = await prisma.iMLeaderboardSnapshot.findFirst({
    where: { period, boardType: 'agent' },
    orderBy: { snapshotDate: 'desc' },
    select: { snapshotDate: true },
  });

  if (latest) {
    const where: Record<string, unknown> = {
      period,
      boardType: 'agent',
      snapshotDate: latest.snapshotDate,
      agentId,
    };
    if (domain && domain !== 'all') where.domain = domain;

    const rows = await prisma.iMLeaderboardSnapshot.findMany({ where });
    if (rows.length > 0) {
      const r = rows.reduce((best: any, cur: any) => (cur.rank < best.rank ? cur : best));
      return {
        rank: r.rank,
        prevRank: r.prevRank ?? null,
        rankChange: r.prevRank != null ? r.prevRank - r.rank : null,
        agentId: r.agentId,
        agentName: r.agentName,
        ownerUsername: r.ownerUsername,
        err: r.err,
        sessionCount: r.sessionCount,
        successRate: r.successRate,
        geneHitRate: r.geneHitRate,
        trendData: JSON.parse(r.trendData || '[]'),
        domain: r.domain,
        value: {
          tokenSaved: r.tokenSaved || 0,
          moneySaved: r.moneySaved || 0,
          co2Reduced: r.co2Reduced || 0,
          devHoursSaved: r.devHoursSaved || 0,
        },
        badges,
        percentile: r.percentile ?? null,
        growthRate: r.growthRate ?? null,
      };
    }
  }

  const vm = await prisma.iMValueMetrics.findFirst({
    where: { entityId: agentId, entityType: 'agent', period },
    orderBy: { snapshotDate: 'desc' },
    select: {
      tokenSaved: true,
      moneySaved: true,
      co2Reduced: true,
      devHoursSaved: true,
      percentile: true,
      growthRate: true,
    },
  });
  const [card, user] = await Promise.all([
    prisma.iMAgentCard.findFirst({
      where: { imUserId: agentId },
      select: { name: true },
    }),
    prisma.iMUser.findUnique({
      where: { id: agentId },
      select: { username: true },
    }),
  ]);

  if (!vm && !card && !user && badges.length === 0) return null;

  return {
    rank: null,
    prevRank: null,
    rankChange: null,
    agentId,
    agentName: (card as { name: string } | null)?.name || (user as { username: string } | null)?.username || agentId,
    ownerUsername: (user as { username: string } | null)?.username || '',
    err: null,
    sessionCount: 0,
    successRate: null,
    geneHitRate: null,
    trendData: [],
    domain: 'general',
    value: {
      tokenSaved: vm?.tokenSaved ?? 0,
      moneySaved: vm?.moneySaved ?? 0,
      co2Reduced: vm?.co2Reduced ?? 0,
      devHoursSaved: vm?.devHoursSaved ?? 0,
    },
    badges,
    percentile: vm?.percentile ?? null,
    growthRate: vm?.growthRate ?? null,
  };
}

export async function getGeneLeaderboard(opts: {
  period?: string;
  domain?: string;
  limit?: number;
  sort?: 'impact' | 'adopters';
}): Promise<GeneRanking[]> {
  const { period = 'weekly', domain, limit = 50, sort = 'impact' } = opts;

  const latest = await prisma.iMLeaderboardSnapshot.findFirst({
    where: { period, boardType: 'gene' },
    orderBy: { snapshotDate: 'desc' },
    select: { snapshotDate: true },
  });
  if (!latest) return [];

  const where: Record<string, unknown> = {
    period,
    boardType: 'gene',
    snapshotDate: latest.snapshotDate,
  };
  if (domain && domain !== 'all') where.domain = domain;

  const rows = await prisma.iMLeaderboardSnapshot.findMany({
    where,
    orderBy: sort === 'adopters' ? { adopters: 'desc' } : { rank: 'asc' },
    take: limit,
  });

  return rows.map((r: any) => ({
    rank: r.rank,
    geneId: r.geneId || '',
    geneName: r.geneName,
    adopters: r.adopters,
    avgImpact: r.avgImpact,
    geneCreatorId: r.geneCreatorId,
    domain: r.domain,
  }));
}

export async function getContributorLeaderboard(opts: {
  period?: string;
  limit?: number;
  sort?: string;
}): Promise<ContributorRanking[]> {
  const { period = 'weekly', limit = 50, sort } = opts;

  const latest = await prisma.iMLeaderboardSnapshot.findFirst({
    where: { period, boardType: 'contributor' },
    orderBy: { snapshotDate: 'desc' },
    select: { snapshotDate: true },
  });
  if (!latest) return [];

  const contribSortMap: Record<string, Record<string, 'asc' | 'desc'>> = {
    value: { moneySaved: 'desc' },
    published: { genesPublished: 'desc' },
    adopted: { genesAdopted: 'desc' },
  };
  const contribOrderBy = sort && contribSortMap[sort] ? contribSortMap[sort] : { rank: 'asc' };

  const rows = await prisma.iMLeaderboardSnapshot.findMany({
    where: {
      period,
      boardType: 'contributor',
      snapshotDate: latest.snapshotDate,
    },
    orderBy: contribOrderBy,
    take: limit,
  });

  // Enrich with agent count per owner
  const ownerImUserIds = rows.map((r: any) => r.agentId).filter(Boolean);
  const ownerUsers =
    ownerImUserIds.length > 0
      ? await prisma.iMUser.findMany({
          where: { id: { in: ownerImUserIds } },
          select: { id: true, userId: true },
        })
      : [];
  const ownerCloudIds = [...new Set((ownerUsers as any[]).map((u) => u.userId).filter(Boolean))];
  const agentCounts =
    ownerCloudIds.length > 0
      ? await prisma.iMUser.groupBy({
          by: ['userId'],
          where: { userId: { in: ownerCloudIds }, role: 'agent' },
          _count: { id: true },
        })
      : [];
  const countByCloudId = new Map<string, number>((agentCounts as any[]).map((g) => [g.userId, g._count.id]));
  const countByImUserId = new Map<string, number>();
  for (const u of ownerUsers as any[]) {
    if (u.userId) countByImUserId.set(u.id, countByCloudId.get(u.userId) || 0);
  }

  return rows.map((r: any) => ({
    rank: r.rank,
    prevRank: r.prevRank ?? null,
    rankChange: r.prevRank != null ? r.prevRank - r.rank : null,
    agentId: r.agentId,
    agentName: r.agentName,
    ownerUsername: r.ownerUsername,
    genesPublished: r.genesPublished,
    genesAdopted: r.genesAdopted,
    agentsHelped: r.agentsHelped,
    agentCount: countByImUserId.get(r.agentId) || undefined,
    value: {
      tokenSaved: r.tokenSaved || 0,
      moneySaved: r.moneySaved || 0,
      co2Reduced: r.co2Reduced || 0,
    },
    topGene: null,
    percentile: r.percentile ?? null,
  }));
}

/**
 * Get leaderboard summary stats for the hero section.
 */
export async function getLeaderboardStats(): Promise<{
  totalAgentsEvolving: number;
  avgErr: number | null;
  totalGeneTransfers: number;
}> {
  const [agentCount, capsuleStats, geneTransfers] = await Promise.all([
    prisma.iMEvolutionCapsule
      .groupBy({
        by: ['ownerAgentId'],
        where: { scope: 'global', outcome: { in: ['success', 'failed'] } },
      })
      .then((r: Array<{ ownerAgentId: string }>) => r.length)
      .catch(() => 0),

    prisma.iMEvolutionMetrics.findFirst({
      where: { scope: 'global' },
      orderBy: { ts: 'desc' },
      select: { errApprox: true },
    }),

    // Count cross-agent gene usages: capsules where agent != gene creator
    // Uses groupBy to get distinct (geneId, ownerAgentId) pairs, then filters
    (async () => {
      try {
        const pairs = await prisma.iMEvolutionCapsule.groupBy({
          by: ['geneId', 'ownerAgentId'],
          where: { scope: 'global', outcome: { in: ['success', 'failed'] } },
          _count: true,
        });
        // Load gene ownership to check cross-agent
        type PairRow = { geneId: string; ownerAgentId: string; _count: number };
        const geneIds = [...new Set((pairs as PairRow[]).map((p) => p.geneId))];
        const genes = await prisma.iMGene.findMany({
          where: { id: { in: geneIds } },
          select: { id: true, ownerAgentId: true },
        });
        const geneOwnerMap = new Map(
          (genes as { id: string; ownerAgentId: string | null }[]).map((g) => [g.id, g.ownerAgentId]),
        );
        return (pairs as PairRow[]).filter((p) => {
          const owner = geneOwnerMap.get(p.geneId);
          return owner && owner !== p.ownerAgentId;
        }).length;
      } catch {
        return 0;
      }
    })(),
  ]);

  return {
    totalAgentsEvolving: agentCount,
    avgErr: capsuleStats?.errApprox ?? null,
    totalGeneTransfers: geneTransfers,
  };
}

/**
 * Hero section stats combining global value metrics with network stats.
 */
export async function getLeaderboardHero(): Promise<{
  global: { totalTokenSaved: number; totalMoneySaved: number; totalCo2Reduced: number; totalDevHoursSaved: number };
  network: { totalAgentsEvolving: number; totalGenesPublished: number; totalGeneTransfers: number };
  period: { label: string; weeklyGrowth: number | null };
}> {
  const { getGlobalValueStats } = await import('./value-metrics.service');
  const globalValues = await getGlobalValueStats();
  const networkStats = await getLeaderboardStats();

  const now = new Date();
  const weekNum = Math.ceil((now.getTime() - new Date(now.getFullYear(), 0, 1).getTime()) / (7 * 24 * 60 * 60 * 1000));

  // Compute weeklyGrowth: compare this week's moneySaved to last week's
  let weeklyGrowth: number | null = null;
  try {
    const thisWeekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const lastWeekStart = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    const [thisWeekCapsules, lastWeekCapsules] = await Promise.all([
      prisma.iMEvolutionCapsule.count({
        where: { createdAt: { gte: thisWeekStart }, outcome: 'success', scope: 'global' },
      }),
      prisma.iMEvolutionCapsule.count({
        where: { createdAt: { gte: lastWeekStart, lt: thisWeekStart }, outcome: 'success', scope: 'global' },
      }),
    ]);
    if (lastWeekCapsules > 0) {
      weeklyGrowth = Math.round(((thisWeekCapsules - lastWeekCapsules) / lastWeekCapsules) * 1000) / 10;
    }
  } catch {
    /* non-critical */
  }

  return {
    global: globalValues,
    network: {
      totalAgentsEvolving: networkStats.totalAgentsEvolving,
      totalGenesPublished: await prisma.iMGene.count({ where: { visibility: 'published' } }).catch(() => 0),
      totalGeneTransfers: networkStats.totalGeneTransfers,
    },
    period: {
      label: `Week ${weekNum}, ${now.getFullYear()}`,
      weeklyGrowth,
    },
  };
}

/**
 * Rising leaderboard: agents with highest growth rate.
 */
export async function getRisingLeaderboard(limit = 20): Promise<
  Array<{
    rank: number;
    entityType: string;
    entityId: string;
    entityName: string;
    ownerUsername: string;
    growthRate: number;
    currentValue: number;
    trend: number[];
    daysActive: number;
  }>
> {
  const latest = await prisma.iMValueMetrics.findMany({
    where: { period: 'weekly', growthRate: { not: null } },
    orderBy: { snapshotDate: 'desc' },
    take: 500,
  });

  const seen = new Set<string>();
  const unique = latest.filter((m: any) => {
    const key = `${m.entityType}:${m.entityId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return m.growthRate !== null && m.growthRate > 0;
  });

  unique.sort((a: any, b: any) => (b.growthRate || 0) - (a.growthRate || 0));

  const entityIds = unique.slice(0, limit).map((m: any) => m.entityId);
  const [cards, userRecords] = await Promise.all([
    prisma.iMAgentCard.findMany({
      where: { imUserId: { in: entityIds } },
      select: { imUserId: true, name: true },
    }),
    prisma.iMUser.findMany({
      where: { id: { in: entityIds } },
      select: { id: true, username: true },
    }),
  ]);
  const nameMap = new Map<string, string>();
  for (const c of cards as any[]) nameMap.set(c.imUserId, c.name);
  for (const u of userRecords as any[]) if (!nameMap.has(u.id)) nameMap.set(u.id, u.username);
  const userMap2 = new Map<string, string>((userRecords as any[]).map((u: any) => [u.id, u.username]));

  // Load prior value metrics snapshots for trend data
  const risingEntityIds = unique.slice(0, limit).map((m: any) => m.entityId);
  const priorMetrics =
    risingEntityIds.length > 0
      ? await prisma.iMValueMetrics.findMany({
          where: { entityId: { in: risingEntityIds }, period: 'weekly' },
          orderBy: { snapshotDate: 'desc' },
          take: risingEntityIds.length * 8,
          select: { entityId: true, moneySaved: true },
        })
      : [];
  const trendByEntity = new Map<string, number[]>();
  for (const pm of priorMetrics as any[]) {
    const arr = trendByEntity.get(pm.entityId) || [];
    if (arr.length < 8) arr.push(pm.moneySaved);
    trendByEntity.set(pm.entityId, arr);
  }

  // Compute daysActive from first capsule per entity
  const firstCapsules =
    risingEntityIds.length > 0
      ? await prisma.iMEvolutionCapsule.findMany({
          where: { ownerAgentId: { in: risingEntityIds } },
          orderBy: { createdAt: 'asc' },
          distinct: ['ownerAgentId'],
          select: { ownerAgentId: true, createdAt: true },
        })
      : [];
  const firstSeenMap = new Map<string, Date>((firstCapsules as any[]).map((c: any) => [c.ownerAgentId, c.createdAt]));

  return unique.slice(0, limit).map((m: any, i: number) => {
    const firstSeen = firstSeenMap.get(m.entityId);
    const daysActive = firstSeen
      ? Math.max(1, Math.ceil((Date.now() - firstSeen.getTime()) / (24 * 60 * 60 * 1000)))
      : 7;
    return {
      rank: i + 1,
      entityType: m.entityType,
      entityId: m.entityId,
      entitySlug: userMap2.get(m.entityId) || m.entityId,
      entityName: nameMap.get(m.entityId) || m.entityId,
      ownerUsername: userMap2.get(m.entityId) || '',
      growthRate: m.growthRate || 0,
      currentValue: m.moneySaved,
      trend: (trendByEntity.get(m.entityId) || []).reverse(),
      daysActive,
    };
  });
}
