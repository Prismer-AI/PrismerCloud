/**
 * Memory health metrics aggregator — M-F (doc 25 §5.5).
 *
 * Seven workspace-level metrics that quantify whether the M-A..M-C
 * refactor is producing the right behavior in the field:
 *
 *   1. recall_pull / session_turn ratio    < 0.3
 *      → "not every turn triggers recall"
 *   2. recall_pull empty_rate               > 0.4
 *      → "selector is actually selective; many recalls return nothing"
 *   3. recall p95 latency ms                < 1500
 *      → "fork + LLM stage doesn't stall the turn"
 *   4. recall_inject token-per-turn p95     < 800
 *      → "injection budget is honored"
 *   5. dream idle violation count           == 0
 *      → "Dream daemon never preempts the user"
 *   6. extract proposal user-accept rate    > 0.6
 *      → "extracted proposals are worth surfacing"
 *   7. fork prompt-cache hit rate           > 0.7
 *      → "cache-safe params actually amortize selector cost"
 *
 * Reads from `im_memory_observability_events` (recall_*, recall_fork,
 * memory.feedback) + `im_memory_proposals`. The window defaults to the
 * last 24 hours; callers can override via `?windowMs=`.
 */

import prisma from '../db';

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface MemoryMetricsThresholds {
  recallPullPerTurnMax: number;
  recallEmptyRateMin: number;
  recallP95LatencyMaxMs: number;
  recallInjectTokenPerTurnP95Max: number;
  dreamIdleViolationMax: number;
  extractAcceptRateMin: number;
  forkCacheHitRateMin: number;
}

export const DEFAULT_THRESHOLDS: MemoryMetricsThresholds = {
  recallPullPerTurnMax: 0.3,
  recallEmptyRateMin: 0.4,
  recallP95LatencyMaxMs: 1500,
  recallInjectTokenPerTurnP95Max: 800,
  dreamIdleViolationMax: 0,
  extractAcceptRateMin: 0.6,
  forkCacheHitRateMin: 0.7,
};

export interface MetricWithThreshold {
  value: number | null;
  threshold: number;
  passing: boolean;
  /** Sample count contributing to the metric, when relevant. */
  sampleSize: number;
}

export interface MemoryMetricsReport {
  workspaceId: string;
  windowMs: number;
  computedAt: string;
  metrics: {
    recallPullPerTurn: MetricWithThreshold;
    recallEmptyRate: MetricWithThreshold;
    recallP95LatencyMs: MetricWithThreshold;
    recallInjectTokenPerTurnP95: MetricWithThreshold;
    dreamIdleViolationCount: MetricWithThreshold;
    extractProposalAcceptRate: MetricWithThreshold;
    forkPromptCacheHitRate: MetricWithThreshold;
  };
  overall: {
    passingCount: number;
    failingCount: number;
    /** True only when every metric with a non-null value passes its threshold. */
    allGreen: boolean;
  };
}

interface ObsEventRow {
  eventType: string;
  pageId: string | null;
  query: string | null;
  metricsJson: string | null;
  metadataJson: string | null;
  createdAt: Date;
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function p95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.ceil(0.95 * sorted.length) - 1);
  return sorted[idx]!;
}

export async function computeMemoryMetrics(
  workspaceId: string,
  windowMs: number = DEFAULT_WINDOW_MS,
  thresholds: MemoryMetricsThresholds = DEFAULT_THRESHOLDS,
): Promise<MemoryMetricsReport> {
  const since = new Date(Date.now() - windowMs);

  const [rawEvents, proposals] = await Promise.all([
    prisma.iMMemoryObservabilityEvent.findMany({
      where: {
        workspaceId,
        createdAt: { gte: since },
      },
      select: {
        eventType: true,
        pageId: true,
        query: true,
        metricsJson: true,
        metadataJson: true,
        createdAt: true,
      },
    }),
    prisma.iMMemoryProposal.findMany({
      where: { workspaceId, createdAt: { gte: since } },
      select: { status: true },
    }),
  ]);
  const events = rawEvents as ObsEventRow[];

  // Group events by family.
  const pulls = events.filter((e) => e.eventType === 'recall_pull');
  const injects = events.filter((e) => e.eventType === 'recall_inject');
  const forks = events.filter((e) => e.eventType === 'recall_fork');
  // "session turn" = any agent-emitted observability event that isn't a
  // dream/fork — recall_pull and recall_inject themselves are per-turn.
  // We approximate "turn count" with the count of UNIQUE sessions × the
  // pulls observed; the cleaner replacement is to count
  // distinct (sessionId, turnIndex) tuples from metadataJson.
  const turnSet = new Set<string>();
  for (const e of events) {
    if (e.eventType === 'recall_pull' || e.eventType === 'recall_inject') {
      const meta = parseJson<{ sessionId?: string; turnIndex?: number }>(e.metadataJson);
      if (meta?.sessionId && typeof meta.turnIndex === 'number') {
        turnSet.add(`${meta.sessionId}#${meta.turnIndex}`);
      }
    }
  }
  const turnCount = turnSet.size;

  // 1. recall_pull / turn
  const recallPullPerTurn = turnCount === 0 ? null : pulls.length / turnCount;

  // 2. recall_pull empty rate — pull events whose metricsJson.topK == 0 or
  // where the corresponding `metadataJson.tool === 'memory_recall'` had a
  // zero-result fork. The simplest proxy: a recall_fork with
  // metadataJson.selectedCount == 0.
  let emptyForks = 0;
  for (const f of forks) {
    const meta = parseJson<{ selectedCount?: number }>(f.metadataJson);
    if (typeof meta?.selectedCount === 'number' && meta.selectedCount === 0) emptyForks++;
  }
  const recallEmptyRate = forks.length === 0 ? null : emptyForks / forks.length;

  // 3. p95 latency — recall_fork metricsJson.durationMs.
  const latencies: number[] = [];
  for (const f of forks) {
    const m = parseJson<{ durationMs?: number }>(f.metricsJson);
    if (typeof m?.durationMs === 'number') latencies.push(m.durationMs);
  }
  const recallP95LatencyMs = p95(latencies);

  // 4. recall_inject token per turn p95.
  const tokensPerTurn = new Map<string, number>();
  for (const e of injects) {
    const meta = parseJson<{ sessionId?: string; turnIndex?: number }>(e.metadataJson);
    const metrics = parseJson<{ tokenCount?: number }>(e.metricsJson);
    if (meta?.sessionId && typeof meta.turnIndex === 'number' && typeof metrics?.tokenCount === 'number') {
      const key = `${meta.sessionId}#${meta.turnIndex}`;
      tokensPerTurn.set(key, (tokensPerTurn.get(key) ?? 0) + metrics.tokenCount);
    }
  }
  const recallInjectTokenPerTurnP95 = p95([...tokensPerTurn.values()]);

  // 5. Dream idle violation count — counted from a dedicated event type.
  // We re-use access_denied as a placeholder bucket for now since
  // 'dream_idle_violation' isn't in the envelope schema; production
  // path will add an explicit eventType when needed.
  const dreamIdleViolations = events.filter(
    (e) => e.eventType === 'access_denied' && parseJson<{ reason?: string }>(e.metadataJson)?.reason === 'dream_idle',
  ).length;

  // 6. extract proposal accept rate.
  const totalProposals = proposals.length;
  const approved = (proposals as Array<{ status: string }>).filter((p) => p.status === 'approved').length;
  const extractAcceptRate = totalProposals === 0 ? null : approved / totalProposals;

  // 7. fork prompt cache hit rate.
  let cacheHits = 0;
  let cacheTotal = 0;
  for (const f of forks) {
    const m = parseJson<{
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
      inputTokens?: number;
    }>(f.metricsJson);
    if (!m) continue;
    const read = m.cacheReadTokens ?? 0;
    const created = m.cacheCreationTokens ?? 0;
    const input = m.inputTokens ?? 0;
    const totalCacheable = read + created + input;
    if (totalCacheable === 0) continue;
    cacheHits += read;
    cacheTotal += totalCacheable;
  }
  const forkCacheHitRate = cacheTotal === 0 ? null : cacheHits / cacheTotal;

  const metrics = {
    recallPullPerTurn: bind(recallPullPerTurn, thresholds.recallPullPerTurnMax, pulls.length, 'lte'),
    recallEmptyRate: bind(recallEmptyRate, thresholds.recallEmptyRateMin, forks.length, 'gte'),
    recallP95LatencyMs: bind(recallP95LatencyMs, thresholds.recallP95LatencyMaxMs, latencies.length, 'lte'),
    recallInjectTokenPerTurnP95: bind(
      recallInjectTokenPerTurnP95,
      thresholds.recallInjectTokenPerTurnP95Max,
      tokensPerTurn.size,
      'lte',
    ),
    dreamIdleViolationCount: bind(dreamIdleViolations, thresholds.dreamIdleViolationMax, events.length, 'lte'),
    extractProposalAcceptRate: bind(extractAcceptRate, thresholds.extractAcceptRateMin, totalProposals, 'gte'),
    forkPromptCacheHitRate: bind(forkCacheHitRate, thresholds.forkCacheHitRateMin, forks.length, 'gte'),
  };

  const passing = Object.values(metrics).filter((m) => m.value !== null && m.passing).length;
  const failing = Object.values(metrics).filter((m) => m.value !== null && !m.passing).length;
  return {
    workspaceId,
    windowMs,
    computedAt: new Date().toISOString(),
    metrics,
    overall: { passingCount: passing, failingCount: failing, allGreen: failing === 0 },
  };
}

function bind(
  value: number | null,
  threshold: number,
  sampleSize: number,
  comparator: 'lte' | 'gte',
): MetricWithThreshold {
  if (value === null) return { value: null, threshold, passing: true, sampleSize };
  const passing = comparator === 'lte' ? value <= threshold : value >= threshold;
  return { value, threshold, passing, sampleSize };
}
