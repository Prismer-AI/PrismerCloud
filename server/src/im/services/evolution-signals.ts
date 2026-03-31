/**
 * Evolution Sub-module: Signal Helpers
 *
 * Signal normalization, matching, coverage scoring, overlap,
 * unmatched signal tracking, and signal clustering.
 */

import prisma from '../db';
import type { SignalTag } from '../types/index';

// ─── Signal Tag Helpers ──────────────────────────────────────

/**
 * Normalize signals input to SignalTag[] (backward compat).
 * string[] → [{ type: s }]; SignalTag[] → pass-through.
 */
export function normalizeSignals(input: string[] | SignalTag[]): SignalTag[] {
  if (input.length === 0) return [];
  if (typeof input[0] === 'string') {
    return (input as string[]).map((s) => ({ type: s }));
  }
  return input as SignalTag[];
}

/**
 * matchesPattern: check if all defined pattern fields match the tag exactly.
 */
export function matchesPattern(tag: SignalTag, pattern: SignalTag): boolean {
  return Object.entries(pattern).every(([k, v]) => v === undefined || tag[k] === v);
}

/**
 * tagCoverageScore: Three-layer signal matching.
 *
 * Layer 1 (Exact):   type field exact match + multi-field ratio → [0.33, 1.0]
 * Layer 2 (Prefix):  same category prefix (error: ↔ error:) → 0.4 + context bonus
 * Layer 3 (Semantic): reserved for async LLM similarity (via semanticCache param)
 *
 * Returns { score: [0,1], layer: 'exact'|'prefix'|'semantic'|'none' }
 */
export function tagCoverageScore(
  eventTags: SignalTag[],
  geneSignalsMatch: SignalTag[],
  semanticCache?: Map<string, number>, // Optional: signal-pair → similarity cache from LLM
): number {
  return tagCoverageScoreDetailed(eventTags, geneSignalsMatch, semanticCache).score;
}

export interface CoverageDetail {
  score: number;
  layer: 'exact' | 'prefix' | 'semantic' | 'none';
}

export function tagCoverageScoreDetailed(
  eventTags: SignalTag[],
  geneSignalsMatch: SignalTag[],
  semanticCache?: Map<string, number>,
): CoverageDetail {
  if (eventTags.length === 0 || geneSignalsMatch.length === 0) return { score: 0, layer: 'none' };

  let totalScore = 0;
  let hasExact = false;
  let hasPrefix = false;
  let hasSemantic = false;

  for (const eventTag of eventTags) {
    let bestScore = 0;

    for (const pattern of geneSignalsMatch) {
      // Layer 1: exact field match (existing behavior)
      if (matchesPattern(eventTag, pattern)) {
        const matchedKeys = Object.keys(pattern).filter((k) => pattern[k] !== undefined).length;
        const totalKeys = Object.keys(eventTag).filter((k) => eventTag[k] !== undefined).length;
        const exactScore = matchedKeys / Math.max(totalKeys, 1);
        if (exactScore > bestScore) {
          bestScore = exactScore;
          hasExact = true;
        }
        continue;
      }

      // Layer 2: prefix/category match
      const eventCategory = eventTag.type.split(':')[0];
      const patternCategory = pattern.type.split(':')[0];
      if (eventCategory && patternCategory && eventCategory === patternCategory) {
        let prefixScore = 0.4; // Same category base score
        // Context dimension bonuses
        if (eventTag.provider && pattern.provider && eventTag.provider === pattern.provider) prefixScore += 0.1;
        if (eventTag.stage && pattern.stage && eventTag.stage === pattern.stage) prefixScore += 0.1;
        if (eventTag.severity && pattern.severity && eventTag.severity === pattern.severity) prefixScore += 0.05;
        if (prefixScore > bestScore) {
          bestScore = prefixScore;
          hasPrefix = true;
        }
      }

      // Layer 3: semantic similarity from LLM cache
      if (semanticCache) {
        const pairKey = [eventTag.type, pattern.type].sort().join('↔');
        const sim = semanticCache.get(pairKey);
        if (sim !== undefined && sim > bestScore) {
          bestScore = sim;
          hasSemantic = true;
        }
      }
    }
    totalScore += bestScore;
  }

  const score = totalScore / eventTags.length;
  const layer = hasExact ? 'exact' : hasPrefix ? 'prefix' : hasSemantic ? 'semantic' : 'none';
  return { score, layer };
}

/**
 * Compute a deterministic signal key from a set of signals.
 * Accepts string[] (old format) or SignalTag[] (v0.3.0).
 * Key is derived from the `type` field of each tag — sorted and pipe-delimited.
 * This ensures backward compat: "error:500" (string) and {type:"error:500"} (tag) → same key.
 */
export function computeSignalKey(signals: string[] | SignalTag[]): string {
  const tags = normalizeSignals(signals as string[] | SignalTag[]);
  return Array.from(new Set(tags.map((t) => t.type)))
    .sort()
    .join('|');
}

/**
 * Extract the coarse signal_type from a set of signals (first tag's type).
 * Used as the key for cross-granularity global prior aggregation (§4.2).
 */
export function extractSignalType(signals: SignalTag[]): string | null {
  return signals.length > 0 ? signals[0].type : null;
}

/**
 * Compute overlap between two pipe-delimited signal keys (for edge matching).
 */
export function signalOverlap(keyA: string, keyB: string): number {
  const partsA = keyA.split('|');
  const setB = new Set(keyB.split('|'));
  let overlap = 0;
  partsA.forEach((s) => {
    if (setB.has(s)) overlap++;
  });
  return overlap;
}

// ===== Unmatched Signal Tracking =====

/**
 * Track signals that had no matching gene — the "evolution frontier".
 * Upserts: increments count if same signal+agent combo exists.
 * v0.3.0: signalKey uses signal_type level (coarse, anti-fragmentation §4.5).
 */
export async function trackUnmatchedSignals(
  signals: string[] | SignalTag[],
  agentId: string,
  scope = 'global',
): Promise<void> {
  const tags = normalizeSignals(signals as string[] | SignalTag[]);
  // Signal key at signal_type level (no provider/stage): anti-fragmentation (§4.5)
  const signalKey = Array.from(new Set(tags.map((t) => t.type)))
    .sort()
    .join('|');
  try {
    await prisma.iMUnmatchedSignal.upsert({
      where: { signalKey_agentId_scope: { signalKey, agentId, scope } },
      update: {
        count: { increment: 1 },
        updatedAt: new Date(),
        // Update signalTags if new format
        ...(tags.some((t) => Object.keys(t).length > 1) && {
          signalTags: JSON.stringify(tags),
        }),
      },
      create: {
        signalKey,
        signals: JSON.stringify(tags.map((t) => t.type)), // compat: store type strings
        signalTags: JSON.stringify(tags),
        agentId,
        count: 1,
        scope,
      },
    });
  } catch (err) {
    // Non-critical — don't fail the analyze request
    console.error('[Evolution] Failed to track unmatched signal:', err);
  }
}

/**
 * Get unmatched signals — the evolution frontier.
 * Returns signals sorted by frequency (most demanded first).
 */
export async function getUnmatchedSignals(limit = 20): Promise<
  Array<{
    signalKey: string;
    signals: string[];
    totalCount: number;
    agentCount: number;
    firstSeen: string;
    lastSeen: string;
  }>
> {
  // Aggregate across all agents
  const raw = await prisma.iMUnmatchedSignal.findMany({
    where: { resolvedBy: null },
    orderBy: { count: 'desc' },
    take: limit * 5, // fetch more, then aggregate
  });

  // Group by signalKey across agents
  const grouped = new Map<
    string,
    { signals: string[]; totalCount: number; agents: Set<string>; firstSeen: Date; lastSeen: Date }
  >();
  for (const r of raw) {
    const existing = grouped.get(r.signalKey);
    if (existing) {
      existing.totalCount += r.count;
      existing.agents.add(r.agentId);
      if (r.createdAt < existing.firstSeen) existing.firstSeen = r.createdAt;
      if (r.updatedAt > existing.lastSeen) existing.lastSeen = r.updatedAt;
    } else {
      grouped.set(r.signalKey, {
        signals: JSON.parse(r.signals || '[]'),
        totalCount: r.count,
        agents: new Set([r.agentId]),
        firstSeen: r.createdAt,
        lastSeen: r.updatedAt,
      });
    }
  }

  return Array.from(grouped.entries())
    .sort((a, b) => b[1].totalCount - a[1].totalCount)
    .slice(0, limit)
    .map(([signalKey, info]) => ({
      signalKey,
      signals: info.signals,
      totalCount: info.totalCount,
      agentCount: info.agents.size,
      firstSeen: info.firstSeen.toISOString(),
      lastSeen: info.lastSeen.toISOString(),
    }));
}

/**
 * Mark an unmatched signal as resolved (a gene was created for it).
 */
export async function resolveUnmatchedSignal(signalKey: string, geneId: string): Promise<void> {
  await prisma.iMUnmatchedSignal.updateMany({
    where: { signalKey, resolvedBy: null },
    data: { resolvedBy: geneId },
  });
}

// ===== Signal Clustering =====

/**
 * Compute signal clusters from co-occurrence in recent capsules.
 * Called by SchedulerService every hour.
 *
 * Algorithm:
 * 1. Fetch all capsules from last 24h with their triggerSignals
 * 2. Build co-occurrence matrix for signal pairs
 * 3. Union-Find clustering on pairs with co-occurrence rate > 0.5
 * 4. For each cluster, find the most successful gene
 * 5. Upsert into im_signal_clusters
 */
export async function computeSignalClusters(): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const capsules = await prisma.iMEvolutionCapsule.findMany({
    where: { createdAt: { gte: since }, outcome: { in: ['success', 'failed'] } },
    select: { triggerSignals: true, geneId: true, outcome: true, ownerAgentId: true },
    take: 1000,
  });

  if (capsules.length < 5) return 0; // Not enough data

  // 1. Extract signal sets per capsule
  const capsuleSignals: Array<{ signals: string[]; geneId: string; outcome: string; agentId: string }> = [];
  for (const c of capsules) {
    try {
      const signals = JSON.parse(c.triggerSignals || '[]') as string[];
      if (signals.length > 0) {
        capsuleSignals.push({ signals, geneId: c.geneId, outcome: c.outcome, agentId: c.ownerAgentId });
      }
    } catch {
      /* skip */
    }
  }

  // 2. Build co-occurrence counts
  const pairCount = new Map<string, number>(); // "a↔b" → count
  const signalCount = new Map<string, number>(); // "a" → total appearances
  const signalAgents = new Map<string, Set<string>>(); // "a" → distinct agents

  for (const cap of capsuleSignals) {
    const unique = [...new Set(cap.signals)];
    for (const s of unique) {
      signalCount.set(s, (signalCount.get(s) || 0) + 1);
      if (!signalAgents.has(s)) signalAgents.set(s, new Set());
      signalAgents.get(s)!.add(cap.agentId);
    }
    // Pairs
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        const key = [unique[i], unique[j]].sort().join('↔');
        pairCount.set(key, (pairCount.get(key) || 0) + 1);
      }
    }
  }

  // 3. Union-Find clustering (signals that co-occur > 50% of the time)
  const parent = new Map<string, string>();
  function find(x: string): string {
    if (!parent.has(x)) parent.set(x, x);
    if (parent.get(x) !== x) parent.set(x, find(parent.get(x)!));
    return parent.get(x)!;
  }
  function union(a: string, b: string): void {
    const ra = find(a),
      rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  for (const [pair, count] of pairCount) {
    const [a, b] = pair.split('↔');
    const minAppearances = Math.min(signalCount.get(a) || 0, signalCount.get(b) || 0);
    if (minAppearances >= 3 && count / minAppearances >= 0.5) {
      union(a, b);
    }
  }

  // 4. Collect clusters
  const clusters = new Map<string, Set<string>>();
  for (const signal of signalCount.keys()) {
    const root = find(signal);
    if (!clusters.has(root)) clusters.set(root, new Set());
    clusters.get(root)!.add(signal);
  }

  // 5. For each cluster, find the best gene
  let upserted = 0;
  for (const [, members] of clusters) {
    if (members.size < 2) continue; // Singleton — not a cluster

    const memberArray = [...members].sort();
    const clusterKey = generateClusterKey(memberArray);

    // Count frequency and agents
    let freq = 0;
    const agents = new Set<string>();
    for (const cap of capsuleSignals) {
      if (cap.signals.some((s) => members.has(s))) {
        freq++;
        agents.add(cap.agentId);
      }
    }

    // Find top gene (highest success rate for this cluster's signals)
    const geneStats = new Map<string, { success: number; total: number }>();
    for (const cap of capsuleSignals) {
      if (cap.signals.some((s) => members.has(s))) {
        const gs = geneStats.get(cap.geneId) || { success: 0, total: 0 };
        gs.total++;
        if (cap.outcome === 'success') gs.success++;
        geneStats.set(cap.geneId, gs);
      }
    }
    let topGeneId: string | null = null;
    let topGeneRate: number | null = null;
    for (const [gid, gs] of geneStats) {
      if (gs.total >= 2) {
        const rate = gs.success / gs.total;
        if (topGeneRate === null || rate > topGeneRate) {
          topGeneId = gid;
          topGeneRate = rate;
        }
      }
    }

    try {
      await prisma.iMSignalCluster.upsert({
        where: { clusterKey },
        update: {
          memberSignals: JSON.stringify(memberArray),
          frequency: freq,
          agentCount: agents.size,
          topGeneId,
          topGeneRate,
        },
        create: {
          clusterKey,
          memberSignals: JSON.stringify(memberArray),
          frequency: freq,
          agentCount: agents.size,
          topGeneId,
          topGeneRate,
        },
      });
      upserted++;
    } catch {
      /* skip duplicates */
    }
  }

  if (upserted > 0)
    console.log(`[Evolution] Computed ${upserted} signal clusters from ${capsuleSignals.length} capsules`);
  return upserted;
}

/**
 * Generate a human-readable cluster key from member signals.
 * e.g. ["error:connection_refused", "error:timeout"] → "error:connection+timeout"
 */
function generateClusterKey(signals: string[]): string {
  const categories = new Map<string, string[]>();
  for (const s of signals) {
    const [cat, ...rest] = s.split(':');
    if (!categories.has(cat)) categories.set(cat, []);
    categories.get(cat)!.push(rest.join(':') || cat);
  }
  return [...categories.entries()].map(([cat, specs]) => `${cat}:${specs.slice(0, 3).join('+')}`).join('|');
}

/**
 * Look up signal clusters for a set of event signals.
 * Returns matching cluster's topGeneId if found.
 */
export async function lookupCluster(signalTypes: string[]): Promise<{
  clusterKey: string;
  topGeneId: string;
  topGeneRate: number;
  memberSignals: string[];
} | null> {
  const clusters = await prisma.iMSignalCluster.findMany({
    where: { topGeneId: { not: null } },
    orderBy: { frequency: 'desc' },
    take: 50,
  });

  for (const cluster of clusters) {
    const members = JSON.parse(cluster.memberSignals || '[]') as string[];
    const overlap = signalTypes.filter((s) => members.includes(s)).length;
    if (overlap > 0 && overlap >= members.length * 0.3) {
      return {
        clusterKey: cluster.clusterKey,
        topGeneId: cluster.topGeneId!,
        topGeneRate: cluster.topGeneRate ?? 0,
        memberSignals: members,
      };
    }
  }
  return null;
}
