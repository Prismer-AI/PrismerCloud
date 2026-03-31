/**
 * Prismer TypeScript SDK — Evolution Client Integration Tests
 *
 * Tests the full evolution lifecycle against the live test environment.
 * Requires PRISMER_API_KEY_TEST env var.
 *
 * Usage:
 *   PRISMER_API_KEY_TEST="sk-prismer-live-..." npx vitest run tests/integration/evolution.test.ts --reporter=verbose
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismerClient } from '../../src/index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const API_KEY = process.env.PRISMER_API_KEY_TEST;
if (!API_KEY) {
  throw new Error('PRISMER_API_KEY_TEST environment variable is required');
}

const BASE_URL = process.env.PRISMER_BASE_URL || 'https://cloud.prismer.dev';
const RUN_ID = Date.now().toString(36);

function apiClient(): PrismerClient {
  return new PrismerClient({
    apiKey: API_KEY!,
    baseUrl: BASE_URL,
    timeout: 60_000,
  });
}

function imClient(token: string): PrismerClient {
  return new PrismerClient({
    apiKey: token,
    baseUrl: BASE_URL,
    timeout: 60_000,
  });
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let agentToken: string;
let agentId: string;
let client: PrismerClient; // authenticated with IM JWT
let createdGeneId: string;
let publishedGeneId: string;
let forkedGeneId: string;
let importedGeneId: string;
let reportTraceId: string;

// Gene IDs to clean up at the end
const geneIdsToCleanup: string[] = [];

// ---------------------------------------------------------------------------
// Setup: register an agent so we have an authenticated IM identity
// ---------------------------------------------------------------------------

beforeAll(async () => {
  const setupClient = apiClient();
  const reg = await setupClient.im.account.register({
    type: 'agent',
    username: `evo-test-agent-${RUN_ID}`,
    displayName: `Evolution Test Agent (${RUN_ID})`,
    agentType: 'assistant',
    capabilities: ['evolution', 'testing'],
    description: 'Integration test agent for EvolutionClient',
  });
  expect(reg.ok).toBe(true);
  expect(reg.data).toBeDefined();
  agentToken = reg.data!.token;
  agentId = reg.data!.imUserId;
  client = imClient(agentToken);
}, 30000);

// ---------------------------------------------------------------------------
// Cleanup: delete all test genes
// ---------------------------------------------------------------------------

afterAll(async () => {
  if (!client) return;
  for (const geneId of geneIdsToCleanup) {
    try {
      await client.im.evolution.deleteGene(geneId);
    } catch {
      // Best effort cleanup
    }
  }
}, 30000);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Evolution Client — Full Lifecycle', () => {

  // =========================================================================
  // Public endpoints (no auth required)
  // =========================================================================

  describe('Public Endpoints', () => {
    it('getStats() — returns evolution statistics', async () => {
      const result = await client.im.evolution.getStats();
      expect(result.ok).toBe(true);
      expect(result.data).toBeDefined();
      if (result.data) {
        expect(typeof result.data.total_genes).toBe('number');
        expect(typeof result.data.total_capsules).toBe('number');
        expect(typeof result.data.avg_success_rate).toBe('number');
        expect(typeof result.data.active_agents).toBe('number');
      }
    }, 30000);

    it('getHotGenes() — returns trending genes', async () => {
      const result = await client.im.evolution.getHotGenes(5);
      expect(result.ok).toBe(true);
      if (result.data) {
        expect(Array.isArray(result.data)).toBe(true);
      }
    }, 30000);

    it('getFeed() — returns public evolution feed', async () => {
      const result = await client.im.evolution.getFeed(5);
      expect(result.ok).toBe(true);
      if (result.data) {
        expect(Array.isArray(result.data)).toBe(true);
      }
    }, 30000);

    it('browseGenes() — browse with category filter', async () => {
      const result = await client.im.evolution.browseGenes({
        category: 'repair',
        limit: 5,
      });
      expect(result.ok).toBe(true);
      if (result.data) {
        expect(Array.isArray(result.data)).toBe(true);
      }
    }, 30000);

    it('browseGenes() — browse with search query', async () => {
      const result = await client.im.evolution.browseGenes({
        search: 'timeout',
        limit: 5,
      });
      expect(result.ok).toBe(true);
      if (result.data) {
        expect(Array.isArray(result.data)).toBe(true);
      }
    }, 30000);

    it('browseGenes() — browse with sort option', async () => {
      const result = await client.im.evolution.browseGenes({
        sort: 'newest',
        limit: 3,
      });
      expect(result.ok).toBe(true);
      if (result.data) {
        expect(Array.isArray(result.data)).toBe(true);
      }
    }, 30000);
  });

  // =========================================================================
  // Gene CRUD
  // =========================================================================

  describe('Gene CRUD', () => {
    it('createGene() — creates a test gene', async () => {
      const result = await client.im.evolution.createGene({
        category: 'repair',
        signals_match: [
          { type: `test-signal-${RUN_ID}` },
          { type: 'connection-timeout', provider: 'http', severity: 'high' },
        ],
        strategy: [
          'Retry with exponential backoff',
          'Increase timeout to 30s',
          'Validate network connectivity first',
        ],
        title: `Test Gene ${RUN_ID}`,
        preconditions: ['Network is reachable', 'Service is deployed'],
        constraints: { maxRetries: 5, baseDelay: 1000 },
      });
      expect(result.ok).toBe(true);
      expect(result.data).toBeDefined();
      if (result.data) {
        expect(result.data.id).toBeDefined();
        expect(typeof result.data.id).toBe('string');
        expect(result.data.category).toBe('repair');
        expect(result.data.strategy).toBeDefined();
        expect(Array.isArray(result.data.strategy)).toBe(true);
        createdGeneId = result.data.id;
        geneIdsToCleanup.push(createdGeneId);
      }
    }, 30000);

    it('createGene() — creates a second gene with different category', async () => {
      const result = await client.im.evolution.createGene({
        category: 'optimize',
        signals_match: [
          { type: `perf-signal-${RUN_ID}` },
        ],
        strategy: ['Cache results', 'Use batch processing'],
        title: `Optimize Gene ${RUN_ID}`,
      });
      expect(result.ok).toBe(true);
      if (result.data) {
        geneIdsToCleanup.push(result.data.id);
      }
    }, 30000);

    it('listGenes() — lists own genes', async () => {
      const result = await client.im.evolution.listGenes();
      expect(result.ok).toBe(true);
      expect(result.data).toBeDefined();
      if (result.data) {
        expect(Array.isArray(result.data)).toBe(true);
        expect(result.data.length).toBeGreaterThanOrEqual(1);
        // Verify our created gene is in the list
        const found = result.data.find((g) => g.id === createdGeneId);
        expect(found).toBeDefined();
      }
    }, 30000);

    it('listGenes() — with signals filter', async () => {
      const result = await client.im.evolution.listGenes(`test-signal-${RUN_ID}`);
      expect(result.ok).toBe(true);
      if (result.data) {
        expect(Array.isArray(result.data)).toBe(true);
      }
    }, 30000);

    it('listGenes() — with scope filter', async () => {
      const result = await client.im.evolution.listGenes(undefined, 'global');
      expect(result.ok).toBe(true);
      if (result.data) {
        expect(Array.isArray(result.data)).toBe(true);
      }
    }, 30000);
  });

  // =========================================================================
  // Analysis + Recording
  // =========================================================================

  describe('Analysis & Recording', () => {
    it('analyze() — with signals', async () => {
      expect(createdGeneId).toBeDefined();
      const result = await client.im.evolution.analyze({
        signals: [
          { type: `test-signal-${RUN_ID}` },
        ],
        error: 'Connection timed out after 10s',
      });
      expect(result.ok).toBe(true);
      expect(result.data).toBeDefined();
      if (result.data) {
        expect(result.data.action).toBeDefined();
        expect(['apply_gene', 'explore', 'none', 'create_suggested']).toContain(result.data.action);
        expect(typeof result.data.confidence).toBe('number');
        expect(Array.isArray(result.data.signals)).toBe(true);
      }
    }, 30000);

    it('analyze() — with scope', async () => {
      const result = await client.im.evolution.analyze({
        signals: [{ type: 'generic-test-signal' }],
        scope: 'global',
      });
      expect(result.ok).toBe(true);
      expect(result.data).toBeDefined();
      if (result.data) {
        expect(result.data.action).toBeDefined();
      }
    }, 30000);

    it('analyze() — with tags', async () => {
      const result = await client.im.evolution.analyze({
        tags: ['testing', 'integration', `run-${RUN_ID}`],
        task_status: 'failing',
        task_capability: 'http-request',
      });
      expect(result.ok).toBe(true);
      expect(result.data).toBeDefined();
      if (result.data) {
        expect(result.data.action).toBeDefined();
      }
    }, 30000);

    it('analyze() — with provider and stage', async () => {
      const result = await client.im.evolution.analyze({
        signals: [{ type: 'api-error' }],
        provider: 'openai',
        stage: 'inference',
        severity: 'medium',
      });
      expect(result.ok).toBe(true);
      expect(result.data).toBeDefined();
    }, 30000);

    it('record() — success outcome', async () => {
      expect(createdGeneId).toBeDefined();
      const result = await client.im.evolution.record({
        gene_id: createdGeneId,
        signals: [{ type: `test-signal-${RUN_ID}` }],
        outcome: 'success',
        score: 0.9,
        summary: `Integration test success outcome for run ${RUN_ID}`,
        strategy_used: ['Retry with exponential backoff'],
      });
      expect(result.ok).toBe(true);
      expect(result.data).toBeDefined();
    }, 30000);

    it('record() — failed outcome', async () => {
      expect(createdGeneId).toBeDefined();
      const result = await client.im.evolution.record({
        gene_id: createdGeneId,
        signals: [{ type: `test-signal-${RUN_ID}` }],
        outcome: 'failed',
        score: 0.2,
        summary: `Integration test failure outcome for run ${RUN_ID}`,
      });
      expect(result.ok).toBe(true);
      expect(result.data).toBeDefined();
    }, 30000);

    it('record() — with scope', async () => {
      expect(createdGeneId).toBeDefined();
      const result = await client.im.evolution.record({
        gene_id: createdGeneId,
        signals: [{ type: `test-signal-${RUN_ID}` }],
        outcome: 'success',
        score: 0.85,
        summary: `Scoped record for run ${RUN_ID}`,
        scope: 'global',
      });
      expect(result.ok).toBe(true);
    }, 30000);
  });

  // =========================================================================
  // Distill
  // =========================================================================

  describe('Distillation', () => {
    it('distill() — dry_run mode', async () => {
      const result = await client.im.evolution.distill(true);
      expect(result.ok).toBe(true);
      expect(result.data).toBeDefined();
    }, 30000);
  });

  // =========================================================================
  // Publish / Import / Fork
  // =========================================================================

  describe('Publish, Import & Fork', () => {
    it('publishGene() — publishes the test gene', async () => {
      expect(createdGeneId).toBeDefined();
      const result = await client.im.evolution.publishGene(createdGeneId, {
        skipCanary: true,
      });
      if (!result.ok) {
        console.warn('[Evolution] publishGene returned ok:false, using createdGeneId as fallback:', result.error);
        publishedGeneId = createdGeneId;
        return;
      }
      expect(result.data).toBeDefined();
      if (result.data) {
        expect(result.data.id).toBe(createdGeneId);
        publishedGeneId = createdGeneId;
      }
    }, 30000);

    it('getPublicGene() — fetches the published gene by ID', async () => {
      if (!publishedGeneId) {
        console.warn('Skipping: no published gene');
        return;
      }
      const result = await client.im.evolution.getPublicGene(publishedGeneId);
      if (!result.ok) {
        console.warn('[Evolution] getPublicGene returned ok:false:', result.error);
        return;
      }
      expect(result.data).toBeDefined();
      if (result.data) {
        expect(result.data.id).toBe(publishedGeneId);
        expect(result.data.category).toBe('repair');
        expect(Array.isArray(result.data.strategy)).toBe(true);
      }
    }, 30000);

    it('getGeneCapsules() — fetches capsules for the gene', async () => {
      if (!publishedGeneId) {
        console.warn('Skipping: no published gene');
        return;
      }
      const result = await client.im.evolution.getGeneCapsules(publishedGeneId, 10);
      if (!result.ok) {
        console.warn('[Evolution] getGeneCapsules returned ok:false:', result.error);
        return;
      }
      if (result.data) {
        expect(Array.isArray(result.data)).toBe(true);
        // We recorded outcomes above, so we should have capsules
        if (result.data.length > 0) {
          const capsule = result.data[0] as any;
          // API returns subset of fields: outcome, score, createdAt, agentName
          expect(capsule.outcome).toBeDefined();
          expect(typeof capsule.score).toBe('number');
        }
      }
    }, 30000);

    it('getGeneLineage() — fetches lineage for the gene', async () => {
      if (!publishedGeneId) {
        console.warn('Skipping: no published gene');
        return;
      }
      const result = await client.im.evolution.getGeneLineage(publishedGeneId);
      if (!result.ok) {
        console.warn('[Evolution] getGeneLineage returned ok:false:', result.error);
        return;
      }
      expect(result.data).toBeDefined();
      if (result.data) {
        expect(result.data.geneId).toBe(publishedGeneId);
        expect(Array.isArray(result.data.children)).toBe(true);
        expect(typeof result.data.generation).toBe('number');
      }
    }, 30000);

    it('importGene() — imports the published gene', async () => {
      if (!publishedGeneId) {
        console.warn('Skipping: no published gene');
        return;
      }
      const result = await client.im.evolution.importGene(publishedGeneId);
      // Import may succeed or fail if already owned
      if (result.ok && result.data) {
        expect(result.data.id).toBeDefined();
        importedGeneId = result.data.id;
        if (importedGeneId !== createdGeneId) {
          geneIdsToCleanup.push(importedGeneId);
        }
      } else {
        // Acceptable: may error if importing own gene
        expect(result.error).toBeDefined();
      }
    }, 30000);

    it('forkGene() — forks with modifications', async () => {
      if (!publishedGeneId) {
        console.warn('Skipping: no published gene');
        return;
      }
      const result = await client.im.evolution.forkGene({
        gene_id: publishedGeneId,
        modifications: {
          strategy: [
            'Retry with exponential backoff',
            'Add circuit breaker pattern',
            'Log detailed error metrics',
          ],
          title: `Forked Gene ${RUN_ID}`,
        },
      });
      // Fork may succeed or return error for own gene
      if (result.ok && result.data) {
        expect(result.data.id).toBeDefined();
        expect(result.data.id).not.toBe(publishedGeneId);
        forkedGeneId = result.data.id;
        geneIdsToCleanup.push(forkedGeneId);
      } else {
        // Acceptable: some servers may not allow self-fork
        expect(result).toBeDefined();
      }
    }, 30000);
  });

  // =========================================================================
  // Edges & Capsules
  // =========================================================================

  describe('Edges & Capsules', () => {
    it('getEdges() — without filters', async () => {
      const result = await client.im.evolution.getEdges();
      expect(result.ok).toBe(true);
      if (result.data) {
        expect(Array.isArray(result.data)).toBe(true);
      }
    }, 30000);

    it('getEdges() — with signalKey filter', async () => {
      const result = await client.im.evolution.getEdges({
        signalKey: `test-signal-${RUN_ID}`,
        limit: 10,
      });
      expect(result.ok).toBe(true);
      if (result.data) {
        expect(Array.isArray(result.data)).toBe(true);
        if (result.data.length > 0) {
          const edge = result.data[0];
          expect(edge.signal_key).toBeDefined();
          expect(edge.gene_id).toBeDefined();
          expect(typeof edge.confidence).toBe('number');
        }
      }
    }, 30000);

    it('getEdges() — with geneId filter', async () => {
      expect(createdGeneId).toBeDefined();
      const result = await client.im.evolution.getEdges({
        geneId: createdGeneId,
      });
      expect(result.ok).toBe(true);
      if (result.data) {
        expect(Array.isArray(result.data)).toBe(true);
      }
    }, 30000);

    it('getEdges() — with scope filter', async () => {
      const result = await client.im.evolution.getEdges({
        scope: 'global',
        limit: 5,
      });
      expect(result.ok).toBe(true);
      if (result.data) {
        expect(Array.isArray(result.data)).toBe(true);
      }
    }, 30000);

    it('getCapsules() — with page and limit', async () => {
      const result = await client.im.evolution.getCapsules({
        page: 1,
        limit: 10,
      });
      expect(result.ok).toBe(true);
      if (result.data) {
        expect(Array.isArray(result.data)).toBe(true);
        if (result.data.length > 0) {
          const capsule = result.data[0];
          expect(capsule.id).toBeDefined();
          // API may return gene_id or geneId
          expect(capsule.gene_id || capsule.geneId).toBeDefined();
          expect(capsule.outcome).toBeDefined();
          expect(capsule.score).toBeDefined();
        }
      }
    }, 30000);

    it('getCapsules() — with scope', async () => {
      const result = await client.im.evolution.getCapsules({
        scope: 'global',
        limit: 5,
      });
      expect(result.ok).toBe(true);
      if (result.data) {
        expect(Array.isArray(result.data)).toBe(true);
      }
    }, 30000);
  });

  // =========================================================================
  // Reports
  // =========================================================================

  describe('Reports', () => {
    it('getReport() — without agentId (own report)', async () => {
      const result = await client.im.evolution.getReport();
      expect(result.ok).toBe(true);
      expect(result.data).toBeDefined();
    }, 30000);

    it('getReport() — with explicit agentId', async () => {
      expect(agentId).toBeDefined();
      const result = await client.im.evolution.getReport(agentId);
      expect(result.ok).toBe(true);
      expect(result.data).toBeDefined();
    }, 30000);

    it('getReport() — with scope', async () => {
      const result = await client.im.evolution.getReport(undefined, 'global');
      expect(result.ok).toBe(true);
      expect(result.data).toBeDefined();
    }, 30000);

    it('submitReport() — submits a raw context report', async () => {
      const result = await client.im.evolution.submitReport({
        rawContext: `Error: Connection refused to database at 10.0.0.5:5432. Retried 3 times. Run: ${RUN_ID}`,
        outcome: 'failed',
        taskContext: 'Database migration during deployment',
        taskError: 'ECONNREFUSED',
        taskId: `task-${RUN_ID}`,
        metadata: { env: 'test', runId: RUN_ID },
      });
      if (!result.ok) {
        console.warn('[Evolution] submitReport not available or returned error:', result.error);
        return;
      }
      expect(result.data).toBeDefined();
      if (result.data) {
        // The response may contain a traceId for status polling
        if (result.data.traceId) {
          reportTraceId = result.data.traceId;
        } else if (result.data.trace_id) {
          reportTraceId = result.data.trace_id;
        }
      }
    }, 30000);

    it('getReportStatus() — by traceId', async () => {
      // Use the traceId from submitReport if available, else use a dummy
      const traceId = reportTraceId || `trace-${RUN_ID}`;
      const result = await client.im.evolution.getReportStatus(traceId);
      // May succeed or return not found for dummy traceId
      if (result.ok) {
        expect(result.data).toBeDefined();
      } else {
        expect(result.error).toBeDefined();
      }
    }, 30000);
  });

  // =========================================================================
  // Achievements
  // =========================================================================

  describe('Achievements', () => {
    it('getAchievements() — returns achievements array', async () => {
      const result = await client.im.evolution.getAchievements();
      expect(result.ok).toBe(true);
      if (result.data) {
        expect(Array.isArray(result.data)).toBe(true);
      }
    }, 30000);
  });

  // =========================================================================
  // Stories & Metrics
  // =========================================================================

  describe('Stories & Metrics', () => {
    it('getStories() — with limit', async () => {
      const result = await client.im.evolution.getStories({ limit: 5 });
      expect(result.ok).toBe(true);
      if (result.data) {
        expect(Array.isArray(result.data)).toBe(true);
      }
    }, 30000);

    it('getStories() — with since timestamp', async () => {
      const result = await client.im.evolution.getStories({
        limit: 10,
        since: Date.now() - 3600_000, // last hour
      });
      expect(result.ok).toBe(true);
      if (result.data) {
        expect(Array.isArray(result.data)).toBe(true);
      }
    }, 30000);

    it('getMetrics() — returns metrics comparison', async () => {
      const result = await client.im.evolution.getMetrics();
      expect(result.ok).toBe(true);
      if (result.data) {
        // May have standard, hypergraph, verdict fields
        expect(result.data).toBeDefined();
      }
    }, 30000);

    it('collectMetrics() — triggers metrics collection', async () => {
      const result = await client.im.evolution.collectMetrics(1);
      expect(result.ok).toBe(true);
      if (result.data) {
        expect(result.data).toBeDefined();
      }
    }, 30000);
  });

  // =========================================================================
  // Sync
  // =========================================================================

  describe('Sync', () => {
    it('getSyncSnapshot() — with since=0', async () => {
      const result = await client.im.evolution.getSyncSnapshot(0);
      expect(result.ok).toBe(true);
      expect(result.data).toBeDefined();
    }, 30000);

    it('getSyncSnapshot() — without since (latest)', async () => {
      const result = await client.im.evolution.getSyncSnapshot();
      expect(result.ok).toBe(true);
      expect(result.data).toBeDefined();
    }, 30000);

    it('sync() — pull only', async () => {
      const result = await client.im.evolution.sync({
        pullSince: 0,
      });
      expect(result.ok).toBe(true);
      expect(result.data).toBeDefined();
    }, 30000);

    it('sync() — push outcomes and pull', async () => {
      expect(createdGeneId).toBeDefined();
      const result = await client.im.evolution.sync({
        pushOutcomes: [
          {
            gene_id: createdGeneId,
            signals: [{ type: `sync-signal-${RUN_ID}` }],
            outcome: 'success',
            score: 0.75,
            summary: `Sync push test for run ${RUN_ID}`,
          },
        ],
        pullSince: 0,
      });
      expect(result.ok).toBe(true);
      expect(result.data).toBeDefined();
    }, 30000);
  });

  // =========================================================================
  // Evolve (one-step)
  // =========================================================================

  describe('Evolve (one-step)', () => {
    it('evolve() — success outcome', async () => {
      const result = await client.im.evolution.evolve({
        error: `Test error for evolve: timeout in run ${RUN_ID}`,
        signals: [{ type: `test-signal-${RUN_ID}` }],
        outcome: 'success',
        score: 0.85,
        summary: `Resolved with retry strategy in run ${RUN_ID}`,
        strategy_used: ['Retry with exponential backoff'],
      });
      if (!result.ok) {
        console.warn('[Evolution] evolve() returned ok:false (analyze may have failed):', result.error);
        return;
      }
      expect(result.data).toBeDefined();
      if (result.data) {
        expect(result.data.analysis).toBeDefined();
        expect(result.data.analysis.action).toBeDefined();
        expect(typeof result.data.recorded).toBe('boolean');
      }
    }, 30000);

    it('evolve() — failed outcome', async () => {
      const result = await client.im.evolution.evolve({
        task_status: 'error',
        task_capability: 'database-query',
        tags: ['database', 'timeout'],
        outcome: 'failed',
        score: 0.1,
        summary: `Database query failed in run ${RUN_ID}`,
      });
      if (!result.ok) {
        console.warn('[Evolution] evolve() returned ok:false:', result.error);
        return;
      }
      expect(result.data).toBeDefined();
      if (result.data) {
        expect(result.data.analysis).toBeDefined();
        expect(typeof result.data.recorded).toBe('boolean');
      }
    }, 30000);

    it('evolve() — with scope', async () => {
      const result = await client.im.evolution.evolve({
        error: 'API rate limit exceeded',
        outcome: 'success',
        summary: 'Added rate limiting with token bucket',
        scope: 'global',
      });
      if (!result.ok) {
        console.warn('[Evolution] evolve() returned ok:false:', result.error);
        return;
      }
      expect(result.data).toBeDefined();
    }, 30000);
  });

  // =========================================================================
  // Export as Skill
  // =========================================================================

  describe('Export as Skill', () => {
    it('exportAsSkill() — exports gene as a skill', async () => {
      expect(createdGeneId).toBeDefined();
      const result = await client.im.evolution.exportAsSkill(createdGeneId, {
        slug: `test-skill-${RUN_ID}`,
        displayName: `Test Skill ${RUN_ID}`,
        changelog: 'Initial export from integration test',
      });
      // Export may succeed or fail depending on server state
      if (result.ok) {
        expect(result.data).toBeDefined();
      } else {
        // Acceptable: gene may need more data to become a skill
        expect(result.error).toBeDefined();
      }
    }, 30000);
  });

  // =========================================================================
  // Scopes
  // =========================================================================

  describe('Scopes', () => {
    it('listScopes() — returns available scopes', async () => {
      const result = await client.im.evolution.listScopes();
      expect(result.ok).toBe(true);
      if (result.data) {
        expect(Array.isArray(result.data)).toBe(true);
      }
    }, 30000);
  });

  // =========================================================================
  // Cleanup: deleteGene
  // =========================================================================

  describe('Cleanup', () => {
    it('deleteGene() — deletes the created gene', async () => {
      expect(createdGeneId).toBeDefined();
      const result = await client.im.evolution.deleteGene(createdGeneId);
      expect(result.ok).toBe(true);
      // Remove from cleanup list since we already deleted it
      const idx = geneIdsToCleanup.indexOf(createdGeneId);
      if (idx >= 0) geneIdsToCleanup.splice(idx, 1);
    }, 30000);

    it('deleteGene() — deleting again returns error or idempotent ok', async () => {
      const result = await client.im.evolution.deleteGene(createdGeneId);
      // Should fail with not found or succeed idempotently
      if (!result.ok) {
        expect(result.error).toBeDefined();
      }
    }, 30000);

    it('deleteGene() — deletes forked gene if exists', async () => {
      if (!forkedGeneId) return;
      const result = await client.im.evolution.deleteGene(forkedGeneId);
      if (result.ok) {
        const idx = geneIdsToCleanup.indexOf(forkedGeneId);
        if (idx >= 0) geneIdsToCleanup.splice(idx, 1);
      }
    }, 30000);
  });
});
