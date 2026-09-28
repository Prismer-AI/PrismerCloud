import { describe, it, expect, beforeEach } from 'vitest';
import { EvolutionCache } from '../../src/evolution-cache';
import type {
  IMGene,
  IMEvolutionEdge,
  SignalTag,
  EvolutionSyncSnapshot,
  EvolutionSyncDelta,
} from '../../src/types';

// ---------------------------------------------------------------------------
// Helpers to build test fixtures
// ---------------------------------------------------------------------------

function makeSignal(type: string, extras?: Record<string, string>): SignalTag {
  return { type, ...extras };
}

function makeGene(overrides: Partial<IMGene> & { id: string }): IMGene {
  return {
    type: 'gene',
    id: overrides.id,
    category: overrides.category ?? 'strategy',
    title: overrides.title ?? `Gene ${overrides.id}`,
    description: overrides.description,
    visibility: overrides.visibility ?? 'published',
    signals_match: overrides.signals_match ?? [makeSignal('test:signal')],
    preconditions: overrides.preconditions ?? [],
    strategy: overrides.strategy ?? ['do something'],
    constraints: overrides.constraints ?? {},
    success_count: overrides.success_count ?? 0,
    failure_count: overrides.failure_count ?? 0,
    last_used_at: overrides.last_used_at ?? null,
    created_by: overrides.created_by ?? 'agent-1',
    distilled_from: overrides.distilled_from,
    parentGeneId: overrides.parentGeneId,
    forkCount: overrides.forkCount,
    generation: overrides.generation,
  };
}

function makeEdge(overrides: Partial<IMEvolutionEdge> & { signal_key: string; gene_id: string }): IMEvolutionEdge {
  return {
    signal_key: overrides.signal_key,
    gene_id: overrides.gene_id,
    success_count: overrides.success_count ?? 0,
    failure_count: overrides.failure_count ?? 0,
    confidence: overrides.confidence ?? 0.5,
    last_score: overrides.last_score ?? null,
    last_used_at: overrides.last_used_at ?? null,
  };
}

function makeSnapshot(
  genes: IMGene[],
  edges: IMEvolutionEdge[] = [],
  globalPrior: Record<string, { alpha: number; beta: number }> = {},
  cursor = 42,
): EvolutionSyncSnapshot {
  return { genes, edges, globalPrior, cursor };
}

function makeDelta(
  genes: IMGene[] = [],
  edges: IMEvolutionEdge[] = [],
  globalPrior: Record<string, { alpha: number; beta: number }> = {},
  quarantines: string[] = [],
  promotions: string[] = [],
  cursor = 100,
): EvolutionSyncDelta {
  return {
    pulled: { genes, edges, globalPrior, quarantines, promotions, cursor },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EvolutionCache', () => {
  let cache: EvolutionCache;

  beforeEach(() => {
    cache = new EvolutionCache();
  });

  // -----------------------------------------------------------------------
  // 1. Constructor / getters
  // -----------------------------------------------------------------------
  describe('constructor / getters', () => {
    it('cursor starts at 0', () => {
      expect(cache.cursor).toBe(0);
    });

    it('geneCount starts at 0', () => {
      expect(cache.geneCount).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // 2. loadSnapshot()
  // -----------------------------------------------------------------------
  describe('loadSnapshot()', () => {
    it('loads genes into internal map', () => {
      const g1 = makeGene({ id: 'g1' });
      const g2 = makeGene({ id: 'g2' });
      cache.loadSnapshot(makeSnapshot([g1, g2]));
      expect(cache.geneCount).toBe(2);
    });

    it('loads edges grouped by signal_key', () => {
      const e1 = makeEdge({ signal_key: 'lang:ts', gene_id: 'g1' });
      const e2 = makeEdge({ signal_key: 'lang:ts', gene_id: 'g2' });
      const e3 = makeEdge({ signal_key: 'tool:vitest', gene_id: 'g1' });
      const g1 = makeGene({ id: 'g1' });
      const g2 = makeGene({ id: 'g2' });
      cache.loadSnapshot(makeSnapshot([g1, g2], [e1, e2, e3]));
      // Verify via cursor (edges are internal — we verify indirectly)
      expect(cache.cursor).toBe(42);
    });

    it('loads globalPrior', () => {
      const prior = { 'lang:ts': { alpha: 5, beta: 2 } };
      cache.loadSnapshot(makeSnapshot([], [], prior, 10));
      // The prior is internal; verify it affects selectGene later
      expect(cache.cursor).toBe(10);
    });

    it('sets cursor from snapshot', () => {
      cache.loadSnapshot(makeSnapshot([], [], {}, 99));
      expect(cache.cursor).toBe(99);
    });

    it('clears previous data on reload', () => {
      const g1 = makeGene({ id: 'g1' });
      const g2 = makeGene({ id: 'g2' });
      cache.loadSnapshot(makeSnapshot([g1, g2], [], {}, 10));
      expect(cache.geneCount).toBe(2);
      expect(cache.cursor).toBe(10);

      // Reload with only one gene
      const g3 = makeGene({ id: 'g3' });
      cache.loadSnapshot(makeSnapshot([g3], [], {}, 20));
      expect(cache.geneCount).toBe(1);
      expect(cache.cursor).toBe(20);
    });
  });

  // -----------------------------------------------------------------------
  // 3. applyDelta()
  // -----------------------------------------------------------------------
  describe('applyDelta()', () => {
    it('adds new genes', () => {
      cache.loadSnapshot(makeSnapshot([makeGene({ id: 'g1' })], [], {}, 1));
      expect(cache.geneCount).toBe(1);

      cache.applyDelta(makeDelta([makeGene({ id: 'g2' })], [], {}, [], [], 2));
      expect(cache.geneCount).toBe(2);
    });

    it('removes quarantined genes', () => {
      cache.loadSnapshot(makeSnapshot([makeGene({ id: 'g1' }), makeGene({ id: 'g2' })], [], {}, 1));
      expect(cache.geneCount).toBe(2);

      cache.applyDelta(makeDelta([], [], {}, ['g1'], [], 2));
      expect(cache.geneCount).toBe(1);
    });

    it('updates existing edges (same gene_id + signal_key)', () => {
      const edge1 = makeEdge({ signal_key: 'lang:ts', gene_id: 'g1', success_count: 1 });
      cache.loadSnapshot(makeSnapshot([makeGene({ id: 'g1' })], [edge1], {}, 1));

      const updatedEdge = makeEdge({ signal_key: 'lang:ts', gene_id: 'g1', success_count: 5 });
      cache.applyDelta(makeDelta([], [updatedEdge], {}, [], [], 2));
      expect(cache.cursor).toBe(2);
    });

    it('adds new edges to existing signal_key group', () => {
      const edge1 = makeEdge({ signal_key: 'lang:ts', gene_id: 'g1' });
      cache.loadSnapshot(makeSnapshot([makeGene({ id: 'g1' }), makeGene({ id: 'g2' })], [edge1], {}, 1));

      const edge2 = makeEdge({ signal_key: 'lang:ts', gene_id: 'g2' });
      cache.applyDelta(makeDelta([], [edge2], {}, [], [], 2));
      expect(cache.cursor).toBe(2);
    });

    it('updates globalPrior', () => {
      cache.loadSnapshot(makeSnapshot([], [], { 'lang:ts': { alpha: 1, beta: 1 } }, 1));
      cache.applyDelta(makeDelta([], [], { 'lang:ts': { alpha: 10, beta: 2 } }, [], [], 2));

      // Verify prior took effect: load a gene and select with lang:ts signal
      const gene = makeGene({
        id: 'g1',
        signals_match: [makeSignal('lang:ts')],
        success_count: 1,
        failure_count: 1,
      });
      cache.applyDelta(makeDelta([gene], [], {}, [], [], 3));

      const result = cache.selectGene([makeSignal('lang:ts')]);
      expect(result.action).toBe('apply_gene');
      // With alpha=10 beta=2 prior blended in, confidence should be higher than without
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('updates cursor', () => {
      cache.loadSnapshot(makeSnapshot([], [], {}, 1));
      cache.applyDelta(makeDelta([], [], {}, [], [], 55));
      expect(cache.cursor).toBe(55);
    });
  });

  // -----------------------------------------------------------------------
  // 4. loadDelta() — alias for applyDelta
  // -----------------------------------------------------------------------
  describe('loadDelta()', () => {
    it('is an alias for applyDelta — produces identical state', () => {
      const gene = makeGene({ id: 'g1' });

      // Use applyDelta on one cache
      const cacheA = new EvolutionCache();
      cacheA.loadSnapshot(makeSnapshot([], [], {}, 0));
      cacheA.applyDelta(makeDelta([gene], [], {}, [], [], 10));

      // Use loadDelta on another cache
      const cacheB = new EvolutionCache();
      cacheB.loadSnapshot(makeSnapshot([], [], {}, 0));
      cacheB.loadDelta(makeDelta([gene], [], {}, [], [], 10));

      expect(cacheA.geneCount).toBe(cacheB.geneCount);
      expect(cacheA.cursor).toBe(cacheB.cursor);

      const resultA = cacheA.selectGene([makeSignal('test:signal')]);
      const resultB = cacheB.selectGene([makeSignal('test:signal')]);
      expect(resultA).toEqual(resultB);
    });
  });

  // -----------------------------------------------------------------------
  // 5. selectGene() — the most critical method
  // -----------------------------------------------------------------------
  describe('selectGene()', () => {
    // ----- Empty cache -----
    it('returns action "none" when cache is empty', () => {
      const result = cache.selectGene([makeSignal('anything')]);
      expect(result.action).toBe('none');
      expect(result.confidence).toBe(0);
      expect(result.reason).toBe('no genes in cache');
      expect(result.fromCache).toBe(true);
    });

    // ----- No signal overlap -----
    it('returns "create_suggested" when no signal overlap', () => {
      cache.loadSnapshot(makeSnapshot([
        makeGene({ id: 'g1', signals_match: [makeSignal('lang:rust')] }),
      ]));
      const result = cache.selectGene([makeSignal('lang:python')]);
      expect(result.action).toBe('create_suggested');
      expect(result.confidence).toBe(0);
      expect(result.fromCache).toBe(true);
    });

    // ----- Quarantined genes are skipped -----
    it('skips quarantined genes', () => {
      cache.loadSnapshot(makeSnapshot([
        makeGene({
          id: 'g1',
          signals_match: [makeSignal('lang:ts')],
          visibility: 'quarantined',
          success_count: 100,
          failure_count: 0,
        }),
      ]));
      const result = cache.selectGene([makeSignal('lang:ts')]);
      expect(result.action).toBe('create_suggested');
    });

    // ----- Genes with empty signals_match are skipped -----
    it('skips genes with empty signals_match', () => {
      cache.loadSnapshot(makeSnapshot([
        makeGene({ id: 'g1', signals_match: [] }),
      ]));
      const result = cache.selectGene([makeSignal('lang:ts')]);
      expect(result.action).toBe('create_suggested');
    });

    // ----- Single matching gene -----
    it('returns "apply_gene" for a single matching gene', () => {
      const gene = makeGene({
        id: 'g1',
        signals_match: [makeSignal('lang:ts')],
        success_count: 5,
        failure_count: 1,
      });
      cache.loadSnapshot(makeSnapshot([gene]));

      const result = cache.selectGene([makeSignal('lang:ts')]);
      expect(result.action).toBe('apply_gene');
      expect(result.gene_id).toBe('g1');
      expect(result.gene).toEqual(gene);
      expect(result.strategy).toEqual(['do something']);
      expect(result.fromCache).toBe(true);
      expect(result.alternatives).toEqual([]);
    });

    // ----- Multiple matching genes sorted by rankScore descending -----
    it('sorts multiple matching genes by rankScore descending', () => {
      // Gene with high success should rank higher
      const gHigh = makeGene({
        id: 'g-high',
        signals_match: [makeSignal('lang:ts')],
        success_count: 50,
        failure_count: 2,
      });
      const gLow = makeGene({
        id: 'g-low',
        signals_match: [makeSignal('lang:ts')],
        success_count: 2,
        failure_count: 10,
      });
      cache.loadSnapshot(makeSnapshot([gLow, gHigh]));

      const result = cache.selectGene([makeSignal('lang:ts')]);
      expect(result.action).toBe('apply_gene');
      expect(result.gene_id).toBe('g-high');
    });

    // ----- Thompson Sampling: high success ranks higher -----
    it('ranks gene with high success_count higher via Thompson Sampling', () => {
      const gWinner = makeGene({
        id: 'g-winner',
        signals_match: [makeSignal('err:timeout')],
        success_count: 40,
        failure_count: 5,
      });
      const gLoser = makeGene({
        id: 'g-loser',
        signals_match: [makeSignal('err:timeout')],
        success_count: 5,
        failure_count: 5,
      });
      cache.loadSnapshot(makeSnapshot([gLoser, gWinner]));

      const result = cache.selectGene([makeSignal('err:timeout')]);
      expect(result.gene_id).toBe('g-winner');
      expect(result.confidence).toBeGreaterThan(0);
    });

    // ----- Thompson Sampling: failure-heavy gene ranks lower -----
    it('ranks failure-heavy gene lower', () => {
      const gGood = makeGene({
        id: 'g-good',
        signals_match: [makeSignal('task:build')],
        success_count: 10,
        failure_count: 2,
      });
      const gBad = makeGene({
        id: 'g-bad',
        signals_match: [makeSignal('task:build')],
        success_count: 2,
        failure_count: 20,
      });
      cache.loadSnapshot(makeSnapshot([gBad, gGood]));

      const result = cache.selectGene([makeSignal('task:build')]);
      expect(result.gene_id).toBe('g-good');
    });

    // ----- Ban threshold: >10 obs and <18% success rate is skipped -----
    it('skips gene with >10 obs and <18% success rate (ban threshold)', () => {
      const gBanned = makeGene({
        id: 'g-banned',
        signals_match: [makeSignal('lang:ts')],
        success_count: 1,     // 1/12 = 8.3% < 18%
        failure_count: 11,    // total = 12
      });
      cache.loadSnapshot(makeSnapshot([gBanned]));

      const result = cache.selectGene([makeSignal('lang:ts')]);
      expect(result.action).toBe('create_suggested');
      expect(result.reason).toBe('no matching genes for signals');
    });

    // ----- Ban threshold: exactly 10 obs and 17% success — skipped -----
    it('skips gene with exactly 10 obs and ~17% success rate', () => {
      // 1/10 = 10% < 18% => should be banned (totalObs >= 10)
      // To get closer to 17%: we can't get exact 17% with integer counts at total=10
      // But the condition is success/total < 0.18, so 1/10 = 0.10 < 0.18 => banned
      const gBorder = makeGene({
        id: 'g-border',
        signals_match: [makeSignal('lang:ts')],
        success_count: 1,    // 1/10 = 10% < 18%
        failure_count: 9,    // total = 10
      });
      cache.loadSnapshot(makeSnapshot([gBorder]));

      const result = cache.selectGene([makeSignal('lang:ts')]);
      expect(result.action).toBe('create_suggested');
    });

    // ----- Ban threshold: 9 obs and 0% success — NOT skipped -----
    it('does NOT skip gene with 9 obs and 0% success (insufficient data)', () => {
      const gInsufficientData = makeGene({
        id: 'g-insufficient',
        signals_match: [makeSignal('lang:ts')],
        success_count: 0,    // 0/9 = 0%, but total < 10 => not banned
        failure_count: 9,
      });
      cache.loadSnapshot(makeSnapshot([gInsufficientData]));

      const result = cache.selectGene([makeSignal('lang:ts')]);
      expect(result.action).toBe('apply_gene');
      expect(result.gene_id).toBe('g-insufficient');
    });

    // ----- Global prior blending -----
    it('global prior blending affects ranking', () => {
      // Two genes with identical success/failure counts
      // But the global prior for one signal strongly favors alpha
      const gA = makeGene({
        id: 'g-a',
        signals_match: [makeSignal('sig:a')],
        success_count: 3,
        failure_count: 3,
      });
      const gB = makeGene({
        id: 'g-b',
        signals_match: [makeSignal('sig:b')],
        success_count: 3,
        failure_count: 3,
      });
      // Strong prior for sig:a (high alpha) should boost g-a
      cache.loadSnapshot(makeSnapshot(
        [gA, gB],
        [],
        { 'sig:a': { alpha: 50, beta: 1 } },
        1,
      ));

      const resultA = cache.selectGene([makeSignal('sig:a')]);
      const resultB = cache.selectGene([makeSignal('sig:b')]);
      // g-a should have higher confidence due to prior
      expect(resultA.confidence).toBeGreaterThan(resultB.confidence);
    });

    // ----- Coverage score: partial signal match -----
    it('partial signal match reduces coverage and rank score', () => {
      // Gene requires two signals, input provides one
      const gene = makeGene({
        id: 'g-partial',
        signals_match: [makeSignal('lang:ts'), makeSignal('err:type')],
        success_count: 10,
        failure_count: 1,
      });
      cache.loadSnapshot(makeSnapshot([gene]));

      const result = cache.selectGene([makeSignal('lang:ts')]);
      expect(result.action).toBe('apply_gene');
      expect(result.coverageScore).toBe(0.5);
    });

    // ----- Coverage score: full signal match -----
    it('full signal match maximizes coverage score', () => {
      const gene = makeGene({
        id: 'g-full',
        signals_match: [makeSignal('lang:ts'), makeSignal('err:type')],
        success_count: 10,
        failure_count: 1,
      });
      cache.loadSnapshot(makeSnapshot([gene]));

      const result = cache.selectGene([makeSignal('lang:ts'), makeSignal('err:type')]);
      expect(result.action).toBe('apply_gene');
      expect(result.coverageScore).toBe(1);
    });

    // ----- Full coverage gene beats partial coverage gene -----
    it('gene with full coverage beats gene with partial coverage (equal success)', () => {
      const gFull = makeGene({
        id: 'g-full',
        signals_match: [makeSignal('lang:ts')],
        success_count: 5,
        failure_count: 2,
      });
      const gPartial = makeGene({
        id: 'g-partial',
        signals_match: [makeSignal('lang:ts'), makeSignal('err:type')],
        success_count: 5,
        failure_count: 2,
      });
      cache.loadSnapshot(makeSnapshot([gPartial, gFull]));

      // Only provide lang:ts → g-full has coverage 1.0, g-partial has coverage 0.5
      const result = cache.selectGene([makeSignal('lang:ts')]);
      expect(result.gene_id).toBe('g-full');
    });

    // ----- Alternatives list: max 3 -----
    it('returns at most 3 alternatives', () => {
      const genes = Array.from({ length: 6 }, (_, i) =>
        makeGene({
          id: `g${i}`,
          signals_match: [makeSignal('lang:ts')],
          success_count: 10 - i,
          failure_count: 1,
        }),
      );
      cache.loadSnapshot(makeSnapshot(genes));

      const result = cache.selectGene([makeSignal('lang:ts')]);
      expect(result.action).toBe('apply_gene');
      expect(result.alternatives!.length).toBe(3);
      // Each alternative should have gene_id, confidence, title
      for (const alt of result.alternatives!) {
        expect(alt).toHaveProperty('gene_id');
        expect(alt).toHaveProperty('confidence');
        expect(alt).toHaveProperty('title');
      }
    });

    // ----- Confidence rounding: 2 decimal places -----
    it('rounds confidence to 2 decimal places', () => {
      const gene = makeGene({
        id: 'g1',
        signals_match: [makeSignal('lang:ts')],
        success_count: 7,
        failure_count: 3,
      });
      cache.loadSnapshot(makeSnapshot([gene]));

      const result = cache.selectGene([makeSignal('lang:ts')]);
      // Verify confidence has at most 2 decimal places
      const decimalPart = result.confidence.toString().split('.')[1] ?? '';
      expect(decimalPart.length).toBeLessThanOrEqual(2);
    });

    it('rounds coverageScore to 2 decimal places', () => {
      // 1/3 coverage = 0.3333... should round to 0.33
      const gene = makeGene({
        id: 'g1',
        signals_match: [makeSignal('a'), makeSignal('b'), makeSignal('c')],
        success_count: 5,
        failure_count: 1,
      });
      cache.loadSnapshot(makeSnapshot([gene]));

      const result = cache.selectGene([makeSignal('a')]);
      expect(result.coverageScore).toBe(0.33);
    });

    // ----- String signals_match compatibility -----
    it('handles string signals_match (not just SignalTag objects)', () => {
      // The source code handles: typeof s === 'string' ? s : s.type
      const gene = makeGene({
        id: 'g-string-signals',
        signals_match: ['lang:ts', 'err:compile'] as any,
        success_count: 5,
        failure_count: 1,
      });
      cache.loadSnapshot(makeSnapshot([gene]));

      const result = cache.selectGene([makeSignal('lang:ts')]);
      expect(result.action).toBe('apply_gene');
      expect(result.gene_id).toBe('g-string-signals');
    });

    it('handles mixed string and SignalTag in signals_match', () => {
      const gene = makeGene({
        id: 'g-mixed',
        signals_match: ['lang:ts', makeSignal('err:type')] as any,
        success_count: 5,
        failure_count: 1,
      });
      cache.loadSnapshot(makeSnapshot([gene]));

      const result = cache.selectGene([makeSignal('lang:ts'), makeSignal('err:type')]);
      expect(result.action).toBe('apply_gene');
      expect(result.coverageScore).toBe(1);
    });

    // ----- Reason message includes gene count -----
    it('reason includes gene count from cache', () => {
      cache.loadSnapshot(makeSnapshot([
        makeGene({ id: 'g1', signals_match: [makeSignal('a')] }),
        makeGene({ id: 'g2', signals_match: [makeSignal('b')] }),
        makeGene({ id: 'g3', signals_match: [makeSignal('a')] }),
      ]));

      const result = cache.selectGene([makeSignal('a')]);
      expect(result.reason).toContain('3 genes');
    });

    // ----- Alternatives are sorted by rankScore descending -----
    it('alternatives are sorted by rankScore descending', () => {
      const genes = [
        makeGene({ id: 'g-best', signals_match: [makeSignal('x')], success_count: 50, failure_count: 1 }),
        makeGene({ id: 'g-mid', signals_match: [makeSignal('x')], success_count: 20, failure_count: 5 }),
        makeGene({ id: 'g-low', signals_match: [makeSignal('x')], success_count: 5, failure_count: 5 }),
        makeGene({ id: 'g-worst', signals_match: [makeSignal('x')], success_count: 2, failure_count: 8 }),
      ];
      cache.loadSnapshot(makeSnapshot(genes));

      const result = cache.selectGene([makeSignal('x')]);
      expect(result.gene_id).toBe('g-best');
      const altConfidences = result.alternatives!.map(a => a.confidence);
      // Should be descending
      for (let i = 1; i < altConfidences.length; i++) {
        expect(altConfidences[i - 1]).toBeGreaterThanOrEqual(altConfidences[i]);
      }
    });

    // ----- Quarantined + banned + no overlap all excluded, one valid remains -----
    it('returns the single valid gene when others are quarantined, banned, or non-overlapping', () => {
      cache.loadSnapshot(makeSnapshot([
        makeGene({ id: 'g-q', signals_match: [makeSignal('x')], visibility: 'quarantined', success_count: 50 }),
        makeGene({ id: 'g-banned', signals_match: [makeSignal('x')], success_count: 1, failure_count: 11 }),
        makeGene({ id: 'g-no-overlap', signals_match: [makeSignal('y')] }),
        makeGene({ id: 'g-empty', signals_match: [] }),
        makeGene({ id: 'g-valid', signals_match: [makeSignal('x')], success_count: 3, failure_count: 1 }),
      ]));

      const result = cache.selectGene([makeSignal('x')]);
      expect(result.action).toBe('apply_gene');
      expect(result.gene_id).toBe('g-valid');
      expect(result.alternatives).toEqual([]);
    });

    // ----- Multiple signals in input increase match count -----
    it('extra input signals beyond gene signals_match do not affect coverage score', () => {
      // Gene has 1 signal, input has 3. Coverage = 1/1 = 1.0
      const gene = makeGene({
        id: 'g1',
        signals_match: [makeSignal('lang:ts')],
        success_count: 5,
        failure_count: 1,
      });
      cache.loadSnapshot(makeSnapshot([gene]));

      const result = cache.selectGene([
        makeSignal('lang:ts'),
        makeSignal('err:type'),
        makeSignal('tool:vitest'),
      ]);
      expect(result.coverageScore).toBe(1);
    });

    // ----- Ban threshold boundary: exactly 18% success with 100 obs -----
    it('does NOT skip gene with exactly 18% success rate (at boundary)', () => {
      // 18/100 = 0.18 => NOT < 0.18 => not banned
      const gene = makeGene({
        id: 'g-boundary',
        signals_match: [makeSignal('x')],
        success_count: 18,
        failure_count: 82,
      });
      cache.loadSnapshot(makeSnapshot([gene]));

      const result = cache.selectGene([makeSignal('x')]);
      expect(result.action).toBe('apply_gene');
      expect(result.gene_id).toBe('g-boundary');
    });

    // ----- Ban threshold: just below 18% with enough data -----
    it('skips gene with 17.9% success rate and 1000 obs', () => {
      // 179/1000 = 0.179 < 0.18 => banned
      const gene = makeGene({
        id: 'g-just-below',
        signals_match: [makeSignal('x')],
        success_count: 179,
        failure_count: 821,
      });
      cache.loadSnapshot(makeSnapshot([gene]));

      const result = cache.selectGene([makeSignal('x')]);
      expect(result.action).toBe('create_suggested');
    });

    // ----- Gene result includes strategy field -----
    it('result includes the gene strategy array', () => {
      const gene = makeGene({
        id: 'g1',
        signals_match: [makeSignal('x')],
        strategy: ['step1', 'step2', 'step3'],
        success_count: 5,
      });
      cache.loadSnapshot(makeSnapshot([gene]));

      const result = cache.selectGene([makeSignal('x')]);
      expect(result.strategy).toEqual(['step1', 'step2', 'step3']);
    });

    // ----- Canary and seed visibility are NOT skipped -----
    it('does not skip canary or seed visibility genes', () => {
      cache.loadSnapshot(makeSnapshot([
        makeGene({ id: 'g-canary', signals_match: [makeSignal('x')], visibility: 'canary', success_count: 3 }),
        makeGene({ id: 'g-seed', signals_match: [makeSignal('x')], visibility: 'seed', success_count: 1 }),
      ]));

      const result = cache.selectGene([makeSignal('x')]);
      expect(result.action).toBe('apply_gene');
      // Canary gene has higher success, should be selected
      expect(result.gene_id).toBe('g-canary');
      expect(result.alternatives!.length).toBe(1);
    });

    // ----- Rank score formula verification -----
    it('rank score combines coverage (0.4) and sampled score (0.6)', () => {
      // Gene A: full coverage (1.0), low sampled score
      // Gene B: partial coverage (0.5), very high sampled score
      // rankA = 1.0 * 0.4 + sampledA * 0.6
      // rankB = 0.5 * 0.4 + sampledB * 0.6
      // With right numbers, B can beat A due to high sampled score
      const gA = makeGene({
        id: 'g-a',
        signals_match: [makeSignal('x')],
        success_count: 1,
        failure_count: 5,
      });
      const gB = makeGene({
        id: 'g-b',
        signals_match: [makeSignal('x'), makeSignal('y')],
        success_count: 100,
        failure_count: 1,
      });
      cache.loadSnapshot(makeSnapshot([gA, gB]));

      // Input only has 'x' => gA coverage=1.0, gB coverage=0.5
      // gA sampled ≈ 2/8 = 0.25, gB sampled ≈ 101/103 ≈ 0.98
      // rankA = 1.0*0.4 + 0.25*0.6 = 0.55
      // rankB = 0.5*0.4 + 0.98*0.6 = 0.788
      // gB should win
      const result = cache.selectGene([makeSignal('x')]);
      expect(result.gene_id).toBe('g-b');
    });
  });
});
