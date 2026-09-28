// apc/05 §1 A2 (S8 git-ops) — daemon-side git RPC.
//
// The daemon owns the workdir on disk, so commit / branch / merge / push must
// execute here and be driven from cloud over the WS reverse channel — exactly
// the shape `agent.workdir.materialize` already uses (cloud
// `src/im/services/workdir.service.ts:103-114` → daemon
// `runner.ts:2127` → `workdir-materialize.ts`).
//
// Hard invariants (apc/00 §3 不变量 6, apc/05 §1 A2, apc/01 §3):
//   - **cwd jail**: every op resolves + jails its cwd inside the workspace root,
//     mirroring `resolveWorkdirCwd` (workdir-materialize.ts:260). A request may
//     not touch a repo outside the workspace the caller was authorized for.
//   - **remote allowlist**: `push` may only name a remote from an explicit
//     allowlist. A bare `remote` string is also a git *option* position, so an
//     unvalidated value is straight command execution (`--receive-pack=…`).
//   - **no force**: no `--force`, no `+refs`, no `--strategy`/`-X` conflict
//     auto-resolution anywhere in this file.
//   - **conflicts escalate**: a merge conflict returns `code:'conflict'` WITH
//     the unmerged file list and the worktree is left exactly as git left it
//     (no `merge --abort`, no `reset`) so a human can inspect the scene.
//   - **prod tags refused**: the four prod-triggering tag prefixes
//     (`.gitlab-ci.yml` — `k8s-prod-*` / `desktop-prod-*` / `prod-*` /
//     `ali-k8s-prod-*`) are refused daemon-side. This is defence in depth, not
//     the闸 — the real one is GitLab protected tags (apc/01 §3).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isSafeSegment, resolveWithinJail } from './path-jail.js';

const exec = promisify(execFile);

/** apc/01 §3 — all four prod-triggering tag prefixes. */
const PROD_TAG = /^(?:k8s-prod-|desktop-prod-|prod-|ali-k8s-prod-)/;

/** Default cap on any single git subprocess (a push to a dead remote hangs). */
const GIT_TIMEOUT_MS = 120_000;

/** Remotes a daemon may push to unless the host explicitly widens the set. */
export const DEFAULT_REMOTE_ALLOWLIST: readonly string[] = ['origin'];

export type GitRpcOp = 'commit' | 'branch' | 'merge' | 'push';

export const GIT_RPC_OPS: readonly GitRpcOp[] = ['commit', 'branch', 'merge', 'push'];

export interface GitRpcRequest {
  op: GitRpcOp;
  /**
   * Jail root — the resolved `cwd` must be this path or live strictly under it.
   * Required (fail-closed): callers that cannot name a root cannot run git.
   */
  root: string;
  /** Repo directory to operate in (absolute, or relative to `root`). */
  cwd: string;
  message?: string;
  branch?: string;
  source?: string;
  remote?: string;
  tag?: string;
}

export interface GitRpcOptions {
  /** Remote NAMES allowed for `push`. Defaults to `DEFAULT_REMOTE_ALLOWLIST`. */
  remoteAllowlist?: readonly string[];
  timeoutMs?: number;
}

export interface GitRpcResult {
  ok: true;
  op: GitRpcOp;
  stdout: string;
  /** Ref the op acted on (branch name / merged source / pushed refspec). */
  ref?: string;
  /**
   * Commit sha after the op, for `commit` and `merge`. apc/05 §1 A2 (3):
   * task↔branch↔commit provenance is written from this into task metadata.
   */
  sha?: string;
}

export type GitRpcErrorCode =
  | 'bad_request'
  | 'path_escape'
  | 'remote_denied'
  | 'conflict'
  | 'prod_tag'
  | 'git_failed';

export class GitRpcError extends Error {
  constructor(
    public readonly code: GitRpcErrorCode,
    message: string,
    /** Unmerged paths, populated for `code === 'conflict'`. */
    public readonly files?: string[],
  ) {
    super(message);
    this.name = 'GitRpcError';
  }
}

function validRef(ref: string | undefined): string {
  if (!ref || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) || ref.includes('..') || ref.startsWith('-'))
    throw new GitRpcError('bad_request', 'invalid git ref');
  return ref;
}

export type ResolveGitCwdResult =
  | { ok: true; cwd: string }
  | { ok: false; code: 'bad_request' | 'path_escape'; message?: string };

/**
 * Resolve + jail the repo directory for a git RPC.
 *
 * The containment check runs on REALPATHS (`resolveWithinJail`), not on the
 * lexical `path.resolve` result. A lexical jail is worth ~nothing against this
 * module's primary adversary: the threat model at the top of this file is the
 * coding agent working in the workdir, and that agent has full filesystem write
 * access there — `ln -s /some/other/repo link` inside the root would otherwise
 * let `cwd:'link'` operate on any repo on the host.
 *
 * The resolved REAL path is what gets returned (and therefore what git runs
 * in), so the check cannot be sidestepped by re-pointing the symlink after it.
 */
export function resolveGitCwd(root: string | undefined, cwd: string | undefined): ResolveGitCwdResult {
  if (!root || root.trim().length === 0) {
    return { ok: false, code: 'bad_request', message: 'jail root is required' };
  }
  if (!cwd || cwd.trim().length === 0) {
    return { ok: false, code: 'bad_request', message: 'cwd is required' };
  }
  const jailed = resolveWithinJail(root, cwd);
  if (!jailed.ok) {
    return { ok: false, code: 'path_escape', message: 'cwd escapes the workspace root' };
  }
  return { ok: true, cwd: jailed.path };
}

/**
 * A remote must be a plain NAME from the allowlist — never a URL and never
 * something git would read as an option. `git push --receive-pack=<cmd>` runs
 * `<cmd>` on the far side, and `git push <url>` bypasses the host's configured
 * remotes entirely, so both shapes are refused before the allowlist lookup.
 */
function checkRemote(remote: string | undefined, allowlist: readonly string[]): string {
  const name = (remote ?? 'origin').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new GitRpcError('remote_denied', `remote '${name}' is not a plain remote name`);
  }
  if (!allowlist.includes(name)) {
    throw new GitRpcError(
      'remote_denied',
      `remote '${name}' is not in the allowlist [${allowlist.join(', ')}]`,
    );
  }
  return name;
}

/** Local-first daemon git RPC. No force operations and conflicts always escalate. */
export async function gitRpc(req: GitRpcRequest, opts: GitRpcOptions = {}): Promise<GitRpcResult> {
  if (!req || !req.op) throw new GitRpcError('bad_request', 'op is required');
  if (!GIT_RPC_OPS.includes(req.op)) throw new GitRpcError('bad_request', `unknown op '${String(req.op)}'`);

  const jailed = resolveGitCwd(req.root, req.cwd);
  if (!jailed.ok) throw new GitRpcError(jailed.code, jailed.message ?? 'cwd rejected');
  const cwd = jailed.cwd;

  const allowlist = opts.remoteAllowlist ?? DEFAULT_REMOTE_ALLOWLIST;
  const timeout = opts.timeoutMs ?? GIT_TIMEOUT_MS;

  const run = async (args: string[]) => {
    try {
      return await exec('git', args, { cwd, timeout, maxBuffer: 2 * 1024 * 1024 });
    } catch (e: unknown) {
      const err = e as { stderr?: string; stdout?: string; message?: string };
      // git writes merge-conflict lines to STDOUT (verified: `Automatic merge
      // failed` + `CONFLICT (…)` are stdout, stderr is empty), so both streams
      // must be inspected — an `||` chain drops the conflict text whenever
      // stderr happens to be non-empty.
      const detail =
        [err?.stderr, err?.stdout].filter((s) => typeof s === 'string' && s.trim().length > 0).join('\n').trim() ||
        String(err?.message ?? 'git failed').trim();
      // The `conflict` verdict is taken from a SIDE EFFECT — git's own unmerged
      // index / in-progress merge — and NEVER from the error text. git echoes
      // caller-supplied ref names back in its messages, so a substring match on
      // "conflict" classified `branch 'fix/conflict-handling' already exists`
      // and `merge: feat/conflict-x - not something we can merge` as merge
      // conflicts: a typo was rendered to the human as "Merge conflict — NOT
      // auto-resolved. Escalate." with an EMPTY evidence list. This is the same
      // rule the repo's acceptance discipline states for oracles: assert the
      // side effect, never the wording.
      const files = await unmergedPaths(cwd, timeout);
      if (files.length > 0 || (await mergeInProgress(cwd, timeout))) {
        throw new GitRpcError('conflict', detail, files);
      }
      throw new GitRpcError('git_failed', detail);
    }
  };

  const headSha = async (): Promise<string | undefined> => {
    try {
      const r = await exec('git', ['rev-parse', 'HEAD'], { cwd, timeout, maxBuffer: 64 * 1024 });
      return r.stdout.trim() || undefined;
    } catch {
      // Provenance is best-effort; never turn a successful commit into a failure.
      return undefined;
    }
  };

  switch (req.op) {
    case 'commit': {
      const msg = req.message?.trim();
      if (!msg) throw new GitRpcError('bad_request', 'commit message is required');
      const r = await run(['commit', '-m', msg]);
      return { ok: true, op: req.op, stdout: r.stdout.trim(), sha: await headSha() };
    }
    case 'branch': {
      const branch = validRef(req.branch);
      const r = await run(['switch', '-c', branch]);
      return { ok: true, op: req.op, ref: branch, stdout: r.stdout.trim() };
    }
    case 'merge': {
      const source = validRef(req.source);
      const r = await run(['merge', '--no-edit', source]);
      return { ok: true, op: req.op, ref: source, stdout: r.stdout.trim(), sha: await headSha() };
    }
    case 'push': {
      const tag = req.tag;
      if (tag && PROD_TAG.test(tag))
        throw new GitRpcError('prod_tag', 'prod-triggering tags are forbidden by daemon RPC');
      // Allowlist BEFORE any git invocation — a denied remote must never reach
      // the subprocess argv.
      const remote = checkRemote(req.remote, allowlist);
      const ref = tag ? `refs/tags/${validRef(tag)}` : `HEAD:refs/heads/${validRef(req.branch)}`;
      const r = await run(['push', remote, ref]);
      return { ok: true, op: req.op, ref, stdout: r.stdout.trim() };
    }
  }
}

/**
 * Unmerged (conflicted) paths in `cwd`. Best-effort: a failure here must not
 * mask the conflict itself, so it degrades to an empty list.
 */
async function unmergedPaths(cwd: string, timeoutMs: number): Promise<string[]> {
  try {
    const r = await exec('git', ['diff', '--name-only', '--diff-filter=U'], {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    });
    return r.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

/**
 * True when the repo is sitting in a stopped merge (`MERGE_HEAD` present).
 * Second side-effect signal for the conflict verdict: it keeps a merge that
 * halted with an empty unmerged set from being reported as a plain failure,
 * which would drop 不变量 6's escalation.
 */
async function mergeInProgress(cwd: string, timeoutMs: number): Promise<boolean> {
  try {
    await exec('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// `agent.git.exec` reverse-RPC request handling.
//
// Extracted out of the runner (mirroring how `resolveWorkdirCwd` was extracted
// from `onAgentWorkdirMaterialize`) so the load-bearing path — payload parsing
// → jail → real git → reply envelope — is unit-testable against real repos
// without a live daemon. The runner case is then pure glue: rpcId + ws.send.
// ---------------------------------------------------------------------------

export interface GitExecPayload {
  workspaceId?: string;
  cwd?: string;
  op?: string;
  message?: string;
  branch?: string;
  source?: string;
  remote?: string;
  tag?: string;
  _rpcId?: string;
}

export type GitExecReply =
  | { ok: true; data: Omit<GitRpcResult, 'ok'> }
  | { ok: false; error: { code: GitRpcErrorCode; message: string; files?: string[] } };

/**
 * Execute an `agent.git.exec` payload.
 *
 * @param resolveRoot maps the request's workspaceId to the jail root on this
 *   host (`join(paths.workspacesDir, workspaceId)` in the runner).
 */
export async function runGitExecRequest(
  payload: GitExecPayload | undefined,
  resolveRoot: (workspaceId: string) => string,
  opts: GitRpcOptions = {},
): Promise<GitExecReply> {
  const p = payload ?? {};
  // The workspaceId is a PATH SEGMENT — `resolveRoot` joins it onto the
  // daemon's workspaces dir to build the jail ROOT. `path.join` normalizes, so
  // an unchecked `'ws_A/..'` lifts the root to the workspaces dir itself and
  // the jail then contains every workspace on this host (verified: it created
  // a branch in another workspace's repo). Validating the segment is what
  // makes the daemon-side jail hold when the cloud-side gate is wrong — which
  // is the only reason this second layer exists.
  if (!isSafeSegment(p.workspaceId)) {
    return {
      ok: false,
      error: { code: 'bad_request', message: 'workspaceId must be a single path segment' },
    };
  }
  if (!p.op || !GIT_RPC_OPS.includes(p.op as GitRpcOp)) {
    return {
      ok: false,
      error: { code: 'bad_request', message: `op must be one of: ${GIT_RPC_OPS.join(', ')}` },
    };
  }
  try {
    const { ok: _ok, ...data } = await gitRpc(
      {
        op: p.op as GitRpcOp,
        root: resolveRoot(p.workspaceId),
        cwd: p.cwd ?? '',
        message: p.message,
        branch: p.branch,
        source: p.source,
        remote: p.remote,
        tag: p.tag,
      },
      opts,
    );
    return { ok: true, data };
  } catch (err) {
    if (err instanceof GitRpcError) {
      return {
        ok: false,
        error: { code: err.code, message: err.message, ...(err.files ? { files: err.files } : {}) },
      };
    }
    return { ok: false, error: { code: 'git_failed', message: (err as Error).message } };
  }
}

/** Parse `PRISMER_GIT_REMOTE_ALLOWLIST` (comma-separated). Empty → default. */
export function remoteAllowlistFromEnv(raw: string | undefined): readonly string[] {
  const names = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return names.length > 0 ? names : DEFAULT_REMOTE_ALLOWLIST;
}
