// release201/26 §14.9 Phase A (#A5) — eval/throwaway session scratch memory
// scope isolation. Guards against the release201/24 Phase 2 pollution bug where
// a failed eval's extract wrote into SHARED memory and the next eval's recall
// read it back. The scratch scope must be fully isolated and disposable.

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScopedMemoryStore } from '../src/daemon/memory/scoped-store.js';
import type { ScopedWriteInput } from '../src/daemon/memory/scoped-store.js';

const cleanup: string[] = [];

function makeStore(): { store: ScopedMemoryStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'prismer-scoped-scratch-'));
  cleanup.push(dir);
  const store = new ScopedMemoryStore({
    rootDir: dir,
    workspaceId: 'ws_eval',
    deviceId: 'dev_test',
  });
  return { store, dir };
}

function writeInput(overrides: Partial<ScopedWriteInput> & { scope: ScopedWriteInput['scope'] }): ScopedWriteInput {
  return {
    path: 'notes/stale.md',
    content: 'skill X is stale and should not be reused',
    pageType: 'leaf',
    title: 'Stale skill note',
    description: 'eval-extracted note',
    actorImUserId: 'im_eval_runner',
    actorKind: 'agent',
    ...overrides,
  };
}

describe('ScopedMemoryStore session-scratch (release201/26 §14.9 #A5)', () => {
  afterEach(() => {
    for (const dir of cleanup.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  it('write to session-scratch then search returns it', () => {
    const { store } = makeStore();
    try {
      store.write(writeInput({ scope: 'session-scratch', sessionKey: 'eval-run1' }));
      const hits = store.search({ query: 'stale skill', scope: 'session-scratch', sessionKey: 'eval-run1' });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0].path).toBe('notes/stale.md');
    } finally {
      store.close();
    }
  });

  it('scratch content is NOT visible from workspace-shared or agent-private (isolation)', () => {
    const { store } = makeStore();
    try {
      store.write(writeInput({ scope: 'session-scratch', sessionKey: 'eval-run2' }));

      // Shared store must be empty — the extract never touched shared memory.
      const sharedHits = store.search({ query: 'stale skill', scope: 'workspace-shared' });
      expect(sharedHits.length).toBe(0);

      // Agent-private store must be empty too.
      const agentHits = store.search({
        query: 'stale skill',
        scope: 'agent-private',
        agentImUserId: 'im_eval_runner',
      });
      expect(agentHits.length).toBe(0);

      // And searchForAgent (shared ∪ agent) — the live recall path — sees nothing.
      const recallHits = store.searchForAgent('stale skill', 'im_eval_runner');
      expect(recallHits.length).toBe(0);
    } finally {
      store.close();
    }
  });

  it('two different sessionKeys do not see each other', () => {
    const { store } = makeStore();
    try {
      store.write(writeInput({ scope: 'session-scratch', sessionKey: 'eval-runA', content: 'apple secret note' }));
      store.write(writeInput({ scope: 'session-scratch', sessionKey: 'eval-runB', content: 'banana secret note' }));

      const aHits = store.search({ query: 'apple', scope: 'session-scratch', sessionKey: 'eval-runA' });
      expect(aHits.length).toBeGreaterThan(0);
      const aCross = store.search({ query: 'apple', scope: 'session-scratch', sessionKey: 'eval-runB' });
      expect(aCross.length).toBe(0);

      const bHits = store.search({ query: 'banana', scope: 'session-scratch', sessionKey: 'eval-runB' });
      expect(bHits.length).toBeGreaterThan(0);
      const bCross = store.search({ query: 'banana', scope: 'session-scratch', sessionKey: 'eval-runA' });
      expect(bCross.length).toBe(0);
    } finally {
      store.close();
    }
  });

  it('dropScratch removes the bucket (search empty + file gone)', () => {
    const { store, dir } = makeStore();
    try {
      store.write(writeInput({ scope: 'session-scratch', sessionKey: 'eval-drop' }));
      const dbFile = join(dir, 'ws_eval', 'scratch', 'eval-drop.db');
      expect(existsSync(dbFile)).toBe(true);
      expect(store.listScratchKeys()).toContain('eval-drop');

      store.dropScratch('eval-drop');

      expect(existsSync(dbFile)).toBe(false);
      expect(store.listScratchKeys()).not.toContain('eval-drop');

      // Re-opening a fresh bucket under the same key must come back empty.
      const hits = store.search({ query: 'stale skill', scope: 'session-scratch', sessionKey: 'eval-drop' });
      expect(hits.length).toBe(0);
    } finally {
      store.close();
    }
  });

  it('rejects empty / blank sessionKey for session-scratch', () => {
    const { store } = makeStore();
    try {
      // Empty string is falsy → rejected at resolve() guard.
      expect(() =>
        store.write(writeInput({ scope: 'session-scratch', sessionKey: '' })),
      ).toThrow(/requires sessionKey/);
      // Whitespace-only is truthy but rejected by the sanitizer.
      expect(() =>
        store.search({ query: 'x', scope: 'session-scratch', sessionKey: '   ' }),
      ).toThrow(/non-empty sessionKey/);
      // Missing sessionKey entirely is also rejected.
      expect(() =>
        store.search({ query: 'x', scope: 'session-scratch' }),
      ).toThrow(/requires sessionKey/);
    } finally {
      store.close();
    }
  });

  it('sanitizes path-traversal sessionKeys into the scratch dir', () => {
    const { store, dir } = makeStore();
    try {
      store.write(writeInput({ scope: 'session-scratch', sessionKey: 'eval-../../etc/passwd' }));
      // Sanitized to underscores — file stays inside scratch/.
      const escaped = join(dir, 'etc', 'passwd.db');
      expect(existsSync(escaped)).toBe(false);
      const keys = store.listScratchKeys();
      expect(keys.length).toBe(1);
      expect(keys[0]).not.toContain('/');
      expect(keys[0]).not.toContain('..');
    } finally {
      store.close();
    }
  });

  it('keeps workspace-shared / agent-private routing unchanged (backward compat)', () => {
    const { store } = makeStore();
    try {
      store.write(writeInput({ scope: 'workspace-shared', path: 'shared/a.md', content: 'shared apple' }));
      store.write(writeInput({
        scope: 'agent-private',
        agentImUserId: 'im_eval_runner',
        path: 'priv/b.md',
        content: 'private banana',
      }));

      expect(store.search({ query: 'apple', scope: 'workspace-shared' }).length).toBeGreaterThan(0);
      expect(
        store.search({ query: 'banana', scope: 'agent-private', agentImUserId: 'im_eval_runner' }).length,
      ).toBeGreaterThan(0);
      // Shared must not see the private note and vice versa.
      expect(store.search({ query: 'banana', scope: 'workspace-shared' }).length).toBe(0);
    } finally {
      store.close();
    }
  });
});
