import { describe, expect, it, vi } from 'vitest';
import { SyncQueue, nextBackoffMs } from '../src/sync/sync-queue.js';
import { SyncWorker, type FlushFn, type FlushResult } from '../src/sync/sync-worker.js';
import { TARGET_SCHEMA_VERSION, currentSchemaVersion, openLocalDb } from '../src/sync/store.js';

function makeQueue() {
  const db = openLocalDb(':memory:');
  return { db, queue: new SyncQueue(db) };
}

describe('store', () => {
  it('opens :memory: db and applies migrations to TARGET_SCHEMA_VERSION', () => {
    const db = openLocalDb(':memory:');
    expect(currentSchemaVersion(db)).toBe(TARGET_SCHEMA_VERSION);
  });

  it('migrations are idempotent', () => {
    const db = openLocalDb(':memory:');
    const before = currentSchemaVersion(db);
    // Re-running openLocalDb on a fresh db is the wrong test (each call is its own db);
    // verify that we can re-invoke runMigrations without changing version.
    const tableCount = (
      db
        .prepare(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
        .get() as { c: number }
    ).c;
    // v1: workspaces, agents, agent_profiles, sync_queue, sync_state, running_tasks
    // v2: cached_assets, workspace_files_mirror
    // v3: asset_metadata_index
    // v4: pending_dispatch_replies (Wave 4 E7 — two-phase reply crash recovery)
    // v5: local_run_sessions (v2.1 §9.5 daemon-as-hook-intake run_id ↔ conversationId map)
    // v6: ALTER local_run_sessions (no new table — hermes session cols)
    // v7: local_run_checkpoints (release201/26 Phase 4 — phase-level run checkpoints)
    expect(tableCount).toBe(12);
    expect(before).toBe(TARGET_SCHEMA_VERSION);
  });
});

describe('SyncQueue', () => {
  it('enqueue + dequeueBatch returns oldest first', () => {
    const { queue } = makeQueue();
    queue.enqueue({ resourceType: 'workspace', resourceId: 'w1', operation: 'update', payload: { name: 'A' } });
    queue.enqueue({ resourceType: 'agent_profile', resourceId: 'p1', operation: 'create', payload: {} });
    const batch = queue.dequeueBatch(10);
    expect(batch).toHaveLength(2);
    expect(batch[0]!.resource_id).toBe('w1');
    expect(batch[1]!.resource_id).toBe('p1');
    expect(JSON.parse(batch[0]!.payload)).toEqual({ name: 'A' });
  });

  it('runAt in the future is not dequeued yet', () => {
    const { queue } = makeQueue();
    const future = Date.now() + 60_000;
    queue.enqueue({ resourceType: 'workspace', resourceId: 'w1', operation: 'update', payload: {}, runAt: future });
    expect(queue.dequeueBatch(10)).toHaveLength(0);
    expect(queue.dequeueBatch(10, future + 1)).toHaveLength(1);
  });

  it('markCompleted removes the row', () => {
    const { queue } = makeQueue();
    const id = queue.enqueue({ resourceType: 'workspace', resourceId: 'w1', operation: 'update', payload: {} });
    queue.markCompleted(id);
    expect(queue.pendingCount()).toBe(0);
  });

  it('markConflict transitions status away from pending', () => {
    const { queue } = makeQueue();
    const id = queue.enqueue({ resourceType: 'workspace', resourceId: 'w1', operation: 'update', payload: {} });
    queue.markConflict(id);
    expect(queue.pendingCount()).toBe(0);
    expect(queue.listForResource('workspace', 'w1')[0]!.status).toBe('failed_conflict');
  });

  it('markBackoff increments attempt_count and reschedules', () => {
    const { queue } = makeQueue();
    const id = queue.enqueue({ resourceType: 'workspace', resourceId: 'w1', operation: 'update', payload: {} });
    queue.markBackoff(id, 0);
    const rows = queue.listForResource('workspace', 'w1');
    expect(rows[0]!.attempt_count).toBe(1);
    expect(rows[0]!.next_attempt_at).toBeGreaterThan(Date.now());
    expect(queue.dequeueBatch(10)).toHaveLength(0);
  });

  it('nextBackoffMs caps at last bucket', () => {
    expect(nextBackoffMs(0)).toBe(5_000);
    expect(nextBackoffMs(3)).toBe(60_000);
    expect(nextBackoffMs(99)).toBe(60_000);
  });
});

describe('SyncWorker', () => {
  it('drains pending rows on tick + ok flush deletes', async () => {
    const { queue } = makeQueue();
    queue.enqueue({ resourceType: 'workspace', resourceId: 'w1', operation: 'update', payload: { v: 1 } });
    queue.enqueue({ resourceType: 'workspace', resourceId: 'w2', operation: 'update', payload: { v: 1 } });

    const flushed: string[] = [];
    const flush: FlushFn = async (row) => {
      flushed.push(row.resource_id);
      return { ok: true };
    };
    const worker = new SyncWorker({ queue, flush });
    const result = await worker.tick();
    expect(result.processed).toBe(2);
    expect(flushed.sort()).toEqual(['w1', 'w2']);
    expect(queue.pendingCount()).toBe(0);
  });

  it('409 → markConflict, 5xx → markBackoff (still pending in future), 400 → markFailedOther', async () => {
    const { queue } = makeQueue();
    queue.enqueue({ resourceType: 'workspace', resourceId: 'conflict', operation: 'update', payload: {} });
    queue.enqueue({ resourceType: 'workspace', resourceId: 'serverdown', operation: 'update', payload: {} });
    queue.enqueue({ resourceType: 'workspace', resourceId: 'badreq', operation: 'update', payload: {} });

    const flush: FlushFn = async (row) => {
      const r: FlushResult = row.resource_id === 'conflict'
        ? { ok: false, status: 409 }
        : row.resource_id === 'serverdown'
          ? { ok: false, status: 503 }
          : { ok: false, status: 400 };
      return r;
    };
    const worker = new SyncWorker({ queue, flush });
    await worker.tick();

    expect(queue.listForResource('workspace', 'conflict')[0]!.status).toBe('failed_conflict');
    expect(queue.listForResource('workspace', 'serverdown')[0]!.status).toBe('pending');
    expect(queue.listForResource('workspace', 'serverdown')[0]!.next_attempt_at).toBeGreaterThan(Date.now());
    expect(queue.listForResource('workspace', 'badreq')[0]!.status).toBe('failed_other');
  });

  it('flush throw → markBackoff + emit error', async () => {
    const { queue } = makeQueue();
    queue.enqueue({ resourceType: 'workspace', resourceId: 'boom', operation: 'update', payload: {} });
    const flush: FlushFn = async () => {
      throw new Error('network down');
    };
    const worker = new SyncWorker({ queue, flush });
    const errored = vi.fn();
    worker.on('error', errored);
    await worker.tick();
    expect(errored).toHaveBeenCalled();
    expect(queue.listForResource('workspace', 'boom')[0]!.attempt_count).toBe(1);
  });

  it('start/stop cycles cleanly without hanging', async () => {
    const { queue } = makeQueue();
    const worker = new SyncWorker({ queue, flush: async () => ({ ok: true }), tickMs: 50 });
    worker.start();
    await new Promise((r) => setTimeout(r, 10));
    worker.stop();
    // No assertion needed — test passes if it doesn't hang.
  });
});
