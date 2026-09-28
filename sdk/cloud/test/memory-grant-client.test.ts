/**
 * Unit tests for the cross-workspace memory grant SDK face (memory211/05 W3,
 * plan 2026-09-10-cross-workspace-memory-grant-v1 Task 5).
 *
 * Strategy mirrors `commands-environment.test.ts`: a real PrismerClient over a
 * mocked fetch, asserting the WIRE contract the IM routes pin —
 *   POST   /api/im/memory/grants           { targetWorkspaceId, expiresInDays? } [+ ?workspaceId=]
 *   GET    /api/im/memory/grants[?workspaceId=]
 *   GET    /api/im/memory/grants/incoming[?workspaceId=]
 *   DELETE /api/im/memory/grants/:id
 *   POST   /api/im/memory/external/search  { sourceWorkspaceId, queries, limit? } [+ ?workspaceId=]
 *   POST   /api/im/memory/external/load    { sourceWorkspaceId, path, format? }  [+ ?workspaceId=]
 * plus the verbatim fail-envelope pass-through (`ok:false` + server codes — the
 * SDK never rewrites 404-family/403/429 memory-grant codes).
 */

import { describe, it, expect, vi } from 'vitest';
import { PrismerClient, type IMMemoryGrant } from '../src/index';

type FetchCall = { url: string; method: string; body?: unknown; headers: Record<string, string> };

function makeFetchMock(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ url, method, body: init?.body, headers: (init?.headers ?? {}) as Record<string, string> });
    return handler(url, init);
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

function makeClient(fetchFn: typeof fetch): PrismerClient {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const client = new PrismerClient({
    apiKey: 'sk-prismer-live-testkey0000000000000000000000000000000000000000',
    baseUrl: 'https://api.test',
    fetch: fetchFn,
  });
  warnSpy.mockRestore();
  return client;
}

function okEnvelope(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function failEnvelope(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ ok: false, error: { code, message } }), { status });
}

const GRANT: IMMemoryGrant = {
  id: 'mgr_01ABC',
  sourceWorkspaceId: 'ws_src',
  targetWorkspaceId: 'ws_tgt',
  subjectAgentId: null,
  selectorJson: null,
  status: 'active',
  grantedByImUserId: 'usr_owner',
  approvalId: null,
  expiresAt: '2026-10-10T00:00:00.000Z',
  createdAt: '2026-09-10T00:00:00.000Z',
  updatedAt: '2026-09-10T00:00:00.000Z',
};

function memory(client: PrismerClient) {
  return client.im.memory;
}

describe('client.im.memory.grants — wire contract', () => {
  it('create posts targetWorkspaceId + optional expiresInDays and the workspace hint as query', async () => {
    const { fetchFn, calls } = makeFetchMock(() => okEnvelope(GRANT));
    const client = makeClient(fetchFn);

    const res = await memory(client).grants.create({
      targetWorkspaceId: 'ws_tgt',
      expiresInDays: 90,
      workspaceId: 'ws_src',
    });

    expect(res.ok).toBe(true);
    expect(res.data!.id).toBe('mgr_01ABC');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/api/im/memory/grants');
    expect(url.searchParams.get('workspaceId')).toBe('ws_src');
    expect(JSON.parse(calls[0]!.body as string)).toEqual({ targetWorkspaceId: 'ws_tgt', expiresInDays: 90 });
  });

  it('create omits expiresInDays / workspaceId when unspecified', async () => {
    const { fetchFn, calls } = makeFetchMock(() => okEnvelope(GRANT));
    const client = makeClient(fetchFn);

    await memory(client).grants.create({ targetWorkspaceId: 'ws_tgt' });

    expect(JSON.parse(calls[0]!.body as string)).toEqual({ targetWorkspaceId: 'ws_tgt' });
    expect(new URL(calls[0]!.url).search).toBe('');
  });

  it('list and incoming are GETs on the granted / incoming views', async () => {
    const { fetchFn, calls } = makeFetchMock(() => okEnvelope([GRANT]));
    const client = makeClient(fetchFn);

    await memory(client).grants.list();
    await memory(client).grants.list({ workspaceId: 'ws_src' });
    await memory(client).grants.incoming({ workspaceId: 'ws_tgt' });

    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}?${new URL(c.url).searchParams}`)).toEqual([
      'GET /api/im/memory/grants?',
      'GET /api/im/memory/grants?workspaceId=ws_src',
      'GET /api/im/memory/grants/incoming?workspaceId=ws_tgt',
    ]);
  });

  it('revoke is a DELETE on the encoded grant id', async () => {
    const { fetchFn, calls } = makeFetchMock(() => okEnvelope({ ...GRANT, status: 'revoked' }));
    const client = makeClient(fetchFn);

    const res = await memory(client).grants.revoke('mgr_01/ABC');

    expect(res.ok).toBe(true);
    expect(res.data!.status).toBe('revoked');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('DELETE');
    expect(new URL(calls[0]!.url).pathname).toBe('/api/im/memory/grants/mgr_01%2FABC');
  });

  it('fail envelopes pass through verbatim (ok:false + server code, never thrown)', async () => {
    const { fetchFn, calls } = makeFetchMock(() => failEnvelope(409, 'MEMORY_GRANT_PAIR_RACE', 'pair raced'));
    const client = makeClient(fetchFn);

    const res = await memory(client).grants.create({ targetWorkspaceId: 'ws_tgt' });

    expect(res.ok).toBe(false);
    expect(res.error!.code).toBe('MEMORY_GRANT_PAIR_RACE');
    expect(res.error!.message).toBe('pair raced');
    expect(calls).toHaveLength(1);
  });
});

describe('client.im.memory.externalSearch / externalLoad — wire contract', () => {
  it('search posts sourceWorkspaceId + queries (+limit) and the workspace hint as query', async () => {
    const payload = {
      sourceWorkspaceId: 'ws_src',
      grantId: 'mgr_01ABC',
      resultsByQuery: [{ query: 'quartz', results: [], navigation: undefined }],
      results: [],
      took_ms: 4,
    };
    const { fetchFn, calls } = makeFetchMock(() => okEnvelope(payload));
    const client = makeClient(fetchFn);

    const res = await memory(client).externalSearch({
      sourceWorkspaceId: 'ws_src',
      queries: ['quartz', 'gadolinium'],
      limit: 5,
      workspaceId: 'ws_tgt',
    });

    expect(res.ok).toBe(true);
    expect(res.data!.grantId).toBe('mgr_01ABC');
    expect(res.data!.resultsByQuery[0]!.query).toBe('quartz');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/api/im/memory/external/search');
    expect(url.searchParams.get('workspaceId')).toBe('ws_tgt');
    expect(JSON.parse(calls[0]!.body as string)).toEqual({
      sourceWorkspaceId: 'ws_src',
      queries: ['quartz', 'gadolinium'],
      limit: 5,
    });
  });

  it('load posts sourceWorkspaceId + path (+format)', async () => {
    const payload = {
      sourceWorkspaceId: 'ws_src',
      grantId: 'mgr_01ABC',
      tier: 'grant',
      via: 'grant:mgr_01ABC',
      page: {
        pageId: 'pg_1',
        sourceWorkspaceId: 'ws_src',
        path: 'notes/quartz.pkf',
        title: 'Quartz',
        description: null,
        pageType: 'leaf',
        visibility: 'workspace',
        stale: false,
        version: 3,
        createdAt: '2026-09-10T00:00:00.000Z',
        updatedAt: '2026-09-10T00:00:00.000Z',
        content: 'body',
        contentHtml: '<p>body</p>',
        tier: 'grant',
        via: 'grant:mgr_01ABC',
      },
    };
    const { fetchFn, calls } = makeFetchMock(() => okEnvelope(payload));
    const client = makeClient(fetchFn);

    const res = await memory(client).externalLoad({
      sourceWorkspaceId: 'ws_src',
      path: 'notes/quartz.pkf',
      format: 'markdown',
    });

    expect(res.ok).toBe(true);
    expect(res.data!.page.tier).toBe('grant');
    expect(res.data!.page.via).toBe('grant:mgr_01ABC');
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).pathname).toBe('/api/im/memory/external/load');
    expect(JSON.parse(calls[0]!.body as string)).toEqual({
      sourceWorkspaceId: 'ws_src',
      path: 'notes/quartz.pkf',
      format: 'markdown',
    });
  });

  it('external-channel failures pass through verbatim (404 zero-leak family, 429 budget)', async () => {
    const { fetchFn, calls } = makeFetchMock((url) => {
      if (url.includes('/external/search')) return failEnvelope(404, 'MEMORY_EXTERNAL_UNAVAILABLE', 'external memory source is not available');
      return new Response(
        JSON.stringify({
          ok: false,
          error: {
            code: 'MEMORY_EXTERNAL_RATE_LIMITED',
            message: 'external memory recall rate limit exceeded (60/min per caller per source workspace)',
            details: { limit: 60, retryAfterMs: 42000 },
          },
        }),
        { status: 429 },
      );
    });
    const client = makeClient(fetchFn);

    const search = await memory(client).externalSearch({ sourceWorkspaceId: 'ws_src', queries: ['q'] });
    expect(search.ok).toBe(false);
    expect(search.error!.code).toBe('MEMORY_EXTERNAL_UNAVAILABLE');

    const load = await memory(client).externalLoad({ sourceWorkspaceId: 'ws_src', path: 'notes/quartz.pkf' });
    expect(load.ok).toBe(false);
    expect(load.error!.code).toBe('MEMORY_EXTERNAL_RATE_LIMITED');
    expect((load.error as unknown as { details?: { limit?: number } }).details?.limit).toBe(60);
  });
});
