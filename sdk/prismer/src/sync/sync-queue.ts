// Offline-first push queue. Daemon writes locally, then enqueues here;
// SyncWorker drains rows and pushes to cloud HTTP. See 04-daemon-runtime §Sync worker.

import type { LocalDb } from './store.js';

export type SyncResourceType =
  | 'workspace'
  | 'agent'
  | 'agent_profile'
  // desktop202 M2 (13 §7) — local IM gateway optimistic writes. resource_id is
  // the idempotency key `cmsg_<uuid>` (生成一次, 重试/重启永不更换).
  | 'im_message'
  | 'task_mutation';
export type SyncOperation = 'create' | 'update' | 'delete';
export type SyncStatus = 'pending' | 'failed_conflict' | 'failed_other';

export interface SyncQueueRow {
  id: number;
  resource_type: SyncResourceType;
  resource_id: string;
  operation: SyncOperation;
  payload: string; // JSON serialized
  attempt_count: number;
  last_attempt_at: number | null;
  next_attempt_at: number;
  status: SyncStatus;
}

/** Backoff schedule per 13-error-handling §2.7: 5s → 10s → 30s → 60s, cap. */
const BACKOFF_SCHEDULE_MS = [5_000, 10_000, 30_000, 60_000];

export function nextBackoffMs(attemptCount: number): number {
  const idx = Math.min(attemptCount, BACKOFF_SCHEDULE_MS.length - 1);
  return BACKOFF_SCHEDULE_MS[idx]!;
}

export class SyncQueue {
  constructor(private db: LocalDb) {}

  enqueue(input: {
    resourceType: SyncResourceType;
    resourceId: string;
    operation: SyncOperation;
    payload: unknown;
    /** Defaults to now (ready immediately). */
    runAt?: number;
  }): number {
    const stmt = this.db.prepare(`
      INSERT INTO sync_queue (resource_type, resource_id, operation, payload, next_attempt_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      input.resourceType,
      input.resourceId,
      input.operation,
      JSON.stringify(input.payload),
      input.runAt ?? Date.now(),
    );
    return result.lastInsertRowid as number;
  }

  /** Take up to `limit` rows whose next_attempt_at <= now and status='pending'. Oldest first. */
  dequeueBatch(limit: number, now: number = Date.now()): SyncQueueRow[] {
    return this.db
      .prepare(
        `SELECT * FROM sync_queue
         WHERE status = 'pending' AND next_attempt_at <= ?
         ORDER BY id ASC
         LIMIT ?`,
      )
      .all(now, limit) as SyncQueueRow[];
  }

  markCompleted(id: number): void {
    this.db.prepare('DELETE FROM sync_queue WHERE id = ?').run(id);
  }

  markConflict(id: number): void {
    this.db
      .prepare(
        `UPDATE sync_queue SET status = 'failed_conflict', last_attempt_at = ? WHERE id = ?`,
      )
      .run(Date.now(), id);
  }

  /** Increment attempt + reschedule via backoff. Caller passes the current attempt_count. */
  markBackoff(id: number, currentAttemptCount: number): void {
    const nextAttemptAt = Date.now() + nextBackoffMs(currentAttemptCount);
    this.db
      .prepare(
        `UPDATE sync_queue
           SET attempt_count = ?, last_attempt_at = ?, next_attempt_at = ?
         WHERE id = ?`,
      )
      .run(currentAttemptCount + 1, Date.now(), nextAttemptAt, id);
  }

  /** Permanent failure (4xx other than 409). */
  markFailedOther(id: number): void {
    this.db
      .prepare(
        `UPDATE sync_queue SET status = 'failed_other', last_attempt_at = ? WHERE id = ?`,
      )
      .run(Date.now(), id);
  }

  pendingCount(): number {
    return (
      this.db.prepare(`SELECT COUNT(*) AS c FROM sync_queue WHERE status = 'pending'`).get() as {
        c: number;
      }
    ).c;
  }

  /**
   * Count pending rows of given resource types (desktop202 M3 /healthz
   * `pendingWrites`). With no types → all pending rows.
   */
  pendingCountByType(types?: SyncResourceType[]): number {
    if (!types || types.length === 0) return this.pendingCount();
    const placeholders = types.map(() => '?').join(',');
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM sync_queue WHERE status = 'pending' AND resource_type IN (${placeholders})`,
        )
        .get(...types) as { c: number }
    ).c;
  }

  /**
   * Age (ms) of the oldest still-pending row's first enqueue, by resource type
   * (desktop202 M3 /healthz `oldestPendingAge`). Approximated from the lowest
   * row id (autoincrement = enqueue order) via its current next_attempt_at is
   * not reliable post-backoff, so we use last_attempt_at when present else
   * next_attempt_at as a floor. Returns null when nothing is pending.
   *
   * NOTE: sync_queue has no created_at column; we surface the oldest pending
   * row's `next_attempt_at` lower-bounded age which is "time since it became
   * eligible", a good-enough staleness signal for the offline indicator.
   */
  oldestPendingAge(types?: SyncResourceType[], now: number = Date.now()): number | null {
    const typeFilter =
      types && types.length > 0
        ? `AND resource_type IN (${types.map(() => '?').join(',')})`
        : '';
    const row = this.db
      .prepare(
        `SELECT MIN(next_attempt_at) AS ts FROM sync_queue WHERE status = 'pending' ${typeFilter}`,
      )
      .get(...(types ?? [])) as { ts: number | null };
    if (row.ts == null) return null;
    return Math.max(0, now - row.ts);
  }

  /**
   * Recovery kick (desktop202 M3): make every pending row immediately eligible
   * by resetting next_attempt_at to now, so a freshly-reachable cloud flushes
   * the whole backlog on the next tick instead of waiting out per-row backoff
   * windows. Does NOT touch failed_conflict / failed_other rows (those need an
   * explicit resend). Returns the number of rows kicked.
   */
  kickPending(now: number = Date.now()): number {
    const result = this.db
      .prepare(`UPDATE sync_queue SET next_attempt_at = ? WHERE status = 'pending' AND next_attempt_at > ?`)
      .run(now, now);
    return result.changes as number;
  }

  /** All rows for a given resource (debugging / CLI status). */
  listForResource(type: SyncResourceType, id: string): SyncQueueRow[] {
    return this.db
      .prepare(`SELECT * FROM sync_queue WHERE resource_type = ? AND resource_id = ? ORDER BY id`)
      .all(type, id) as SyncQueueRow[];
  }
}
