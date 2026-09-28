// Phase 8a / M2 — outbox optimistic write + ack remap + echo 对账.
// (docs/desktop202/13-sync-protocol-spec.md §7/§8).

import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { openLocalDb } from '../src/sync/store.js';
import {
  openReadModel,
  getMessageByClientMsgId,
  getTask,
  listMessages,
  upsertMessage,
  upsertTask,
  insertOptimisticMessage,
  remapMessageAck,
  applyOptimisticTask,
  clearTaskDirty,
  setMessageSyncStatus,
} from '../src/daemon/gateway/read-model.js';
import { SyncQueue } from '../src/sync/sync-queue.js';
import { SyncWorker } from '../src/sync/sync-worker.js';
import { LocalRelay, type LocalSyncEvent } from '../src/daemon/gateway/local-relay.js';
import { Materializer } from '../src/daemon/gateway/materializer.js';
import { OutboxWriter, extractServerMessage } from '../src/daemon/gateway/outbox-writer.js';
import { LocalGateway, resolveGatewayConfig } from '../src/daemon/gateway/gateway.js';
import { CloudClient } from '../src/auth.js';

const AUTH = 'sk-prismer-test-token';

class RecordingRelay extends LocalRelay {
  events: LocalSyncEvent[] = [];
  override broadcast(event: LocalSyncEvent): void {
    this.events.push(event);
  }
}

function freshDb() {
  const db = openLocalDb(':memory:');
  openReadModel(db);
  return db;
}

/** CloudClient stub: handler decides status + body per (method, url, init). */
function stubCloud(
  handler: (req: { method: string; url: string; headers: Record<string, string>; body: unknown }) => {
    status: number;
    body: unknown;
  },
) {
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    const h = init?.headers as Record<string, string> | undefined;
    if (h) for (const k of Object.keys(h)) headers[k.toLowerCase()] = h[k]!;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const { status, body: resBody } = handler({ method, url: u, headers, body });
    return new Response(JSON.stringify(resBody), { status, headers: { 'content-type': 'application/json' } });
  });
  return new CloudClient({ baseUrl: 'https://cloud.example', apiKey: AUTH, fetchImpl: fetchImpl as unknown as typeof fetch });
}

function mkOutbox(db: ReturnType<typeof openLocalDb>, cloud: CloudClient, relay = new RecordingRelay()) {
  const queue = new SyncQueue(db);
  const outbox = new OutboxWriter({ db, queue, cloud, relay });
  return { queue, outbox, relay };
}

// ── read-model M2 primitives ───────────────────────────────────────────────

describe('read-model — optimistic message + ack remap (§7)', () => {
  it('inserts an optimistic message (cmsg id, dirty=1, pending)', () => {
    const db = freshDb();
    insertOptimisticMessage(db, { clientMsgId: 'cmsg_a', conversationId: 'c1', payload: { id: 'cmsg_a', text: 'hi' } });
    const row = getMessageByClientMsgId(db, 'cmsg_a')!;
    expect(row.id).toBe('cmsg_a');
    expect(row.client_msg_id).toBe('cmsg_a');
    expect(row.boundary_seq).toBeNull();
    expect(row.sync_status).toBe('pending');
    expect(row.dirty).toBe(1);
  });

  it('insertOptimisticMessage is idempotent on the cmsg (retry no-dup)', () => {
    const db = freshDb();
    insertOptimisticMessage(db, { clientMsgId: 'cmsg_a', conversationId: 'c1', payload: { id: 'cmsg_a' } });
    insertOptimisticMessage(db, { clientMsgId: 'cmsg_a', conversationId: 'c1', payload: { id: 'cmsg_a', x: 2 } });
    expect(listMessages(db, 'c1')).toHaveLength(1);
  });

  it('remapMessageAck rewrites id→serverId + seq, clears dirty, advances watermark', () => {
    const db = freshDb();
    insertOptimisticMessage(db, { clientMsgId: 'cmsg_a', conversationId: 'c1', payload: { id: 'cmsg_a' } });
    const ok = remapMessageAck(db, { clientMsgId: 'cmsg_a', serverId: 'srv1', boundarySeq: 7, payload: { id: 'srv1' } });
    expect(ok).toBe(true);
    const row = getMessageByClientMsgId(db, 'cmsg_a')!; // client_msg_id retained
    expect(row.id).toBe('srv1');
    expect(row.boundary_seq).toBe(7);
    expect(row.sync_status).toBe('synced');
    expect(row.dirty).toBe(0);
    expect(listMessages(db, 'c1').map((r) => r.id)).toEqual(['srv1']);
  });

  it('remapMessageAck is a no-op when the cmsg no longer exists', () => {
    const db = freshDb();
    expect(remapMessageAck(db, { clientMsgId: 'gone', serverId: 'x', boundarySeq: 1 })).toBe(false);
  });
});

describe('read-model — task optimistic + dirty guard (§8 ③)', () => {
  it('applyOptimisticTask marks dirty+pending; cloud upsert does NOT clobber dirty', () => {
    const db = freshDb();
    upsertTask(db, { id: 't1', workspaceId: 'w1', payload: { id: 't1', status: 'todo' }, updatedAt: 1 });
    applyOptimisticTask(db, { id: 't1', workspaceId: 'w1', payload: { id: 't1', status: 'doing' } });
    expect(getTask(db, 't1')!.dirty).toBe(1);
    // a non-echo cloud update arrives → held back (dirty guard)
    upsertTask(db, { id: 't1', workspaceId: 'w1', payload: { id: 't1', status: 'CLOUD' }, updatedAt: 99 });
    expect(JSON.parse(getTask(db, 't1')!.payload_json).status).toBe('doing'); // local kept
  });

  it('clearTaskDirty acks (server-wins回纠) and clears dirty', () => {
    const db = freshDb();
    applyOptimisticTask(db, { id: 't1', workspaceId: 'w1', payload: { id: 't1', status: 'doing' } });
    expect(clearTaskDirty(db, { id: 't1', payload: { id: 't1', status: 'done' }, updatedAt: 5 })).toBe(true);
    const row = getTask(db, 't1')!;
    expect(row.dirty).toBe(0);
    expect(row.sync_status).toBe('synced');
    expect(JSON.parse(row.payload_json).status).toBe('done');
  });

  it('a clean (dirty=0) cloud update still overwrites', () => {
    const db = freshDb();
    upsertTask(db, { id: 't1', workspaceId: 'w1', payload: { id: 't1', v: 1 }, updatedAt: 1 });
    upsertTask(db, { id: 't1', workspaceId: 'w1', payload: { id: 't1', v: 2 }, updatedAt: 2 });
    expect(JSON.parse(getTask(db, 't1')!.payload_json).v).toBe(2);
  });
});

// ── OutboxWriter flush + ack ─────────────────────────────────────────────────

describe('OutboxWriter — message flush + ack remap (§7)', () => {
  it('enqueue → flush → cloud POST carries X-Idempotency-Key + clientMsgId, remaps', async () => {
    const db = freshDb();
    let seenHeader = '';
    let seenBodyKey = '';
    const cloud = stubCloud((req) => {
      seenHeader = req.headers['x-idempotency-key'] ?? '';
      seenBodyKey = (req.body as { clientMsgId?: string })?.clientMsgId ?? '';
      return { status: 201, body: { ok: true, data: { message: { id: 'srv9', boundarySeq: 3, content: 'hi' } } } };
    });
    const { queue, outbox, relay } = mkOutbox(db, cloud);
    const { clientMsgId } = outbox.enqueueMessageSend({ conversationId: 'c1', body: { content: 'hi', type: 'text' } });

    // optimistic row exists immediately
    expect(getMessageByClientMsgId(db, clientMsgId)!.sync_status).toBe('pending');

    const row = queue.dequeueBatch(10)[0]!;
    const result = await outbox.flushRow(row);
    expect(result.ok).toBe(true);
    expect(seenHeader).toBe(clientMsgId);
    expect(seenBodyKey).toBe(clientMsgId);

    const remapped = getMessageByClientMsgId(db, clientMsgId)!;
    expect(remapped.id).toBe('srv9');
    expect(remapped.boundary_seq).toBe(3);
    expect(remapped.dirty).toBe(0);
    expect(remapped.sync_status).toBe('synced');
    // synced echo broadcast so renderer reconciles without waiting for SSE
    expect(relay.events.some((e) => e.type === 'message.new' && e.boundarySeq === 3)).toBe(true);
  });

  it('idempotency key is stable across retries (worker re-flush reuses same cmsg)', async () => {
    const db = freshDb();
    const seenKeys: string[] = [];
    let calls = 0;
    const cloud = stubCloud((req) => {
      seenKeys.push(req.headers['x-idempotency-key'] ?? '');
      calls++;
      if (calls === 1) return { status: 503, body: { error: { code: 'unavailable' } } };
      return { status: 201, body: { ok: true, data: { message: { id: 'srv1', boundarySeq: 1 } } } };
    });
    const { queue, outbox } = mkOutbox(db, cloud);
    const { clientMsgId } = outbox.enqueueMessageSend({ conversationId: 'c1', body: { content: 'x' } });

    const row1 = queue.dequeueBatch(10)[0]!;
    const r1 = await outbox.flushRow(row1);
    expect(r1.ok).toBe(false);
    expect(r1.status).toBe(503);
    // retrying state surfaced
    expect(getMessageByClientMsgId(db, clientMsgId)!.sync_status).toBe('retrying');

    // re-flush the SAME row → same key
    const r2 = await outbox.flushRow(row1);
    expect(r2.ok).toBe(true);
    expect(seenKeys).toEqual([clientMsgId, clientMsgId]);
  });
});

describe('OutboxWriter — failure 三态 (§7)', () => {
  it('5xx/network → retrying (transient)', async () => {
    const db = freshDb();
    const cloud = stubCloud(() => ({ status: 500, body: { error: { code: 'internal' } } }));
    const { queue, outbox } = mkOutbox(db, cloud);
    const { clientMsgId } = outbox.enqueueMessageSend({ conversationId: 'c1', body: {} });
    const row = queue.dequeueBatch(10)[0]!;
    const res = await outbox.flushRow(row);
    expect(res.ok).toBe(false);
    expect(getMessageByClientMsgId(db, clientMsgId)!.sync_status).toBe('retrying');
  });

  it('409 conflict → failed (needs explicit resend)', async () => {
    const db = freshDb();
    const cloud = stubCloud(() => ({ status: 409, body: { error: { code: 'duplicate' } } }));
    const { queue, outbox } = mkOutbox(db, cloud);
    const { clientMsgId } = outbox.enqueueMessageSend({ conversationId: 'c1', body: {} });
    const row = queue.dequeueBatch(10)[0]!;
    const res = await outbox.flushRow(row);
    expect(res.status).toBe(409);
    expect(getMessageByClientMsgId(db, clientMsgId)!.sync_status).toBe('failed');
  });

  it('other 4xx → failed', async () => {
    const db = freshDb();
    const cloud = stubCloud(() => ({ status: 400, body: { error: { code: 'bad' } } }));
    const { queue, outbox } = mkOutbox(db, cloud);
    const { clientMsgId } = outbox.enqueueMessageSend({ conversationId: 'c1', body: {} });
    const row = queue.dequeueBatch(10)[0]!;
    await outbox.flushRow(row);
    expect(getMessageByClientMsgId(db, clientMsgId)!.sync_status).toBe('failed');
  });

  it('failed row resend uses a NEW cmsg key (§15 #4)', async () => {
    const db = freshDb();
    const cloud = stubCloud(() => ({ status: 201, body: { ok: true, data: { message: { id: 's', boundarySeq: 1 } } } }));
    const { outbox } = mkOutbox(db, cloud);
    const first = outbox.enqueueMessageSend({ conversationId: 'c1', body: {} });
    setMessageSyncStatus(db, first.clientMsgId, 'failed');
    const resend = outbox.enqueueMessageSend({ conversationId: 'c1', body: {} });
    expect(resend.clientMsgId).not.toBe(first.clientMsgId);
  });
});

describe('OutboxWriter — task mutation flush (§8 ③)', () => {
  it('PATCH task → optimistic dirty → ack clears dirty server-wins', async () => {
    const db = freshDb();
    upsertTask(db, { id: 't1', workspaceId: 'w1', payload: { id: 't1', status: 'todo' }, updatedAt: 1 });
    const cloud = stubCloud((req) => {
      expect(req.method).toBe('PATCH');
      return { status: 200, body: { ok: true, data: { id: 't1', status: 'doing', updatedAt: 50 } } };
    });
    const { queue, outbox } = mkOutbox(db, cloud);
    outbox.enqueueTaskMutation({
      taskId: 't1',
      workspaceId: 'w1',
      method: 'PATCH',
      path: '/api/im/tasks/t1',
      body: { status: 'doing' },
      optimisticPatch: { status: 'doing' },
    });
    expect(getTask(db, 't1')!.dirty).toBe(1);
    const row = queue.dequeueBatch(10)[0]!;
    const res = await outbox.flushRow(row);
    expect(res.ok).toBe(true);
    const acked = getTask(db, 't1')!;
    expect(acked.dirty).toBe(0);
    expect(JSON.parse(acked.payload_json).status).toBe('doing');
  });

  it('task transient failure → retrying', async () => {
    const db = freshDb();
    upsertTask(db, { id: 't1', workspaceId: 'w1', payload: { id: 't1' }, updatedAt: 1 });
    const cloud = stubCloud(() => ({ status: 502, body: {} }));
    const { queue, outbox } = mkOutbox(db, cloud);
    outbox.enqueueTaskMutation({ taskId: 't1', workspaceId: 'w1', method: 'POST', path: '/api/im/tasks/t1/transition', body: {} });
    const row = queue.dequeueBatch(10)[0]!;
    await outbox.flushRow(row);
    expect(getTask(db, 't1')!.sync_status).toBe('retrying');
  });
});

// ── echo 对账 in the materializer (§8 ②) ─────────────────────────────────────

describe('materializer — echo 对账 (§8 ②)', () => {
  function setup() {
    const db = freshDb();
    const relay = new RecordingRelay();
    const mat = new Materializer({ db, relay, workspaceId: () => 'w1' });
    return { db, relay, mat };
  }

  it('matches a cloud echo by top-level clientMsgId → remaps, no dup row', () => {
    const { db, mat } = setup();
    insertOptimisticMessage(db, { clientMsgId: 'cmsg_e', conversationId: 'c1', payload: { id: 'cmsg_e' } });
    const r = mat.ingest({
      type: 'message.new',
      boundarySeq: 1,
      conversationId: 'c1',
      data: { id: 'srv_e', conversationId: 'c1', boundarySeq: 1, clientMsgId: 'cmsg_e' },
    });
    expect(r.materialized).toBe(true);
    const rows = listMessages(db, 'c1');
    expect(rows).toHaveLength(1); // remapped, not duplicated
    expect(rows[0]!.id).toBe('srv_e');
    expect(rows[0]!.dirty).toBe(0);
    expect(rows[0]!.boundary_seq).toBe(1);
  });

  it('matches a cloud echo carried in metadata._idempotencyKey', () => {
    const { db, mat } = setup();
    insertOptimisticMessage(db, { clientMsgId: 'cmsg_m', conversationId: 'c1', payload: { id: 'cmsg_m' } });
    mat.ingest({
      type: 'message.new',
      boundarySeq: 1,
      conversationId: 'c1',
      data: { id: 'srv_m', conversationId: 'c1', boundarySeq: 1, metadata: { _idempotencyKey: 'cmsg_m' } },
    });
    const rows = listMessages(db, 'c1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('srv_m');
  });

  it('a non-echo message (no matching cmsg) materializes normally', () => {
    const { db, mat } = setup();
    insertOptimisticMessage(db, { clientMsgId: 'cmsg_mine', conversationId: 'c1', payload: { id: 'cmsg_mine' } });
    mat.ingest({
      type: 'message.new',
      boundarySeq: 1,
      conversationId: 'c1',
      data: { id: 'other', conversationId: 'c1', boundarySeq: 1, clientMsgId: 'cmsg_someone_else' },
    });
    const ids = listMessages(db, 'c1').map((r) => r.id);
    expect(ids).toContain('cmsg_mine'); // optimistic still pending
    expect(ids).toContain('other');
  });

  it('already-acked (dirty=0) echo does not re-remap (idempotent)', () => {
    const { db, mat } = setup();
    insertOptimisticMessage(db, { clientMsgId: 'cmsg_x', conversationId: 'c1', payload: { id: 'cmsg_x' } });
    remapMessageAck(db, { clientMsgId: 'cmsg_x', serverId: 'srv_x', boundarySeq: 1 });
    // SSE echo arrives after the ack-path already remapped → treated as normal
    // upsert (dirty=0, id already server) → no duplicate.
    mat.ingest({
      type: 'message.new',
      boundarySeq: 1,
      conversationId: 'c1',
      data: { id: 'srv_x', conversationId: 'c1', boundarySeq: 1, clientMsgId: 'cmsg_x' },
    });
    expect(listMessages(db, 'c1')).toHaveLength(1);
  });
});

// ── gateway HTTP write path ──────────────────────────────────────────────────

function mockRes() {
  let body = '';
  const res = {
    statusCode: 0,
    setHeader: () => {},
    write: (c: string) => { body += c; return true; },
    end: (c?: string) => { if (c) body += c; },
    on: () => res,
  } as unknown as ServerResponse;
  return {
    res,
    get status() { return (res as unknown as { statusCode: number }).statusCode; },
    get json() { return body ? JSON.parse(body) : undefined; },
  };
}

function mockPost(url: string, body: unknown, method = 'POST'): IncomingMessage {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  (stream as unknown as { url: string }).url = url;
  (stream as unknown as { method: string }).method = method;
  (stream as unknown as { headers: Record<string, string> }).headers = { authorization: `Bearer ${AUTH}` };
  return stream;
}

describe('gateway — POST write path (§7)', () => {
  function makeGateway(db: ReturnType<typeof openLocalDb>, cloud: CloudClient, withOutbox = true) {
    const relay = new RecordingRelay();
    const queue = new SyncQueue(db);
    const outbox = new OutboxWriter({ db, queue, cloud, relay });
    const config = resolveGatewayConfig({ enabled: true, domains: ['chats', 'tasks'] });
    const gw = new LocalGateway({ config, db, cloud, relay, authToken: AUTH, outbox: withOutbox ? outbox : undefined });
    return { gw, queue, relay };
  }

  it('POST /api/im/messages/:id → optimistic 201 + enqueues outbox row', async () => {
    const db = freshDb();
    const cloud = stubCloud(() => ({ status: 201, body: { ok: true, data: { message: { id: 's' } } } }));
    const { gw, queue } = makeGateway(db, cloud);
    const m = mockRes();
    const claimed = await gw.handle(mockPost('/api/im/messages/c1', { content: 'hello', type: 'text' }), m.res);
    expect(claimed).toBe(true);
    expect(m.status).toBe(201);
    const cmsg = m.json.data.message.clientMsgId as string;
    expect(cmsg.startsWith('cmsg_')).toBe(true);
    // outbox row enqueued
    expect(queue.dequeueBatch(10)).toHaveLength(1);
    // optimistic rm row present
    expect(getMessageByClientMsgId(db, cmsg)!.sync_status).toBe('pending');
  });

  it('PATCH /api/im/tasks/:id → optimistic 202 + enqueues task_mutation', async () => {
    const db = freshDb();
    upsertTask(db, { id: 't1', workspaceId: 'w1', payload: { id: 't1', status: 'todo' }, updatedAt: 1 });
    const cloud = stubCloud(() => ({ status: 200, body: { ok: true, data: { id: 't1' } } }));
    const { gw, queue } = makeGateway(db, cloud);
    const m = mockRes();
    const claimed = await gw.handle(mockPost('/api/im/tasks/t1', { status: 'doing' }, 'PATCH'), m.res);
    expect(claimed).toBe(true);
    expect(m.status).toBe(202);
    expect(getTask(db, 't1')!.dirty).toBe(1);
    const enq = queue.dequeueBatch(10);
    expect(enq).toHaveLength(1);
    expect(enq[0]!.resource_type).toBe('task_mutation');
  });

  it('without outbox (write capability OFF) → cloud passthrough, no enqueue', async () => {
    const db = freshDb();
    let cloudHit = false;
    const cloud = stubCloud(() => { cloudHit = true; return { status: 201, body: { ok: true, data: { message: { id: 's' } } } }; });
    const { gw, queue } = makeGateway(db, cloud, /* withOutbox */ false);
    const m = mockRes();
    const claimed = await gw.handle(mockPost('/api/im/messages/c1', { content: 'x' }), m.res);
    expect(claimed).toBe(true);
    expect(cloudHit).toBe(true); // passthrough to cloud
    expect(queue.dequeueBatch(10)).toHaveLength(0); // nothing enqueued
    // no optimistic rm row created
    expect(listMessages(db, 'c1')).toHaveLength(0);
  });
});

// ── end-to-end via SyncWorker ────────────────────────────────────────────────

describe('SyncWorker integration — drains gateway outbox rows', () => {
  it('worker tick flushes an im_message row and acks it', async () => {
    const db = freshDb();
    const cloud = stubCloud(() => ({ status: 201, body: { ok: true, data: { message: { id: 'srvW', boundarySeq: 4 } } } }));
    const { queue, outbox } = mkOutbox(db, cloud);
    const { clientMsgId } = outbox.enqueueMessageSend({ conversationId: 'c1', body: { content: 'q' } });
    const worker = new SyncWorker({ queue, flush: (row) => outbox.flushRow(row) });
    await worker.tick();
    expect(queue.pendingCount()).toBe(0); // completed + removed
    expect(getMessageByClientMsgId(db, clientMsgId)!.id).toBe('srvW');
  });
});

describe('extractServerMessage', () => {
  it('unwraps {ok,data:{message}}', () => {
    expect(extractServerMessage({ ok: true, data: { message: { id: 'a', boundarySeq: 2 } } })).toEqual({
      id: 'a',
      boundarySeq: 2,
      raw: { id: 'a', boundarySeq: 2 },
    });
  });
  it('unwraps bare message', () => {
    expect(extractServerMessage({ id: 'b' })).toMatchObject({ id: 'b', boundarySeq: null });
  });
  it('returns null without an id', () => {
    expect(extractServerMessage({ data: {} })).toBeNull();
  });
});
