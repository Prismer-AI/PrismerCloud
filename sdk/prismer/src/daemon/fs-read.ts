// release203/21 §6 R1 — `agent.fs.read` container file read core.
//
// Pure resolve + jail + read helper extracted from the runner (mirrors
// fs-list.ts) so it can be unit-tested without a live daemon. The runner's
// `onAgentFsRead` resolves the per-project `repos/` base via
// `resolveProjectReposDir`, computes the workspace jail root, then delegates
// here. The browser only ever sends a logical `{ workspaceId, projectId?,
// subpath?, path }` scope; this helper resolves the absolute target and
// enforces that it stays inside the workspace root — a `../../etc/passwd`
// path is rejected at the protocol boundary (`path_escape`).
//
// Files larger than `maxBytes` (default 1 MiB) are rejected with `too_large`
// so the browser falls back to the asset channel (private-bucket bytes route)
// instead of streaming a large blob over the WS reverse RPC. Binary content is
// returned base64-encoded with a best-effort mime guess; text is utf8.

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/** Default ceiling for inline reads. Larger files → `too_large`. */
export const FS_READ_MAX_BYTES = 1024 * 1024; // 1 MiB

export interface FsReadData {
  /** utf8 string, or base64 when `encoding === 'base64'`. */
  content: string;
  encoding: 'utf8' | 'base64';
  sizeBytes: number;
  mtimeMs: number;
  /** sha256 of the RAW file bytes (used as the write `ifMatchSha256` token). */
  sha256: string;
  /** Best-effort mime; only meaningful for binary (base64) payloads. */
  mime?: string;
}

export type FsReadResult =
  | { ok: true; data: FsReadData }
  | {
      ok: false;
      error: {
        code: 'path_escape' | 'too_large' | 'not_found' | 'read_failed';
        message?: string;
      };
    };

/**
 * Read a file under `base`, jailed inside `root`.
 *
 * - `base`: the per-project `repos/` absolute path (from `resolveProjectReposDir`).
 * - `root`: the workspace jail root (`workspaces/<wid>`). The resolved target
 *   must live strictly underneath it (a bare file at `root` is fine too).
 * - `subpath` / `filePath`: caller-relative navigation appended to `base`.
 *   `filePath` is the file name/relative path within `subpath` (the browser
 *   sends `{ subpath, path }` where `path` is the leaf file); they're joined.
 */
export async function readReposFile(
  base: string,
  root: string,
  subpath: string | undefined,
  filePath: string,
  maxBytes: number = FS_READ_MAX_BYTES,
): Promise<FsReadResult> {
  const target = path.resolve(base, subpath ?? '', filePath ?? '');

  // JAIL — target must be the workspace root itself or strictly underneath it.
  if (target !== root && !target.startsWith(root + path.sep)) {
    return { ok: false, error: { code: 'path_escape' } };
  }

  let st;
  try {
    st = await stat(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, error: { code: 'not_found', message: 'File not found' } };
    }
    return { ok: false, error: { code: 'read_failed', message: (err as Error).message } };
  }

  if (st.isDirectory()) {
    return { ok: false, error: { code: 'read_failed', message: 'Target is a directory' } };
  }

  if (st.size > maxBytes) {
    return {
      ok: false,
      error: {
        code: 'too_large',
        message: `File is ${st.size} bytes (limit ${maxBytes}); use the asset channel for large files`,
      },
    };
  }

  let buf: Buffer;
  try {
    buf = await readFile(target);
  } catch (err) {
    return { ok: false, error: { code: 'read_failed', message: (err as Error).message } };
  }

  const sha256 = createHash('sha256').update(buf).digest('hex');
  const binary = looksBinary(buf);

  if (binary) {
    return {
      ok: true,
      data: {
        content: buf.toString('base64'),
        encoding: 'base64',
        sizeBytes: st.size,
        mtimeMs: st.mtimeMs,
        sha256,
        mime: guessMime(target),
      },
    };
  }

  return {
    ok: true,
    data: {
      content: buf.toString('utf8'),
      encoding: 'utf8',
      sizeBytes: st.size,
      mtimeMs: st.mtimeMs,
      sha256,
    },
  };
}

/**
 * Heuristic binary detection: a NUL byte in the first 8 KiB (the same rule git
 * uses) marks content as binary. Cheap and good enough — the browser only needs
 * to know whether to decode utf8 or treat the payload as base64 bytes.
 */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

function guessMime(p: string): string {
  return MIME_BY_EXT[path.extname(p).toLowerCase()] ?? 'application/octet-stream';
}
