/**
 * Evolution Sub-module: Gene Lifecycle
 *
 * Gene CRUD (load, save, delete, create helper),
 * Publish/Import/Fork flows,
 * Safety layer (canary promotion, gene demotion, circuit breaker, freeze mode),
 * Seed gene loading and initialization.
 */

import prisma from '../db';
import type { PrismerGene, GeneCategory, GeneVisibility, SignalTag } from '../types/index';
import type { CreditService } from './credit.service';
import type { AchievementService } from './achievement.service';
import { invalidatePublicGenesCache } from './evolution-public';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { normalizeSignals, tagCoverageScore } from './evolution-signals';
import { generateTitle } from './evolution-selector';
import { bumpGeneOnSuccess, decayGeneOnFailure } from './quality-score.service';
import { createModuleLogger } from '../../lib/logger';

const log = createModuleLogger('Evolution');

// ===== Gene Store (uses im_genes table) =====

/** Convert DB row to PrismerGene interface */
export function dbGeneToModel(r: any): PrismerGene {
  // Parse signals_match: prefer signalTags JSON (v0.3.0), fall back to signalId string (compat)
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

/**
 * Load all genes owned by an agent from im_genes table.
 */
export async function loadGenes(agentId: string, scope = 'global'): Promise<PrismerGene[]> {
  const rows = await prisma.iMGene.findMany({
    where: { ownerAgentId: agentId, scope },
    include: { signalLinks: true },
  });
  return rows.map((r: any) => dbGeneToModel(r));
}

/**
 * Save a gene to im_genes table. Upserts by ID.
 */
export async function saveGene(agentId: string, gene: PrismerGene, scope = 'global'): Promise<void> {
  await prisma.iMGene.upsert({
    where: { id: gene.id },
    update: {
      category: gene.category,
      title: gene.title || '',
      description: gene.description || '',
      strategySteps: JSON.stringify(gene.strategy),
      preconditions: JSON.stringify(gene.preconditions),
      constraints: JSON.stringify(gene.constraints),
      visibility: gene.visibility || 'private',
      successCount: gene.success_count,
      failureCount: gene.failure_count,
      lastUsedAt: gene.last_used_at ? new Date(gene.last_used_at) : null,
      parentId: gene.parentGeneId,
      forkCount: gene.forkCount ?? 0,
      generation: gene.generation ?? 1,
    },
    create: {
      id: gene.id,
      ownerAgentId: agentId,
      category: gene.category,
      title: gene.title || '',
      description: gene.description || '',
      strategySteps: JSON.stringify(gene.strategy),
      preconditions: JSON.stringify(gene.preconditions),
      constraints: JSON.stringify(gene.constraints),
      visibility: gene.visibility || 'private',
      successCount: gene.success_count,
      failureCount: gene.failure_count,
      parentId: gene.parentGeneId,
      forkCount: gene.forkCount ?? 0,
      generation: gene.generation ?? 1,
      scope,
    },
  });

  // Upsert signal links (v0.3.0: persist both signalId=type and signalTags=SignalTag JSON)
  const existingLinks = await prisma.iMGeneSignal.findMany({ where: { geneId: gene.id } });
  const existingSignalIds = new Set<string>(existingLinks.map((l: any) => l.signalId as string));
  const newTagsByType = new Map<string, SignalTag>(gene.signals_match.map((t) => [t.type, t]));

  // Delete signals that no longer exist
  const toDelete = [...existingSignalIds].filter((id) => !newTagsByType.has(id));
  if (toDelete.length > 0) {
    await prisma.iMGeneSignal.deleteMany({
      where: { geneId: gene.id, signalId: { in: toDelete } },
    });
  }

  // Upsert (add new + update existing with latest signalTags)
  for (const [signalId, tag] of newTagsByType.entries()) {
    const signalTagsJson = JSON.stringify([tag]);
    if (existingSignalIds.has(signalId)) {
      // Update signalTags if the tag has more than just 'type' (new format)
      const hasExtraFields = Object.keys(tag).filter((k) => k !== 'type' && tag[k] !== undefined).length > 0;
      if (hasExtraFields) {
        await prisma.iMGeneSignal
          .update({
            where: { geneId_signalId: { geneId: gene.id, signalId } },
            data: { signalTags: signalTagsJson },
          })
          .catch(() => {}); // Non-critical: old schema might not have this column
      }
    } else {
      await prisma.iMGeneSignal
        .create({
          data: { geneId: gene.id, signalId, signalTags: signalTagsJson },
        })
        .catch(async () => {
          // Fallback without signalTags (old schema)
          await prisma.iMGeneSignal
            .create({
              data: { geneId: gene.id, signalId },
            })
            .catch(() => {});
        });
    }
  }
}

/**
 * Delete a gene from im_genes table.
 */
export async function deleteGene(agentId: string, geneId: string): Promise<boolean> {
  const gene = await prisma.iMGene.findFirst({
    where: { id: geneId, ownerAgentId: agentId },
  });
  if (!gene) return false;

  await prisma.iMGene.delete({ where: { id: geneId } });
  invalidatePublicGenesCache();
  return true;
}

/**
 * Create a new gene with validation.
 */
export function createGene(input: {
  category: GeneCategory;
  signals_match: string[] | SignalTag[];
  strategy: string[];
  preconditions?: string[];
  constraints?: Partial<PrismerGene['constraints']>;
  created_by: string;
  title?: string;
  description?: string;
}): PrismerGene {
  const id = `gene_${input.category}_${Date.now().toString(36)}`;
  const tags = normalizeSignals(input.signals_match as string[] | SignalTag[]);
  return {
    type: 'Gene',
    id,
    category: input.category,
    title: input.title || generateTitle(tags),
    description: input.description,
    signals_match: normalizeSignals(input.signals_match as string[] | SignalTag[]),
    preconditions: input.preconditions ?? [],
    strategy: input.strategy,
    constraints: {
      max_credits: input.constraints?.max_credits ?? 100,
      max_retries: input.constraints?.max_retries ?? 3,
      required_capabilities: input.constraints?.required_capabilities ?? [],
    },
    success_count: 0,
    failure_count: 0,
    last_used_at: null,
    created_by: input.created_by,
  };
}

// ===== Publish / Import / Fork =====

/** POST /genes/:id/publish — Publish a gene to public market (via im_genes table) */
export async function publishGene(
  agentId: string,
  geneId: string,
  deps: { creditService?: CreditService; achievementService?: AchievementService },
): Promise<PrismerGene | null> {
  const gene = await prisma.iMGene.findFirst({
    where: { id: geneId, ownerAgentId: agentId },
    include: { signalLinks: true },
  });
  if (!gene || gene.visibility === 'published' || gene.visibility === 'seed') return null;

  await prisma.iMGene.update({
    where: { id: geneId },
    data: { visibility: 'published' },
  });
  invalidatePublicGenesCache();

  // Increment owner's publishCount
  await prisma.iMUser
    .update({
      where: { id: gene.ownerAgentId },
      data: { publishCount: { increment: 1 } },
    })
    .catch(() => {});

  // Credit reward for publishing (+10 cr)
  if (deps.creditService) {
    try {
      await deps.creditService.credit(agentId, 10, 'evolution_reward', `Gene published: ${geneId}`);
    } catch (err) {
      log.warn(`Publish credit reward failed: ${(err as Error).message}`);
    }
  }

  // Achievement check
  if (deps.achievementService) {
    try {
      await deps.achievementService.checkAndUnlock(agentId, { event: 'publish' });
    } catch {}
  }

  log.info(`Gene ${geneId} published by ${agentId}`);
  return dbGeneToModel({ ...gene, visibility: 'published' });
}

/** Publish gene directly to 'published' (skip canary). For MVP/admin use. */
export async function publishGeneDirect(agentId: string, geneId: string): Promise<PrismerGene | null> {
  const gene = await prisma.iMGene.findFirst({
    where: { id: geneId, ownerAgentId: agentId },
    include: { signalLinks: true },
  });
  if (!gene || gene.visibility === 'published' || gene.visibility === 'seed') return null;

  await prisma.iMGene.update({
    where: { id: geneId },
    data: { visibility: 'published' },
  });
  invalidatePublicGenesCache();

  // Increment owner's publishCount
  await prisma.iMUser
    .update({
      where: { id: gene.ownerAgentId },
      data: { publishCount: { increment: 1 } },
    })
    .catch(() => {});

  log.info(`Gene ${geneId} published directly (skipCanary) by ${agentId}`);
  return dbGeneToModel({ ...gene, visibility: 'published' });
}

/**
 * Publish gene → canary (not directly published).
 * Canary genes are visible to creator + 5% of agents.
 */
export async function publishGeneAsCanary(agentId: string, geneId: string): Promise<PrismerGene | null> {
  const gene = await prisma.iMGene.findFirst({
    where: { id: geneId, ownerAgentId: agentId },
    include: { signalLinks: true },
  });
  if (!gene || gene.visibility === 'seed') return null;

  await prisma.iMGene.update({
    where: { id: geneId },
    data: { visibility: 'canary' },
  });
  invalidatePublicGenesCache();

  // Increment owner's publishCount
  await prisma.iMUser
    .update({
      where: { id: gene.ownerAgentId },
      data: { publishCount: { increment: 1 } },
    })
    .catch(() => {});

  return dbGeneToModel({ ...gene, visibility: 'canary' });
}

/** POST /genes/import — Import a public gene to own agent */
export async function importPublicGene(
  agentId: string,
  geneId: string,
  deps: {
    creditService?: CreditService;
    achievementService?: AchievementService;
    getPublicGeneDetail: (geneId: string) => Promise<PrismerGene | null>;
  },
): Promise<PrismerGene | null> {
  const sourceGene = await deps.getPublicGeneDetail(geneId);
  if (!sourceGene) return null;

  // Clone with unique ID and reset stats
  const imported: PrismerGene = {
    ...sourceGene,
    id: `${sourceGene.id}_imp_${agentId.slice(-6)}`,
    parentGeneId: sourceGene.id,
    generation: (sourceGene.generation || 0) + 1,
    visibility: 'private',
    success_count: 0,
    failure_count: 0,
    last_used_at: null,
    created_by: agentId,
  };

  // Save to im_genes table
  await saveGene(agentId, imported);

  // Credit reward for original author (+5 cr) when gene is adopted
  if (deps.creditService && sourceGene.created_by && sourceGene.created_by !== agentId) {
    try {
      await deps.creditService.credit(
        sourceGene.created_by,
        5,
        'evolution_reward',
        `Gene adopted: ${geneId} by ${agentId.slice(-6)}`,
      );
    } catch (err) {
      log.warn(`Adoption credit reward failed: ${(err as Error).message}`);
    }
  }

  // Achievement check (for the original author: gene_adopted)
  if (deps.achievementService && sourceGene.created_by && sourceGene.created_by !== agentId) {
    try {
      await deps.achievementService.checkAndUnlock(sourceGene.created_by, {
        event: 'import',
        originalAuthorId: sourceGene.created_by,
      });
    } catch {}
  }

  log.info(`Gene ${geneId} imported by ${agentId} as ${imported.id}`);
  return imported;
}

/** POST /genes/fork — Fork a public gene with optional modifications */
export async function forkGene(
  agentId: string,
  sourceGeneId: string,
  modifications: { title?: string; signals_match?: string[] | SignalTag[]; strategy?: string[] } | undefined,
  deps: { getPublicGeneDetail: (geneId: string) => Promise<PrismerGene | null> },
): Promise<PrismerGene | null> {
  const sourceGene = await deps.getPublicGeneDetail(sourceGeneId);
  if (!sourceGene) return null;

  const forkedGene: PrismerGene = {
    ...sourceGene,
    id: `${sourceGene.id}_fork_${agentId.slice(-6)}_${Date.now().toString(36)}`,
    parentGeneId: sourceGene.id,
    generation: (sourceGene.generation || 0) + 1,
    forkCount: 0,
    visibility: 'private',
    success_count: 0,
    failure_count: 0,
    last_used_at: null,
    created_by: agentId,
  };

  if (modifications?.title) forkedGene.title = modifications.title;
  if (modifications?.signals_match)
    forkedGene.signals_match = normalizeSignals(modifications.signals_match as string[] | SignalTag[]);
  if (modifications?.strategy) forkedGene.strategy = modifications.strategy;

  await saveGene(agentId, forkedGene);

  // Increment parent's forkCount in im_genes table
  try {
    await prisma.iMGene.update({
      where: { id: sourceGeneId },
      data: { forkCount: { increment: 1 } },
    });
    // Bump parent's quality score on fork
    const { bumpGeneOnFork } = await import('./quality-score.service');
    bumpGeneOnFork(sourceGeneId).catch(() => {});
  } catch {
    // Skip silently if parent gene not in table (seed genes etc.)
  }

  log.info(`Gene ${sourceGeneId} forked by ${agentId} as ${forkedGene.id}`);
  return forkedGene;
}

// ===== Safety Layer: Canary + Circuit Breaker + Freeze Mode =====

/**
 * Check if a canary gene should be promoted to published.
 * Conditions: ≥3 agents, ≥20 executions, >50% success, ≥48h old.
 */
export async function checkCanaryPromotion(geneId: string): Promise<{ promote: boolean; reason: string }> {
  const gene = await prisma.iMGene.findUnique({ where: { id: geneId } });
  if (!gene || gene.visibility !== 'canary') {
    return { promote: false, reason: 'not a canary gene' };
  }

  // Check age (≥48h)
  const ageMs = Date.now() - gene.createdAt.getTime();
  if (ageMs < 48 * 60 * 60 * 1000) {
    return { promote: false, reason: `too young (${Math.round(ageMs / 3600000)}h < 48h)` };
  }

  // Check agent count
  const agentCount = await prisma.iMEvolutionEdge.groupBy({
    by: ['ownerAgentId'],
    where: { geneId },
  });
  if (agentCount.length < 3) {
    return { promote: false, reason: `insufficient agents (${agentCount.length} < 3)` };
  }

  // Check execution count and success rate
  const totalExec = gene.successCount + gene.failureCount;
  if (totalExec < 20) {
    return { promote: false, reason: `insufficient executions (${totalExec} < 20)` };
  }
  const successRate = gene.successCount / totalExec;
  if (successRate <= 0.5) {
    return { promote: false, reason: `low success rate (${Math.round(successRate * 100)}% ≤ 50%)` };
  }

  // All conditions met → promote
  await prisma.iMGene.update({
    where: { id: geneId },
    data: { visibility: 'published' },
  });

  // Increment owner's publishCount on canary → published promotion
  await prisma.iMUser
    .update({
      where: { id: gene.ownerAgentId },
      data: { publishCount: { increment: 1 } },
    })
    .catch(() => {});

  log.info(
    `Canary gene ${geneId} promoted to published (${Math.round(successRate * 100)}%, ${totalExec} runs, ${agentCount.length} agents)`,
  );
  return { promote: true, reason: 'all conditions met' };
}

/**
 * Check if a published gene should be quarantined.
 * Conditions: consecutive failures ≥ 10 or success rate < 20% in last 50 runs.
 */
export async function checkGeneDemotion(geneId: string): Promise<{ demote: boolean; reason: string }> {
  const gene = await prisma.iMGene.findUnique({ where: { id: geneId } });
  if (!gene || gene.visibility === 'seed' || gene.visibility === 'quarantined') {
    return { demote: false, reason: 'not demotable' };
  }

  // Check last 50 capsules — select ownerAgentId to enforce distinct-agent anti-abuse check
  const recentCapsules = await prisma.iMEvolutionCapsule.findMany({
    where: { geneId },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { outcome: true, ownerAgentId: true },
  });

  if (recentCapsules.length < 10) {
    return { demote: false, reason: 'insufficient data' };
  }

  // Anti-abuse: require ≥3 distinct agents in the sample before allowing auto-quarantine.
  // Prevents a single rogue agent (or coordinated pair) from quarantining any gene
  // by submitting fake failure capsules.
  const distinctAgents = new Set(recentCapsules.map((c: any) => c.ownerAgentId));
  if (distinctAgents.size < 3) {
    return { demote: false, reason: `insufficient distinct agents (${distinctAgents.size} < 3 required)` };
  }

  // Check consecutive failures (from most recent)
  let consecutiveFails = 0;
  for (const c of recentCapsules) {
    if (c.outcome === 'failed') consecutiveFails++;
    else break;
  }
  if (consecutiveFails >= 10) {
    await prisma.iMGene.update({ where: { id: geneId }, data: { visibility: 'quarantined' } });
    log.info(`Gene ${geneId} quarantined: ${consecutiveFails} consecutive failures from ${distinctAgents.size} agents`);
    return { demote: true, reason: `${consecutiveFails} consecutive failures` };
  }

  // Check success rate in last 50
  const successes = recentCapsules.filter((c: any) => c.outcome === 'success').length;
  const rate = successes / recentCapsules.length;
  if (rate < 0.2) {
    await prisma.iMGene.update({ where: { id: geneId }, data: { visibility: 'quarantined' } });
    log.info(`Gene ${geneId} quarantined: ${Math.round(rate * 100)}% success rate from ${distinctAgents.size} agents`);
    return { demote: true, reason: `success rate ${Math.round(rate * 100)}% < 20%` };
  }

  return { demote: false, reason: 'healthy' };
}

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

// ─── Circuit Breaker (per-Gene, DB-persisted — multi-pod safe) ───
//
// State stored in im_genes.breakerState / breakerFailCount / breakerStateAt.
// selectGene() reads breaker data from already-loaded gene rows (zero extra queries).
// updateCircuitBreaker() writes to DB so all K8s pods share the same state.

const BREAKER_FAILURE_THRESHOLD = 5;
const BREAKER_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
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

/**
 * Update circuit breaker state in DB after a gene execution outcome.
 * Async DB write — shared across all pods.
 *
 * @param preloaded - Pre-loaded breaker state from the ACL check (avoids duplicate DB query).
 *                    Counter increment is always atomic via Prisma increment.
 */
export async function updateCircuitBreaker(
  geneId: string,
  isSuccess: boolean,
  preloaded: { breakerState: string; breakerFailCount: number; breakerStateAt: Date | null },
): Promise<void> {
  const now = new Date();
  const { breakerState, breakerFailCount, breakerStateAt } = preloaded;

  if (isSuccess) {
    if (breakerState === 'open') {
      // Recovery or successful probe → reset to closed
      await prisma.iMGene.update({
        where: { id: geneId },
        data: { breakerState: 'closed', breakerFailCount: 0, breakerStateAt: now },
      });
    } else if (breakerFailCount > 0) {
      // Partial recovery in closed state: atomic decrement with floor guard
      await prisma.iMGene.updateMany({
        where: { id: geneId, breakerFailCount: { gt: 0 } },
        data: { breakerFailCount: { decrement: 1 } },
      });
    }
    return;
  }

  // Failure path
  const windowExpired = Date.now() - (breakerStateAt?.getTime() ?? 0) > BREAKER_WINDOW_MS;
  if (windowExpired && breakerState === 'closed') {
    // Stale window — reset counter and start a fresh window
    await prisma.iMGene.update({
      where: { id: geneId },
      data: { breakerFailCount: 1, breakerStateAt: now },
    });
    return;
  }

  // 'open' + cooldown elapsed means this was a half_open probe. Probe failed → reset cooldown.
  // Breaker stays open; another probe is allowed after one more full cooldown cycle.
  const isProbeFailure = breakerState === 'open' && Date.now() - (breakerStateAt?.getTime() ?? 0) > BREAKER_COOLDOWN_MS;
  if (isProbeFailure) {
    await prisma.iMGene.update({
      where: { id: geneId },
      data: { breakerStateAt: now },
    });
    return;
  }

  // Atomically increment, read post-increment value to check threshold
  const updated = await prisma.iMGene.update({
    where: { id: geneId },
    data: { breakerFailCount: { increment: 1 } },
    select: { breakerFailCount: true },
  });
  if (updated.breakerFailCount >= BREAKER_FAILURE_THRESHOLD && breakerState === 'closed') {
    await prisma.iMGene.update({
      where: { id: geneId },
      data: { breakerState: 'open', breakerStateAt: now },
    });
    log.info(`Circuit breaker OPEN for gene ${geneId} (${updated.breakerFailCount} failures in window)`);
  }
}

// ─── Freeze Mode (global, DB-computed + TTL cache — multi-pod safe) ───
//
// Freeze state is computed by aggregating im_evolution_capsules in a 5-minute
// sliding window (DB query). The result is cached locally for 30s per pod to
// avoid a DB hit on every recordOutcome() call. This makes freeze detection
// eventually consistent across pods — acceptable for a cascade-protection mechanism.

const FREEZE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const FREEZE_FAILURE_RATE = 0.8; // 80% failure rate to freeze
const FREEZE_MIN_CAPSULES = 20; // minimum sample before triggering
const UNFREEZE_FAILURE_RATE = 0.3; // below 30% → unfreeze
const FREEZE_CACHE_TTL_MS = 30_000; // recompute at most every 30s

// Module-level freeze cache (shared state within this module)
const freezeCache = { isFrozen: false, computedAt: 0 };

/**
 * Recompute freeze state from DB aggregate, update local TTL cache.
 * Called from recordOutcome() after edge update.
 * The current capsule is not yet inserted — intentional (consistent with prior behavior).
 */
export async function updateFreezeMode(): Promise<boolean> {
  const now = Date.now();

  // Only recompute when cache is stale
  if (now - freezeCache.computedAt < FREEZE_CACHE_TTL_MS) {
    return freezeCache.isFrozen;
  }

  const cutoff = new Date(now - FREEZE_WINDOW_MS);
  const [total, failures] = await Promise.all([
    prisma.iMEvolutionCapsule.count({ where: { createdAt: { gte: cutoff } } }),
    prisma.iMEvolutionCapsule.count({ where: { createdAt: { gte: cutoff }, outcome: 'failed' } }),
  ]);

  const failureRate = total >= FREEZE_MIN_CAPSULES ? failures / total : 0;
  const wasFrozen = freezeCache.isFrozen;
  const nowFrozen = wasFrozen
    ? failureRate > UNFREEZE_FAILURE_RATE // stay frozen until rate drops below 30%
    : failureRate > FREEZE_FAILURE_RATE; // freeze when rate exceeds 80%

  freezeCache.isFrozen = nowFrozen;
  freezeCache.computedAt = now;

  if (!wasFrozen && nowFrozen) {
    log.warn(
      `FREEZE MODE activated: ${Math.round(failureRate * 100)}% failure rate over ${total} capsules (5min window)`,
    );
  } else if (wasFrozen && !nowFrozen) {
    log.info(`FREEZE MODE deactivated (failure rate now ${Math.round(failureRate * 100)}%)`);
  }

  return nowFrozen;
}

/** Returns the locally-cached freeze state (may be up to 30s stale — acceptable). */
export function isFrozen(): boolean {
  return freezeCache.isFrozen;
}

// ─── Provider-scoped Freeze (GAP7) ───
//
// DB-backed + TTL cache — consistent architecture with Global Freeze.
// Reads from im_evolution_capsules (same source of truth, same multi-pod safety).
// metadata field is queried via JSON string match: '{"provider":"openai",...}'.

/** TTL cache for per-provider frozen state (30s, same as global) */
const providerFreezeCache = new Map<
  string,
  {
    isFrozen: boolean;
    computedAt: number;
  }
>();

const PROVIDER_FREEZE_MIN_CAPSULES = 10;

/**
 * Check whether a provider is currently frozen.
 * Queries DB with TTL cache — consistent with updateFreezeMode() global pattern.
 * Called from recordOutcome() when capsule metadata contains a provider tag.
 */
export async function checkProviderFrozen(provider: string): Promise<boolean> {
  const cached = providerFreezeCache.get(provider);
  const now = Date.now();
  if (cached && now - cached.computedAt < FREEZE_CACHE_TTL_MS) {
    return cached.isFrozen;
  }

  const cutoff = new Date(now - FREEZE_WINDOW_MS);

  const [total, failures] = await Promise.all([
    prisma.iMEvolutionCapsule.count({
      where: { createdAt: { gte: cutoff }, provider },
    }),
    prisma.iMEvolutionCapsule.count({
      where: { createdAt: { gte: cutoff }, outcome: 'failed', provider },
    }),
  ]);

  const failureRate = total >= PROVIDER_FREEZE_MIN_CAPSULES ? failures / total : 0;
  const wasFrozen = cached?.isFrozen ?? false;
  const nowFrozen = wasFrozen
    ? failureRate > UNFREEZE_FAILURE_RATE // stay frozen until drops below 30%
    : failureRate > FREEZE_FAILURE_RATE; // freeze when exceeds 80%

  providerFreezeCache.set(provider, { isFrozen: nowFrozen, computedAt: now });

  if (!wasFrozen && nowFrozen) {
    log.warn(
      `PROVIDER FREEZE: ${provider} — ${Math.round(failureRate * 100)}% failure rate (${total} capsules in 5min)`,
    );
  } else if (wasFrozen && !nowFrozen) {
    log.info(`PROVIDER FREEZE deactivated: ${provider} (failure rate now ${Math.round(failureRate * 100)}%)`);
  }

  return nowFrozen;
}

/** Check cached provider frozen state (non-async, may be stale up to 30s) */
export function isProviderFrozen(provider: string): boolean {
  return providerFreezeCache.get(provider)?.isFrozen ?? false;
}

// ===== Seed Gene Initialization =====

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

/**
 * Ensure seed genes exist in im_genes table (global, visibility='seed').
 * Called once at server startup. Idempotent.
 */
export async function ensureSeedGenesInTable(): Promise<void> {
  const seedGenes = loadSeedGenes();
  if (seedGenes.length === 0) return;

  for (const g of seedGenes) {
    try {
      await prisma.iMGene.upsert({
        where: { id: g.id },
        update: {
          // Sync strategy + signals on every startup so seed-genes.json changes take effect
          strategySteps: JSON.stringify(g.strategy),
          preconditions: JSON.stringify(g.preconditions || []),
          constraints: JSON.stringify(g.constraints || {}),
          title: g.title || '',
          description: g.description || '',
          qualityScore: 1.0,
        },
        create: {
          id: g.id,
          ownerAgentId: 'system:seed',
          category: g.category,
          title: g.title || '',
          description: g.description || '',
          strategySteps: JSON.stringify(g.strategy),
          preconditions: JSON.stringify(g.preconditions || []),
          constraints: JSON.stringify(g.constraints || {}),
          visibility: 'seed',
          generation: 1,
          qualityScore: 1.0,
        },
      });
      // Re-sync signal links: delete stale, insert current
      await prisma.iMGeneSignal.deleteMany({ where: { geneId: g.id } });
      for (const tag of g.signals_match ?? []) {
        try {
          await prisma.iMGeneSignal.create({
            data: { geneId: g.id, signalId: tag.type, signalTags: JSON.stringify([tag]) },
          });
        } catch {
          /* skip duplicate */
        }
      }
    } catch {
      // Skip duplicates
    }
  }
  log.info(`Synced ${seedGenes.length} seed genes in im_genes table`);
}

/**
 * Seed initial genes for a newly registered agent.
 * Clones seed genes into im_genes table with agent-specific IDs.
 */
export async function seedGenesForNewAgent(agentId: string): Promise<void> {
  const seedGenes = loadSeedGenes();
  if (seedGenes.length === 0) return;

  // Check if agent already has genes in the table
  const existingCount = await prisma.iMGene.count({ where: { ownerAgentId: agentId } });
  if (existingCount > 0) return;

  // Batch insert genes + signal links
  for (const g of seedGenes) {
    const geneId = `${g.id}_${agentId.slice(-6)}`;
    try {
      await prisma.iMGene.create({
        data: {
          id: geneId,
          ownerAgentId: agentId,
          category: g.category,
          title: g.title || '',
          description: g.description || '',
          strategySteps: JSON.stringify(g.strategy),
          preconditions: JSON.stringify(g.preconditions || []),
          constraints: JSON.stringify(g.constraints || {}),
          visibility: 'private',
          generation: 1,
        },
      });
      // Insert signal links (v0.3.0: signals_match is SignalTag[], use .type for signalId)
      for (const tag of g.signals_match) {
        try {
          await prisma.iMGeneSignal.create({
            data: { geneId, signalId: tag.type, signalTags: JSON.stringify([tag]) },
          });
        } catch {
          /* skip duplicate */
        }
      }
    } catch {
      // Skip duplicates silently
    }
  }

  log.info(`Seeded ${seedGenes.length} genes for agent ${agentId}`);
}

/**
 * Scan all published genes and grant credit rewards when usage milestones are crossed.
 * Now reads directly from im_genes table.
 */
export async function scanCreditReturns(): Promise<number> {
  const MILESTONES: Array<{ threshold: number; reward: number }> = [
    { threshold: 100, reward: 500 },
    { threshold: 1000, reward: 5000 },
  ];

  const publishedGenes = await prisma.iMGene.findMany({
    where: { visibility: { in: ['published', 'canary'] } },
  });

  let rewardsGranted = 0;

  for (const gene of publishedGenes) {
    const successCount = await prisma.iMEvolutionCapsule.count({
      where: { geneId: gene.id, outcome: 'success' },
    });

    const constraints = JSON.parse(gene.constraints || '{}');
    const milestonesPaid: number[] = constraints.credit_milestones_paid || [];

    for (const milestone of MILESTONES) {
      if (successCount >= milestone.threshold && !milestonesPaid.includes(milestone.threshold)) {
        const imUser = await prisma.iMUser.findUnique({
          where: { id: gene.ownerAgentId },
          select: { userId: true },
        });

        if (imUser?.userId) {
          try {
            const { addCredits } = await import('@/lib/db-credits');
            await addCredits(
              parseInt(imUser.userId, 10),
              milestone.reward,
              'bonus',
              `Gene "${gene.id}" reached ${milestone.threshold} successful uses`,
              'evolution_milestone',
              `${gene.id}_${milestone.threshold}`,
            );
            log.info(`Granted ${milestone.reward} credits for gene ${gene.id}`);
          } catch (err) {
            log.error({ err }, `Failed to grant credits for gene ${gene.id}`);
            continue;
          }
        }

        milestonesPaid.push(milestone.threshold);
        constraints.credit_milestones_paid = milestonesPaid;
        await prisma.iMGene.update({
          where: { id: gene.id },
          data: { constraints: JSON.stringify(constraints) },
        });
        rewardsGranted++;
      }
    }
  }

  return rewardsGranted;
}

/**
 * Update gene success/failure stats in im_genes table.
 */
export async function updateGeneStats(
  agentId: string,
  geneId: string,
  isSuccess: boolean,
  score?: number,
): Promise<void> {
  try {
    // Only update global gene stats if the agent owns the gene.
    // Non-owners benefit from public genes via per-agent edges (one-way consumption).
    const gene = await prisma.iMGene.findUnique({
      where: { id: geneId },
      select: { ownerAgentId: true },
    });
    if (!gene || gene.ownerAgentId !== agentId) return;

    await prisma.iMGene.update({
      where: { id: geneId },
      data: {
        successCount: isSuccess ? { increment: 1 } : undefined,
        failureCount: isSuccess ? undefined : { increment: 1 },
        lastUsedAt: new Date(),
      },
    });
    // Update quality score based on outcome
    if (isSuccess) {
      bumpGeneOnSuccess(geneId).catch(() => {});
    } else {
      decayGeneOnFailure(geneId).catch(() => {});
    }
  } catch {
    // Gene might not exist in table yet (legacy data) — ignore
  }
}
