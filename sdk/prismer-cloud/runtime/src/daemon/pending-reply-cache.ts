// Wave-4 E7 — pending dispatch reply cache (W3 two-phase crash-recovery key).
//
// The two-phase dispatch reply protocol (server: src/im/api/dispatch.ts,
// spec: docs/release200/14-messaging-state-machine-reliability.md §4.3) splits
// the legacy single-shot `/dispatch/reply` into:
//
//   1. PREPARE  — daemon uploads assets, then POSTs the reply payload to
//                  `/api/im/dispatch/:taskId/prepare` with a client-generated
//                  idempotencyKey. Server returns `{ replyId, status:'prepared' }`
//                  and writes an im_dispatch_replies row with status='prepared'.
//   2. COMMIT   — daemon POSTs `/api/im/dispatch/:taskId/commit` with the
//                  replyId. Server flips status='committed' and writes the
//                  chat message + task transition in a single transaction.
//
// Between PREPARE and COMMIT, the daemon owns the `replyId` and is the only
// party who knows the row exists. A crash here leaves the server with a
// 'prepared' row that never commits — the server-side reaper sweeps these
// at >1h, but the daemon should retry commit on cold-start to avoid the
// reaper aborting a reply we actually completed.
//
// This module persists the in-flight (taskId, idempotencyKey, replyId) tuple
// in the daemon's local SQLite (~/.prismer/local.db) so a crash window is
// recoverable. Lifecycle:
//
//   savePending(taskId, idempotencyKey, payload) → row(status='pending')
//                                                  // BEFORE prepare network call
//   markPrepared(idempotencyKey, replyId)        → row(status='prepared')
//                                                  // AFTER prepare 200
//   clearPending(idempotencyKey)                 → row deleted
//                                                  // AFTER commit 200, or
//                                                  // AFTER server says
//                                                  // status='committed'
//                                                  // (idempotent re-send)
//   listForRecovery()                            → rows with status in
//                                                  // ('pending','prepared')
//                                                  // for cold-start retry
//   markFailed(idempotencyKey, err)              → row.last_error set,
//                                                  // attempt_count++; row
//                                                  // stays for next retry
//
// The daemon's Runner calls `recoverPendingReplies()` once after WS connect
// completes (signal: cloud is reachable). `pending` rows trigger a re-prepare
// (idempotent on (taskId, idempotencyKey) per W3 server contract); `prepared`
// rows trigger a commit (idempotent on replyId).
//
// See also: `runtime/src/sync/store.ts` migration v4 for table schema.

import type { LocalDb } from '../sync/store.js';

export type PendingReplyStatus = 'pending' | 'prepared';

export interface PendingReplyRow {
  /** Client-generated UUID; primary key + server-side idempotency key. */
  idempotencyKey: string;
  /** Task this reply belongs to. URL path arg on prepare/commit. */
  taskId: string;
  /** Server-issued reply id, set after a successful prepare. */
  replyId: string | null;
  status: PendingReplyStatus;
  /** Original prepare payload (JSON-encoded) — replayed on cold-start. */
  payloadJson: string;
  /** Local clock at row insert. */
  createdAt: number;
  /** Local clock when prepare 200 was received; null until then. */
  preparedAt: number | null;
  /** Local clock of the last commit/prepare attempt (best-effort observability). */
  lastAttemptAt: number | null;
  attemptCount: number;
  lastError: string | null;
}

export interface PendingReplyCache {
  savePending(
    idempotencyKey: string,
    taskId: string,
    payloadJson: string,
    now?: number,
  ): void;
  markPrepared(idempotencyKey: string, replyId: string, now?: number): void;
  markAttempt(idempotencyKey: string, now?: number, error?: string): void;
  clearPending(idempotencyKey: string): void;
  listForRecovery(): PendingReplyRow[];
  /** Test-only / observability — count of rows by status. */
  countByStatus(): { pending: number; prepared: number };
  /** Test-only — direct row lookup. */
  findByIdempotencyKey(idempotencyKey: string): PendingReplyRow | null;
}

interface RawRow {
  idempotency_key: string;
  task_id: string;
  reply_id: string | null;
  status: PendingReplyStatus;
  payload_json: string;
  prepared_at: number | null;
  created_at: number;
  last_attempt_at: number | null;
  attempt_count: number;
  last_error: string | null;
}

function fromRaw(r: RawRow): PendingReplyRow {
  return {
    idempotencyKey: r.idempotency_key,
    taskId: r.task_id,
    replyId: r.reply_id,
    status: r.status,
    payloadJson: r.payload_json,
    createdAt: r.created_at,
    preparedAt: r.prepared_at,
    lastAttemptAt: r.last_attempt_at,
    attemptCount: r.attempt_count,
    lastError: r.last_error,
  };
}

/**
 * Open a cache view over an existing local.db. The migration that creates
 * `pending_dispatch_replies` lives in `runtime/src/sync/store.ts` v4 — callers
 * must pass a db that has already had `runMigrations` applied (openLocalDb()
 * does this automatically).
 */
export function createPendingReplyCache(db: LocalDb): PendingReplyCache {
  const insert = db.prepare(
    `INSERT OR REPLACE INTO pending_dispatch_replies
       (idempotency_key, task_id, reply_id, status, payload_json,
        prepared_at, created_at, last_attempt_at, attempt_count, last_error)
     VALUES (?, ?, NULL, 'pending', ?, NULL, ?, NULL, 0, NULL)`,
  );
  const markPreparedStmt = db.prepare(
    `UPDATE pending_dispatch_replies
       SET reply_id = ?, status = 'prepared', prepared_at = ?,
           last_attempt_at = ?, attempt_count = attempt_count + 1,
           last_error = NULL
     WHERE idempotency_key = ?`,
  );
  const markAttemptStmt = db.prepare(
    `UPDATE pending_dispatch_replies
       SET last_attempt_at = ?, attempt_count = attempt_count + 1,
           last_error = ?
     WHERE idempotency_key = ?`,
  );
  const clearStmt = db.prepare(
    `DELETE FROM pending_dispatch_replies WHERE idempotency_key = ?`,
  );
  const listRecoveryStmt = db.prepare(
    `SELECT * FROM pending_dispatch_replies
     WHERE status IN ('pending', 'prepared')
     ORDER BY created_at ASC`,
  );
  const countStmt = db.prepare(
    `SELECT status, COUNT(*) as cnt FROM pending_dispatch_replies
     WHERE status IN ('pending','prepared') GROUP BY status`,
  );
  const findStmt = db.prepare(
    `SELECT * FROM pending_dispatch_replies WHERE idempotency_key = ?`,
  );

  return {
    savePending(idempotencyKey, taskId, payloadJson, now = Date.now()) {
      insert.run(idempotencyKey, taskId, payloadJson, now);
    },
    markPrepared(idempotencyKey, replyId, now = Date.now()) {
      markPreparedStmt.run(replyId, now, now, idempotencyKey);
    },
    markAttempt(idempotencyKey, now = Date.now(), error) {
      markAttemptStmt.run(now, error ?? null, idempotencyKey);
    },
    clearPending(idempotencyKey) {
      clearStmt.run(idempotencyKey);
    },
    listForRecovery() {
      const rows = listRecoveryStmt.all() as RawRow[];
      return rows.map(fromRaw);
    },
    countByStatus() {
      const rows = countStmt.all() as Array<{ status: PendingReplyStatus; cnt: number }>;
      const result = { pending: 0, prepared: 0 };
      for (const r of rows) {
        if (r.status === 'pending') result.pending = r.cnt;
        else if (r.status === 'prepared') result.prepared = r.cnt;
      }
      return result;
    },
    findByIdempotencyKey(idempotencyKey) {
      const row = findStmt.get(idempotencyKey) as RawRow | undefined;
      return row ? fromRaw(row) : null;
    },
  };
}

/**
 * Generate a v4-style UUID without pulling a runtime dep — the dispatch reply
 * idempotency key only needs to be globally unique per (taskId, daemon) tuple,
 * not cryptographically strong. crypto.randomUUID() is the obvious choice but
 * is also fine to call from Node 18+.
 */
export function generateIdempotencyKey(): string {
  // Node 18+ exposes globalThis.crypto.randomUUID; fall back to a manual
  // composition (still RFC 4122 v4 shape) for environments without it.
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // crypto.getRandomValues fallback (any modern Node has this).
  const bytes = new Uint8Array(16);
  const cryptoNode = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => void } })
    .crypto;
  if (cryptoNode?.getRandomValues) {
    cryptoNode.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
