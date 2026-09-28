import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RecallObservationStore,
  type RecallObservation,
} from '../src/daemon/memory/recall-observations.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'prismer-recall-obs-'));
}

function dbPath(dir: string): string {
  return join(dir, 'ws_slug', 'recall-observations.db');
}

function obs(overrides: Partial<RecallObservation> = {}): RecallObservation {
  return {
    workspaceId: 'ws_test',
    conversationId: 'conv_1',
    runId: 'run_1',
    query: 'what did we decide about auth?',
    ourRecall: [{ path: 'decisions/auth.md', score: 0.91, snippet: 'use JWT + API key' }],
    mode: 'shadow',
    injected: false,
    ...overrides,
  };
}

describe('RecallObservationStore', () => {
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
    const p = dbPath(dir);
    const store = new RecallObservationStore({ dbPath: p });
    store.open();
    try {
      expect(existsSync(p)).toBe(true);
      if (process.platform !== 'win32') {
        expect(statSync(p).mode & 0o777).toBe(0o600);
        expect(statSync(join(dir, 'ws_slug')).mode & 0o777).toBe(0o700);
      }
    } finally {
      store.close();
    }
  });

  it('records shadow + inject observations with and without hermesRecall and null optionals', () => {
    const dir = tmpDir();
    cleanup.push(dir);
    const store = new RecallObservationStore({ dbPath: dbPath(dir) });
    store.open();
    try {
      // shadow, our-recall only (hermesRecall unknown -> null)
      store.record(obs({ mode: 'shadow', injected: false }));

      // shadow with hermes-recall captured
      store.record(
        obs({
          mode: 'shadow',
          injected: false,
          hermesRecall: [{ path: 'USER.md', score: 0.4, snippet: 'prefers TS' }],
        }),
      );

      // stateless-inject path, injected true, agentImUserId + sessionKey set
      store.record(
        obs({
          mode: 'stateless-inject',
          injected: true,
          agentImUserId: 'im_agent_7',
          sessionKey: 'hermes_sess_abc',
          outputQuality: 0.8,
        }),
      );

      // inject path with all optionals null / absent
      store.record({
        workspaceId: 'ws_test',
        agentImUserId: null,
        conversationId: null,
        runId: null,
        sessionKey: null,
        query: 'standalone recall',
        ourRecall: [],
        hermesRecall: null,
        mode: 'inject',
        injected: true,
        outputQuality: null,
      });

      expect(store.count()).toBe(4);

      const all = store.list();
      expect(all).toHaveLength(4);

      // newest-first ordering: last inserted ('standalone recall') comes first
      expect(all[0].query).toBe('standalone recall');
      expect(all[0].conversationId).toBeNull();
      expect(all[0].runId).toBeNull();
      expect(all[0].sessionKey).toBeNull();
      expect(all[0].hermesRecall).toBeNull();
      expect(all[0].outputQuality).toBeNull();
      expect(all[0].ourRecall).toEqual([]);
      expect(all[0].injected).toBe(true);
      expect(all[0].mode).toBe('inject');

      // round-trip of JSON hit arrays
      const withHermes = all.find((r) => r.hermesRecall != null);
      expect(withHermes?.hermesRecall).toEqual([
        { path: 'USER.md', score: 0.4, snippet: 'prefers TS' },
      ]);

      const stateless = all.find((r) => r.mode === 'stateless-inject');
      expect(stateless?.agentImUserId).toBe('im_agent_7');
      expect(stateless?.sessionKey).toBe('hermes_sess_abc');
      expect(stateless?.outputQuality).toBeCloseTo(0.8);
      expect(stateless?.injected).toBe(true);

      // at is auto-filled as an ISO string
      expect(typeof all[0].at).toBe('string');
      expect(new Date(all[0].at).toISOString()).toBe(all[0].at);
    } finally {
      store.close();
    }
  });

  it('list() filters by conversationId and runId and honours limit', () => {
    const dir = tmpDir();
    cleanup.push(dir);
    const store = new RecallObservationStore({ dbPath: dbPath(dir) });
    store.open();
    try {
      store.record(obs({ conversationId: 'conv_A', runId: 'run_A' }));
      store.record(obs({ conversationId: 'conv_A', runId: 'run_B' }));
      store.record(obs({ conversationId: 'conv_B', runId: 'run_C' }));

      expect(store.list({ conversationId: 'conv_A' })).toHaveLength(2);
      expect(store.list({ conversationId: 'conv_B' })).toHaveLength(1);
      expect(store.list({ runId: 'run_B' })).toHaveLength(1);
      expect(store.list({ conversationId: 'conv_A', runId: 'run_A' })).toHaveLength(1);
      expect(store.list({ limit: 1 })).toHaveLength(1);
      expect(store.list({ conversationId: 'conv_missing' })).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it('stats() reports dbPath + rowCount', () => {
    const dir = tmpDir();
    cleanup.push(dir);
    const p = dbPath(dir);
    const store = new RecallObservationStore({ dbPath: p });
    store.open();
    try {
      store.record(obs());
      store.record(obs());
      const s = store.stats();
      expect(s.dbPath).toBe(p);
      expect(s.rowCount).toBe(2);
    } finally {
      store.close();
    }
  });

  it('persists data across close/reopen (idempotent reopen)', () => {
    const dir = tmpDir();
    cleanup.push(dir);
    const p = dbPath(dir);

    const first = new RecallObservationStore({ dbPath: p });
    first.open();
    first.record(obs({ query: 'persisted query', conversationId: 'conv_persist' }));
    expect(first.count()).toBe(1);
    first.close();

    const second = new RecallObservationStore({ dbPath: p });
    second.open();
    try {
      expect(second.count()).toBe(1);
      const rows = second.list({ conversationId: 'conv_persist' });
      expect(rows).toHaveLength(1);
      expect(rows[0].query).toBe('persisted query');
      // reopening again is a no-op (open() guards on existing handle)
      second.open();
      expect(second.count()).toBe(1);
    } finally {
      second.close();
    }
  });

  it('throws if used before open()', () => {
    const dir = tmpDir();
    cleanup.push(dir);
    const store = new RecallObservationStore({ dbPath: dbPath(dir) });
    expect(() => store.count()).toThrow(/open\(\) must be called/);
  });
});
