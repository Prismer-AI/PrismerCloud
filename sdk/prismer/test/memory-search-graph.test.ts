// M-LOCAL-GRAPH unit tests (测试闸 ③).
//
// Covers MemorySearch.hybrid()'s composite (lexical + graph) recall:
//   ① FTS-hittable pages stay in the result head.
//   ② keyword-miss page reachable via memory_links is recovered by graph
//      expansion (cloud "Set D" parity).
//   ③ graph hit score is STRICTLY below every FTS hit.
//   ④ cycle safety: A↔B mutual link, seed=A → no infinite loop, B once.
//   ⑤ maxDepth=0 disables the graph layer (pure FTS); maxDepth>5 is clamped.
//   ⑥ empty links table → degrades to pure FTS (inert / safe).
//
// Uses a real MemoryStore (better-sqlite3, on-disk temp db) seeded with pages
// + links — no mocks. Production code (search.ts / store.ts) is unchanged.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/daemon/memory/store.js';
import { MemorySearch } from '../src/daemon/memory/search.js';
import type { MemoryWriteInput } from '../src/daemon/memory/types.js';

const WS = 'ws_graph';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'prismer-memory-graph-'));
}

function buildStore(dir: string): MemoryStore {
  const store = new MemoryStore({
    dbPath: join(dir, 'memory.db'),
    workspaceId: WS,
    deviceId: 'dev_x',
  });
  store.open();
  return store;
}

function input(overrides: Partial<MemoryWriteInput> = {}): MemoryWriteInput {
  return {
    workspaceId: WS,
    path: 'note.md',
    content: 'placeholder',
    pageType: 'leaf',
    actorImUserId: 'im_alice',
    actorKind: 'human',
    ...overrides,
  };
}

/** Seed an undirected (one-row) link a↔b in the daemon URI form. */
function link(store: MemoryStore, aPath: string, bPath: string, weight = 1): void {
  store.upsertLink({
    sourceUri: `pkm://${aPath}`,
    targetUri: `pkm://${bPath}`,
    relation: 'related',
    weight,
    extractedFromPageId: null,
  });
}

describe('M-LOCAL-GRAPH — MemorySearch composite recall', () => {
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

  function withStore(fn: (store: MemoryStore) => void): void {
    const dir = tmpDir();
    cleanup.push(dir);
    const store = buildStore(dir);
    try {
      fn(store);
    } finally {
      store.close();
    }
  }

  // ① FTS-hittable page stays in the result head.
  it('① keeps a direct FTS hit at the head of results', () => {
    withStore((store) => {
      store.write(input({ path: 'auth.md', title: 'Auth', content: 'We chose OAuth for the auth flow.' }));
      store.write(input({ path: 'billing.md', title: 'Billing', content: 'Stripe billing notes.' }));
      // A linked neighbor that does NOT contain the keyword.
      store.write(input({ path: 'session.md', title: 'Session', content: 'cookie rotation policy' }));
      link(store, 'auth.md', 'session.md');

      const results = new MemorySearch(store).hybrid('OAuth');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.path).toBe('auth.md');
      expect(results[0]?.via ?? 'fts').toBe('fts');
    });
  });

  // ② keyword-miss page reachable via memory_links is recovered by graph.
  it('② recovers a keyword-miss neighbor via the link graph (Set D parity)', () => {
    withStore((store) => {
      // Only auth.md matches "OAuth". session.md is the keyword-miss neighbor.
      store.write(input({ path: 'auth.md', title: 'Auth Decision', content: 'We chose OAuth over SAML.' }));
      store.write(input({ path: 'session.md', title: 'Session Mgmt', content: 'cookie rotation and refresh policy' }));
      link(store, 'auth.md', 'session.md');

      // FTS-only: only auth.md.
      const ftsOnly = new MemorySearch(store).hybrid('OAuth', { graph: false });
      expect(ftsOnly.map((r) => r.path)).toEqual(['auth.md']);

      // Composite: graph recovers session.md.
      const composite = new MemorySearch(store).hybrid('OAuth');
      const paths = composite.map((r) => r.path);
      expect(paths).toContain('auth.md');
      expect(paths).toContain('session.md');
      const session = composite.find((r) => r.path === 'session.md');
      expect(session?.via).toBe('graph');
    });
  });

  // ③ graph hit score is strictly below every FTS hit.
  it('③ graph-hit score is strictly lower than every FTS hit', () => {
    withStore((store) => {
      store.write(input({ path: 'auth.md', content: 'OAuth chosen here' }));
      store.write(input({ path: 'oauth-notes.md', content: 'more OAuth detail and tradeoffs' }));
      store.write(input({ path: 'session.md', content: 'cookie rotation policy' }));
      link(store, 'auth.md', 'session.md');

      const results = new MemorySearch(store).hybrid('OAuth');
      const ftsScores = results.filter((r) => (r.via ?? 'fts') === 'fts').map((r) => r.score);
      const graphScores = results.filter((r) => r.via === 'graph').map((r) => r.score);
      expect(ftsScores.length).toBeGreaterThan(0);
      expect(graphScores.length).toBeGreaterThan(0);
      const minFts = Math.min(...ftsScores);
      const maxGraph = Math.max(...graphScores);
      expect(maxGraph).toBeLessThan(minFts);
    });
  });

  // ④ cycle safety: A↔B mutual link, seed=A → terminates, B appears once.
  it('④ is cycle-safe: A↔B mutual link does not loop, B appears once', () => {
    withStore((store) => {
      store.write(input({ path: 'a.md', content: 'unique-anchor-keyword alpha' }));
      store.write(input({ path: 'b.md', content: 'beta neighbor content' }));
      // Two rows forming a mutual cycle a→b and b→a.
      link(store, 'a.md', 'b.md');
      link(store, 'b.md', 'a.md');

      // depth high enough to attempt re-traversal back to the seed.
      const results = new MemorySearch(store).hybrid('unique-anchor-keyword', { maxDepth: 5 });
      const paths = results.map((r) => r.path);
      // a.md is the FTS seed; b.md is recovered once via graph; no dup, no hang.
      expect(paths.filter((p) => p === 'b.md').length).toBe(1);
      expect(paths.filter((p) => p === 'a.md').length).toBe(1);
      expect(results.find((r) => r.path === 'b.md')?.via).toBe('graph');
    });
  });

  // ⑤ maxDepth=0 disables graph; maxDepth>5 is clamped (does not blow past
  //    the hard cap — a long chain only surfaces up to 5 hops).
  it('⑤ maxDepth=0 yields pure FTS; depth>5 is clamped to the hard cap', () => {
    withStore((store) => {
      store.write(input({ path: 'auth.md', content: 'OAuth chosen' }));
      store.write(input({ path: 'session.md', content: 'cookie rotation' }));
      link(store, 'auth.md', 'session.md');

      const depthZero = new MemorySearch(store).hybrid('OAuth', { maxDepth: 0 });
      expect(depthZero.map((r) => r.path)).toEqual(['auth.md']);
      expect(depthZero.every((r) => (r.via ?? 'fts') === 'fts')).toBe(true);

      // Build a 7-hop chain h0(seed) → h1 → ... → h7. With depth clamped to 5,
      // h6 and h7 (reachable only at hop 6/7) must NOT surface.
      const chainDir = tmpDir();
      cleanup.push(chainDir);
      const chain = buildStore(chainDir);
      try {
        for (let i = 0; i <= 7; i++) {
          chain.write(input({ path: `h${i}.md`, content: i === 0 ? 'rootkeyword anchor' : `hop ${i} body` }));
        }
        for (let i = 0; i < 7; i++) {
          chain.upsertLink({
            sourceUri: `pkm://h${i}.md`,
            targetUri: `pkm://h${i + 1}.md`,
            relation: 'related',
            weight: 1,
            extractedFromPageId: null,
          });
        }
        // Request an absurd depth — clamp to 5. Use a large topK so result-count
        // capping isn't the reason deep hops are missing.
        const clamped = new MemorySearch(chain).hybrid('rootkeyword', { maxDepth: 99, topK: 50 });
        const paths = clamped.map((r) => r.path);
        // hops 1..5 reachable; 6 and 7 are beyond the clamped cap.
        expect(paths).toContain('h5.md');
        expect(paths).not.toContain('h6.md');
        expect(paths).not.toContain('h7.md');
      } finally {
        chain.close();
      }
    });
  });

  // ⑥ empty links table → pure FTS (graph layer is inert / safe).
  it('⑥ empty links table degrades to pure FTS (inert)', () => {
    withStore((store) => {
      store.write(input({ path: 'auth.md', content: 'OAuth chosen' }));
      store.write(input({ path: 'billing.md', content: 'Stripe billing' }));
      // No links seeded.
      const results = new MemorySearch(store).hybrid('OAuth');
      expect(results.map((r) => r.path)).toEqual(['auth.md']);
      expect(results.every((r) => (r.via ?? 'fts') === 'fts')).toBe(true);
    });
  });
});
