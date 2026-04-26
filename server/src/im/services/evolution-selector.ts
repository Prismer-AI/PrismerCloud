/**
 * Evolution Sub-module: Gene Selection
 *
 * GeneSelector implementations (Thompson Sampling, Laplace),
 * Beta distribution sampling, bimodality index calculation,
 * and the selectGene() orchestration logic.
 */

import prisma from '../db';
import type {
  PrismerGene,
  GeneCategory,
  SignalTag,
  EvolutionAdvice,
  GeneSelector,
  GeneSelectorInput,
  ScoredGene,
} from '../types/index';
import type { SignalExtractorService } from './signal-extractor';
import {
  normalizeSignals,
  matchesPattern,
  tagCoverageScore,
  tagCoverageScoreDetailed,
  computeSignalKey,
  extractSignalType,
  signalOverlap,
  trackUnmatchedSignals,
} from './evolution-signals';
import { getAgentMode, queryHypergraphCandidates } from './evolution-hypergraph';
import { dbGeneToModel, isCanaryVisibleToAgent, checkCircuitBreakerData } from './evolution-lifecycle';
import { getPersonality } from './evolution-personality';

// ─── Constants ──────────────────────────────────────────────

/** Genes with success rate below this are banned (unless drift kicks in) */
const BAN_THRESHOLD = 0.18;

/** Half-life for time decay (30 days in ms) */
const HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

// ─── Analyze Result Cache (TTL=5s) ─────────────────────────

interface CachedAdvice {
  result: EvolutionAdvice;
  ts: number;
}

const _analyzeCache = new Map<string, CachedAdvice>();
const ANALYZE_CACHE_TTL = 5_000; // 5 seconds
const ANALYZE_CACHE_MAX_SIZE = 200;

function getAnalyzeCache(agentId: string, signalKey: string): EvolutionAdvice | null {
  const key = `${agentId}:${signalKey}`;
  const entry = _analyzeCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > ANALYZE_CACHE_TTL) {
    _analyzeCache.delete(key);
    return null;
  }
  return entry.result;
}

/** Invalidate cached analyze result after recording an outcome */
export function invalidateAnalyzeCache(agentId: string): void {
  // Remove all entries for this agent (signalKey may vary)
  for (const key of _analyzeCache.keys()) {
    if (key.startsWith(`${agentId}:`)) {
      _analyzeCache.delete(key);
    }
  }
}

function setAnalyzeCache(agentId: string, signalKey: string, result: EvolutionAdvice): void {
  // Evict oldest entries if cache is full
  if (_analyzeCache.size >= ANALYZE_CACHE_MAX_SIZE) {
    const oldest = _analyzeCache.keys().next().value;
    if (oldest) _analyzeCache.delete(oldest);
  }
  _analyzeCache.set(`${agentId}:${signalKey}`, { result, ts: Date.now() });
}

// ─── Beta Distribution Sampling (Thompson Sampling) ─────────

/**
 * Sample from Beta(α, β) distribution.
 * Uses Jöhnk's algorithm for small α, β (< 1) — numerically stable for cold-start priors.
 * Falls back to Gamma-ratio method (Marsaglia & Tsang) for larger parameters.
 */
export function betaSample(alpha: number, beta: number): number {
  if (alpha <= 0 || beta <= 0) return 0.5;
  if (alpha === 1 && beta === 1) return Math.random();

  // Jöhnk's algorithm: numerically stable for small α, β (exploration-heavy cold-start)
  if (alpha < 1 && beta < 1) {
    for (let iter = 0; iter < 1000; iter++) {
      const u = Math.random();
      const v = Math.random();
      const x = Math.pow(u, 1 / alpha);
      const y = Math.pow(v, 1 / beta);
      if (x + y <= 1) return x / (x + y);
    }
    // Fallback: Gamma-ratio method if Jöhnk rejection sampling exhausted
    const gx = gammaSample(alpha);
    const gy = gammaSample(beta);
    return gx / (gx + gy);
  }

  // Gamma-ratio method for α ≥ 1 or β ≥ 1
  const x = gammaSample(alpha);
  const y = gammaSample(beta);
  return x / (x + y);
}

export function gammaSample(shape: number): number {
  if (shape < 1) return gammaSample(shape + 1) * Math.pow(Math.random(), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x: number, v: number;
    do {
      x = randn();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

export function randn(): number {
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * updateBimodalityIndex: overdispersion-based bimodality detection.
 *
 * Splits recent N outcomes into time windows, computes window-level success rates,
 * and measures how much more variance there is vs i.i.d. Bernoulli(p).
 *
 * Returns [0, 1]: 0 = stable/random, ~1 = strongly bimodal (hidden context dependency).
 */
export function updateBimodalityIndex(
  recentOutcomes: number[], // 0/1 sequence, chronological order
  windowSize = 10,
): number {
  const N = recentOutcomes.length;
  if (N < windowSize * 2) return 0; // Need at least 2 windows

  const p = recentOutcomes.reduce((a, b) => a + b, 0) / N;
  // Extreme ranges (including p=0 or p=1) cannot distinguish bimodal from unimodal
  if (p <= 0 || p >= 1 || p < 0.05 || p > 0.95) return 0;

  const windowRates: number[] = [];
  for (let i = 0; i + windowSize <= N; i += windowSize) {
    const w = recentOutcomes.slice(i, i + windowSize);
    windowRates.push(w.reduce((a, b) => a + b, 0) / windowSize);
  }

  const wMean = windowRates.reduce((a, b) => a + b, 0) / windowRates.length;
  const crossWindowVar = windowRates.reduce((a, b) => a + Math.pow(b - wMean, 2), 0) / windowRates.length;
  const expectedVar = (p * (1 - p)) / windowSize;

  // Overdispersion ratio: 1.0 = pure random, >>1 = context-dependent (hidden bimodal)
  const overdispersion = crossWindowVar / (expectedVar + 1e-6);

  // Guard against NaN/Infinity from degenerate inputs
  if (!isFinite(overdispersion)) return 1.0;

  // Normalize: [1×, 10×] overdispersion → [0, 1]
  return Math.min(1.0, Math.max(0, (overdispersion - 1) / 9));
}

// ─── Pluggable Gene Selectors (§3.3) ────────────────────────

/**
 * Base scoring loop: handles coverage, filtering (ban/breaker/quarantine),
 * global prior blending. Subclasses override computeMemoryScore() only.
 */
abstract class BaseSelectorImpl implements GeneSelector {
  abstract readonly name: string;
  protected abstract computeMemoryScore(alphaCombined: number, betaCombined: number, lastUsedAt: Date | null): number;

  score(input: GeneSelectorInput): ScoredGene[] {
    const { genes, signalTags, edgeMap, globalEdges, wGlobal, breakerCheck } = input;
    const scored: ScoredGene[] = [];

    for (const gene of genes) {
      const coverage = tagCoverageScoreDetailed(signalTags, gene.signals_match, input.semanticCache);
      const coverageScore = coverage.score;
      if (coverageScore === 0) continue;

      // Skip: quarantined genes and open circuit breakers
      if (gene.visibility === 'quarantined') continue;
      const breaker = breakerCheck(gene.id);
      if (!breaker.allowed) continue;

      const edgeData = edgeMap.get(gene.id);
      let memoryScore = gene.visibility === 'canary' ? 0.35 : 0.5;

      if (edgeData) {
        const n = edgeData.success + edgeData.failure;

        // Ban check: success rate below threshold with enough data
        const effectiveBan = input.banThreshold ?? BAN_THRESHOLD;
        const p = (edgeData.success + 1) / (n + 2);
        if (n >= 5 && p < effectiveBan) continue;
      }

      // Hierarchical Bayesian: blend global and local posteriors
      // CRITICAL: always check global prior, even when agent has no local edge.
      // This is how Agent B benefits from Agent A's experience.
      const globalEdge = globalEdges.find((g) => g.geneId === gene.id);
      const hasGlobalData =
        globalEdge && (globalEdge._sum?.successCount || 0) + (globalEdge._sum?.failureCount || 0) > 0;

      if (edgeData || hasGlobalData) {
        const alphaGlobal = (globalEdge?._sum?.successCount || 0) + 1;
        const betaGlobal = (globalEdge?._sum?.failureCount || 0) + 1;
        const alphaLocal = (edgeData?.success || 0) + 1;
        const betaLocal = (edgeData?.failure || 0) + 1;

        const canaryDiscount = gene.visibility === 'canary' ? 0.5 : 1.0;
        const wEff = wGlobal * canaryDiscount;
        const alphaCombined = alphaGlobal * wEff + alphaLocal * (1 - wEff);
        const betaCombined = betaGlobal * wEff + betaLocal * (1 - wEff);

        memoryScore = this.computeMemoryScore(alphaCombined, betaCombined, edgeData?.lastUsedAt ?? null);
      }

      // Confidence: Thompson-backed value × sample-size discount
      // memoryScore is already betaSample(alpha, beta) — use it instead of naive N/10
      const localN = edgeData ? edgeData.success + edgeData.failure : 0;
      const globalN = (globalEdge?._sum?.successCount || 0) + (globalEdge?._sum?.failureCount || 0);
      const sampleDiscount = Math.min((localN + globalN) / 20, 1.0);
      // Cross-agent transferability: other agents' executions boost confidence
      const otherAgentN = Math.max(0, globalN - localN);
      const transferabilityBonus = otherAgentN >= 10 ? 0.1 : otherAgentN >= 5 ? 0.05 : 0;
      const confidence = Math.min(memoryScore * sampleDiscount + transferabilityBonus, 1.0);

      // Context match bonus
      const eventProviders = new Set(signalTags.map((t) => t.provider).filter(Boolean));
      const eventStages = new Set(signalTags.map((t) => t.stage).filter(Boolean));
      const geneProviders = new Set(gene.signals_match.map((t) => t.provider).filter(Boolean));
      const geneStages = new Set(gene.signals_match.map((t) => t.stage).filter(Boolean));
      const providerMatch = [...eventProviders].some((p) => geneProviders.has(p));
      const stageMatch = [...eventStages].some((s) => geneStages.has(s));
      const contextBonus = (providerMatch ? 0.5 : 0) + (stageMatch ? 0.5 : 0);

      // Quality bonus
      const totalExec = gene.success_count + gene.failure_count;
      const successRate = totalExec > 0 ? gene.success_count / totalExec : 0;
      const qualityBonus = Math.min((gene.forkCount || 0) / 10, 0.5) + Math.min(successRate, 0.5);

      // Match layer bonus: exact matches deserve inherent trust even without execution data.
      // Without this, cold-start genes with confidence=0 always lose to generic prefix-match
      // genes that have accumulated data — creating a vicious cycle where new exact-match
      // genes never get selected and thus never accumulate data.
      const matchLayerBonus = coverage.layer === 'exact' ? 0.15 : coverage.layer === 'semantic' ? 0.05 : 0;

      // Tech stack mismatch penalty: if event signals include a techStack hint,
      // penalize genes whose signals_match reference a different tech stack.
      // Soft penalty (not hard filter) for backward compatibility.
      let techStackPenalty = 1.0;
      const eventTechStack = signalTags.find((t) => t.techStack)?.techStack;
      if (eventTechStack) {
        const KNOWN_STACKS = ['typescript', 'javascript', 'python', 'swift', 'rust', 'go', 'java', 'ruby'];
        const geneSignalTypes = gene.signals_match.map((s: SignalTag) => s.type.toLowerCase());
        const geneHasTechHint = geneSignalTypes.some((t) => KNOWN_STACKS.some((stack) => t.includes(stack)));
        if (geneHasTechHint) {
          const geneMatchesTech = geneSignalTypes.some((t) => t.includes(eventTechStack));
          if (!geneMatchesTech) {
            techStackPenalty = 0.1; // Heavy penalty for wrong tech stack
          }
        }
      }

      // Multi-dimensional rank score
      const rankScore =
        (coverageScore * 0.35 +
          memoryScore * 0.25 +
          confidence * 0.15 +
          contextBonus * 0.15 +
          qualityBonus * 0.1 +
          matchLayerBonus) *
        techStackPenalty;

      scored.push({
        gene,
        score: rankScore,
        confidence,
        coverageScore,
        matchLayer: coverage.layer,
        rankScore,
        providerMatch,
        stageMatch,
      });
    }
    return scored;
  }
}

/**
 * ThompsonSelector: Beta posterior sampling × tag coverage score.
 * Default selector — provides automatic explore-exploit balance.
 */
class ThompsonSelector extends BaseSelectorImpl {
  readonly name = 'thompson';

  protected computeMemoryScore(alphaCombined: number, betaCombined: number, lastUsedAt: Date | null): number {
    if (lastUsedAt) {
      const ageMs = Date.now() - lastUsedAt.getTime();
      const alphaEff = Math.max(1, alphaCombined * Math.pow(0.5, ageMs / HALF_LIFE_MS));
      const betaEff = Math.max(1, betaCombined * Math.pow(0.5, ageMs / HALF_LIFE_MS));
      return betaSample(alphaEff, betaEff);
    }
    return betaSample(alphaCombined, betaCombined);
  }
}

/**
 * LaplaceSelector: deterministic point estimate + time decay (legacy).
 * Preserved for backward compatibility; use EVOLUTION_SELECTOR=laplace to activate.
 */
class LaplaceSelector extends BaseSelectorImpl {
  readonly name = 'laplace';

  protected computeMemoryScore(alphaCombined: number, betaCombined: number, lastUsedAt: Date | null): number {
    let timeWeight = 1.0;
    if (lastUsedAt) {
      timeWeight = Math.pow(0.5, (Date.now() - lastUsedAt.getTime()) / HALF_LIFE_MS);
    }
    return (alphaCombined / (alphaCombined + betaCombined)) * timeWeight;
  }
}

/**
 * GreedySelector: pure exploitation, no exploration.
 * Picks the gene with highest point estimate (alpha / (alpha + beta)).
 * Use EVOLUTION_DETERMINISTIC=true for benchmark reproducibility (G1 v1.8.2).
 */
class GreedySelector extends BaseSelectorImpl {
  readonly name = 'greedy';

  protected computeMemoryScore(alphaCombined: number, betaCombined: number, _lastUsedAt: Date | null): number {
    return alphaCombined / (alphaCombined + betaCombined);
  }
}

/** Factory: create selector from env var */
export function createGeneSelector(): GeneSelector {
  if (process.env.EVOLUTION_DETERMINISTIC === 'true') return new GreedySelector();
  if (process.env.EVOLUTION_SELECTOR === 'laplace') return new LaplaceSelector();
  return new ThompsonSelector();
}

/** Logged once per process to avoid spamming */
let _selectorModeLogged = false;

// ===== Create Suggestion =====

/**
 * Build a suggestion for creating a new gene when no match is found.
 * Pure algorithmic — no LLM needed. Infers category from signal prefix,
 * generates a title, and finds the most similar existing genes.
 */
export function buildCreateSuggestion(
  signals: string[] | SignalTag[],
  allGenes: PrismerGene[],
): {
  category: GeneCategory;
  signals_match: SignalTag[];
  title: string;
  description: string;
  similar_genes: Array<{ gene_id: string; title: string; similarity: number }>;
} {
  const tags = normalizeSignals(signals as string[] | SignalTag[]);

  // Infer category from signal prefix
  const category = inferCategory(tags);

  // Generate title from signals
  const title = generateTitle(tags);

  // Generate description
  const typeStr = tags.map((t) => t.type).join(', ');
  const description = `Handles ${typeStr} signals. Auto-suggested by evolution engine.`;

  // Find most similar existing genes by tag coverage score
  const similar = allGenes
    .map((g) => ({
      gene_id: g.id,
      title: g.title || g.id,
      similarity: tagCoverageScore(tags, g.signals_match),
    }))
    .filter((s) => s.similarity > 0)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 3);

  return {
    category,
    signals_match: tags,
    title,
    description,
    similar_genes: similar,
  };
}

/**
 * Infer gene category from signal prefixes (v0.3.0: accepts SignalTag[]).
 * High-cardinality signals (error:500 with no other context) → diagnostic.
 */
export function inferCategory(signals: SignalTag[]): GeneCategory {
  let errorCount = 0;
  let perfCount = 0;
  let otherCount = 0;

  for (const s of signals) {
    if (s.type.startsWith('error:') || s.type === 'task.failed') errorCount++;
    else if (s.type.startsWith('perf:') || s.type.startsWith('cost:')) perfCount++;
    else otherCount++;
  }

  // Single high-cardinality error signal with no specific context → diagnostic
  if (errorCount === 1 && signals.length === 1 && Object.keys(signals[0]).length === 1) {
    return 'diagnostic';
  }
  if (errorCount >= perfCount && errorCount >= otherCount) return 'repair';
  if (perfCount >= errorCount && perfCount >= otherCount) return 'optimize';
  return 'innovate';
}

/**
 * Generate a human-readable title from signals.
 * "error:graphql_validation" → "GraphQL Validation Handler"
 * "perf:cold_start" → "Cold Start Optimizer"
 */
export function generateTitle(signals: SignalTag[]): string {
  // Use the most specific signal (prefer tags with most fields)
  const sorted = [...signals].sort((a, b) => Object.keys(b).length - Object.keys(a).length);
  const primary = sorted[0]?.type || 'unknown';
  const parts = primary.split(':');
  const specific = parts.length > 1 ? parts.slice(1).join(':') : parts[0];

  // Convert snake_case to Title Case
  const words = specific
    .replace(/[_.-]/g, ' ')
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');

  // Add suffix based on category
  const category = inferCategory(signals);
  const suffixMap: Record<GeneCategory, string> = {
    repair: 'Handler',
    optimize: 'Optimizer',
    innovate: 'Strategy',
    diagnostic: 'Triage',
  };
  const suffix = suffixMap[category] ?? 'Strategy';
  return `${words} ${suffix}`;
}

// ===== Gene Selection Orchestration =====

/**
 * Select the best gene for given signals using the memory graph.
 * Algorithm: tag coverage scoring + Thompson Sampling + hierarchical Bayesian pooling + genetic drift.
 * v0.3.0: accepts SignalTag[] (or string[] for backward compat).
 */
export async function selectGene(
  signals: string[] | SignalTag[],
  agentId: string,
  deps: {
    selector: GeneSelector;
    signalExtractor?: SignalExtractorService;
  },
  scope = 'global',
): Promise<EvolutionAdvice> {
  // Normalize to SignalTag[] (backward compat)
  const signalTags = normalizeSignals(signals as string[] | SignalTag[]);

  const signalKey = computeSignalKey(signalTags);

  // ── Cache hit: return cached result if same agent+signals within 5s ──
  const cached = getAnalyzeCache(agentId, signalKey);
  if (cached) return cached;

  // signal_type = coarse key for global prior aggregation (§4.2)
  const signalType = extractSignalType(signalTags);

  // ── Parallel Phase 1: Load agent card (mode + personality) + genes + edges simultaneously ──
  // Previously these were 7+ sequential queries. Now 4 parallel queries.
  const agentCardPromise = prisma.iMAgentCard.findUnique({
    where: { imUserId: agentId },
    select: { metadata: true },
  });

  const [agentCard, ownRows, globalRows, edges] = await Promise.all([
    agentCardPromise,
    prisma.iMGene.findMany({
      where: { ownerAgentId: agentId, scope },
      include: { signalLinks: true },
    }),
    prisma.iMGene.findMany({
      where: {
        ownerAgentId: { not: agentId },
        visibility: { in: ['seed', 'published', 'canary'] },
        scope,
      },
      include: { signalLinks: true },
      take: 200,
      orderBy: { successCount: 'desc' },
    }),
    prisma.iMEvolutionEdge.findMany({
      where: { ownerAgentId: agentId, scope },
    }),
  ]);

  // Extract mode + personality from single agentCard query (avoids 2 separate DB calls)
  const cardMeta = (() => {
    try {
      return JSON.parse((agentCard as any)?.metadata || '{}');
    } catch {
      return {};
    }
  })();
  const agentMode: 'standard' | 'hypergraph' =
    cardMeta.evolution_mode === 'hypergraph'
      ? 'hypergraph'
      : cardMeta.evolution_mode === 'standard'
        ? 'standard'
        : process.env.EVOLUTION_DEFAULT_MODE === 'hypergraph'
          ? 'hypergraph'
          : 'standard';
  const personality = {
    rigor: cardMeta.personality?.rigor ?? 0.7,
    creativity: cardMeta.personality?.creativity ?? 0.35,
    risk_tolerance: cardMeta.personality?.risk_tolerance ?? 0.4,
  };

  // Build per-gene circuit breaker map from already-loaded rows (no extra DB queries)
  const breakerMap = new Map<string, { state: string; stateAt: Date | null }>();
  for (const r of [...ownRows, ...(globalRows as any[])]) {
    breakerMap.set(r.id, { state: r.breakerState ?? 'closed', stateAt: r.breakerStateAt ?? null });
  }

  const ownGenes = ownRows.map((r: any) => dbGeneToModel(r));
  const visibleGlobalGenes = (globalRows as any[])
    .filter((r) => r.visibility !== 'canary' || isCanaryVisibleToAgent(r.ownerAgentId, agentId))
    .map((r) => dbGeneToModel(r));

  // Merge: agent's own genes take priority on ID collision
  const ownIds = new Set(ownGenes.map((g: PrismerGene) => g.id));
  const genes = [...ownGenes, ...visibleGlobalGenes.filter((g: PrismerGene) => !ownIds.has(g.id))];

  if (genes.length === 0) {
    const suggestion = buildCreateSuggestion(signalTags, []);
    await trackUnmatchedSignals(signalTags, agentId, scope);
    return {
      action: 'create_suggested',
      confidence: 0,
      signals: signalTags,
      reason: 'no genes available',
      suggestion,
    };
  }

  // Hypergraph candidate narrowing — always attempt as supplementary signal source.
  // In standard mode: used as bonus (boosts matching genes), not filter.
  // In hypergraph mode: used as hard filter (narrows candidate set).
  let hypergraphCandidateIds: Set<string> | null = null;
  try {
    const hgCandidates = await queryHypergraphCandidates(signalTags);
    if (hgCandidates.length > 0) {
      if (agentMode === 'hypergraph') {
        // Hard filter: only consider hypergraph-matched genes
        hypergraphCandidateIds = new Set(hgCandidates);
        console.log(`[Evolution] Hypergraph narrowed candidates: ${genes.length} → ${hgCandidates.length}`);
      } else {
        // Soft signal: hypergraph matches get a coverage bonus (see scoring below)
        hypergraphCandidateIds = new Set(hgCandidates);
      }
    }
  } catch {
    /* non-blocking */
  }

  // Build edge lookup: geneId → edge data (accumulate matching edges by signal overlap)
  const edgeMap = new Map<
    string,
    { success: number; failure: number; lastScore: number | null; lastUsedAt: Date | null }
  >();
  for (const edge of edges) {
    if (signalOverlap(signalKey, edge.signalKey) > 0) {
      const existing = edgeMap.get(edge.geneId);
      if (existing) {
        existing.success += edge.successCount;
        existing.failure += edge.failureCount;
        if (edge.lastScore !== null) existing.lastScore = edge.lastScore;
        if (edge.lastUsedAt && (!existing.lastUsedAt || edge.lastUsedAt > existing.lastUsedAt)) {
          existing.lastUsedAt = edge.lastUsedAt;
        }
      } else {
        edgeMap.set(edge.geneId, {
          success: edge.successCount,
          failure: edge.failureCount,
          lastScore: edge.lastScore,
          lastUsedAt: edge.lastUsedAt,
        });
      }
    }
  }

  // ── Parallel Phase 2: Global prior aggregation ──
  // v0.3.1: filter by mode to prevent cross-mode prior contamination
  // Optimized: removed OR + startsWith (caused full table scan on MySQL).
  // Now uses exact signalType OR signalKey match only.
  const rawGlobalEdges = await prisma.iMEvolutionEdge.groupBy({
    by: ['geneId'],
    where: {
      mode: agentMode,
      scope,
      ...(signalType ? { OR: [{ signalType }, { signalKey }] } : { signalKey }),
    },
    _sum: { successCount: true, failureCount: true },
  });

  // Cross-agent gene matching: build base-ID aggregation.
  // Seed genes are cloned per agent with suffix (seed_repair_timeout_v1_abc123).
  // We also aggregate by base ID (seed_repair_timeout_v1) so Agent B benefits from Agent A's data
  // on the same base gene, even though their gene IDs differ.
  const baseIdAgg = new Map<string, { successCount: number; failureCount: number }>();
  for (const e of rawGlobalEdges) {
    const baseId = e.geneId.replace(/_[a-z0-9]{5,8}$/, '').replace(/_imp_[a-z0-9]+$/, '');
    const existing = baseIdAgg.get(baseId) || { successCount: 0, failureCount: 0 };
    existing.successCount += e._sum?.successCount || 0;
    existing.failureCount += e._sum?.failureCount || 0;
    baseIdAgg.set(baseId, existing);
  }

  // Merge: for each candidate gene, check both exact geneId and base ID in global edges
  const globalEdges = rawGlobalEdges.map((e: any) => ({ ...e })); // copy
  for (const gene of genes) {
    const exactMatch = globalEdges.find((g: any) => g.geneId === gene.id);
    if (!exactMatch) {
      // Check base ID aggregation
      const baseId = gene.id.replace(/_[a-z0-9]{5,8}$/, '').replace(/_imp_[a-z0-9]+$/, '');
      const baseAgg = baseIdAgg.get(baseId);
      if (baseAgg && baseAgg.successCount + baseAgg.failureCount > 0) {
        globalEdges.push({
          geneId: gene.id,
          _sum: { successCount: baseAgg.successCount, failureCount: baseAgg.failureCount },
        } as any);
      }
    }
  }

  // Combine: weight global prior by agent experience
  const agentTotal = edges.reduce(
    (s: number, e: { successCount: number; failureCount: number }) => s + e.successCount + e.failureCount,
    0,
  );
  const wGlobal = Math.max(0.2, 1 - agentTotal / 100); // Experience threshold: 100

  // personality already loaded from agentCard in Phase 1 above (no extra DB query)

  // Load semantic similarity cache from Redis (Layer 3 — async LLM results)
  // Skip when exact coverage is already high — semantic matching adds no value there.
  let semanticCache: Map<string, number> | undefined;
  const preScoreHasExactMatch = genes.some((g) => tagCoverageScore(signalTags, g.signals_match) >= 0.67);
  if (deps.signalExtractor && !preScoreHasExactMatch) {
    try {
      const redis = (deps.signalExtractor as any).redis;
      if (redis) {
        const eventTypes = signalTags.map((t) => t.type);
        const geneTypes = [...new Set(genes.flatMap((g) => g.signals_match.map((s: SignalTag) => s.type)))];
        const pairKeySet = new Set<string>();
        for (const et of eventTypes) {
          for (const gt of geneTypes) {
            if (et !== gt) pairKeySet.add([et, gt].sort().join('↔'));
          }
        }
        const pairKeys = [...pairKeySet];
        if (pairKeys.length > 0 && pairKeys.length <= 50) {
          // Batch fetch via mget (single round-trip instead of N×M)
          const redisKeys = pairKeys.map((k) => `evo:sim:${k}`);
          const values = await redis.mget(...redisKeys).catch(() => [] as (string | null)[]);
          semanticCache = new Map<string, number>();
          for (let i = 0; i < pairKeys.length; i++) {
            if (values[i] !== null && values[i] !== undefined) {
              semanticCache.set(pairKeys[i], parseFloat(values[i]));
            }
          }
        }
      }
    } catch {
      /* non-blocking */
    }
  }

  // Delegate scoring to pluggable GeneSelector (§3.3)
  if (!_selectorModeLogged) {
    console.log(`[Evolution] Gene selection using ${deps.selector.name} selector`);
    _selectorModeLogged = true;
  }

  const scored = deps.selector.score({
    genes,
    signalTags,
    edgeMap,
    globalEdges: globalEdges as any[],
    wGlobal,
    breakerCheck: (geneId: string) => {
      const data = breakerMap.get(geneId) ?? { state: 'closed', stateAt: null };
      return checkCircuitBreakerData(data.state, data.stateAt);
    },
    semanticCache,
  });

  // 3.4b Hypergraph bonus: genes matched via inverted index get a small score boost.
  if (hypergraphCandidateIds && hypergraphCandidateIds.size > 0) {
    for (const s of scored) {
      if (hypergraphCandidateIds.has(s.gene.id)) {
        s.score += 0.05;
      }
    }
  }

  // v1.8.0 Phase 2a.3 + 2d.1 + 2d.2: Parallelized enrichment queries
  // Three independent DB queries run in parallel to minimize selector latency.
  if (scored.length > 0) {
    const scoredGeneIds = scored.map((s) => s.gene.id);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [reflectionsResult, contextResult, bimodalResult] = await Promise.all([
      // 2a.3: Reflection-informed confidence adjustment
      process.env.FF_EVOLUTION_REFLECTION !== 'false'
        ? prisma.iMEvolutionCapsule
            .findMany({
              where: {
                geneId: { in: scoredGeneIds },
                signalKey,
                reflection: { not: null },
                createdAt: { gte: sevenDaysAgo },
              },
              select: { geneId: true, outcome: true, reflection: true },
              orderBy: { createdAt: 'desc' },
              take: 15,
            })
            .catch(() => [] as Array<{ geneId: string; outcome: string; reflection: string | null }>)
        : Promise.resolve([] as Array<{ geneId: string; outcome: string; reflection: string | null }>),

      // 2d.1: Contextual Thompson Sampling — per-signalType (α,β)
      signalType
        ? prisma.iMEvolutionEdge
            .groupBy({
              by: ['geneId'],
              where: {
                signalType,
                scope,
                geneId: { in: scoredGeneIds },
              },
              _sum: { successCount: true, failureCount: true },
            })
            .catch(() => [] as any[])
        : Promise.resolve([] as any[]),

      // 2d.2: Bimodality utilization (scoped to current signalKey)
      prisma.iMEvolutionEdge
        .findMany({
          where: {
            geneId: { in: scoredGeneIds },
            ownerAgentId: agentId,
            signalKey,
            bimodalityIndex: { gt: 0.6 },
            scope,
          },
          select: { geneId: true, bimodalityIndex: true },
        })
        .catch(() => [] as Array<{ geneId: string; bimodalityIndex: number | null }>),
    ]);

    // Apply 2a.3: reflection penalty
    if (reflectionsResult.length > 0) {
      const failureByGene = new Map<string, number>();
      for (const r of reflectionsResult) {
        if (r.outcome === 'failed' && r.reflection) {
          failureByGene.set(r.geneId, (failureByGene.get(r.geneId) || 0) + 1);
        }
      }
      for (const s of scored) {
        const failCount = failureByGene.get(s.gene.id) || 0;
        if (failCount > 0) {
          const penalty = Math.min(failCount * 0.1, 0.3);
          s.confidence *= 1 - penalty;
          s.score *= 1 - penalty * 0.5;
        }
      }
    }

    // Apply 2d.1: contextual Thompson Sampling blend
    if (contextResult.length > 0) {
      const ctxMap = new Map<string, { s: number; f: number }>(
        contextResult.map((e: any) => [
          e.geneId as string,
          { s: (e._sum?.successCount || 0) as number, f: (e._sum?.failureCount || 0) as number },
        ]),
      );
      for (const s of scored) {
        const ctx = ctxMap.get(s.gene.id);
        if (ctx && ctx.s + ctx.f >= 3) {
          const ctxRate = (ctx.s + 1) / (ctx.s + ctx.f + 2);
          const globalRate = s.confidence;
          const blendWeight = Math.min((ctx.s + ctx.f) / 10, 0.6);
          s.confidence = ctxRate * blendWeight + globalRate * (1 - blendWeight);
          s.score += (ctxRate - 0.5) * 0.1;
        }
      }
    }

    // Apply 2d.2: bimodality exploration bonus
    if (bimodalResult.length > 0) {
      const bimodalMap = new Map<string, number>(
        bimodalResult.map((b: { geneId: string; bimodalityIndex: number | null }) => [
          b.geneId,
          b.bimodalityIndex ?? 0,
        ]),
      );
      for (const s of scored) {
        const bIdx = bimodalMap.get(s.gene.id);
        if (bIdx !== undefined && bIdx > 0.6) {
          s.score += bIdx * 0.2;
        }
      }
    }
  }

  // 3.5 Diagnostic Gene boost (§3.4.4): if no fine-match genes exist,
  // boost diagnostic genes as "first responders" for high-cardinality signals.
  // When the best fine-match score is low, a diagnostic gene's routing ability matters more.
  const hasFineMatch = scored.some((s) => s.coverageScore >= 0.67);
  if (!hasFineMatch) {
    for (const s of scored) {
      if (s.gene.category === 'diagnostic') {
        // Diagnostic boost: when no fine-match exists, compensate for coverage penalty
        // Effective: 0.33 coverage → boosted to ~0.55 (still below fine-match 1.0)
        s.score = (s.score / Math.max(s.coverageScore, 0.1)) * 0.55;
      }
    }
  }

  // 3.6 Async semantic similarity trigger: if best coverage is low, queue LLM similarity
  //      for unmatched signal pairs. Results cached in Redis for next call.
  if (deps.signalExtractor && scored.length > 0 && scored[0].coverageScore < 0.5) {
    const eventTypes = signalTags.map((t) => t.type);
    const topGeneTypes = scored.slice(0, 3).flatMap((s) => s.gene.signals_match.map((p) => p.type));
    const pairs: Array<[string, string]> = [];
    for (const et of eventTypes) {
      for (const gt of topGeneTypes) {
        if (et !== gt && et.split(':')[0] === gt.split(':')[0]) {
          pairs.push([et, gt]);
        }
      }
    }
    if (pairs.length > 0) {
      // Fire-and-forget: compute semantic similarity for next time
      deps.signalExtractor.batchSemanticSimilarity(pairs).catch(() => {});
    }
  }

  // 4. Genetic drift — explore with probability inversely proportional to population size
  // intensity = 1/√Ne (more drift with fewer genes)
  // Dampen when a strong coverage match exists to reduce spurious exploration
  const Ne = Math.max(scored.length, 1);
  const driftIntensity = 1.0 / Math.sqrt(Ne);
  const bestCoverage = scored.length > 0 ? Math.max(...scored.map((s) => s.coverageScore)) : 0;
  const driftDampen = bestCoverage >= 0.67 ? 0.3 : 0.6;
  const driftThreshold = driftIntensity * personality.creativity * driftDampen;

  if (scored.length > 0 && Math.random() < driftThreshold) {
    // Random selection (exploration) — not cached (randomized)
    const randomIdx = Math.floor(Math.random() * scored.length);
    const drifted = scored[randomIdx];
    return {
      action: 'explore',
      gene_id: drifted.gene.id,
      gene: drifted.gene,
      strategy: drifted.gene.strategy,
      confidence: drifted.confidence * 0.5,
      signals: signalTags,
      coverageScore: drifted.coverageScore,
      alternatives: scored
        .filter((_, i) => i !== randomIdx)
        .slice(0, 3)
        .map((s) => ({ gene_id: s.gene.id, confidence: s.confidence })),
      reason: 'genetic drift exploration',
    };
  }

  // 5. Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    // ── 4-level Fallback Strategy (v1.8.0 P3) ──
    // Level 2: Relax ban threshold (0.18 → 0.05) and re-score
    const relaxedScored = deps.selector.score({
      genes,
      signalTags,
      edgeMap,
      globalEdges: globalEdges as any[],
      wGlobal,
      breakerCheck: (geneId: string) => {
        const data = breakerMap.get(geneId) ?? { state: 'closed', stateAt: null };
        return checkCircuitBreakerData(data.state, data.stateAt);
      },
      semanticCache,
      banThreshold: 0.05,
    });
    if (relaxedScored.length > 0) {
      relaxedScored.sort((a, b) => b.score - a.score);
      const best = relaxedScored[0];
      return {
        action: 'apply_gene',
        gene_id: best.gene.id,
        gene: best.gene,
        strategy: best.gene.strategy,
        confidence: best.confidence * 0.6,
        signals: signalTags,
        coverageScore: best.coverageScore,
        alternatives: [],
        reason: 'fallback: relaxed ban threshold',
        fallback: 'relaxed_ban',
      };
    }

    // Level 3: Hypergraph neighbor expansion (distance 2) — with ban/breaker guard
    if (hypergraphCandidateIds && hypergraphCandidateIds.size > 0) {
      const neighborGene = genes.find((g) => {
        if (!hypergraphCandidateIds!.has(g.id)) return false;
        const data = breakerMap.get(g.id) ?? { state: 'closed', stateAt: null };
        if (!checkCircuitBreakerData(data.state, data.stateAt).allowed) return false;
        const successRate = (g.success_count ?? 0) / Math.max((g.success_count ?? 0) + (g.failure_count ?? 0), 1);
        return successRate >= 0.05;
      });
      if (neighborGene) {
        return {
          action: 'apply_gene',
          gene_id: neighborGene.id,
          gene: neighborGene,
          strategy: neighborGene.strategy,
          confidence: 0.2,
          signals: signalTags,
          coverageScore: 0,
          alternatives: [],
          reason: 'fallback: hypergraph neighbor',
          fallback: 'hypergraph_neighbor',
        };
      }
    }

    // Level 4: Baseline — no gene, suggest creation
    const suggestion = buildCreateSuggestion(signalTags, genes);
    await trackUnmatchedSignals(signalTags, agentId, scope);
    return {
      action: 'create_suggested',
      confidence: 0,
      signals: signalTags,
      reason: 'all fallback levels exhausted; using baseline behavior',
      suggestion,
      fallback: 'baseline',
    };
  }

  const best = scored[0];

  // 5.1 Low-coverage guard: if no gene has meaningful coverage, suggest creation
  // This prevents diagnostic or prefix-only genes from being applied to truly novel signals.
  // When no exact match exists, even prefix matches (coverage ~0.4) are unreliable.
  const hasExactMatch = scored.some((s) => s.matchLayer === 'exact');
  if ((best.coverageScore < 0.3 || (!hasExactMatch && best.coverageScore < 0.5)) && !hasFineMatch) {
    const suggestion = buildCreateSuggestion(signalTags, genes);
    await trackUnmatchedSignals(signalTags, agentId, scope);
    return {
      action: 'create_suggested',
      confidence: 0,
      signals: signalTags,
      reason: `Best gene coverage too low (${Math.round(best.coverageScore * 100)}%), suggesting creation`,
      suggestion,
    };
  }

  // Build rank array with reasons
  const rank = scored.slice(0, 5).map((s) => {
    const layer = s.matchLayer || 'none';
    let reason = '';
    if (layer === 'exact') {
      const matchedSignals = signalTags.filter((t) => s.gene.signals_match.some((p) => matchesPattern(t, p)));
      reason = `Exact match on ${matchedSignals.map((t) => t.type).join(', ')}`;
    } else if (layer === 'prefix') {
      const categories = [...new Set(s.gene.signals_match.map((p) => p.type.split(':')[0]))];
      reason = `Same category: ${categories.join(', ')}`;
    } else if (layer === 'semantic') {
      reason = 'Semantic similarity match';
    }
    if (s.providerMatch) reason += ' + same provider';
    if (s.stageMatch) reason += ' + same stage';
    return {
      gene_id: s.gene.id,
      title: s.gene.title,
      rankScore: Math.round((s.rankScore || s.score) * 1000) / 1000,
      matchLayer: layer,
      confidence: Math.round(s.confidence * 100) / 100,
      reason,
    };
  });

  const result: EvolutionAdvice = {
    action: 'apply_gene',
    gene_id: best.gene.id,
    gene: best.gene,
    strategy: best.gene.strategy,
    confidence: best.confidence,
    signals: signalTags,
    coverageScore: best.coverageScore,
    alternatives: scored.slice(1, 4).map((s) => ({ gene_id: s.gene.id, confidence: s.confidence })),
    rank,
  };

  // Cache successful result for 5s (avoids full DB roundtrip on repeated calls)
  setAnalyzeCache(agentId, signalKey, result);

  return result;
}
