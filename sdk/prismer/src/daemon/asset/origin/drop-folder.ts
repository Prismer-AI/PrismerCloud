// Drop-folder Origin Adapter.
//
// Watches `~/.prismer/workspaces/<wid>/drop/` for new files and produces
// observations the UploadRunner can drain into cloud `POST /api/im/assets`.
//
// Lifecycle of one dropped file:
//
//   ~/.prismer/workspaces/<wid>/drop/foo.csv
//      → DropFolderAdapter.scanOnce yields observation
//      → OriginOutbox.enqueue (pending row, idempotency keyed on path+mtime)
//      → UploadRunner.drainOnce:
//          • outbox.claimNext
//          • adapter.fetch(obs)   ← reads bytes
//          • cloud.uploadAsset(...)
//          • on success: outbox.markUploaded + adapter.onUploadSuccess
//            → move to ~/.prismer/workspaces/<wid>/uploaded/foo.csv
//          • on failure (after maxAttempts): outbox dead-letter +
//            adapter.onUploadFailure → move to .../upload-failed/foo.csv
//
// Polling rather than fs.watch: matches artifacts-watcher.ts rationale —
// behaviour is consistent across macOS APFS / Linux ext4 / Windows NTFS,
// and drop-folder latency tolerates a 1s tick. fs.watch can be switched in
// later if measurements warrant.

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import type {
  OriginAdapter,
  OriginKind,
  SourceBytes,
  SourceIdentity,
  SourceObservation,
} from './spi.js';

export interface DropFolderAdapterOptions {
  /** Explicit per-workspace sync root. Contains drop/uploaded/upload-failed. */
  workspaceDir?: string;
  /** Prismer home root. Defaults to `${homeDir}/.prismer` for compatibility. */
  rootDir?: string;
  /** Override `os.homedir()` for tests. */
  homeDir?: string;
}

export interface DropFolderObservationDetail {
  path: string;
  watchDir: string;
  size: number;
  mtime: number;
}

export class DropFolderAdapter implements OriginAdapter {
  readonly kind: OriginKind = 'drop-folder';
  private readonly workspaceDir?: string;
  private readonly rootDir: string;

  constructor(opts: DropFolderAdapterOptions = {}) {
    this.workspaceDir = opts.workspaceDir;
    this.rootDir = opts.rootDir ?? path.join(opts.homeDir ?? homedir(), '.prismer');
  }

  /**
   * Long-lived async iterable wrapping `scanOnce` on a 1s polling interval.
   * Stops when the iterator is broken (e.g. consumer returns / throws).
   */
  async *observe(workspaceId: string): AsyncIterable<SourceObservation> {
    while (true) {
      const batch = await this.scanOnce(workspaceId);
      for (const obs of batch) yield obs;
      await sleep(1000);
    }
  }

  /**
   * Single-tick scan exposed for tests and one-shot CLI usage. Reads every
   * file currently under the workspace's drop directory, returning one
   * observation per file. The caller is expected to feed each into the
   * outbox; idempotency on the outbox side collapses re-observations of
   * unchanged files.
   */
  async scanOnce(workspaceId: string): Promise<SourceObservation[]> {
    const drop = this.dropDir(workspaceId);
    let entries: string[] = [];
    try {
      entries = await fs.readdir(drop);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const out: SourceObservation[] = [];
    for (const name of entries) {
      if (name.startsWith('.')) continue;
      const fullPath = path.join(drop, name);
      // lstat (not stat) so we see the symlink as a symlink, not its target.
      // Following symlinks invites two failure modes: cycles (`ln -s . loop`
      // → ENAMETOOLONG / infinite recursion) and unintended uploads of
      // anything outside drop/.
      const stat = await fs.lstat(fullPath).catch(() => null);
      if (!stat) continue;
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        for (const nested of await walk(fullPath)) {
          const nstat = await fs.lstat(nested).catch(() => null);
          if (!nstat || !nstat.isFile()) continue;
          out.push(makeObservation(workspaceId, nested, drop, nstat.size, Math.floor(nstat.mtimeMs)));
        }
        continue;
      }
      if (!stat.isFile()) continue;
      out.push(makeObservation(workspaceId, fullPath, drop, stat.size, Math.floor(stat.mtimeMs)));
    }
    return out;
  }

  async identifySource(obs: SourceObservation): Promise<SourceIdentity> {
    const detail = obs.detail as unknown as DropFolderObservationDetail;
    const rel = path.relative(detail.watchDir, detail.path);
    const folderDir = path.dirname(rel);
    return {
      sourceRef: `folder://${obs.workspaceId}/${rel.split(path.sep).join('/')}`,
      hints: {
        filename: path.basename(detail.path),
        folderPath: folderDir === '.' ? '' : folderDir.split(path.sep).join('/'),
      },
    };
  }

  async fetch(obs: SourceObservation): Promise<SourceBytes> {
    const detail = obs.detail as unknown as DropFolderObservationDetail;
    const bytes = await fs.readFile(detail.path);
    return {
      bytes,
      mime: mimeFromExtension(detail.path),
      size: bytes.length,
    };
  }

  /** Hook called by UploadRunner after a successful upload of one observation. */
  async onUploadSuccess(obs: SourceObservation): Promise<void> {
    await this.moveTo(obs, this.uploadedDir(obs.workspaceId));
  }

  /** Hook called by UploadRunner after attempts hit maxAttempts. */
  async onUploadFailure(obs: SourceObservation): Promise<void> {
    await this.moveTo(obs, this.failedDir(obs.workspaceId));
  }

  private async moveTo(obs: SourceObservation, destDir: string): Promise<void> {
    const detail = obs.detail as unknown as DropFolderObservationDetail;
    if (!detail || typeof detail.path !== 'string') return;
    try {
      const rel =
        typeof detail.watchDir === 'string'
          ? path.relative(detail.watchDir, detail.path)
          : path.basename(detail.path);
      const safeRel = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : path.basename(detail.path);
      const destPath = path.join(destDir, safeRel);
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.rename(detail.path, destPath);
    } catch (err) {
      // Don't crash the worker on a missing source — file may have been
      // already moved by a concurrent process or removed by the user.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }

  private dropDir(workspaceId: string): string {
    if (this.workspaceDir) return path.join(this.workspaceDir, 'drop');
    return path.join(this.rootDir, 'workspaces', workspaceId, 'drop');
  }

  private uploadedDir(workspaceId: string): string {
    if (this.workspaceDir) return path.join(this.workspaceDir, 'uploaded');
    return path.join(this.rootDir, 'workspaces', workspaceId, 'uploaded');
  }

  private failedDir(workspaceId: string): string {
    if (this.workspaceDir) return path.join(this.workspaceDir, 'upload-failed');
    return path.join(this.rootDir, 'workspaces', workspaceId, 'upload-failed');
  }
}

function makeObservation(
  workspaceId: string,
  filePath: string,
  watchDir: string,
  size: number,
  mtime: number,
): SourceObservation {
  return {
    workspaceId,
    detail: { path: filePath, watchDir, size, mtime } satisfies DropFolderObservationDetail,
    observedAt: mtime,
  };
}

async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(root).catch(() => []);
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const full = path.join(root, name);
    // lstat (not stat) — never recurse through symlinks (cycle / escape risk).
    const stat = await fs.lstat(full).catch(() => null);
    if (!stat) continue;
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      out.push(...(await walk(full)));
    } else if (stat.isFile()) {
      out.push(full);
    }
  }
  return out;
}

const MIME_BY_EXT: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xhtml': 'application/xhtml+xml',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.wav': 'audio/wav',
};

function mimeFromExtension(p: string): string | null {
  const ext = path.extname(p).toLowerCase();
  return MIME_BY_EXT[ext] ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
