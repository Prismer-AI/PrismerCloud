/**
 * Evolution Map — Mock Data for Development
 *
 * Provides realistic sample data when the IM server is not available.
 * Covers: 4 domain clusters, 12 genes, 18 signals, ~30 edges, 3 stories.
 */

import type { EvolutionMapData, EvolutionStory } from '../types/evolution-map.types';

const now = new Date().toISOString();
const ago = (min: number) => new Date(Date.now() - min * 60000).toISOString();

export const MOCK_MAP_DATA: EvolutionMapData = {
  signals: [
    // ── Network cluster ──
    { key: 'error:rateLimit', category: 'error', frequency: 47, lastSeen: ago(2) },
    { key: 'error:timeout', category: 'error', frequency: 31, lastSeen: ago(5) },
    { key: 'error:http429', category: 'error', frequency: 22, lastSeen: ago(8) },
    { key: 'error:http503', category: 'error', frequency: 15, lastSeen: ago(30) },
    { key: 'error:authExpired', category: 'error', frequency: 12, lastSeen: ago(15) },
    // ── Code.Web cluster ──
    { key: 'task:tsTypeCheck', category: 'task', frequency: 38, lastSeen: ago(1) },
    { key: 'task:bundleSize', category: 'task', frequency: 19, lastSeen: ago(10) },
    { key: 'task:reactPerf', category: 'task', frequency: 14, lastSeen: ago(20) },
    { key: 'error:tsCompile', category: 'error', frequency: 25, lastSeen: ago(3) },
    // ── Code.Python cluster ──
    { key: 'task:pythonDebug', category: 'task', frequency: 16, lastSeen: ago(12) },
    { key: 'error:importError', category: 'error', frequency: 11, lastSeen: ago(25) },
    { key: 'task:depResolve', category: 'task', frequency: 9, lastSeen: ago(40) },
    // ── Code.Systems cluster ──
    { key: 'error:segfault', category: 'error', frequency: 8, lastSeen: ago(60) },
    { key: 'task:memoryLeak', category: 'task', frequency: 6, lastSeen: ago(45) },
    { key: 'capability:rustBorrow', category: 'capability', frequency: 13, lastSeen: ago(7) },
    // ── Cross-domain ──
    { key: 'error:httpGeneric', category: 'error', frequency: 28, lastSeen: ago(4) },
    { key: 'perf:latency', category: 'perf', frequency: 20, lastSeen: ago(6) },
    { key: 'tag:migration', category: 'tag', frequency: 5, lastSeen: null },
  ],

  genes: [
    // ── Network (repair + optimize) ──
    { id: 'gene-rate-limit', title: 'Rate Limit Backoff', category: 'optimize', successRate: 0.79, totalExecutions: 42, agentCount: 8, pqi: 74 },
    { id: 'gene-timeout-recovery', title: 'Timeout Recovery', category: 'repair', successRate: 0.94, totalExecutions: 28, agentCount: 5, pqi: 88 },
    { id: 'gene-auth-refresh', title: 'Auth Token Refresh', category: 'repair', successRate: 0.82, totalExecutions: 18, agentCount: 4, pqi: 71 },
    { id: 'gene-retry-orchestrator', title: 'Retry Orchestrator', category: 'optimize', successRate: 0.67, totalExecutions: 15, agentCount: 3, pqi: 58 },
    // ── Code.Web (repair + optimize + innovate) ──
    { id: 'gene-ts-type-fix', title: 'TS Type Fix', category: 'repair', successRate: 0.85, totalExecutions: 35, agentCount: 7, pqi: 80 },
    { id: 'gene-bundle-opt', title: 'Bundle Optimizer', category: 'optimize', successRate: 0.71, totalExecutions: 12, agentCount: 3, pqi: 62 },
    { id: 'gene-react-perf', title: 'React Perf Tune', category: 'optimize', successRate: 0.76, totalExecutions: 10, agentCount: 2, pqi: 65 },
    { id: 'gene-ts-rust-rewriter', title: 'TS to Rust Rewriter', category: 'innovate', successRate: 0.45, totalExecutions: 4, agentCount: 1, pqi: 32 },
    // ── Code.Python ──
    { id: 'gene-py-debug', title: 'Python Debug Recovery', category: 'repair', successRate: 0.88, totalExecutions: 20, agentCount: 4, pqi: 82 },
    { id: 'gene-dep-resolver', title: 'Dependency Resolver', category: 'repair', successRate: 0.73, totalExecutions: 8, agentCount: 2, pqi: 55 },
    // ── Code.Systems ──
    { id: 'gene-rust-borrow', title: 'Rust Borrow Fix', category: 'repair', successRate: 0.91, totalExecutions: 16, agentCount: 3, pqi: 85 },
    { id: 'gene-mem-opt', title: 'Memory Optimizer', category: 'optimize', successRate: 0.68, totalExecutions: 7, agentCount: 2, pqi: 50 },
  ],

  edges: [
    // ── Network cluster edges ──
    { signalKey: 'error:rateLimit', geneId: 'gene-rate-limit', alpha: 34, beta: 10, confidence: 0.77, routingWeight: 0.77, totalObs: 42, isExploring: false, bimodalityIndex: 0.1, coverageLevel: 2 },
    { signalKey: 'error:http429', geneId: 'gene-rate-limit', alpha: 16, beta: 8, confidence: 0.67, routingWeight: 0.67, totalObs: 22, isExploring: false, bimodalityIndex: 0.15, coverageLevel: 1 },
    { signalKey: 'error:timeout', geneId: 'gene-timeout-recovery', alpha: 27, beta: 3, confidence: 0.90, routingWeight: 0.90, totalObs: 28, isExploring: false, bimodalityIndex: 0.05, coverageLevel: 2 },
    { signalKey: 'error:http503', geneId: 'gene-timeout-recovery', alpha: 12, beta: 4, confidence: 0.75, routingWeight: 0.75, totalObs: 14, isExploring: false, bimodalityIndex: 0.2, coverageLevel: 1 },
    { signalKey: 'error:authExpired', geneId: 'gene-auth-refresh', alpha: 15, beta: 4, confidence: 0.79, routingWeight: 0.79, totalObs: 17, isExploring: false, bimodalityIndex: 0.1, coverageLevel: 2 },
    { signalKey: 'error:rateLimit', geneId: 'gene-retry-orchestrator', alpha: 9, beta: 7, confidence: 0.56, routingWeight: 0.56, totalObs: 14, isExploring: false, bimodalityIndex: 0.35, coverageLevel: 1 },
    { signalKey: 'error:timeout', geneId: 'gene-retry-orchestrator', alpha: 5, beta: 4, confidence: 0.56, routingWeight: 0.56, totalObs: 7, isExploring: true, bimodalityIndex: 0.4, coverageLevel: 0 },

    // ── Code.Web cluster edges ──
    { signalKey: 'task:tsTypeCheck', geneId: 'gene-ts-type-fix', alpha: 30, beta: 6, confidence: 0.83, routingWeight: 0.83, totalObs: 34, isExploring: false, bimodalityIndex: 0.08, coverageLevel: 2 },
    { signalKey: 'error:tsCompile', geneId: 'gene-ts-type-fix', alpha: 20, beta: 6, confidence: 0.77, routingWeight: 0.77, totalObs: 24, isExploring: false, bimodalityIndex: 0.12, coverageLevel: 1 },
    { signalKey: 'task:bundleSize', geneId: 'gene-bundle-opt', alpha: 9, beta: 4, confidence: 0.69, routingWeight: 0.69, totalObs: 11, isExploring: false, bimodalityIndex: 0.18, coverageLevel: 1 },
    { signalKey: 'task:reactPerf', geneId: 'gene-react-perf', alpha: 8, beta: 3, confidence: 0.73, routingWeight: 0.73, totalObs: 9, isExploring: true, bimodalityIndex: 0.2, coverageLevel: 1 },
    { signalKey: 'task:tsTypeCheck', geneId: 'gene-ts-rust-rewriter', alpha: 3, beta: 3, confidence: 0.50, routingWeight: 0.50, totalObs: 4, isExploring: true, bimodalityIndex: 0.6, coverageLevel: 0 },

    // ── Code.Python cluster edges ──
    { signalKey: 'task:pythonDebug', geneId: 'gene-py-debug', alpha: 18, beta: 3, confidence: 0.86, routingWeight: 0.86, totalObs: 19, isExploring: false, bimodalityIndex: 0.06, coverageLevel: 2 },
    { signalKey: 'error:importError', geneId: 'gene-py-debug', alpha: 8, beta: 4, confidence: 0.67, routingWeight: 0.67, totalObs: 10, isExploring: false, bimodalityIndex: 0.25, coverageLevel: 1 },
    { signalKey: 'task:depResolve', geneId: 'gene-dep-resolver', alpha: 6, beta: 3, confidence: 0.67, routingWeight: 0.67, totalObs: 7, isExploring: true, bimodalityIndex: 0.15, coverageLevel: 1 },
    { signalKey: 'error:importError', geneId: 'gene-dep-resolver', alpha: 4, beta: 2, confidence: 0.67, routingWeight: 0.67, totalObs: 4, isExploring: true, bimodalityIndex: 0.3, coverageLevel: 0 },

    // ── Code.Systems cluster edges ──
    { signalKey: 'error:segfault', geneId: 'gene-rust-borrow', alpha: 7, beta: 2, confidence: 0.78, routingWeight: 0.78, totalObs: 7, isExploring: true, bimodalityIndex: 0.1, coverageLevel: 1 },
    { signalKey: 'capability:rustBorrow', geneId: 'gene-rust-borrow', alpha: 12, beta: 2, confidence: 0.86, routingWeight: 0.86, totalObs: 12, isExploring: false, bimodalityIndex: 0.05, coverageLevel: 2 },
    { signalKey: 'task:memoryLeak', geneId: 'gene-mem-opt', alpha: 5, beta: 3, confidence: 0.63, routingWeight: 0.63, totalObs: 6, isExploring: true, bimodalityIndex: 0.22, coverageLevel: 1 },

    // ── Cross-domain edges (shared signals connecting different clusters) ──
    { signalKey: 'error:httpGeneric', geneId: 'gene-rate-limit', alpha: 12, beta: 5, confidence: 0.71, routingWeight: 0.71, totalObs: 15, isExploring: false, bimodalityIndex: 0.2, coverageLevel: 0 },
    { signalKey: 'error:httpGeneric', geneId: 'gene-timeout-recovery', alpha: 10, beta: 4, confidence: 0.71, routingWeight: 0.71, totalObs: 12, isExploring: false, bimodalityIndex: 0.15, coverageLevel: 0 },
    { signalKey: 'error:httpGeneric', geneId: 'gene-ts-type-fix', alpha: 4, beta: 3, confidence: 0.57, routingWeight: 0.57, totalObs: 5, isExploring: true, bimodalityIndex: 0.45, coverageLevel: 0 },
    { signalKey: 'perf:latency', geneId: 'gene-rate-limit', alpha: 8, beta: 4, confidence: 0.67, routingWeight: 0.67, totalObs: 10, isExploring: false, bimodalityIndex: 0.18, coverageLevel: 1 },
    { signalKey: 'perf:latency', geneId: 'gene-bundle-opt', alpha: 5, beta: 3, confidence: 0.63, routingWeight: 0.63, totalObs: 6, isExploring: true, bimodalityIndex: 0.3, coverageLevel: 0 },
    { signalKey: 'perf:latency', geneId: 'gene-mem-opt', alpha: 3, beta: 2, confidence: 0.60, routingWeight: 0.60, totalObs: 3, isExploring: true, bimodalityIndex: 0.4, coverageLevel: 0 },
    { signalKey: 'tag:migration', geneId: 'gene-ts-rust-rewriter', alpha: 2, beta: 2, confidence: 0.50, routingWeight: 0.50, totalObs: 2, isExploring: true, bimodalityIndex: 0.5, coverageLevel: 0 },
  ],

  recentEvents: [
    { signalKey: 'error:rateLimit', geneId: 'gene-rate-limit', outcome: 'success', agentName: 'market-analyst', timestamp: ago(0.03) },
    { signalKey: 'task:tsTypeCheck', geneId: 'gene-ts-type-fix', outcome: 'success', agentName: 'code-reviewer', timestamp: ago(3) },
    { signalKey: 'error:timeout', geneId: 'gene-retry-orchestrator', outcome: 'failed', agentName: 'data-pipeline', timestamp: ago(8) },
    { signalKey: 'task:pythonDebug', geneId: 'gene-py-debug', outcome: 'success', agentName: 'py-assistant', timestamp: ago(12) },
    { signalKey: 'capability:rustBorrow', geneId: 'gene-rust-borrow', outcome: 'success', agentName: 'sys-engineer', timestamp: ago(20) },
  ],

  stats: {
    totalExecutions: 287,
    systemSuccessRate: 0.78,
    activeAgents: 12,
    explorationRate: 0.32,
    totalSignals: 18,
    totalGenes: 12,
    totalEdges: 25,
  },
};

export const MOCK_STORIES: EvolutionStory[] = [
  {
    id: 'story-1',
    timestamp: ago(0.03),
    agent: { id: 'agent-market', name: 'market-analyst' },
    task: { description: 'Q1 Revenue Analysis', phase: 'Data Fetch' },
    signal: { key: 'error:rateLimit', category: 'error', label: 'Rate Limit Error' },
    gene: { id: 'gene-rate-limit', name: 'Rate Limit Backoff', category: 'optimize', strategyPreview: 'Exponential backoff retry, max 3 attempts' },
    outcome: 'success',
    effect: {
      actionDescription: 'Waited 2s then retried x2, succeeded on 2nd retry',
      resultSummary: 'Fetched 47 data points successfully',
      geneSuccessRateBefore: 0.76,
      geneSuccessRateAfter: 0.79,
      successRateDelta: 0.03,
      isExplorationEvent: false,
    },
  },
  {
    id: 'story-2',
    timestamp: ago(3),
    agent: { id: 'agent-reviewer', name: 'code-reviewer' },
    task: { description: 'PR Security Scan', phase: 'Type Check' },
    signal: { key: 'task:tsTypeCheck', category: 'task', label: 'TypeScript Type Check' },
    gene: { id: 'gene-ts-type-fix', name: 'TS Type Fix', category: 'repair', strategyPreview: 'Auto-infer missing types from usage context' },
    outcome: 'success',
    effect: {
      actionDescription: 'Inferred 3 missing types from function signatures',
      resultSummary: 'Type errors reduced from 12 to 0',
      geneSuccessRateBefore: 0.83,
      geneSuccessRateAfter: 0.85,
      successRateDelta: 0.02,
      isExplorationEvent: false,
    },
  },
  {
    id: 'story-3',
    timestamp: ago(8),
    agent: { id: 'agent-pipeline', name: 'data-pipeline' },
    task: { description: 'ETL Job Recovery', phase: 'API Call' },
    signal: { key: 'error:timeout', category: 'error', label: 'Timeout Error' },
    gene: { id: 'gene-retry-orchestrator', name: 'Retry Orchestrator', category: 'optimize', strategyPreview: 'Coordinated retry across dependent services' },
    outcome: 'failed',
    effect: {
      actionDescription: 'Retried 3 times with increasing delay, all timed out',
      resultSummary: 'ETL job failed, queued for next window',
      geneSuccessRateBefore: 0.69,
      geneSuccessRateAfter: 0.67,
      successRateDelta: -0.02,
      isExplorationEvent: true,
    },
  },
];
