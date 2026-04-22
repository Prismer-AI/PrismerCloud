// T14 — DaemonRunner composition tests

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import { startDaemonRunner } from '../../src/daemon/runner.js';

// ============================================================
// HTTP helpers
// ============================================================

function httpGet(
  url: string,
  opts: { headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const reqOpts: http.RequestOptions = {
      hostname: parsed.hostname,
      port: Number(parsed.port),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: opts.headers,
    };
    const req = http.request(reqOpts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
      );
    });
    req.setTimeout(opts.timeoutMs ?? 5000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

function httpRequest(
  url: string,
  opts: { method?: string; body?: unknown; headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const reqOpts: http.RequestOptions = {
      hostname: parsed.hostname,
      port: Number(parsed.port),
      path: parsed.pathname + parsed.search,
      method: opts.method ?? 'GET',
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...opts.headers,
      },
    };
    const req = http.request(reqOpts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
      );
    });
    req.setTimeout(opts.timeoutMs ?? 5000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ============================================================
// Helpers
// ============================================================

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'runner-test-'));
}

function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort
  }
}

// ============================================================
// Tests
// ============================================================

describe('startDaemonRunner', () => {
  const tmpDirs: string[] = [];
  const handles: Array<{ stop(): Promise<void> }> = [];

  afterEach(async () => {
    // Stop all running handles
    await Promise.all(handles.map((h) => h.stop().catch(() => undefined)));
    handles.length = 0;
    // Remove temp dirs
    while (tmpDirs.length > 0) {
      cleanupDir(tmpDirs.pop()!);
    }
  });

  function newTmpOpts() {
    const dir = makeTempDir();
    tmpDirs.push(dir);
    return {
      pidFile: path.join(dir, 'daemon.pid'),
      dataDir: path.join(dir, 'prismer'),
      installSignalHandlers: false,
    };
  }

  it('starts with ephemeral port (port 0) and serves /api/v1/health', async () => {
    const opts = newTmpOpts();
    const handle = await startDaemonRunner({ ...opts, port: 0 });
    handles.push(handle);

    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(handle.pid).toBe(process.pid);
    expect(handle.dataDir).toBe(opts.dataDir);

    const r = await httpGet(`${handle.url}/api/v1/health`);
    expect(r.status).toBe(200);

    const body = JSON.parse(r.body) as {
      status: string;
      daemon: { pid: number; uptime: number; state: string; rssBytes: number; port: number };
      counts: { agents: number; subscriptions: number };
    };
    expect(body.status).toBe('ok');
    expect(body.daemon.pid).toBe(process.pid);
    expect(body.daemon.state).toBe('running');
    expect(body.daemon.rssBytes).toBeGreaterThan(0);
    expect(body.daemon.port).toBeGreaterThan(0);
  }, 10_000);

  it('stop() shuts down HTTP server and daemon process cleanly', async () => {
    const opts = newTmpOpts();
    const handle = await startDaemonRunner({ ...opts, port: 0 });

    // Remove from auto-cleanup since we stop manually
    const idx = handles.indexOf(handle);
    if (idx >= 0) handles.splice(idx, 1);

    const url = handle.url;
    await handle.stop();

    // After stop, HTTP should be unreachable
    await expect(httpGet(`${url}/api/v1/health`, { timeoutMs: 1000 })).rejects.toThrow();

    // PID file should be gone
    expect(fs.existsSync(opts.pidFile)).toBe(false);
  }, 10_000);

  it('second start succeeds after clean stop', async () => {
    const opts = newTmpOpts();

    const handle1 = await startDaemonRunner({ ...opts, port: 0 });
    await handle1.stop();

    // Should be able to start again on same pidFile
    const handle2 = await startDaemonRunner({ ...opts, port: 0 });
    handles.push(handle2);

    const r = await httpGet(`${handle2.url}/api/v1/health`);
    expect(r.status).toBe(200);
  }, 10_000);

  it('with authBearer: /health is public, /api/v1/agents requires token', async () => {
    const opts = newTmpOpts();
    const handle = await startDaemonRunner({ ...opts, port: 0, authBearer: 'my-secret-token' });
    handles.push(handle);

    // Health should be accessible without auth
    const healthR = await httpGet(`${handle.url}/api/v1/health`);
    expect(healthR.status).toBe(200);

    // Agents without token → 401
    const noTokenR = await httpGet(`${handle.url}/api/v1/agents`);
    expect(noTokenR.status).toBe(401);

    // Agents with wrong token → 401
    const wrongTokenR = await httpGet(`${handle.url}/api/v1/agents`, {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(wrongTokenR.status).toBe(401);

    // Agents with correct token → 200
    const okR = await httpGet(`${handle.url}/api/v1/agents`, {
      headers: { Authorization: 'Bearer my-secret-token' },
    });
    expect(okR.status).toBe(200);
    const body = JSON.parse(okR.body) as { agents: unknown[] };
    expect(Array.isArray(body.agents)).toBe(true);
  }, 10_000);

  it('without authBearer: all routes are accessible without token', async () => {
    const opts = newTmpOpts();
    const handle = await startDaemonRunner({ ...opts, port: 0 });
    handles.push(handle);

    const r = await httpGet(`${handle.url}/api/v1/agents`);
    expect(r.status).toBe(200);
  }, 10_000);

  it('Q10: daemon.port sidecar is written with bound port and removed on stop', async () => {
    const opts = newTmpOpts();
    const handle = await startDaemonRunner({ ...opts, port: 0 });

    const portFile = path.join(opts.dataDir, 'daemon.port');

    // Sidecar exists and contains the actual bound port
    expect(fs.existsSync(portFile)).toBe(true);
    const raw = fs.readFileSync(portFile, 'utf-8').trim();
    const sidecarPort = parseInt(raw, 10);
    expect(isNaN(sidecarPort)).toBe(false);
    expect(sidecarPort).toBeGreaterThan(0);

    // Port in sidecar matches the URL returned by the handle
    const urlPort = parseInt(new URL(handle.url).port, 10);
    expect(sidecarPort).toBe(urlPort);

    // After stop, sidecar is removed
    await handle.stop();
    expect(fs.existsSync(portFile)).toBe(false);
  }, 10_000);

  it('serves Memory Gateway write, recall, stats, and delete routes', async () => {
    const opts = newTmpOpts();
    const handle = await startDaemonRunner({ ...opts, port: 0 });
    handles.push(handle);

    const writeR = await httpRequest(`${handle.url}/api/v1/memory/write`, {
      method: 'POST',
      body: {
        ownerId: 'agent-memory-test',
        ownerType: 'agent',
        path: 'notes/runtime.md',
        content: 'Runtime gateway recalls timeout fixes quickly.',
        scope: 'project',
        memoryType: 'project',
      },
    });
    expect(writeR.status).toBe(200);
    const writeBody = JSON.parse(writeR.body) as { success: boolean; data: { id: string } };
    expect(writeBody.success).toBe(true);
    expect(writeBody.data.id).toBeTruthy();

    const recallR = await httpRequest(`${handle.url}/api/v1/memory/recall`, {
      method: 'POST',
      body: {
        keyword: 'timeout',
        ownerId: 'agent-memory-test',
        scope: 'project',
      },
    });
    expect(recallR.status).toBe(200);
    const recallBody = JSON.parse(recallR.body) as { data: { results: Array<{ path: string }> } };
    expect(recallBody.data.results[0].path).toBe('notes/runtime.md');

    const statsR = await httpGet(`${handle.url}/api/v1/memory/stats?ownerId=agent-memory-test`);
    expect(statsR.status).toBe(200);
    const statsBody = JSON.parse(statsR.body) as { data: { fileCount: number } };
    expect(statsBody.data.fileCount).toBe(1);

    const deleteR = await httpRequest(`${handle.url}/api/v1/memory/${writeBody.data.id}`, {
      method: 'DELETE',
    });
    expect(deleteR.status).toBe(200);
  }, 10_000);

  it('serves default sandboxed FS routes from the configured workspace', async () => {
    const opts = newTmpOpts();
    const workspace = path.join(opts.dataDir, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const filePath = path.join(workspace, 'hello.txt');
    fs.writeFileSync(filePath, 'hello from runner', 'utf8');

    const handle = await startDaemonRunner({ ...opts, port: 0, workspace });
    handles.push(handle);

    const readR = await httpRequest(`${handle.url}/api/v1/fs/read`, {
      method: 'POST',
      body: { agentId: 'runner-agent', path: filePath },
    });
    expect(readR.status).toBe(200);
    expect(JSON.parse(readR.body).content).toContain('hello from runner');

    const outsidePath = path.join(opts.dataDir, 'outside.txt');
    fs.writeFileSync(outsidePath, 'nope', 'utf8');
    const outsideR = await httpRequest(`${handle.url}/api/v1/fs/read`, {
      method: 'POST',
      body: { agentId: 'runner-agent', path: outsidePath },
    });
    expect(outsideR.status).toBe(403);
  }, 10_000);

  it('serves Evolution Gateway local signal extraction route', async () => {
    const opts = newTmpOpts();
    const handle = await startDaemonRunner({ ...opts, port: 0 });
    handles.push(handle);

    const signalR = await httpRequest(`${handle.url}/api/v1/evolution/signal`, {
      method: 'POST',
      body: {
        provider: 'codex',
        toolOutput: {
          toolName: 'bash',
          output: 'TypeError: cannot read property',
          exitCode: 1,
          durationMs: 12_000,
        },
        tags: ['runtime'],
      },
    });
    expect(signalR.status).toBe(200);
    const body = JSON.parse(signalR.body) as { ok: boolean; data: string[] };
    expect(body.ok).toBe(true);
    expect(body.data).toContain('error:type_error|provider=codex');
    expect(body.data).toContain('exit_error|exitCode=1');
    expect(body.data).toContain('perf:slow_operation|duration=12000ms');
    expect(body.data).toContain('tag:runtime');
  }, 10_000);

  // Bug A regression — when TransportManager is enabled (apiKey + daemonId +
  // userId + cloudApiBase all supplied) the probe pass may take tens of seconds
  // against an unreachable host. Previously `await transportManager.start()`
  // happened before `httpServer.start()` + the `daemon.port` sidecar write,
  // causing the sidecar to not exist during the entire probe window. Any
  // client that tried to `prismer status` / talk to the daemon during that
  // window got the "disabled" canned response and a missing port file.
  // This test pins a bogus cloudApiBase so probes fail fast and asserts the
  // sidecar is already written by the time startDaemonRunner resolves.
  it('Bug A regression: daemon.port written promptly even when transport is probing', async () => {
    const opts = newTmpOpts();
    const handle = await startDaemonRunner({
      ...opts,
      port: 0,
      // Credentials that pass the TransportManager gate but point at an
      // invalid host — probes must fail but not block port-file writing.
      apiKey: 'sk-prismer-live-test-fake-key',
      daemonId: 'daemon:test',
      userId: 'user:test',
      cloudApiBase: 'http://127.0.0.1:1',
    });
    handles.push(handle);

    const portFile = path.join(opts.dataDir, 'daemon.port');

    // Port file must exist by the time startDaemonRunner resolves. No
    // polling/waiting — the write path is on the synchronous critical path
    // for daemon start completion.
    expect(fs.existsSync(portFile)).toBe(true);
    const sidecarPort = parseInt(fs.readFileSync(portFile, 'utf-8').trim(), 10);
    expect(sidecarPort).toBe(parseInt(new URL(handle.url).port, 10));

    // Transport manager should be published on globalThis for the HTTP
    // handler to read (even before its initial probe completes).
    expect((globalThis as any).__transportManager).toBeDefined();
  }, 10_000);
});
