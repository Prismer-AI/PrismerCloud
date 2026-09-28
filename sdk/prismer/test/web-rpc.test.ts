// release203 web-capability fix — daemon `/local/web/*` routes.
//
// Proves the daemon leg of the web-tools lane (daemon/web/rpc.ts):
//   - /local/web/search forwards { input: query } to the cloud Load API with
//     the daemon's OWN `Authorization: Bearer sk-prismer-*` (auth form the
//     Load API's apiGuard accepts — no JWT exchange).
//   - text fields in the passthrough are bounded (~8k chars, marked).
//   - /local/web/load forwards single + batch url shapes.
//   - negative: non-http(s) input → 400 invalid_url, NEVER forwarded.
//   - degrade: no cloud client → structured 503 (降级不中断).

import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LocalServer, type LocalServerState } from '../src/daemon/local-server.js';
import { boundBaseUrl } from './_helpers/listen-ephemeral.js';
import {
  attachWebRpc,
  boundLoadApiPayload,
  WEB_TEXT_FIELD_MAX,
  type HeadlessSeam,
} from '../src/daemon/web/rpc.js';
import type { HeadlessLoadOutcome, HeadlessSearchOutcome } from '../src/daemon/web/headless-serp.js';
import { SeenJournal } from '../src/daemon/web/seen-journal.js';
import { CloudClient } from '../src/auth.js';

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

async function post(baseUrl: string, path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe('web tools RPC (/local/web/*)', () => {
  let server: LocalServer | undefined;
  let baseUrl = '';
  let cloud: CloudClient;
  let cloudCalls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
  // Per-test control of what the stub cloud Load API returns.
  let cloudResponse: () => Response = () =>
    new Response(JSON.stringify({ success: true, mode: 'query', results: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  beforeEach(async () => {
    cloudCalls = [];
    const fetchStub: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = v;
      cloudCalls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : {}, headers });
      return cloudResponse();
    }) as typeof fetch;

    cloud = new CloudClient({ baseUrl: 'http://cloud.test', apiKey: 'sk-prismer-test-key', fetchImpl: fetchStub });
    server = new LocalServer({
      port: 0, // ephemeral — read the real port back after start (O16-b)
      getState: () => baseState,
      attachWeb: attachWebRpc({ cloud }),
    });
    await server.start();
    baseUrl = boundBaseUrl(server);
  });

  afterEach(async () => {
    await server?.stop();
  });

  it('search forwards { input: query } to /api/context/load with the daemon Bearer sk-prismer key', async () => {
    const r = await post(baseUrl, '/local/web/search', { query: 'anthropic latest models', limit: 3 });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(cloudCalls).toHaveLength(1);
    expect(cloudCalls[0].url).toBe('http://cloud.test/api/context/load');
    expect(cloudCalls[0].body).toMatchObject({
      input: 'anthropic latest models',
      inputType: 'query',
      // BOTH topKs: search.topK bounds how many hits get compressed (the
      // route default of 15 made cold queries take 59–118s), return.topK
      // bounds the ranked results returned.
      search: { topK: 3 },
      return: { topK: 3 },
    });
    // Auth form: plain apikey Bearer — the Load API apiGuard's dual-form
    // Bearer accepts sk-prismer-* directly (src/lib/api-guard.ts).
    expect(cloudCalls[0].headers.authorization).toBe('Bearer sk-prismer-test-key');
    // Self-fetch scheme fix: the Load API self-fetches /api/search at
    // `x-forwarded-proto || https`; the daemon must send the proto of its own
    // cloud baseUrl (http here) or a plain-HTTP cloud 500s.
    expect(cloudCalls[0].headers['x-forwarded-proto']).toBe('http');
  });

  it('search passthrough bounds oversized text fields and marks truncation', async () => {
    const huge = 'x'.repeat(WEB_TEXT_FIELD_MAX + 5_000);
    cloudResponse = () =>
      new Response(
        JSON.stringify({
          success: true,
          mode: 'query',
          results: [{ rank: 1, url: 'https://example.com', title: 't', hqcc: huge, cached: false }],
          summary: { query: 'q', searched: 1, cacheHits: 0, compressed: 1, returned: 1 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    const r = await post(baseUrl, '/local/web/search', { query: 'q' });
    expect(r.status).toBe(200);
    const hqcc: string = r.body.results[0].hqcc;
    expect(hqcc.length).toBeLessThan(WEB_TEXT_FIELD_MAX + 200);
    expect(hqcc).toContain('[truncated');
    expect(r.body.results[0].hqccTruncated).toBe(true);
    // Non-text structure passes through untouched.
    expect(r.body.summary.searched).toBe(1);
  });

  it('search requires a non-empty query (400, not forwarded)', async () => {
    const r = await post(baseUrl, '/local/web/search', { query: '   ' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('query_required');
    expect(cloudCalls).toHaveLength(0);
  });

  it('load forwards a single url as { input: url } and a batch as { input: urls[] }', async () => {
    cloudResponse = () =>
      new Response(JSON.stringify({ success: true, mode: 'single_url', result: { url: 'https://a.com', hqcc: 'ok' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    const single = await post(baseUrl, '/local/web/load', { url: 'https://a.com' });
    expect(single.status).toBe(200);
    expect(cloudCalls[0].body.input).toBe('https://a.com');

    const batch = await post(baseUrl, '/local/web/load', { urls: ['https://a.com', 'https://b.com'] });
    expect(batch.status).toBe(200);
    expect(cloudCalls[1].body.input).toEqual(['https://a.com', 'https://b.com']);
  });

  it('NEGATIVE: load rejects garbage schemes with 400 invalid_url and never forwards', async () => {
    // memory203/20 §2.2 — prismer:// is now ACCEPTED (workspace asset/file
    // pointers ride the same lane), so it is no longer in this list.
    for (const bad of ['file:///etc/passwd', 'ftp://x.com/a', 'not-a-url']) {
      cloudCalls = [];
      const r = await post(baseUrl, '/local/web/load', { url: bad });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('invalid_url');
      expect(cloudCalls).toHaveLength(0);
    }
  });

  it('load ACCEPTS prismer:// URIs and forwards them to the cloud Load API unchanged (memory203/20 §2.2)', async () => {
    cloudResponse = () =>
      new Response(
        JSON.stringify({ success: true, mode: 'prismer_uri', result: { url: 'prismer://owner/asset/abc', hqcc: 'asset text' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    const uri = 'prismer://owner/asset/' + 'a'.repeat(64);
    const r = await post(baseUrl, '/local/web/load', { url: uri });
    expect(r.status).toBe(200);
    expect(cloudCalls).toHaveLength(1);
    // Forwarded UNCHANGED — the cloud Load API is the resolution authority.
    expect(cloudCalls[0].body.input).toBe(uri);
  });

  it('load rejects an oversized batch (400 too_many_urls)', async () => {
    const urls = Array.from({ length: 6 }, (_, i) => `https://e${i}.com`);
    const r = await post(baseUrl, '/local/web/load', { urls });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('too_many_urls');
    expect(cloudCalls).toHaveLength(0);
  });

  it('cloud error status + code pass through (not a daemon crash) — explicit off mode', async () => {
    // 默认已是 fallback（cloud 失败→headless 兜底），此用例验证"显式 off 时
    // cloud 错误原样透传、daemon 不崩"
    await server?.stop();
    server = new LocalServer({
      port: 0,
      getState: () => baseState,
      attachWeb: attachWebRpc({ cloud, env: { FF_WEB_HEADLESS_SERP: 'off' } }),
    });
    await server.start();
    baseUrl = boundBaseUrl(server);
    cloudResponse = () =>
      new Response(JSON.stringify({ success: false, error: { code: 'SEARCH_ERROR', message: 'Search failed' } }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    const r = await post(baseUrl, '/local/web/search', { query: 'q' });
    expect(r.status).toBe(500);
    expect(r.body.ok).toBe(false);
  });

  it('degrades to 503 cloud_not_wired when no cloud client is attached', async () => {
    await server?.stop();
    server = new LocalServer({ port: 0, getState: () => baseState, attachWeb: attachWebRpc({}) });
    await server.start();
    baseUrl = boundBaseUrl(server);
    const r = await post(baseUrl, '/local/web/search', { query: 'q' });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('cloud_not_wired');
  });
});

describe('boundLoadApiPayload', () => {
  it('bounds result (single) and results (batch/query) text fields, leaves short fields alone', () => {
    const huge = 'y'.repeat(WEB_TEXT_FIELD_MAX * 2);
    const out = boundLoadApiPayload({
      mode: 'single_url',
      result: { url: 'https://a.com', hqcc: huge, raw: 'short' },
      results: [{ url: 'https://b.com', text: huge }],
    }) as any;
    expect(out.result.hqcc.length).toBeLessThan(WEB_TEXT_FIELD_MAX + 200);
    expect(out.result.hqccTruncated).toBe(true);
    expect(out.result.raw).toBe('short');
    expect(out.result.rawTruncated).toBeUndefined();
    expect(out.results[0].text.length).toBeLessThan(WEB_TEXT_FIELD_MAX + 200);
    expect(out.results[0].textTruncated).toBe(true);
  });
});

describe('web RPC headless routing (runtime210/01)', () => {
  let server: LocalServer | undefined;
  let baseUrl = '';
  let tmp: string;
  let cloudCalls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
  let cloudResponder: () => Response = () =>
    new Response(JSON.stringify({ success: true, mode: 'query', results: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  let headlessSearches = 0;
  let headlessLoads = 0;
  let journalSeq = 0;

  const okOutcome: HeadlessSearchOutcome = {
    ok: true,
    results: [
      { rank: 1, url: 'https://a.example/1', title: 'A One', snippet: 'snippet a', engine: 'bing' },
      { rank: 2, url: 'https://b.example/2', title: 'B Two', snippet: 'snippet b', engine: 'ddg' },
    ],
    attempts: [{ provider: 'headless', engine: 'bing', ok: true, ms: 5 }],
  };

  async function start(opts: {
    env?: Record<string, string>;
    searchOutcome?: HeadlessSearchOutcome;
    loadOutcome?: HeadlessLoadOutcome;
    journalFile?: string;
  }): Promise<void> {
    cloudCalls = [];
    headlessSearches = 0;
    headlessLoads = 0;
    // 每个用例重置（前一个用例可能改成 500/其它 payload）
    cloudResponder = () =>
      new Response(JSON.stringify({ success: true, mode: 'query', results: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    const fetchStub: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = v;
      cloudCalls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : {}, headers });
      return cloudResponder();
    }) as typeof fetch;
    const cloud = new CloudClient({ baseUrl: 'http://cloud.test', apiKey: 'sk-prismer-test-key', fetchImpl: fetchStub });
    const headless: HeadlessSeam = {
      search: async () => {
        headlessSearches++;
        return (
          opts.searchOutcome ?? {
            ok: false,
            results: [],
            attempts: [{ provider: 'headless', engine: 'bing', ok: false, ms: 1, error: 'stub_unset' }],
          }
        );
      },
      load: async (u: string) => {
        headlessLoads++;
        return (
          opts.loadOutcome ?? { ok: false, url: u, error: 'stub_unset', attempts: [] }
        );
      },
    };
    // 测试隔离：每个用例独立 journal（缺省时用 tmp 下唯一文件），
    // 防止 deposit 写进默认 ~/.prismer/cache 污染真实 daemon 状态
    server = new LocalServer({
      port: 0,
      getState: () => baseState,
      attachWeb: attachWebRpc({
        cloud,
        env: opts.env,
        headless,
        journalFile: opts.journalFile ?? path.join(tmp, `auto-${++journalSeq}.json`),
      }),
    });
    await server.start();
    baseUrl = boundBaseUrl(server);
  }

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'web-rpc-headless-'));
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  afterEach(async () => {
    await server?.stop();
  });

  it('local-first: headless results → load-shaped payload + save regression + journal', async () => {
    const journalFile = path.join(tmp, 'journal-1.json');
    await start({ env: { FF_WEB_HEADLESS_SERP: 'local-first' }, journalFile, searchOutcome: okOutcome });
    const r = await post(baseUrl, '/local/web/search', { query: 'test query', limit: 2 });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.degraded).toBe(true);
    // load 同构 key 集合（仅附加 degraded/providerAttempts）
    expect(Object.keys(r.body).sort()).toEqual(
      ['cost', 'degraded', 'mode', 'ok', 'processingTime', 'providerAttempts', 'requestId', 'results', 'success', 'summary'].sort(),
    );
    expect(r.body.mode).toBe('query');
    expect(r.body.cost).toEqual({ searchCredits: 0, compressionCredits: 0, totalCredits: 0, savedByCache: 0 });
    expect(r.body.results[0]).toMatchObject({
      url: 'https://a.example/1',
      hqcc: 'snippet a',
      cached: false,
      ranking: { score: 0 },
      meta: { source: 'headless_serp', engine: 'bing' },
    });
    // 回归：save 一次；load 未被调
    expect(cloudCalls).toHaveLength(1);
    expect(cloudCalls[0].url).toBe('http://cloud.test/api/context/save');
    expect(cloudCalls[0].body.items).toHaveLength(2);
    expect(cloudCalls[0].body.items[0]).toMatchObject({
      url: 'https://a.example/1',
      hqcc: 'snippet a',
      visibility: 'public',
      tags: ['test query'],
      meta: { source: 'headless_serp', engine: 'bing' },
    });
    // journal 落盘
    const j = new SeenJournal(journalFile);
    expect(j.has('https://a.example/1')).toBe(true);
    expect(j.has('https://b.example/2')).toBe(true);
  });

  it('local-first + headless fail → cloud fallback, degraded + attempts', async () => {
    await start({
      env: { FF_WEB_HEADLESS_SERP: 'local-first' },
      searchOutcome: {
        ok: false,
        results: [],
        attempts: [{ provider: 'headless', engine: 'bing', ok: false, ms: 3, error: 'challenge' }],
      },
    });
    const r = await post(baseUrl, '/local/web/search', { query: 'q', limit: 2 });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.degraded).toBe(true);
    expect(r.body.providerAttempts[0]).toMatchObject({ engine: 'bing', ok: false, error: 'challenge' });
    expect(cloudCalls).toHaveLength(1);
    expect(cloudCalls[0].url).toContain('/api/context/load');
  });

  it('fallback + cloud ok → cloud path only (headless never called)', async () => {
    await start({ env: { FF_WEB_HEADLESS_SERP: 'fallback' } });
    cloudResponder = () =>
      new Response(JSON.stringify({ success: true, mode: 'query', results: [{ rank: 1, url: 'https://c.example', title: 'C', hqcc: 'h' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    const r = await post(baseUrl, '/local/web/search', { query: 'q', limit: 2 });
    expect(headlessSearches).toBe(0);
    expect(r.status).toBe(200);
    expect(r.body.degraded).toBe(true);
    expect(cloudCalls).toHaveLength(1);
    expect(cloudCalls[0].url).toContain('/api/context/load');
  });

  it('fallback + cloud fail → headless rescue with cloud attempt recorded', async () => {
    await start({ env: { FF_WEB_HEADLESS_SERP: 'fallback' }, searchOutcome: okOutcome });
    cloudResponder = () => new Response(JSON.stringify({ success: false, error: { code: 'SEARCH_ERROR' } }), { status: 500 });
    const r = await post(baseUrl, '/local/web/search', { query: 'q', limit: 2 });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.degraded).toBe(true);
    expect(r.body.results[0].url).toBe('https://a.example/1');
    expect(r.body.providerAttempts[0]).toMatchObject({ provider: 'cloud', ok: false });
    expect(r.body.providerAttempts[1]).toMatchObject({ engine: 'bing', ok: true });
  });

  it('off (explicit env): unchanged cloud path, headless never called', async () => {
    await start({ env: { FF_WEB_HEADLESS_SERP: 'off' } });
    const r = await post(baseUrl, '/local/web/search', { query: 'q', limit: 2 });
    expect(headlessSearches).toBe(0);
    expect(r.status).toBe(200);
    expect(cloudCalls).toHaveLength(1);
    expect(cloudCalls[0].url).toContain('/api/context/load');
  });

  it('DEFAULT (no flag env): fallback — cloud primary, headless never called (2026-08-23 终裁)', async () => {
    await start({ searchOutcome: okOutcome });
    const r = await post(baseUrl, '/local/web/search', { query: 'q', limit: 2 });
    expect(headlessSearches).toBe(0);
    expect(r.status).toBe(200);
    expect(cloudCalls).toHaveLength(1);
    expect(cloudCalls[0].url).toContain('/api/context/load');
  });

  it('local-first (explicit env): headless primary + save regression', async () => {
    await start({ env: { FF_WEB_HEADLESS_SERP: 'local-first' }, searchOutcome: okOutcome });
    const r = await post(baseUrl, '/local/web/search', { query: 'q', limit: 2 });
    expect(headlessSearches).toBe(1);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.results[0].url).toBe('https://a.example/1');
    expect(cloudCalls.some((c) => c.url.endsWith('/api/context/save'))).toBe(true);
  });

  it('journal dedup: same URL searched twice → save regression fires once', async () => {
    const journalFile = path.join(tmp, 'journal-2.json');
    await start({ env: { FF_WEB_HEADLESS_SERP: 'local-first' }, journalFile, searchOutcome: okOutcome });
    await post(baseUrl, '/local/web/search', { query: 'q', limit: 2 });
    await post(baseUrl, '/local/web/search', { query: 'q', limit: 2 });
    const saves = cloudCalls.filter((c) => c.url.endsWith('/api/context/save'));
    expect(saves).toHaveLength(1);
  });

  it('web_load local-first: local read → load-shaped result + save with raw', async () => {
    const journalFile = path.join(tmp, 'journal-3.json');
    await start({
      env: { FF_WEB_HEADLESS_SERP: 'local-first' },
      journalFile,
      loadOutcome: {
        ok: true,
        url: 'https://a.example/1',
        title: 'A One',
        text: 'full text content here',
        attempts: [{ provider: 'headless', ok: true, ms: 4 }],
      },
    });
    const r = await post(baseUrl, '/local/web/load', { url: 'https://a.example/1' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.mode).toBe('single_url');
    expect(r.body.result).toMatchObject({
      url: 'https://a.example/1',
      title: 'A One',
      hqcc: 'full text content here',
      raw: 'full text content here',
      cached: false,
    });
    expect(r.body.cost).toEqual({ credits: 0, cached: false });
    const save = cloudCalls.find((c) => c.url.endsWith('/api/context/save'));
    expect(save?.body.items[0]).toMatchObject({
      url: 'https://a.example/1',
      hqcc: 'full text content here',
      raw: 'full text content here',
      visibility: 'public',
      meta: { source: 'headless_serp', engine: 'chromium' },
    });
    const j = new SeenJournal(journalFile);
    expect(j.has('https://a.example/1')).toBe(true);
  });

  it('doctor: flags/env shape (mode off → no network probes)', async () => {
    await start({ env: { FF_WEB_HEADLESS_SERP: 'off', FF_WEB_HEADLESS_SERP_GOOGLE: 'true' } });
    const res = await fetch(`${baseUrl}/local/web/doctor`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.flags).toEqual({ serp: 'off', bing: true, google: true, ddg: true, order: ['bing', 'ddg', 'google'] });
    expect(body.chromium).toHaveProperty('available');
    expect(body.engines.bing).toEqual({ probed: false });
    expect(body.cloud).toMatchObject({ wired: true, baseUrl: 'http://cloud.test' });
  });

  it('C8: local-first 与 cloud 路径同构（剥附加字段后 key 集一致）', async () => {
    // cloud 路径（off 模式，固定 payload 与 headless stub 同源）
    await start({});
    cloudResponder = () =>
      new Response(
        JSON.stringify({
          success: true,
          requestId: 'cloud-1',
          mode: 'query',
          results: [
            {
              rank: 1,
              url: 'https://a.example/1',
              title: 'A One',
              hqcc: 'snippet a',
              cached: false,
              cachedAt: null,
              ranking: { score: 0, factors: { searchRank: 1 } },
              meta: { source: 'load_api' },
            },
          ],
          summary: { query: 'q', searched: 1, cacheHits: 0, compressed: 0, returned: 1 },
          cost: { searchCredits: 0, compressionCredits: 0, totalCredits: 0, savedByCache: 0 },
          processingTime: 1,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    const cloudRes = await post(baseUrl, '/local/web/search', { query: 'q', limit: 2 });

    // local 路径（local-first，headless 固定数据）
    await server?.stop();
    await start({ env: { FF_WEB_HEADLESS_SERP: 'local-first' }, searchOutcome: okOutcome });
    const localRes = await post(baseUrl, '/local/web/search', { query: 'q', limit: 2 });

    const strip = (o: any) => {
      const { degraded, providerAttempts, ...rest } = o;
      return rest;
    };
    expect(Object.keys(strip(localRes.body)).sort()).toEqual(Object.keys(strip(cloudRes.body)).sort());
    expect(Object.keys(localRes.body.results[0]).sort()).toEqual(Object.keys(cloudRes.body.results[0]).sort());
    expect(localRes.body.results[0]).toMatchObject({ url: cloudRes.body.results[0].url, cached: false });
  });
});
