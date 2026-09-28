// release203/09 §3.2 — `agent.fs.list` container directory listing core.
//
// Pure resolve + jail + readdir helper extracted from the runner so it can be
// unit-tested without a live daemon. The runner's `onAgentFsList` resolves the
// per-project `repos/` base via `resolveProjectReposDir`, computes the workspace
// jail root, then delegates here. The browser only ever sends a logical
// `{ workspaceId, projectId, subpath? }` scope; this helper resolves the
// absolute path and enforces that it stays inside the workspace root — so a
// `../../etc` subpath is rejected at the protocol boundary (`path_escape`).

import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

export interface FsListEntry {
  name: string;
  type: 'dir' | 'file';
  isRepo: boolean;
}

export interface FsListData {
  absPath: string;
  parentRel: string | null;
  entries: FsListEntry[];
}

export type FsListResult =
  | { ok: true; data: FsListData }
  | { ok: false; error: { code: 'path_escape' | 'read_failed'; message?: string } };

/**
 * List a directory under `base`, jailed inside `root`.
 *
 * - `base`: the per-project `repos/` absolute path (from `resolveProjectReposDir`).
 * - `root`: the workspace jail root (`workspaces/<wid>`). The resolved target
 *   must be `root` itself or live underneath it.
 * - `subpath`: caller-relative navigation appended to `base` (default '').
 *
 * Non-existent target (ENOENT — e.g. `repos/` not yet created) is NOT an error:
 * returns `ok:true` with empty `entries` and a valid `absPath` (per doc §4.4),
 * so the UI can still select that default cwd. Other readdir failures →
 * `read_failed`. Path escape → `path_escape`.
 */
export async function listReposDir(
  base: string,
  root: string,
  subpath: string | undefined,
): Promise<FsListResult> {
  const target = path.resolve(base, subpath ?? '');

  // JAIL — target must be the workspace root itself or strictly underneath it.
  if (target !== root && !target.startsWith(root + path.sep)) {
    return { ok: false, error: { code: 'path_escape' } };
  }

  // parentRel: null when at base; otherwise the subpath one level up relative to
  // base ('' meaning the base root itself).
  const parentRel = target === base ? null : path.relative(base, path.dirname(target));

  let dirents;
  try {
    dirents = await readdir(target, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: true, data: { absPath: target, parentRel, entries: [] } };
    }
    return { ok: false, error: { code: 'read_failed', message: (err as Error).message } };
  }

  const entries: FsListEntry[] = dirents.map((d) => {
    const isDir = d.isDirectory();
    return {
      name: d.name,
      type: isDir ? 'dir' : 'file',
      // Only dirs are probed for `.git` (single level, non-recursive); files
      // are never repos.
      isRepo: isDir ? existsSync(path.join(target, d.name, '.git')) : false,
    };
  });

  // Sort: dirs first, then files; alphabetical within each group.
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return { ok: true, data: { absPath: target, parentRel, entries } };
}
