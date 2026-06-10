// Workspace file mirror — daemon-side cache of cloud im_workspace_files rows.
// Persists a cursor at ~/.prismer/<wid>/asset-cursor.json so a restart picks
// up exactly where it left off. SQLite table `workspace_files_mirror` already
// migrated by sync/store.ts schema v2. See docs/54release/26-asset-multi-tier-sync.md
// (24h-disconnect cursor-catch-up acceptance).
//
// Why two cursors exist:
//   - cloud /assets/index uses numeric assetIndexSeq (asset-row changes)
//   - cloud /workspaces/:wsId/files/sync uses ISO updatedAt (path-binding changes)
// The mirror tracks path→asset bindings, so it consumes the *files* endpoint
// and stores an ISO timestamp string. WS push 'workspace_file.changed' triggers
// pullDelta() which fans out from there.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CloudClient } from '../../auth.js';
import type { LocalDb } from '../../sync/store.js';

export interface WorkspaceFileBinding {
  workspaceId: string;
  path: string;
  assetId: string;
  contentHash: string;
  version: number;
  syncedAt: number | null;
  dirty: boolean;
}

interface MirrorRow {
  workspace_id: string;
  path: string;
  asset_id: string;
  content_hash: string;
  version: number;
  synced_at: number | null;
  dirty: number;
}

interface CursorFile {
  workspaceId: string;
  /** ISO updatedAt from /workspaces/:wsId/files/sync, or null on first run. */
  cursor: string | null;
  /** Daemon-local timestamp of the most recent successful pullDelta. */
  writtenAt: number;
}

interface FilesSyncItem {
  id: string;
  workspaceId: string;
  path: string;
  assetId: string;
  contentHash?: string;
  version: number;
  parentVersionId: string | null;
  modifierImUserId: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

interface FilesSyncEnvelope {
  items: FilesSyncItem[];
  cursor: string | null;
}

export interface WorkspaceMirrorOptions {
  db: LocalDb;
  cloud: CloudClient;
  workspaceId: string;
  /**
   * Per-workspace state dir. Caller should pass ~/.prismer/<wid>/ so different
   * paired workspaces don't race on the cursor file.
   */
  workspaceStateDir: string;
}

function rowToBinding(row: MirrorRow): WorkspaceFileBinding {
  return {
    workspaceId: row.workspace_id,
    path: row.path,
    assetId: row.asset_id,
    contentHash: row.content_hash,
    version: row.version,
    syncedAt: row.synced_at,
    dirty: row.dirty === 1,
  };
}

/**
 * Mirror reads cloud-side path→asset bindings into SQLite for fast local
 * lookup. The cursor file is the only piece of state that must survive
 * daemon restart; the SQLite mirror is rebuilt from scratch by the very
 * first pullDelta() with no cursor.
 */
export class WorkspaceMirror {
  private readonly db: LocalDb;
  private readonly cloud: CloudClient;
  private readonly workspaceId: string;
  private readonly cursorPath: string;

  constructor(opts: WorkspaceMirrorOptions) {
    this.db = opts.db;
    this.cloud = opts.cloud;
    this.workspaceId = opts.workspaceId;
    if (!existsSync(opts.workspaceStateDir)) {
      mkdirSync(opts.workspaceStateDir, { recursive: true });
    }
    this.cursorPath = join(opts.workspaceStateDir, 'asset-cursor.json');
  }

  /** Persisted cursor for this workspace, or null on first run / corrupted file. */
  readCursor(): string | null {
    if (!existsSync(this.cursorPath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.cursorPath, 'utf8')) as CursorFile;
      if (parsed.workspaceId !== this.workspaceId) return null;
      return parsed.cursor;
    } catch {
      return null;
    }
  }

  private writeCursor(cursor: string | null): void {
    const payload: CursorFile = {
      workspaceId: this.workspaceId,
      cursor,
      writtenAt: Date.now(),
    };
    writeFileSync(this.cursorPath, JSON.stringify(payload, null, 2));
  }

  /**
   * Pull workspace_file changes since the persisted cursor and upsert into
   * the local mirror. Soft-deleted rows are removed from the mirror; active
   * rows are upserted with synced_at = now and dirty = 0.
   *
   * Returns the count of items applied + the new cursor (may be unchanged
   * when the cloud has nothing new). Idempotent — safe to retry.
   */
  async pullDelta(opts?: { signal?: AbortSignal }): Promise<{ applied: number; cursor: string | null }> {
    const since = this.readCursor();
    const sinceParam = since ? `?since=${encodeURIComponent(since)}` : '';
    const envelope = await this.cloud.get<FilesSyncEnvelope>(
      `/api/im/workspaces/${encodeURIComponent(this.workspaceId)}/files/sync${sinceParam}`,
      { signal: opts?.signal },
    );

    const upsert = this.db.prepare(`
      INSERT INTO workspace_files_mirror (workspace_id, path, asset_id, content_hash, version, synced_at, dirty)
      VALUES (?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(workspace_id, path) DO UPDATE SET
        asset_id = excluded.asset_id,
        content_hash = excluded.content_hash,
        version = excluded.version,
        synced_at = excluded.synced_at,
        dirty = 0
    `);
    const remove = this.db.prepare(
      'DELETE FROM workspace_files_mirror WHERE workspace_id = ? AND path = ?',
    );

    const now = Date.now();
    let applied = 0;
    const tx = this.db.transaction((items: FilesSyncItem[]) => {
      for (const item of items) {
        if (item.workspaceId !== this.workspaceId) continue;
        if (item.deletedAt) {
          remove.run(this.workspaceId, item.path);
        } else if (item.contentHash) {
          upsert.run(this.workspaceId, item.path, item.assetId, item.contentHash, item.version, now);
        } else {
          // contentHash missing means cloud row lost its asset relation; treat as removed.
          remove.run(this.workspaceId, item.path);
        }
        applied += 1;
      }
    });
    tx(envelope.items);

    this.writeCursor(envelope.cursor);
    return { applied, cursor: envelope.cursor };
  }

  /** Lookup the active binding for a workspace path. Returns undefined if not mirrored. */
  lookupByPath(path: string): WorkspaceFileBinding | undefined {
    const row = this.db
      .prepare('SELECT * FROM workspace_files_mirror WHERE workspace_id = ? AND path = ?')
      .get(this.workspaceId, path) as MirrorRow | undefined;
    return row ? rowToBinding(row) : undefined;
  }

  /** Find an asset's contentHash via any path binding (asset may map to many paths). */
  hashForAssetId(assetId: string): string | undefined {
    const row = this.db
      .prepare(
        'SELECT content_hash FROM workspace_files_mirror WHERE workspace_id = ? AND asset_id = ? LIMIT 1',
      )
      .get(this.workspaceId, assetId) as { content_hash: string } | undefined;
    return row?.content_hash;
  }

  /** All active bindings for this workspace — used by status / debug surfaces. */
  list(): WorkspaceFileBinding[] {
    const rows = this.db
      .prepare('SELECT * FROM workspace_files_mirror WHERE workspace_id = ? ORDER BY path ASC')
      .all(this.workspaceId) as MirrorRow[];
    return rows.map(rowToBinding);
  }

  /** Wipe the mirror for this workspace (e.g., re-pair). Cursor file is left intact. */
  clear(): void {
    this.db.prepare('DELETE FROM workspace_files_mirror WHERE workspace_id = ?').run(this.workspaceId);
  }
}
