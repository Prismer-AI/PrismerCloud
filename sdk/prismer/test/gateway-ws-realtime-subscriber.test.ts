import { describe, expect, it } from 'vitest';
import { openLocalDb } from '../src/sync/store.js';
import {
  openReadModel,
  getWatermark,
  listMessages,
  listConversations,
} from '../src/daemon/gateway/read-model.js';
import { LocalRelay, type LocalSyncEvent } from '../src/daemon/gateway/local-relay.js';
import { Materializer } from '../src/daemon/gateway/materializer.js';
import {
  WsRealtimeSubscriber,
  type RealtimeSocketLike,
} from '../src/daemon/gateway/ws-realtime-subscriber.js';

/** Records relay broadcasts instead of writing sockets. */
class RecordingRelay extends LocalRelay {
  events: LocalSyncEvent[] = [];
  override broadcast(e: LocalSyncEvent): void {
    this.events.push(e);
  }
  override broadcastReset(): void {
    /* ignore */
  }
}

/** Fake `/ws/realtime` socket the test drives directly (no real network). */
class FakeSocket implements RealtimeSocketLike {
  static instances: FakeSocket[] = [];
  url: string;
  private handlers = new Map<string, (arg?: unknown) => void>();
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }
  on(event: string, cb: (arg?: unknown) => void): void {
    this.handlers.set(event, cb as (arg?: unknown) => void);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.handlers.get('close')?.(1000);
  }
  // ── test drivers ──
  fireOpen(): void {
    this.handlers.get('open')?.();
  }
  frame(obj: unknown): void {
    this.handlers.get('message')?.(JSON.stringify(obj));
  }
  end(): void {
    this.close();
  }
}

function setup() {
  const db = openLocalDb(':memory:');
  openReadModel(db);
  const relay = new RecordingRelay();
  const mat = new Materializer({ db, relay, workspaceId: () => 'w1' });
  return { db, relay, mat };
}

async function until(cond: () => boolean, tries = 300): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (cond()) return;
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error('condition not met');
}

function makeFactory() {
  FakeSocket.instances = [];
  const urls: string[] = [];
  const factory = (url: string): RealtimeSocketLike => {
    urls.push(url);
    return new FakeSocket(url);
  };
  return { factory, urls };
}

describe('WsRealtimeSubscriber — feeds materializer from the unified /ws/realtime', () => {
  it('demuxes ch:sync frames → rm_* materialized + watermark + local relay + cursor', async () => {
    const { db, relay, mat } = setup();
    const { factory } = makeFactory();

    const sub = new WsRealtimeSubscriber({
      cloudBase: 'https://cloud.test',
      apiKey: 'sk-prismer-x',
      materializer: mat,
      db,
      wsFactory: factory,
      log: () => {},
      backoffMinMs: 1,
      backoffMaxMs: 4,
    });
    sub.start();

    await until(() => FakeSocket.instances.length >= 1);
    const sock = FakeSocket.instances[0]!;
    sock.fireOpen();
    sock.frame({
      ch: 'sync',
      name: 'sync',
      data: {
        seq: 10,
        boundarySeq: 1,
        type: 'message.new',
        conversationId: 'c1',
        data: { id: 'm1', conversationId: 'c1', boundarySeq: 1, body: 'hi' },
      },
    });
    sock.frame({
      ch: 'sync',
      name: 'sync',
      data: { seq: 11, type: 'conversation.updated', data: { id: 'c1', title: 'T' } },
    });

    await until(() => listMessages(db, 'c1').length === 1 && listConversations(db).length === 1);
    sub.stop();

    expect(listMessages(db, 'c1')[0]!.id).toBe('m1');
    expect(getWatermark(db, 'chats', 'c1')!.cursor).toBe(1);
    expect(relay.events.map((e) => e.type)).toContain('message.new');
    expect(relay.events.map((e) => e.type)).toContain('conversation.updated');
    // per-user cursor advanced to highest seq seen + persisted under the SAME
    // sentinel watermark the SSE subscriber used (seamless transport switch).
    expect(sub.currentCursor).toBe(11);
    expect(getWatermark(db, 'chats', '__sse__')!.cursor).toBe(11);
  });

  it('first connect requests since=0; reconnect resumes from persisted seq', async () => {
    const { db, mat } = setup();
    const { factory, urls } = makeFactory();

    const sub = new WsRealtimeSubscriber({
      cloudBase: 'https://cloud.test',
      apiKey: 'sk-prismer-x',
      materializer: mat,
      db,
      wsFactory: factory,
      log: () => {},
      backoffMinMs: 1,
      backoffMaxMs: 4,
    });
    sub.start();

    await until(() => FakeSocket.instances.length >= 1);
    const first = FakeSocket.instances[0]!;
    first.fireOpen();
    first.frame({
      ch: 'sync',
      name: 'sync',
      data: {
        seq: 7,
        boundarySeq: 1,
        type: 'message.new',
        conversationId: 'c9',
        data: { id: 'mA', conversationId: 'c9', boundarySeq: 1 },
      },
    });
    first.end(); // drop → triggers a reconnect

    await until(() => FakeSocket.instances.length >= 2);
    sub.stop();

    expect(urls[0]).toContain('/ws/realtime');
    expect(urls[0]).toContain('since=0');
    // After applying seq=7 the reconnect resumes from since=7 (no replay storm).
    expect(urls[1]).toContain('since=7');
    // derived wss:// from https cloudBase
    expect(urls[0]!.startsWith('wss://')).toBe(true);
  });

  it('sync.backfill.truncated jumps cursor to newestSeq (avoids replay storm)', async () => {
    const { db, mat } = setup();
    const { factory, urls } = makeFactory();

    const sub = new WsRealtimeSubscriber({
      cloudBase: 'https://cloud.test',
      apiKey: 'sk-prismer-x',
      materializer: mat,
      db,
      wsFactory: factory,
      log: () => {},
      backoffMinMs: 1,
      backoffMaxMs: 4,
    });
    sub.start();

    await until(() => FakeSocket.instances.length >= 1);
    const first = FakeSocket.instances[0]!;
    first.fireOpen();
    first.frame({
      ch: 'sync',
      name: 'sync',
      data: { type: 'sync.backfill.truncated', oldestSeq: 1, newestSeq: 500, replayed: true },
    });
    first.end();

    await until(() => FakeSocket.instances.length >= 2);
    sub.stop();

    expect(sub.currentCursor).toBe(500);
    expect(urls[1]).toContain('since=500');
  });

  it('ignores the ch:tasks projection (daemon only materializes sync)', async () => {
    const { db, relay, mat } = setup();
    const { factory } = makeFactory();

    const sub = new WsRealtimeSubscriber({
      cloudBase: 'https://cloud.test',
      apiKey: 'sk-prismer-x',
      materializer: mat,
      db,
      wsFactory: factory,
      log: () => {},
      backoffMinMs: 1,
      backoffMaxMs: 4,
    });
    sub.start();

    await until(() => FakeSocket.instances.length >= 1);
    const sock = FakeSocket.instances[0]!;
    sock.fireOpen();
    // tasks channel + control frames must NOT materialize or advance cursor.
    sock.frame({ ch: 'tasks', name: 'task.updated', data: { taskId: 't1', seq: 99 } });
    sock.frame({ name: 'heartbeat' });
    sock.frame({ name: 'caught_up', cursor: 0 });
    // one real sync frame proves the socket IS live and demuxing works.
    sock.frame({
      ch: 'sync',
      name: 'sync',
      data: { seq: 5, type: 'conversation.updated', data: { id: 'c2', title: 'X' } },
    });

    await until(() => listConversations(db).length === 1);
    sub.stop();

    expect(sub.currentCursor).toBe(5); // tasks frame's seq=99 ignored
    expect(getWatermark(db, 'chats', '__sse__')!.cursor).toBe(5);
    expect(relay.events.every((e) => e.type !== 'task.updated')).toBe(true);
  });
});
