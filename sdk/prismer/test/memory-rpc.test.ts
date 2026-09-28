import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalServer, type LocalServerState } from '../src/daemon/local-server.js';
import { boundBaseUrl } from './_helpers/listen-ephemeral.js';
import { MemoryRuntime, attachMemoryRpc } from '../src/daemon/memory/index.js';
import { mintSystemCap } from '../src/daemon/memory/cap.js';
import { CloudClient } from '../src/auth.js';

let cleanupDirs: string[] = [];
let server: LocalServer | undefined;
let runtime: MemoryRuntime | undefined;
let baseUrl = '';
// spec16 §8.1 — the RPC is fail-closed; this suite exercises daemon-level
// behavior across several workspaces (incl. the global /stats aggregate), so
// the helpers carry the daemon-internal system cap (the test channel).
let sysCap = '';

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

beforeEach(async () => {
  // Preserve this broad RPC suite's legacy flat fixtures. Default enforcement
  // is asserted explicitly in memory-write-w2.test.ts.
  process.env.PRISMER_MEMORY_PLACEMENT_ENFORCE = 'warn';
  const dir = mkdtempSync(join(tmpdir(), 'prismer-memory-rpc-'));
  cleanupDirs.push(dir);
  sysCap = mintSystemCap();
  runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'dev_x' });
  server = new LocalServer({
    port: 0, // ephemeral — read the real port back after start (O16-b)
    getState: () => baseState,
    attachMemory: attachMemoryRpc({ runtime }),
  });
  await server.start();
  baseUrl = boundBaseUrl(server);
});

afterEach(async () => {
  delete process.env.PRISMER_MEMORY_PLACEMENT_ENFORCE;
  await server?.stop();
  runtime?.closeAll();
  for (const d of cleanupDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, { headers: { 'x-prismer-memory-cap': sysCap } });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function post(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-prismer-memory-cap': sysCap },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const writeBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  workspaceId: 'ws_test',
  path: 'INDEX.md',
  content: '# index\n\n- decisions/auth.md',
  pageType: 'hub',
  title: 'Workspace Index',
  actorImUserId: 'im_alice',
  actorKind: 'human',
  ...overrides,
});

describe('LocalServer + MemoryRuntime RPC', () => {
  it('healthz reports memoryReady=true when attachMemory is wired', async () => {
    const r = await get('/healthz');
    expect(r.status).toBe(200);
    expect((r.body as { memoryReady: boolean }).memoryReady).toBe(true);
  });

  it('POST /local/memory/write → returns page; GET /list reflects it', async () => {
    const w = await post('/local/memory/write', writeBody());
    expect(w.status).toBe(200);
    const written = (w.body as { page: { id: string; path: string } }).page;
    expect(written.path).toBe('INDEX.md');
    expect(written.id).toMatch(/^page_/);

    const l = await get('/local/memory/list?workspaceId=ws_test');
    expect(l.status).toBe(200);
    const pages = (l.body as { pages: Array<{ path: string }> }).pages;
    expect(pages.map((p) => p.path)).toContain('INDEX.md');
  });

  it('GET /local/memory/load resolves prismer:// URI to page + content', async () => {
    await post('/local/memory/write', writeBody({ path: 'decisions/auth.md', content: 'OAuth chosen' }));
    const r = await get(
      '/local/memory/load?uri=' + encodeURIComponent('prismer://workspace/ws_test/memory/decisions/auth.md'),
    );
    expect(r.status).toBe(200);
    const body = r.body as { page: { path: string }; content: string };
    expect(body.page.path).toBe('decisions/auth.md');
    expect(body.content).toBe('OAuth chosen');
  });

  it('GET /local/memory/load 404 when page missing', async () => {
    const r = await get('/local/memory/load?workspaceId=ws_test&path=missing.md');
    expect(r.status).toBe(404);
  });

  it('GET /local/memory/search returns BM25-ranked hits', async () => {
    await post('/local/memory/write', writeBody({ path: 'a.md', content: 'OAuth migration notes' }));
    await post('/local/memory/write', writeBody({ path: 'b.md', content: 'Stripe billing' }));
    const r = await get('/local/memory/search?workspaceId=ws_test&q=OAuth');
    expect(r.status).toBe(200);
    const results = (r.body as { results: Array<{ path: string }> }).results;
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.path).toBe('a.md');
  });

  // Pre-deploy regression: handleSearch silently dropped pageType from the
  // query string, so memory_search calls with `pageType=['decision']` returned
  // ALL pageType results unfiltered (recall correctness violation). This
  // verifies the daemon now forwards the filter to MemorySearch.hybrid().
  it('GET /local/memory/search?pageType=decision filters to that pageType', async () => {
    // Two pages share the term "auth" but with different pageType. Without
    // the filter both come back; with pageType=decision only one should.
    await post('/local/memory/write', writeBody({
      path: 'decisions/auth.md',
      content: 'auth decision: chose OAuth over SAML',
      pageType: 'decision',
    }));
    await post('/local/memory/write', writeBody({
      path: 'glossary/auth.md',
      content: 'auth glossary: terms used in auth flow',
      pageType: 'glossary',
    }));

    const unfiltered = await get('/local/memory/search?workspaceId=ws_test&q=auth');
    expect(unfiltered.status).toBe(200);
    const allHits = (unfiltered.body as { results: Array<{ path: string }> }).results;
    expect(allHits.map((r) => r.path).sort()).toEqual(['decisions/auth.md', 'glossary/auth.md']);

    const filtered = await get('/local/memory/search?workspaceId=ws_test&q=auth&pageType=decision');
    expect(filtered.status).toBe(200);
    const decisionOnly = (filtered.body as { results: Array<{ path: string }> }).results;
    expect(decisionOnly.map((r) => r.path)).toEqual(['decisions/auth.md']);

    // Unknown pageType values are silently ignored (treated as no filter), so
    // the query falls back to the unfiltered result set rather than 400-ing.
    // This keeps the daemon forward-compatible if the union grows.
    const bogus = await get('/local/memory/search?workspaceId=ws_test&q=auth&pageType=bogus');
    expect(bogus.status).toBe(200);
    const bogusHits = (bogus.body as { results: Array<{ path: string }> }).results;
    expect(bogusHits.map((r) => r.path).sort()).toEqual(['decisions/auth.md', 'glossary/auth.md']);
  });

  it('POST /local/memory/flush returns queue depth without uploading (phase-0)', async () => {
    await post('/local/memory/write', writeBody({ path: 'a.md' }));
    const r = await post('/local/memory/flush', { workspaceId: 'ws_test' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ pending: 0, flushed: 0 });
    // pending=0 because store.write() doesn't auto-enqueue outbox events in
    // phase-0 (that wiring is part of phase-1 sync). Outbox API is reachable
    // for callers that want to enqueue manually.
  });

  it('POST /local/memory/invalidate removes pages', async () => {
    const w = await post('/local/memory/write', writeBody({ path: 'doomed.md' }));
    const id = (w.body as { page: { id: string } }).page.id;
    const r = await post('/local/memory/invalidate', {
      workspaceId: 'ws_test',
      pageIds: [id],
      reason: 'soft_delete',
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ workspaceId: 'ws_test', invalidated: 1 });
    const after = await get('/local/memory/load?workspaceId=ws_test&path=doomed.md');
    expect(after.status).toBe(404);
  });

  it('GET /local/memory/stats global aggregates across workspaces', async () => {
    await post('/local/memory/write', writeBody({ workspaceId: 'ws_a', path: 'a.md' }));
    await post('/local/memory/write', writeBody({ workspaceId: 'ws_b', path: 'b.md' }));
    const r = await get('/local/memory/stats');
    expect(r.status).toBe(200);
    const body = r.body as { workspaceCount: number; totalPages: number };
    expect(body.workspaceCount).toBe(2);
    expect(body.totalPages).toBe(2);
  });

  it('POST /local/memory/write 400 on missing required fields', async () => {
    const r = await post('/local/memory/write', { workspaceId: 'ws_test' });
    expect(r.status).toBe(400);
  });

  it('GET /local/memory/health accepts kind=oversized (memory203/20 §1.2 hub-size advisory) — degraded shape offline', async () => {
    const r = await get('/local/memory/health?workspaceId=ws_test&kind=oversized');
    expect(r.status).toBe(200);
    const body = r.body as { ok: boolean; degraded?: boolean; candidates?: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.degraded).toBe(true);
    expect(body.candidates).toHaveProperty('oversized');
  });

  it('GET /local/memory/health kind=all includes the oversized surface; bogus kind still 400', async () => {
    const all = await get('/local/memory/health?workspaceId=ws_test&kind=all');
    expect(all.status).toBe(200);
    expect((all.body as { candidates: Record<string, unknown> }).candidates).toHaveProperty('oversized');
    const bogus = await get('/local/memory/health?workspaceId=ws_test&kind=gigantic');
    expect(bogus.status).toBe(400);
  });

  it('non-memory routes still reachable when attachMemory wired (e.g. /healthz)', async () => {
    const r = await get('/healthz');
    expect(r.status).toBe(200);
    // /agents is a normal route — fall-through must work.
    const r2 = await get('/agents');
    expect(r2.status).toBe(200);
  });

  it('unknown /local/memory/* sub-route returns 404 from memory handler', async () => {
    const r = await get('/local/memory/nonsense');
    expect(r.status).toBe(404);
    expect((r.body as { error: string }).error).toBe('memory_route_not_found');
  });

  // T2-A: out-of-process observability event sink. Hermes Python provider
  // POSTs recall_inject / recall_pull envelopes here; we validate the daemon
  // accepts them and they land in the outbox for the C2 worker to upload.
  it('POST /local/memory/observability/emit accepts recall_inject envelope', async () => {
    const eventId = '01HZX0000000000000000000RI';
    const createdAt = new Date().toISOString();
    const r = await post('/local/memory/observability/emit', {
      eventId,
      schemaVersion: 1,
      eventType: 'recall_inject',
      workspaceId: 'ws_test',
      actorImUserId: 'im_agent_x',
      actorKind: 'agent',
      deviceId: 'dev_x',
      createdAt,
      idempotencyKey: `obs:recall_inject:im_agent_x:${createdAt}:${eventId.slice(0, 8)}`,
      pageId: 'page_seed',
      query: 'how do I auth',
      metadataJson: { sessionId: 'sess_1', turnIndex: 0 },
      metricsJson: { tokenCount: 42, relevanceScore: 0.8, topK: 1 },
    });
    expect(r.status).toBe(200);
    const body = r.body as { id: string; deadLetter: boolean };
    expect(body.deadLetter).toBe(false);
    expect(body.id).toMatch(/^out_/);

    // Verify the event landed in the outbox (per-workspace stats).
    const stats = await get('/local/memory/stats?workspaceId=ws_test');
    expect((stats.body as { pendingOutbox: number }).pendingOutbox).toBe(1);
  });

  it('POST /local/memory/observability/emit dead-letters invalid envelope', async () => {
    const r = await post('/local/memory/observability/emit', {
      // Missing schemaVersion, idempotencyKey, etc. — zod will reject.
      eventType: 'recall_pull',
      workspaceId: 'ws_test',
      actorImUserId: 'im_agent_x',
    });
    expect(r.status).toBe(400);
    const body = r.body as { error: string; deadLetterId: string };
    expect(body.error).toBe('envelope_validation_failed');
    expect(body.deadLetterId).toMatch(/^dl_/);
  });

  it('POST /local/memory/observability/emit 400 when workspaceId missing', async () => {
    const r = await post('/local/memory/observability/emit', {
      eventType: 'recall_pull',
      // No workspaceId — handler 400s before reaching outbox.enqueue.
    });
    expect(r.status).toBe(400);
  });

  // ─── Retired extract routes (memory203/13 §0.5) ─────────────────────────
  // The cloud-extract lane is RETIRED: extraction now runs in-pod via the
  // post_llm_call hook (extract.ts → gateway /api/v1/messages), never via the
  // cloud LLM. The extract-turn / extract-compress routes are kept addressable
  // (so an older provider shell never 404s) but are inert no-ops that return
  // `{ok:true, retired:true, reason:'cloud_extract_retired_memory203_13_0_5'}`
  // UNCONDITIONALLY — no workspaceId validation, no queueing, no cloud forward
  // (rpc.ts:189-190).
  const RETIRED_BODY = {
    ok: true,
    retired: true,
    reason: 'cloud_extract_retired_memory203_13_0_5',
  };

  it('POST /local/memory/extract-turn is a retired inert no-op (memory203/13 §0.5)', async () => {
    const r = await post('/local/memory/extract-turn', {
      workspaceId: 'ws_test',
      userMessage: 'a'.repeat(100),
      assistantResponse: 'b'.repeat(300),
      sessionId: 'sess_1',
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual(RETIRED_BODY);
  });

  it('POST /local/memory/extract-turn returns retired 200 even without workspaceId (route no longer validates)', async () => {
    const r = await post('/local/memory/extract-turn', { userMessage: 'x' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual(RETIRED_BODY);
  });

  it('POST /local/memory/extract-compress is a retired inert no-op (memory203/13 §0.5)', async () => {
    const r = await post('/local/memory/extract-compress', {
      workspaceId: 'ws_test',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual(RETIRED_BODY);
  });

  it('POST /local/memory/mirror writes an add into the workspace-shared substrate (no cloud needed)', async () => {
    const r = await post('/local/memory/mirror', {
      workspaceId: 'ws_test',
      action: 'add',
      target: 'preferences/tone.md',
      content: 'user prefers concise replies',
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, mirrored: true, action: 'add' });
  });

  it('POST /local/memory/mirror remove is an acknowledged no-op', async () => {
    const r = await post('/local/memory/mirror', {
      workspaceId: 'ws_test',
      action: 'remove',
      target: 'preferences/tone.md',
      content: '',
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, mirrored: false, action: 'remove' });
  });

  it('POST /local/memory/mirror 400 when workspaceId missing', async () => {
    const r = await post('/local/memory/mirror', { action: 'add', target: 'x', content: 'y' });
    expect(r.status).toBe(400);
  });
});

// Provider extract routes WITH a wired (stub) cloud client. memory203/13 §0.5
// RETIRED the cloud-extract lane: even with a cloud wired, the extract-turn
// route no longer forwards to /api/im/memory/extract — it returns the inert
// retired no-op and the cloud stub is NEVER hit (extractCalls stays 0).
describe('LocalServer + provider extract routes (cloud wired)', () => {
  let dir2 = '';
  let server2: LocalServer | undefined;
  let runtime2: MemoryRuntime | undefined;
  let base2 = '';
  let extractCalls = 0;

  beforeEach(async () => {
    dir2 = mkdtempSync(join(tmpdir(), 'prismer-memory-rpc-cloud-'));
    cleanupDirs.push(dir2);
    runtime2 = new MemoryRuntime({ baseDir: dir2, deviceId: 'dev_x' });
    extractCalls = 0;
    const fetchStub: typeof fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('/api/im/memory/extract')) {
        extractCalls += 1;
        return new Response(
          JSON.stringify({
            ok: true,
            data: {
              extracted: [
                {
                  path: 'project/facts.md',
                  memoryType: 'project',
                  description: 'a fact',
                  content: 'the api base is /api/v1',
                },
              ],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const cloud = new CloudClient({ baseUrl: 'http://cloud.test', apiKey: 'sk-test', fetchImpl: fetchStub });
    server2 = new LocalServer({
      port: 0, // ephemeral — read the real port back after start (O16-b)
      getState: () => baseState,
      attachMemory: attachMemoryRpc({ runtime: runtime2, cloud, deviceId: 'dev_x' }),
    });
    await server2.start();
    base2 = boundBaseUrl(server2);
  });

  afterEach(async () => {
    await server2?.stop();
    runtime2?.closeAll();
  });

  it('extract-turn returns the retired no-op and NEVER forwards to cloud (memory203/13 §0.5)', async () => {
    const res = await fetch(`${base2}/local/memory/extract-turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-prismer-memory-cap': sysCap },
      body: JSON.stringify({
        workspaceId: 'ws_cloud',
        userMessage:
          'Please record this for future sessions: our API base path is /api/v1 for all backend ' +
          'calls, and every service we build should default to that prefix unless told otherwise.',
        assistantResponse:
          'Understood — I will use /api/v1 as the API base for every backend request from now on, ' +
          'and I have noted it so future sessions pick it up automatically. Any new service or client ' +
          'I generate will default to the /api/v1 prefix for backend calls unless you explicitly ' +
          'override it, keeping the convention consistent across the whole codebase.',
        sessionId: 'sess_cloud',
      }),
    });
    // RETIRED (memory203/13 §0.5): the route short-circuits to an inert 200 no-op
    // and forwards NOTHING to the cloud LLM — the cloud-extract lane is gone.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; retired: boolean; reason: string };
    expect(body.ok).toBe(true);
    expect(body.retired).toBe(true);
    expect(body.reason).toBe('cloud_extract_retired_memory203_13_0_5');

    // Negative control on the retirement: give any (regressed) background forward
    // a window to fire — the cloud stub must stay untouched.
    await new Promise((r) => setTimeout(r, 100));
    expect(extractCalls).toBe(0);
  });
});
