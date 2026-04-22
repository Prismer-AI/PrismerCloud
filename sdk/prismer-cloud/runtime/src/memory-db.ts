import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { createContentCrypto, type ContentCrypto } from './memory-db-crypto.js';

export interface EncryptionConfig {
  enabled: boolean;
  key?: Buffer;
}

export interface MemoryFile {
  id: string;
  ownerId: string;
  ownerType: 'user' | 'agent';
  scope: string;
  path: string;
  content: string;
  version: number;
  memoryType?: string;
  description?: string;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
  stale: boolean;
}

export interface MemoryFileVersion {
  id: string;
  fileId: string;
  version: number;
  content: string;
  createdAt: string;
}

export interface DreamCompaction {
  id: string;
  ownerId: string;
  scope: string;
  summary: string;
  createdAt: string;
}

export interface WriteMemoryFileInput {
  ownerId: string;
  ownerType: 'user' | 'agent';
  scope?: string;
  path: string;
  content: string;
  memoryType?: string;
  description?: string;
}

export interface MemoryFileFilters {
  ownerId?: string;
  scope?: string;
  path?: string;
  memoryType?: string;
  stale?: boolean;
  limit?: number;
  offset?: number;
}

export interface MemorySearchResult extends MemoryFile {
  relevance: number;
  snippet?: string;
}

export interface MemoryStats {
  fileCount: number;
  totalSize: number;
  totalBytes: number;
  staleFiles: number;
  ftsIndexed: number;
  recallP95: number;
}

function defaultStorePath(): string {
  return path.join(os.homedir(), '.prismer', 'memory.db');
}

function nowIso(): string {
  return new Date().toISOString();
}

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/** Map a raw SQLite row (stale as 0|1) to a MemoryFile interface object.
 *  `decryptContent` is applied to the raw content column so that plaintext
 *  rows pass through and ciphertext envelopes are unwrapped transparently. */
function rowToMemoryFile(
  row: Record<string, unknown>,
  decryptContent: (v: string) => string = (v) => v,
): MemoryFile {
  return {
    id: row.id as string,
    ownerId: row.ownerId as string,
    ownerType: row.ownerType as 'user' | 'agent',
    scope: row.scope as string,
    path: row.path as string,
    content: decryptContent(row.content as string),
    version: row.version as number,
    memoryType: (row.memoryType as string) || undefined,
    description: (row.description as string) || undefined,
    contentHash: row.contentHash as string,
    createdAt: row.createdAt as string,
    updatedAt: row.updatedAt as string,
    stale: (row.stale as number) === 1,
  };
}

// ---------------------------------------------------------------------------
// Schema DDL
// ---------------------------------------------------------------------------

const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS memory_files (
  id TEXT PRIMARY KEY,
  ownerId TEXT NOT NULL,
  ownerType TEXT NOT NULL DEFAULT 'user',
  scope TEXT NOT NULL DEFAULT 'global',
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  memoryType TEXT,
  description TEXT,
  contentHash TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0,
  UNIQUE(ownerId, scope, path)
);

CREATE TABLE IF NOT EXISTS memory_file_versions (
  id TEXT PRIMARY KEY,
  fileId TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  FOREIGN KEY (fileId) REFERENCES memory_files(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS memory_dreams (
  id TEXT PRIMARY KEY,
  ownerId TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'global',
  summary TEXT NOT NULL,
  createdAt TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  path,
  description,
  content,
  content=memory_files,
  content_rowid=rowid
);

CREATE TRIGGER IF NOT EXISTS memory_fts_ai AFTER INSERT ON memory_files BEGIN
  INSERT INTO memory_fts(rowid, path, description, content)
  VALUES (new.rowid, new.path, COALESCE(new.description, ''), new.content);
END;

CREATE TRIGGER IF NOT EXISTS memory_fts_ad AFTER DELETE ON memory_files BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, path, description, content)
  VALUES ('delete', old.rowid, old.path, COALESCE(old.description, ''), old.content);
END;

CREATE TRIGGER IF NOT EXISTS memory_fts_au AFTER UPDATE ON memory_files BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, path, description, content)
  VALUES ('delete', old.rowid, old.path, COALESCE(old.description, ''), old.content);
  INSERT INTO memory_fts(rowid, path, description, content)
  VALUES (new.rowid, new.path, COALESCE(new.description, ''), new.content);
END;
`;

// ---------------------------------------------------------------------------
// JSON migration helper
// ---------------------------------------------------------------------------

interface LegacyStoreShape {
  files: MemoryFile[];
  versions: MemoryFileVersion[];
  dreams: DreamCompaction[];
}

function migrateFromJson(jsonPath: string, db: BetterSqlite3.Database): void {
  let raw: string;
  try {
    raw = fs.readFileSync(jsonPath, 'utf-8');
  } catch {
    return; // JSON file unreadable -- skip
  }

  let parsed: Partial<LegacyStoreShape>;
  try {
    parsed = JSON.parse(raw) as Partial<LegacyStoreShape>;
  } catch {
    return; // malformed JSON -- skip
  }

  const files = Array.isArray(parsed.files) ? parsed.files : [];
  const versions = Array.isArray(parsed.versions) ? parsed.versions : [];
  const dreams = Array.isArray(parsed.dreams) ? parsed.dreams : [];

  if (files.length === 0 && versions.length === 0 && dreams.length === 0) {
    return;
  }

  const insertFile = db.prepare(`
    INSERT OR IGNORE INTO memory_files
      (id, ownerId, ownerType, scope, path, content, version, memoryType, description, contentHash, createdAt, updatedAt, stale)
    VALUES
      (@id, @ownerId, @ownerType, @scope, @path, @content, @version, @memoryType, @description, @contentHash, @createdAt, @updatedAt, @stale)
  `);

  const insertVersion = db.prepare(`
    INSERT OR IGNORE INTO memory_file_versions
      (id, fileId, version, content, createdAt)
    VALUES
      (@id, @fileId, @version, @content, @createdAt)
  `);

  const insertDream = db.prepare(`
    INSERT OR IGNORE INTO memory_dreams
      (id, ownerId, scope, summary, createdAt)
    VALUES
      (@id, @ownerId, @scope, @summary, @createdAt)
  `);

  const importAll = db.transaction(() => {
    for (const f of files) {
      insertFile.run({
        id: f.id,
        ownerId: f.ownerId,
        ownerType: f.ownerType,
        scope: f.scope,
        path: f.path,
        content: f.content,
        version: f.version,
        memoryType: f.memoryType ?? null,
        description: f.description ?? null,
        contentHash: f.contentHash,
        createdAt: f.createdAt,
        updatedAt: f.updatedAt,
        stale: f.stale ? 1 : 0,
      });
    }
    for (const v of versions) {
      insertVersion.run({
        id: v.id,
        fileId: v.fileId,
        version: v.version,
        content: v.content,
        createdAt: v.createdAt,
      });
    }
    for (const d of dreams) {
      insertDream.run({
        id: d.id,
        ownerId: d.ownerId,
        scope: d.scope,
        summary: d.summary,
        createdAt: d.createdAt,
      });
    }
  });

  importAll();

  // Rename JSON file to .migrated so it is not re-imported
  try {
    fs.renameSync(jsonPath, jsonPath + '.migrated');
  } catch {
    // best effort
  }
}

// ---------------------------------------------------------------------------
// MemoryDB class -- SQLite + FTS5
// ---------------------------------------------------------------------------

export class MemoryDB {
  private readonly filePath: string;
  private readonly db: BetterSqlite3.Database;
  private readonly crypto: ContentCrypto;

  constructor(_encryptionConfig: EncryptionConfig = { enabled: false }, opts?: { filePath?: string }) {
    this.filePath = opts?.filePath ?? defaultStorePath();
    // v1.9.0 opt-in: content encryption via env var PRISMER_DB_ENCRYPTION=1.
    // The legacy `_encryptionConfig` parameter is retained for API stability but
    // the actual switch is the env var — this matches how @prismer/runtime
    // reads secrets everywhere else (keychain + env indirection).
    this.crypto = createContentCrypto();

    // Ensure parent directory exists
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });

    this.db = new Database(this.filePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    // Create schema
    this.db.exec(SCHEMA_DDL);

    // Migrate from legacy JSON file if it exists and DB is fresh
    const jsonPath = this.filePath.replace(/\.db$/, '.json');
    if (jsonPath !== this.filePath && fs.existsSync(jsonPath)) {
      const count = (this.db.prepare('SELECT COUNT(*) AS cnt FROM memory_files').get() as { cnt: number }).cnt;
      if (count === 0) {
        migrateFromJson(jsonPath, this.db);
      }
    }
  }

  writeMemoryFile(input: WriteMemoryFileInput): MemoryFile {
    const scope = input.scope ?? 'global';
    const timestamp = nowIso();

    const existing = this.db.prepare(
      'SELECT * FROM memory_files WHERE ownerId = ? AND scope = ? AND path = ?',
    ).get(input.ownerId, scope, input.path) as Record<string, unknown> | undefined;

    if (existing) {
      const newVersion = (existing.version as number) + 1;
      const newHash = hashContent(input.content);
      const encryptedContent = this.crypto.encrypt(input.content);

      // Wrap version insert + file update in a transaction to prevent
      // phantom version records on crash (C3 review fix).
      const updateTx = this.db.transaction(() => {
        // Save old version — keep whatever envelope it was stored as
        // (plaintext or ciphertext). Lazy migration means we don't force
        // re-encrypt of history; old rows stay in their original form.
        this.db.prepare(`
          INSERT INTO memory_file_versions (id, fileId, version, content, createdAt)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          crypto.randomUUID(),
          existing.id as string,
          existing.version as number,
          existing.content as string,
          timestamp,
        );

        // Update existing file with (possibly encrypted) new content
        this.db.prepare(`
          UPDATE memory_files
          SET content = ?, version = ?, memoryType = ?, description = ?,
              contentHash = ?, updatedAt = ?, stale = 0
          WHERE id = ?
        `).run(
          encryptedContent,
          newVersion,
          input.memoryType ?? null,
          input.description ?? null,
          newHash,
          timestamp,
          existing.id as string,
        );
      });
      updateTx();

      return {
        id: existing.id as string,
        ownerId: existing.ownerId as string,
        ownerType: existing.ownerType as 'user' | 'agent',
        scope: existing.scope as string,
        path: existing.path as string,
        content: input.content,
        version: newVersion,
        memoryType: input.memoryType,
        description: input.description,
        contentHash: newHash,
        createdAt: existing.createdAt as string,
        updatedAt: timestamp,
        stale: false,
      };
    }

    // Insert new file
    const id = crypto.randomUUID();
    const contentHash = hashContent(input.content);
    this.db.prepare(`
      INSERT INTO memory_files
        (id, ownerId, ownerType, scope, path, content, version, memoryType, description, contentHash, createdAt, updatedAt, stale)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 0)
    `).run(
      id,
      input.ownerId,
      input.ownerType,
      scope,
      input.path,
      this.crypto.encrypt(input.content),
      input.memoryType ?? null,
      input.description ?? null,
      contentHash,
      timestamp,
      timestamp,
    );

    return {
      id,
      ownerId: input.ownerId,
      ownerType: input.ownerType,
      scope,
      path: input.path,
      content: input.content,
      version: 1,
      memoryType: input.memoryType,
      description: input.description,
      contentHash,
      createdAt: timestamp,
      updatedAt: timestamp,
      stale: false,
    };
  }

  getMemoryFileById(id: string): MemoryFile | null {
    const row = this.db.prepare('SELECT * FROM memory_files WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? rowToMemoryFile(row, this.crypto.decrypt) : null;
  }

  deleteMemoryFile(id: string): boolean {
    // Versions are deleted via ON DELETE CASCADE
    const result = this.db.prepare('DELETE FROM memory_files WHERE id = ?').run(id);
    return result.changes > 0;
  }

  listMemoryFiles(filters: MemoryFileFilters = {}): MemoryFile[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.ownerId) {
      conditions.push('ownerId = ?');
      params.push(filters.ownerId);
    }
    if (filters.scope) {
      conditions.push('scope = ?');
      params.push(filters.scope);
    }
    if (filters.path) {
      conditions.push('path = ?');
      params.push(filters.path);
    }
    if (filters.memoryType) {
      conditions.push('memoryType = ?');
      params.push(filters.memoryType);
    }
    if (filters.stale !== undefined) {
      conditions.push('stale = ?');
      params.push(filters.stale ? 1 : 0);
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const limit = filters.limit ?? 50;
    const offset = filters.offset ?? 0;

    const sql = `SELECT * FROM memory_files ${where} ORDER BY updatedAt DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map((r) => rowToMemoryFile(r, this.crypto.decrypt));
  }

  searchMemoryFiles(keyword: string, filters: MemoryFileFilters = {}): MemorySearchResult[] {
    const terms = keyword
      .toLowerCase()
      .split(/\s+/)
      .map((term) => term.trim())
      .filter(Boolean);

    if (terms.length === 0) return [];

    // Build FTS5 match expression: each term quoted for safety
    const ftsQuery = terms.map((t) => '"' + t.replace(/"/g, '""') + '"').join(' ');

    const conditions: string[] = [];
    const params: unknown[] = [ftsQuery];

    if (filters.ownerId) {
      conditions.push('m.ownerId = ?');
      params.push(filters.ownerId);
    }
    if (filters.scope) {
      conditions.push('m.scope = ?');
      params.push(filters.scope);
    }
    if (filters.path) {
      conditions.push('m.path = ?');
      params.push(filters.path);
    }
    if (filters.memoryType) {
      conditions.push('m.memoryType = ?');
      params.push(filters.memoryType);
    }
    if (filters.stale !== undefined) {
      conditions.push('m.stale = ?');
      params.push(filters.stale ? 1 : 0);
    }

    const extraWhere = conditions.length > 0 ? 'AND ' + conditions.join(' AND ') : '';
    const limit = filters.limit ?? 10;
    params.push(limit);

    const sql = `
      SELECT m.*, bm25(memory_fts, 5.0, 3.0, 1.0) AS rank,
             snippet(memory_fts, 2, '', '', '...', 30) AS fts_snippet
      FROM memory_fts f
      JOIN memory_files m ON f.rowid = m.rowid
      WHERE memory_fts MATCH ?
      ${extraWhere}
      ORDER BY rank
      LIMIT ?
    `;

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;

    return rows.map((row) => {
      const file = rowToMemoryFile(row, this.crypto.decrypt);
      // bm25 returns negative values; more negative = more relevant.
      // Normalize to 0-1 range where 1 = most relevant.
      const rawRank = row.rank as number;
      const relevance = Math.min(1, Math.max(0, -rawRank / 10));
      return {
        ...file,
        relevance: relevance || 0.1, // floor at 0.1 so matched results always have > 0
        snippet: (row.fts_snippet as string) || undefined,
      };
    });
  }

  getStats(ownerId?: string): MemoryStats {
    if (ownerId) {
      const row = this.db.prepare(`
        SELECT COUNT(*) AS cnt,
               COALESCE(SUM(LENGTH(content)), 0) AS totalBytes,
               COALESCE(SUM(CASE WHEN stale = 1 THEN 1 ELSE 0 END), 0) AS staleCount
        FROM memory_files
        WHERE ownerId = ?
      `).get(ownerId) as { cnt: number; totalBytes: number; staleCount: number };

      const ftsCount = (this.db.prepare(
        'SELECT COUNT(*) AS cnt FROM memory_fts f JOIN memory_files m ON f.rowid = m.rowid WHERE m.ownerId = ?',
      ).get(ownerId) as { cnt: number }).cnt;

      return {
        fileCount: row.cnt,
        totalSize: row.totalBytes,
        totalBytes: row.totalBytes,
        staleFiles: row.staleCount,
        ftsIndexed: ftsCount,
        recallP95: 0,
      };
    }

    const row = this.db.prepare(`
      SELECT COUNT(*) AS cnt,
             COALESCE(SUM(LENGTH(content)), 0) AS totalBytes,
             COALESCE(SUM(CASE WHEN stale = 1 THEN 1 ELSE 0 END), 0) AS staleCount
      FROM memory_files
    `).get() as { cnt: number; totalBytes: number; staleCount: number };

    const ftsCount = (this.db.prepare('SELECT COUNT(*) AS cnt FROM memory_fts').get() as { cnt: number }).cnt;

    return {
      fileCount: row.cnt,
      totalSize: row.totalBytes,
      totalBytes: row.totalBytes,
      staleFiles: row.staleCount,
      ftsIndexed: ftsCount,
      recallP95: 0,
    };
  }

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Singleton management
// ---------------------------------------------------------------------------

let memoryDbInstance: MemoryDB | null = null;

export function getMemoryDB(): MemoryDB {
  if (memoryDbInstance === null) {
    memoryDbInstance = new MemoryDB();
  }
  return memoryDbInstance;
}

export function closeMemoryDB(): void {
  if (memoryDbInstance !== null) {
    memoryDbInstance.close();
    memoryDbInstance = null;
  }
}

// ---------------------------------------------------------------------------
// Encryption helpers (unchanged)
// ---------------------------------------------------------------------------

export function generateSalt(): Buffer {
  return crypto.randomBytes(16);
}

export function deriveKey(password: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(password, salt, 100_000, 32, 'sha256');
}

export function encrypt(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

export function decrypt(encoded: string, key: Buffer): string {
  const packed = Buffer.from(encoded, 'base64');
  const iv = packed.subarray(0, 12);
  const tag = packed.subarray(12, 28);
  const ciphertext = packed.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
