// Asset metadata index — daemon-side cache of cloud im_assets rows for #filename
// reference resolution. Persists a numeric cursor at
// ~/.prismer/<wid>/asset-metadata-cursor.json so a restart picks up exactly where
// it left off. Uses the existing daemon SQLite DB (same as sync/store.ts) for
// the `asset_metadata_index` table.
//
// Why a separate cursor from WorkspaceMirror:
//   - cloud /api/im/assets/index uses numeric assetIndexSeq (asset-row changes)
//   - cloud /workspaces/:wsId/files/sync uses ISO updatedAt (path-binding changes)
// The metadata index tracks asset identity, not path bindings, so it consumes
// the *index* endpoint and stores a numeric cursor.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CloudClient } from '../../auth.js';
import type { LocalDb } from '../../sync/store.js';

export interface AssetMetadataRow {
  assetId: string;
  contentHash: string;
  filename: string | null;
  folderPath: string | null;
  mime: string;
  kind: string;
  sizeBytes: number;
  description: string | null;
  assetIndexSeq: number;
}

interface IndexRow {
  workspace_id: string;
  asset_id: string;
  content_hash: string;
  filename: string | null;
  folder_path: string | null;
  mime: string;
  kind: string;
  size_bytes: number;
  description: string | null;
  asset_index_seq: number;
}

interface IndexEnvelopeItem {
  id?: string;
  assetId?: string;
  contentHash: string;
  filename: string | null;
  folderPath: string | null;
  mime: string;
  kind: string;
  sizeBytes: number;
  description: string | null;
  assetIndexSeq: number;
}

interface IndexEnvelope {
  items: IndexEnvelopeItem[];
  cursor: number;
}

interface CursorFile {
  workspaceId: string;
  cursor: number;
  writtenAt: number;
}

export interface AssetMetadataIndexOptions {
  db: LocalDb;
  cloud: CloudClient;
  workspaceId: string;
  /**
   * Per-workspace state dir. Caller should pass ~/.prismer/<wid>/ so different
   * paired workspaces don't race on the cursor file.
   */
  workspaceStateDir: string;
}

const DEFAULT_LIMIT = 8;
export const PULL_PAGE_SIZE = 500;
const THROTTLE_MS = 30_000;

function rowToMetadata(row: IndexRow): AssetMetadataRow {
  return {
    assetId: row.asset_id,
    contentHash: row.content_hash,
    filename: row.filename,
    folderPath: row.folder_path,
    mime: row.mime,
    kind: row.kind,
    sizeBytes: row.size_bytes,
    description: row.description,
    assetIndexSeq: row.asset_index_seq,
  };
}

/**
 * AssetMetadataIndex mirrors cloud-side asset metadata into SQLite for fast
 * local `#filename` lookup. The cursor file is the only piece of state that
 * must survive daemon restart; the SQLite mirror is incremental between restarts
 * (cursor catch-up). Idempotent — safe to retry pullDelta() on errors.
 */
export class AssetMetadataIndex {
  private readonly db: LocalDb;
  private readonly cloud: CloudClient;
  /** Workspace ID — exposed for prismer:// URI construction. */
  readonly workspaceId: string;
  private readonly cursorPath: string;
  private _lastSyncMs = 0;

  constructor(opts: AssetMetadataIndexOptions) {
    this.db = opts.db;
    this.cloud = opts.cloud;
    this.workspaceId = opts.workspaceId;
    if (!existsSync(opts.workspaceStateDir)) {
      mkdirSync(opts.workspaceStateDir, { recursive: true });
    }
    this.cursorPath = join(opts.workspaceStateDir, 'asset-metadata-cursor.json');
  }

  /** Persisted cursor for this workspace, or 0 on first run / corrupted file. */
  readCursor(): number {
    if (!existsSync(this.cursorPath)) return 0;
    try {
      const parsed = JSON.parse(readFileSync(this.cursorPath, 'utf8')) as CursorFile;
      if (parsed.workspaceId !== this.workspaceId) return 0;
      return parsed.cursor;
    } catch {
      return 0;
    }
  }

  private writeCursor(cursor: number): void {
    const payload: CursorFile = {
      workspaceId: this.workspaceId,
      cursor,
      writtenAt: Date.now(),
    };
    writeFileSync(this.cursorPath, JSON.stringify(payload, null, 2));
  }

  /**
   * Pull incremental asset metadata changes since the persisted cursor and
   * upsert into the local index. Newer rows overwrite older ones by
   * (workspace_id, asset_id) primary key.
   *
   * Returns the count of items applied + the new cursor. Throttled: if called
   * within 30s of the last successful pull, returns immediately.
   */
  async pullDelta(opts?: { signal?: AbortSignal; force?: boolean }): Promise<{ applied: number; cursor: number }> {
    const now = Date.now();
    if (!opts?.force && now - this._lastSyncMs < THROTTLE_MS) {
      return { applied: 0, cursor: this.readCursor() };
    }

    const since = this.readCursor();
    const sinceParam = since > 0 ? `&since=${since}` : '';
    const envelope = await this.cloud.get<IndexEnvelope>(
      `/api/im/assets/index?workspaceId=${encodeURIComponent(this.workspaceId)}&limit=${PULL_PAGE_SIZE}${sinceParam}`,
      { signal: opts?.signal },
    );

    const upsert = this.db.prepare(`
      INSERT INTO asset_metadata_index
        (workspace_id, asset_id, content_hash, filename, folder_path, mime, kind, size_bytes, description, asset_index_seq, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, asset_id) DO UPDATE SET
        content_hash = excluded.content_hash,
        filename = excluded.filename,
        folder_path = excluded.folder_path,
        mime = excluded.mime,
        kind = excluded.kind,
        size_bytes = excluded.size_bytes,
        description = excluded.description,
        asset_index_seq = excluded.asset_index_seq,
        updated_at = excluded.updated_at
    `);

    const nowTs = Date.now();
    let applied = 0;
    const tx = this.db.transaction((items: IndexEnvelopeItem[]) => {
      for (const item of items) {
        const assetId = item.assetId ?? item.id;
        if (!assetId) {
          throw new Error('Asset metadata index item missing assetId/id');
        }
        upsert.run(
          this.workspaceId,
          assetId,
          item.contentHash,
          item.filename ?? null,
          item.folderPath ?? null,
          item.mime,
          item.kind,
          item.sizeBytes,
          item.description ?? null,
          item.assetIndexSeq,
          nowTs,
        );
        applied += 1;
      }
    });
    try {
      tx(envelope.items);
      this.writeCursor(envelope.cursor);
    } catch (err) {
      // Transaction rolled back; don't advance cursor so we retry next pull
      throw err;
    }
    this._lastSyncMs = now;
    return { applied, cursor: envelope.cursor };
  }

  /**
   * Search local index by filename or description substring.
   * Escapes LIKE wildcards (% and _). Default limit 8.
   */
  search(query: string, limit?: number): AssetMetadataRow[] {
    const escaped = query.replace(/%/g, '\\%').replace(/_/g, '\\_');
    const pattern = `%${escaped}%`;
    const limitVal = Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), 200);
    const rows = this.db
      .prepare(
        `SELECT * FROM asset_metadata_index
         WHERE workspace_id = ?
           AND (filename LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')
         ORDER BY asset_index_seq DESC
         LIMIT ?`,
      )
      .all(this.workspaceId, pattern, pattern, limitVal) as IndexRow[];
    return rows.map(rowToMetadata);
  }

  /** Exact match on filename column. Returns undefined if not indexed. */
  resolveByFilename(filename: string): AssetMetadataRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM asset_metadata_index WHERE workspace_id = ? AND filename = ?')
      .get(this.workspaceId, filename) as IndexRow | undefined;
    return row ? rowToMetadata(row) : undefined;
  }

  resolveByAssetId(assetId: string): AssetMetadataRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM asset_metadata_index WHERE workspace_id = ? AND asset_id = ?')
      .get(this.workspaceId, assetId) as IndexRow | undefined;
    return row ? rowToMetadata(row) : undefined;
  }

  resolveByContentHash(contentHash: string): AssetMetadataRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM asset_metadata_index WHERE workspace_id = ? AND content_hash = ?')
      .get(this.workspaceId, contentHash) as IndexRow | undefined;
    return row ? rowToMetadata(row) : undefined;
  }

  /** Batch exact match — returns Map for O(1) access. */
  resolveByFilenames(filenames: string[]): Map<string, AssetMetadataRow> {
    if (filenames.length === 0) return new Map();
    const placeholders = filenames.map(() => '?').join(',');
    const params: (string | number)[] = [this.workspaceId, ...filenames];
    const rows = this.db
      .prepare(
        `SELECT * FROM asset_metadata_index
         WHERE workspace_id = ? AND filename IN (${placeholders})`,
      )
      .all(...params) as IndexRow[];
    const map = new Map<string, AssetMetadataRow>();
    for (const row of rows) {
      if (row.filename) map.set(row.filename, rowToMetadata(row));
    }
    return map;
  }

}
