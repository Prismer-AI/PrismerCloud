import { describe, expect, it, vi } from 'vitest';
import { openLocalDb } from '../src/sync/store.js';
import {
  openReadModel,
  getWatermark,
  listMessages,
  listConversations,
} from '../src/daemon/gateway/read-model.js';
import { LocalRelay, type LocalSyncEvent } from '../src/daemon/gateway/local-relay.js';
import { Materializer } from '../src/daemon/gateway/materializer.js';
import { SseSubscriber } from '../src/daemon/gateway/sse-subscriber.js';

/** Records relay broadcasts instead of writing sockets. */
class RecordingRelay extends LocalRelay {
  events: LocalSyncEvent[] = [];
  resets: Array<{ domain: string; scopeId?: string }> = [];
  override broadcast(e: LocalSyncEvent): void {
    this.events.push(e);
  }
  override broadcastReset(s: { domain: string; scopeId?: string }): void {
    this.resets.push(s);
  }
}

/** Build a Response whose body streams the given SSE frame strings, then ends. */
function sseResponse(frames: string[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function syncFrame(event: Record<string, unknown>): string {
  const id = typeof event.seq === 'number' ? `id: ${event.seq}\n` : '';
  return `event: sync\n${id}data: ${JSON.stringify(event)}\n\n`;
}

function setup() {
  const db = openLocalDb(':memory:');
  openReadModel(db);
  const relay = new RecordingRelay();
  const mat = new Materializer({ db, relay, workspaceId: () => 'w1' });
  return { db, relay, mat };
}

/** Wait until `cond()` is true or time out (deterministic poll, no real sleep). */
async function until(cond: () => boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (cond()) return;
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error('condition not met');
}

describe('SseSubscriber — feeds materializer from cloud SSE', () => {
  it('parses sync frames → rm_* materialized + watermark + local relay fan-out', async () => {
    const { db, relay, mat } = setup();
    const fetchImpl = vi.fn().mockResolvedValue(
      sseResponse([
        ': connected\n\n',
        `event: caught_up\ndata: ${JSON.stringify({ cursor: 0 })}\n\n`,
        syncFrame({
          seq: 10,
          boundarySeq: 1,
          type: 'message.new',
          conversationId: 'c1',
          data: { id: 'm1', conversationId: 'c1', boundarySeq: 1, body: 'hi' },
        }),
        syncFrame({ seq: 11, type: 'conversation.updated', data: { id: 'c1', title: 'T' } }),
      ]),
    );

    const sub = new SseSubscriber({
      cloudBase: 'https://cloud.test',
      apiKey: 'sk-prismer-x',
      materializer: mat,
      db,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: () => {},
      backoffMinMs: 1,
      backoffMaxMs: 4,
    });
    sub.start();

    await until(() => listMessages(db, 'c1').length === 1 && listConversations(db).length === 1);
    sub.stop();

    // message materialized with boundarySeq + per-conversation watermark advanced
    expect(listMessages(db, 'c1')[0]!.id).toBe('m1');
    expect(getWatermark(db, 'chats', 'c1')!.cursor).toBe(1);
    // forwarded to local SSE subscribers, shape preserved (cursor 恒等)
    expect(relay.events.map((e) => e.type)).toContain('message.new');
    expect(relay.events.map((e) => e.type)).toContain('conversation.updated');
    // per-user SSE cursor advanced to highest seq seen (11)
    expect(sub.currentCursor).toBe(11);
    expect(getWatermark(db, 'chats', '__sse__')!.cursor).toBe(11);
  });

  it('first connect requests since=0; reconnect resumes from persisted seq', async () => {
    const { db, mat } = setup();
    const urls: string[] = [];
    // First connection: emits one event then EOF → triggers a reconnect.
    // Second connection: empty stream (we stop right after observing the URL).
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      urls.push(url);
      if (urls.length === 1) {
        return Promise.resolve(
          sseResponse([
            syncFrame({
              seq: 7,
              boundarySeq: 1,
              type: 'message.new',
              conversationId: 'c9',
              data: { id: 'mA', conversationId: 'c9', boundarySeq: 1 },
            }),
          ]),
        );
      }
      return Promise.resolve(sseResponse([]));
    });

    const sub = new SseSubscriber({
      cloudBase: 'https://cloud.test',
      apiKey: 'sk-prismer-x',
      materializer: mat,
      db,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: () => {},
      backoffMinMs: 1,
      backoffMaxMs: 4,
    });
    sub.start();

    await until(() => urls.length >= 2);
    sub.stop();

    expect(urls[0]).toContain('since=0');
    // After applying seq=7, the reconnect must resume from since=7 (not 0) —
    // this is what prevents the full-replay storm on every drop.
    expect(urls[1]).toContain('since=7');
  });

  it('sync.backfill.truncated jumps cursor to newestSeq (avoids replay storm)', async () => {
    const { db, mat } = setup();
    const urls: string[] = [];
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      urls.push(url);
      if (urls.length === 1) {
        return Promise.resolve(
          sseResponse([
            syncFrame({ type: 'sync.backfill.truncated', oldestSeq: 1, newestSeq: 500, replayed: true }),
          ]),
        );
      }
      return Promise.resolve(sseResponse([]));
    });

    const sub = new SseSubscriber({
      cloudBase: 'https://cloud.test',
      apiKey: 'sk-prismer-x',
      materializer: mat,
      db,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: () => {},
      backoffMinMs: 1,
      backoffMaxMs: 4,
    });
    sub.start();

    await until(() => urls.length >= 2);
    sub.stop();

    expect(sub.currentCursor).toBe(500);
    expect(urls[1]).toContain('since=500');
  });

  it('retries with backoff on connect failure (non-ok response)', async () => {
    const { db, mat } = setup();
    let calls = 0;
    const fetchImpl = vi.fn().mockImplementation(() => {
      calls += 1;
      if (calls === 1) return Promise.resolve(new Response('nope', { status: 502 }));
      return Promise.resolve(sseResponse([]));
    });

    const sub = new SseSubscriber({
      cloudBase: 'https://cloud.test',
      apiKey: 'sk-prismer-x',
      materializer: mat,
      db,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: () => {},
      backoffMinMs: 1,
      backoffMaxMs: 4,
    });
    sub.start();

    await until(() => calls >= 2);
    sub.stop();
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
