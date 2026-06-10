// Verifies the daemon Runner's phase-1 memory wiring (T1 RUNNER-1):
//
//   - attachMemoryRunner instantiates MemoryRuntime, starts the outbox
//     worker, and attaches a `memory.invalidate` listener to the supplied
//     WsClient (EventEmitter-shaped).
//   - WS-pushed `memory.invalidate` events propagate into the local
//     SQLite mirror (proves the listener is wired, not just constructed).
//   - The returned `stop()` halts the worker timer, detaches the WS
//     listener, and closes per-workspace stores.
//
// We test the helper directly instead of standing up a full Runner — the
// runner's other dependencies (real WsClient connecting to a local WS
// server, local sqlite db, adapter registry, etc.) make a black-box
// integration prohibitively slow and out of scope for this unit. The
// helper is the seam Runner.start() routes through; covering it covers
// the wiring contract.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CloudClient } from '../src/auth.js';
import { attachMemoryRunner } from '../src/daemon/memory/runner-wiring.js';
import { attachMemoryRpc } from '../src/daemon/memory/rpc.js';
import { LocalServer, type LocalServerState } from '../src/daemon/local-server.js';

let dir = '';
let ws: EventEmitter;
const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

function mockCloud(): CloudClient {
  // Worker won't actually fire (no events queued), but it needs a real
  // CloudClient instance for typing. The fetchImpl is a vi.fn() that
  // throws if called — surfaces unexpected network traffic.
  return new CloudClient({
    apiKey: 'sk-test',
    baseUrl: 'http://cloud.test',
    fetchImpl: vi.fn(async () => {
      throw new Error('cloud fetch should not be called in this test');
    }) as unknown as typeof fetch,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'prismer-runner-wiring-'));
  ws = new EventEmitter();
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('attachMemoryRunner (T1 RUNNER-1)', () => {
  it('starts the outbox worker and returns a runtime + worker handle', () => {
    const wiring = attachMemoryRunner({
      cloud: mockCloud(),
      wsClient: ws,
      baseDir: dir,
      deviceId: 'dev_test',
      // Long poll interval so the worker tick doesn't fire during this
      // synchronous test — we only care that .start() set the timer.
      workerOptions: { pollIntervalMs: 60_000, log: silentLog },
    });

    try {
      expect(wiring.runtime).toBeDefined();
      expect(wiring.worker).toBeDefined();
      // Internal: the worker exposes no public 'isRunning' getter, but
      // calling stop() while the timer is set is the inverse proof —
      // covered in the next test.
    } finally {
      wiring.stop();
    }
  });

  it('attaches a `memory.invalidate` WS listener that mutates the local store', () => {
    const wiring = attachMemoryRunner({
      cloud: mockCloud(),
      wsClient: ws,
      baseDir: dir,
      deviceId: 'dev_test',
      workerOptions: { pollIntervalMs: 60_000, log: silentLog },
      invalidateLog: { info: () => {}, warn: () => {} },
    });

    try {
      // Seed a page in the workspace's SQLite mirror.
      const slot = wiring.runtime.resolve('ws_test');
      const page = slot.store.write({
        workspaceId: 'ws_test',
        path: 'a.md',
        content: 'x',
        pageType: 'leaf',
        actorImUserId: 'im_seed',
        actorKind: 'human',
      });
      expect(slot.store.loadById(page.id)).not.toBeNull();

      // Cloud-pushed invalidate over the WS channel.
      ws.emit('message', {
        type: 'memory.invalidate',
        payload: {
          workspaceId: 'ws_test',
          pageIds: [page.id],
          reason: 'soft_delete',
        },
      });

      // After the listener fires, the page must be invalidated locally.
      // (MemoryStore.invalidate is synchronous — no await needed.)
      expect(slot.store.loadById(page.id)).toBeNull();
    } finally {
      wiring.stop();
    }
  });

  it('stop() detaches the WS listener so post-stop events are ignored', () => {
    const wiring = attachMemoryRunner({
      cloud: mockCloud(),
      wsClient: ws,
      baseDir: dir,
      deviceId: 'dev_test',
      workerOptions: { pollIntervalMs: 60_000, log: silentLog },
      invalidateLog: { info: () => {}, warn: () => {} },
    });

    const slot = wiring.runtime.resolve('ws_test');
    const page = slot.store.write({
      workspaceId: 'ws_test',
      path: 'a.md',
      content: 'x',
      pageType: 'leaf',
      actorImUserId: 'im_seed',
      actorKind: 'human',
    });

    // Sanity: listener is registered before stop().
    expect(ws.listenerCount('message')).toBe(1);

    wiring.stop();

    // After stop: listener removed; emitting another invalidate is a noop
    // (and the runtime is closed, so peek() can't act on it anyway).
    expect(ws.listenerCount('message')).toBe(0);
    ws.emit('message', {
      type: 'memory.invalidate',
      payload: { workspaceId: 'ws_test', pageIds: [page.id], reason: 'soft_delete' },
    });
    // No throw — the event was simply dropped.
  });

  it('stop() is idempotent', () => {
    const wiring = attachMemoryRunner({
      cloud: mockCloud(),
      wsClient: ws,
      baseDir: dir,
      deviceId: 'dev_test',
      workerOptions: { pollIntervalMs: 60_000, log: silentLog },
    });
    wiring.stop();
    // Second stop() must not double-detach a listener already off, nor
    // re-close an already-closed sqlite handle.
    expect(() => wiring.stop()).not.toThrow();
    expect(ws.listenerCount('message')).toBe(0);
  });
});

// T2-A: integration test for the runner.ts wiring step that
// `attachMemoryRpc({ runtime: this.memoryWiring.runtime })` is passed into
// LocalServer so `/local/memory/*` is reachable on 127.0.0.1. We don't stand
// up a full Runner here (cloud + WS + adapter registry would dwarf the test);
// instead we assemble the same two seams the runner connects: take the
// runtime out of attachMemoryRunner() and feed it through attachMemoryRpc()
// into a LocalServer, then hit /local/memory/stats over real HTTP.
describe('Runner wiring → LocalServer /local/memory/* reachability (T2-A)', () => {
  it('GET /local/memory/stats returns 200 when LocalServer is built with attachMemory', async () => {
    const wiring = attachMemoryRunner({
      cloud: mockCloud(),
      wsClient: ws,
      baseDir: dir,
      deviceId: 'dev_test',
      workerOptions: { pollIntervalMs: 60_000, log: silentLog },
    });

    const baseState: LocalServerState = {
      daemonId: 'dev_test',
      daemonVersion: '0.0.0-test',
      cloudBaseUrl: 'http://cloud.test',
      workspaceId: null,
      pid: 99999,
      startedAt: Date.now(),
      wsConnected: false,
      hostedAgents: [],
      runningTaskIds: [],
    };

    // Pick a high random port to avoid collisions with parallel test runs.
    const port = 39000 + Math.floor(Math.random() * 1000);
    const server = new LocalServer({
      port,
      getState: () => baseState,
      attachMemory: attachMemoryRpc({ runtime: wiring.runtime }),
    });

    try {
      await server.start();

      // /healthz reflects that memory is wired.
      const health = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(health.status).toBe(200);
      const healthBody = (await health.json()) as { memoryReady: boolean };
      expect(healthBody.memoryReady).toBe(true);

      // /local/memory/stats — global aggregate across open workspaces. With
      // no writes yet, returns the zero-state aggregate shape; what matters
      // here is the route is wired (200 not 404).
      const stats = await fetch(`http://127.0.0.1:${port}/local/memory/stats`);
      expect(stats.status).toBe(200);
      const statsBody = (await stats.json()) as {
        workspaces: unknown[];
        workspaceCount: number;
        totalPages: number;
      };
      expect(Array.isArray(statsBody.workspaces)).toBe(true);
      expect(typeof statsBody.workspaceCount).toBe('number');
      expect(typeof statsBody.totalPages).toBe('number');

      // Per-workspace stats endpoint must also be reachable (reads a
      // not-yet-opened workspace via runtime.peek, returns zero-state
      // without implicitly opening the store).
      const wsStats = await fetch(
        `http://127.0.0.1:${port}/local/memory/stats?workspaceId=ws_unwritten`,
      );
      expect(wsStats.status).toBe(200);
    } finally {
      await server.stop();
      wiring.stop();
    }
  });
});
