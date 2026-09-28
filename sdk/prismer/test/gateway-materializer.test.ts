import { describe, expect, it } from 'vitest';
import { openLocalDb } from '../src/sync/store.js';
import { openReadModel, getWatermark, listMessages, listConversations, listTasks } from '../src/daemon/gateway/read-model.js';
import { LocalRelay, type LocalSyncEvent } from '../src/daemon/gateway/local-relay.js';
import { Materializer } from '../src/daemon/gateway/materializer.js';

/** A LocalRelay subclass that records broadcasts instead of writing sockets. */
class RecordingRelay extends LocalRelay {
  events: LocalSyncEvent[] = [];
  resets: Array<{ domain: string; scopeId?: string }> = [];
  override broadcast(event: LocalSyncEvent): void {
    this.events.push(event);
  }
  override broadcastReset(scope: { domain: string; scopeId?: string }): void {
    this.resets.push(scope);
  }
}

function setup(workspaceId = 'w1') {
  const db = openLocalDb(':memory:');
  openReadModel(db);
  const relay = new RecordingRelay();
  const mat = new Materializer({ db, relay, workspaceId: () => workspaceId });
  return { db, relay, mat };
}

describe('materializer — message events', () => {
  it('materializes message.new → rm_messages + advances watermark + forwards SSE', () => {
    const { db, relay, mat } = setup();
    const r = mat.ingest({
      type: 'message.new',
      seq: 42,
      boundarySeq: 1,
      conversationId: 'c1',
      data: { id: 'm1', conversationId: 'c1', boundarySeq: 1, body: 'hi' },
    });
    expect(r.materialized).toBe(true);
    const rows = listMessages(db, 'c1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('m1');
    expect(rows[0]!.boundary_seq).toBe(1);
    expect(getWatermark(db, 'chats', 'c1')!.cursor).toBe(1);
    // forwarded shape preserves boundarySeq + seq (cursor 恒等, §5)
    expect(relay.events).toHaveLength(1);
    expect(relay.events[0]).toMatchObject({ type: 'message.new', seq: 42, boundarySeq: 1 });
  });

  it('handles daemon-WS envelope shape (payload instead of data)', () => {
    const { db, mat } = setup();
    mat.ingest({
      type: 'message.new',
      boundarySeq: 1,
      payload: { id: 'mX', conversationId: 'cZ', boundarySeq: 1 },
    });
    expect(listMessages(db, 'cZ')).toHaveLength(1);
  });

  it('detects a boundarySeq gap → resets scope + emits sync.reset', () => {
    const { db, relay, mat } = setup();
    // establish cursor at 1
    mat.ingest({ type: 'message.new', boundarySeq: 1, conversationId: 'c1', data: { id: 'm1', conversationId: 'c1', boundarySeq: 1 } });
    expect(getWatermark(db, 'chats', 'c1')!.cursor).toBe(1);
    // jump to 5 (gap: expected 2)
    const r = mat.ingest({ type: 'message.new', boundarySeq: 5, conversationId: 'c1', data: { id: 'm5', conversationId: 'c1', boundarySeq: 5 } });
    expect(r.materialized).toBe(false);
    expect(r.reset).toEqual({ domain: 'chats', scopeId: 'c1' });
    // scope cleared, watermark gone
    expect(listMessages(db, 'c1')).toHaveLength(0);
    expect(getWatermark(db, 'chats', 'c1')).toBeUndefined();
    expect(relay.resets).toContainEqual({ domain: 'chats', scopeId: 'c1' });
  });

  it('does NOT treat seq==cursor+1 as a gap', () => {
    const { db, mat } = setup();
    mat.ingest({ type: 'message.new', boundarySeq: 1, conversationId: 'c1', data: { id: 'm1', conversationId: 'c1', boundarySeq: 1 } });
    const r = mat.ingest({ type: 'message.new', boundarySeq: 2, conversationId: 'c1', data: { id: 'm2', conversationId: 'c1', boundarySeq: 2 } });
    expect(r.materialized).toBe(true);
    expect(listMessages(db, 'c1')).toHaveLength(2);
    expect(getWatermark(db, 'chats', 'c1')!.cursor).toBe(2);
  });

  it('ignores message events missing id/conversationId', () => {
    const { mat } = setup();
    expect(mat.ingest({ type: 'message.new', data: { body: 'x' } }).materialized).toBe(false);
  });
});

describe('materializer — conversation + task events', () => {
  it('materializes conversation.updated', () => {
    const { db, mat } = setup();
    const r = mat.ingest({
      type: 'conversation.updated',
      seq: 7,
      data: { id: 'c1', title: 'Hello', updatedAt: 123 },
    });
    expect(r.materialized).toBe(true);
    expect(listConversations(db).map((x) => x.id)).toEqual(['c1']);
    expect(getWatermark(db, 'chats', '')!.cursor).toBe(7);
  });

  it('materializes task.updated using event workspaceId then falling back', () => {
    const { db, mat } = setup('wFallback');
    mat.ingest({ type: 'task.updated', data: { id: 't1', workspaceId: 'wExplicit' } });
    mat.ingest({ type: 'task.updated', data: { id: 't2' } }); // no ws → fallback
    expect(listTasks(db, 'wExplicit').map((x) => x.id)).toEqual(['t1']);
    expect(listTasks(db, 'wFallback').map((x) => x.id)).toEqual(['t2']);
  });

  it('ignores unrelated event types (side-effect-only tap)', () => {
    const { relay, mat } = setup();
    expect(mat.ingest({ type: 'task.dispatch.request', payload: { taskId: 'x' } }).materialized).toBe(false);
    expect(mat.ingest({ type: 'host.acked', payload: {} }).materialized).toBe(false);
    expect(relay.events).toHaveLength(0);
  });

  it('never throws on malformed input', () => {
    const { mat } = setup();
    expect(() => mat.ingest({} as never)).not.toThrow();
    expect(mat.ingest({} as never).materialized).toBe(false);
  });
});
