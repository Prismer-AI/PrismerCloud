// Schema test for the daemon /healthz endpoint (Release 200 §5.4).
//
// The cloud-side probeDaemon depends on /healthz returning a specific
// field set so it can graceful-degrade against pre-2.0.0 daemons that
// only emit `{ status, daemonId, ... }`. This test pins the schema so
// any future field rename breaks loudly in unit tests, not in production
// after a kind reload.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalServer, type LocalServerState } from '../src/daemon/local-server.js';

let server: LocalServer | undefined;
let baseUrl = '';
let port = 0;

function buildState(overrides: Partial<LocalServerState> = {}): LocalServerState {
  return {
    daemonId: 'dev_test',
    daemonVersion: '2.0.0-test',
    cloudBaseUrl: 'http://cloud.test',
    workspaceId: 'ws_a',
    pid: 99999,
    startedAt: Date.now() - 5_000,
    wsConnected: true,
    hostedAgents: [{ imUserId: 'u_1', name: 'helper', adapterName: 'claude-code' }],
    runningTaskIds: [],
    adapters: [
      { name: 'claude-code', ready: true },
      { name: 'hermes', ready: true },
    ],
    resources: {
      cpu: { usagePct: 0 },
      mem: { usedBytes: 0, limitBytes: 0 },
    },
    readyForDispatch: true,
    ...overrides,
  };
}

beforeEach(async () => {
  port = 39800 + Math.floor(Math.random() * 200);
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

describe('GET /healthz schema (Release 200 §5.4)', () => {
  it('returns all v200 required fields when state is fully populated', async () => {
    const state = buildState();
    server = new LocalServer({ port, getState: () => state });
    await server.start();

    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    // Legacy fields (pre-200) — must remain.
    expect(body.status).toBe('ok');
    expect(body.daemonId).toBe('dev_test');
    expect(body.cloudBaseUrl).toBe('http://cloud.test');
    expect(body.workspaceId).toBe('ws_a');
    expect(body.pid).toBe(99999);
    expect(typeof body.startedAt).toBe('number');
    expect(body.wsConnected).toBe(true);
    expect(Array.isArray(body.hostedAgents)).toBe(true);

    // Release 200 §5.4 new fields.
    expect(body.daemonVersion).toBe('2.0.0-test');
    expect(typeof body.uptime).toBe('number');
    expect(body.uptime).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(body.adapters)).toBe(true);
    const adapters = body.adapters as Array<{ name: string; ready: boolean }>;
    expect(adapters.length).toBe(2);
    expect(adapters[0]).toMatchObject({ name: 'claude-code', ready: true });
    expect(body.resources).toMatchObject({
      cpu: { usagePct: 0 },
      mem: { usedBytes: 0, limitBytes: 0 },
    });
    expect(body.readyForDispatch).toBe(true);
  });

  it('readyForDispatch defaults to false when state omits it', async () => {
    // Simulate a degenerate state where readyForDispatch is undefined —
    // the handler should not crash and should report `false` rather than
    // leaking `undefined` to the wire.
    const state = buildState({ readyForDispatch: undefined, adapters: [] });
    server = new LocalServer({ port, getState: () => state });
    await server.start();

    const res = await fetch(`${baseUrl}/healthz`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.readyForDispatch).toBe(false);
    expect(body.adapters).toEqual([]);
  });

  it('reports daemonVersion verbatim from state — no fallback synthesis', async () => {
    const state = buildState({ daemonVersion: '1.9.9-legacy-mirror' });
    server = new LocalServer({ port, getState: () => state });
    await server.start();

    const res = await fetch(`${baseUrl}/healthz`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.daemonVersion).toBe('1.9.9-legacy-mirror');
  });

  it('uptime is monotonically derived from Date.now() - startedAt', async () => {
    const startedAt = Date.now() - 12_345;
    const state = buildState({ startedAt });
    server = new LocalServer({ port, getState: () => state });
    await server.start();

    const res = await fetch(`${baseUrl}/healthz`);
    const body = (await res.json()) as Record<string, unknown>;
    const uptime = body.uptime as number;
    // startedAt was 12.345s in the past; uptime should be at least 12s
    // and within a small slack window.
    expect(uptime).toBeGreaterThanOrEqual(12);
    expect(uptime).toBeLessThan(20);
  });
});
