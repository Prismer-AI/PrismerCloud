/**
 * mode-b-bridge.test.ts — Unit tests for src/para/mode-b-bridge.ts
 *
 * Verifies the OpenClaw → daemon Mode B handshake (per Task 3 of v1.9.x):
 *   - notifyDaemonOfPresence POSTs to the right endpoint with the right body
 *   - notifyDaemonOfPresence swallows errors when daemon not reachable
 *   - The local listener responds 200 to POST /dispatch with the stub shape
 *   - The local listener returns 400 on invalid body
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'node:http';
import {
  notifyDaemonOfPresence,
  startLocalDispatchListener,
  startModeBBridge,
} from '../../src/para/mode-b-bridge.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function jsonRequest(
  url: string,
  opts: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: Number(parsed.port),
        path: parsed.pathname + parsed.search,
        method: opts.method ?? 'POST',
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.setTimeout(opts.timeoutMs ?? 3000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// notifyDaemonOfPresence
// ---------------------------------------------------------------------------

describe('notifyDaemonOfPresence', () => {
  let fakeDaemon: http.Server;
  let fakeDaemonPort = 0;
  let receivedBody: any = undefined;
  let receivedPath = '';
  let receivedMethod = '';

  beforeEach(async () => {
    receivedBody = undefined;
    receivedPath = '';
    receivedMethod = '';
    fakeDaemon = http.createServer((req, res) => {
      receivedPath = req.url ?? '';
      receivedMethod = req.method ?? '';
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        try {
          receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch {
          receivedBody = null;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, replaced: false }));
      });
    });
    await new Promise<void>((resolve) => fakeDaemon.listen(0, '127.0.0.1', resolve));
    fakeDaemonPort = (fakeDaemon.address() as any).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => fakeDaemon.close(() => resolve()));
  });

  it('POSTs to /api/v1/adapters/register-mode-b with name + loopbackUrl', async () => {
    const result = await notifyDaemonOfPresence({
      daemonHttpBase: `http://127.0.0.1:${fakeDaemonPort}`,
      name: 'openclaw',
      loopbackUrl: 'http://127.0.0.1:54321',
    });
    expect(result.ok).toBe(true);
    expect(receivedPath).toBe('/api/v1/adapters/register-mode-b');
    expect(receivedMethod).toBe('POST');
    expect(receivedBody).toEqual({
      name: 'openclaw',
      loopbackUrl: 'http://127.0.0.1:54321',
    });
  });

  it('returns { ok: false } and does not throw when daemon not reachable', async () => {
    // Pick a port we know is closed (close fakeDaemon, then use its old port).
    await new Promise<void>((resolve) => fakeDaemon.close(() => resolve()));
    const closedPort = fakeDaemonPort;
    const result = await notifyDaemonOfPresence({
      daemonHttpBase: `http://127.0.0.1:${closedPort}`,
      name: 'openclaw',
      loopbackUrl: 'http://127.0.0.1:54321',
      timeoutMs: 500,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    // Re-open so afterEach close is safe.
    fakeDaemon = http.createServer();
    await new Promise<void>((resolve) => fakeDaemon.listen(0, '127.0.0.1', resolve));
  });

  it('returns { ok: false } when daemon returns non-2xx', async () => {
    // Replace the existing fake daemon with one that 500s.
    await new Promise<void>((resolve) => fakeDaemon.close(() => resolve()));
    fakeDaemon = http.createServer((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('boom');
    });
    await new Promise<void>((resolve) => fakeDaemon.listen(0, '127.0.0.1', resolve));
    const port = (fakeDaemon.address() as any).port;
    const result = await notifyDaemonOfPresence({
      daemonHttpBase: `http://127.0.0.1:${port}`,
      name: 'openclaw',
      loopbackUrl: 'http://127.0.0.1:54321',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('500');
  });
});

// ---------------------------------------------------------------------------
// startLocalDispatchListener
// ---------------------------------------------------------------------------

describe('startLocalDispatchListener', () => {
  let listener: { url: string; close(): Promise<void> } | undefined;

  afterEach(async () => {
    if (listener) {
      await listener.close();
      listener = undefined;
    }
  });

  it('binds to 127.0.0.1 on a free port and exposes the URL', async () => {
    listener = await startLocalDispatchListener();
    expect(listener.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const port = Number(new URL(listener.url).port);
    expect(port).toBeGreaterThan(0);
  });

  it('responds 200 to POST /dispatch with ok:false stub (I4)', async () => {
    // I4: stub now returns { ok:false, error: 'mode_b_stub_not_implemented' }.
    // HTTP status stays 200 because the request DID reach the right handler —
    // the failure is at the application layer. Cloud TaskRouter will map
    // ok:false → im_tasks.status = 'failed', surfacing the stub state instead
    // of pretending success.
    listener = await startLocalDispatchListener();
    const r = await jsonRequest(listener.url + '/dispatch', {
      method: 'POST',
      body: { taskId: 't-123', capability: 'code.write', prompt: 'hello' },
    });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.ok).toBe(false);
    expect(body.error).toBe('mode_b_stub_not_implemented');
    expect(body.metadata).toEqual({ mode: 'mode_b_stub', adapter: 'openclaw' });
  });

  it('returns 400 on invalid JSON body', async () => {
    listener = await startLocalDispatchListener();
    // raw HTTP send invalid JSON
    const port = Number(new URL(listener.url).port);
    const r = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/dispatch',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
          );
        },
      );
      req.on('error', reject);
      req.write('this is not json{{{');
      req.end();
    });
    expect(r.status).toBe(400);
  });

  it('returns 400 on missing required fields', async () => {
    listener = await startLocalDispatchListener();
    const r = await jsonRequest(listener.url + '/dispatch', {
      method: 'POST',
      body: { taskId: 't-1' /* missing capability & prompt */ },
    });
    expect(r.status).toBe(400);
  });

  it('returns 404 on non-/dispatch paths', async () => {
    listener = await startLocalDispatchListener();
    const r = await jsonRequest(listener.url + '/something-else', {
      method: 'POST',
      body: {},
    });
    expect(r.status).toBe(404);
  });

  // v1.9.x agent_restart hook (see runtime AdapterImpl.reset). The bridge
  // itself is stateless — each /dispatch is independent — so POST /reset
  // is an ack/noop. Body { agentName } is optional.
  it('responds 200 to POST /reset with ok:true + state:openclaw_bridge_noop', async () => {
    listener = await startLocalDispatchListener();
    const r = await jsonRequest(listener.url + '/reset', {
      method: 'POST',
      body: { agentName: 'openclaw' },
    });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.ok).toBe(true);
    expect(body.state).toBe('openclaw_bridge_noop');
    expect(body.agentName).toBe('openclaw');
  });

  it('POST /reset with empty body still returns ok:true (agentName absent)', async () => {
    listener = await startLocalDispatchListener();
    const r = await jsonRequest(listener.url + '/reset', {
      method: 'POST',
      // no body
    });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.ok).toBe(true);
    expect(body.state).toBe('openclaw_bridge_noop');
    expect(body.agentName).toBeUndefined();
  });

  it('POST /reset with malformed JSON still returns ok:true (tolerant body parse)', async () => {
    listener = await startLocalDispatchListener();
    const port = Number(new URL(listener.url).port);
    const r = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/reset',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
          );
        },
      );
      req.on('error', reject);
      req.write('this is not json{{{');
      req.end();
    });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.ok).toBe(true);
    expect(body.state).toBe('openclaw_bridge_noop');
  });

  it('GET /reset is 404 (POST-only)', async () => {
    listener = await startLocalDispatchListener();
    const r = await jsonRequest(listener.url + '/reset', {
      method: 'GET',
    });
    expect(r.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// I3: startModeBBridge re-registration heartbeat
// ---------------------------------------------------------------------------
//
// On daemon restart, OpenClaw must re-announce itself within ~heartbeatMs so
// the new daemon process learns the loopback URL. Without this, a daemon
// bounce strands the binding until OpenClaw is restarted too. The heartbeat
// is best-effort (errors swallowed) and the timer is .unref()'d so it never
// keeps the process alive on shutdown.

describe('startModeBBridge re-registration heartbeat (I3)', () => {
  let fakeDaemon: http.Server;
  let fakeDaemonPort = 0;
  let registerCalls = 0;

  beforeEach(async () => {
    registerCalls = 0;
    fakeDaemon = http.createServer((req, res) => {
      if (req.url === '/api/v1/adapters/register-mode-b' && req.method === 'POST') {
        // Drain body before responding.
        req.on('data', () => {});
        req.on('end', () => {
          registerCalls += 1;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, replaced: false }));
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => fakeDaemon.listen(0, '127.0.0.1', resolve));
    fakeDaemonPort = (fakeDaemon.address() as any).port;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await new Promise<void>((resolve) => fakeDaemon.close(() => resolve()));
  });

  it('re-registers periodically (initial + ≥1 heartbeat in <1s with small interval)', async () => {
    // Real timers + small interval is more reliable than fake-timers for tests
    // that span an actual fetch round-trip (fake-timers don't advance the
    // socket I/O). We accept ~600ms of wall time to verify the heartbeat.
    const heartbeatMs = 200;
    const fakeApi: any = { logger: { info: () => {}, warn: () => {} } };
    const result = await startModeBBridge(fakeApi, {
      daemonHttpBase: `http://127.0.0.1:${fakeDaemonPort}`,
      name: 'openclaw',
      heartbeatMs,
    });

    expect(result.registered).toBe(true);
    expect(result.stopHeartbeat).toBeTypeOf('function');
    // Initial notify already happened.
    expect(registerCalls).toBeGreaterThanOrEqual(1);

    // Wait for ≥2 heartbeat firings (initial + 2 ticks → ≥3 calls).
    await new Promise((r) => setTimeout(r, heartbeatMs * 3 + 50));

    expect(registerCalls).toBeGreaterThanOrEqual(2);

    result.stopHeartbeat?.();
    if (result.listener) await result.listener.close();
  }, 5_000);

  it('stopHeartbeat() prevents further re-registration', async () => {
    const heartbeatMs = 100;
    const fakeApi: any = { logger: { info: () => {}, warn: () => {} } };
    const result = await startModeBBridge(fakeApi, {
      daemonHttpBase: `http://127.0.0.1:${fakeDaemonPort}`,
      name: 'openclaw',
      heartbeatMs,
    });
    // Stop immediately after the initial notify.
    result.stopHeartbeat?.();
    const callsAfterStop = registerCalls;

    // Wait several intervals — count must not grow.
    await new Promise((r) => setTimeout(r, heartbeatMs * 5));

    expect(registerCalls).toBe(callsAfterStop);

    if (result.listener) await result.listener.close();
  }, 5_000);
});
