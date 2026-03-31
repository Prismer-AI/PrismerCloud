import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EvolutionRuntime } from '../../src/evolution-runtime';
import type {
  IMGene,
  SignalTag,
  EvolutionSyncSnapshot,
} from '../../src/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSignal(type: string, extras?: Record<string, string>): SignalTag {
  return { type, ...extras };
}

function makeGene(overrides: Partial<IMGene> & { id: string }): IMGene {
  return {
    type: 'gene',
    id: overrides.id,
    category: overrides.category ?? 'repair',
    title: overrides.title ?? `Gene ${overrides.id}`,
    description: overrides.description,
    visibility: overrides.visibility ?? 'published',
    signals_match: overrides.signals_match ?? [makeSignal('error:timeout')],
    preconditions: overrides.preconditions ?? [],
    strategy: overrides.strategy ?? ['increase timeout to 30s'],
    constraints: overrides.constraints ?? {},
    success_count: overrides.success_count ?? 5,
    failure_count: overrides.failure_count ?? 1,
    last_used_at: overrides.last_used_at ?? null,
    created_by: overrides.created_by ?? 'agent-1',
    distilled_from: overrides.distilled_from,
    parentGeneId: overrides.parentGeneId,
    forkCount: overrides.forkCount,
    generation: overrides.generation,
  };
}

function makeSnapshot(genes: IMGene[]): EvolutionSyncSnapshot {
  return {
    genes,
    edges: genes.map(g => ({
      signal_key: (g.signals_match[0] as SignalTag).type,
      gene_id: g.id,
      success_count: g.success_count,
      failure_count: g.failure_count,
      confidence: g.success_count / (g.success_count + g.failure_count + 1),
      last_score: null,
      last_used_at: null,
    })),
    globalPrior: {},
    cursor: 100,
  };
}

/** Create a mock client with all four methods stubbed. */
function createMockClient() {
  return {
    getSyncSnapshot: vi.fn().mockResolvedValue({ data: null }),
    analyze: vi.fn().mockResolvedValue({ data: null }),
    record: vi.fn().mockResolvedValue({ data: { ok: true } }),
    sync: vi.fn().mockResolvedValue({ data: null }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EvolutionRuntime', () => {
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    vi.useFakeTimers();
    client = createMockClient();
  });

  afterEach(async () => {
    vi.useRealTimers();
  });

  // ─── 1. constructor ────────────────────────────────────

  describe('constructor', () => {
    it('creates instance with default config', () => {
      const runtime = new EvolutionRuntime(client);
      expect(runtime).toBeInstanceOf(EvolutionRuntime);
      // Sessions should start empty
      expect(runtime.sessions).toEqual([]);
    });
  });

  // ─── 2–3. start() ─────────────────────────────────────

  describe('start()', () => {
    it('calls getSyncSnapshot and loads snapshot into cache', async () => {
      const gene = makeGene({ id: 'g1' });
      const snapshot = makeSnapshot([gene]);
      client.getSyncSnapshot.mockResolvedValue({ data: snapshot });

      const runtime = new EvolutionRuntime(client);
      await runtime.start();

      expect(client.getSyncSnapshot).toHaveBeenCalledTimes(1);
      expect(client.getSyncSnapshot).toHaveBeenCalledWith(0);

      // Verify cache is populated: suggest for a matching error should hit cache
      const result = await runtime.suggest('ETIMEDOUT: connection timed out');
      expect(result.fromCache).toBe(true);
      expect(result.action).toBe('apply_gene');
      expect(result.geneId).toBe('g1');

      await runtime.stop();
    });

    it('is idempotent — calling twice is safe', async () => {
      const gene = makeGene({ id: 'g1' });
      client.getSyncSnapshot.mockResolvedValue({ data: makeSnapshot([gene]) });

      const runtime = new EvolutionRuntime(client);
      await runtime.start();
      await runtime.start(); // second call

      // getSyncSnapshot should only be called once
      expect(client.getSyncSnapshot).toHaveBeenCalledTimes(1);

      await runtime.stop();
    });

    it('handles network error gracefully (does not throw)', async () => {
      client.getSyncSnapshot.mockRejectedValue(new Error('network down'));

      const runtime = new EvolutionRuntime(client);
      // Should not throw
      await expect(runtime.start()).resolves.toBeUndefined();

      await runtime.stop();
    });
  });

  // ─── 4. stop() ─────────────────────────────────────────

  describe('stop()', () => {
    it('clears timers and flushes outbox', async () => {
      const gene = makeGene({ id: 'g1' });
      client.getSyncSnapshot.mockResolvedValue({ data: makeSnapshot([gene]) });

      const runtime = new EvolutionRuntime(client, {
        syncIntervalMs: 10_000,
        outboxFlushMs: 5_000,
      });
      await runtime.start();

      // Add something to outbox via learned()
      const suggestion = await runtime.suggest('ETIMEDOUT: timed out');
      runtime.learned('ETIMEDOUT', 'success', 'fixed it');

      // Stop should flush
      await runtime.stop();

      expect(client.record).toHaveBeenCalledTimes(1);

      // After stop, advancing timers should NOT trigger sync or flush
      client.sync.mockClear();
      client.record.mockClear();
      vi.advanceTimersByTime(60_000);
      expect(client.sync).not.toHaveBeenCalled();
    });
  });

  // ─── 5–9. suggest() ───────────────────────────────────

  describe('suggest()', () => {
    it('with signals matching cache — returns apply_gene from cache (no network)', async () => {
      const gene = makeGene({
        id: 'g-timeout',
        signals_match: [makeSignal('error:timeout')],
        success_count: 10,
        failure_count: 1,
      });
      client.getSyncSnapshot.mockResolvedValue({ data: makeSnapshot([gene]) });

      const runtime = new EvolutionRuntime(client);
      await runtime.start();

      const result = await runtime.suggest('ETIMEDOUT: connection timed out');

      expect(result.action).toBe('apply_gene');
      expect(result.fromCache).toBe(true);
      expect(result.geneId).toBe('g-timeout');
      expect(result.signals.length).toBeGreaterThan(0);
      // analyze should NOT have been called — cache hit
      expect(client.analyze).not.toHaveBeenCalled();

      await runtime.stop();
    });

    it('with empty cache — calls server analyze endpoint', async () => {
      // No snapshot data → empty cache
      client.getSyncSnapshot.mockResolvedValue({ data: null });
      client.analyze.mockResolvedValue({
        data: {
          action: 'apply_gene',
          gene_id: 'g-server',
          gene: makeGene({ id: 'g-server' }),
          strategy: ['retry with backoff'],
          confidence: 0.85,
          reason: 'server matched',
        },
      });

      const runtime = new EvolutionRuntime(client);
      await runtime.start();

      const result = await runtime.suggest('ETIMEDOUT: connection timed out');

      expect(result.action).toBe('apply_gene');
      expect(result.fromCache).toBe(false);
      expect(result.geneId).toBe('g-server');
      expect(client.analyze).toHaveBeenCalledTimes(1);

      await runtime.stop();
    });

    it('server failure — falls back to stale cache result', async () => {
      // Load a gene into cache, but with low confidence (<=0.3) so the first
      // cache check in suggest() won't short-circuit, forcing the server path.
      // Then we make the server fail so the fallback cache path is used.
      // Gene requires two signals but error only produces one → partial coverage
      // With success_count=0, failure_count=8 (below ban threshold of 10):
      // coverageScore = 1/2 = 0.5, sampledScore = alpha/(alpha+beta) = 1/10 = 0.1
      // rankScore = 0.5*0.4 + 0.1*0.6 = 0.26 <= 0.3 → falls through to server
      const gene = makeGene({
        id: 'g-stale',
        signals_match: [makeSignal('error:timeout'), makeSignal('error:dns_error')],
        success_count: 0,
        failure_count: 8,
      });
      client.getSyncSnapshot.mockResolvedValue({ data: makeSnapshot([gene]) });
      client.analyze.mockRejectedValue(new Error('server error'));

      const runtime = new EvolutionRuntime(client);
      await runtime.start();

      const result = await runtime.suggest('ETIMEDOUT: connection timed out');

      // Should fall back to cache since server is unreachable
      expect(result.fromCache).toBe(true);
      expect(result.reason).toContain('server unreachable');

      await runtime.stop();
    });

    it('no signals extracted (empty context) — returns action: none', async () => {
      const runtime = new EvolutionRuntime(client);
      await runtime.start();

      // Pass an empty string — extractSignals should still produce a fallback signal
      // but passing undefined-like context with no error should produce none.
      // Actually, extractSignals always produces a signal for non-empty error strings.
      // We need to pass a context where error is empty/undefined.
      const result = await runtime.suggest('', { error: undefined } as any);

      // An empty string will produce a normalized fallback signal, so let's test
      // with a truly empty error. Looking at the code: ctx.error = '' is falsy,
      // so extractSignals won't produce error signals. If no tags/taskStatus either,
      // we get an empty signals array.
      // However, suggest() sets ctx.error = errorStr which is ''.
      // extractSignals checks `if (ctx.error)` — empty string is falsy → no error signals.
      // No taskStatus, no tags → empty signals array → action: 'none'.
      expect(result.action).toBe('none');
      expect(result.signals).toEqual([]);
      expect(result.reason).toContain('no signals');

      await runtime.stop();
    });

    it('confidence threshold — cache result with confidence <= 0.3 falls through to server', async () => {
      const gene = makeGene({
        id: 'g-low',
        signals_match: [makeSignal('error:timeout')],
        success_count: 0,
        failure_count: 10, // very low confidence
      });
      client.getSyncSnapshot.mockResolvedValue({ data: makeSnapshot([gene]) });
      client.analyze.mockResolvedValue({
        data: {
          action: 'create_suggested',
          confidence: 0.15,
          reason: 'low confidence suggestion',
        },
      });

      const runtime = new EvolutionRuntime(client);
      await runtime.start();

      const result = await runtime.suggest('ETIMEDOUT: connection timed out');

      // Cache had a result but confidence <= 0.3, so it fell through to server
      expect(client.analyze).toHaveBeenCalled();
      expect(result.fromCache).toBe(false);

      await runtime.stop();
    });
  });

  // ─── 10–13. learned() ─────────────────────────────────

  describe('learned()', () => {
    it('records outcome and adds to outbox', async () => {
      const gene = makeGene({ id: 'g1', success_count: 10, failure_count: 1 });
      client.getSyncSnapshot.mockResolvedValue({ data: makeSnapshot([gene]) });

      const runtime = new EvolutionRuntime(client);
      await runtime.start();

      await runtime.suggest('ETIMEDOUT: timed out');
      runtime.learned('ETIMEDOUT', 'success', 'increased timeout', 'g1');

      // Flush on stop should send the record
      await runtime.stop();

      expect(client.record).toHaveBeenCalledTimes(1);
      expect(client.record).toHaveBeenCalledWith(
        expect.objectContaining({
          gene_id: 'g1',
          outcome: 'success',
          summary: 'increased timeout',
        }),
      );
    });

    it('without geneId, uses lastSuggestedGeneId', async () => {
      const gene = makeGene({ id: 'g-auto', success_count: 10, failure_count: 1 });
      client.getSyncSnapshot.mockResolvedValue({ data: makeSnapshot([gene]) });

      const runtime = new EvolutionRuntime(client);
      await runtime.start();

      // suggest() sets lastSuggestedGeneId
      await runtime.suggest('ETIMEDOUT: timed out');
      // learned() without explicit geneId
      runtime.learned('ETIMEDOUT', 'success', 'auto resolved');

      await runtime.stop();

      expect(client.record).toHaveBeenCalledWith(
        expect.objectContaining({
          gene_id: 'g-auto',
        }),
      );
    });

    it('without geneId and no prior suggest — silently returns', async () => {
      const runtime = new EvolutionRuntime(client);
      await runtime.start();

      // No prior suggest(), no explicit geneId
      runtime.learned('some error', 'failed', 'nothing happened');

      await runtime.stop();

      // record should never have been called — nothing in outbox
      expect(client.record).not.toHaveBeenCalled();
    });

    it('outbox flush triggered when outboxMaxSize reached', async () => {
      const gene = makeGene({ id: 'g-flush', success_count: 10, failure_count: 1 });
      client.getSyncSnapshot.mockResolvedValue({ data: makeSnapshot([gene]) });

      const runtime = new EvolutionRuntime(client, { outboxMaxSize: 3 });
      await runtime.start();

      // Suggest once to set lastSuggestedGeneId
      await runtime.suggest('ETIMEDOUT: timed out');

      // Add 3 entries to hit outboxMaxSize
      runtime.learned('err1', 'success', 's1', 'g-flush');
      runtime.learned('err2', 'failed', 's2', 'g-flush');
      runtime.learned('err3', 'success', 's3', 'g-flush');

      // The third learned() should trigger flush
      // Allow the async flush() promise to resolve
      await vi.advanceTimersByTimeAsync(0);

      expect(client.record).toHaveBeenCalledTimes(3);

      await runtime.stop();
    });
  });

  // ─── 14. sessions getter ──────────────────────────────

  describe('sessions getter', () => {
    it('returns session array', async () => {
      const gene = makeGene({ id: 'g1', success_count: 10, failure_count: 1 });
      client.getSyncSnapshot.mockResolvedValue({ data: makeSnapshot([gene]) });

      const runtime = new EvolutionRuntime(client);
      await runtime.start();

      expect(runtime.sessions).toEqual([]);

      // Complete a suggest→learned cycle
      await runtime.suggest('ETIMEDOUT: timed out');
      runtime.learned('ETIMEDOUT', 'success', 'fixed', 'g1');

      const sessions = runtime.sessions;
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        suggestedGeneId: 'g1',
        usedGeneId: 'g1',
        adopted: true,
        outcome: 'success',
      });
      expect(sessions[0].id).toMatch(/^ses_/);
      expect(sessions[0].durationMs).toBeTypeOf('number');

      await runtime.stop();
    });
  });

  // ─── 15. getMetrics() ─────────────────────────────────

  describe('getMetrics()', () => {
    it('calculates geneUtilizationRate, adoptedSuccessRate, cacheHitRate', async () => {
      const gene = makeGene({ id: 'g1', success_count: 10, failure_count: 1 });
      client.getSyncSnapshot.mockResolvedValue({ data: makeSnapshot([gene]) });

      const runtime = new EvolutionRuntime(client);
      await runtime.start();

      // Session 1: suggest g1, adopt g1, success (cache hit)
      await runtime.suggest('ETIMEDOUT: timed out');
      runtime.learned('ETIMEDOUT', 'success', 'fixed', 'g1');

      // Session 2: suggest g1, adopt g1, failed (cache hit)
      await runtime.suggest('ETIMEDOUT: timed out');
      runtime.learned('ETIMEDOUT', 'failed', 'still broken', 'g1');

      // Session 3: suggest g1, use different gene (cache hit)
      await runtime.suggest('ETIMEDOUT: timed out');
      runtime.learned('ETIMEDOUT', 'success', 'used different approach', 'g-other');

      const metrics = runtime.getMetrics();

      expect(metrics.totalSuggestions).toBe(3);
      expect(metrics.suggestionsWithGene).toBe(3); // all suggested g1
      expect(metrics.totalLearned).toBe(3);
      expect(metrics.adoptedCount).toBe(2); // sessions 1 & 2 adopted g1
      expect(metrics.geneUtilizationRate).toBeCloseTo(2 / 3, 1);
      expect(metrics.adoptedSuccessRate).toBe(0.5); // 1 success out of 2 adopted
      expect(metrics.cacheHitRate).toBe(1); // all from cache

      await runtime.stop();
    });
  });

  // ─── 16. resetMetrics() ───────────────────────────────

  describe('resetMetrics()', () => {
    it('clears all metrics counters', async () => {
      const gene = makeGene({ id: 'g1', success_count: 10, failure_count: 1 });
      client.getSyncSnapshot.mockResolvedValue({ data: makeSnapshot([gene]) });

      const runtime = new EvolutionRuntime(client);
      await runtime.start();

      await runtime.suggest('ETIMEDOUT: timed out');
      runtime.learned('ETIMEDOUT', 'success', 'fixed', 'g1');

      expect(runtime.sessions).toHaveLength(1);
      expect(runtime.getMetrics().totalSuggestions).toBe(1);

      runtime.resetMetrics();

      expect(runtime.sessions).toHaveLength(0);
      const metrics = runtime.getMetrics();
      expect(metrics.totalSuggestions).toBe(0);
      expect(metrics.totalLearned).toBe(0);
      expect(metrics.adoptedCount).toBe(0);
      expect(metrics.geneUtilizationRate).toBe(0);
      expect(metrics.adoptedSuccessRate).toBe(0);
      expect(metrics.cacheHitRate).toBe(0);

      await runtime.stop();
    });
  });
});
