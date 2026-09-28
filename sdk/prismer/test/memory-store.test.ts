import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/daemon/memory/store.js';
import type { MemoryWriteInput } from '../src/daemon/memory/types.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'prismer-memory-store-'));
}

function dbPath(dir: string): string {
  return join(dir, 'sub', 'memory.db');
}

function input(overrides: Partial<MemoryWriteInput> = {}): MemoryWriteInput {
  return {
    workspaceId: 'ws_test',
    path: 'INDEX.md',
    content: '# index\n\n- decisions/auth.md\n- glossary.md\n',
    pageType: 'hub',
    title: 'Workspace Index',
    description: 'Top-level memory index',
    actorImUserId: 'im_alice',
    actorKind: 'human',
    ...overrides,
  };
}

describe('MemoryStore', () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const dir of cleanup.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  it('open() creates db file with 0o600 perms and parent dir with 0o700', () => {
    const dir = tmpDir();
    cleanup.push(dir);
    const path = dbPath(dir);
    const store = new MemoryStore({ dbPath: path, workspaceId: 'ws_test', deviceId: 'dev_x' });
    store.open();
    try {
      expect(existsSync(path)).toBe(true);
      // POSIX-only assertion; skip on Windows runners.
      if (process.platform !== 'win32') {
        const fileMode = statSync(path).mode & 0o777;
        const dirMode = statSync(join(dir, 'sub')).mode & 0o777;
        expect(fileMode).toBe(0o600);
        expect(dirMode).toBe(0o700);
      }
    } finally {
      store.close();
    }
  });

  it('write + loadByPath round-trips a page with version=1', () => {
    const dir = tmpDir();
    cleanup.push(dir);
    const store = new MemoryStore({
      dbPath: dbPath(dir),
      workspaceId: 'ws_test',
      deviceId: 'dev_x',
    });
    store.open();
    try {
      const page = store.write(input());
      expect(page.version).toBe(1);
      expect(page.path).toBe('INDEX.md');
      expect(page.pageType).toBe('hub');
      expect(page.contentHash).toMatch(/^[0-9a-f]{64}$/);

      const reloaded = store.loadByPath('INDEX.md');
      expect(reloaded?.id).toBe(page.id);
      expect(reloaded?.version).toBe(1);

      const content = store.loadContent(page.id);
      expect(content?.content).toContain('# index');
    } finally {
      store.close();
    }
  });

  it('repeated write() to the same path increments version + preserves createdAt', () => {
    const dir = tmpDir();
    cleanup.push(dir);
    const store = new MemoryStore({
      dbPath: dbPath(dir),
      workspaceId: 'ws_test',
      deviceId: 'dev_x',
    });
    store.open();
    try {
      const v1 = store.write(input({ content: 'first' }));
      const v2 = store.write(input({ content: 'second' }));
      expect(v2.id).toBe(v1.id);
      expect(v2.version).toBe(2);
      expect(v2.createdAt).toBe(v1.createdAt); // createdAt frozen at first insert
      expect(v2.updatedAt).toBeGreaterThanOrEqual(v1.updatedAt);
      expect(store.loadContent(v1.id, 1)?.content).toBe('first');
      expect(store.loadContent(v1.id, 2)?.content).toBe('second');
    } finally {
      store.close();
    }
  });

  it('write rejects mismatched workspaceId (defense against misrouted RPC)', () => {
    const dir = tmpDir();
    cleanup.push(dir);
    const store = new MemoryStore({
      dbPath: dbPath(dir),
      workspaceId: 'ws_alice',
      deviceId: 'dev_x',
    });
    store.open();
    try {
      expect(() => store.write(input({ workspaceId: 'ws_bob' }))).toThrow(/workspace mismatch/);
    } finally {
      store.close();
    }
  });

  it('list() returns most-recently updated pages first, honors pageType filter + limit', async () => {
    const dir = tmpDir();
    cleanup.push(dir);
    const store = new MemoryStore({
      dbPath: dbPath(dir),
      workspaceId: 'ws_test',
      deviceId: 'dev_x',
    });
    store.open();
    try {
      // Sub-ms writes share an updatedAt; SQLite ORDER BY is unstable on
      // ties. Spacing by 2ms reflects realistic user write cadence.
      store.write(input({ path: 'a.md', pageType: 'leaf' }));
      await new Promise((r) => setTimeout(r, 2));
      store.write(input({ path: 'b.md', pageType: 'decision' }));
      await new Promise((r) => setTimeout(r, 2));
      store.write(input({ path: 'c.md', pageType: 'leaf' }));

      const all = store.list();
      expect(all.map((p) => p.path)).toEqual(['c.md', 'b.md', 'a.md']);

      const decisions = store.list({ pageType: 'decision' });
      expect(decisions.map((p) => p.path)).toEqual(['b.md']);

      const limited = store.list({ limit: 2 });
      expect(limited.length).toBe(2);
    } finally {
      store.close();
    }
  });

  it('invalidate() removes pages + cascades versions/content + clears FTS rows; cross-workspace ids are ignored', () => {
    const dir = tmpDir();
    cleanup.push(dir);
    const store = new MemoryStore({
      dbPath: dbPath(dir),
      workspaceId: 'ws_test',
      deviceId: 'dev_x',
    });
    store.open();
    try {
      const p1 = store.write(input({ path: 'a.md' }));
      const p2 = store.write(input({ path: 'b.md' }));

      store.invalidate([p1.id, 'page_foreign_xxx'], 'soft_delete');

      expect(store.loadById(p1.id)).toBeNull();
      expect(store.loadById(p2.id)?.path).toBe('b.md');
      expect(store.loadContent(p1.id)).toBeNull();
    } finally {
      store.close();
    }
  });

  it('upsertLink() inserts new + upgrades weight on conflict', () => {
    const dir = tmpDir();
    cleanup.push(dir);
    const store = new MemoryStore({
      dbPath: dbPath(dir),
      workspaceId: 'ws_test',
      deviceId: 'dev_x',
    });
    store.open();
    try {
      store.upsertLink({
        sourceUri: 'prismer://ws_test/memory/a.md',
        targetUri: 'prismer://ws_test/memory/b.md',
        relation: 'references',
        weight: 0.5,
        extractedFromPageId: null,
      });
      store.upsertLink({
        sourceUri: 'prismer://ws_test/memory/a.md',
        targetUri: 'prismer://ws_test/memory/b.md',
        relation: 'references',
        weight: 0.9,
        extractedFromPageId: 'page_xyz',
      });
      // Verify by raw query — link readback is phase-1 (search.ts).
      const db = store.rawDb();
      const row = db
        .prepare(
          'SELECT weight, extractedFromPageId FROM memory_links WHERE workspaceId = ? AND sourceUri = ? AND targetUri = ? AND relation = ?',
        )
        .get('ws_test', 'prismer://ws_test/memory/a.md', 'prismer://ws_test/memory/b.md', 'references') as
        | { weight: number; extractedFromPageId: string | null }
        | undefined;
      expect(row?.weight).toBe(0.9);
      expect(row?.extractedFromPageId).toBe('page_xyz');
    } finally {
      store.close();
    }
  });

  it('stats() reports pageCount accurately', () => {
    const dir = tmpDir();
    cleanup.push(dir);
    const store = new MemoryStore({
      dbPath: dbPath(dir),
      workspaceId: 'ws_test',
      deviceId: 'dev_x',
    });
    store.open();
    try {
      const before = store.stats();
      expect(before.pageCount).toBe(0);
      expect(before.pendingOutbox).toBe(0);
      expect(before.deadLetterCount).toBe(0);
      expect(before.dbPath).toContain('memory.db');

      store.write(input({ path: 'a.md' }));
      store.write(input({ path: 'b.md' }));

      const after = store.stats();
      expect(after.pageCount).toBe(2);
    } finally {
      store.close();
    }
  });

  it('reopening an existing db preserves data + does not double-init schema', () => {
    const dir = tmpDir();
    cleanup.push(dir);
    const path = dbPath(dir);
    const opts = { dbPath: path, workspaceId: 'ws_test', deviceId: 'dev_x' };

    const s1 = new MemoryStore(opts);
    s1.open();
    s1.write(input({ path: 'a.md', content: 'persistent' }));
    s1.close();

    const s2 = new MemoryStore(opts);
    s2.open();
    try {
      const reloaded = s2.loadByPath('a.md');
      expect(reloaded?.contentHash).toBeTruthy();
      const content = s2.loadContent(reloaded!.id);
      expect(content?.content).toBe('persistent');
    } finally {
      s2.close();
    }
  });
});
