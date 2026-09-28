// release201/09 §9.3.1 + release202/04 §3.1 — once-off startup migration:
// legacy `runs/<taskId>/{_outbox,result,workdir}` → new
// `workspaces/<wid>/projects/<pid|_unscoped>/tasks/<tid>/{artifacts,scratch}`.
//
// Idempotent: every migrated task gets a watermark file under
// `${paths.root}/migrations/task-workdir-v207/<taskId>` so we never re-process.
// Symlink left behind at the old runs/<tid>/ pointing at the new dir so any
// in-flight or legacy script paths keep working through the 90-day grace
// window (§9.3.1).
//
// Cloud lookups: per-task we call GET /api/im/tasks/<tid> to learn
// workspaceId + projectId. Failures (cloud unreachable, 404, malformed)
// log + skip the task; next daemon startup retries. Cloud-offline is
// expected (local-first daemon), so do NOT fail-fast.

import { promises as fsp } from 'node:fs';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type { CloudClient } from '../auth.js';
import type { ConfigPaths } from '../config.js';
import { resolveTaskWorkdir, UNSCOPED_PROJECT_SENTINEL } from '../config.js';

const WATERMARK_DIR = 'migrations/task-workdir-v207';

interface TaskMetaLite {
  workspaceId?: string | null;
  projectId?: string | null;
}

export interface MigrationResult {
  scanned: number;
  migrated: number;
  skipped: number;
  failed: number;
  errors: Array<{ taskId: string; reason: string }>;
}

async function fetchTaskMeta(cloud: CloudClient, taskId: string): Promise<TaskMetaLite | null> {
  try {
    const t = await cloud.get<TaskMetaLite>(`/api/im/tasks/${encodeURIComponent(taskId)}`);
    return t ?? null;
  } catch {
    return null;
  }
}

async function isAlreadyMigrated(paths: ConfigPaths, taskId: string): Promise<boolean> {
  const marker = path.join(paths.root, WATERMARK_DIR, taskId);
  try {
    await fsp.access(marker);
    return true;
  } catch {
    return false;
  }
}

async function writeWatermark(paths: ConfigPaths, taskId: string): Promise<void> {
  const dir = path.join(paths.root, WATERMARK_DIR);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, taskId), `${new Date().toISOString()}\n`, 'utf8');
}

/**
 * Migrate a single task directory.
 *
 * Move legacy artifacts dir → `artifacts/` (release202/04 §3.1). The source
 * may be either the oldest `_outbox/` name or the intermediate `result/`
 * name (release201/09); both map to the new `artifacts/`. `workdir/` → the
 * new `scratch/`. Leftover content in `runs/<tid>/` (anything other than
 * those recognized names) is also moved so we don't orphan stray files.
 *
 * After move, replace the old runs/<tid>/ with a symlink to the new dir
 * so paths from any in-flight write resolve correctly during the grace
 * window. Throws on any unrecoverable error.
 */
async function migrateOne(
  paths: ConfigPaths,
  taskId: string,
  meta: TaskMetaLite,
): Promise<void> {
  const oldDir = path.join(paths.runsDir, taskId);
  if (!meta.workspaceId) {
    throw new Error('task has no workspaceId — cannot resolve new path');
  }
  const newDir = resolveTaskWorkdir(paths, meta.workspaceId, meta.projectId ?? null, taskId);
  await fsp.mkdir(newDir, { recursive: true });

  // Move legacy artifacts dir → artifacts/. Read BOTH legacy names: oldest
  // `_outbox/` and the intermediate `result/`. First-present wins (a task
  // wouldn't normally have both; if it does, prefer `result/` as the newer).
  const newArtifacts = path.join(newDir, 'artifacts');
  const legacyArtifactsCandidates = [path.join(oldDir, 'result'), path.join(oldDir, '_outbox')];
  for (const oldArtifacts of legacyArtifactsCandidates) {
    if (existsSync(oldArtifacts) && !existsSync(newArtifacts)) {
      await fsp.rename(oldArtifacts, newArtifacts);
      break;
    }
  }
  // Move workdir → scratch.
  const oldWorkdir = path.join(oldDir, 'workdir');
  const newScratch = path.join(newDir, 'scratch');
  if (existsSync(oldWorkdir) && !existsSync(newScratch)) {
    await fsp.rename(oldWorkdir, newScratch);
  }
  // Move any stray files (defensive — pre-F18 layouts wrote loose files).
  const recognized = new Set(['_outbox', 'result', 'workdir']);
  for (const name of await fsp.readdir(oldDir).catch(() => [])) {
    if (recognized.has(name)) continue;
    const src = path.join(oldDir, name);
    const dst = path.join(newDir, name);
    if (!existsSync(dst)) {
      await fsp.rename(src, dst).catch(() => {
        /* best-effort */
      });
    }
  }
  // Replace old dir with symlink. If old dir is non-empty (stale files we
  // couldn't move above), leave it intact and skip the symlink — the
  // watermark prevents re-attempting next startup. (Cleanup is manual.)
  const remaining = await fsp.readdir(oldDir).catch(() => []);
  if (remaining.length === 0) {
    await fsp.rmdir(oldDir).catch(() => undefined);
    // Best-effort symlink — on platforms where it fails (Windows w/o
    // privilege), just leave the absence. The grace window is for
    // hand-rolled scripts that still hard-code runs/<tid>/; if symlinks
    // are unavailable those scripts already broke earlier.
    await fsp.symlink(newDir, oldDir, 'dir').catch(() => undefined);
  }
}

/**
 * Walk every legacy `runs/<tid>/` directory and migrate. Safe to call on
 * every daemon boot — re-runs are bounded by the watermark check.
 *
 * Returns counters so the caller can log / surface in /healthz once.
 */
export async function migrateLegacyTaskWorkdirs(
  paths: ConfigPaths,
  cloud: CloudClient,
): Promise<MigrationResult> {
  const result: MigrationResult = {
    scanned: 0,
    migrated: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  let entries: string[] = [];
  try {
    entries = await fsp.readdir(paths.runsDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return result; // nothing to migrate
    throw err;
  }

  for (const name of entries) {
    // Skip dotfiles + non-directories.
    if (name.startsWith('.')) continue;
    const full = path.join(paths.runsDir, name);
    let st;
    try {
      st = await fsp.lstat(full);
    } catch {
      continue;
    }
    // Skip symlinks (already migrated or hand-created).
    if (st.isSymbolicLink()) continue;
    if (!st.isDirectory()) continue;
    result.scanned += 1;
    const taskId = name;
    if (await isAlreadyMigrated(paths, taskId)) {
      result.skipped += 1;
      continue;
    }
    const meta = await fetchTaskMeta(cloud, taskId);
    if (!meta || !meta.workspaceId) {
      result.failed += 1;
      result.errors.push({
        taskId,
        reason: meta ? 'no_workspace_id' : 'cloud_lookup_failed',
      });
      continue;
    }
    try {
      await migrateOne(paths, taskId, meta);
      await writeWatermark(paths, taskId);
      result.migrated += 1;
    } catch (err) {
      result.failed += 1;
      result.errors.push({
        taskId,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

/**
 * Re-export the sentinel for test convenience.
 */
export { UNSCOPED_PROJECT_SENTINEL };
