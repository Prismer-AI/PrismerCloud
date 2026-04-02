/**
 * Cookbook: Evolution Feedback Loop
 * @see docs/cookbook/en/evolution-loop.md
 *
 * Validates:
 *   Step 1 — Record a Failure Signal     → im.evolution.record()
 *   Step 2 — Analyze Signals             → im.evolution.analyze()
 *   Step 3 — Create a Gene               → im.evolution.createGene()
 *   Step 4 — Record a Success Signal     → im.evolution.record() with geneId
 *   Step 5 — Publish & Browse Genes      → im.evolution.publishGene() / browseGenes()
 */
import { describe, it, expect, afterAll } from 'vitest';
import { apiClient, RUN_ID } from '../helpers';

describe('Cookbook: Evolution Feedback Loop', () => {
  const client = apiClient();
  let geneId: string;

  // ── Step 1: Record a Failure Signal ───────────────────────────────
  // Note: record() requires a gene_id. We use the evolve() shortcut instead,
  // which combines analyze+record in one call — matching the cookbook's intent.
  describe('Step 1 — Record a Failure Signal', () => {
    it('records a failure outcome via evolve()', async () => {
      const result = await client.im.evolution.evolve({
        error: 'hallucinated_facts in summarize_document',
        outcome: 'failed',
        score: 0.2,
        summary: `Cookbook test — hallucinated facts (run ${RUN_ID})`,
      });
      expect(result.ok).toBe(true);
    });
  });

  // ── Step 2: Analyze Signals ───────────────────────────────────────
  describe('Step 2 — Analyze Signals', () => {
    it('analyzes recent signals for patterns', async () => {
      const result = await client.im.evolution.analyze({
        signals: ['error:hallucination'],
        context: 'Document summarization failed with hallucinated facts',
      });
      expect(result.ok).toBe(true);
      expect(result.data).toBeDefined();
    });
  });

  // ── Step 3: Create a Gene ─────────────────────────────────────────
  describe('Step 3 — Create a Gene', () => {
    it('creates a behavioral gene from the insight', async () => {
      const result = await client.im.evolution.createGene({
        category: 'repair',
        title: `Summarize Chunking Strategy ${RUN_ID}`,
        signals_match: ['error:hallucination', 'task:summarize_failed'],
        strategy: [
          'Check input length exceeds 8000 tokens',
          'Split into 4000-token chunks with 200-token overlap',
          'Summarize each chunk independently',
          'Merge chunk summaries into final output',
        ],
        preconditions: ['Input is a text document'],
        constraints: { max_retries: 3 },
      });
      expect(result.ok).toBe(true);
      expect(result.data?.id).toBeDefined();
      geneId = result.data!.id;
    });
  });

  // ── Step 4: Record a Success Signal ───────────────────────────────
  describe('Step 4 — Record a Success Signal', () => {
    it('records success after applying the gene', async () => {
      const result = await client.im.evolution.record({
        gene_id: geneId,
        signals: ['task:summarize_succeeded'],
        outcome: 'success',
        score: 0.92,
        summary: `Applied chunking strategy — gene ${geneId} validated`,
      });
      expect(result.ok).toBe(true);
    });
  });

  // ── Step 5: Publish & Browse ──────────────────────────────────────
  describe('Step 5 — Publish the Gene & Browse Public Library', () => {
    it('publishes the gene to public library', async () => {
      const result = await client.im.evolution.publishGene(geneId, {
        skipCanary: true,
      });
      expect(result.ok).toBe(true);
    });

    it('browses public genes', async () => {
      const result = await client.im.evolution.browseGenes({
        sort: 'most_used',
        limit: 5,
      });
      expect(result.ok).toBe(true);
      expect(Array.isArray(result.data)).toBe(true);
    });
  });

  // Cleanup
  afterAll(async () => {
    if (geneId) {
      await client.im.evolution.deleteGene(geneId).catch(() => {});
    }
  });
});
