import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/daemon/memory/store.js';
import { MemorySearch } from '../src/daemon/memory/search.js';
import type { MemoryWriteInput } from '../src/daemon/memory/types.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'prismer-memory-search-'));
}

function buildStore(dir: string): MemoryStore {
  const store = new MemoryStore({
    dbPath: join(dir, 'memory.db'),
    workspaceId: 'ws_test',
    deviceId: 'dev_x',
  });
  store.open();
  return store;
}

function input(overrides: Partial<MemoryWriteInput> = {}): MemoryWriteInput {
  return {
    workspaceId: 'ws_test',
    path: 'note.md',
    content: 'placeholder',
    pageType: 'leaf',
    actorImUserId: 'im_alice',
    actorKind: 'human',
    ...overrides,
  };
}

describe('MemorySearch', () => {
  const cleanup: string[] = [];
  afterEach(() => {
    for (const d of cleanup.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it('returns BM25-ranked results for a single matching term', () => {
    const dir = tmpDir();
    cleanup.push(dir);
    const store = buildStore(dir);
    try {
      store.write(
        input({ path: 'auth.md', title: 'Auth Decision', content: 'We chose OAuth over SAML for the new auth flow.' }),
      );
      store.write(
        input({ path: 'billing.md', title: 'Billing', content: 'Stripe integration notes for monthly billing.' }),
      );
      store.write(
        input({ path: 'random.md', title: 'Random', content: 'Unrelated jam.' }),
      );

      const results = new MemorySearch(store).hybrid('auth');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.path).toBe('auth.md');
      expect(results[0]?.score).toBeGreaterThan(0);
      expect(results[0]?.snippet).toContain('«');
    } finally {
      store.close();
    }
  });

  it('honors topK by capping result count', () => {
    const dir = tmpDir();
    cleanup.push(dir);
    const store = buildStore(dir);
    try {
      for (let i = 0; i < 5; i++) {
        store.write(input({ path: `n${i}.md`, content: `decision number ${i}` }));
      }
      const results = new MemorySearch(store).hybrid('decision', { topK: 2 });
      expect(results.length).toBe(2);
    } finally {
      store.close();
    }
  });

  it('respects maxBytes via greedy snippet budget', () => {
    const dir = tmpDir();
    cleanup.push(dir);
    const store = buildStore(dir);
    try {
      for (let i = 0; i < 5; i++) {
        store.write(
          input({
            path: `n${i}.md`,
            content: `decision ${i} ${'x'.repeat(200)}`,
          }),
        );
      }
      // Tight 200-byte budget. Snippets are 24-token windows each so
      // 200 bytes should fit ~1 result before the budgeter cuts off.
      const results = new MemorySearch(store).hybrid('decision', { topK: 5, maxBytes: 200 });
      const totalBytes = results.reduce(
        (acc, r) => acc + Buffer.byteLength(r.snippet, 'utf8'),
        0,
      );
      // Either we got 1 result (single may exceed budget per applyTokenBudget
      // policy) or N where total fits the budget.
      expect(results.length).toBeGreaterThanOrEqual(1);
      if (results.length > 1) {
        expect(totalBytes).toBeLessThanOrEqual(200);
      }
    } finally {
      store.close();
    }
  });

  it('excludes archived + stale pages from search', () => {
    const dir = tmpDir();
    cleanup.push(dir);
    const store = buildStore(dir);
    try {
      const page = store.write(input({ path: 'a.md', content: 'unique-keyword-foo' }));
      // Archive directly via raw db until store exposes archive() (post-MVP).
      const db = store.rawDb();
      db.prepare('UPDATE memory_pages SET archivedAt = ? WHERE id = ?').run(Date.now(), page.id);

      const results = new MemorySearch(store).hybrid('unique-keyword-foo');
      expect(results.length).toBe(0);
    } finally {
      store.close();
    }
  });

  it('returns empty array for empty/whitespace query (does not throw)', () => {
    const dir = tmpDir();
    cleanup.push(dir);
    const store = buildStore(dir);
    try {
      store.write(input({ path: 'a.md', content: 'hello' }));
      const search = new MemorySearch(store);
      expect(search.hybrid('').length).toBe(0);
      expect(search.hybrid('   ').length).toBe(0);
    } finally {
      store.close();
    }
  });

  it('sanitizes FTS5 operator chars to prevent MATCH syntax errors', () => {
    const dir = tmpDir();
    cleanup.push(dir);
    const store = buildStore(dir);
    try {
      store.write(input({ path: 'a.md', content: 'hello world' }));
      // Without sanitization these would raise FTS5 syntax errors.
      const search = new MemorySearch(store);
      expect(() => search.hybrid('"hello"')).not.toThrow();
      expect(() => search.hybrid('hello AND world')).not.toThrow();
      expect(() => search.hybrid('(hello world)')).not.toThrow();
    } finally {
      store.close();
    }
  });

  it('AND-first: a multi-term query matches a page containing ALL terms', () => {
    const dir = tmpDir();
    cleanup.push(dir);
    const store = buildStore(dir);
    try {
      store.write(
        input({ path: 'helios.md', title: 'Project Helios', content: 'The Helios line sustains 18400 events per second throughput per shard.' }),
      );
      store.write(
        input({ path: 'other.md', title: 'Other', content: 'Unrelated throughput notes for a different system.' }),
      );
      // Both terms present in helios.md → precise AND hit, other.md excluded
      // (it has "throughput" but not "helios").
      const results = new MemorySearch(store).hybrid('helios throughput');
      expect(results.map((r) => r.path)).toContain('helios.md');
      expect(results.map((r) => r.path)).not.toContain('other.md');
    } finally {
      store.close();
    }
  });

  it('OR-fallback: a multi-term query with no AND match still recalls subset hits', () => {
    const dir = tmpDir();
    cleanup.push(dir);
    const store = buildStore(dir);
    try {
      store.write(
        input({ path: 'helios.md', title: 'Project Helios', content: 'The Helios line throughput target is 18400 events per second.' }),
      );
      // Query pads the key noun with words that appear in NO page ("provider",
      // "recall"). AND would return zero; OR-fallback must still surface the
      // page that matches the one real term ("helios").
      const results = new MemorySearch(store).hybrid('helios provider recall');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.path).toBe('helios.md');
    } finally {
      store.close();
    }
  });

  it('OR-fallback ranks a page matching MORE terms above one matching fewer', () => {
    const dir = tmpDir();
    cleanup.push(dir);
    const store = buildStore(dir);
    try {
      store.write(
        input({ path: 'both.md', title: 'Both', content: 'alpha and bravo both appear together here.' }),
      );
      store.write(
        input({ path: 'one.md', title: 'One', content: 'only alpha appears in this page, nothing else.' }),
      );
      // No page has alpha+bravo+charlie (AND miss) → OR fallback. both.md
      // matches 2 of 3 terms, one.md matches 1 → both.md must rank first.
      const results = new MemorySearch(store).hybrid('alpha bravo charlie');
      expect(results.length).toBeGreaterThanOrEqual(2);
      expect(results[0]?.path).toBe('both.md');
    } finally {
      store.close();
    }
  });

  // ── memory203 doc26 Wave 4 — temporal / supersede re-scoring ──────────────
  it('demotes a superseded page below an equal-BM25 fresh page; reverts when the edge is removed', () => {
    const dir = tmpDir();
    cleanup.push(dir);
    const store = buildStore(dir);
    try {
      // Two pages with IDENTICAL content → identical BM25 → identical relevance
      // (normalizeBm25 span=0 ⇒ both score 1). Only the temporal/supersede term
      // can break the tie, so this isolates the new re-scoring pass.
      const body = 'quantum roadmap alpha bravo charlie delta';
      store.write(input({ path: 'old.md', title: 'Old plan', content: body }));
      store.write(input({ path: 'new.md', title: 'New plan', content: body }));
      const search = new MemorySearch(store);

      // Baseline: no edge → order is a BM25 tie (deterministic but supersede-free).
      // Record it so we can prove the edge REVERSES it, not just that new wins.
      const baseline = search.hybrid('quantum roadmap', { graph: false });
      expect(baseline.map((r) => r.path).sort()).toEqual(['new.md', 'old.md']);

      // Author a supersede edge: old.md --superseded-by--> new.md. Local links are
      // URI-keyed; use the short `scheme://<path>` form so pathFromMemoryUri's
      // resolved path equals the page `path` column (same resolution linkNeighbors
      // uses). old.md is now the demoted (−0.8) side.
      store.upsertLink({
        sourceUri: 'pkm://old.md',
        targetUri: 'pkm://new.md',
        relation: 'superseded-by',
        weight: 1,
        extractedFromPageId: null,
      });

      const demoted = search.hybrid('quantum roadmap', { graph: false });
      expect(demoted.length).toBe(2);
      // new.md (superseding, +0.05) must now rank strictly above old.md (−0.8).
      expect(demoted[0]?.path).toBe('new.md');
      expect(demoted[1]?.path).toBe('old.md');
      const newScore = demoted.find((r) => r.path === 'new.md')!.score;
      const oldScore = demoted.find((r) => r.path === 'old.md')!.score;
      expect(newScore).toBeGreaterThan(oldScore);
      // The demotion gap must reflect the term magnitudes (~0.8 + 0.05), not a
      // rounding wobble — proves the supersede term actually fired.
      expect(newScore - oldScore).toBeGreaterThan(0.5);

      // Negative control: remove the supersede edge → the demotion must vanish so
      // old.md is no longer sunk below new.md by a large margin. A test that
      // stayed "new far above old" here would be an open-book test (green
      // regardless of the term), so we assert the gap COLLAPSES.
      store.rawDb().prepare('DELETE FROM memory_links WHERE relation = ?').run('superseded-by');
      const reverted = search.hybrid('quantum roadmap', { graph: false });
      const rNew = reverted.find((r) => r.path === 'new.md')!.score;
      const rOld = reverted.find((r) => r.path === 'old.md')!.score;
      expect(Math.abs(rNew - rOld)).toBeLessThan(0.5);
    } finally {
      store.close();
    }
  });

  it('honors pageType filter', () => {
    const dir = tmpDir();
    cleanup.push(dir);
    const store = buildStore(dir);
    try {
      store.write(input({ path: 'd.md', pageType: 'decision', content: 'unique-token-x' }));
      store.write(input({ path: 'l.md', pageType: 'leaf', content: 'unique-token-x' }));
      const search = new MemorySearch(store);
      const decisions = search.hybrid('unique-token-x', { pageType: ['decision'] });
      expect(decisions.length).toBe(1);
      expect(decisions[0]?.path).toBe('d.md');
    } finally {
      store.close();
    }
  });
});
