// SQLite-backed memory store.
//
// One MemoryStore instance per workspace. Daemon owns the multi-workspace pool
// (rpc.ts resolves a store per request). Schema covers:
//
//   memory_schema_version    — single-row migration ratchet
//   memory_pages             — current state of each page (workspace-scoped UNIQUE on path)
//   memory_page_versions     — immutable version history
//   memory_page_content      — payload (inline plaintext or blobRef URI) per version
//   memory_links             — page→page graph (unique on workspace+source+target+relation)
//   memory_fts               — FTS5 virtual over title/path/description/content
//   memory_outbox            — write-only in phase-0 (worker disabled per dispatcher)
//   memory_outbox_dead_letter
//   memory_inbox_cursor      — phase-1 high-water mark for cloud→daemon sync
//
// File perms enforced on open(): 0o600 db file, 0o700 parent dir. Single
// workspace invariant: writes for a different workspaceId are rejected so a
// misrouted request cannot silently leak data across stores.

import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import type {
  MemoryPage,
  MemoryPageContent,
  MemoryLink,
  MemoryWriteInput,
  MemoryStats,
  MemoryPageType,
  MemoryVisibility,
  MemorySyncStatus,
} from './types.js';
import { sealPlaintext } from './crypto.js';

export interface MemoryStoreOptions {
  /** Absolute path to the SQLite database file. Parent dir created with 0o700 if absent. */
  dbPath: string;
  /** Workspace this store belongs to. Reject ops referencing other workspaces. */
  workspaceId: string;
  /** Device identifier. Stamped onto version + outbox rows at write time. */
  deviceId: string;
}

const SCHEMA_VERSION = 1;

// DDL split per-statement so each can run via prepare().run(); avoids the
// multi-statement batch API and keeps the schema easy to diff per table.
const SCHEMA_V1_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS memory_schema_version (
     version INTEGER PRIMARY KEY
   )`,
  `CREATE TABLE IF NOT EXISTS memory_pages (
     id TEXT PRIMARY KEY,
     workspaceId TEXT NOT NULL,
     path TEXT NOT NULL,
     title TEXT,
     description TEXT,
     contentHash TEXT NOT NULL,
     version INTEGER NOT NULL DEFAULT 1,
     pageType TEXT NOT NULL DEFAULT 'leaf',
     visibilityKind TEXT NOT NULL DEFAULT 'workspace',
     visibilityImUserId TEXT,
     encrypted INTEGER NOT NULL DEFAULT 0,
     stale INTEGER NOT NULL DEFAULT 0,
     archivedAt INTEGER,
     sourceAssetId TEXT,
     sourceRefsJson TEXT NOT NULL DEFAULT '[]',
     syncStatus TEXT NOT NULL DEFAULT 'local-only',
     createdAt INTEGER NOT NULL,
     updatedAt INTEGER NOT NULL,
     UNIQUE(workspaceId, path)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_memory_pages_workspace_type ON memory_pages(workspaceId, pageType)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_pages_workspace_updated ON memory_pages(workspaceId, updatedAt DESC)`,
  `CREATE TABLE IF NOT EXISTS memory_page_versions (
     pageId TEXT NOT NULL,
     version INTEGER NOT NULL,
     contentHash TEXT NOT NULL,
     actorImUserId TEXT NOT NULL,
     actorKind TEXT NOT NULL,
     deviceId TEXT NOT NULL,
     createdAt INTEGER NOT NULL,
     PRIMARY KEY (pageId, version),
     FOREIGN KEY (pageId) REFERENCES memory_pages(id) ON DELETE CASCADE
   )`,
  `CREATE TABLE IF NOT EXISTS memory_page_content (
     pageId TEXT NOT NULL,
     version INTEGER NOT NULL,
     payloadKind TEXT NOT NULL,
     payloadValue TEXT NOT NULL,
     PRIMARY KEY (pageId, version),
     FOREIGN KEY (pageId, version) REFERENCES memory_page_versions(pageId, version) ON DELETE CASCADE
   )`,
  `CREATE TABLE IF NOT EXISTS memory_links (
     workspaceId TEXT NOT NULL,
     sourceUri TEXT NOT NULL,
     targetUri TEXT NOT NULL,
     relation TEXT NOT NULL,
     weight REAL NOT NULL DEFAULT 1.0,
     extractedFromPageId TEXT,
     createdAt INTEGER NOT NULL,
     PRIMARY KEY (workspaceId, sourceUri, targetUri, relation)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_memory_links_target ON memory_links(workspaceId, targetUri, relation)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
     pageId UNINDEXED,
     workspaceId UNINDEXED,
     path,
     title,
     description,
     content,
     tokenize = 'porter unicode61 remove_diacritics 1'
   )`,
  `CREATE TABLE IF NOT EXISTS memory_outbox (
     id TEXT PRIMARY KEY,
     eventType TEXT NOT NULL,
     envelopeJson TEXT NOT NULL,
     idempotencyKey TEXT NOT NULL UNIQUE,
     status TEXT NOT NULL DEFAULT 'pending',
     createdAt INTEGER NOT NULL,
     ackedAt INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS idx_memory_outbox_status ON memory_outbox(status, createdAt)`,
  `CREATE TABLE IF NOT EXISTS memory_outbox_dead_letter (
     id TEXT PRIMARY KEY,
     eventType TEXT,
     rawJson TEXT NOT NULL,
     errorJson TEXT NOT NULL,
     createdAt INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS memory_inbox_cursor (
     workspaceId TEXT PRIMARY KEY,
     cursor TEXT NOT NULL,
     updatedAt INTEGER NOT NULL
   )`,
];

interface PageRow {
  id: string;
  workspaceId: string;
  path: string;
  title: string | null;
  description: string | null;
  contentHash: string;
  version: number;
  pageType: string;
  visibilityKind: string;
  visibilityImUserId: string | null;
  encrypted: number;
  stale: number;
  archivedAt: number | null;
  sourceAssetId: string | null;
  sourceRefsJson: string;
  syncStatus: string;
  createdAt: number;
  updatedAt: number;
}

export class MemoryStore {
  private db: Database.Database | null = null;

  constructor(private readonly opts: MemoryStoreOptions) {}

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
    db.pragma('foreign_keys = ON');
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
      .prepare('SELECT version FROM memory_schema_version')
      .get() as { version: number } | undefined;
    if (!versionRow) {
      db.prepare('INSERT INTO memory_schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
    } else if (versionRow.version > SCHEMA_VERSION) {
      db.close();
      throw new Error(
        `MemoryStore: db schema version ${versionRow.version} is newer than runtime ${SCHEMA_VERSION}; refusing to open`,
      );
    }
    // Future: if versionRow.version < SCHEMA_VERSION, run forward migrations here.

    this.db = db;
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  loadByPath(pagePath: string): MemoryPage | null {
    const db = this.requireDb();
    const row = db
      .prepare('SELECT * FROM memory_pages WHERE workspaceId = ? AND path = ?')
      .get(this.opts.workspaceId, pagePath) as PageRow | undefined;
    return row ? this.rowToPage(row) : null;
  }

  loadById(pageId: string): MemoryPage | null {
    const db = this.requireDb();
    const row = db
      .prepare('SELECT * FROM memory_pages WHERE workspaceId = ? AND id = ?')
      .get(this.opts.workspaceId, pageId) as PageRow | undefined;
    return row ? this.rowToPage(row) : null;
  }

  loadContent(pageId: string, version?: number): MemoryPageContent | null {
    const db = this.requireDb();
    const targetVersion =
      version ??
      (
        db
          .prepare('SELECT version FROM memory_pages WHERE workspaceId = ? AND id = ?')
          .get(this.opts.workspaceId, pageId) as { version: number } | undefined
      )?.version;
    if (targetVersion === undefined) return null;
    const row = db
      .prepare(
        `SELECT c.pageId, c.version, c.payloadKind, c.payloadValue
         FROM memory_page_content c
         JOIN memory_pages p ON p.id = c.pageId
         WHERE p.workspaceId = ? AND c.pageId = ? AND c.version = ?`,
      )
      .get(this.opts.workspaceId, pageId, targetVersion) as
      | { pageId: string; version: number; payloadKind: string; payloadValue: string }
      | undefined;
    if (!row) return null;
    if (row.payloadKind !== 'inline') {
      throw new Error(
        `MemoryStore.loadContent: pageId=${pageId} v${row.version} stored as ${row.payloadKind}; M4 encryption not yet implemented`,
      );
    }
    return { pageId: row.pageId, version: row.version, content: row.payloadValue };
  }

  list(options?: { pageType?: MemoryPageType; limit?: number }): MemoryPage[] {
    const db = this.requireDb();
    const limit = Math.min(Math.max(options?.limit ?? 100, 1), 1000);
    const rows = options?.pageType
      ? (db
          .prepare(
            `SELECT * FROM memory_pages
             WHERE workspaceId = ? AND pageType = ?
             ORDER BY updatedAt DESC LIMIT ?`,
          )
          .all(this.opts.workspaceId, options.pageType, limit) as PageRow[])
      : (db
          .prepare(
            `SELECT * FROM memory_pages
             WHERE workspaceId = ?
             ORDER BY updatedAt DESC LIMIT ?`,
          )
          .all(this.opts.workspaceId, limit) as PageRow[]);
    return rows.map((r) => this.rowToPage(r));
  }

  write(input: MemoryWriteInput): MemoryPage {
    if (input.workspaceId !== this.opts.workspaceId) {
      throw new Error(
        `MemoryStore.write: workspace mismatch (store=${this.opts.workspaceId}, input=${input.workspaceId})`,
      );
    }
    const db = this.requireDb();
    const now = Date.now();
    const contentHash = sha256(input.content);
    const payload = sealPlaintext(input.content);
    if (payload.kind !== 'inline') {
      throw new Error('MemoryStore.write: non-inline payload not yet supported in phase-0');
    }
    const visibility = input.visibility ?? { kind: 'workspace' };
    const visibilityImUserId = visibility.kind === 'workspace' ? null : visibility.imUserId;
    const sourceRefsJson = JSON.stringify(input.sourceRefs ?? []);

    const existing = db
      .prepare(
        'SELECT id, version, createdAt FROM memory_pages WHERE workspaceId = ? AND path = ?',
      )
      .get(this.opts.workspaceId, input.path) as
      | { id: string; version: number; createdAt: number }
      | undefined;

    const pageId = existing?.id ?? `page_${randomUUID().replace(/-/g, '').slice(0, 22)}`;
    const newVersion = (existing?.version ?? 0) + 1;
    const createdAt = existing?.createdAt ?? now;

    const staleFlag = input.stale ? 1 : 0;
    const insertPage = db.prepare(`
      INSERT INTO memory_pages (
        id, workspaceId, path, title, description, contentHash, version,
        pageType, visibilityKind, visibilityImUserId, encrypted, stale,
        archivedAt, sourceAssetId, sourceRefsJson, syncStatus,
        createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?, 'local-only', ?, ?)
      ON CONFLICT(workspaceId, path) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        contentHash = excluded.contentHash,
        version = excluded.version,
        pageType = excluded.pageType,
        visibilityKind = excluded.visibilityKind,
        visibilityImUserId = excluded.visibilityImUserId,
        sourceAssetId = excluded.sourceAssetId,
        sourceRefsJson = excluded.sourceRefsJson,
        stale = excluded.stale,
        updatedAt = excluded.updatedAt
    `);

    const insertVersion = db.prepare(`
      INSERT INTO memory_page_versions (pageId, version, contentHash, actorImUserId, actorKind, deviceId, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const insertContent = db.prepare(`
      INSERT INTO memory_page_content (pageId, version, payloadKind, payloadValue)
      VALUES (?, ?, ?, ?)
    `);

    const deleteFts = db.prepare('DELETE FROM memory_fts WHERE pageId = ?');
    const insertFts = db.prepare(`
      INSERT INTO memory_fts (pageId, workspaceId, path, title, description, content)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const tx = db.transaction(() => {
      insertPage.run(
        pageId,
        this.opts.workspaceId,
        input.path,
        input.title ?? null,
        input.description ?? null,
        contentHash,
        newVersion,
        input.pageType ?? 'leaf',
        visibility.kind,
        visibilityImUserId,
        staleFlag,
        input.sourceAssetId ?? null,
        sourceRefsJson,
        createdAt,
        now,
      );
      insertVersion.run(
        pageId,
        newVersion,
        contentHash,
        input.actorImUserId,
        input.actorKind,
        this.opts.deviceId,
        now,
      );
      insertContent.run(pageId, newVersion, payload.kind, payload.content);
      deleteFts.run(pageId);
      insertFts.run(
        pageId,
        this.opts.workspaceId,
        input.path,
        input.title ?? '',
        input.description ?? '',
        input.content,
      );
    });
    tx();

    const written = this.loadById(pageId);
    if (!written) throw new Error('MemoryStore.write: post-write loadById returned null');
    return written;
  }

  invalidate(pageIds: string[], _reason: string): void {
    if (pageIds.length === 0) return;
    const db = this.requireDb();
    const placeholders = pageIds.map(() => '?').join(',');
    const ownPages = db
      .prepare(
        `SELECT id FROM memory_pages WHERE workspaceId = ? AND id IN (${placeholders})`,
      )
      .all(this.opts.workspaceId, ...pageIds) as { id: string }[];
    if (ownPages.length === 0) return;
    const ownIds = ownPages.map((r) => r.id);
    const ownPlaceholders = ownIds.map(() => '?').join(',');

    const deletePages = db.prepare(`DELETE FROM memory_pages WHERE id IN (${ownPlaceholders})`);
    const deleteFts = db.prepare(`DELETE FROM memory_fts WHERE pageId IN (${ownPlaceholders})`);

    db.transaction(() => {
      deletePages.run(...ownIds); // CASCADE removes versions + content
      deleteFts.run(...ownIds);
    })();
  }

  upsertLink(link: MemoryLink): void {
    const db = this.requireDb();
    db.prepare(
      `INSERT INTO memory_links (workspaceId, sourceUri, targetUri, relation, weight, extractedFromPageId, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspaceId, sourceUri, targetUri, relation) DO UPDATE SET
         weight = excluded.weight,
         extractedFromPageId = excluded.extractedFromPageId`,
    ).run(
      this.opts.workspaceId,
      link.sourceUri,
      link.targetUri,
      link.relation,
      link.weight,
      link.extractedFromPageId,
      Date.now(),
    );
  }

  stats(): MemoryStats {
    const db = this.requireDb();
    const pageCount = (
      db
        .prepare('SELECT COUNT(*) AS n FROM memory_pages WHERE workspaceId = ?')
        .get(this.opts.workspaceId) as { n: number }
    ).n;
    const pendingOutbox = (
      db.prepare("SELECT COUNT(*) AS n FROM memory_outbox WHERE status = 'pending'").get() as {
        n: number;
      }
    ).n;
    const deadLetterCount = (
      db.prepare('SELECT COUNT(*) AS n FROM memory_outbox_dead_letter').get() as { n: number }
    ).n;
    const cursorRow = db
      .prepare('SELECT updatedAt FROM memory_inbox_cursor WHERE workspaceId = ?')
      .get(this.opts.workspaceId) as { updatedAt: number } | undefined;
    return {
      workspaceId: this.opts.workspaceId,
      pageCount,
      pendingOutbox,
      deadLetterCount,
      lastSyncAt: cursorRow?.updatedAt ?? null,
      dbPath: this.opts.dbPath,
    };
  }

  /**
   * Record sync cursor for incremental sync. Used by cloud-sync.ts to
   * persist the high-water mark for future cursor-based catch-up.
   */
  recordCursor(workspaceId: string, cursor: string): void {
    const now = Date.now();
    this.requireDb()
      .prepare(
        `INSERT OR REPLACE INTO memory_inbox_cursor (workspaceId, cursor, updatedAt) VALUES (?, ?, ?)`,
      )
      .run(workspaceId, cursor, now);
  }

  /**
   * Internal accessor for outbox.ts — outbox writes its own table within the
   * same DB. Returning the live Database handle keeps outbox transactions
   * shareable with store transactions if ever needed.
   */
  rawDb(): Database.Database {
    return this.requireDb();
  }

  /** Workspace this store is bound to (read-only). */
  workspaceId(): string {
    return this.opts.workspaceId;
  }

  /** Device id stamped onto version + outbox rows. */
  deviceId(): string {
    return this.opts.deviceId;
  }

  private requireDb(): Database.Database {
    if (!this.db) throw new Error('MemoryStore: open() must be called before use');
    return this.db;
  }

  private rowToPage(row: PageRow): MemoryPage {
    const visibility: MemoryVisibility =
      row.visibilityKind === 'workspace'
        ? { kind: 'workspace' }
        : row.visibilityKind === 'agent'
          ? { kind: 'agent', imUserId: row.visibilityImUserId ?? '' }
          : { kind: 'private', imUserId: row.visibilityImUserId ?? '' };
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      path: row.path,
      title: row.title,
      description: row.description,
      contentHash: row.contentHash,
      version: row.version,
      pageType: row.pageType as MemoryPageType,
      visibility,
      encrypted: row.encrypted === 1,
      stale: row.stale === 1,
      archivedAt: row.archivedAt,
      sourceAssetId: row.sourceAssetId,
      sourceRefs: JSON.parse(row.sourceRefsJson) as string[],
      syncStatus: row.syncStatus as MemorySyncStatus,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}
