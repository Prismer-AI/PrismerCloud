// Schema test for the daemon /healthz endpoint (Release 200 §5.4).
//
// The cloud-side probeDaemon depends on /healthz returning a specific
// field set so it can graceful-degrade against pre-2.0.0 daemons that
// only emit `{ status, daemonId, ... }`. This test pins the schema so
// any future field rename breaks loudly in unit tests, not in production
// after a kind reload.

import { afterEach, describe, expect, it } from 'vitest';
import { LocalServer, type LocalServerState } from '../src/daemon/local-server.js';
import { boundBaseUrl } from './_helpers/listen-ephemeral.js';

let server: LocalServer | undefined;
let baseUrl = '';

function buildState(overrides: Partial<LocalServerState> = {}): LocalServerState {
  return {
    daemonId: 'dev_test',
    daemonVersion: '2.0.0-test',
    cloudBaseUrl: 'http://cloud.test',
    workspaceId: 'ws_a',
    pid: 99999,
    runtimePid: 99999,
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

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

describe('GET /healthz schema (Release 200 §5.4)', () => {
  it('returns all v200 required fields when state is fully populated', async () => {
    const state = buildState();
    // ephemeral port — read the real one back after start (O16-b)
    server = new LocalServer({ port: 0, getState: () => state });
    await server.start();
    baseUrl = boundBaseUrl(server);

    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    // Legacy fields (pre-200) — must remain.
    expect(body.status).toBe('ok');
    expect(body.daemonId).toBe('dev_test');
    expect(body.cloudBaseUrl).toBe('http://cloud.test');
    expect(body.workspaceId).toBe('ws_a');
    expect(body.pid).toBe(99999);
    expect(body.runtimePid).toBe(99999);
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

  it('projects an allowlisted in-memory OTA snapshot without leaking extra state', async () => {
    const state = buildState({
      runtimePid: 111,
      ota: {
        managerPid: 222,
        version: '2.2.11',
        source: 'bundle',
        current: '2.2.11',
        previous: '2.2.10',
        activeBundleDigest: `sha256:${'a'.repeat(64)}`,
        signatureChecksum: `sha256:${'b'.repeat(64)}`,
        signatureVerified: true,
        rawSignature: 'must-not-leak',
      } as LocalServerState['ota'],
    });
    server = new LocalServer({ port: 0, getState: () => state });
    await server.start();
    baseUrl = boundBaseUrl(server);

    const first = (await (await fetch(`${baseUrl}/healthz`)).json()) as Record<string, unknown>;
    expect(first.runtimePid).toBe(111);
    expect(first.ota).toEqual({
      managerPid: 222,
      version: '2.2.11',
      source: 'bundle',
      current: '2.2.11',
      previous: '2.2.10',
      activeBundleDigest: `sha256:${'a'.repeat(64)}`,
      signatureChecksum: `sha256:${'b'.repeat(64)}`,
      signatureVerified: true,
    });
    expect(JSON.stringify(first)).not.toContain('must-not-leak');

    const second = (await (await fetch(`${baseUrl}/healthz`)).json()) as Record<string, unknown>;
    expect(second.ota).toEqual(first.ota);
  });

  it('readyForDispatch defaults to false when state omits it', async () => {
    // Simulate a degenerate state where readyForDispatch is undefined —
    // the handler should not crash and should report `false` rather than
    // leaking `undefined` to the wire.
    const state = buildState({ readyForDispatch: undefined, adapters: [] });
    // ephemeral port — read the real one back after start (O16-b)
    server = new LocalServer({ port: 0, getState: () => state });
    await server.start();
    baseUrl = boundBaseUrl(server);

    const res = await fetch(`${baseUrl}/healthz`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.readyForDispatch).toBe(false);
    expect(body.adapters).toEqual([]);
  });

  it('projects only sanitized ConfigDelivery provenance from state onto the real response', async () => {
    const state = buildState({
      config: {
        configVersion: 'sha256:abc123',
        lastApplyAt: '2026-08-09T00:00:00.000Z',
        lastApplyError: null,
        pending: false,
        apiKey: 'must-not-leak',
      } as LocalServerState['config'],
    });
    server = new LocalServer({ port: 0, getState: () => state });
    await server.start();
    baseUrl = boundBaseUrl(server);

    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { config?: Record<string, unknown> };

    expect(body.config).toEqual({
      configVersion: 'sha256:abc123',
      lastApplyAt: '2026-08-09T00:00:00.000Z',
      lastApplyError: null,
      pending: false,
    });
    expect(JSON.stringify(body)).not.toContain('must-not-leak');
  });

  it('reports daemonVersion verbatim from state — no fallback synthesis', async () => {
    const state = buildState({ daemonVersion: '1.9.9-legacy-mirror' });
    // ephemeral port — read the real one back after start (O16-b)
    server = new LocalServer({ port: 0, getState: () => state });
    await server.start();
    baseUrl = boundBaseUrl(server);

    const res = await fetch(`${baseUrl}/healthz`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.daemonVersion).toBe('1.9.9-legacy-mirror');
  });

  it('uptime is monotonically derived from Date.now() - startedAt', async () => {
    const startedAt = Date.now() - 12_345;
    const state = buildState({ startedAt });
    // ephemeral port — read the real one back after start (O16-b)
    server = new LocalServer({ port: 0, getState: () => state });
    await server.start();
    baseUrl = boundBaseUrl(server);

    const res = await fetch(`${baseUrl}/healthz`);
    const body = (await res.json()) as Record<string, unknown>;
    const uptime = body.uptime as number;
    // startedAt was 12.345s in the past; uptime should be at least 12s
    // and within a small slack window.
    expect(uptime).toBeGreaterThanOrEqual(12);
    expect(uptime).toBeLessThan(20);
  });
});
