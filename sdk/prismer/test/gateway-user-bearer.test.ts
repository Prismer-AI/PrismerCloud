/**
 * desktop205 (2026-08-31) — gateway user-Bearer acceptance + passthrough
 * header forwarding.
 *
 * The desktop renderer authenticates with the USER session JWT (or sk-prismer
 * key), not the daemon's api key; before this seam was closed the whole local
 * data plane 401'd for every renderer request. Coverage here:
 *   + user Bearer introspected OK (cloud /api/im/me 200) → request served;
 *   + introspection result is CACHED (no cloud roundtrip per request);
 *   + negative: introspection 401 → gateway 401 (and negative TTL is short —
 *     a later success is not locked out);
 *   + daemon key fast path still passes without any introspection call;
 *   + passthrough GET forwards X-IM-Workspace / X-Request-Id to the cloud
 *     (audit C: losing the workspace header made multi-workspace members read
 *     the default workspace's data through the loopback base).
 */
import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { openLocalDb } from '../src/sync/store.js';
import { openReadModel } from '../src/daemon/gateway/read-model.js';
import { LocalGateway, resolveGatewayConfig } from '../src/daemon/gateway/gateway.js';
import { CloudClient } from '../src/auth.js';

const AUTH = 'sk-daemon-key';
// Unique per test: the introspection cache is module-level, so a shared bearer
// would leak a verdict across tests (exactly what the cache is FOR).
function userBearer(name: string): string {
  return `eyJ.${name}.jwt`;
}

function freshDb() {
  const db = openLocalDb(':memory:');
  openReadModel(db);
  return db;
}

type CloudCall = { method: string; url: string; headers: Record<string, string> };

/**
 * Cloud stub that records every call. /api/im/me answers from a queue so a
 * test can flip the introspection verdict; anything else answers 200 {ok:true}
 * so passthrough succeeds and its headers are observable.
 */
function recordingCloud(meStatuses: number[] = [200], meUserFor?: (bearer: string) => string) {
  const calls: CloudCall[] = [];
  let meIndex = 0;
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    const h = init?.headers as Record<string, string> | undefined;
    if (h) for (const k of Object.keys(h)) headers[k.toLowerCase()] = h[k]!;
    calls.push({ method, url: u, headers });
    if (u.endsWith('/api/im/me')) {
      const status = meStatuses[Math.min(meIndex, meStatuses.length - 1)] ?? 200;
      meIndex += 1;
      const bearer = headers['authorization']?.replace(/^Bearer /, '') ?? '';
      const userId = meUserFor ? meUserFor(bearer) : 'u-owner';
      return new Response(JSON.stringify({ ok: status < 400, data: { user: { id: userId } } }), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true, data: { passed: true } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  const cloud = new CloudClient({
    baseUrl: 'https://cloud.example',
    apiKey: AUTH,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return { cloud, calls };
}

function mockGet(url: string, bearer: string, extraHeaders: Record<string, string> = {}): IncomingMessage {
  const stream = Readable.from([]) as unknown as IncomingMessage;
  (stream as unknown as { url: string }).url = url;
  (stream as unknown as { method: string }).method = 'GET';
  (stream as unknown as { headers: Record<string, string> }).headers = {
    authorization: `Bearer ${bearer}`,
    ...extraHeaders,
  };
  return stream;
}

function mockRes() {
  let body = '';
  const res = {
    statusCode: 0,
    setHeader: () => {},
    write: (c: string) => {
      body += c;
      return true;
    },
    end: (c?: string) => {
      if (c) body += c;
    },
    on: () => res,
  } as unknown as ServerResponse;
  return {
    res,
    get status() {
      return (res as unknown as { statusCode: number }).statusCode;
    },
    get json() {
      return body ? JSON.parse(body) : undefined;
    },
  };
}

function makeGateway(cloud: CloudClient, opts?: { workspaceId?: () => string | null }) {
  const config = resolveGatewayConfig({ enabled: true, domains: ['chats'] });
  const relay = { deliver: () => {}, drain: () => Promise.resolve() } as never;
  return new LocalGateway({
    config,
    db: freshDb(),
    cloud,
    relay,
    authToken: AUTH,
    workspaceId: opts?.workspaceId,
  });
}

describe('gateway — desktop user-Bearer seam (desktop205 auth fix)', () => {
  it('serves a request whose Bearer is a cloud-verified user credential', async () => {
    const { cloud, calls } = recordingCloud([200]);
    const gw = makeGateway(cloud);
    const m = mockRes();
    const claimed = await gw.handle(
      mockGet('/api/im/agents?limit=5', userBearer('serve'), { 'x-im-workspace': 'ws-42' }),
      m.res,
    );
    expect(claimed).toBe(true);
    expect(m.status).toBe(200);
    // introspection happened exactly once with the USER bearer, plus exactly
    // one OWNER resolution with the daemon key (both under /api/im/me).
    const me = calls.filter((c) => c.url.endsWith('/api/im/me'));
    const userProbes = me.filter((c) => c.headers['authorization'] === `Bearer ${userBearer('serve')}`);
    const ownerProbes = me.filter((c) => c.headers['authorization'] === `Bearer ${AUTH}`);
    expect(userProbes).toHaveLength(1);
    expect(ownerProbes).toHaveLength(1);
    // audit C — the passthrough call forwarded the workspace header.
    const passthrough = calls.find((c) => c.url.includes('/api/im/agents'));
    expect(passthrough?.headers['x-im-workspace']).toBe('ws-42');
  });

  it('caches the introspection verdict — second request makes no /api/im/me call', async () => {
    const { cloud, calls } = recordingCloud([200]);
    const gw = makeGateway(cloud);
    const b = userBearer('cache');
    await gw.handle(mockGet('/api/im/agents', b), mockRes().res);
    await gw.handle(mockGet('/api/im/agents', b), mockRes().res);
    // user-bearer introspection only once; the owner resolution is also cached
    // (process-lifetime) so the daemon-key /me also fires only once.
    expect(calls.filter((c) => c.url.endsWith('/api/im/me'))).toHaveLength(2);
  });

  it('rejects a Bearer the cloud rejects (401); a FRESH login token is not locked out', async () => {
    // Re-login mints a NEW JWT — a different bearer string, hence a cache miss.
    // (The same rejected bearer intentionally stays cached for the short
    // negative TTL: hammering the cloud per-retry is what the cache prevents.)
    const { cloud } = recordingCloud([401, 200]);
    const gw = makeGateway(cloud);
    const bad = mockRes();
    await gw.handle(mockGet('/api/im/agents', userBearer('stale-login')), bad.res);
    expect(bad.status).toBe(401);
    const good = mockRes();
    await gw.handle(mockGet('/api/im/agents', userBearer('fresh-login')), good.res);
    expect(good.status).toBe(200);
  });

  it('SWR conversations revalidation is scoped to the declared workspace', async () => {
    // desktop205 — an unscoped daemon-key fetch returns the DEFAULT workspace's
    // list; the gateway must ask for the daemon's declared workspace instead.
    const { cloud, calls } = recordingCloud([200]);
    const gw = makeGateway(cloud, { workspaceId: () => 'ws-declared' });
    const conv = mockRes();
    await gw.handle(mockGet('/api/im/conversations', userBearer('swr')), conv.res);
    const convCall = calls.find((c) => c.url.includes('/api/im/conversations'));
    expect(convCall).toBeTruthy();
    expect(convCall!.url).toContain('workspaceId=ws-declared');
  });

  it('review hardening: a VALID cloud token of a DIFFERENT user is refused (owner binding)', async () => {
    // The daemon key resolves to u-owner; a stranger's perfectly-valid token
    // (u-stranger) must NOT pass introspection — originally any valid account
    // token could read the owner's SWR cache from any same-machine page.
    const { cloud } = recordingCloud([200, 200], (bearer) => (bearer === AUTH ? 'u-owner' : 'u-stranger'));
    const gw = makeGateway(cloud);
    const m = mockRes();
    await gw.handle(mockGet('/api/im/agents', userBearer('stranger-valid-token')), m.res);
    expect(m.status).toBe(401);
  });

  it('review hardening: the OWNER user token still passes (and the cache never stores raw tokens)', async () => {
    const { cloud, calls } = recordingCloud([200, 200], (bearer) => (bearer === AUTH ? 'u-owner' : 'u-owner'));
    const gw = makeGateway(cloud);
    const m = mockRes();
    await gw.handle(mockGet('/api/im/agents', userBearer('owner-token')), m.res);
    expect(m.status).toBe(200);
    // every recorded /me call carried a Bearer (owner resolution uses the daemon key)
    for (const c of calls.filter((x) => x.url.endsWith('/api/im/me'))) {
      expect(c.headers['authorization']).toMatch(/^Bearer /);
    }
  });

  it('daemon key fast path: no introspection roundtrip, request served', async () => {
    const { cloud, calls } = recordingCloud([200]);
    const gw = makeGateway(cloud);
    const m = mockRes();
    await gw.handle(mockGet('/api/im/agents', AUTH), m.res);
    expect(m.status).toBe(200);
    expect(calls.filter((c) => c.url.endsWith('/api/im/me'))).toHaveLength(0);
  });

  it('no Bearer at all → 401 without touching the cloud', async () => {
    const { cloud, calls } = recordingCloud([200]);
    const gw = makeGateway(cloud);
    const m = mockRes();
    await gw.handle(mockGet('/api/im/agents', ''), m.res);
    expect(m.status).toBe(401);
    expect(calls).toHaveLength(0);
  });
});
