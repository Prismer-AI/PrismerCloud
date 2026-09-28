import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalServer, type LocalServerState } from '../src/daemon/local-server.js';
import { boundBaseUrl } from './_helpers/listen-ephemeral.js';
import { MemoryRuntime, attachMemoryRpc } from '../src/daemon/memory/index.js';
import { CloudClient } from '../src/auth.js';
import { mintCap, __resetCapKeyForTest } from '../src/daemon/memory/cap.js';

// memory203 MVP4 phase-1 — POST /local/memory/curate forwards the three
// curation verbs (promote_to_hub / supersede / rebuild_index) to the matching
// cloud endpoint. This test proves:
//   - ws cap gate: a cap{ws:A} request for ws_b → 403 (越 ws cap blocked)
//   - run_dream is REJECTED as an unknown op → 400 (memory203/13 §0.5 removed it
//     from CURATE_OPS: Dream is the orchestrator's own skill calling the write
//     verbs, NOT a cloud-LLM trigger advertised to every agent — rpc.ts:1327)
//   - promote_to_hub is forwarded AND the cloud's orchestrator_only 403 is
//     passed through verbatim (the daemon does NOT re-gate, only plumbs)
//   - cloud absent → 200 degraded no-op

let cleanupDirs: string[] = [];

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

const CAP_HEADER = 'x-prismer-memory-cap';

async function post(
  baseUrl: string,
  path: string,
  body: unknown,
  cap?: string,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cap ? { [CAP_HEADER]: cap } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

afterEach(() => {
  __resetCapKeyForTest();
  delete process.env.PRISMER_MEMORY_CAP_ENFORCE;
  for (const d of cleanupDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe('memory curate RPC (MVP4 phase-1, cloud wired)', () => {
  let server: LocalServer | undefined;
  let runtime: MemoryRuntime | undefined;
  let baseUrl = '';
  // Track what the daemon forwarded to cloud + how cloud replied.
  let cloudCalls: Array<{ path: string; body: any; headers: Record<string, string> }> = [];
  // Per-test toggle: when true the stub cloud returns a 403 orchestrator_only.
  let orchestratorForbidden = false;

  beforeEach(async () => {
    __resetCapKeyForTest();
    const dir = mkdtempSync(join(tmpdir(), 'prismer-curate-rpc-'));
    cleanupDirs.push(dir);
    runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'dev_x' });
    cloudCalls = [];
    orchestratorForbidden = false;

    const fetchStub: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
      // Normalise to lower-case keys so the assertion is case-insensitive.
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = v;
      cloudCalls.push({ path: u, body, headers });
      if (u.includes('/api/im/memory/page-dream')) {
        return new Response(
          JSON.stringify({ ok: true, data: { candidates: [{ pageId: 'p1', kind: 'merge' }] } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (u.includes('/promote-to-hub')) {
        if (orchestratorForbidden) {
          return new Response(
            JSON.stringify({ ok: false, error: { code: 'orchestrator_only', message: 'not the orchestrator' } }),
            { status: 403, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify({ ok: true, data: { id: 'p1', pageType: 'hub' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (u.includes('/index/rebuild')) {
        return new Response(JSON.stringify({ ok: true, data: { rebuilt: true } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const cloud = new CloudClient({ baseUrl: 'http://cloud.test', apiKey: 'sk-test', fetchImpl: fetchStub });
    server = new LocalServer({
      port: 0, // ephemeral — read the real port back after start (O16-b)
      getState: () => baseState,
      attachMemory: attachMemoryRpc({ runtime, cloud, deviceId: 'dev_x' }),
    });
    await server.start();
    baseUrl = boundBaseUrl(server);
  });

  afterEach(async () => {
    await server?.stop();
    runtime?.closeAll();
  });

  it('cross-ws cap{ws:A} → curate on ws_b → 401 cap-layer ws mismatch, NOT forwarded', async () => {
    const cap = mintCap('im_alice', 'ws_a');
    // Use a VALID op (rebuild_index) so the request clears op-validation and the
    // ws-scope check is what rejects it — a retired op (run_dream) would 400 on
    // op-validation first and never exercise the scope gate.
    const r = await post(baseUrl, '/local/memory/curate', { workspaceId: 'ws_b', op: 'rebuild_index' }, cap);
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('memory_cap_invalid');
    // The cap gate fires BEFORE any cloud forward.
    expect(cloudCalls.length).toBe(0);
  });

  it('run_dream is a REMOVED op → 400 unknown op, NOT forwarded (memory203/13 §0.5)', async () => {
    const cap = mintCap('im_alice', 'ws_a');
    const r = await post(baseUrl, '/local/memory/curate', { workspaceId: 'ws_a', op: 'run_dream' }, cap);
    // §0.5 dropped run_dream from CURATE_OPS (rpc.ts:1181,1327): Dream is not a
    // cloud-LLM trigger any agent can fire. It is now an unknown op → 400, and
    // nothing is forwarded to the cloud.
    expect(r.status).toBe(400);
    expect(cloudCalls.length).toBe(0);
  });

  it('promote_to_hub forwards to cloud; cloud orchestrator_only 403 is passed through verbatim', async () => {
    orchestratorForbidden = true;
    const cap = mintCap('im_bob', 'ws_a');
    const r = await post(
      baseUrl,
      '/local/memory/curate',
      { workspaceId: 'ws_a', op: 'promote_to_hub', pageId: 'p1' },
      cap,
    );
    // The daemon forwarded (ws cap passed) and the cloud said 403 — daemon
    // passes that status through; it does NOT re-gate orchestrator itself.
    expect(cloudCalls).toHaveLength(1);
    expect(cloudCalls[0].path).toContain('/promote-to-hub');
    expect(r.status).toBe(403);
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toBe('orchestrator_only');
  });

  it('promote_to_hub succeeds when cloud allows (orchestrator)', async () => {
    const cap = mintCap('im_orch', 'ws_a');
    const r = await post(
      baseUrl,
      '/local/memory/curate',
      { workspaceId: 'ws_a', op: 'promote_to_hub', pageId: 'p1' },
      cap,
    );
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.data.pageType).toBe('hub');
  });

  it('promote_to_hub without pageId → 400 (does not reach cloud)', async () => {
    const cap = mintCap('im_orch', 'ws_a');
    const r = await post(baseUrl, '/local/memory/curate', { workspaceId: 'ws_a', op: 'promote_to_hub' }, cap);
    expect(r.status).toBe(400);
    expect(cloudCalls.length).toBe(0);
  });

  it('unknown op → 400 (does not reach cloud)', async () => {
    const cap = mintCap('im_orch', 'ws_a');
    const r = await post(baseUrl, '/local/memory/curate', { workspaceId: 'ws_a', op: 'nuke' }, cap);
    expect(r.status).toBe(400);
    expect(cloudCalls.length).toBe(0);
  });

  it('forwards the acting-agent identity (cap.sub) as X-Prismer-Memory-Actor — so cloud gates the AGENT, not the owner key', async () => {
    const cap = mintCap('im_bob', 'ws_a');
    const r = await post(
      baseUrl,
      '/local/memory/curate',
      { workspaceId: 'ws_a', op: 'promote_to_hub', pageId: 'p1' },
      cap,
    );
    expect(r.status).toBe(200);
    expect(cloudCalls).toHaveLength(1);
    // The verified acting agent (cap.sub) is forwarded so the cloud's
    // isOrchestratorActor evaluates THIS agent's authority — not the daemon's
    // owner api_key (which would be callerKind='user' → gate bypassed).
    expect(cloudCalls[0].headers['x-prismer-memory-actor']).toBe('im_bob');
  });

  it('rebuild_index forwards to /index/rebuild', async () => {
    const cap = mintCap('im_orch', 'ws_a');
    const r = await post(baseUrl, '/local/memory/curate', { workspaceId: 'ws_a', op: 'rebuild_index' }, cap);
    expect(r.status).toBe(200);
    expect(r.body.data.rebuilt).toBe(true);
    expect(cloudCalls[0].path).toContain('/index/rebuild');
  });
});

describe('memory curate RPC (no cloud → degrade)', () => {
  let server: LocalServer | undefined;
  let runtime: MemoryRuntime | undefined;
  let baseUrl = '';

  beforeEach(async () => {
    __resetCapKeyForTest();
    const dir = mkdtempSync(join(tmpdir(), 'prismer-curate-rpc-nocloud-'));
    cleanupDirs.push(dir);
    runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'dev_x' });
    server = new LocalServer({
      port: 0, // ephemeral — read the real port back after start (O16-b)
      getState: () => baseState,
      attachMemory: attachMemoryRpc({ runtime }), // no cloud wired
    });
    await server.start();
    baseUrl = boundBaseUrl(server);
  });

  afterEach(async () => {
    await server?.stop();
    runtime?.closeAll();
  });

  it('cloud not wired → 200 degraded no-op', async () => {
    const cap = mintCap('im_alice', 'ws_a');
    // rebuild_index is a valid op; with no cloud wired the handler degrades to a
    // 200 no-op (run_dream would 400 on op-validation before the degrade branch).
    const r = await post(baseUrl, '/local/memory/curate', { workspaceId: 'ws_a', op: 'rebuild_index' }, cap);
    expect(r.status).toBe(200);
    expect(r.body.degraded).toBe(true);
    expect(r.body.reason).toBe('cloud_not_wired');
  });
});
