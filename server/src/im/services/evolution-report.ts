/**
 * Evolution Sub-module: Report Pipeline
 *
 * submitReport(), getReportStatus(), processOneReport(), processPendingReports(),
 * generateReport(), getEdges(), getCapsules()
 */

import prisma from '../db';
import type {
  PrismerGene,
  SignalTag,
  EvolutionEdgeInfo,
  EvolutionReport,
  EvolutionReportInput,
  ExtractionTrace,
} from '../types/index';
import type { SignalExtractorService } from './signal-extractor';
import { computeSignalKey } from './evolution-signals';
import { getAgentMode } from './evolution-hypergraph';
import { loadGenes } from './evolution-lifecycle';
import { getPersonality } from './evolution-personality';

// ===== Report Pipeline (async LLM aggregation) =====

/**
 * Types for internal report queue management.
 */
export interface ReportQueueItem {
  capsuleId: string;
  agentId: string;
  input: EvolutionReportInput;
}

/**
 * Submit a report for async LLM processing.
 * Returns immediately with trace_id. LLM runs in background.
 */
export async function submitReport(
  agentId: string,
  input: EvolutionReportInput,
  deps: {
    extractSignals: (context: {
      error?: string;
      taskStatus?: string;
      provider?: string;
      stage?: string;
      severity?: string;
    }) => SignalTag[];
    enqueueReport: (item: ReportQueueItem) => void;
  },
): Promise<{
  trace_id: string;
  status: 'accepted';
  fast_signals: SignalTag[];
}> {
  // Fast path: regex extraction for immediate reference
  const fastSignals = deps.extractSignals({
    error: input.raw_context,
    taskStatus: input.outcome,
    provider: input.provider,
    stage: input.stage,
    severity: input.severity,
  });

  // Create capsule in pending state
  const capsule = await prisma.iMEvolutionCapsule.create({
    data: {
      ownerAgentId: agentId,
      geneId: input.gene_id || 'pending',
      signalKey: computeSignalKey(fastSignals),
      triggerSignals: JSON.stringify(fastSignals.map((s) => s.type)),
      outcome: 'pending',
      score: input.score ?? null,
      summary: input.task || input.raw_context.slice(0, 200),
      costCredits: 0,
      metadata: JSON.stringify({
        raw_context: input.raw_context.slice(0, 4096),
        task: input.task,
        provider: input.provider,
        stage: input.stage,
        severity: input.severity,
        requested_outcome: input.outcome,
        extraction_status: 'pending',
      }),
      provider: input.provider ?? null,
      mode: await getAgentMode(agentId),
      scope: 'global',
    },
  });

  // Enqueue for async processing
  deps.enqueueReport({ capsuleId: capsule.id, agentId, input });

  return {
    trace_id: capsule.id,
    status: 'accepted',
    fast_signals: fastSignals,
  };
}

/**
 * Get report processing status by trace ID.
 */
export async function getReportStatus(
  traceId: string,
  agentId: string,
): Promise<{
  trace_id: string;
  status: 'pending' | 'processed' | 'failed';
  extracted_signals?: SignalTag[];
  root_cause?: string;
  gene_recommendation?: { id: string; title?: string; strategy?: string[]; confidence: number };
  extraction_method?: string;
} | null> {
  const capsule = await prisma.iMEvolutionCapsule.findUnique({ where: { id: traceId } });
  if (!capsule || capsule.ownerAgentId !== agentId) return null;

  const metadata = JSON.parse(capsule.metadata || '{}') as Record<string, unknown>;
  const trace = metadata.extraction_trace as ExtractionTrace | undefined;

  if (metadata.extraction_status === 'pending') {
    return { trace_id: traceId, status: 'pending' };
  }

  if (metadata.extraction_status === 'failed') {
    return { trace_id: traceId, status: 'failed' };
  }

  return {
    trace_id: traceId,
    status: 'processed',
    extracted_signals: trace?.extracted_signals,
    root_cause: trace?.root_cause ?? undefined,
    gene_recommendation: trace?.gene_alternatives?.[0]
      ? {
          id: trace.gene_alternatives[0].id,
          title: trace.gene_alternatives[0].title,
          confidence: trace.gene_alternatives[0].score,
        }
      : undefined,
    extraction_method: trace?.extraction_method,
  };
}

/**
 * Process a single report: LLM extraction → gene match → capsule update → edge upsert.
 */
export async function processOneReport(
  capsuleId: string,
  agentId: string,
  input: EvolutionReportInput,
  deps: {
    signalExtractor?: SignalExtractorService;
    extractSignals: (context: {
      error?: string;
      taskStatus?: string;
      provider?: string;
      stage?: string;
      severity?: string;
    }) => SignalTag[];
    selectGene: (signals: SignalTag[], agentId: string) => Promise<any>;
  },
): Promise<void> {
  // 1. LLM extraction (or fallback)
  let extraction: {
    signals: SignalTag[];
    rootCause: string | null;
    method: string;
    model?: string;
    latencyMs: number;
  };

  if (deps.signalExtractor) {
    const result = await deps.signalExtractor.extract({
      rawContext: input.raw_context,
      task: input.task,
      outcome: input.outcome,
      provider: input.provider,
      stage: input.stage,
      severity: input.severity,
    });
    extraction = {
      signals: result.signals,
      rootCause: result.rootCause,
      method: result.method,
      model: result.model,
      latencyMs: result.latencyMs,
    };
  } else {
    const regex = deps.extractSignals({
      error: input.raw_context,
      taskStatus: input.outcome,
      provider: input.provider,
      stage: input.stage,
      severity: input.severity,
    });
    extraction = { signals: regex, rootCause: null, method: 'regex', latencyMs: 0 };
  }

  if (extraction.signals.length === 0) {
    extraction.signals = [{ type: input.outcome === 'failed' ? 'task.failed' : 'task.completed' }];
  }

  const signalKey = computeSignalKey(extraction.signals);

  // 2. Gene match (if no gene_id provided)
  let geneAlternatives: Array<{ id: string; title?: string; score: number; reason?: string }> = [];
  let matchedGeneId = input.gene_id || '';

  if (!matchedGeneId) {
    try {
      const advice = await deps.selectGene(extraction.signals, agentId);
      if (advice.gene) {
        matchedGeneId = advice.gene.id;
        geneAlternatives = [
          { id: advice.gene.id, title: advice.gene.title, score: advice.confidence },
          ...(advice.alternatives?.map((a: any) => ({ id: a.gene_id, score: a.confidence })) || []),
        ];
      }
    } catch {
      /* non-blocking */
    }
  }

  // 3. Build extraction trace
  const trace: ExtractionTrace = {
    raw_context: input.raw_context.slice(0, 2000),
    extraction_method: extraction.method as ExtractionTrace['extraction_method'],
    extraction_model: extraction.model,
    extraction_latency_ms: extraction.latencyMs,
    extracted_signals: extraction.signals,
    root_cause: extraction.rootCause ?? undefined,
    gene_alternatives: geneAlternatives.length > 0 ? geneAlternatives : undefined,
    gene_match_confidence: geneAlternatives[0]?.score,
  };

  // 4. Update capsule with full data
  await prisma.iMEvolutionCapsule.update({
    where: { id: capsuleId },
    data: {
      geneId: matchedGeneId || 'unmatched',
      signalKey,
      triggerSignals: JSON.stringify(extraction.signals.map((s) => s.type)),
      outcome: input.outcome,
      summary: input.task || input.raw_context.slice(0, 200),
      metadata: JSON.stringify({
        extraction_status: 'processed',
        extraction_trace: trace,
      }),
    },
  });

  // 5. Upsert edges (if we have a gene)
  if (matchedGeneId && matchedGeneId !== 'pending' && matchedGeneId !== 'unmatched') {
    const isSuccess = input.outcome === 'success';
    const mode = await getAgentMode(agentId);
    const existingEdge = await prisma.iMEvolutionEdge.findUnique({
      where: {
        ownerAgentId_signalKey_geneId_mode_scope: {
          ownerAgentId: agentId,
          signalKey,
          geneId: matchedGeneId,
          mode,
          scope: 'global',
        },
      },
    });

    if (existingEdge) {
      await prisma.iMEvolutionEdge.update({
        where: { id: existingEdge.id },
        data: {
          successCount: isSuccess ? existingEdge.successCount + 1 : existingEdge.successCount,
          failureCount: isSuccess ? existingEdge.failureCount : existingEdge.failureCount + 1,
          lastScore: input.score ?? null,
          lastUsedAt: new Date(),
        },
      });
    } else {
      await prisma.iMEvolutionEdge.create({
        data: {
          ownerAgentId: agentId,
          signalKey,
          geneId: matchedGeneId,
          mode,
          scope: 'global',
          successCount: isSuccess ? 1 : 0,
          failureCount: isSuccess ? 0 : 1,
          lastScore: input.score ?? null,
          lastUsedAt: new Date(),
        },
      });
    }
  }

  // 6. SSE broadcast
  try {
    const syncService = (globalThis as any).__imServices?.syncService;
    if (syncService) {
      await syncService.writeEvent(
        'evolution:report_processed',
        {
          capsuleId,
          geneId: matchedGeneId,
          outcome: input.outcome,
          signals: extraction.signals,
          rootCause: extraction.rootCause,
          method: extraction.method,
          agentId,
        },
        null,
        agentId,
      );
    }
  } catch {
    /* non-blocking */
  }

  console.log(
    `[Evolution] Report processed: ${capsuleId} method=${extraction.method} signals=${extraction.signals.length} gene=${matchedGeneId || 'none'}`,
  );
}

/**
 * Scan and process pending report capsules (called by SchedulerService).
 */
export async function processPendingReports(
  limit: number,
  deps: {
    processOneReport: (capsuleId: string, agentId: string, input: EvolutionReportInput) => Promise<void>;
  },
): Promise<number> {
  const pending = await prisma.iMEvolutionCapsule.findMany({
    where: { outcome: 'pending' },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });

  if (pending.length === 0) return 0;

  let processed = 0;
  for (const capsule of pending) {
    try {
      const meta = JSON.parse(capsule.metadata || '{}');
      if (meta.extraction_status !== 'pending') continue;

      const input: EvolutionReportInput = {
        raw_context: meta.raw_context || capsule.summary,
        task: meta.task,
        outcome: (meta.requested_outcome as 'success' | 'failed') || 'failed',
        score: capsule.score ?? undefined,
        provider: meta.provider,
        stage: meta.stage,
        severity: meta.severity,
        gene_id: capsule.geneId === 'pending' ? undefined : capsule.geneId,
      };

      await deps.processOneReport(capsule.id, capsule.ownerAgentId, input);
      processed++;
    } catch (err) {
      console.warn(`[Evolution] Pending report ${capsule.id} failed:`, (err as Error).message);
    }
  }

  if (processed > 0) console.log(`[Evolution] Processed ${processed} pending reports`);
  return processed;
}

// ===== Memory Graph Queries =====

/**
 * Get evolution edges for an agent, optionally filtered by signals.
 */
export async function getEdges(
  agentId: string,
  options?: {
    signalKey?: string;
    geneId?: string;
    limit?: number;
    scope?: string;
  },
): Promise<EvolutionEdgeInfo[]> {
  const where: Record<string, unknown> = { ownerAgentId: agentId, scope: options?.scope ?? 'global' };
  if (options?.signalKey) where.signalKey = options.signalKey;
  if (options?.geneId) where.geneId = options.geneId;

  const edges = await prisma.iMEvolutionEdge.findMany({
    where,
    orderBy: { updatedAt: 'desc' },
    take: options?.limit ?? 100,
  });

  return edges.map((e: any) => {
    const n = (e.successCount as number) + (e.failureCount as number);
    const p = n > 0 ? (e.successCount + 1) / (n + 2) : 0.5;
    return {
      signal_key: e.signalKey as string,
      gene_id: e.geneId as string,
      success_count: e.successCount as number,
      failure_count: e.failureCount as number,
      confidence: p,
      last_score: e.lastScore as number | null,
      last_used_at: e.lastUsedAt?.toISOString() ?? null,
    };
  });
}

// ===== Evolution Report =====

/**
 * Generate a comprehensive evolution report for an agent.
 */
export async function generateReport(agentId: string, scope = 'global'): Promise<EvolutionReport> {
  const [capsules, personality, genes] = await Promise.all([
    prisma.iMEvolutionCapsule.findMany({
      where: { ownerAgentId: agentId, scope },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
    getPersonality(agentId),
    loadGenes(agentId, scope),
  ]);

  const total = capsules.length;
  const successes = capsules.filter((c: any) => c.outcome === 'success').length;
  const successRate = total > 0 ? successes / total : 0;

  // Top genes by usage
  const geneUsage = new Map<string, { uses: number; successes: number }>();
  for (const c of capsules) {
    const g = geneUsage.get(c.geneId) ?? { uses: 0, successes: 0 };
    g.uses++;
    if (c.outcome === 'success') g.successes++;
    geneUsage.set(c.geneId, g);
  }

  const topGenes = Array.from(geneUsage.entries())
    .sort((a, b) => b[1].uses - a[1].uses)
    .slice(0, 5)
    .map(([geneId, data]) => ({
      gene_id: geneId,
      uses: data.uses,
      success_rate: data.uses > 0 ? data.successes / data.uses : 0,
    }));

  // Trend: compare first half vs second half success rate
  let trend: 'improving' | 'declining' | 'stable' = 'stable';
  if (total >= 10) {
    const mid = Math.floor(total / 2);
    const olderHalf = capsules.slice(mid);
    const newerHalf = capsules.slice(0, mid);
    const olderRate = olderHalf.filter((c: any) => c.outcome === 'success').length / olderHalf.length;
    const newerRate = newerHalf.filter((c: any) => c.outcome === 'success').length / newerHalf.length;
    if (newerRate - olderRate > 0.1) trend = 'improving';
    else if (olderRate - newerRate > 0.1) trend = 'declining';
  }

  return {
    agent_id: agentId,
    total_capsules: total,
    success_rate: successRate,
    top_genes: topGenes,
    personality,
    recent_trend: trend,
  };
}

/** GET /capsules — Paginated capsules for agent */
export async function getCapsules(
  agentId: string,
  page: number,
  limit: number,
  scope = 'global',
): Promise<{ capsules: unknown[]; total: number }> {
  const [capsules, total] = await Promise.all([
    prisma.iMEvolutionCapsule.findMany({
      where: { ownerAgentId: agentId, scope },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.iMEvolutionCapsule.count({ where: { ownerAgentId: agentId, scope } }),
  ]);

  return {
    capsules: capsules.map((c: any) => ({
      id: c.id,
      geneId: c.geneId,
      signalKey: c.signalKey,
      triggerSignals: JSON.parse(c.triggerSignals || '[]'),
      outcome: c.outcome,
      score: c.score,
      summary: c.summary,
      costCredits: c.costCredits,
      createdAt: c.createdAt,
    })),
    total,
  };
}
