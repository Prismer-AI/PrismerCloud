/**
 * Prismer IM — Skill Evolution Service (Facade)
 *
 * Cloud-based evolution engine inspired by EvoMap/Evolver.
 * Implements: signal extraction, gene selection (Laplace smoothing + genetic drift),
 * outcome recording, personality adaptation, and gene distillation.
 *
 * This file is a facade that delegates to focused sub-modules:
 * - evolution-signals.ts     — Signal normalization, matching, clustering
 * - evolution-selector.ts    — Gene selection, Thompson Sampling, bimodality
 * - evolution-recorder.ts    — Outcome recording, capsule quality
 * - evolution-lifecycle.ts   — Gene CRUD, publish/fork, safety layer
 * - evolution-personality.ts — Agent personality system
 * - evolution-hypergraph.ts  — Hypergraph layer (mode, atoms, queries)
 * - evolution-distill.ts     — LLM distillation pipeline
 * - evolution-report.ts      — Report pipeline, edges, capsules
 * - evolution-metrics.ts     — North-star metrics collection
 * - evolution-public.ts      — Public APIs, map data, stories, feed
 *
 * @see docs/SKILL-EVOLUTION.md
 */

import type {
  PrismerGene,
  GeneCategory,
  SignalTag,
  AgentPersonality,
  PersonalityStats,
  EvolutionAdvice,
  EvolutionRecordInput,
  EvolutionEdgeInfo,
  EvolutionReport,
  GeneSelector,
} from '../types/index';
import type { EvolutionReportInput } from '../types/index';
import type { CreditService } from './credit.service';
import type { AchievementService } from './achievement.service';
import type { SignalExtractorService } from './signal-extractor';

// ─── Sub-module imports ─────────────────────────────────────

import {
  normalizeSignals,
  computeSignalKey as _computeSignalKey,
  trackUnmatchedSignals as _trackUnmatchedSignals,
  getUnmatchedSignals as _getUnmatchedSignals,
  resolveUnmatchedSignal as _resolveUnmatchedSignal,
  computeSignalClusters as _computeSignalClusters,
  lookupCluster as _lookupCluster,
} from './evolution-signals';

import {
  createGeneSelector,
  selectGene as _selectGene,
  buildCreateSuggestion as _buildCreateSuggestion,
} from './evolution-selector';

import { recordOutcome as _recordOutcome } from './evolution-recorder';

import {
  loadGenes as _loadGenes,
  saveGene as _saveGene,
  deleteGene as _deleteGene,
  createGene as _createGene,
  dbGeneToModel,
  publishGene as _publishGene,
  publishGeneDirect as _publishGeneDirect,
  publishGeneAsCanary as _publishGeneAsCanary,
  importPublicGene as _importPublicGene,
  forkGene as _forkGene,
  checkCanaryPromotion as _checkCanaryPromotion,
  checkGeneDemotion as _checkGeneDemotion,
  isCanaryVisibleToAgent as _isCanaryVisibleToAgent,
  checkCircuitBreakerData as _checkCircuitBreakerData,
  updateCircuitBreaker as _updateCircuitBreaker,
  updateFreezeMode as _updateFreezeMode,
  isFrozen as _isFrozen,
  checkProviderFrozen as _checkProviderFrozen,
  isProviderFrozen as _isProviderFrozen,
  ensureSeedGenesInTable as _ensureSeedGenesInTable,
  seedGenesForNewAgent as _seedGenesForNewAgent,
  scanCreditReturns as _scanCreditReturns,
  updateGeneStats as _updateGeneStats,
} from './evolution-lifecycle';

import {
  getPersonality as _getPersonality,
  getPersonalityStats as _getPersonalityStats,
} from './evolution-personality';

import {
  getAgentMode as _getAgentMode,
  queryHypergraphCandidates as _queryHypergraphCandidates,
} from './evolution-hypergraph';

import {
  shouldDistill as _shouldDistill,
  getSuccessCapsules as _getSuccessCapsules,
  triggerDistillation as _triggerDistillation,
} from './evolution-distill';

import {
  submitReport as _submitReport,
  getReportStatus as _getReportStatus,
  processOneReport as _processOneReport,
  processPendingReports as _processPendingReports,
  getEdges as _getEdges,
  generateReport as _generateReport,
  getCapsules as _getCapsules,
  type ReportQueueItem,
} from './evolution-report';

import { collectMetrics as _collectMetrics, getMetricsComparison as _getMetricsComparison } from './evolution-metrics';

import {
  getPublicStats as _getPublicStats,
  getAdvancedMetrics as _getAdvancedMetrics,
  getPublicHotGenes as _getPublicHotGenes,
  getPublicGenes as _getPublicGenes,
  getPublicGeneDetail as _getPublicGeneDetail,
  getPublicGeneCapsules as _getPublicGeneCapsules,
  getGeneLineage as _getGeneLineage,
  getPublicFeed as _getPublicFeed,
  getStories as _getStories,
  getMapData as _getMapData,
} from './evolution-public';

// ─── Service ────────────────────────────────────────────────

export class EvolutionService {
  private creditService?: CreditService;
  private achievementService?: AchievementService;
  private signalExtractor?: SignalExtractorService;
  private selector: GeneSelector;
  private reportQueue: Array<ReportQueueItem> = [];
  private processingReport = false;

  constructor(
    creditService?: CreditService,
    achievementService?: AchievementService,
    signalExtractor?: SignalExtractorService,
  ) {
    this.creditService = creditService;
    this.achievementService = achievementService;
    this.signalExtractor = signalExtractor;
    this.selector = createGeneSelector();
  }

  // ===== Mode Resolution =====

  async getAgentMode(agentId: string): Promise<'standard' | 'hypergraph'> {
    return _getAgentMode(agentId);
  }

  // ===== Hypergraph Layer =====

  async queryHypergraphCandidates(signalTags: SignalTag[]): Promise<string[]> {
    return _queryHypergraphCandidates(signalTags);
  }

  // ===== Signal Extraction =====

  extractSignals(context: {
    taskStatus?: string;
    taskCapability?: string;
    error?: string;
    tags?: string[];
    customSignals?: string[] | SignalTag[];
    provider?: string;
    stage?: string;
    severity?: string;
  }): SignalTag[] {
    const rawSignals: SignalTag[] = [];

    if (context.taskStatus === 'failed') rawSignals.push({ type: 'task.failed' });
    if (context.taskStatus === 'completed') rawSignals.push({ type: 'task.completed' });
    if (context.taskCapability) rawSignals.push({ type: `capability:${context.taskCapability}` });

    if (context.error) {
      const allMatched = this.normalizeErrors(context.error);
      for (const normalized of allMatched) {
        const tag: SignalTag = { type: `error:${normalized}` };
        if (context.provider) tag.provider = context.provider;
        if (context.stage) tag.stage = context.stage;
        if (context.severity) tag.severity = context.severity;
        rawSignals.push(tag);
      }
    }

    if (context.tags) {
      for (const tag of context.tags) {
        rawSignals.push({ type: `tag:${tag}` });
      }
    }

    if (context.customSignals) {
      const normalized = normalizeSignals(context.customSignals as string[] | SignalTag[]);
      rawSignals.push(...normalized);
    }

    const seen = new Set<string>();
    return rawSignals
      .filter((s) => {
        if (seen.has(s.type)) return false;
        seen.add(s.type);
        return true;
      })
      .sort((a, b) => a.type.localeCompare(b.type));
  }

  private normalizeErrors(error: string): string[] {
    const lower = error.toLowerCase().trim();
    const matched: string[] = [];

    const patterns: Array<[RegExp, string]> = [
      [/timeout|etimedout/i, 'timeout'],
      [/econnrefused|connection refused|connections? (?:to \S+ )?refused/i, 'connection_refused'],
      [/enotfound|dns/i, 'dns_error'],
      [/rate.?limit|429/i, 'rate_limit'],
      [/unauthorized|401/i, 'auth_error'],
      [/forbidden|403/i, 'forbidden'],
      [/not.?found|404/i, 'not_found'],
      [/500|internal server/i, 'server_error'],
      [/typeerror/i, 'type_error'],
      [/syntaxerror/i, 'syntax_error'],
      [/referenceerror/i, 'reference_error'],
      [/out of memory|oom|oomkill/i, 'oom'],
      [/crashloopbackoff|crash.?loop|keeps? restarting/i, 'crash_loop'],
      [/memory.?spike|memory.?limit/i, 'memory_pressure'],
      [/connection.?pool|too many connections/i, 'connection_pool_exhausted'],
      [/service.?unavailable|503/i, 'service_unavailable'],
      [/evicted|quota/i, 'resource_quota'],
      [/certificate|ssl|tls/i, 'tls_error'],
      [/deadlock/i, 'deadlock'],
      [/segfault|segmentation/i, 'segfault'],
    ];

    for (const [re, key] of patterns) {
      if (re.test(lower)) matched.push(key);
    }

    if (matched.length === 0) {
      const fallback = lower
        .slice(0, 50)
        .replace(/[^a-z0-9_]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '');
      if (fallback) matched.push(fallback);
    }

    return matched;
  }

  private normalizeError(error: string): string {
    return this.normalizeErrors(error)[0] || 'unknown';
  }

  computeSignalKey(signals: string[] | SignalTag[]): string {
    return _computeSignalKey(signals);
  }

  // ===== Gene Store =====

  async loadGenes(agentId: string, scope = 'global'): Promise<PrismerGene[]> {
    return _loadGenes(agentId, scope);
  }

  async saveGene(agentId: string, gene: PrismerGene, scope = 'global'): Promise<void> {
    return _saveGene(agentId, gene, scope);
  }

  async deleteGene(agentId: string, geneId: string): Promise<boolean> {
    return _deleteGene(agentId, geneId);
  }

  // ===== Gene Selection =====

  async selectGene(signals: string[] | SignalTag[], agentId: string, scope = 'global'): Promise<EvolutionAdvice> {
    return _selectGene(
      signals,
      agentId,
      {
        selector: this.selector,
        signalExtractor: this.signalExtractor,
      },
      scope,
    );
  }

  // ===== Unmatched Signal Tracking =====

  async getUnmatchedSignals(limit = 20) {
    return _getUnmatchedSignals(limit);
  }

  async resolveUnmatchedSignal(signalKey: string, geneId: string): Promise<void> {
    return _resolveUnmatchedSignal(signalKey, geneId);
  }

  // ===== Outcome Recording =====

  async recordOutcome(
    agentId: string,
    input: EvolutionRecordInput,
    scope = 'global',
  ): Promise<{
    edge_updated: boolean;
    personality_adjusted: boolean;
    distill_ready: boolean;
  }> {
    return _recordOutcome(
      agentId,
      input,
      {
        creditService: this.creditService,
        achievementService: this.achievementService,
        shouldDistill: (aid: string) => _shouldDistill(aid),
      },
      scope,
    );
  }

  // ===== Safety Layer =====

  async publishGeneAsCanary(agentId: string, geneId: string): Promise<PrismerGene | null> {
    return _publishGeneAsCanary(agentId, geneId);
  }

  async checkCanaryPromotion(geneId: string): Promise<{ promote: boolean; reason: string }> {
    return _checkCanaryPromotion(geneId);
  }

  async checkGeneDemotion(geneId: string): Promise<{ demote: boolean; reason: string }> {
    return _checkGeneDemotion(geneId);
  }

  isCanaryVisibleToAgent(geneOwnerAgentId: string, viewerAgentId: string): boolean {
    return _isCanaryVisibleToAgent(geneOwnerAgentId, viewerAgentId);
  }

  checkCircuitBreakerData(breakerState: string, breakerStateAt: Date | null): { allowed: boolean; state: string } {
    return _checkCircuitBreakerData(breakerState, breakerStateAt);
  }

  async updateCircuitBreaker(
    geneId: string,
    isSuccess: boolean,
    preloaded: { breakerState: string; breakerFailCount: number; breakerStateAt: Date | null },
  ): Promise<void> {
    return _updateCircuitBreaker(geneId, isSuccess, preloaded);
  }

  async updateFreezeMode(): Promise<boolean> {
    return _updateFreezeMode();
  }

  isFrozen(): boolean {
    return _isFrozen();
  }

  async checkProviderFrozen(provider: string): Promise<boolean> {
    return _checkProviderFrozen(provider);
  }

  isProviderFrozen(provider: string): boolean {
    return _isProviderFrozen(provider);
  }

  // ===== Personality System =====

  async getPersonality(agentId: string): Promise<AgentPersonality> {
    return _getPersonality(agentId);
  }

  async getPersonalityStats(agentId: string): Promise<PersonalityStats> {
    return _getPersonalityStats(agentId);
  }

  // ===== Distillation =====

  async shouldDistill(agentId: string): Promise<boolean> {
    return _shouldDistill(agentId);
  }

  async getSuccessCapsules(agentId: string, limit = 50) {
    return _getSuccessCapsules(agentId, limit);
  }

  async triggerDistillation(agentId: string) {
    return _triggerDistillation(agentId);
  }

  // ===== Report Pipeline =====

  async submitReport(agentId: string, input: EvolutionReportInput) {
    return _submitReport(agentId, input, {
      extractSignals: this.extractSignals.bind(this),
      enqueueReport: (item: ReportQueueItem) => {
        this.reportQueue.push(item);
        this.drainReportQueue();
      },
    });
  }

  async getReportStatus(traceId: string, agentId: string) {
    return _getReportStatus(traceId, agentId);
  }

  private drainReportQueue(): void {
    if (this.processingReport) return;
    this.processingReport = true;

    setImmediate(async () => {
      while (this.reportQueue.length > 0) {
        const item = this.reportQueue.shift()!;
        try {
          await _processOneReport(item.capsuleId, item.agentId, item.input, {
            signalExtractor: this.signalExtractor,
            extractSignals: this.extractSignals.bind(this),
            selectGene: (signals: SignalTag[], agentId: string) => this.selectGene(signals, agentId),
          });
        } catch (err) {
          console.error('[Evolution] Report processing failed:', (err as Error).message);
          try {
            const prisma = (await import('../db')).default;
            const capsule = await prisma.iMEvolutionCapsule.findUnique({ where: { id: item.capsuleId } });
            if (capsule) {
              const meta = JSON.parse(capsule.metadata || '{}');
              meta.extraction_status = 'failed';
              meta.extraction_error = (err as Error).message;
              await prisma.iMEvolutionCapsule.update({
                where: { id: item.capsuleId },
                data: { metadata: JSON.stringify(meta) },
              });
            }
          } catch {
            /* best effort */
          }
        }
      }
      this.processingReport = false;
    });
  }

  async processPendingReports(limit = 20): Promise<number> {
    return _processPendingReports(limit, {
      processOneReport: (capsuleId: string, agentId: string, input: EvolutionReportInput) =>
        _processOneReport(capsuleId, agentId, input, {
          signalExtractor: this.signalExtractor,
          extractSignals: this.extractSignals.bind(this),
          selectGene: (signals: SignalTag[], agentId: string) => this.selectGene(signals, agentId),
        }),
    });
  }

  // ===== Memory Graph Queries =====

  async getEdges(
    agentId: string,
    options?: { signalKey?: string; geneId?: string; limit?: number; scope?: string },
  ): Promise<EvolutionEdgeInfo[]> {
    return _getEdges(agentId, options);
  }

  // ===== Signal Clustering =====

  async computeSignalClusters(): Promise<number> {
    return _computeSignalClusters();
  }

  async lookupCluster(signalTypes: string[]) {
    return _lookupCluster(signalTypes);
  }

  // ===== Evolution Report =====

  async generateReport(agentId: string, scope = 'global'): Promise<EvolutionReport> {
    return _generateReport(agentId, scope);
  }

  // ===== Gene Creation Helper =====

  createGene(input: {
    category: GeneCategory;
    signals_match: string[] | SignalTag[];
    strategy: string[];
    preconditions?: string[];
    constraints?: Partial<PrismerGene['constraints']>;
    created_by: string;
    title?: string;
    description?: string;
  }): PrismerGene {
    return _createGene(input);
  }

  // ===== Seed Gene Initialization =====

  async ensureSeedGenesInTable(): Promise<void> {
    return _ensureSeedGenesInTable();
  }

  async seedGenesForNewAgent(agentId: string): Promise<void> {
    return _seedGenesForNewAgent(agentId);
  }

  async scanCreditReturns(): Promise<number> {
    return _scanCreditReturns();
  }

  // ===== Metrics Collection =====

  async collectMetrics(windowHours?: number, mode?: 'standard' | 'hypergraph') {
    return _collectMetrics(windowHours, mode);
  }

  async getMetricsComparison() {
    return _getMetricsComparison();
  }

  // ===== Public APIs =====

  async getPublicStats() {
    return _getPublicStats();
  }

  async getAdvancedMetrics() {
    return _getAdvancedMetrics();
  }

  async getPublicHotGenes(limit: number): Promise<PrismerGene[]> {
    return _getPublicHotGenes(limit);
  }

  async getPublicGenes(opts: {
    category?: string;
    search?: string;
    sort: 'newest' | 'most_used' | 'highest_success';
    page: number;
    limit: number;
  }) {
    return _getPublicGenes(opts);
  }

  async getPublicGeneDetail(geneId: string): Promise<PrismerGene | null> {
    return _getPublicGeneDetail(geneId);
  }

  async getPublicGeneCapsules(geneId: string, limit: number) {
    return _getPublicGeneCapsules(geneId, limit);
  }

  async getGeneLineage(geneId: string) {
    return _getGeneLineage(geneId);
  }

  async getPublicFeed(limit = 20) {
    return _getPublicFeed(limit);
  }

  async getStories(limit = 3, sinceMinutes = 30) {
    return _getStories(limit, sinceMinutes);
  }

  async getMapData(opts?: { topN?: number; includeGeneIds?: string[] }) {
    return _getMapData(opts);
  }

  /** POST /genes/:id/publish */
  async publishGene(agentId: string, geneId: string): Promise<PrismerGene | null> {
    return _publishGene(agentId, geneId, {
      creditService: this.creditService,
      achievementService: this.achievementService,
    });
  }

  /** Publish gene directly (skip canary) */
  async publishGeneDirect(agentId: string, geneId: string): Promise<PrismerGene | null> {
    return _publishGeneDirect(agentId, geneId);
  }

  /** POST /genes/import */
  async importPublicGene(agentId: string, geneId: string): Promise<PrismerGene | null> {
    return _importPublicGene(agentId, geneId, {
      creditService: this.creditService,
      achievementService: this.achievementService,
      getPublicGeneDetail: (id: string) => this.getPublicGeneDetail(id),
    });
  }

  /** POST /genes/fork */
  async forkGene(
    agentId: string,
    sourceGeneId: string,
    modifications?: { title?: string; signals_match?: string[] | SignalTag[]; strategy?: string[] },
  ): Promise<PrismerGene | null> {
    return _forkGene(agentId, sourceGeneId, modifications, {
      getPublicGeneDetail: (id: string) => this.getPublicGeneDetail(id),
    });
  }

  /** GET /capsules */
  async getCapsules(agentId: string, page: number, limit: number, scope = 'global') {
    return _getCapsules(agentId, page, limit, scope);
  }
}
