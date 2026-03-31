/**
 * EvolutionRuntime — High-level evolution API for agents.
 *
 * Composes EvolutionCache + SignalEnrichment + async outbox into two simple methods:
 *   - suggest(error, context?) → strategy recommendation (<1ms local, fallback to server)
 *   - learned(error, outcome, summary, geneId?) → fire-and-forget outcome recording
 *
 * Also handles:
 *   - Bootstrap: auto-load sync snapshot on init
 *   - Periodic sync: pull delta every N seconds
 *   - Session tracking: correlates suggest → learned within a task
 *
 * Usage:
 *   const runtime = new EvolutionRuntime(client.im.evolution);
 *   await runtime.start();
 *
 *   const fix = await runtime.suggest('ETIMEDOUT: connection timed out');
 *   // ... agent applies fix.strategy ...
 *   runtime.learned('ETIMEDOUT', 'success', 'Fixed by increasing timeout to 30s');
 */

import { EvolutionCache } from './evolution-cache';
import { extractSignals, createEnrichedExtractor } from './signal-enrichment';
import type { SignalTag, ExecutionContext, SignalEnrichmentConfig, IMGene } from './types';

/** Minimal interface for the evolution client — avoids circular import */
interface EvolutionClientLike {
  getSyncSnapshot(since?: number): Promise<{ data?: any }>;
  analyze(options: Record<string, any>): Promise<{ data?: any }>;
  record(options: Record<string, any>): Promise<{ data?: any }>;
  sync(options: Record<string, any>): Promise<{ data?: any }>;
}

// ─── Types ──────────────────────────────────────────────

export interface EvolutionRuntimeConfig {
  /** Sync interval in ms (default: 60000 = 1 min) */
  syncIntervalMs?: number;
  /** Signal enrichment mode */
  enrichment?: SignalEnrichmentConfig;
  /** Scope for all operations (default: 'global') */
  scope?: string;
  /** Max outbox queue size before force flush */
  outboxMaxSize?: number;
  /** Outbox flush interval in ms (default: 5000) */
  outboxFlushMs?: number;
}

export interface Suggestion {
  action: 'apply_gene' | 'create_suggested' | 'none';
  geneId?: string;
  gene?: IMGene;
  strategy?: string[];
  confidence: number;
  signals: SignalTag[];
  fromCache: boolean;
  reason?: string;
  alternatives?: Array<{ gene_id: string; confidence: number; title?: string }>;
}

interface OutboxEntry {
  geneId: string;
  signals: SignalTag[];
  outcome: 'success' | 'failed';
  summary: string;
  score?: number;
  metadata?: Record<string, any>;
  timestamp: number;
  sessionId?: string;
}

/** Tracks a single suggest→learned cycle within a task. */
export interface EvolutionSession {
  /** Unique session ID */
  id: string;
  /** When suggest() was called */
  suggestedAt: number;
  /** What gene was recommended */
  suggestedGeneId?: string;
  /** What gene the agent actually used (may differ from suggested) */
  usedGeneId?: string;
  /** Signals that triggered the suggest */
  signals: SignalTag[];
  /** Whether agent adopted the recommended strategy */
  adopted: boolean;
  /** When learned() was called (null if not yet) */
  completedAt?: number;
  /** Outcome */
  outcome?: 'success' | 'failed';
  /** Duration from suggest to learned (ms) */
  durationMs?: number;
  /** Confidence of the suggestion */
  confidence: number;
  /** Whether suggestion came from cache or server */
  fromCache: boolean;
}

/** Aggregate session metrics for benchmarking. */
export interface SessionMetrics {
  /** Total suggest() calls */
  totalSuggestions: number;
  /** suggest() calls that returned a gene */
  suggestionsWithGene: number;
  /** learned() calls */
  totalLearned: number;
  /** Sessions where agent used the suggested gene */
  adoptedCount: number;
  /** Gene Utilization Rate = adoptedCount / suggestionsWithGene */
  geneUtilizationRate: number;
  /** Average suggest→learned duration (ms) */
  avgDurationMs: number;
  /** Success rate of adopted recommendations */
  adoptedSuccessRate: number;
  /** Success rate without adoption (agent did it alone) */
  nonAdoptedSuccessRate: number;
  /** Cache hit rate */
  cacheHitRate: number;
}

// ─── Runtime ────────────────────────────────────────────

export class EvolutionRuntime {
  private cache: EvolutionCache;
  private enricher: (ctx: ExecutionContext) => Promise<SignalTag[]>;
  private outbox: OutboxEntry[] = [];
  private syncTimer?: ReturnType<typeof setInterval>;
  private flushTimer?: ReturnType<typeof setInterval>;
  private lastSuggestedGeneId?: string;
  private started = false;
  private readonly scope: string;
  private readonly config: Required<EvolutionRuntimeConfig>;

  // Session tracking
  private _sessions: EvolutionSession[] = [];
  private _activeSession?: EvolutionSession;
  private _sessionCounter = 0;

  constructor(
    private client: EvolutionClientLike,
    config?: EvolutionRuntimeConfig,
  ) {
    this.config = {
      syncIntervalMs: config?.syncIntervalMs ?? 60_000,
      enrichment: config?.enrichment ?? { mode: 'rules' },
      scope: config?.scope ?? 'global',
      outboxMaxSize: config?.outboxMaxSize ?? 50,
      outboxFlushMs: config?.outboxFlushMs ?? 5_000,
    };
    this.scope = this.config.scope;
    this.cache = new EvolutionCache();
    this.enricher = config?.enrichment
      ? createEnrichedExtractor(config.enrichment)
      : async (ctx) => extractSignals(ctx);
  }

  // ─── Lifecycle ──────────────────────────────────────

  /** Initialize: load snapshot + start sync + start outbox flush */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // Bootstrap cache from server
    try {
      const snapshot = await this.client.getSyncSnapshot(0);
      if (snapshot.data) {
        this.cache.loadSnapshot(snapshot.data);
      }
    } catch {
      // Non-fatal: runtime works without cache (falls back to server)
    }

    // Periodic sync
    if (this.config.syncIntervalMs > 0) {
      this.syncTimer = setInterval(() => this.sync(), this.config.syncIntervalMs);
    }

    // Periodic outbox flush
    this.flushTimer = setInterval(() => this.flush(), this.config.outboxFlushMs);
  }

  /** Stop: clear timers + flush remaining outbox */
  async stop(): Promise<void> {
    if (this.syncTimer) clearInterval(this.syncTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.flush();
    this.started = false;
  }

  // ─── High-Level API ─────────────────────────────────

  /**
   * Get a strategy recommendation for an error/context.
   *
   * Flow: extract signals → try local cache (<1ms) → fallback to server (~30ms)
   *
   * @param error - Error message or Error object
   * @param context - Optional additional context (provider, stage, etc.)
   */
  async suggest(
    error: string | Error,
    context?: Partial<ExecutionContext>,
  ): Promise<Suggestion> {
    const errorStr = error instanceof Error ? error.message : error;
    const ctx: ExecutionContext = {
      error: errorStr,
      ...context,
    };

    // Extract signals
    const signals = await this.enricher(ctx);
    if (signals.length === 0) {
      return {
        action: 'none',
        confidence: 0,
        signals: [],
        fromCache: false,
        reason: 'no signals extracted from error',
      };
    }

    const buildSuggestion = (
      action: string, geneId: string | undefined, gene: any, strategy: any,
      confidence: number, fromCache: boolean, reason?: string, alternatives?: any,
    ): Suggestion => {
      this.lastSuggestedGeneId = geneId;
      // Start session tracking
      this._activeSession = {
        id: `ses_${++this._sessionCounter}_${Date.now()}`,
        suggestedAt: Date.now(),
        suggestedGeneId: geneId,
        signals,
        adopted: false,
        confidence,
        fromCache,
      };
      return {
        action: action as any, geneId, gene, strategy, confidence,
        signals, fromCache, reason, alternatives,
      };
    };

    // Try local cache first (<1ms)
    if (this.cache.geneCount > 0) {
      const local = this.cache.selectGene(signals);
      if (local.action === 'apply_gene' && local.confidence > 0.3) {
        return buildSuggestion(
          local.action, local.gene_id, local.gene, local.strategy,
          local.confidence, true, local.reason, local.alternatives,
        );
      }
    }

    // Fallback to server
    try {
      const result = await this.client.analyze({
        signals: signals as any,
        scope: this.scope,
      });
      if (result.data) {
        return buildSuggestion(
          result.data.action, result.data.gene_id, result.data.gene, result.data.strategy,
          result.data.confidence ?? 0, false, result.data.reason, result.data.alternatives,
        );
      }
    } catch {
      const local = this.cache.selectGene(signals);
      return buildSuggestion(
        local.action, local.gene_id, local.gene, local.strategy,
        local.confidence, true, 'server unreachable, using cache fallback', local.alternatives,
      );
    }

    return {
      action: 'none',
      confidence: 0,
      signals,
      fromCache: false,
      reason: 'no recommendation from server',
    };
  }

  /**
   * Record an outcome. Fire-and-forget — never blocks, never throws.
   *
   * @param error - The error that was encountered
   * @param outcome - 'success' or 'failed'
   * @param summary - One-line summary of what happened
   * @param geneId - Gene that was used (auto-detected from last suggest() if omitted)
   */
  learned(
    error: string | Error,
    outcome: 'success' | 'failed',
    summary: string,
    geneId?: string,
    metadata?: Record<string, any>,
  ): void {
    const errorStr = error instanceof Error ? error.message : error;
    const ctx: ExecutionContext = { error: errorStr };
    const signals = extractSignals(ctx); // Sync extraction for non-blocking

    const resolvedGeneId = geneId || this.lastSuggestedGeneId;
    if (!resolvedGeneId) return; // Can't record without a gene

    // Complete active session
    if (this._activeSession) {
      const session = this._activeSession;
      session.usedGeneId = resolvedGeneId;
      session.adopted = resolvedGeneId === session.suggestedGeneId;
      session.completedAt = Date.now();
      session.outcome = outcome;
      session.durationMs = session.completedAt - session.suggestedAt;
      this._sessions.push(session);
      this._activeSession = undefined;
    }

    this.outbox.push({
      geneId: resolvedGeneId,
      signals,
      outcome,
      summary,
      metadata,
      timestamp: Date.now(),
      sessionId: this._sessions[this._sessions.length - 1]?.id,
    });

    // Force flush if outbox is full
    if (this.outbox.length >= this.config.outboxMaxSize) {
      this.flush().catch(() => {});
    }
  }

  // ─── Session Metrics ────────────────────────────────

  /** Get all completed sessions. */
  get sessions(): readonly EvolutionSession[] {
    return this._sessions;
  }

  /** Get aggregate metrics for benchmarking. */
  getMetrics(): SessionMetrics {
    const sessions = this._sessions;
    const totalSuggestions = sessions.length;
    const suggestionsWithGene = sessions.filter(s => s.suggestedGeneId).length;
    const totalLearned = sessions.filter(s => s.completedAt).length;
    const adoptedSessions = sessions.filter(s => s.adopted && s.completedAt);
    const adoptedCount = adoptedSessions.length;
    const nonAdopted = sessions.filter(s => !s.adopted && s.completedAt);

    const durations = sessions.filter(s => s.durationMs != null).map(s => s.durationMs!);
    const avgDurationMs = durations.length > 0
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : 0;

    const adoptedSuccess = adoptedSessions.filter(s => s.outcome === 'success').length;
    const nonAdoptedSuccess = nonAdopted.filter(s => s.outcome === 'success').length;
    const cacheHits = sessions.filter(s => s.fromCache).length;

    return {
      totalSuggestions,
      suggestionsWithGene,
      totalLearned,
      adoptedCount,
      geneUtilizationRate: suggestionsWithGene > 0 ? Math.round(adoptedCount / suggestionsWithGene * 100) / 100 : 0,
      avgDurationMs,
      adoptedSuccessRate: adoptedCount > 0 ? Math.round(adoptedSuccess / adoptedCount * 100) / 100 : 0,
      nonAdoptedSuccessRate: nonAdopted.length > 0 ? Math.round(nonAdoptedSuccess / nonAdopted.length * 100) / 100 : 0,
      cacheHitRate: totalSuggestions > 0 ? Math.round(cacheHits / totalSuggestions * 100) / 100 : 0,
    };
  }

  /** Reset session history. */
  resetMetrics(): void {
    this._sessions = [];
  }

  // ─── Internal ───────────────────────────────────────

  /** Sync cache with server */
  private async sync(): Promise<void> {
    try {
      const result = await this.client.sync({
        pull: { since: this.cache.cursor },
        scope: this.scope,
      } as any);
      if (result.data?.pulled) {
        this.cache.applyDelta({ pulled: result.data.pulled });
      }
    } catch {
      // Non-fatal
    }
  }

  /** Flush outbox to server */
  private async flush(): Promise<void> {
    if (this.outbox.length === 0) return;

    const batch = this.outbox.splice(0, this.config.outboxMaxSize);
    const promises = batch.map(entry =>
      this.client.record({
        gene_id: entry.geneId,
        signals: entry.signals.map(s => s.type),
        outcome: entry.outcome,
        summary: entry.summary,
        score: entry.score,
        metadata: entry.metadata,
        scope: this.scope,
      } as any).catch(() => {
        // Put back on failure
        this.outbox.push(entry);
      })
    );

    await Promise.allSettled(promises);
  }
}
