// release203/21 §6 R1 — `agent.fs.write` container file write core.
//
// Pure resolve + jail + atomic-write helper (mirrors fs-list.ts / fs-read.ts).
// The runner's `onAgentFsWrite` resolves the per-project `repos/` base via
// `resolveProjectReposDir`, computes the workspace jail root, then delegates
// here. The browser only ever sends a logical `{ workspaceId, projectId?,
// subpath?, path, content, encoding, ifMatchSha256? }` scope; this helper
// resolves the absolute target and enforces that it stays inside the
// workspace root (`path_escape`).
//
// Optimistic-concurrency: when `ifMatchSha256` is provided and the file
// currently on disk hashes to a different sha256, the write is rejected with
// `conflict` (the agent — or another browser tab — changed it since the last
// read). The browser then prompts reload / force-overwrite / cancel.
//
// Atomicity: content is written to a sibling temp file (`<name>.<rand>.tmp`)
// then `rename`d over the target, so a reader never observes a half-written
// file and a crash mid-write leaves the original intact. Parent directories
// are created as needed.

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface FsWriteData {
  /** sha256 of the bytes that were just written (the new write token). */
  sha256: string;
  mtimeMs: number;
}

export type FsWriteResult =
  | { ok: true; data: FsWriteData }
  | {
      ok: false;
      error: {
        code: 'path_escape' | 'conflict' | 'write_failed';
        message?: string;
        /** On conflict: the sha256 currently on disk so the UI can show a diff. */
        currentSha256?: string;
      };
    };

/**
 * Write a file under `base`, jailed inside `root`, atomically.
 *
 * - `base` / `root`: same resolve + jail contract as readReposFile.
 * - `subpath` / `filePath`: joined to form the target leaf.
 * - `content` + `encoding`: utf8 string or base64-encoded bytes.
 * - `ifMatchSha256`: optional optimistic-concurrency token from the last read.
 */
export async function writeReposFile(
  base: string,
  root: string,
  subpath: string | undefined,
  filePath: string,
  content: string,
  encoding: 'utf8' | 'base64',
  ifMatchSha256: string | undefined,
): Promise<FsWriteResult> {
  const target = path.resolve(base, subpath ?? '', filePath ?? '');

  // JAIL — target must be the workspace root itself or strictly underneath it.
  if (target !== root && !target.startsWith(root + path.sep)) {
    return { ok: false, error: { code: 'path_escape' } };
  }

  const bytes = Buffer.from(content, encoding === 'base64' ? 'base64' : 'utf8');

  // Optimistic-concurrency guard. Hash the bytes currently on disk and compare.
  // A missing file with a provided ifMatchSha256 is itself a conflict (the
  // caller expected a specific prior version that no longer exists).
  if (ifMatchSha256 != null) {
    let current: Buffer | null = null;
    try {
      current = await readFile(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        return { ok: false, error: { code: 'write_failed', message: (err as Error).message } };
      }
      current = null;
    }
    const currentSha = current ? createHash('sha256').update(current).digest('hex') : null;
    if (currentSha !== ifMatchSha256) {
      return {
        ok: false,
        error: {
          code: 'conflict',
          message: 'File changed since last read',
          ...(currentSha ? { currentSha256: currentSha } : {}),
        },
      };
    }
  }

  // Atomic write: temp sibling + rename. Create parent dirs first.
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${path.basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(tmp, bytes);
    await rename(tmp, target);
  } catch (err) {
    return { ok: false, error: { code: 'write_failed', message: (err as Error).message } };
  }

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let mtimeMs = Date.now();
  try {
    mtimeMs = (await stat(target)).mtimeMs;
  } catch {
    /* best-effort — fall back to now() */
  }

  return { ok: true, data: { sha256, mtimeMs } };
}
