// release203/06 §3.7 (block 1) — repo-scoped code-agent workdir materialization.
//
// codex & claude-code are REPO-scoped: their cwd must be a PERSISTENT folder
// that is reused across turns so that
//   - codex `CODEX_HOME` thread resume,
//   - claude-code `.claude/projects` session resume, and
//   - the repo files themselves
// all survive between dispatches. The daemon's default per-task scratch dir is
// FRESH every dispatch — correct for one-shot file-producing tasks, wrong for a
// code agent working a repo. When a dispatch carries a `workdir` spec, we
// materialize that persistent folder here and point the adapter cwd at it
// (see dispatch.ts overrideMetadataForWorkdir).
//
// This module owns ONLY the on-disk materialization (git clone / git init /
// verify-exists). Choosing the path + writing it back into task.metadata is
// dispatch.ts's job; cloud (RS-3) populates the spec on the wire.

import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { isSafeSegment, resolveWithinJail } from './path-jail.js';
import { seedDevPreset } from './seed-dev-preset.js';

/**
 * How the workdir should be brought into existence.
 *   - `clone`           — `git clone <sourceRef> <cwd>` when cwd is empty/absent.
 *   - `init`            — `git init` in a fresh (or empty) cwd.
 *   - `host-pick`       — desktop user picked an existing host folder; verify it.
 *   - `container-pick`  — an existing in-container path; verify it.
 */
export type WorkdirSource = 'clone' | 'init' | 'host-pick' | 'container-pick';

/**
 * The persistent-workdir spec carried by a dispatch (cloud → daemon).
 * `id` is the stable workdir identifier (cloud-side row id); `cwd` is the
 * absolute path on the daemon host/container; `sourceRef` is the clone URL for
 * `source==='clone'` (ignored otherwise).
 */
export interface WorkdirSpec {
  id: string;
  cwd: string;
  source: WorkdirSource;
  sourceRef?: string;
}

/** Default cap for the git subprocess. Clone of a large repo can be slow. */
const GIT_TIMEOUT_MS = 120_000;

export interface EnsureWorkdirResult {
  /** The persistent cwd the adapter should run in (echoes spec.cwd). */
  cwd: string;
  /** What the helper actually did this dispatch. */
  action: 'cloned' | 'init' | 'reused' | 'verified';
}

/**
 * Thrown when the workdir cannot be materialized. dispatch.ts catches this and
 * surfaces a clear dispatch error rather than silently falling back to scratch
 * (the user asked for the repo — a scratch fallback would lose their work).
 */
export class WorkdirMaterializeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkdirMaterializeError';
  }
}

function log(line: string): void {
  process.stderr.write(`[workdir] ${line}\n`);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** True when `dir` exists and is a git repo (has a `.git` entry). */
async function isGitRepo(dir: string): Promise<boolean> {
  return pathExists(`${dir.replace(/\/+$/, '')}/.git`);
}

/** True when `dir` is absent or an empty directory. */
async function isAbsentOrEmpty(dir: string): Promise<boolean> {
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    // readdir throws ENOENT for an absent dir → absent counts as "empty".
    return true;
  }
  return entries.length === 0;
}

/**
 * Run `git <args>` via execFile. Rejects with a WorkdirMaterializeError that
 * carries the trimmed stderr so the dispatch error is actionable.
 */
function runGit(
  args: string[],
  cwd: string | undefined,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err) {
          const detail = (stderr || err.message || '').toString().trim().slice(0, 1024);
          reject(new WorkdirMaterializeError(`git ${args[0]} failed: ${detail || '<no stderr>'}`));
          return;
        }
        resolve();
      },
    );
  });
}

/**
 * Materialize the dispatch's persistent workdir. Idempotent + safe to call on
 * every dispatch — a `clone`/`init` that already happened is a no-op.
 *
 * Per source:
 *   - `clone`: if `cwd` is already a git repo → reuse (no-op); else if absent /
 *     empty → `git clone --depth 1 <sourceRef> <cwd>`. A non-empty non-git dir
 *     is an error (we won't clone over the user's files).
 *   - `init`: if `cwd` is already a git repo → reuse; else mkdir -p + `git init`.
 *   - `host-pick` / `container-pick`: the path must already exist (the user
 *     picked it) → verify. No clone/init. Missing → error.
 *
 * @throws WorkdirMaterializeError on any failure (bad clone, missing pick path).
 */
export async function ensureWorkdir(
  spec: WorkdirSpec,
  opts: { timeoutMs?: number } = {},
): Promise<EnsureWorkdirResult> {
  const timeoutMs = opts.timeoutMs ?? GIT_TIMEOUT_MS;
  const cwd = spec.cwd;
  if (!cwd || cwd.trim().length === 0) {
    throw new WorkdirMaterializeError('workdir.cwd is empty');
  }

  let result: EnsureWorkdirResult;
  switch (spec.source) {
    case 'clone': {
      if (await isGitRepo(cwd)) {
        log(`reuse clone id=${spec.id} cwd=${cwd} (already a git repo)`);
        result = { cwd, action: 'reused' };
        break;
      }
      if (!spec.sourceRef || spec.sourceRef.trim().length === 0) {
        throw new WorkdirMaterializeError(
          `workdir source='clone' requires sourceRef (id=${spec.id})`,
        );
      }
      if (!(await isAbsentOrEmpty(cwd))) {
        throw new WorkdirMaterializeError(
          `workdir cwd=${cwd} is non-empty and not a git repo; refusing to clone over it (id=${spec.id})`,
        );
      }
      // Parent must exist for `git clone <ref> <cwd>`.
      const parent = cwd.replace(/\/+$/, '').replace(/\/[^/]+$/, '') || '/';
      await fsp.mkdir(parent, { recursive: true });
      log(`clone id=${spec.id} ref=${spec.sourceRef} → cwd=${cwd}`);
      await runGit(['clone', '--depth', '1', spec.sourceRef, cwd], undefined, timeoutMs);
      result = { cwd, action: 'cloned' };
      break;
    }

    case 'init': {
      if (await isGitRepo(cwd)) {
        log(`reuse init id=${spec.id} cwd=${cwd} (already a git repo)`);
        result = { cwd, action: 'reused' };
        break;
      }
      await fsp.mkdir(cwd, { recursive: true });
      log(`init id=${spec.id} cwd=${cwd}`);
      await runGit(['init'], cwd, timeoutMs);
      result = { cwd, action: 'init' };
      break;
    }

    case 'host-pick':
    case 'container-pick': {
      if (!(await pathExists(cwd))) {
        throw new WorkdirMaterializeError(
          `workdir source='${spec.source}' path does not exist: ${cwd} (id=${spec.id})`,
        );
      }
      log(`verified ${spec.source} id=${spec.id} cwd=${cwd}`);
      // host-pick/container-pick land on an existing folder → append-only seed.
      result = { cwd, action: 'verified' };
      break;
    }

    default: {
      // Exhaustiveness guard — a new source value reaching here is a wiring bug.
      throw new WorkdirMaterializeError(
        `unknown workdir source='${String((spec as WorkdirSpec).source)}' (id=${spec.id})`,
      );
    }
  }

  // release203/09 §7.5 — seed the dev preset bundle into the materialized
  // workdir. Best-effort: seeding must NEVER fail the materialize (the user
  // asked for the repo, not the preset). Same non-fatal posture as the repos/
  // mkdir in dispatch.ts.
  try {
    await seedDevPreset(result.cwd, result.action);
  } catch (err) {
    log(`seed dev preset failed (non-fatal) cwd=${result.cwd}: ${(err as Error).message}`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// release203/09 §7.3 — `agent.workdir.materialize` cwd resolution + jail.
//
// Pure decision extracted from the runner's `onAgentWorkdirMaterialize` so it
// can be unit-tested without a live daemon (mirrors fs-list.ts). It resolves
// the absolute target cwd from the logical request scope, then enforces that
// the result stays inside the workspace jail root. The actual on-disk
// materialization (`ensureWorkdir`) is the caller's job — this only decides the
// path and whether it is allowed.
// ---------------------------------------------------------------------------

/** Sources accepted on the `agent.workdir.materialize` RPC. */
export type MaterializeSource = 'clone' | 'init' | 'container-pick';

export type ResolveWorkdirCwdResult =
  | { ok: true; cwd: string }
  | { ok: false; code: 'bad_request' | 'path_escape'; message?: string };

/**
 * Resolve + jail the target cwd for an `agent.workdir.materialize` request.
 *
 * - `clone` / `init`: `name` must be a single safe folder segment; the cwd is
 *   `base/<name>` (base is the per-project `repos/` dir, already under root).
 * - `container-pick`: the picked absolute path arrives in `cwd` (from the
 *   /fs/list picker) and is used as-is; the jail check is what protects it.
 *
 * JAIL (all sources): the resolved cwd must equal `root` or live strictly
 * underneath it, else `path_escape`. Containment is decided on REALPATHS
 * (`resolveWithinJail`) — a lexical check is defeated by a symlink planted
 * inside the root, and the agent that works in this tree can plant one.
 *
 * @param base per-project `repos/` absolute path (`resolveProjectReposDir`)
 * @param root workspace jail root (`workspaces/<wid>`)
 */
export function resolveWorkdirCwd(
  base: string,
  root: string,
  source: MaterializeSource,
  name: string | undefined,
  cwd: string | undefined,
): ResolveWorkdirCwdResult {
  let target: string;
  if (source === 'clone' || source === 'init') {
    if (!isSafeSegment(name)) {
      return { ok: false, code: 'bad_request', message: 'name must be a single folder segment' };
    }
    target = path.resolve(base, name);
  } else if (source === 'container-pick') {
    if (!cwd || cwd.trim().length === 0) {
      return { ok: false, code: 'bad_request', message: 'container-pick requires cwd' };
    }
    target = path.resolve(cwd);
  } else {
    return { ok: false, code: 'bad_request', message: `unknown source '${String(source)}'` };
  }

  // JAIL — target must be the workspace root itself or strictly underneath it.
  const jailed = resolveWithinJail(root, target);
  if (!jailed.ok) {
    return { ok: false, code: 'path_escape' };
  }

  return { ok: true, cwd: jailed.path };
}
