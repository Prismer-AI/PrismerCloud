import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalServer, type LocalServerState } from '../src/daemon/local-server.js';
import { MemoryRuntime, attachMemoryRpc } from '../src/daemon/memory/index.js';

let cleanupDirs: string[] = [];
let server: LocalServer | undefined;
let runtime: MemoryRuntime | undefined;
let baseUrl = '';

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
  const dir = mkdtempSync(join(tmpdir(), 'prismer-memory-rpc-'));
  cleanupDirs.push(dir);
  runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'dev_x' });
  const port = 38000 + Math.floor(Math.random() * 1000);
  server = new LocalServer({
    port,
    getState: () => baseState,
    attachMemory: attachMemoryRpc({ runtime }),
  });
  await server.start();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
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
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function post(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
});
