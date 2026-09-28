import { describe, expect, it } from 'vitest';
import { openLocalDb, currentSchemaVersion, TARGET_SCHEMA_VERSION } from '../src/sync/store.js';
import {
  openReadModel,
  RM_SCHEMA_VERSION,
  advanceWatermark,
  getConversation,
  getMessageByClientMsgId,
  getTask,
  getWatermark,
  isFresh,
  listConversations,
  listMessages,
  listTasks,
  resetScope,
  touchWatermark,
  upsertConversation,
  upsertMessage,
  upsertTask,
} from '../src/daemon/gateway/read-model.js';

function freshDb() {
  const db = openLocalDb(':memory:');
  openReadModel(db);
  return db;
}

describe('read-model schema mechanism', () => {
  it('does NOT advance store.ts PRAGMA user_version (independent mechanism)', () => {
    const db = openLocalDb(':memory:');
    const before = currentSchemaVersion(db);
    expect(before).toBe(TARGET_SCHEMA_VERSION);
    openReadModel(db);
    // rm_* creation must not touch user_version migrations.
    expect(currentSchemaVersion(db)).toBe(TARGET_SCHEMA_VERSION);
  });

  it('creates rm_* tables on first boot and stamps version', () => {
    const db = openLocalDb(':memory:');
    const res = openReadModel(db);
    expect(res.rebuilt).toBe(false); // first boot is not a "rebuild"
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'rm_%'`)
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name).sort();
    expect(names).toEqual(['rm_conversations', 'rm_messages', 'rm_tasks', 'rm_watermarks']);
    // schema version stamped under sentinel domain
    const v = db
      .prepare(`SELECT cursor FROM rm_watermarks WHERE domain='__schema__' AND scope_id=''`)
      .get() as { cursor: number };
    expect(v.cursor).toBe(RM_SCHEMA_VERSION);
  });

  it('is idempotent when version matches', () => {
    const db = freshDb();
    upsertConversation(db, { id: 'c1', payload: { id: 'c1' }, updatedAt: 1 });
    // re-open: version matches → no rebuild, data preserved
    const res = openReadModel(db);
    expect(res.rebuilt).toBe(false);
    expect(getConversation(db, 'c1')).toBeTruthy();
  });

  it('DROPs + rebuilds rm_* when stored version mismatches', () => {
    const db = freshDb();
    upsertConversation(db, { id: 'c1', payload: { id: 'c1' }, updatedAt: 1 });
    expect(getConversation(db, 'c1')).toBeTruthy();
    // Simulate an older/newer code version by corrupting the stamped version.
    db.prepare(`UPDATE rm_watermarks SET cursor = 999 WHERE domain='__schema__'`).run();
    const res = openReadModel(db);
    expect(res.rebuilt).toBe(true);
    // cache wiped on rebuild
    expect(getConversation(db, 'c1')).toBeUndefined();
    // version re-stamped
    const v = db
      .prepare(`SELECT cursor FROM rm_watermarks WHERE domain='__schema__' AND scope_id=''`)
      .get() as { cursor: number };
    expect(v.cursor).toBe(RM_SCHEMA_VERSION);
  });
});

describe('read-model upsert + query', () => {
  it('upserts and lists conversations newest-first', () => {
    const db = freshDb();
    upsertConversation(db, { id: 'a', payload: { id: 'a', n: 1 }, updatedAt: 100 });
    upsertConversation(db, { id: 'b', payload: { id: 'b', n: 2 }, updatedAt: 200 });
    const list = listConversations(db);
    expect(list.map((r) => r.id)).toEqual(['b', 'a']);
    // overwrite a
    upsertConversation(db, { id: 'a', payload: { id: 'a', n: 9 }, updatedAt: 300 });
    expect(listConversations(db).map((r) => r.id)).toEqual(['a', 'b']);
    expect(JSON.parse(getConversation(db, 'a')!.payload_json)).toMatchObject({ n: 9 });
  });

  it('upserts messages ordered by boundary_seq, NULL-seq rows last', () => {
    const db = freshDb();
    upsertMessage(db, { id: 'm2', conversationId: 'c1', boundarySeq: 2, payload: { id: 'm2' }, createdAt: 2 });
    upsertMessage(db, { id: 'm1', conversationId: 'c1', boundarySeq: 1, payload: { id: 'm1' }, createdAt: 1 });
    upsertMessage(db, {
      id: 'opt',
      conversationId: 'c1',
      clientMsgId: 'cmsg_x',
      boundarySeq: null,
      payload: { id: 'opt' },
      syncStatus: 'pending',
      createdAt: 3,
    });
    const rows = listMessages(db, 'c1');
    expect(rows.map((r) => r.id)).toEqual(['m1', 'm2', 'opt']);
    expect(getMessageByClientMsgId(db, 'cmsg_x')!.id).toBe('opt');
  });

  it('upserts + lists tasks scoped by workspace', () => {
    const db = freshDb();
    upsertTask(db, { id: 't1', workspaceId: 'w1', payload: { id: 't1' }, updatedAt: 10 });
    upsertTask(db, { id: 't2', workspaceId: 'w2', payload: { id: 't2' }, updatedAt: 20 });
    expect(listTasks(db, 'w1').map((r) => r.id)).toEqual(['t1']);
    expect(getTask(db, 't2')!.workspace_id).toBe('w2');
  });
});

describe('read-model watermarks', () => {
  it('advances monotonically (never regresses cursor)', () => {
    const db = freshDb();
    expect(advanceWatermark(db, 'chats', 'c1', 5)).toBe(5);
    expect(advanceWatermark(db, 'chats', 'c1', 3)).toBe(5); // lower ignored for cursor
    expect(advanceWatermark(db, 'chats', 'c1', 8)).toBe(8);
    expect(getWatermark(db, 'chats', 'c1')!.cursor).toBe(8);
  });

  it('touchWatermark bumps freshness without moving cursor', () => {
    const db = freshDb();
    advanceWatermark(db, 'chats', '', 4, 1000);
    touchWatermark(db, 'chats', '', 5000);
    const wm = getWatermark(db, 'chats', '')!;
    expect(wm.cursor).toBe(4);
    expect(wm.synced_at).toBe(5000);
  });

  it('isFresh respects TTL', () => {
    const now = 100_000;
    expect(isFresh({ domain: 'chats', scope_id: '', cursor: 1, synced_at: now - 1000 }, 30_000, now)).toBe(true);
    expect(isFresh({ domain: 'chats', scope_id: '', cursor: 1, synced_at: now - 60_000 }, 30_000, now)).toBe(false);
    expect(isFresh(undefined, 30_000, now)).toBe(false);
  });
});

describe('read-model domain reset (gap → re-pull)', () => {
  it('clears a conversation scope + watermark', () => {
    const db = freshDb();
    upsertMessage(db, { id: 'm1', conversationId: 'c1', boundarySeq: 1, payload: {}, createdAt: 1 });
    upsertMessage(db, { id: 'm2', conversationId: 'c2', boundarySeq: 1, payload: {}, createdAt: 1 });
    advanceWatermark(db, 'chats', 'c1', 1);
    resetScope(db, 'chats', 'c1');
    expect(listMessages(db, 'c1')).toHaveLength(0);
    expect(listMessages(db, 'c2')).toHaveLength(1); // other scope untouched
    expect(getWatermark(db, 'chats', 'c1')).toBeUndefined();
  });

  it('clears all tasks on a tasks-domain reset', () => {
    const db = freshDb();
    upsertTask(db, { id: 't1', workspaceId: 'w1', payload: {}, updatedAt: 1 });
    advanceWatermark(db, 'tasks', '', 3);
    resetScope(db, 'tasks', '');
    expect(listTasks(db, 'w1')).toHaveLength(0);
    expect(getWatermark(db, 'tasks', '')).toBeUndefined();
  });
});
