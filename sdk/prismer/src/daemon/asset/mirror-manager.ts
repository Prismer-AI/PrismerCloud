// desktop202/17 Phase 9 — local asset mirror layer.
//
// Bridges cloud assets (Library) ↔ the user's local filesystem via THREE
// explicit通路 (each its own affordance — repo 反 overloaded-button约束):
//
//   ① Materialize (cloud → local): getOrFetch bytes → hardlink/copy to the
//      named mirror path under `<mirrorRoot>/<wsName>/<folderPath>/<file>` →
//      record local_asset_mirror(clean). Folder-level "keep offline available"
//      = materialize all + cache pin + subscribe asset.changed auto-refresh
//      (订阅式拉取, NOT a watcher).
//   ② Import (local → cloud): reuses the existing deliver / direct-upload
//      cloud endpoints (driven from electron, not here) — this module only
//      REGISTERS an imported file into the mirror index when its source already
//      lives inside the mirror dir.
//   ③ Edit-roundtrip (local edit → explicit回写): stat-compare materialized
//      entries at app-activate / Library-open / "check local edits" — NO全盘
//      watcher. mtime changed → re-hash to confirm → mark localEdit → the user
//      explicitly clicks "upload new version" (electron POSTs /:id/revisions).
//
// Multi-device convergence (§4): device A bumps a revision → asset.changed
// broadcast → device B's daemon (this module, via onAssetChanged) refreshes the
// mirror ONLY when the entry is materialized + pinned + locally clean. Idempotent
// by (assetId, revision) monotonic compare. Conflict (§5): localEdit + a newer
// cloud revision → save the local copy aside as `<name> (本机修改 <date>).<ext>`,
// materialize the cloud revision as the main name, mark conflict, never lose bytes.
//
// 红线 (17 §头部): NO默认 silent two-way sync folder. Every "auto" here is either
// 订阅式 (event-driven, pinned-only) or explicit opt-in. No autoScan upload.

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import type { AssetCache } from '../../asset-cache.js';
import type { LocalDb } from '../../sync/store.js';

/** A row in `local_asset_mirror`. */
export interface MirrorEntry {
  assetId: string;
  contentHash: string;
  revision: number;
  workspaceId: string;
  localPath: string;
  materializedAt: number;
  localMtime: number;
  dirtyState: 'clean' | 'localEdit' | 'conflict';
  pinned: boolean;
}

interface MirrorRow {
  asset_id: string;
  content_hash: string;
  revision: number;
  workspace_id: string;
  local_path: string;
  materialized_at: number;
  local_mtime: number;
  dirty_state: 'clean' | 'localEdit' | 'conflict';
  pinned: number;
}

function rowToEntry(row: MirrorRow): MirrorEntry {
  return {
    assetId: row.asset_id,
    contentHash: row.content_hash,
    revision: row.revision,
    workspaceId: row.workspace_id,
    localPath: row.local_path,
    materializedAt: row.materialized_at,
    localMtime: row.local_mtime,
    dirtyState: row.dirty_state,
    pinned: row.pinned === 1,
  };
}

/** Minimal cloud asset descriptor the manager needs to place a file on disk. */
export interface MirrorAssetDescriptor {
  assetId: string;
  contentHash: string;
  /** Cloud filename (im_assets.filename); falls back to assetId when null. */
  filename: string | null;
  /** Virtual folder path (im_assets.folderPath); root when null/empty. */
  folderPath: string | null;
  /** Monotonic version (im_asset_revisions). Defaults to 0 when unknown. */
  revision?: number;
}

/** Pluggable workspace-name resolver (cloud name → Finder-safe dir segment). */
export type WorkspaceNameResolver = (workspaceId: string) => string | undefined;

export interface MirrorManagerOptions {
  db: LocalDb;
  assetCache: AssetCache;
  /** Mirror root, e.g. `~/Prismer`. Honours config/env override at the caller. */
  mirrorRoot: string;
  /** Resolve a workspace's display name for the mirror dir segment. */
  resolveWorkspaceName?: WorkspaceNameResolver;
  /** Reveal-in-Finder hook (electron `shell.showItemInFolder`). Optional —
   *  the daemon-side manager records the path; the renderer/electron does the
   *  reveal. Wired for the CLI parity path. */
  revealInFinder?: (path: string) => void;
  log?: (line: string) => void;
}

/** Result of a materialize call (returned to electron for showItemInFolder). */
export interface MaterializeResult {
  localPath: string;
  /** True when the bytes were freshly fetched/placed; false when already present. */
  placed: boolean;
  linked: boolean;
}

/** Per-entry edit-detection outcome. */
export interface EditCheckResult {
  assetId: string;
  localPath: string;
  dirtyState: MirrorEntry['dirtyState'];
  /** Set when this check flipped a clean entry to localEdit. */
  changed: boolean;
}

const DATE_RE = /[^0-9]/g;

export class MirrorManager {
  private readonly db: LocalDb;
  private readonly assetCache: AssetCache;
  private readonly mirrorRoot: string;
  private readonly resolveWorkspaceName?: WorkspaceNameResolver;
  private readonly revealInFinder?: (path: string) => void;
  private readonly log: (line: string) => void;

  constructor(opts: MirrorManagerOptions) {
    this.db = opts.db;
    this.assetCache = opts.assetCache;
    this.mirrorRoot = resolve(opts.mirrorRoot);
    this.resolveWorkspaceName = opts.resolveWorkspaceName;
    this.revealInFinder = opts.revealInFinder;
    this.log = opts.log ?? (() => undefined);
  }

  get root(): string {
    return this.mirrorRoot;
  }

  // ── index access ──────────────────────────────────────────────────────────

  getEntry(assetId: string): MirrorEntry | undefined {
    const row = this.db
      .prepare('SELECT * FROM local_asset_mirror WHERE asset_id = ?')
      .get(assetId) as MirrorRow | undefined;
    return row ? rowToEntry(row) : undefined;
  }

  getEntryByHash(contentHash: string): MirrorEntry | undefined {
    const row = this.db
      .prepare('SELECT * FROM local_asset_mirror WHERE content_hash = ? LIMIT 1')
      .get(contentHash) as MirrorRow | undefined;
    return row ? rowToEntry(row) : undefined;
  }

  listEntries(workspaceId?: string): MirrorEntry[] {
    const rows = (
      workspaceId
        ? this.db.prepare('SELECT * FROM local_asset_mirror WHERE workspace_id = ?').all(workspaceId)
        : this.db.prepare('SELECT * FROM local_asset_mirror').all()
    ) as MirrorRow[];
    return rows.map(rowToEntry);
  }

  // ── ① Materialize (cloud → local) ───────────────────────────────────────────

  /**
   * Fetch the asset bytes (cache getOrFetch) and place a named mirror file via
   * hardlink (same volume) or copy (cross-volume). Writes the index row as
   * 'clean'. Idempotent: re-materializing an unchanged entry is a no-op placement.
   *
   * @param pin when true, the entry is marked pinned + the cache hash pinned
   *   (folder "keep offline available" membership, §3a/§4).
   */
  async materialize(
    asset: MirrorAssetDescriptor,
    opts: { workspaceId: string; signal?: AbortSignal; pin?: boolean; reveal?: boolean },
  ): Promise<MaterializeResult> {
    const cached = await this.assetCache.getOrFetch(asset.contentHash, {
      workspaceIdHint: opts.workspaceId,
      assetId: asset.assetId,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });

    const wsName = this.workspaceDirName(opts.workspaceId);
    const localPath = this.mirrorPathFor(wsName, asset.folderPath, asset.filename ?? asset.assetId);
    mkdirSync(dirname(localPath), { recursive: true });

    const existing = this.getEntry(asset.assetId);
    let placed = false;
    let linked = false;
    // Skip re-placement when an in-index file already matches this content hash
    // on disk (clean & present). Always (re)place otherwise.
    if (
      !existing ||
      existing.localPath !== localPath ||
      existing.contentHash !== asset.contentHash ||
      !existsSync(localPath)
    ) {
      linked = this.placeFile(cached.localPath, localPath);
      placed = true;
    }

    const mtime = existsSync(localPath) ? Math.floor(statSync(localPath).mtimeMs) : Date.now();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO local_asset_mirror
          (asset_id, content_hash, revision, workspace_id, local_path, materialized_at, local_mtime, dirty_state, pinned)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'clean', ?)
         ON CONFLICT(asset_id) DO UPDATE SET
           content_hash = excluded.content_hash,
           revision = excluded.revision,
           workspace_id = excluded.workspace_id,
           local_path = excluded.local_path,
           materialized_at = excluded.materialized_at,
           local_mtime = excluded.local_mtime,
           dirty_state = 'clean',
           pinned = MAX(local_asset_mirror.pinned, excluded.pinned)`,
      )
      .run(
        asset.assetId,
        asset.contentHash,
        asset.revision ?? existing?.revision ?? 0,
        opts.workspaceId,
        localPath,
        now,
        mtime,
        opts.pin ? 1 : existing?.pinned ? 1 : 0,
      );

    if (opts.pin) this.assetCache.pin(asset.contentHash);
    if (opts.reveal) this.revealInFinder?.(localPath);

    return { localPath, placed, linked };
  }

  /**
   * Folder-level "keep offline available" (§3a): materialize+pin every supplied
   * member descriptor. The asset.changed subscription (driven by the runner via
   * `refreshFromCloud`) keeps pinned entries fresh thereafter.
   */
  async pinFolder(
    members: MirrorAssetDescriptor[],
    opts: { workspaceId: string; signal?: AbortSignal },
  ): Promise<{ materialized: number; failed: Array<{ assetId: string; error: string }> }> {
    let materialized = 0;
    const failed: Array<{ assetId: string; error: string }> = [];
    for (const m of members) {
      try {
        await this.materialize(m, { workspaceId: opts.workspaceId, pin: true, ...(opts.signal ? { signal: opts.signal } : {}) });
        materialized += 1;
      } catch (err) {
        failed.push({ assetId: m.assetId, error: (err as Error).message });
      }
    }
    return { materialized, failed };
  }

  /** Cancel "keep offline available": unpin + un-subscribe. Mirror file is kept
   *  (17 §3a — never silently delete user-visible files). */
  unpin(assetId: string): void {
    const entry = this.getEntry(assetId);
    if (!entry) return;
    this.db.prepare('UPDATE local_asset_mirror SET pinned = 0 WHERE asset_id = ?').run(assetId);
    this.assetCache.unpin(entry.contentHash);
  }

  // ── ② Import (local → cloud) — register-only side ──────────────────────────

  /**
   * After electron uploads a local file (deliver / direct-upload), register it
   * into the mirror index — but ONLY when the source path is inside the mirror
   * dir (17 §3b: out-of-dir imports are NOT moved or tracked). Returns true when
   * a row was written.
   */
  registerImported(asset: MirrorAssetDescriptor & { sourcePath: string; workspaceId: string }): boolean {
    const src = resolve(asset.sourcePath);
    if (!this.isInsideMirror(src)) return false;
    const mtime = existsSync(src) ? Math.floor(statSync(src).mtimeMs) : Date.now();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO local_asset_mirror
          (asset_id, content_hash, revision, workspace_id, local_path, materialized_at, local_mtime, dirty_state, pinned)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'clean', 0)
         ON CONFLICT(asset_id) DO UPDATE SET
           content_hash = excluded.content_hash,
           revision = excluded.revision,
           local_path = excluded.local_path,
           local_mtime = excluded.local_mtime,
           dirty_state = 'clean'`,
      )
      .run(asset.assetId, asset.contentHash, asset.revision ?? 0, asset.workspaceId, src, now, mtime);
    return true;
  }

  // ── ③ Edit-roundtrip detection (stat compare, NOT a watcher) ───────────────

  /**
   * Stat-compare every materialized 'clean' entry (optionally scoped to a
   * workspace). mtime changed → re-hash to confirm (防 touch 误报) → mark
   * 'localEdit'. Returns only entries that flipped OR are already dirty.
   *
   * Called at the three explicit时机 (17 §3c): app-activate, Library-open,
   * "check local edits" button. There is NO continuous fs.watch.
   */
  checkLocalEdits(workspaceId?: string): EditCheckResult[] {
    const entries = this.listEntries(workspaceId);
    const out: EditCheckResult[] = [];
    for (const entry of entries) {
      if (entry.dirtyState === 'conflict') {
        out.push({ assetId: entry.assetId, localPath: entry.localPath, dirtyState: 'conflict', changed: false });
        continue;
      }
      if (!existsSync(entry.localPath)) {
        // File vanished (user deleted/moved in Finder). 17 §6 边界: not an error,
        // not a rename-track — leave the row so a re-materialize can recover.
        continue;
      }
      const st = statSync(entry.localPath);
      const mtime = Math.floor(st.mtimeMs);
      if (entry.dirtyState === 'localEdit') {
        out.push({ assetId: entry.assetId, localPath: entry.localPath, dirtyState: 'localEdit', changed: false });
        continue;
      }
      // Cheap secondary signal: a size change means an edit even when the mtime
      // resolution is too coarse to move (same-ms rewrite). When BOTH mtime and
      // size are unchanged the file is almost certainly untouched → skip.
      const cached = this.assetCache.get(entry.contentHash);
      const sizeChanged = cached != null && st.size !== cached.sizeBytes;
      if (mtime === entry.localMtime && !sizeChanged) continue; // unchanged
      // mtime/size moved — confirm with a hash (touch / no-op write 误报 guard).
      const actualHash = this.hashFile(entry.localPath);
      if (actualHash === entry.contentHash) {
        // Same bytes, new mtime (e.g. `touch`). Re-stamp mtime, stay clean.
        this.db.prepare('UPDATE local_asset_mirror SET local_mtime = ? WHERE asset_id = ?').run(mtime, entry.assetId);
        continue;
      }
      this.db
        .prepare("UPDATE local_asset_mirror SET dirty_state = 'localEdit', local_mtime = ? WHERE asset_id = ?")
        .run(mtime, entry.assetId);
      out.push({ assetId: entry.assetId, localPath: entry.localPath, dirtyState: 'localEdit', changed: true });
    }
    return out;
  }

  /**
   * Read the current local bytes for an entry marked 'localEdit' so electron can
   * POST them as a new revision. Returns the bytes + the local hash. Throws when
   * the entry isn't dirty (guards against uploading an unchanged file).
   */
  readLocalEdit(assetId: string): { bytes: Buffer; contentHash: string; localPath: string } {
    const entry = this.getEntry(assetId);
    if (!entry) throw new Error(`mirror entry not found: ${assetId}`);
    if (entry.dirtyState !== 'localEdit') {
      throw new Error(`asset ${assetId} is not localEdit (state=${entry.dirtyState})`);
    }
    const bytes = readFileSync(entry.localPath);
    return { bytes, contentHash: this.hashBuffer(bytes), localPath: entry.localPath };
  }

  /**
   * After electron successfully POSTs /:id/revisions, settle the index back to
   * 'clean' at the new revision/hash (17 §3c). The cache is updated by the
   * normal asset.changed refresh; here we only re-stamp the local index.
   */
  markUploaded(assetId: string, newRevision: number, newContentHash: string): void {
    const entry = this.getEntry(assetId);
    if (!entry) return;
    const mtime = existsSync(entry.localPath) ? Math.floor(statSync(entry.localPath).mtimeMs) : Date.now();
    this.db
      .prepare(
        "UPDATE local_asset_mirror SET dirty_state = 'clean', revision = ?, content_hash = ?, local_mtime = ? WHERE asset_id = ?",
      )
      .run(newRevision, newContentHash, mtime, assetId);
  }

  // ── §4 multi-device refresh + §5 conflict ──────────────────────────────────

  /**
   * Drive a refresh from a cloud asset.changed event (or assets/index catch-up).
   * Only acts on MATERIALIZED entries (17 §4):
   *   - not materialized → caller updates metadata only (no-op here)
   *   - dirtyState clean → atomically replace the mirror file with the new bytes
   *   - dirtyState localEdit → CONFLICT (§5): save local aside, materialize cloud
   * Idempotent by (assetId, revision): an older/equal revision is dropped.
   *
   * Returns the action taken (for observability + tests).
   */
  async refreshFromCloud(
    asset: MirrorAssetDescriptor,
    opts: { workspaceId: string; operation?: 'create' | 'update' | 'delete'; signal?: AbortSignal },
  ): Promise<'skipped' | 'not-materialized' | 'refreshed' | 'conflict' | 'deleted'> {
    const entry = this.getEntry(asset.assetId);

    if (opts.operation === 'delete') {
      if (!entry) return 'not-materialized';
      this.trashEntry(entry);
      return 'deleted';
    }

    if (!entry) return 'not-materialized';

    // §4 收敛单位 = revision. Monotonic compare: an incoming revision that is
    // not strictly newer than what we hold is a stale/duplicate/out-of-order
    // event — drop it WITHOUT fetching (the revision number is authoritative,
    // independent of contentHash). Only `revision===0` (unknown) falls through
    // to the contentHash comparison below.
    const incomingRev = asset.revision ?? 0;
    if (incomingRev !== 0 && incomingRev <= entry.revision) {
      return 'skipped';
    }
    if (asset.contentHash === entry.contentHash && entry.dirtyState === 'clean') {
      // Same bytes, possibly newer revision number — just advance the revision.
      if (incomingRev > entry.revision) {
        this.db.prepare('UPDATE local_asset_mirror SET revision = ? WHERE asset_id = ?').run(incomingRev, asset.assetId);
      }
      return 'skipped';
    }

    // Pull the new bytes into the cache (content-addressed; pin preserved).
    const cached = await this.assetCache.getOrFetch(asset.contentHash, {
      workspaceIdHint: opts.workspaceId,
      assetId: asset.assetId,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (entry.pinned) this.assetCache.pin(asset.contentHash);

    if (entry.dirtyState === 'localEdit') {
      // §5 conflict — never lose either side.
      return this.resolveConflict(entry, asset, cached.localPath, incomingRev);
    }

    // clean → atomic replace.
    this.atomicReplace(cached.localPath, entry.localPath);
    const mtime = Math.floor(statSync(entry.localPath).mtimeMs);
    this.db
      .prepare(
        "UPDATE local_asset_mirror SET content_hash = ?, revision = ?, local_mtime = ?, dirty_state = 'clean' WHERE asset_id = ?",
      )
      .run(asset.contentHash, incomingRev || entry.revision, mtime, asset.assetId);
    return 'refreshed';
  }

  /**
   * §5 — local副本改名保留 + 云端新 revision 材化为主名 + 标 conflict.
   * Returns 'conflict'. The aside copy is registered as an orphan row
   * (assetId-less is impossible with a PK, so we DON'T add a row for it —
   * it's an inert on-disk file the user resolves; we surface it via the
   * conflict state + the saved path baked into the log/notification).
   */
  private resolveConflict(
    entry: MirrorEntry,
    asset: MirrorAssetDescriptor,
    cacheBytesPath: string,
    incomingRev: number,
  ): 'conflict' {
    const asidePath = this.conflictAsidePath(entry.localPath);
    try {
      renameSync(entry.localPath, asidePath);
    } catch {
      // If rename fails (cross-device / locked), copy then continue — never lose.
      try {
        copyFileSync(entry.localPath, asidePath);
      } catch {
        /* last-resort: leave the local file in place; we still materialize main */
      }
    }
    // Materialize the cloud revision as the main name.
    this.atomicReplace(cacheBytesPath, entry.localPath);
    const mtime = existsSync(entry.localPath) ? Math.floor(statSync(entry.localPath).mtimeMs) : Date.now();
    this.db
      .prepare(
        "UPDATE local_asset_mirror SET content_hash = ?, revision = ?, local_mtime = ?, dirty_state = 'conflict' WHERE asset_id = ?",
      )
      .run(asset.contentHash, incomingRev || entry.revision, mtime, asset.assetId);
    this.log(
      `[mirror] conflict asset=${asset.assetId} — local saved aside: ${asidePath}; cloud rev=${incomingRev} is now main\n`,
    );
    return 'conflict';
  }

  /** Clear a conflict state once the user has dealt with the aside copy (§5). */
  clearConflict(assetId: string): void {
    this.db
      .prepare("UPDATE local_asset_mirror SET dirty_state = 'clean' WHERE asset_id = ? AND dirty_state = 'conflict'")
      .run(assetId);
  }

  // ── delete → .trash (§4) ────────────────────────────────────────────────────

  private trashEntry(entry: MirrorEntry): void {
    const wsName = this.workspaceDirName(entry.workspaceId);
    const trashDir = join(this.mirrorRoot, wsName, '.trash');
    mkdirSync(trashDir, { recursive: true });
    if (existsSync(entry.localPath)) {
      const target = this.uniquePath(join(trashDir, basename(entry.localPath)));
      try {
        renameSync(entry.localPath, target);
      } catch {
        try {
          copyFileSync(entry.localPath, target);
          unlinkSync(entry.localPath);
        } catch {
          /* best-effort */
        }
      }
    }
    this.db.prepare('DELETE FROM local_asset_mirror WHERE asset_id = ?').run(entry.assetId);
    this.assetCache.unpin(entry.contentHash);
  }

  // ── §6 budget / reclaim ─────────────────────────────────────────────────────

  /** Total bytes across non-pinned mirror files (reclaim candidates). */
  reclaimableBytes(): number {
    let total = 0;
    for (const e of this.listEntries()) {
      if (e.pinned) continue;
      if (e.dirtyState !== 'clean') continue; // never reclaim un-uploaded edits
      if (existsSync(e.localPath)) {
        try {
          total += statSync(e.localPath).size;
        } catch {
          /* ignore */
        }
      }
    }
    return total;
  }

  /**
   * §6 "释放本地空间": remove non-pinned, clean mirror files (oldest-used first)
   * until under `budgetBytes`, or all of them when budget=0. NEVER touches
   * pinned / dirty entries. Returns the freed bytes + removed count.
   */
  reclaim(budgetBytes: number): { removed: number; freed: number } {
    const candidates = (
      this.db
        .prepare(
          "SELECT * FROM local_asset_mirror WHERE pinned = 0 AND dirty_state = 'clean' ORDER BY materialized_at ASC",
        )
        .all() as MirrorRow[]
    ).map(rowToEntry);

    let total = 0;
    for (const e of candidates) {
      if (existsSync(e.localPath)) {
        try {
          total += statSync(e.localPath).size;
        } catch {
          /* ignore */
        }
      }
    }

    let removed = 0;
    let freed = 0;
    for (const e of candidates) {
      if (total <= budgetBytes) break;
      let size = 0;
      try {
        if (existsSync(e.localPath)) size = statSync(e.localPath).size;
      } catch {
        /* ignore */
      }
      try {
        if (existsSync(e.localPath)) unlinkSync(e.localPath);
      } catch {
        /* ignore */
      }
      this.db.prepare('DELETE FROM local_asset_mirror WHERE asset_id = ?').run(e.assetId);
      freed += size;
      total -= size;
      removed += 1;
    }
    return { removed, freed };
  }

  // ── path helpers ────────────────────────────────────────────────────────────

  /** Finder-safe workspace dir segment (17 §2a). Illegal chars / collisions →
   *  `<name>-<wsId 前6位>`; the segment is always sanitized + path-confined. */
  workspaceDirName(workspaceId: string): string {
    const raw = this.resolveWorkspaceName?.(workspaceId);
    const base = sanitizeSegment(raw ?? workspaceId);
    if (!base) return sanitizeSegment(workspaceId.slice(0, 12)) || 'workspace';
    // Re-name disambiguation isn't a uniqueness oracle here (single-device
    // index), but we honour the spec's `<name>-<wsId前6>` when the sanitized
    // name diverges from a plausible-clean form OR equals a different ws's name.
    if (raw && sanitizeSegment(raw) !== raw) {
      return `${base}-${workspaceId.slice(0, 6)}`;
    }
    return base;
  }

  /** Compose `<mirrorRoot>/<wsName>/<folderPath>/<fileName>`, path-confined. */
  mirrorPathFor(workspaceDirName: string, folderPath: string | null, fileName: string): string {
    const wsSeg = sanitizeSegment(workspaceDirName) || 'workspace';
    const folderSegs = (folderPath ?? '')
      .split('/')
      .map((s) => sanitizeSegment(s))
      .filter((s) => s.length > 0);
    const fileSeg = sanitizeSegment(fileName) || 'file';
    const candidate = resolve(join(this.mirrorRoot, wsSeg, ...folderSegs, fileSeg));
    // §6 realpath / escape guard: the composed path MUST stay under the root.
    if (!this.isInsideMirror(candidate)) {
      throw new Error(`mirror path escapes root: ${candidate}`);
    }
    return candidate;
  }

  private isInsideMirror(p: string): boolean {
    const rp = resolve(p);
    return rp === this.mirrorRoot || rp.startsWith(this.mirrorRoot + sep);
  }

  /** `<name> (本机修改 yyyy-MM-dd).<ext>`, de-duped with a numeric suffix. */
  private conflictAsidePath(localPath: string): string {
    const dir = dirname(localPath);
    const ext = extname(localPath);
    const stem = basename(localPath, ext);
    const date = new Date().toISOString().slice(0, 10).replace(DATE_RE, '-');
    const base = join(dir, `${stem} (本机修改 ${date})${ext}`);
    return this.uniquePath(base);
  }

  /** Append ` (n)` before the extension until the path is free. */
  private uniquePath(p: string): string {
    if (!existsSync(p)) return p;
    const dir = dirname(p);
    const ext = extname(p);
    const stem = basename(p, ext);
    for (let i = 2; i < 1000; i += 1) {
      const candidate = join(dir, `${stem} (${i})${ext}`);
      if (!existsSync(candidate)) return candidate;
    }
    return join(dir, `${stem}-${Date.now()}${ext}`);
  }

  // ── byte placement (hardlink / copy / atomic replace) ───────────────────────

  /** Hardlink cache → mirror (same volume); fall back to copy across volumes.
   *  Returns true when hardlinked, false when copied. */
  private placeFile(cachePath: string, mirrorPath: string): boolean {
    if (existsSync(mirrorPath)) {
      try {
        unlinkSync(mirrorPath);
      } catch {
        /* ignore */
      }
    }
    try {
      linkSync(cachePath, mirrorPath);
      return true;
    } catch {
      // EXDEV (cross-device) or other — degrade to copy (17 §2a).
      copyFileSync(cachePath, mirrorPath);
      return false;
    }
  }

  /** Atomic replace: place into a temp sibling then rename over the target. */
  private atomicReplace(cachePath: string, mirrorPath: string): void {
    mkdirSync(dirname(mirrorPath), { recursive: true });
    const tmp = `${mirrorPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      try {
        linkSync(cachePath, tmp);
      } catch {
        copyFileSync(cachePath, tmp);
      }
      renameSync(tmp, mirrorPath);
    } finally {
      if (existsSync(tmp)) {
        try {
          unlinkSync(tmp);
        } catch {
          /* ignore */
        }
      }
    }
  }

  private hashFile(path: string): string {
    return this.hashBuffer(readFileSync(path));
  }

  private hashBuffer(buf: Buffer): string {
    return createHash('sha256').update(buf).digest('hex');
  }
}

/**
 * Finder-safe single path segment: strip path separators + control chars +
 * `..`, collapse whitespace, drop reserved leading dots. Confines folderPath /
 * filename / workspaceName before they enter the mirror path (17 §6 防逃逸).
 */
export function sanitizeSegment(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(/[/\\]/g, '-') // path separators
    // eslint-disable-next-line no-control-regex
    .replace(/[ -<>:"|?*]/g, '') // control + reserved
    .replace(/\.\.+/g, '.') // collapse `..` runs
    .replace(/^\.+/, '') // no leading dots (`.`, `..`, dotfiles as dirs)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}
