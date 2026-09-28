// Phase 8b / M3 — offline mode (docs/desktop202/11 §2 M3, 13 §6/§9).
// Covers: online-state aggregation (online/degraded/offline + recovery edge),
// offline reads (stale + X-Data-Stale, miss → 503 offline_unavailable),
// offline writes (enqueue while offline), recovery flush trigger.

import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { openLocalDb } from '../src/sync/store.js';
import {
  openReadModel,
  upsertConversation,
  touchWatermark,
} from '../src/daemon/gateway/read-model.js';
import { LocalRelay } from '../src/daemon/gateway/local-relay.js';
import { LocalGateway, resolveGatewayConfig } from '../src/daemon/gateway/gateway.js';
import { OnlineStateTracker } from '../src/daemon/gateway/online-state.js';
import { OutboxWriter } from '../src/daemon/gateway/outbox-writer.js';
import { SyncQueue } from '../src/sync/sync-queue.js';
import { CloudClient } from '../src/auth.js';

const AUTH = 'sk-prismer-test-token';

function mockRes() {
  const headers: Record<string, string> = {};
  let body = '';
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
    },
    on: () => res,
  } as unknown as ServerResponse;
  return {
    res,
    headers,
    get status() {
      return (res as unknown as { statusCode: number }).statusCode;
    },
    get json() {
      return body ? JSON.parse(body) : undefined;
    },
  };
}

function mockReq(url: string, method = 'GET', body?: unknown): IncomingMessage {
  const listeners: Record<string, Array<(arg?: unknown) => void>> = {};
  const req = {
    url,
    method,
    headers: { authorization: `Bearer ${AUTH}` },
    on(event: string, cb: (arg?: unknown) => void) {
      (listeners[event] ??= []).push(cb);
      // Drive the readable lifecycle synchronously on the next microtask so
      // readJsonBody (data → end) resolves.
      if (event === 'end') {
        queueMicrotask(() => {
          if (body !== undefined) {
            for (const fn of listeners['data'] ?? []) fn(Buffer.from(JSON.stringify(body)));
          }
          for (const fn of listeners['end'] ?? []) fn();
        });
      }
      return req;
    },
  } as unknown as IncomingMessage;
  return req;
}

/** CloudClient that always fails transport (status 0 = cloud unreachable). */
function unreachableCloud() {
  const fetchImpl = vi.fn(async () => {
    throw new Error('ECONNREFUSED');
  });
  return new CloudClient({ baseUrl: 'https://cloud.example', apiKey: AUTH, fetchImpl: fetchImpl as unknown as typeof fetch });
}

function okCloud(body: unknown = { ok: true, data: [] }) {
  const fetchImpl = vi.fn(async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
  );
  return new CloudClient({ baseUrl: 'https://cloud.example', apiKey: AUTH, fetchImpl: fetchImpl as unknown as typeof fetch });
}

function freshDb() {
  const db = openLocalDb(':memory:');
  openReadModel(db);
  return db;
}

// ── online-state aggregation ────────────────────────────────────────────────

describe('OnlineStateTracker — aggregation', () => {
  it('cold boot = degraded (SSE not yet connected)', () => {
    const t = new OnlineStateTracker();
    expect(t.state).toBe('degraded');
    expect(t.cloudReachable).toBe(true); // degraded still REST-reachable
  });

  it('SSE connected → online', () => {
    const t = new OnlineStateTracker();
    t.onSseConnected();
    expect(t.state).toBe('online');
    expect(t.cloudReachable).toBe(true);
  });

  it('SSE down + 2 consecutive revalidate failures → offline', () => {
    const t = new OnlineStateTracker();
    t.onSseConnected();
    t.onSseDisconnected();
    expect(t.state).toBe('degraded'); // single drop, no failures yet
    t.onRevalidateFailure();
    expect(t.state).toBe('degraded'); // one failure debounced
    t.onRevalidateFailure();
    expect(t.state).toBe('offline');
    expect(t.cloudReachable).toBe(false);
  });

  it('SSE down but revalidate still succeeds → degraded (not offline)', () => {
    const t = new OnlineStateTracker();
    t.onSseConnected();
    t.onSseDisconnected();
    t.onRevalidateFailure();
    t.onRevalidateSuccess(); // REST proven reachable
    t.onRevalidateFailure(); // a later failure
    expect(t.state).toBe('degraded'); // success since drop keeps us degraded
  });

  it('recovery: offline → online fires onRecover (edge-triggered per transition)', () => {
    const onRecover = vi.fn();
    const t = new OnlineStateTracker({ onRecover });
    t.onSseConnected(); // cold-boot degraded → online: recovery edge #1
    expect(onRecover).toHaveBeenCalledTimes(1);
    t.onSseDisconnected();
    t.onRevalidateFailure();
    t.onRevalidateFailure();
    expect(t.state).toBe('offline');
    t.onSseConnected(); // offline → online: recovery edge #2
    expect(t.state).toBe('online');
    expect(onRecover).toHaveBeenCalledTimes(2);
  });

  it('does not re-fire onRecover on repeated online signals (no transition)', () => {
    const onRecover = vi.fn();
    const t = new OnlineStateTracker({ onRecover });
    t.onSseConnected(); // degraded → online (1)
    t.onSseConnected(); // online → online: no transition, no fire
    expect(onRecover).toHaveBeenCalledTimes(1);
  });
});

// ── offline reads ───────────────────────────────────────────────────────────

function makeGateway(opts: {
  db: ReturnType<typeof openLocalDb>;
  cloud: CloudClient;
  online?: OnlineStateTracker;
  outbox?: OutboxWriter;
}) {
  const relay = new LocalRelay();
  const config = resolveGatewayConfig({ enabled: true, domains: ['chats', 'tasks'] });
  return new LocalGateway({
    config,
    db: opts.db,
    cloud: opts.cloud,
    relay,
    authToken: AUTH,
    online: opts.online,
    outbox: opts.outbox,
  });
}

describe('gateway — M3 offline reads', () => {
  it('stale cache + offline → serves stale rows with X-Data-Stale header', async () => {
    const db = freshDb();
    upsertConversation(db, { id: 'cached', payload: { id: 'cached' }, updatedAt: 1, syncedAt: 1 });
    touchWatermark(db, 'chats', '', 1); // stale vs now
    const online = new OnlineStateTracker();
    online.onSseConnected();
    online.onSseDisconnected();
    online.onRevalidateFailure();
    online.onRevalidateFailure(); // → offline
    expect(online.state).toBe('offline');

    const gw = makeGateway({ db, cloud: unreachableCloud(), online });
    const m = mockRes();
    await gw.handle(mockReq('/api/im/conversations'), m.res);
    expect(m.status).toBe(200);
    expect(m.json.data[0].id).toBe('cached');
    expect(m.headers['x-data-stale']).toBe('true');
    expect(m.json.stale).toBe(true);
  });

  it('miss + offline → 503 offline_unavailable (not a hang / not 502)', async () => {
    const db = freshDb();
    const online = new OnlineStateTracker();
    online.onSseConnected();
    online.onSseDisconnected();
    online.onRevalidateFailure();
    online.onRevalidateFailure(); // → offline
    const gw = makeGateway({ db, cloud: unreachableCloud(), online });
    const m = mockRes();
    await gw.handle(mockReq('/api/im/conversations'), m.res);
    expect(m.status).toBe(503);
    expect(m.json.error.code).toBe('offline_unavailable');
    expect(m.headers['x-data-stale']).toBe('true');
  });

  it('miss + unreachable WITHOUT online tracker → 502 (M1/M2 unchanged)', async () => {
    const db = freshDb();
    const gw = makeGateway({ db, cloud: unreachableCloud() }); // no online
    const m = mockRes();
    await gw.handle(mockReq('/api/im/conversations'), m.res);
    expect(m.status).toBe(502);
    expect(m.json.error.code).toBe('cloud_unreachable');
  });

  it('SWR revalidate failure feeds online tracker → offline', async () => {
    const db = freshDb();
    upsertConversation(db, { id: 'c', payload: { id: 'c' }, updatedAt: 1, syncedAt: 1 });
    touchWatermark(db, 'chats', '', 1); // stale → triggers background revalidate
    const online = new OnlineStateTracker();
    online.onSseDisconnected(); // not connected
    const gw = makeGateway({ db, cloud: unreachableCloud(), online });
    // two stale reads → two failed revalidates → offline
    await gw.handle(mockReq('/api/im/conversations'), mockRes().res);
    await new Promise((r) => setTimeout(r, 10));
    await gw.handle(mockReq('/api/im/conversations'), mockRes().res);
    await new Promise((r) => setTimeout(r, 10));
    expect(online.state).toBe('offline');
  });

  it('online stale read does NOT set X-Data-Stale', async () => {
    const db = freshDb();
    upsertConversation(db, { id: 'c', payload: { id: 'c' }, updatedAt: 1, syncedAt: 1 });
    touchWatermark(db, 'chats', '', 1);
    const online = new OnlineStateTracker();
    online.onSseConnected(); // online
    const gw = makeGateway({ db, cloud: okCloud({ ok: true, data: [{ id: 'c' }] }), online });
    const m = mockRes();
    await gw.handle(mockReq('/api/im/conversations'), m.res);
    expect(m.status).toBe(200);
    expect(m.headers['x-data-stale']).toBeUndefined();
  });
});

// ── offline writes + recovery flush ─────────────────────────────────────────

describe('gateway — M3 offline writes enqueue + recovery flush', () => {
  it('offline POST message returns optimistic 201 + enqueues (does not block)', async () => {
    const db = freshDb();
    const queue = new SyncQueue(db);
    const relay = new LocalRelay();
    const outbox = new OutboxWriter({ db, queue, cloud: unreachableCloud(), relay });
    const online = new OnlineStateTracker();
    online.onSseDisconnected();
    online.onRevalidateFailure();
    online.onRevalidateFailure(); // offline
    const gw = makeGateway({ db, cloud: unreachableCloud(), online, outbox });

    const m = mockRes();
    const claimed = await gw.handle(mockReq('/api/im/messages/c1', 'POST', { content: 'hi' }), m.res);
    expect(claimed).toBe(true);
    expect(m.status).toBe(201); // optimistic, immediate
    expect(m.json.data.message._optimistic).toBe(true);
    // enqueued for later flush
    expect(queue.pendingCountByType(['im_message'])).toBe(1);
  });

  it('recovery onRecover → kickPending makes backed-off rows eligible + flush', async () => {
    const db = freshDb();
    const queue = new SyncQueue(db);
    // enqueue a row already in a future backoff window (simulate prior failure)
    const future = Date.now() + 60_000;
    queue.enqueue({ resourceType: 'im_message', resourceId: 'cmsg_x', operation: 'create', payload: { kind: 'im_message' }, runAt: future });
    expect(queue.dequeueBatch(10).length).toBe(0); // not eligible yet

    let recovered = false;
    const online = new OnlineStateTracker({
      onRecover: () => {
        queue.kickPending();
        recovered = true;
      },
    });
    // drive offline → online
    online.onSseDisconnected();
    online.onRevalidateFailure();
    online.onRevalidateFailure();
    expect(online.state).toBe('offline');
    online.onSseConnected();
    expect(recovered).toBe(true);
    // kickPending reset next_attempt_at → now eligible
    expect(queue.dequeueBatch(10).length).toBe(1);
  });

  it('oldestPendingAge + pendingCountByType reflect queued writes', () => {
    const db = freshDb();
    const queue = new SyncQueue(db);
    expect(queue.oldestPendingAge(['im_message'])).toBeNull();
    queue.enqueue({ resourceType: 'im_message', resourceId: 'a', operation: 'create', payload: {}, runAt: Date.now() - 5_000 });
    queue.enqueue({ resourceType: 'task_mutation', resourceId: 'b', operation: 'update', payload: {}, runAt: Date.now() });
    expect(queue.pendingCountByType(['im_message', 'task_mutation'])).toBe(2);
    expect(queue.pendingCountByType(['im_message'])).toBe(1);
    const age = queue.oldestPendingAge(['im_message', 'task_mutation']);
    expect(age).toBeGreaterThanOrEqual(5_000);
  });
});

// ── SSE subscriber connection-state callbacks ───────────────────────────────

describe('SseSubscriber — M3 connection-state callbacks', () => {
  it('onConnected fires on successful connect; onDisconnected on EOF', async () => {
    const { SseSubscriber } = await import('../src/daemon/gateway/sse-subscriber.js');
    const { Materializer } = await import('../src/daemon/gateway/materializer.js');
    const db = freshDb();
    const relay = new LocalRelay();
    const mat = new Materializer({ db, relay, workspaceId: () => 'w1' });
    const onConnected = vi.fn();
    const onDisconnected = vi.fn();

    // First connect streams one frame then EOF; second connect we abort via stop.
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      const enc = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(': connected\n\n'));
          c.close(); // immediate EOF
        },
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    });

    const sub = new SseSubscriber({
      cloudBase: 'https://cloud.example',
      apiKey: AUTH,
      materializer: mat,
      db,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      backoffMinMs: 5,
      backoffMaxMs: 5,
      log: () => undefined,
      onConnected,
      onDisconnected,
    });
    sub.start();
    // let it connect + EOF at least once
    for (let i = 0; i < 50 && onDisconnected.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    sub.stop();
    expect(onConnected).toHaveBeenCalled();
    expect(onDisconnected).toHaveBeenCalled();
  });
});
