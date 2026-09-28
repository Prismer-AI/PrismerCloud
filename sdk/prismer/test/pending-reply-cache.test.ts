// Wave-4 E7 — pending dispatch reply cache unit tests.
//
// Covers the local SQLite cache that backs the two-phase reply protocol's
// crash-recovery contract (see daemon/dispatch-reply-transport.ts +
// daemon/pending-reply-cache.ts). NO mocks: real better-sqlite3 in-memory db.

import { describe, it, expect, beforeEach } from 'vitest';
import { openLocalDb, type LocalDb } from '../src/sync/store';
import {
  createPendingReplyCache,
  generateIdempotencyKey,
  type PendingReplyCache,
} from '../src/daemon/pending-reply-cache';

describe('pending-reply-cache', () => {
  let db: LocalDb;
  let cache: PendingReplyCache;

  beforeEach(() => {
    db = openLocalDb(':memory:');
    cache = createPendingReplyCache(db);
  });

  it('savePending writes a pending row visible via findByIdempotencyKey', () => {
    const key = generateIdempotencyKey();
    cache.savePending(key, 'task-1', JSON.stringify({ x: 1 }));
    const row = cache.findByIdempotencyKey(key);
    expect(row).not.toBeNull();
    expect(row!.taskId).toBe('task-1');
    expect(row!.status).toBe('pending');
    expect(row!.replyId).toBeNull();
    expect(row!.attemptCount).toBe(0);
  });

  it('markPrepared sets reply_id + flips status + bumps attemptCount', () => {
    const key = generateIdempotencyKey();
    cache.savePending(key, 'task-2', JSON.stringify({}));
    cache.markPrepared(key, 'reply-abc');
    const row = cache.findByIdempotencyKey(key);
    expect(row?.replyId).toBe('reply-abc');
    expect(row?.status).toBe('prepared');
    expect(row?.preparedAt).not.toBeNull();
    expect(row?.attemptCount).toBe(1);
  });

  it('markAttempt records the last error without changing status', () => {
    const key = generateIdempotencyKey();
    cache.savePending(key, 'task-3', JSON.stringify({}));
    cache.markAttempt(key, Date.now(), 'network blip');
    const row = cache.findByIdempotencyKey(key);
    expect(row?.status).toBe('pending');
    expect(row?.lastError).toBe('network blip');
    expect(row?.attemptCount).toBe(1);
  });

  it('clearPending removes the row entirely', () => {
    const key = generateIdempotencyKey();
    cache.savePending(key, 'task-4', JSON.stringify({}));
    cache.markPrepared(key, 'r-1');
    cache.clearPending(key);
    expect(cache.findByIdempotencyKey(key)).toBeNull();
  });

  it('listForRecovery returns both pending + prepared in createdAt order', () => {
    const k1 = generateIdempotencyKey();
    const k2 = generateIdempotencyKey();
    const k3 = generateIdempotencyKey();
    cache.savePending(k1, 'task-A', JSON.stringify({}), 100);
    cache.savePending(k2, 'task-B', JSON.stringify({}), 200);
    cache.savePending(k3, 'task-C', JSON.stringify({}), 300);
    cache.markPrepared(k2, 'rep-B');
    cache.clearPending(k3); // drop C
    const rows = cache.listForRecovery();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.idempotencyKey).toBe(k1); // pending
    expect(rows[1]!.idempotencyKey).toBe(k2); // prepared
    expect(rows[0]!.status).toBe('pending');
    expect(rows[1]!.status).toBe('prepared');
  });

  it('countByStatus reports pending vs prepared totals', () => {
    cache.savePending('k1', 't1', '{}');
    cache.savePending('k2', 't2', '{}');
    cache.savePending('k3', 't3', '{}');
    cache.markPrepared('k2', 'r2');
    cache.markPrepared('k3', 'r3');
    const counts = cache.countByStatus();
    expect(counts.pending).toBe(1);
    expect(counts.prepared).toBe(2);
  });

  it('savePending with duplicate key overwrites (resets attempt + error)', () => {
    const key = generateIdempotencyKey();
    cache.savePending(key, 'task-X', JSON.stringify({ v: 1 }));
    cache.markAttempt(key, Date.now(), 'first attempt error');
    cache.savePending(key, 'task-X', JSON.stringify({ v: 2 }));
    const row = cache.findByIdempotencyKey(key);
    expect(row?.lastError).toBeNull();
    expect(row?.attemptCount).toBe(0);
    expect(JSON.parse(row!.payloadJson)).toEqual({ v: 2 });
  });

  it('generateIdempotencyKey produces RFC 4122 v4 shape', () => {
    const k = generateIdempotencyKey();
    expect(k).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
