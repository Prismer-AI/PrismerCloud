// Recall observation log — double-sign dataset store.
//
// release201/26 §14.5 Phase A (#A4 "double-sign recall observation log").
//
// During a turn the recall chain (axis A) computes "what we think is relevant".
// On the hermes path that chain runs in SHADOW (recall-only, no injection —
// §14.5 / §14.1). To later optimise the recall algorithm (axis A) + prompting
// (axis B) OFFLINE, we persist a DATASET per recall:
//
//   (query, our-recall result, hermes-recall result, mode, timestamp, ids)
//
// This module is the daemon-local store for that dataset. It is its OWN SQLite
// file `<baseDir>/<workspaceSlug>/recall-observations.db` and does NOT extend
// store.ts (kept additive / separate to avoid touching the fragile shared
// store). Mirrors store.ts conventions: better-sqlite3 + WAL, 0o600 db /
// 0o700 dir perms, single-row schema-version ratchet, prepared statements.
//
// NOTE: NOT wired into the live recall path yet — standalone + unit-tested.
// Deferred wiring is #A2 (hook-server.ts shadow path) per §14.10.

import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** One scored hit from a recall pass (our or hermes side). */
export interface RecallHit {
  /** Memory page path / identifier of the hit. */
  path: string;
  /** Relevance score (BM25 / cosine / provider-native — opaque to this store). */
  score: number;
  /** Short excerpt for offline eyeballing. */
  snippet: string;
}

/** How the recall result was consumed this turn. */
export type RecallMode = 'shadow' | 'inject' | 'stateless-inject';

/** A single recorded recall observation (insert input). */
export interface RecallObservation {
  /** ISO timestamp of the recall. Defaults to now() when omitted. */
  at?: string;
  workspaceId: string;
  /** Agent im_user id, when the recall is agent-scoped. */
  agentImUserId?: string | null;
  conversationId?: string | null;
  runId?: string | null;
  /** Hermes session id, when on the stateful sessions path. */
  sessionKey?: string | null;
  /** The recall query (the turn's effective question). */
  query: string;
  /** What our recall chain computed — array of {path, score, snippet}. */
  ourRecall: RecallHit[];
  /** What hermes actually had/used; null when unknown (builtin/unobservable). */
  hermesRecall?: RecallHit[] | null;
  mode: RecallMode;
  /** Whether the recall was injected into the live prompt this turn. */
  injected: boolean;
  /** Reserved for later turn-outcome scoring; null until graded offline. */
  outputQuality?: number | null;
}

/** A persisted row (read output) — includes the autoinc id + resolved `at`. */
export interface RecallObservationRow extends Omit<RecallObservation, 'at'> {
  id: number;
  at: string;
  agentImUserId: string | null;
  conversationId: string | null;
  runId: string | null;
  sessionKey: string | null;
  hermesRecall: RecallHit[] | null;
  outputQuality: number | null;
}

export interface RecallObservationStoreOptions {
  /** Absolute path to the SQLite database file. Parent dir created 0o700 if absent. */
  dbPath: string;
}

export interface RecallObservationStoreStats {
  dbPath: string;
  rowCount: number;
}

const SCHEMA_VERSION = 1;

const SCHEMA_V1_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS recall_observations_schema_version (
     version INTEGER PRIMARY KEY
   )`,
  `CREATE TABLE IF NOT EXISTS recall_observations (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at TEXT NOT NULL,
     workspaceId TEXT NOT NULL,
     agentImUserId TEXT,
     conversationId TEXT,
     runId TEXT,
     sessionKey TEXT,
     query TEXT NOT NULL,
     ourRecallJson TEXT NOT NULL,
     hermesRecallJson TEXT,
     mode TEXT NOT NULL,
     injected INTEGER NOT NULL DEFAULT 0,
     outputQuality REAL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_recall_obs_ws_conversation
     ON recall_observations(workspaceId, conversationId)`,
  `CREATE INDEX IF NOT EXISTS idx_recall_obs_at ON recall_observations(at)`,
];

interface ObsRow {
  id: number;
  at: string;
  workspaceId: string;
  agentImUserId: string | null;
  conversationId: string | null;
  runId: string | null;
  sessionKey: string | null;
  query: string;
  ourRecallJson: string;
  hermesRecallJson: string | null;
  mode: string;
  injected: number;
  outputQuality: number | null;
}

export interface RecallObservationListFilter {
  conversationId?: string;
  runId?: string;
  limit?: number;
}

export class RecallObservationStore {
  private db: Database.Database | null = null;

  constructor(private readonly opts: RecallObservationStoreOptions) {}

  open(): void {
    if (this.db) return;

    const dir = path.dirname(this.opts.dbPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // mkdirSync ignores mode if dir already exists; chmod best-effort on
      // non-POSIX filesystems where it may throw.
    }

    const dbExisted = fs.existsSync(this.opts.dbPath);
    const db = new Database(this.opts.dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');

    if (!dbExisted) {
      try {
        fs.chmodSync(this.opts.dbPath, 0o600);
      } catch {
        /* non-POSIX */
      }
    }

    for (const ddl of SCHEMA_V1_STATEMENTS) {
      db.prepare(ddl).run();
    }

    const versionRow = db
      .prepare('SELECT version FROM recall_observations_schema_version')
      .get() as { version: number } | undefined;
    if (!versionRow) {
      db.prepare('INSERT INTO recall_observations_schema_version (version) VALUES (?)').run(
        SCHEMA_VERSION,
      );
    } else if (versionRow.version > SCHEMA_VERSION) {
      db.close();
      throw new Error(
        `RecallObservationStore: db schema version ${versionRow.version} is newer than runtime ${SCHEMA_VERSION}; refusing to open`,
      );
    }
    // Future: if versionRow.version < SCHEMA_VERSION, run forward migrations here.

    this.db = db;
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  /** Insert one recall observation. */
  record(obs: RecallObservation): void {
    const db = this.requireDb();
    const at = obs.at ?? new Date().toISOString();
    db.prepare(
      `INSERT INTO recall_observations (
         at, workspaceId, agentImUserId, conversationId, runId, sessionKey,
         query, ourRecallJson, hermesRecallJson, mode, injected, outputQuality
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      at,
      obs.workspaceId,
      obs.agentImUserId ?? null,
      obs.conversationId ?? null,
      obs.runId ?? null,
      obs.sessionKey ?? null,
      obs.query,
      JSON.stringify(obs.ourRecall ?? []),
      obs.hermesRecall == null ? null : JSON.stringify(obs.hermesRecall),
      obs.mode,
      obs.injected ? 1 : 0,
      obs.outputQuality ?? null,
    );
  }

  /** List observations, newest first, optionally filtered by conversation/run. */
  list(filter?: RecallObservationListFilter): RecallObservationRow[] {
    const db = this.requireDb();
    const limit = Math.min(Math.max(filter?.limit ?? 100, 1), 1000);

    const where: string[] = [];
    const params: unknown[] = [];
    if (filter?.conversationId !== undefined) {
      where.push('conversationId = ?');
      params.push(filter.conversationId);
    }
    if (filter?.runId !== undefined) {
      where.push('runId = ?');
      params.push(filter.runId);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = db
      .prepare(
        `SELECT * FROM recall_observations ${whereSql} ORDER BY id DESC LIMIT ?`,
      )
      .all(...params, limit) as ObsRow[];
    return rows.map((r) => this.rowToObservation(r));
  }

  /** Total number of recorded observations. */
  count(): number {
    const db = this.requireDb();
    return (
      db.prepare('SELECT COUNT(*) AS n FROM recall_observations').get() as { n: number }
    ).n;
  }

  stats(): RecallObservationStoreStats {
    return { dbPath: this.opts.dbPath, rowCount: this.count() };
  }

  private requireDb(): Database.Database {
    if (!this.db) throw new Error('RecallObservationStore: open() must be called before use');
    return this.db;
  }

  private rowToObservation(row: ObsRow): RecallObservationRow {
    return {
      id: row.id,
      at: row.at,
      workspaceId: row.workspaceId,
      agentImUserId: row.agentImUserId,
      conversationId: row.conversationId,
      runId: row.runId,
      sessionKey: row.sessionKey,
      query: row.query,
      ourRecall: JSON.parse(row.ourRecallJson) as RecallHit[],
      hermesRecall:
        row.hermesRecallJson == null
          ? null
          : (JSON.parse(row.hermesRecallJson) as RecallHit[]),
      mode: row.mode as RecallMode,
      injected: row.injected === 1,
      outputQuality: row.outputQuality,
    };
  }
}
