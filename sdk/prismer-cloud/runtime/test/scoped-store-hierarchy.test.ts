// release201/26 §14.6 Phase A (#A5b) — completes the memory scope hierarchy
// (session → role → project → workspace → global). These tests cover the three
// new scopes added additively to ScopedMemoryStore:
//   - 'role-shared'    → roles/<roleSlug>.db
//   - 'project-shared' → projects/<projectId>.db
//   - 'global'         → <rootDir>/global.db (CROSS-workspace)
// Each: write+search round-trip within its own bucket; isolation from the other
// scopes; key validation; and the cross-workspace property of global.

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScopedMemoryStore } from '../src/daemon/memory/scoped-store.js';
import type { ScopedWriteInput } from '../src/daemon/memory/scoped-store.js';

const cleanup: string[] = [];

function makeStore(workspaceId = 'ws_hier'): { store: ScopedMemoryStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'prismer-scoped-hier-'));
  cleanup.push(dir);
  const store = new ScopedMemoryStore({ rootDir: dir, workspaceId, deviceId: 'dev_test' });
  return { store, dir };
}

// Make a store over an EXISTING rootDir (for the cross-workspace global test).
function storeOver(dir: string, workspaceId: string): ScopedMemoryStore {
  return new ScopedMemoryStore({ rootDir: dir, workspaceId, deviceId: 'dev_test' });
}

function writeInput(
  overrides: Partial<ScopedWriteInput> & { scope: ScopedWriteInput['scope'] },
): ScopedWriteInput {
  return {
    path: 'notes/a.md',
    content: 'hierarchy note content',
    pageType: 'leaf',
    title: 'Note',
    description: 'hierarchy test note',
    actorImUserId: 'im_runner',
    actorKind: 'agent',
    ...overrides,
  };
}

describe('ScopedMemoryStore role-shared (release201/26 §14.6 #A5b)', () => {
  afterEach(() => {
    for (const dir of cleanup.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  it('write+search round-trip within the role bucket', () => {
    const { store, dir } = makeStore();
    try {
      store.write(writeInput({ scope: 'role-shared', roleSlug: 'skill-author', content: 'role apple note' }));
      const dbFile = join(dir, 'ws_hier', 'roles', 'skill-author.db');
      expect(existsSync(dbFile)).toBe(true);

      const hits = store.search({ query: 'apple', scope: 'role-shared', roleSlug: 'skill-author' });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0].path).toBe('notes/a.md');
    } finally {
      store.close();
    }
  });

  it('role A not visible to role B, agent-private, workspace-shared, or global', () => {
    const { store } = makeStore();
    try {
      store.write(writeInput({ scope: 'role-shared', roleSlug: 'roleA', content: 'roleA secret apple' }));

      expect(store.search({ query: 'apple', scope: 'role-shared', roleSlug: 'roleB' }).length).toBe(0);
      expect(store.search({ query: 'apple', scope: 'agent-private', agentImUserId: 'im_runner' }).length).toBe(0);
      expect(store.search({ query: 'apple', scope: 'workspace-shared' }).length).toBe(0);
      expect(store.search({ query: 'apple', scope: 'global' }).length).toBe(0);
      // And role A still sees its own.
      expect(store.search({ query: 'apple', scope: 'role-shared', roleSlug: 'roleA' }).length).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });

  it('rejects missing/empty roleSlug and foreign params', () => {
    const { store } = makeStore();
    try {
      expect(() => store.search({ query: 'x', scope: 'role-shared' })).toThrow(/requires roleSlug/);
      expect(() =>
        store.write(writeInput({ scope: 'role-shared', roleSlug: '   ' })),
      ).toThrow(/non-empty value/);
      // A foreign param (agentImUserId) on role-shared is a mis-route.
      expect(() =>
        store.search({ query: 'x', scope: 'role-shared', roleSlug: 'r1', agentImUserId: 'im_x' }),
      ).toThrow(/must not carry agentImUserId/);
    } finally {
      store.close();
    }
  });

  it('sanitizes path-traversal roleSlug into the roles dir', () => {
    const { store, dir } = makeStore();
    try {
      store.write(writeInput({ scope: 'role-shared', roleSlug: '../../etc/passwd' }));
      expect(existsSync(join(dir, 'etc', 'passwd.db'))).toBe(false);
      const hits = store.search({ query: 'hierarchy', scope: 'role-shared', roleSlug: '../../etc/passwd' });
      expect(hits.length).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });
});

describe('ScopedMemoryStore project-shared (release201/26 §14.6 #A5b)', () => {
  afterEach(() => {
    for (const dir of cleanup.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  it('write+search round-trip within the project bucket', () => {
    const { store, dir } = makeStore();
    try {
      store.write(writeInput({ scope: 'project-shared', projectId: 'proj-1', content: 'project banana note' }));
      expect(existsSync(join(dir, 'ws_hier', 'projects', 'proj-1.db'))).toBe(true);
      const hits = store.search({ query: 'banana', scope: 'project-shared', projectId: 'proj-1' });
      expect(hits.length).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });

  it('project P1 not visible to P2, role, workspace-shared, or global', () => {
    const { store } = makeStore();
    try {
      store.write(writeInput({ scope: 'project-shared', projectId: 'P1', content: 'P1 secret banana' }));

      expect(store.search({ query: 'banana', scope: 'project-shared', projectId: 'P2' }).length).toBe(0);
      expect(store.search({ query: 'banana', scope: 'role-shared', roleSlug: 'r1' }).length).toBe(0);
      expect(store.search({ query: 'banana', scope: 'workspace-shared' }).length).toBe(0);
      expect(store.search({ query: 'banana', scope: 'global' }).length).toBe(0);
      expect(store.search({ query: 'banana', scope: 'project-shared', projectId: 'P1' }).length).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });

  it('rejects missing/empty projectId and foreign params', () => {
    const { store } = makeStore();
    try {
      expect(() => store.search({ query: 'x', scope: 'project-shared' })).toThrow(/requires projectId/);
      expect(() =>
        store.write(writeInput({ scope: 'project-shared', projectId: '' })),
      ).toThrow(/requires projectId/);
      expect(() =>
        store.search({ query: 'x', scope: 'project-shared', projectId: 'P1', roleSlug: 'r1' }),
      ).toThrow(/must not carry roleSlug/);
    } finally {
      store.close();
    }
  });
});

describe('ScopedMemoryStore global (release201/26 §14.6 #A5b)', () => {
  afterEach(() => {
    for (const dir of cleanup.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  it('write+search round-trip and global.db at rootDir (not per-workspace)', () => {
    const { store, dir } = makeStore();
    try {
      store.write(writeInput({ scope: 'global', content: 'global cherry note' }));
      // Lives at rootDir/global.db, NOT under the per-workspace dir.
      expect(existsSync(join(dir, 'global.db'))).toBe(true);
      expect(existsSync(join(dir, 'ws_hier', 'global.db'))).toBe(false);
      const hits = store.search({ query: 'cherry', scope: 'global' });
      expect(hits.length).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });

  it('is shared across two DIFFERENT workspaceIds under the same rootDir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prismer-scoped-hier-global-'));
    cleanup.push(dir);
    const wsA = storeOver(dir, 'ws_A');
    const wsB = storeOver(dir, 'ws_B');
    try {
      // Write via workspace A's global scope...
      wsA.write(writeInput({ scope: 'global', path: 'g/shared.md', content: 'cross workspace durian fact' }));
      // ...and read it back via workspace B's global scope.
      const hits = wsB.search({ query: 'durian', scope: 'global' });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0].path).toBe('g/shared.md');

      // But B's workspace-shared must NOT see the global write (scope isolation).
      expect(wsB.search({ query: 'durian', scope: 'workspace-shared' }).length).toBe(0);
    } finally {
      wsA.close();
      wsB.close();
    }
  });

  it('rejects foreign params on global', () => {
    const { store } = makeStore();
    try {
      expect(() => store.search({ query: 'x', scope: 'global', agentImUserId: 'im_x' })).toThrow(
        /must not carry agentImUserId/,
      );
      expect(() => store.search({ query: 'x', scope: 'global', roleSlug: 'r1' })).toThrow(
        /must not carry roleSlug/,
      );
      expect(() => store.search({ query: 'x', scope: 'global', projectId: 'p1' })).toThrow(
        /must not carry projectId/,
      );
    } finally {
      store.close();
    }
  });
});

describe('ScopedMemoryStore existing scopes regression (release201/26 §14.6 #A5b)', () => {
  afterEach(() => {
    for (const dir of cleanup.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  it('workspace-shared / agent-private / session-scratch still route and isolate', () => {
    const { store } = makeStore();
    try {
      store.write(writeInput({ scope: 'workspace-shared', path: 's/a.md', content: 'shared apple' }));
      store.write(writeInput({ scope: 'agent-private', agentImUserId: 'im_runner', path: 'p/b.md', content: 'private banana' }));
      store.write(writeInput({ scope: 'session-scratch', sessionKey: 'eval-x', path: 'sc/c.md', content: 'scratch cherry' }));

      expect(store.search({ query: 'apple', scope: 'workspace-shared' }).length).toBeGreaterThan(0);
      expect(store.search({ query: 'banana', scope: 'agent-private', agentImUserId: 'im_runner' }).length).toBeGreaterThan(0);
      expect(store.search({ query: 'cherry', scope: 'session-scratch', sessionKey: 'eval-x' }).length).toBeGreaterThan(0);

      // Cross-scope isolation still holds.
      expect(store.search({ query: 'banana', scope: 'workspace-shared' }).length).toBe(0);
      expect(store.search({ query: 'cherry', scope: 'workspace-shared' }).length).toBe(0);
      // New foreign params must not be accepted on the legacy scopes.
      expect(() => store.search({ query: 'x', scope: 'workspace-shared', roleSlug: 'r1' })).toThrow(
        /must not carry roleSlug/,
      );
      expect(() =>
        store.search({ query: 'x', scope: 'agent-private', agentImUserId: 'im_runner', projectId: 'p1' }),
      ).toThrow(/must not carry projectId/);
    } finally {
      store.close();
    }
  });
});
