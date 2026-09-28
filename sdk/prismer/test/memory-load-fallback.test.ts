import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CloudClient } from '../src/auth.js';
import { LocalServer, type LocalServerState } from '../src/daemon/local-server.js';
import { boundBaseUrl } from './_helpers/listen-ephemeral.js';
import { MemoryRuntime, attachMemoryRpc } from '../src/daemon/memory/index.js';
import { mintCap } from '../src/daemon/memory/cap.js';

// doc 07 §3 / 08 收敛 — local-first load fallback: a subset MISS pulls the page
// from the cloud superset (GET /memory/resolve?uri=), materialises it locally,
// then the second load is a local FTS hit. Offline → genuine 404 (no 5xx).

const PAGE = {
  id: 'page_cloud_1',
  workspaceId: 'ws_w',
  path: 'decisions/auth.md',
  title: 'Auth decision',
  pageType: 'decision',
  version: 3,
  visibility: 'workspace',
  contentHash: 'abc',
  encrypted: false,
};
const CONTENT = '# Auth\n\nWe chose OAuth.';

function mockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** Cloud that serves GET /memory/resolve?uri= as a page hit; counts calls. */
function cloudResolving(counter: { resolveCalls: number }): CloudClient {
  return new CloudClient({
    apiKey: 'sk-test',
    baseUrl: 'http://cloud.test',
    fetchImpl: ((url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url instanceof URL ? url.href : (url as Request).url;
      if (u.includes('/api/im/memory/resolve')) {
        counter.resolveCalls++;
        return Promise.resolve(
          mockResponse(200, { ok: true, data: { kind: 'page', hit: true, page: PAGE, content: CONTENT } }),
        );
      }
      // Any other endpoint (e.g. detail fetch) — empty ok.
      return Promise.resolve(mockResponse(200, { ok: true, data: {} }));
    }) as unknown as typeof fetch,
  });
}

/** Cloud whose every request rejects (simulates offline). */
function cloudOffline(): CloudClient {
  return new CloudClient({
    apiKey: 'sk-test',
    baseUrl: 'http://cloud.test',
    fetchImpl: (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch,
  });
}

const baseState: LocalServerState = {
  daemonId: 'dev_x',
  daemonVersion: '0.0.0-test',
  cloudBaseUrl: 'http://cloud.test',
  workspaceId: null,
  pid: 99999,
  startedAt: Date.now(),
  wsConnected: false,
  hostedAgents: [],
  runningTaskIds: [],
};

let cleanupDirs: string[] = [];
let server: LocalServer | undefined;
let runtime: MemoryRuntime | undefined;
let baseUrl = '';
// spec16 §8.1 — fail-closed RPC: the load/seed calls carry the suite's agent cap.
let cap = '';

beforeEach(() => {
  // This suite seeds legacy flat fixtures; placement enforcement is covered by
  // memory-write-w2.test.ts.
  process.env.PRISMER_MEMORY_PLACEMENT_ENFORCE = 'warn';
});

async function startServer(cloud?: CloudClient): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'prismer-load-fb-'));
  cleanupDirs.push(dir);
  cap = mintCap('im_a', 'ws_w');
  runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'dev_x' });
  server = new LocalServer({
    port: 0, // ephemeral — read the real port back after start (O16-b)
    getState: () => baseState,
    attachMemory: attachMemoryRpc({ runtime, cloud }),
  });
  await server.start();
  baseUrl = boundBaseUrl(server);
}

afterEach(async () => {
  delete process.env.PRISMER_MEMORY_PLACEMENT_ENFORCE;
  await server?.stop();
  server = undefined;
  runtime?.closeAll();
  runtime = undefined;
  for (const d of cleanupDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

async function load(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/local/memory/load?workspaceId=ws_w&path=${encodeURIComponent(path)}`, {
    headers: { 'x-prismer-memory-cap': cap },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe('local-first load fallback (doc 07 §3)', () => {
  it('miss → cloud回源 → materialised locally → second load is a local hit', async () => {
    const counter = { resolveCalls: 0 };
    await startServer(cloudResolving(counter));

    // First load: local miss → triggers回源 → returns the page.
    const r1 = await load('decisions/auth.md');
    expect(r1.status).toBe(200);
    expect(r1.body.page.path).toBe('decisions/auth.md');
    expect(r1.body.content).toBe(CONTENT);
    expect(counter.resolveCalls).toBe(1);

    // Second load: now a LOCAL hit — no further回源.
    const r2 = await load('decisions/auth.md');
    expect(r2.status).toBe(200);
    expect(r2.body.content).toBe(CONTENT);
    expect(counter.resolveCalls).toBe(1); // unchanged → served from local subset
  });

  it('offline (cloud unreachable) → genuine 404, never 5xx (断云仍 load 本地)', async () => {
    await startServer(cloudOffline());
    const r = await load('decisions/auth.md');
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('memory_page_not_found');
  });

  it('no cloud wired → miss is a plain 404 (no fallback attempted)', async () => {
    await startServer(undefined);
    const r = await load('decisions/auth.md');
    expect(r.status).toBe(404);
  });

  it('local hit is served WITHOUT any回源 (cloud not consulted)', async () => {
    const counter = { resolveCalls: 0 };
    await startServer(cloudResolving(counter));
    // Seed the page locally first. NOTE: since memory203/18 R1.4 the WRITE path
    // itself does a write-time回源 for an absent/local-only page (its own
    // resolve call) — that is the write's hygiene, not the load's. Snapshot the
    // counter AFTER seeding so this test keeps asserting the LOAD behaviour.
    await fetch(`${baseUrl}/local/memory/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-prismer-memory-cap': cap },
      body: JSON.stringify({
        workspaceId: 'ws_w',
        path: 'local.md',
        content: 'local body',
        pageType: 'leaf',
        actorImUserId: 'im_a',
        actorKind: 'agent',
      }),
    });
    const callsAfterSeed = counter.resolveCalls;
    const r = await load('local.md');
    expect(r.status).toBe(200);
    expect(r.body.content).toBe('local body');
    expect(counter.resolveCalls).toBe(callsAfterSeed); // local hit → the LOAD never consulted the cloud
  });
});
