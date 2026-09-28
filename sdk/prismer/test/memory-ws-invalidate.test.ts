import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryRuntime } from '../src/daemon/memory/runtime.js';
import { attachWsInvalidate } from '../src/daemon/memory/ws-invalidate.js';
import {
  registerMemoryAuthoritySnapshot,
  computeMemoryAuthoritySnapshotHash,
  __resetCapKeyForTest,
  type MemoryAuthoritySnapshotBundleV1,
} from '../src/daemon/memory/cap.js';
import { MemoryReplicaNotReadyError } from '../src/daemon/memory/store.js';

let dir = '';
let runtime: MemoryRuntime;
let ws: EventEmitter;
let dispose: () => void;
const silentLog = { info: () => {}, warn: () => {} };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'prismer-ws-inval-'));
  runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'dev_x' });
  ws = new EventEmitter();
  dispose = attachWsInvalidate({ wsClient: ws, runtime, log: silentLog });
});

afterEach(() => {
  dispose?.();
  runtime.closeAll();
  __resetCapKeyForTest();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function seed(workspaceId: string, path: string): { id: string } {
  const slot = runtime.resolve(workspaceId);
  const page = slot.store.write({
    workspaceId,
    path,
    content: 'x',
    pageType: 'leaf',
    actorImUserId: 'im_seed',
    actorKind: 'human',
  });
  return { id: page.id };
}

describe('attachWsInvalidate', () => {
  it('memory.invalidate event removes the page from local SQLite', () => {
    const { id } = seed('ws_test', 'a.md');
    const slot = runtime.resolve('ws_test');
    expect(slot.store.loadById(id)).not.toBeNull();

    ws.emit('message', {
      type: 'memory.invalidate',
      payload: {
        workspaceId: 'ws_test',
        pageIds: [id],
        reason: 'soft_delete',
        createdAt: new Date().toISOString(),
      },
    });

    expect(slot.store.loadById(id)).toBeNull();
  });

  it('non-memory.invalidate WS messages are ignored', () => {
    const { id } = seed('ws_test', 'a.md');
    ws.emit('message', { type: 'message.new', payload: { foo: 'bar' } });
    expect(runtime.resolve('ws_test').store.loadById(id)).not.toBeNull();
  });

  it('invalidate for a workspace without a local store is a no-op (no implicit open)', () => {
    // No prior write to ws_other → no store opened.
    const before = runtime.workspaceIds();
    expect(before).not.toContain('ws_other');

    ws.emit('message', {
      type: 'memory.invalidate',
      payload: {
        workspaceId: 'ws_other',
        pageIds: ['page_xxx'],
        reason: 'soft_delete',
      },
    });

    const after = runtime.workspaceIds();
    expect(after).toEqual(before); // still no store for ws_other
  });

  it('malformed payload is logged + ignored without throwing', () => {
    const warnings: string[] = [];
    dispose(); // reattach with capturing log
    dispose = attachWsInvalidate({
      wsClient: ws,
      runtime,
      log: { info: () => {}, warn: (m) => warnings.push(m) },
    });

    ws.emit('message', {
      type: 'memory.invalidate',
      payload: { workspaceId: 'ws_test' /* missing pageIds */ },
    });
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('disposer removes the listener', () => {
    const { id } = seed('ws_test', 'a.md');
    dispose();
    ws.emit('message', {
      type: 'memory.invalidate',
      payload: { workspaceId: 'ws_test', pageIds: [id], reason: 'soft_delete' },
    });
    expect(runtime.resolve('ws_test').store.loadById(id)).not.toBeNull();
  });

  // ── doc 07 §4 — re-pull fresh subset projection on non-delete invalidate ──
  it('non-delete invalidate triggers a cloud subset re-pull; soft_delete does not', async () => {
    const { CloudClient } = await import('../src/auth.js');
    const resolveCalls: string[] = [];
    const pageCalls: string[] = [];
    const cloud = new CloudClient({
      apiKey: 'sk-test',
      baseUrl: 'http://cloud.test',
      fetchImpl: ((url: string | URL | Request) => {
        const u = typeof url === 'string' ? url : url instanceof URL ? url.href : (url as Request).url;
        if (u.includes('/api/im/memory/pages')) pageCalls.push(u);
        if (u.includes('/api/im/memory/resolve')) resolveCalls.push(u);
        // initialSyncFromCloud lists pages; return empty set (re-pull is a no-op
        // materialisation but the LIST call proves the re-pull fired).
        return Promise.resolve({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ok: true, data: [] }),
        } as unknown as Response);
      }) as unknown as typeof fetch,
    });

    dispose();
    dispose = attachWsInvalidate({ wsClient: ws, runtime, cloud, log: silentLog });
    const { id } = seed('ws_rp', 'a.md');

    // soft_delete → NO re-pull
    ws.emit('message', {
      type: 'memory.invalidate',
      payload: { workspaceId: 'ws_rp', pageIds: [id], reason: 'soft_delete' },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(pageCalls.length).toBe(0);

    // visibility_changed → re-pull fires (lists cloud pages for the workspace)
    ws.emit('message', {
      type: 'memory.invalidate',
      payload: { workspaceId: 'ws_rp', pageIds: [id], reason: 'visibility_changed' },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(pageCalls.length).toBeGreaterThan(0);
    expect(pageCalls[0]).toContain('workspaceId=ws_rp');
  });

  // ── product209/16 §9.5 — invalidation suspends the replica FIRST ─────────
  it('memory.invalidate suspends an authorized replica (pages removed AND recall closed until reconcile)', () => {
    const slot = runtime.resolve('ws_suspend');
    const page = slot.store.write({
      workspaceId: 'ws_suspend',
      path: 'a.md',
      content: 'x',
      pageType: 'leaf',
      actorImUserId: 'im_seed',
      actorKind: 'human',
    });
    // Prior strict reconcile result (authorized epoch).
    slot.store.applyReplicaCommit({
      heads: [],
      diffDeletePageIds: [],
      tombstonePageIds: [],
      state: {
        cursor: null,
        accessVersion: 7,
        replicaSubjectHash: 'sha256:subject-e1',
        contentHighWatermarkJson: JSON.stringify({ updatedAt: new Date(0).toISOString(), id: 'z' }),
        leaseExpiresAt: Date.now() + 60_000,
        status: 'ready',
      },
    });

    ws.emit('message', {
      type: 'memory.invalidate',
      payload: { workspaceId: 'ws_suspend', pageIds: [page.id], reason: 'soft_delete' },
    });

    // The row is gone (raw check — gated reads now fail closed)…
    expect(
      slot.store.rawDb().prepare('SELECT id FROM memory_pages WHERE id = ?').get(page.id),
    ).toBeUndefined();
    // …and recall is CLOSED: invalidation suspends FIRST.
    expect(() => slot.store.loadById(page.id)).toThrow(MemoryReplicaNotReadyError);
    expect(slot.store.getReplicaState()?.status).toBe('suspended');
    expect(slot.store.getReplicaState()?.accessVersion).toBe(7); // epoch kept, not authorized
  });

  it('strict workspace re-pull goes through the V3 manifest port, never the legacy pages list (426)', async () => {
    const WS = 'ws_strict';
    const daemonId = 'daemon-strict-test';
    const { CloudClient } = await import('../src/auth.js');
    const pageCalls: string[] = [];
    const manifestCalls: string[] = [];
    const manifestData = {
      ok: true,
      data: {
        schemaVersion: 1,
        mode: 'strict',
        snapshotAccessVersion: 7,
        replicaSubjectHash: 'sha256:subject-e1',
        snapshotToken: 'v1.1.a.b',
        contentHighWatermark: { updatedAt: new Date().toISOString(), id: 'zzzz' },
        nextCursor: null,
        hasMore: false,
        heads: [],
        tombstones: [],
      },
    };
    const cloud = new CloudClient({
      apiKey: 'sk-test',
      baseUrl: 'http://cloud.test',
      fetchImpl: ((url: string | URL | Request) => {
        const u = typeof url === 'string' ? url : url instanceof URL ? url.href : (url as Request).url;
        if (u.includes('/api/im/memory/sync/manifest')) manifestCalls.push(u);
        if (u.includes('/api/im/memory/pages')) pageCalls.push(u);
        return Promise.resolve({
          ok: true,
          status: 200,
          text: async () => JSON.stringify(manifestData),
        } as unknown as Response);
      }) as unknown as typeof fetch,
    });
    // Register the strict snapshot so initialSyncFromCloud routes to the V3 port.
    const base = {
      schemaVersion: 1 as const,
      workspaceId: WS,
      daemonId,
      replicaMode: 'strict' as const,
      minRuntimeVersion: '2.2.12',
      requiredRuntimeCapabilities: [
        'memory-authority-snapshot-v1',
        'memory-replica-manifest-v1',
        'memory-replica-content-v1',
      ] as const,
      accessVersion: 7,
      replicaSubjectHash: 'sha256:subject-e1',
      issuedAt: new Date(Date.now() - 60_000).toISOString(),
      validUntil: new Date(Date.now() + 30 * 60_000).toISOString(),
      actors: [],
    };
    const snapshot: MemoryAuthoritySnapshotBundleV1 = {
      ...base,
      snapshotHash: computeMemoryAuthoritySnapshotHash(base),
    };
    expect(registerMemoryAuthoritySnapshot(snapshot, daemonId)).toBe(true);

    dispose();
    dispose = attachWsInvalidate({ wsClient: ws, runtime, cloud, log: silentLog });
    // A local row exists so the store is open for this workspace.
    const { id } = seed(WS, 'a.md');

    ws.emit('message', {
      type: 'memory.invalidate',
      payload: { workspaceId: WS, pageIds: [id], reason: 'visibility_changed' },
    });

    // Wait for the fire-and-forget re-pull to finish (poll the replica state).
    let ready = false;
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 20));
      const state = runtime.resolve(WS).store.getReplicaState();
      if (state?.status === 'ready' && state?.accessVersion === 7) {
        ready = true;
        break;
      }
    }
    expect(ready).toBe(true);
    expect(manifestCalls.length).toBeGreaterThan(0);
    expect(pageCalls.length).toBe(0); // legacy port untouched (Cloud would 426 it)
  });
});
