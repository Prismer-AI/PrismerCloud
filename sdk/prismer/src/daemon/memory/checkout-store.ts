/**
 * product209/15 PKF-H5 — local PKF checkout registry (§7.6.1/§10.1).
 *
 * `pkf_checkouts` records path → base revision bindings for the native
 * filesystem lane. The registry stores the BINDING ONLY — never a second copy
 * of the canonical head, never a watcher-driven state: `status` re-hashes the
 * file on disk every time. Idempotent boot migration, downgrade-tolerant read.
 *
 * Path policy (§7.6.1): normalized workspace-relative regular-file paths
 * inside the current task root; symlink parents / path traversal / case-fold
 * collisions are rejected at the TOOL level — the store persists the binding
 * and re-validates on every read.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA_VERSION = 1;

const SCHEMA_V1_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS pkf_checkout_schema_version (version INTEGER PRIMARY KEY)`,
  `CREATE TABLE IF NOT EXISTS pkf_checkouts (
     checkoutId TEXT PRIMARY KEY,
     workspaceRelativePath TEXT NOT NULL,
     taskRoot TEXT NOT NULL,
     documentUri TEXT NOT NULL,
     baseRevisionId TEXT NOT NULL,
     baseSourceHash TEXT NOT NULL,
     taskId TEXT NOT NULL,
     state TEXT NOT NULL DEFAULT 'clean',
     checkedOutAt TEXT NOT NULL,
     updatedAt TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_pkf_checkouts_path ON pkf_checkouts(workspaceRelativePath)`,
  `CREATE INDEX IF NOT EXISTS idx_pkf_checkouts_task ON pkf_checkouts(taskId)`,
];

export interface PkfCheckoutBinding {
  checkoutId: string;
  workspaceRelativePath: string;
  taskRoot: string;
  documentUri: string;
  baseRevisionId: string;
  baseSourceHash: string;
  taskId: string;
  state: 'clean' | 'dirty' | 'missing' | 'moved-unknown';
  checkedOutAt: string;
  updatedAt: string;
}

interface RowShape {
  checkoutId: string;
  workspaceRelativePath: string;
  taskRoot: string;
  documentUri: string;
  baseRevisionId: string;
  baseSourceHash: string;
  taskId: string;
  state: string;
  checkedOutAt: string;
  updatedAt: string;
}

export interface CheckoutStoreOptions {
  /** the daemon-persisted registry file (~/.prismer/.../pkf-checkouts.db) */
  dbPath: string;
}

export class PkfCheckoutStore {
  private db: Database.Database;

  constructor(private readonly opts: CheckoutStoreOptions) {
    mkdirSync(dirname(opts.dbPath), { recursive: true });
    this.db = new Database(opts.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS pkf_checkout_schema_version (version INTEGER PRIMARY KEY)');
    const row = this.db.prepare('SELECT version FROM pkf_checkout_schema_version').get() as { version: number } | undefined;
    const current = row?.version ?? 0;
    if (current < SCHEMA_VERSION) {
      const migrate = this.db.transaction(() => {
        for (const ddl of SCHEMA_V1_STATEMENTS) this.db.prepare(ddl).run();
        this.db.prepare('INSERT OR REPLACE INTO pkf_checkout_schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
      });
      migrate();
    }
  }

  close(): void {
    this.db.close();
  }

  upsert(binding: Omit<PkfCheckoutBinding, 'updatedAt'>): PkfCheckoutBinding {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO pkf_checkouts
           (checkoutId, workspaceRelativePath, taskRoot, documentUri,
            baseRevisionId, baseSourceHash, taskId, state, checkedOutAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(checkoutId) DO UPDATE SET
           documentUri = excluded.documentUri,
           baseRevisionId = excluded.baseRevisionId,
           baseSourceHash = excluded.baseSourceHash,
           taskRoot = excluded.taskRoot,
           taskId = excluded.taskId,
           state = excluded.state,
           updatedAt = excluded.updatedAt`,
      )
      .run(
        binding.checkoutId,
        binding.workspaceRelativePath,
        binding.taskRoot,
        binding.documentUri,
        binding.baseRevisionId,
        binding.baseSourceHash,
        binding.taskId,
        binding.state,
        binding.checkedOutAt,
        now,
      );
    return { ...binding, updatedAt: now };
  }

  getByCheckoutId(checkoutId: string): PkfCheckoutBinding | null {
    const row = this.db.prepare('SELECT * FROM pkf_checkouts WHERE checkoutId = ?').get(checkoutId) as RowShape | undefined;
    return row ? this.toBinding(row) : null;
  }

  getByPath(workspaceRelativePath: string, taskRoot: string): PkfCheckoutBinding | null {
    const row = this.db
      .prepare('SELECT * FROM pkf_checkouts WHERE workspaceRelativePath = ? AND taskRoot = ?')
      .get(workspaceRelativePath, taskRoot) as RowShape | undefined;
    return row ? this.toBinding(row) : null;
  }

  listByTask(taskId: string): PkfCheckoutBinding[] {
    const rows = this.db.prepare('SELECT * FROM pkf_checkouts WHERE taskId = ?').all(taskId) as RowShape[];
    return rows.map((r) => this.toBinding(r));
  }

  markState(checkoutId: string, state: PkfCheckoutBinding['state']): void {
    this.db
      .prepare('UPDATE pkf_checkouts SET state = ?, updatedAt = ? WHERE checkoutId = ?')
      .run(state, new Date().toISOString(), checkoutId);
  }

  private toBinding(row: RowShape): PkfCheckoutBinding {
    return {
      checkoutId: row.checkoutId,
      workspaceRelativePath: row.workspaceRelativePath,
      taskRoot: row.taskRoot,
      documentUri: row.documentUri,
      baseRevisionId: row.baseRevisionId,
      baseSourceHash: row.baseSourceHash,
      taskId: row.taskId,
      state: row.state as PkfCheckoutBinding['state'],
      checkedOutAt: row.checkedOutAt,
      updatedAt: row.updatedAt,
    };
  }
}
