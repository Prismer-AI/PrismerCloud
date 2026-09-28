// release201/09 §9.4a.7 — Self-check checkpoint hook.
//
// New route prefix `/v1/checkpoints/*` runs in parallel with the existing
// `/v1/hooks/*` (memory recall/extract). Independent handler — does not
// touch Hermes config.yaml shell-hook block, does not touch
// memory/hook-server.ts. SDK calls it BEFORE sending a cloud status
// transition (e.g. `cloud task update --status review`).
//
// Purpose: catch the case where an agent dropped a file in `artifacts/` but
// forgot to `cloud task attach` it. We hash every file in `artifacts/`, diff
// against the set of contentHash values already attached to the task,
// return 409 + pendingFiles[] if any are missing.
//
// In-session, agent-context-only: the SDK formats the response onto its
// stderr; the adapter (hermes/openclaw) spawned the SDK child process, so
// stderr returns to the agent's LLM context — never to user session, never
// to chat. No IMMessage / IMConversation writes.

import { promises as fs, type Stats } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CloudClient } from '../auth.js';
import type { ConfigPaths } from '../config.js';
import { resolveTaskWorkdir } from '../config.js';

export interface CheckpointDeps {
  paths: ConfigPaths;
  cloud: CloudClient;
}

export interface PendingFile {
  /** Relative to `artifacts/` (POSIX separator). */
  path: string;
  sha256: string;
  sizeBytes: number;
}

/** Patterns we never count toward checkpoint (partial / cache / OS-junk). */
const SKIPPED_PATTERNS = [
  /^\.DS_Store$/i,
  /\.swp$/i,
  /~$/,
  /\.partial$/i,
  /\.tmp$/i,
  /\.crdownload$/i,
];

/** Files modified < this many ms ago are treated as partial-writes (retry next call). */
const PARTIAL_WRITE_GUARD_MS = 5_000;

interface TaskMetaLite {
  workspaceId: string | null;
  projectId: string | null | undefined;
}

/**
 * Hash a single file's bytes (sha256, hex). Streaming avoided — files in
 * `artifacts/` are user-deliverables (PDF / DOCX / images), bounded by the
 * agent-output-policy cap, so a single readFile is acceptable.
 */
async function sha256OfFile(absPath: string): Promise<string> {
  const buf = await fs.readFile(absPath);
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Enumerate artifact files (1 level + nested), compute sha256 each. Skips
 * dotfiles + partial-write markers + 0-byte files + mtime within
 * PARTIAL_WRITE_GUARD_MS.
 *
 * `_uploaded/_rejected` sub-dirs (ArtifactsWatcher quarantine) are ignored —
 * keeps host-mode + sandbox container-mode path resolution symmetrical.
 *
 * release202/04 §3.1: accepts the new `artifacts/` dir. Backward-compat — the
 * caller passes any legacy `result/` dir too; both are walked and merged.
 */
export async function enumerateArtifactFiles(artifactsDir: string): Promise<PendingFile[]> {
  const out: PendingFile[] = [];
  const now = Date.now();

  async function walk(dir: string, relBase: string): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const name of entries) {
      if (name === '_uploaded' || name === '_rejected') continue;
      if (SKIPPED_PATTERNS.some((re) => re.test(name))) continue;
      const full = path.join(dir, name);
      let st: Stats;
      try {
        st = await fs.stat(full);
      } catch {
        continue; // raced with delete
      }
      const rel = relBase ? `${relBase}/${name}` : name;
      if (st.isDirectory()) {
        await walk(full, rel);
        continue;
      }
      if (!st.isFile()) continue;
      if (st.size === 0) continue; // empty file
      if (now - st.mtimeMs < PARTIAL_WRITE_GUARD_MS) continue; // partial write
      const sha256 = await sha256OfFile(full);
      out.push({ path: rel, sha256, sizeBytes: st.size });
    }
  }

  await walk(artifactsDir, '');
  return out;
}

/**
 * Fetch the contentHash set of every IMAsset already attached to this
 * task. Daemon queries cloud directly — local SQLite cache is best-effort
 * and may lag (e.g. just-uploaded but outbox not yet flushed). Cloud
 * authoritative read prevents a stale cache from masking a missing
 * attach.
 */
export async function fetchAttachedHashes(
  cloud: CloudClient,
  taskId: string,
): Promise<Set<string>> {
  try {
    const list = await cloud.get<Array<{ contentHash?: string }>>(
      `/api/im/assets?taskId=${encodeURIComponent(taskId)}&limit=500`,
    );
    const hashes = new Set<string>();
    if (Array.isArray(list)) {
      for (const row of list) {
        if (typeof row?.contentHash === 'string' && row.contentHash.length === 64) {
          hashes.add(row.contentHash.toLowerCase());
        }
      }
    }
    return hashes;
  } catch (err) {
    // Daemon offline / cloud 5xx: surface as "checkpoint indeterminate"
    // by re-throwing — handler maps it to 503. We deliberately do NOT
    // fall back to local cache: silently passing through with an empty
    // set would let a missing-attach slip past the gate.
    throw err;
  }
}

/**
 * Resolve task workspace/project metadata from cloud. We need wid + pid to
 * compose the new path `workspaces/<wid>/projects/<pid|_unscoped>/tasks/<tid>/`.
 * No 09 §10.0 metadata-first fallback at this layer — Phase 2 schema is
 * live, IMTask.projectId column exists post-migration 433.
 */
export async function fetchTaskMeta(cloud: CloudClient, taskId: string): Promise<TaskMetaLite> {
  const task = await cloud.get<{ workspaceId?: string | null; projectId?: string | null }>(
    `/api/im/tasks/${encodeURIComponent(taskId)}`,
  );
  return {
    workspaceId: task?.workspaceId ?? null,
    projectId: task?.projectId ?? null,
  };
}

/**
 * Read JSON body from an http request.
 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let raw = '';
  req.setEncoding('utf8');
  for await (const chunk of req) raw += chunk as string;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('invalid_json');
  }
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(JSON.stringify(body));
}

/**
 * POST /v1/checkpoints/pre_status_change handler.
 *
 * Body: { taskId, fromStatus, toStatus }
 *
 * 200 { ok: true }            — artifacts/ matches all attached hashes (or empty)
 * 409 { ok: false, code: 'pending_attach', pendingFiles: [...] }
 * 400                          — body validation
 * 503                          — cloud lookup failed; checkpoint indeterminate
 */
export async function handlePreStatusChange(
  req: IncomingMessage,
  res: ServerResponse,
  deps: CheckpointDeps,
): Promise<void> {
  let body: { taskId?: unknown; fromStatus?: unknown; toStatus?: unknown };
  try {
    body = (await readJsonBody(req)) as typeof body;
  } catch {
    respondJson(res, 400, { ok: false, error: { code: 'invalid_json' } });
    return;
  }

  const taskId = typeof body.taskId === 'string' && body.taskId.length > 0 ? body.taskId : null;
  const toStatus = typeof body.toStatus === 'string' ? body.toStatus : null;
  if (!taskId || !toStatus) {
    respondJson(res, 400, {
      ok: false,
      error: { code: 'invalid_body', message: 'taskId and toStatus are required' },
    });
    return;
  }

  // Resolve workspaceId / projectId from cloud — needed to compose path.
  let meta: TaskMetaLite;
  try {
    meta = await fetchTaskMeta(deps.cloud, taskId);
  } catch (err) {
    respondJson(res, 503, {
      ok: false,
      error: {
        code: 'task_meta_unavailable',
        message: err instanceof Error ? err.message : 'cloud lookup failed',
      },
    });
    return;
  }
  if (!meta.workspaceId) {
    // Tasks without workspace assignment can't have a workdir; treat as OK.
    respondJson(res, 200, { ok: true, code: 'no_workspace' });
    return;
  }

  const taskRoot = resolveTaskWorkdir(deps.paths, meta.workspaceId, meta.projectId, taskId);
  const artifactsDir = path.join(taskRoot, 'artifacts');
  // Backward-compat (release202/04 §3.1): also scan the legacy `result/` dir
  // for in-flight tasks created before the rename.
  const legacyResultDir = path.join(taskRoot, 'result');

  // Enumerate artifacts/ (+ legacy result/) files.
  let candidates: PendingFile[];
  try {
    const fromArtifacts = await enumerateArtifactFiles(artifactsDir);
    const fromLegacy = await enumerateArtifactFiles(legacyResultDir);
    // Dedup by relative path (a file present in both dirs counts once).
    const byPath = new Map<string, PendingFile>();
    for (const f of [...fromArtifacts, ...fromLegacy]) {
      if (!byPath.has(f.path)) byPath.set(f.path, f);
    }
    candidates = [...byPath.values()];
  } catch (err) {
    respondJson(res, 500, {
      ok: false,
      error: {
        code: 'result_scan_failed',
        message: err instanceof Error ? err.message : 'artifacts scan failed',
      },
    });
    return;
  }

  if (candidates.length === 0) {
    respondJson(res, 200, { ok: true, code: 'no_result_files', taskId, toStatus });
    return;
  }

  // Fetch the set of contentHash values already attached to this task.
  let attached: Set<string>;
  try {
    attached = await fetchAttachedHashes(deps.cloud, taskId);
  } catch (err) {
    respondJson(res, 503, {
      ok: false,
      error: {
        code: 'attached_lookup_unavailable',
        message: err instanceof Error ? err.message : 'cloud lookup failed',
      },
    });
    return;
  }

  const pending = candidates.filter((f) => !attached.has(f.sha256.toLowerCase()));
  if (pending.length === 0) {
    respondJson(res, 200, {
      ok: true,
      code: 'all_attached',
      taskId,
      toStatus,
      scanned: candidates.length,
    });
    return;
  }

  respondJson(res, 409, {
    ok: false,
    error: {
      code: 'pending_attach',
      message: `artifacts/ contains ${pending.length} file(s) not yet attached to task ${taskId}`,
    },
    pendingFiles: pending,
  });
}

/**
 * Mount the checkpoint route handler on the LocalServer's `attach`-style
 * chain. Returns true if the request matched a `/v1/checkpoints/*` route
 * and was served (response already written).
 */
export function attachCheckpointServer(
  deps: CheckpointDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    const url = req.url ?? '';
    if (!url.startsWith('/v1/checkpoints/')) return false;
    if (req.method === 'POST' && url === '/v1/checkpoints/pre_status_change') {
      await handlePreStatusChange(req, res, deps);
      return true;
    }
    respondJson(res, 404, { ok: false, error: { code: 'not_found', path: url } });
    return true;
  };
}
