// Origin Outbox — SQLite-backed pending-upload queue. (release202/04 §3.1:
// the backing tables are now `asset_origin_artifacts` (+ dead-letter); the
// class/file names keep the "outbox" pattern word — it's a sync queue.)
//
// Pattern mirrors `daemon/memory/outbox.ts`: validation -> dead-letter,
// idempotencyKey UNIQUE, separate dead-letter table, never silently dropped.
//
// What it stores: one row per OriginAdapter observation that needs to be
// uploaded to cloud `POST /api/im/assets`. The drop-folder watcher is the
// primary producer; agent-gen RPC bypasses the outbox (synchronous return).
//
// What it doesn't store: bytes. The observation row carries the adapter's
// detail payload (fs path, RPC handle, etc.); the uploader re-derives bytes
// via `OriginAdapter.fetch(obs)` at claim time. Keeps the SQLite db small
// and lets large files stream through memory once.

import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { OriginKind } from './spi.js';

const OriginObservationRecordSchema = z.object({
  workspaceId: z.string().min(1),
  originKind: z.enum(['upload', 'drop-folder', 'agent-gen']),
  sourceRef: z.string().min(1),
  payloadJson: z.string().min(2),
  hintsJson: z.string().min(2),
  observedAt: z.number().int().nonnegative(),
});

export type OriginObservationRecord = z.infer<typeof OriginObservationRecordSchema>;

export interface OriginOutboxOptions {
  /** Path to the SQLite db file. Created if missing. */
  dbPath: string;
}

export interface EnqueueResult {
  id: string;
  deadLetter: boolean;
}

export interface ClaimResult {
  /** out_* row id (for markUploaded / recordFailure callbacks). */
  id: string;
  row: OutboxRow;
}

export interface OutboxRow extends OriginObservationRecord {
  id: string;
  attempts: number;
  lastError: string | null;
  createdAt: number;
}

interface UploadedMeta {
  assetId: string;
  contentHash: string;
}

interface RecordFailureOptions {
  /** Move row to dead-letter once `attempts >= maxAttempts`. */
  maxAttempts: number;
}

// DDL split per-statement so each can run via prepare().run(); matches the
// MemoryStore convention in daemon/memory/store.ts.
const DDL_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS asset_origin_artifacts (
    id TEXT PRIMARY KEY,
    workspaceId TEXT NOT NULL,
    originKind TEXT NOT NULL,
    sourceRef TEXT NOT NULL,
    payloadJson TEXT NOT NULL,
    hintsJson TEXT NOT NULL,
    observedAt INTEGER NOT NULL,
    idempotencyKey TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'uploaded')),
    attempts INTEGER NOT NULL DEFAULT 0,
    lastError TEXT,
    assetId TEXT,
    contentHash TEXT,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_asset_origin_artifacts_status
    ON asset_origin_artifacts(status, createdAt)`,
  `CREATE TABLE IF NOT EXISTS asset_origin_artifacts_dead_letter (
    id TEXT PRIMARY KEY,
    workspaceId TEXT NOT NULL,
    originKind TEXT NOT NULL,
    sourceRef TEXT NOT NULL,
    payloadJson TEXT NOT NULL,
    hintsJson TEXT NOT NULL,
    observedAt INTEGER NOT NULL,
    errorJson TEXT NOT NULL,
    attempts INTEGER NOT NULL,
    createdAt INTEGER NOT NULL
  )`,
];

interface RawRow {
  id: string;
  workspaceId: string;
  originKind: string;
  sourceRef: string;
  payloadJson: string;
  hintsJson: string;
  observedAt: number;
  attempts: number;
  lastError: string | null;
  createdAt: number;
}

export class OriginOutbox {
  private readonly db: Database.Database;

  constructor(opts: OriginOutboxOptions) {
    this.db = new Database(opts.dbPath);
    this.db.pragma('journal_mode = WAL');
    for (const ddl of DDL_STATEMENTS) this.db.prepare(ddl).run();
    this.migrateLegacyTables();
  }

  /**
   * release202/04 §3.1 — backward-compat migration: the table was renamed
   * `asset_origin_outbox` → `asset_origin_artifacts` (+ dead-letter). If a db
   * file created before the rename still has the old tables, copy any rows
   * into the new ones (idempotent via INSERT OR IGNORE on the UNIQUE
   * idempotencyKey / PK) and drop the legacy tables so we don't re-copy or
   * leave a stale pending queue behind. New dbs have no legacy tables — the
   * `IF EXISTS` guards make this a cheap no-op then.
   */
  private migrateLegacyTables(): void {
    const hasTable = (name: string): boolean =>
      !!this.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(name);
    const migrate = this.db.transaction(() => {
      if (hasTable('asset_origin_outbox')) {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO asset_origin_artifacts
               (id, workspaceId, originKind, sourceRef, payloadJson, hintsJson, observedAt,
                idempotencyKey, status, attempts, lastError, assetId, contentHash, createdAt, updatedAt)
             SELECT id, workspaceId, originKind, sourceRef, payloadJson, hintsJson, observedAt,
                    idempotencyKey, status, attempts, lastError, assetId, contentHash, createdAt, updatedAt
               FROM asset_origin_outbox`,
          )
          .run();
        this.db.prepare('DROP TABLE asset_origin_outbox').run();
      }
      if (hasTable('asset_origin_outbox_dead_letter')) {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO asset_origin_artifacts_dead_letter
               (id, workspaceId, originKind, sourceRef, payloadJson, hintsJson, observedAt, errorJson, attempts, createdAt)
             SELECT id, workspaceId, originKind, sourceRef, payloadJson, hintsJson, observedAt, errorJson, attempts, createdAt
               FROM asset_origin_outbox_dead_letter`,
          )
          .run();
        this.db.prepare('DROP TABLE asset_origin_outbox_dead_letter').run();
      }
    });
    migrate();
  }

  /**
   * Validate + persist an observation. Schema-invalid input lands in
   * `asset_origin_artifacts_dead_letter` (never silently dropped). Re-enqueue
   * with the same {originKind, workspaceId, sourceRef, observedAt} returns
   * the existing row id without inserting again.
   */
  enqueue(record: unknown): EnqueueResult {
    const now = Date.now();
    const parsed = OriginObservationRecordSchema.safeParse(record);
    if (!parsed.success) {
      const dlId = `dl_${randomUUID()}`;
      const raw = (record && typeof record === 'object' ? record : {}) as Record<string, unknown>;
      // Dead-letter must NEVER throw — that would defeat its "never silently
      // dropped" purpose. Force every column to a string before binding;
      // better-sqlite3 throws TYPE_MISMATCH if a column gets an Object/etc.
      this.db
        .prepare(
          `INSERT INTO asset_origin_artifacts_dead_letter
           (id, workspaceId, originKind, sourceRef, payloadJson, hintsJson, observedAt, errorJson, attempts, createdAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          dlId,
          coerceToString(raw.workspaceId, ''),
          coerceToString(raw.originKind, ''),
          coerceToString(raw.sourceRef, ''),
          coerceToJson(raw.payloadJson),
          coerceToJson(raw.hintsJson),
          typeof raw.observedAt === 'number' ? raw.observedAt : 0,
          JSON.stringify(parsed.error.errors),
          0,
          now,
        );
      return { id: dlId, deadLetter: true };
    }

    const validated = parsed.data;
    const idempotencyKey = computeIdempotencyKey(validated);
    const rowId = `out_${randomUUID()}`;

    try {
      this.db
        .prepare(
          `INSERT INTO asset_origin_artifacts
           (id, workspaceId, originKind, sourceRef, payloadJson, hintsJson, observedAt,
            idempotencyKey, status, attempts, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
        )
        .run(
          rowId,
          validated.workspaceId,
          validated.originKind,
          validated.sourceRef,
          validated.payloadJson,
          validated.hintsJson,
          validated.observedAt,
          idempotencyKey,
          now,
          now,
        );
      return { id: rowId, deadLetter: false };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException & { code?: string }).code;
      if (code === 'SQLITE_CONSTRAINT_UNIQUE') {
        const existing = this.db
          .prepare('SELECT id FROM asset_origin_artifacts WHERE idempotencyKey = ?')
          .get(idempotencyKey) as { id: string } | undefined;
        if (existing) return { id: existing.id, deadLetter: false };
      }
      throw err;
    }
  }

  /**
   * Atomically claim the oldest pending row, transition status to 'claimed',
   * and return it. Returns null when the queue is empty. The caller MUST
   * follow up with `markUploaded` (success) or `recordFailure` (error) so
   * the row doesn't sit in 'claimed' forever — Phase-0 is a single worker
   * so we don't need a claim-expiry sweeper yet.
   */
  claimNext(): ClaimResult | null {
    const pickAndClaim = this.db.transaction((): RawRow | null => {
      const row = this.db
        .prepare(
          `SELECT id, workspaceId, originKind, sourceRef, payloadJson, hintsJson,
                  observedAt, attempts, lastError, createdAt
             FROM asset_origin_artifacts
            WHERE status = 'pending'
            ORDER BY createdAt ASC
            LIMIT 1`,
        )
        .get() as RawRow | undefined;
      if (!row) return null;
      this.db
        .prepare("UPDATE asset_origin_artifacts SET status = 'claimed', updatedAt = ? WHERE id = ?")
        .run(Date.now(), row.id);
      return row;
    });
    const claimed = pickAndClaim();
    if (!claimed) return null;
    return {
      id: claimed.id,
      row: rawToRow(claimed),
    };
  }

  markUploaded(id: string, meta: UploadedMeta): void {
    this.db
      .prepare(
        `UPDATE asset_origin_artifacts
            SET status = 'uploaded', assetId = ?, contentHash = ?, updatedAt = ?
          WHERE id = ?`,
      )
      .run(meta.assetId, meta.contentHash, Date.now(), id);
  }

  /**
   * Record one failed upload attempt. Increments `attempts`, stores the
   * latest error, and either re-queues for retry (status -> 'pending') or
   * spills to dead-letter once attempts hit maxAttempts.
   */
  recordFailure(id: string, error: string, opts: RecordFailureOptions): void {
    const now = Date.now();
    const updated = this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT id, workspaceId, originKind, sourceRef, payloadJson, hintsJson,
                  observedAt, attempts, createdAt
             FROM asset_origin_artifacts
            WHERE id = ?`,
        )
        .get(id) as Omit<RawRow, 'lastError'> | undefined;
      if (!row) return;
      const nextAttempts = row.attempts + 1;
      if (nextAttempts >= opts.maxAttempts) {
        this.db
          .prepare(
            `INSERT INTO asset_origin_artifacts_dead_letter
             (id, workspaceId, originKind, sourceRef, payloadJson, hintsJson, observedAt, errorJson, attempts, createdAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            `dl_${randomUUID()}`,
            row.workspaceId,
            row.originKind,
            row.sourceRef,
            row.payloadJson,
            row.hintsJson,
            row.observedAt,
            JSON.stringify({ message: error, attempts: nextAttempts }),
            nextAttempts,
            now,
          );
        this.db.prepare('DELETE FROM asset_origin_artifacts WHERE id = ?').run(id);
      } else {
        this.db
          .prepare(
            `UPDATE asset_origin_artifacts
                SET status = 'pending', attempts = ?, lastError = ?, updatedAt = ?
              WHERE id = ?`,
          )
          .run(nextAttempts, error, now, id);
      }
    });
    updated();
  }

  /**
   * Re-promote any rows orphaned in `'claimed'` state back to `'pending'`.
   *
   * Why this exists: claimNext() transitions a row to 'claimed' under a
   * transaction, but the upload that follows runs OUTSIDE the transaction
   * (network call). If the daemon dies between the claim and the
   * markUploaded/recordFailure call, the row is stuck — claimNext() only
   * selects status='pending', so it would never be picked up again.
   *
   * Phase-0 single-worker safety: there is at most one in-flight claim at
   * any time, so on next process startup ANY 'claimed' row is by definition
   * orphaned. We promote it back to 'pending' (preserving attempts /
   * lastError) so the next drainOnce can retry it.
   *
   * If we ever go multi-worker, this naive sweep becomes unsafe and must be
   * replaced with a lease/heartbeat scheme.
   *
   * Returns the number of rows recovered (for logging / observability).
   */
  resetClaimed(): number {
    const result = this.db
      .prepare(
        "UPDATE asset_origin_artifacts SET status = 'pending', updatedAt = ? WHERE status = 'claimed'",
      )
      .run(Date.now());
    return Number(result.changes);
  }

  pendingCount(): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM asset_origin_artifacts WHERE status = 'pending'")
        .get() as { n: number }
    ).n;
  }

  uploadedCount(): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM asset_origin_artifacts WHERE status = 'uploaded'")
        .get() as { n: number }
    ).n;
  }

  deadLetterCount(): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM asset_origin_artifacts_dead_letter').get() as {
        n: number;
      }
    ).n;
  }

  close(): void {
    this.db.close();
  }
}

function computeIdempotencyKey(record: OriginObservationRecord): string {
  return createHash('sha256')
    .update(record.originKind as OriginKind)
    .update('|')
    .update(record.workspaceId)
    .update('|')
    .update(record.sourceRef)
    .update('|')
    .update(String(record.observedAt))
    .digest('hex');
}

/** Coerce an unknown value to a string for SQLite TEXT binding (dead-letter only). */
function coerceToString(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value;
  if (value == null) return fallback;
  return String(value);
}

/**
 * Coerce an unknown value to a JSON-serializable string for SQLite TEXT
 * binding. Used in the dead-letter path so an object/array passed where a
 * JSON-string was expected gets stored as `'{"foo":"bar"}'` instead of
 * throwing TYPE_MISMATCH.
 */
function coerceToJson(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '{}';
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
}

function rawToRow(raw: RawRow): OutboxRow {
  return {
    id: raw.id,
    workspaceId: raw.workspaceId,
    originKind: raw.originKind as OriginKind,
    sourceRef: raw.sourceRef,
    payloadJson: raw.payloadJson,
    hintsJson: raw.hintsJson,
    observedAt: raw.observedAt,
    attempts: raw.attempts,
    lastError: raw.lastError,
    createdAt: raw.createdAt,
  };
}
