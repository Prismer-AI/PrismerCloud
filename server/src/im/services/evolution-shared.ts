/**
 * Evolution Sub-module: Shared Helpers (no module-level state).
 *
 * Pure functions extracted from `evolution-lifecycle.ts` and
 * `evolution-selector.ts` so the three evolution sub-modules
 * (`lifecycle`, `public`, `selector`) can share them without forming a
 * circular dependency.
 *
 * Original cycles broken (verified by `madge --circular`):
 *   evolution-lifecycle → evolution-public  (invalidatePublicGenesCache)
 *   evolution-lifecycle → evolution-selector (generateTitle)
 *   evolution-public    → evolution-lifecycle (dbGeneToModel, loadSeedGenes)
 *   evolution-selector  → evolution-lifecycle (dbGeneToModel,
 *                                              isCanaryVisibleToAgent,
 *                                              checkCircuitBreakerData)
 *
 * After extraction:
 *   evolution-public    → evolution-shared
 *   evolution-selector  → evolution-shared
 *   evolution-lifecycle → evolution-shared + evolution-public-cache
 * No cycles remain.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { PrismerGene, GeneCategory, GeneVisibility, SignalTag } from '../types/index';
import { normalizeSignals } from './evolution-signals';
import { createModuleLogger } from '../../lib/logger';

const log = createModuleLogger('Evolution');

// ─── Gene Row Mapping ────────────────────────────────────────

/** Convert DB row to PrismerGene interface */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function dbGeneToModel(r: any): PrismerGene {
  // Parse signals_match: prefer signalTags JSON (v0.3.0), fall back to signalId string (compat)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const signals_match: SignalTag[] = (r.signalLinks ?? []).map((l: any) => {
    if (l.signalTags) {
      try {
        const parsed = typeof l.signalTags === 'string' ? JSON.parse(l.signalTags) : l.signalTags;
        if (Array.isArray(parsed) && parsed.length > 0) return parsed[0] as SignalTag;
      } catch {
        /* fall through */
      }
    }
    // Backward compat: signalId is the signal type string
    return { type: l.signalId } as SignalTag;
  });

  return {
    type: 'Gene',
    id: r.id,
    category: r.category as GeneCategory,
    title: r.title || undefined,
    description: r.description || undefined,
    visibility: r.visibility as GeneVisibility,
    signals_match,
    preconditions: JSON.parse(r.preconditions || '[]'),
    strategy: JSON.parse(r.strategySteps || '[]'),
    constraints: JSON.parse(r.constraints || '{}'),
    success_count: r.successCount ?? 0,
    failure_count: r.failureCount ?? 0,
    last_used_at: r.lastUsedAt?.toISOString() ?? null,
    created_by: r.ownerAgentId,
    parentGeneId: r.parentId ?? null,
    forkCount: r.forkCount ?? 0,
    generation: r.generation ?? 1,
    qualityScore: r.qualityScore ?? 0.01,
  };
}

// ─── Seed Genes (JSON-backed) ─────────────────────────────────

/** Load seed genes from JSON files (cached) */
let _seedGenesCache: PrismerGene[] | null = null;
export function loadSeedGenes(): PrismerGene[] {
  if (_seedGenesCache) return _seedGenesCache;
  try {
    // Use process.cwd() because __dirname may be wrong in Next.js compiled context
    const dataDir = resolve(process.cwd(), 'src/im/data');
    const seedPath = resolve(dataDir, 'seed-genes.json');
    const extPath = resolve(dataDir, 'seed-genes-external.json');
    const seeds: PrismerGene[] = JSON.parse(readFileSync(seedPath, 'utf-8'));
    let externals: PrismerGene[] = [];
    try {
      externals = JSON.parse(readFileSync(extPath, 'utf-8'));
    } catch {
      /* optional */
    }
    _seedGenesCache = [...seeds, ...externals].map((g) => ({
      ...g,
      type: 'Gene' as const,
      // v0.3.0: normalize signals_match from string[] (JSON) to SignalTag[]
      signals_match: normalizeSignals((g.signals_match || []) as string[] | SignalTag[]),
      preconditions: g.preconditions || [],
      constraints: g.constraints || { max_credits: 10, max_retries: 3, required_capabilities: [] },
      success_count: g.success_count || 0,
      failure_count: g.failure_count || 0,
      last_used_at: g.last_used_at || null,
    }));
    log.info(`Loaded ${_seedGenesCache.length} seed genes`);
    return _seedGenesCache;
  } catch (err) {
    log.error({ err }, 'Failed to load seed genes');
    return [];
  }
}

// ─── Canary Visibility ───────────────────────────────────────

/**
 * Check if a canary gene is visible to a specific agent.
 * Creator always sees it. 5% of other agents see it (hash-based).
 */
export function isCanaryVisibleToAgent(geneOwnerAgentId: string, viewerAgentId: string): boolean {
  if (geneOwnerAgentId === viewerAgentId) return true;
  // Deterministic 5% sample: hash agentId and check modulo
  let hash = 0;
  for (let i = 0; i < viewerAgentId.length; i++) {
    hash = ((hash << 5) - hash + viewerAgentId.charCodeAt(i)) | 0;
  }
  return Math.abs(hash % 20) === 0; // 5% = 1/20
}

// ─── Circuit Breaker — pure state check ──────────────────────
//
// State stored in im_genes.breakerState / breakerFailCount / breakerStateAt.
// selectGene() reads breaker data from already-loaded gene rows (zero extra
// queries). updateCircuitBreaker() (in evolution-lifecycle.ts) writes to DB
// so all K8s pods share the same state.

const BREAKER_COOLDOWN_MS = 60 * 1000; // 1 minute

/**
 * Pure state-check using already-loaded DB fields (no DB query).
 * Called by selectGene() which passes data from the pre-fetched gene rows.
 */
export function checkCircuitBreakerData(
  breakerState: string,
  breakerStateAt: Date | null,
): { allowed: boolean; state: string } {
  if (!breakerState || breakerState === 'closed') {
    return { allowed: true, state: 'closed' };
  }
  if (breakerState === 'open') {
    // Cooldown elapsed → treat as half_open (allow one probe)
    if (Date.now() - (breakerStateAt?.getTime() ?? 0) > BREAKER_COOLDOWN_MS) {
      return { allowed: true, state: 'half_open' };
    }
    return { allowed: false, state: 'open' };
  }
  // half_open: allow one probe
  return { allowed: true, state: 'half_open' };
}

// ─── Title / Category inference ──────────────────────────────

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
