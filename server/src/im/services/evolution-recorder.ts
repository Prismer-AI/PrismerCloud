/**
 * Evolution Sub-module: Outcome Recording
 *
 * recordOutcome() method logic, capsule quality computation,
 * rate decay, and adherence scoring.
 */

import prisma from '../db';
import type { PrismerGene, SignalTag, EvolutionRecordInput } from '../types/index';
import type { CreditService } from './credit.service';
import type { AchievementService } from './achievement.service';
import { normalizeSignals, computeSignalKey, extractSignalType } from './evolution-signals';
import { getAgentMode, writeHypergraphLayer } from './evolution-hypergraph';
import {
  isCanaryVisibleToAgent,
  updateCircuitBreaker,
  updateFreezeMode,
  isFrozen,
  checkProviderFrozen,
  updateGeneStats,
  checkCanaryPromotion,
  checkGeneDemotion,
} from './evolution-lifecycle';
import { adjustPersonality } from './evolution-personality';
import { bumpGeneOnSuccess, decayGeneOnFailure } from './quality-score.service';
import { updateBimodalityIndex, invalidateAnalyzeCache } from './evolution-selector';
import { callLLM } from './evolution-distill';
import { KnowledgeLinkService } from './knowledge-link.service';
import type { MemoryService } from './memory.service';

// ===== Capsule Quality Evaluation =====

/**
 * Compute information value of a capsule before recording.
 * High-quality capsules (new info, surprise, diverse agents) update edges.
 * Low-quality capsules (repeat data, no surprise) only append to audit log.
 */
async function computeCapsuleQuality(
  agentId: string,
  geneId: string,
  signalKey: string,
  outcome: string,
  existingEdge: { successCount: number; failureCount: number } | null,
  recentSameCount: number,
  strategyUsed?: string[],
): Promise<{ quality: number; reasons: string[] }> {
  let quality = 0.5;
  const reasons: string[] = [];

  // Information gain: first-time data is more valuable
  const isFirstForAgent = !existingEdge;
  if (isFirstForAgent) {
    quality += 0.15;
    reasons.push('first-use-for-agent');
  }

  // Check if this signal has ever been seen globally
  const globalEdgeCount = await prisma.iMEvolutionEdge.count({
    where: { signalKey, geneId },
  });
  if (globalEdgeCount === 0) {
    quality += 0.2;
    reasons.push('novel-signal-gene-pair');
  }

  // Agent diversity: how many distinct agents have used this gene?
  const distinctAgents = await prisma.iMEvolutionEdge.groupBy({
    by: ['ownerAgentId'],
    where: { geneId },
  });
  const agentCount = distinctAgents.length;
  if (agentCount < 3) {
    quality += 0.1;
    reasons.push('scarce-gene-data');
  } else if (agentCount >= 10) {
    quality -= 0.1;
    reasons.push('well-validated-gene');
  }

  // Surprise: unexpected outcomes are more informative
  if (existingEdge) {
    const n = existingEdge.successCount + existingEdge.failureCount;
    if (n > 0) {
      const expectedRate = (existingEdge.successCount + 1) / (n + 2);
      const actual = outcome === 'success' ? 1 : 0;
      const surprise = Math.abs(actual - expectedRate);
      quality += surprise * 0.25;
      if (surprise > 0.5) reasons.push('surprising-outcome');
    }
  }

  // Adherence: did agent actually use the gene strategy?
  if (strategyUsed && strategyUsed.length > 0) {
    const gene = await prisma.iMGene.findUnique({ where: { id: geneId }, select: { strategySteps: true } });
    if (gene) {
      const geneSteps = JSON.parse(gene.strategySteps || '[]') as string[];
      const adherence = computeAdherenceScore(geneSteps, strategyUsed);
      quality *= 0.3 + 0.7 * adherence; // adherence 0 → quality × 0.3, adherence 1 → quality × 1.0
      if (adherence > 0.5) reasons.push('strategy-followed');
      else reasons.push('strategy-diverged');
    }
  }

  // Repeat penalty: exponential decay for same (agent, gene, outcome) in 1h
  quality *= Math.pow(0.5, recentSameCount);
  if (recentSameCount >= 2) reasons.push(`repeat-penalty-${recentSameCount}x`);

  return { quality: Math.max(0, Math.min(1, quality)), reasons };
}

/**
 * Keyword overlap between gene strategy and actually used strategy.
 */
function computeAdherenceScore(geneStrategy: string[], strategyUsed: string[]): number {
  if (!geneStrategy.length || !strategyUsed.length) return 0.3;
  const geneWords = new Set(
    geneStrategy
      .join(' ')
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 2),
  );
  const usedWords = new Set(
    strategyUsed
      .join(' ')
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 2),
  );
  if (geneWords.size === 0) return 0.5;
  const overlap = [...geneWords].filter((w) => usedWords.has(w)).length;
  return Math.min(1, overlap / geneWords.size);
}

// ===== Fast Capsule Quality (no extra DB queries) =====

/**
 * Lightweight quality assessment using only data already loaded.
 * The full computeCapsuleQuality() does 3 extra DB queries (global edge count,
 * distinct agents, gene strategy) — unnecessary for most capsules.
 */
function computeCapsuleQualityFast(
  existingEdge: { successCount: number; failureCount: number } | null,
  outcome: string,
  recentSameCount: number,
): { quality: number; reasons: string[] } {
  let quality = 0.5;
  const reasons: string[] = [];

  // Information gain: first-time data is more valuable
  if (!existingEdge) {
    quality += 0.15;
    reasons.push('first-use-for-agent');
  }

  // Surprise: unexpected outcomes are more informative
  if (existingEdge) {
    const n = existingEdge.successCount + existingEdge.failureCount;
    if (n > 0) {
      const expectedRate = (existingEdge.successCount + 1) / (n + 2);
      const actual = outcome === 'success' ? 1 : 0;
      const surprise = Math.abs(actual - expectedRate);
      quality += surprise * 0.25;
      if (surprise > 0.5) reasons.push('surprising-outcome');
    }
  }

  // Repeat penalty
  quality *= Math.pow(0.5, recentSameCount);
  if (recentSameCount >= 2) reasons.push(`repeat-penalty-${recentSameCount}x`);

  return { quality: Math.max(0, Math.min(1, quality)), reasons };
}

// ===== Outcome Recording =====

/**
 * Record the outcome of a gene execution.
 * Updates: evolution edge + capsule + gene stats + personality.
 */
export async function recordOutcome(
  agentId: string,
  input: EvolutionRecordInput,
  deps: {
    creditService?: CreditService;
    achievementService?: AchievementService;
    shouldDistill: (agentId: string) => Promise<boolean>;
    memoryService?: MemoryService;
  },
  scope = 'global',
): Promise<{
  edge_updated: boolean;
  personality_adjusted: boolean;
  distill_ready: boolean;
}> {
  // Normalize signals to SignalTag[] (backward compat)
  const signalTags = normalizeSignals(input.signals as string[] | SignalTag[]);
  const signalKey = computeSignalKey(signalTags);
  const signalType = extractSignalType(signalTags);
  const isSuccess = input.outcome === 'success';
  const provider = (input.metadata as any)?.provider as string | undefined;

  // ── Parallel Phase 1: Load gene ACL + agent mode + recent count + existing edge simultaneously ──
  // Previously 5 sequential queries. Now 4 parallel queries.
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  const [targetGene, agentCard, recentCount] = await Promise.all([
    prisma.iMGene.findUnique({ where: { id: input.gene_id } }),
    prisma.iMAgentCard.findUnique({
      where: { imUserId: agentId },
      select: { metadata: true },
    }),
    prisma.iMEvolutionCapsule.count({
      where: {
        ownerAgentId: agentId,
        geneId: input.gene_id,
        createdAt: { gte: oneHourAgo },
      },
    }),
  ]);

  // 0. Gene ACL check
  if (!targetGene) {
    const err = new Error('Gene not found') as any;
    err.code = 'GENE_NOT_FOUND';
    err.status = 404;
    throw err;
  }
  const geneAccessible =
    targetGene.ownerAgentId === agentId ||
    targetGene.visibility === 'seed' ||
    targetGene.visibility === 'published' ||
    (targetGene.visibility === 'canary' && isCanaryVisibleToAgent(targetGene.ownerAgentId, agentId));
  if (!geneAccessible) {
    const err = new Error('Gene not accessible to this agent') as any;
    err.code = 'GENE_ACCESS_DENIED';
    err.status = 403;
    throw err;
  }

  // Extract mode from agentCard (avoids separate getAgentMode query)
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

  // 0.5. Rate Decay
  const RATE_DECAY = 0.5;
  const decayFactor = Math.pow(RATE_DECAY, recentCount);

  // ── Parallel Phase 2: existing edge + provider freeze check ──
  const [existingEdge, isProviderFrozenVal] = await Promise.all([
    prisma.iMEvolutionEdge.findUnique({
      where: {
        ownerAgentId_signalKey_geneId_mode_scope: {
          ownerAgentId: agentId,
          signalKey,
          geneId: input.gene_id,
          mode: agentMode,
          scope,
        },
      },
    }),
    provider ? checkProviderFrozen(provider) : Promise.resolve(false),
  ]);

  // Compute capsule quality — lightweight version (no extra DB queries)
  const { quality: capsuleQuality, reasons: qualityReasons } = computeCapsuleQualityFast(
    existingEdge ? { successCount: existingEdge.successCount, failureCount: existingEdge.failureCount } : null,
    input.outcome,
    recentCount,
  );

  // Apply edge update only if:
  // 1. Decay factor is significant (> 0.1) — prevents spam
  // 2. Neither global nor provider-scoped freeze is active
  // 3. Capsule quality is above threshold (> 0.2) — prevents noise
  const shouldUpdateEdge = decayFactor > 0.1 && capsuleQuality > 0.2 && !isFrozen() && !isProviderFrozenVal;

  if (existingEdge) {
    // Compute task_success_rate (§3.4.3: separate from routing weight)
    const updatedSuccess = shouldUpdateEdge && isSuccess ? existingEdge.successCount + 1 : existingEdge.successCount;
    const updatedFailure = shouldUpdateEdge && !isSuccess ? existingEdge.failureCount + 1 : existingEdge.failureCount;
    const totalExec = updatedSuccess + updatedFailure;
    const taskSuccessRate = totalExec > 0 ? updatedSuccess / totalExec : null;

    await prisma.iMEvolutionEdge.update({
      where: { id: existingEdge.id },
      data: {
        successCount: updatedSuccess,
        failureCount: updatedFailure,
        lastScore: input.score ?? null,
        lastUsedAt: new Date(),
        // v0.3.0 fields
        ...(signalType !== null && { signalType }),
        ...(taskSuccessRate !== null && { taskSuccessRate }),
        // bimodalityIndex: deferred — computed asynchronously by periodic background job
      },
    });
  } else {
    await prisma.iMEvolutionEdge.create({
      data: {
        ownerAgentId: agentId,
        signalKey,
        geneId: input.gene_id,
        successCount: isSuccess ? 1 : 0,
        failureCount: isSuccess ? 0 : 1,
        lastScore: input.score ?? null,
        lastUsedAt: new Date(),
        signalType: signalType ?? undefined,
        taskSuccessRate: isSuccess ? 1.0 : 0.0,
        mode: agentMode,
        scope,
      },
    });
  }

  if (!shouldUpdateEdge) {
    console.log(
      `[Evolution] Rate decay: skipping edge update for (${agentId}, ${input.gene_id}), decay=${decayFactor.toFixed(3)}, recentCount=${recentCount}`,
    );
  }

  // Invalidate analyze cache for this agent (edge data changed, cached rankings stale)
  invalidateAnalyzeCache(agentId);

  // ── Parallel Phase 3: Critical writes (capsule + circuit breaker + freeze) ──
  const [createdCapsule] = await Promise.all([
    // 2. Create capsule record (always, even when frozen — append-only audit)
    prisma.iMEvolutionCapsule.create({
      data: {
        ownerAgentId: agentId,
        geneId: input.gene_id,
        signalKey,
        triggerSignals: JSON.stringify(signalTags.map((t) => t.type)),
        outcome: input.outcome,
        score: input.score ?? null,
        summary: input.summary,
        costCredits: input.cost_credits ?? 0,
        metadata: JSON.stringify({
          ...(input.metadata || {}),
          capsuleQuality: capsuleQuality,
          qualityReasons: qualityReasons,
          edgeUpdated: shouldUpdateEdge,
        }),
        provider: provider ?? null,
        mode: agentMode,
        scope,
        transitionReason: input.transition_reason ?? 'gene_applied',
        contextSnapshot: input.context_snapshot ? JSON.stringify(input.context_snapshot).slice(0, 16384) : null,
      },
    }),
    // 1.6 Circuit Breaker: update per-gene state
    updateCircuitBreaker(input.gene_id, isSuccess, {
      breakerState: targetGene.breakerState,
      breakerFailCount: targetGene.breakerFailCount,
      breakerStateAt: targetGene.breakerStateAt,
    }),
    // 3. Update gene stats
    updateGeneStats(agentId, input.gene_id, isSuccess, input.score),
  ]);

  // ── Background: non-critical operations (don't block response) ──
  // Each operation independently caught so one failure doesn't skip the rest.
  setImmediate(async () => {
    // Freeze mode refresh
    await updateFreezeMode().catch(() => {});

    // Personality adjustment
    await adjustPersonality(agentId, input).catch(() => {});

    // Quality score update (bridges evolution selection ↔ library ranking)
    if (isSuccess) {
      await bumpGeneOnSuccess(input.gene_id).catch(() => {});
    } else {
      await decayGeneOnFailure(input.gene_id).catch(() => {});
    }

    // Distillation check (informational)
    await deps.shouldDistill(agentId).catch(() => {});

    // Hypergraph layer: always write as parallel observation system (independent of mode)
    await writeHypergraphLayer(agentId, signalTags, input.gene_id, input.outcome, signalKey).catch((err) =>
      console.warn('[Evolution] Hypergraph write error:', err instanceof Error ? err.message : err),
    );

    // Credit reward (+1 cr)
    if (isSuccess && deps.creditService) {
      await deps.creditService
        .credit(agentId, 1, 'evolution_reward', 'Gene execution success')
        .catch((err) => console.warn('[Evolution] Credit reward failed:', (err as Error).message));
    }

    // Achievement check + SSE broadcast
    if (deps.achievementService) {
      const newBadges = await deps.achievementService
        .checkAndUnlock(agentId, { event: 'record', outcome: input.outcome })
        .catch(() => [] as string[]);

      const syncService = (globalThis as any).__imServices?.syncService;
      if (syncService) {
        await syncService
          .writeEvent(
            'evolution:capsule',
            {
              geneId: input.gene_id,
              outcome: input.outcome,
              score: input.score,
              summary: input.summary,
              agentId,
              newBadges,
            },
            null,
            agentId,
          )
          .catch(() => {});
      }
    }

    // Canary lifecycle checks
    if (targetGene.visibility === 'canary') {
      await checkCanaryPromotion(input.gene_id).catch(() => {});
    }
    if (targetGene.visibility === 'canary' || targetGene.visibility === 'published') {
      await checkGeneDemotion(input.gene_id).catch(() => {});
    }

    // v1.8.0 Phase 2a: Reflection generation (Reflexion pattern — only for failures or low-score)
    if (
      process.env.FF_EVOLUTION_REFLECTION !== 'false' &&
      (input.outcome === 'failed' || (input.score !== undefined && input.score !== null && input.score < 0.5))
    ) {
      await generateReflection(
        createdCapsule.id,
        agentId,
        input.gene_id,
        signalKey,
        targetGene.title ?? input.gene_id,
        targetGene.strategySteps ?? '[]',
        input.summary ?? '',
        input.outcome,
        input.score,
      ).catch((err) => console.warn('[Evolution] Reflection generation failed:', (err as Error).message));
    }

    // v1.8.0 Phase 2c.1: Cross-layer sediment (evolution → memory)
    if (isSuccess && (input.score ?? 0) >= 0.8 && deps.memoryService) {
      await crossLayerSediment(
        agentId,
        input.gene_id,
        signalKey,
        targetGene.title ?? input.gene_id,
        input.summary ?? '',
        deps.memoryService,
        scope,
      ).catch((err) => console.warn('[Evolution] Cross-layer sediment failed:', (err as Error).message));
    }

    // v1.8.0: Auto-create knowledge links between gene and related memories
    const knowledgeLinkService = new KnowledgeLinkService();
    await knowledgeLinkService
      .autoLinkFromCapsule(input.gene_id, signalKey, agentId, scope)
      .catch((err) => console.warn('[Evolution] Auto-link from capsule failed:', (err as Error).message));

    // v1.8.0: Update bimodality index on the edge (was never written to DB before)
    if (existingEdge) {
      try {
        const recentCapsules = await prisma.iMEvolutionCapsule.findMany({
          where: { geneId: input.gene_id, ownerAgentId: agentId, signalKey, scope },
          orderBy: { createdAt: 'asc' },
          take: 100,
          select: { outcome: true },
        });
        const recentOutcomes = recentCapsules.map((c: { outcome: string }) => (c.outcome === 'success' ? 1 : 0));
        const bimodality = updateBimodalityIndex(recentOutcomes);
        if (bimodality > 0) {
          await prisma.iMEvolutionEdge.update({
            where: { id: existingEdge.id },
            data: { bimodalityIndex: bimodality },
          });
        }
      } catch (err) {
        console.warn('[EvolutionRecorder] bimodality update failed:', err);
      }
    }
  });

  return {
    edge_updated: shouldUpdateEdge,
    personality_adjusted: true,
    distill_ready: false,
  };
}

// ===== Phase 2a: Reflection Generation (Reflexion pattern) =====

async function generateReflection(
  capsuleId: string,
  agentId: string,
  geneId: string,
  signalKey: string,
  geneTitle: string,
  strategyStepsJson: string,
  summary: string,
  outcome: string,
  score?: number | null,
): Promise<void> {
  let steps: string[];
  try {
    steps = JSON.parse(strategyStepsJson);
  } catch {
    steps = [];
  }

  const prompt = `You are an AI strategy reflection engine. A gene (reusable strategy) was applied and ${outcome === 'failed' ? 'FAILED' : `scored low (${score})`}.

Gene: "${geneTitle}"
Signal: ${signalKey}
Strategy steps: ${steps.length > 0 ? steps.join(' → ') : '(none)'}
Outcome summary: ${summary || '(no summary)'}

In ONE sentence (max 100 tokens), explain the root cause of why this strategy ${outcome === 'failed' ? 'failed' : 'underperformed'} in this context. Focus on actionable insight.`;

  const reflection = await callLLM(prompt, 1);
  if (!reflection) return;

  const trimmed = reflection.trim().slice(0, 500);

  await prisma.iMEvolutionCapsule.update({
    where: { id: capsuleId },
    data: { reflection: trimmed },
  });
  console.log(`[Evolution] Reflection generated for capsule ${capsuleId}: ${trimmed.slice(0, 80)}...`);
}

// ===== Phase 2c.1: Cross-layer Sediment (Evolution → Memory) =====

async function crossLayerSediment(
  agentId: string,
  geneId: string,
  signalKey: string,
  geneTitle: string,
  summary: string,
  memoryService: MemoryService,
  scope: string,
): Promise<void> {
  const recentSuccesses = await prisma.iMEvolutionCapsule.count({
    where: {
      ownerAgentId: agentId,
      geneId,
      signalKey,
      outcome: 'success',
      score: { gte: 0.8 },
      createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
    },
  });

  if (recentSuccesses < 3) return;

  const insightPath = 'evolution-insights.md';
  const insightLine = `- **${geneTitle}** on \`${signalKey}\`: ${summary.slice(0, 200)} (${recentSuccesses} successes, ${new Date().toISOString().slice(0, 10)})`;

  try {
    const existing = await memoryService.readMemoryFileByPath(agentId, scope, insightPath);
    if (existing) {
      if (existing.content.includes(geneTitle) && existing.content.includes(signalKey)) {
        return;
      }
      const updated = existing.content + '\n' + insightLine;
      await memoryService.updateMemoryFile(existing.id, 'replace', updated);
      console.log(`[Evolution] Cross-layer sediment: appended insight to ${insightPath}`);
    } else {
      await memoryService.writeMemoryFile(
        agentId,
        'agent',
        insightPath,
        `# Evolution Insights (auto-generated)\n\nProven strategies from the evolution network:\n\n${insightLine}`,
        scope,
      );
      console.log(`[Evolution] Cross-layer sediment: created ${insightPath}`);
    }
  } catch (err) {
    console.warn('[Evolution] Cross-layer sediment error:', (err as Error).message);
  }
}
