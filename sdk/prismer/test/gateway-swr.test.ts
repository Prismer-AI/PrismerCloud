import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { openLocalDb } from '../src/sync/store.js';
import { openReadModel, listConversations, upsertConversation, advanceWatermark, touchWatermark } from '../src/daemon/gateway/read-model.js';
import { LocalRelay } from '../src/daemon/gateway/local-relay.js';
import { LocalGateway, resolveGatewayConfig } from '../src/daemon/gateway/gateway.js';
import { CloudClient } from '../src/auth.js';

const AUTH = 'sk-prismer-test-token';

function mockRes() {
  const headers: Record<string, string> = {};
  let body = '';
  let status = 0;
  const res = {
    statusCode: 0,
    setHeader: (k: string, v: string) => {
      headers[k.toLowerCase()] = v;
    },
    write: (chunk: string) => {
      body += chunk;
      return true;
    },
    end: (chunk?: string) => {
      if (chunk) body += chunk;
      status = (res as unknown as { statusCode: number }).statusCode;
    },
    on: () => res,
  } as unknown as ServerResponse;
  return {
    res,
    get status() {
      return status || (res as unknown as { statusCode: number }).statusCode;
    },
    get json() {
      return body ? JSON.parse(body) : undefined;
    },
    get raw() {
      return body;
    },
  };
}

function mockReq(url: string, auth = AUTH): IncomingMessage {
  return {
    url,
    method: 'GET',
    headers: auth ? { authorization: `Bearer ${auth}` } : {},
  } as unknown as IncomingMessage;
}

/** A CloudClient with a stub fetch returning the given JSON. */
function stubCloud(handler: (url: string) => { status: number; body: unknown }) {
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    const { status, body } = handler(u);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  return new CloudClient({ baseUrl: 'https://cloud.example', apiKey: AUTH, fetchImpl: fetchImpl as unknown as typeof fetch });
}

function makeGateway(opts: {
  db: ReturnType<typeof openLocalDb>;
  cloud: CloudClient;
  domains?: Array<'chats' | 'tasks'>;
}) {
  const relay = new LocalRelay();
  const config = resolveGatewayConfig({ enabled: true, domains: opts.domains ?? ['chats', 'tasks'] });
  return new LocalGateway({ config, db: opts.db, cloud: opts.cloud, relay, authToken: AUTH });
}

function freshDb() {
  const db = openLocalDb(':memory:');
  openReadModel(db);
  return db;
}

describe('gateway — capability + auth', () => {
  it('disabled gateway never claims requests', async () => {
    const db = freshDb();
    const relay = new LocalRelay();
    const config = resolveGatewayConfig({ enabled: false });
    const gw = new LocalGateway({ config, db, cloud: stubCloud(() => ({ status: 200, body: {} })), relay, authToken: AUTH });
    const m = mockRes();
    expect(await gw.handle(mockReq('/api/im/conversations'), m.res)).toBe(false);
  });

  it('rejects missing/invalid Bearer with 401', async () => {
    const db = freshDb();
    const gw = makeGateway({ db, cloud: stubCloud(() => ({ status: 200, body: { ok: true, data: [] } })) });
    const m = mockRes();
    const claimed = await gw.handle(mockReq('/api/im/conversations', ''), m.res);
    expect(claimed).toBe(true);
    expect(m.status).toBe(401);
  });

  it('only claims GET /api/im/* (non-im GET falls through)', async () => {
    const db = freshDb();
    const gw = makeGateway({ db, cloud: stubCloud(() => ({ status: 200, body: {} })) });
    const m = mockRes();
    expect(await gw.handle(mockReq('/healthz'), m.res)).toBe(false);
  });

  it('a disabled domain falls through to passthrough (still claimed)', async () => {
    const db = freshDb();
    const cloud = stubCloud(() => ({ status: 200, body: { ok: true, data: [{ id: 't1' }] } }));
    const gw = makeGateway({ db, cloud, domains: ['chats'] }); // tasks NOT enabled
    const m = mockRes();
    // /api/im/tasks not in enabled domains → passthrough branch
    const claimed = await gw.handle(mockReq('/api/im/tasks?workspaceId=w1'), m.res);
    expect(claimed).toBe(true);
    expect(m.status).toBe(200);
  });
});

describe('gateway — SWR conversations', () => {
  it('miss → cloud passthrough + backfill rm_*', async () => {
    const db = freshDb();
    const cloud = stubCloud(() => ({ status: 200, body: { ok: true, data: [{ id: 'c1', updatedAt: 5 }, { id: 'c2', updatedAt: 9 }] } }));
    const gw = makeGateway({ db, cloud });
    const m = mockRes();
    await gw.handle(mockReq('/api/im/conversations'), m.res);
    expect(m.status).toBe(200);
    expect(m.json.data).toHaveLength(2);
    // backfilled into rm_conversations
    expect(listConversations(db).map((r) => r.id).sort()).toEqual(['c1', 'c2']);
  });

  it('fresh → returns cache without hitting cloud', async () => {
    const db = freshDb();
    upsertConversation(db, { id: 'cached', payload: { id: 'cached' }, updatedAt: 1 });
    advanceWatermark(db, 'chats', '', 1); // fresh now
    const cloud = stubCloud(() => {
      throw new Error('cloud should not be called on fresh hit');
    });
    const gw = makeGateway({ db, cloud });
    const m = mockRes();
    await gw.handle(mockReq('/api/im/conversations'), m.res);
    expect(m.status).toBe(200);
    expect(m.json.data[0].id).toBe('cached');
  });

  it('stale → serves cache immediately + revalidates in background', async () => {
    const db = freshDb();
    upsertConversation(db, { id: 'old', payload: { id: 'old' }, updatedAt: 1, syncedAt: 1 });
    touchWatermark(db, 'chats', '', 1); // synced_at=1 → stale vs now
    let cloudCalls = 0;
    const cloud = stubCloud(() => {
      cloudCalls++;
      return { status: 200, body: { ok: true, data: [{ id: 'fresh1' }] } };
    });
    const gw = makeGateway({ db, cloud });
    const m = mockRes();
    await gw.handle(mockReq('/api/im/conversations'), m.res);
    // served stale cache right away
    expect(m.json.data[0].id).toBe('old');
    // background revalidate fires
    await new Promise((r) => setTimeout(r, 20));
    expect(cloudCalls).toBe(1);
    expect(listConversations(db).some((r) => r.id === 'fresh1')).toBe(true);
  });

  it('miss + cloud unreachable → 502', async () => {
    const db = freshDb();
    const cloud = stubCloud(() => ({ status: 500, body: { error: { code: 'internal_error' } } }));
    const gw = makeGateway({ db, cloud });
    const m = mockRes();
    await gw.handle(mockReq('/api/im/conversations'), m.res);
    expect(m.status).toBe(502);
  });
});

describe('gateway — SWR messages + SSE mirror', () => {
  it('requires conversationId on /api/im/messages', async () => {
    const db = freshDb();
    const gw = makeGateway({ db, cloud: stubCloud(() => ({ status: 200, body: {} })) });
    const m = mockRes();
    await gw.handle(mockReq('/api/im/messages'), m.res);
    expect(m.status).toBe(400);
  });

  it('miss → passthrough + backfills rm_messages with boundarySeq', async () => {
    const db = freshDb();
    const cloud = stubCloud(() => ({
      status: 200,
      body: { ok: true, data: [{ id: 'm1', boundarySeq: 1 }, { id: 'm2', boundarySeq: 2 }] },
    }));
    const gw = makeGateway({ db, cloud });
    const m = mockRes();
    await gw.handle(mockReq('/api/im/messages?conversationId=c1'), m.res);
    expect(m.status).toBe(200);
    const { listMessages } = await import('../src/daemon/gateway/read-model.js');
    const rows = listMessages(db, 'c1');
    expect(rows.map((r) => r.boundary_seq)).toEqual([1, 2]);
  });

  it('GET /api/im/sync/stream opens an SSE stream + registers a subscriber', async () => {
    const db = freshDb();
    const relay = new LocalRelay();
    const config = resolveGatewayConfig({ enabled: true });
    const gw = new LocalGateway({ config, db, cloud: stubCloud(() => ({ status: 200, body: {} })), relay, authToken: AUTH });
    const m = mockRes();
    const claimed = await gw.handle(mockReq('/api/im/sync/stream'), m.res);
    expect(claimed).toBe(true);
    expect(relay.subscriberCount).toBe(1);
    expect(m.raw).toContain('event: caught_up');
  });
});

describe('gateway — config resolution', () => {
  it('defaults to OFF + chats domain', () => {
    const c = resolveGatewayConfig({});
    expect(c.enabled).toBe(false);
    expect([...c.domains]).toEqual(['chats']);
  });

  it('env PRISMER_LOCAL_GATEWAY=1 enables', () => {
    const prev = process.env.PRISMER_LOCAL_GATEWAY;
    process.env.PRISMER_LOCAL_GATEWAY = '1';
    try {
      expect(resolveGatewayConfig({}).enabled).toBe(true);
    } finally {
      if (prev == null) delete process.env.PRISMER_LOCAL_GATEWAY;
      else process.env.PRISMER_LOCAL_GATEWAY = prev;
    }
  });

  it('explicit option overrides env + filters unknown domains', () => {
    const c = resolveGatewayConfig({ enabled: true, domains: ['chats', 'tasks', 'bogus'] });
    expect(c.enabled).toBe(true);
    expect([...c.domains].sort()).toEqual(['chats', 'tasks']);
  });
});
