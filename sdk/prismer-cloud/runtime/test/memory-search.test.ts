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
