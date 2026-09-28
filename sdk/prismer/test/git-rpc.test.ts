/**
 * apc/05 §1 A2 (S8 git-ops) — daemon git RPC.
 *
 * apc/14 D4: the previous "reports merge conflicts" case never created a
 * conflict. Its cwd was an empty `mkdtemp` dir (not even a git repo) so both
 * assertions threw during argument validation, and the assertion itself was
 * `toBeInstanceOf(GitRpcError)` — the module's ONLY error class, hence
 * vacuously true. The `conflict` code path had never executed.
 *
 * Every case below runs REAL git against REAL repositories and asserts a real
 * side effect (refs, worktree state, `.git/MERGE_HEAD`, the receiving bare
 * repo's refs). Every case carries its own negative control. No `mkdtemp`
 * non-repo shortcuts, no `toBeInstanceOf` on the single error class — errors
 * are asserted on `code`, which is discriminating.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  DEFAULT_REMOTE_ALLOWLIST,
  GitRpcError,
  gitRpc,
  remoteAllowlistFromEnv,
  resolveGitCwd,
  runGitExecRequest,
} from '../src/daemon/git-rpc.js';

// Per-file time budget, NOT an assertion change — every assertion below is
// untouched. These cases drive REAL `git` subprocesses (init/commit/fetch over
// ~23 exec points), so the file needs ~25s even with zero contention and ~46s
// when the full runtime suite runs its workers in parallel. Against the 10s
// per-test default that made the file cross the budget only under load, i.e. a
// FLAKY red: `run.ts --tier=T0 --diff` reported it as a `regression` (exit 1)
// while `vitest run` on the same code was 175/175 green. A gate that invents a
// regression with no code change is exactly the "恒红门" the --diff judgment
// exists to kill, so the budget is raised to fit the real work. A genuine hang
// still fails — this delays the deadline, it does not remove it.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const ex = promisify(execFile);
const IDENT = ['-c', 'user.email=x@y', '-c', 'user.name=x'];

const tmpRoots: string[] = [];
afterEach(async () => {
  while (tmpRoots.length) {
    const dir = tmpRoots.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

/**
 * A workspace jail root with a real git repo inside it (`<root>/repo`).
 *
 * The root is REALPATH-resolved: on macOS `os.tmpdir()` is itself a symlink
 * (`/var` → `/private/var`), and a test that compared a symlinked root against
 * a resolved target would be measuring the platform, not the jail.
 */
async function makeWorkspace(): Promise<{ root: string; repo: string }> {
  const raw = await mkdtemp(path.join(tmpdir(), 'git-rpc-ws-'));
  tmpRoots.push(raw);
  const root = realpathSync(raw);
  const repo = path.join(root, 'repo');
  await ex('git', ['init', '-q', '-b', 'main', repo]);
  await writeFile(path.join(repo, 'a.txt'), 'base\n');
  await ex('git', ['add', '.'], { cwd: repo });
  await ex('git', [...IDENT, 'commit', '-qm', 'init'], { cwd: repo });
  return { root, repo };
}

async function head(repo: string): Promise<string> {
  return (await ex('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
}
async function currentBranch(repo: string): Promise<string> {
  return (await ex('git', ['branch', '--show-current'], { cwd: repo })).stdout.trim();
}
async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Build `main` and `feat` so that merging `feat` into `main` conflicts on a.txt. */
async function makeConflict(repo: string): Promise<void> {
  await ex('git', ['switch', '-qc', 'feat'], { cwd: repo });
  await writeFile(path.join(repo, 'a.txt'), 'from-feat\n');
  await ex('git', ['add', '.'], { cwd: repo });
  await ex('git', [...IDENT, 'commit', '-qm', 'feat'], { cwd: repo });
  await ex('git', ['switch', '-q', 'main'], { cwd: repo });
  await writeFile(path.join(repo, 'a.txt'), 'from-main\n');
  await ex('git', ['add', '.'], { cwd: repo });
  await ex('git', [...IDENT, 'commit', '-qm', 'main'], { cwd: repo });
}

describe('daemon git RPC — branch / commit', () => {
  it('creates a branch and commits, returning the real sha', async () => {
    const { root, repo } = await makeWorkspace();
    const before = await head(repo);

    await gitRpc({ op: 'branch', root, cwd: repo, branch: 'feat/test' });
    expect(await currentBranch(repo)).toBe('feat/test');

    await writeFile(path.join(repo, 'b.txt'), 'b\n');
    await ex('git', ['add', '.'], { cwd: repo });
    const res = await gitRpc({ op: 'commit', root, cwd: repo, message: 'feature' });

    // Side effect: HEAD moved, and the returned sha IS the new HEAD.
    const after = await head(repo);
    expect(after).not.toBe(before);
    expect(res.sha).toBe(after);
    expect(res.sha).toMatch(/^[0-9a-f]{40}$/);
    // Provenance is only useful if the sha is reachable as a real commit.
    expect((await ex('git', ['cat-file', '-t', res.sha!], { cwd: repo })).stdout.trim()).toBe('commit');
  });

  // NEGATIVE CONTROL for the commit case: with nothing staged, git refuses and
  // HEAD must not move (no sha is fabricated).
  it('negative control — commit with nothing staged fails and leaves HEAD put', async () => {
    const { root, repo } = await makeWorkspace();
    const before = await head(repo);
    await expect(gitRpc({ op: 'commit', root, cwd: repo, message: 'empty' })).rejects.toMatchObject({
      code: 'git_failed',
    });
    expect(await head(repo)).toBe(before);
  });

  // NEGATIVE CONTROL for ref validation: a flag-shaped branch must never reach argv.
  it('negative control — flag-shaped / traversing refs are rejected before git runs', async () => {
    const { root, repo } = await makeWorkspace();
    for (const bad of ['--upload-pack=touch /tmp/pwned', 'a..b', '']) {
      await expect(gitRpc({ op: 'branch', root, cwd: repo, branch: bad })).rejects.toMatchObject({
        code: 'bad_request',
      });
    }
    expect(await currentBranch(repo)).toBe('main');
  });
});

describe('daemon git RPC — cwd jail (apc/05 §1 A2 hardening)', () => {
  it('runs inside the jail root', async () => {
    const { root, repo } = await makeWorkspace();
    const res = await gitRpc({ op: 'branch', root, cwd: repo, branch: 'inside' });
    expect(res.ref).toBe('inside');
    expect(await currentBranch(repo)).toBe('inside');
  });

  // NEGATIVE CONTROL: a repo that exists and is perfectly valid but lives
  // OUTSIDE the jail must be refused, and must be provably untouched.
  it('negative control — a real repo outside the root is refused and untouched', async () => {
    const { root } = await makeWorkspace();
    const outside = await makeWorkspace(); // separate root → outside `root`
    const outsideBranchBefore = await currentBranch(outside.repo);

    await expect(gitRpc({ op: 'branch', root, cwd: outside.repo, branch: 'pwned' })).rejects.toMatchObject({
      code: 'path_escape',
    });
    // Side-effect oracle: the outside repo's branch set is unchanged.
    expect(await currentBranch(outside.repo)).toBe(outsideBranchBefore);
    const branches = (await ex('git', ['branch', '--list'], { cwd: outside.repo })).stdout;
    expect(branches).not.toContain('pwned');
  });

  it('negative control — `..` traversal out of the root is refused', async () => {
    const { root } = await makeWorkspace();
    expect(resolveGitCwd(root, path.join(root, '..'))).toMatchObject({ ok: false, code: 'path_escape' });
    expect(resolveGitCwd(root, '../..')).toMatchObject({ ok: false, code: 'path_escape' });
    // A sibling directory whose name merely PREFIXES the root must not pass the
    // containment check.
    expect(resolveGitCwd(root, `${root}-evil`)).toMatchObject({ ok: false, code: 'path_escape' });
    // Positive side: the root itself and children resolve.
    expect(resolveGitCwd(root, root)).toEqual({ ok: true, cwd: root });
    expect(resolveGitCwd(root, 'repo')).toEqual({ ok: true, cwd: path.join(root, 'repo') });
    // Fail-closed: no root ⇒ no git.
    expect(resolveGitCwd(undefined, root)).toMatchObject({ ok: false, code: 'bad_request' });
  });
});

// ---------------------------------------------------------------------------
// F3 — the jail must survive a symlink, because the party that can plant one is
// the party the jail exists to contain (git-rpc.ts:10-12 names the coding agent
// as the adversary, and that agent has full write access to its own workdir).
//
// Before the fix `resolveGitCwd` compared `path.resolve` results, which do not
// follow symlinks: `ln -s <outside repo> link` inside the root, then
// `cwd:'link'`, wrote a branch into a repo on the other side of the jail
// (reproduced against real git — the outside repo really ended up on
// `* symlink-pwned`).
// ---------------------------------------------------------------------------
describe('daemon git RPC — cwd jail resolves symlinks (F3)', () => {
  it('a symlink inside the root pointing OUT is refused, and the outside repo is untouched', async () => {
    const { root } = await makeWorkspace();
    const outside = await makeWorkspace();
    const outsideBranchesBefore = (await ex('git', ['branch', '--list'], { cwd: outside.repo })).stdout;
    await symlink(outside.repo, path.join(root, 'link'));

    await expect(gitRpc({ op: 'branch', root, cwd: 'link', branch: 'symlink-pwned' })).rejects.toMatchObject({
      code: 'path_escape',
    });

    // Side-effect oracle: the far-side repo's refs are byte-identical.
    expect((await ex('git', ['branch', '--list'], { cwd: outside.repo })).stdout).toBe(outsideBranchesBefore);
    expect((await ex('git', ['branch', '--list'], { cwd: outside.repo })).stdout).not.toContain('symlink-pwned');
  });

  it('an absolute cwd whose PARENT is a symlink out of the root is refused too', async () => {
    const { root } = await makeWorkspace();
    const outside = await makeWorkspace();
    // `<root>/nest` → `<outsideRoot>`, so `<root>/nest/repo` is a real repo path
    // that is lexically inside the root and physically outside it.
    await symlink(outside.root, path.join(root, 'nest'));
    const before = (await ex('git', ['branch', '--list'], { cwd: outside.repo })).stdout;

    await expect(
      gitRpc({ op: 'branch', root, cwd: path.join(root, 'nest', 'repo'), branch: 'parent-pwned' }),
    ).rejects.toMatchObject({ code: 'path_escape' });

    expect((await ex('git', ['branch', '--list'], { cwd: outside.repo })).stdout).toBe(before);
  });

  // NEGATIVE CONTROL: the fix must reject symlinks that ESCAPE, not symlinks.
  // A link to a repo that really is inside the root still works — otherwise the
  // case above would pass for the wrong reason ("all symlinks refused", or "the
  // op is broken").
  it('negative control — a symlink resolving INSIDE the root still runs', async () => {
    const { root, repo } = await makeWorkspace();
    await symlink(repo, path.join(root, 'inside-link'));

    const res = await gitRpc({ op: 'branch', root, cwd: 'inside-link', branch: 'via-symlink' });
    expect(res.ref).toBe('via-symlink');
    // Side-effect oracle: the real repo behind the link moved to the branch.
    expect(await currentBranch(repo)).toBe('via-symlink');
    // …and the resolved cwd is the REAL path, so a later re-point of the link
    // cannot redirect the operation that was already approved.
    expect(resolveGitCwd(root, 'inside-link')).toEqual({ ok: true, cwd: repo });
  });
});

// ---------------------------------------------------------------------------
// F1 — the `conflict` verdict is a side effect, not a substring.
//
// git echoes caller-supplied ref names back in its error text, so the previous
// `/conflict|automatic merge failed|unmerged files/i` test on that text labelled
// ordinary failures as merge conflicts whenever the ref happened to contain the
// word. Reproduced against real git before the fix: `branch
// fix/conflict-handling` (already exists) and `merge feat/conflict-x`
// (nonexistent ref) BOTH returned code='conflict' with files=[] — which the CLI
// renders as "Merge conflict — NOT auto-resolved. Escalate to a human.
// Conflicted files (0):".
// ---------------------------------------------------------------------------
describe('daemon git RPC — conflict is judged by side effect, not by error text (F1)', () => {
  it('a failing `branch` whose NAME contains "conflict" is git_failed, not conflict', async () => {
    const { root, repo } = await makeWorkspace();
    await ex('git', ['branch', 'fix/conflict-handling'], { cwd: repo });
    const headBefore = await head(repo);

    await expect(
      gitRpc({ op: 'branch', root, cwd: repo, branch: 'fix/conflict-handling' }),
    ).rejects.toMatchObject({ code: 'git_failed' });

    // Side-effect oracle: the repo is provably NOT in a conflicted state, which
    // is the only thing that could justify escalating to a human.
    expect((await ex('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: repo })).stdout.trim()).toBe('');
    expect(await exists(path.join(repo, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(await head(repo)).toBe(headBefore);
  });

  it('a `merge` naming a NONEXISTENT ref containing "conflict" is git_failed, not conflict', async () => {
    const { root, repo } = await makeWorkspace();
    const headBefore = await head(repo);

    await expect(gitRpc({ op: 'merge', root, cwd: repo, source: 'feat/conflict-x' })).rejects.toMatchObject({
      code: 'git_failed',
    });

    expect((await ex('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: repo })).stdout.trim()).toBe('');
    expect(await exists(path.join(repo, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(await head(repo)).toBe(headBefore);
  });

  // NEGATIVE CONTROL: the two cases above must not pass because "nothing is ever
  // a conflict now". A REAL conflict on a ref whose name contains no such word
  // still escalates — and carries a NON-EMPTY file list, which is the evidence
  // the human is asked to act on.
  it('negative control — a real conflict on a plainly-named ref still escalates WITH files', async () => {
    const { root, repo } = await makeWorkspace();
    await makeConflict(repo); // branch is called `feat` — no "conflict" anywhere
    let err: GitRpcError | undefined;
    try {
      await gitRpc({ op: 'merge', root, cwd: repo, source: 'feat' });
    } catch (e) {
      err = e as GitRpcError;
    }
    expect(err?.code).toBe('conflict');
    expect(err?.files).toEqual(['a.txt']);
    expect(err?.files?.length ?? 0).toBeGreaterThan(0);
    expect(await exists(path.join(repo, '.git', 'MERGE_HEAD'))).toBe(true);
  });

  // NEGATIVE CONTROL 2: a `commit` refused BECAUSE the index carries unmerged
  // paths is a genuine conflict even though the op is not `merge` — the verdict
  // follows the repo state, so this stays `conflict` with the file list.
  it('negative control — commit blocked by unmerged paths is still conflict, with files', async () => {
    const { root, repo } = await makeWorkspace();
    await makeConflict(repo);
    await ex('git', ['merge', 'feat'], { cwd: repo }).catch(() => undefined); // leave the repo mid-conflict
    let err: GitRpcError | undefined;
    try {
      await gitRpc({ op: 'commit', root, cwd: repo, message: 'resolve?' });
    } catch (e) {
      err = e as GitRpcError;
    }
    expect(err?.code).toBe('conflict');
    expect(err?.files).toEqual(['a.txt']);
  });
});

describe('daemon git RPC — merge conflicts escalate (apc/00 §3 不变量 6)', () => {
  it('a REAL conflicting merge returns code=conflict WITH the unmerged file list', async () => {
    const { root, repo } = await makeWorkspace();
    // Second conflicting file so a list (not a single path) is exercised.
    await writeFile(path.join(repo, 'c.txt'), 'base\n');
    await ex('git', ['add', '.'], { cwd: repo });
    await ex('git', [...IDENT, 'commit', '-qm', 'add c'], { cwd: repo });
    await ex('git', ['switch', '-qc', 'feat'], { cwd: repo });
    await writeFile(path.join(repo, 'a.txt'), 'from-feat\n');
    await writeFile(path.join(repo, 'c.txt'), 'from-feat\n');
    await ex('git', ['add', '.'], { cwd: repo });
    await ex('git', [...IDENT, 'commit', '-qm', 'feat'], { cwd: repo });
    await ex('git', ['switch', '-q', 'main'], { cwd: repo });
    await writeFile(path.join(repo, 'a.txt'), 'from-main\n');
    await writeFile(path.join(repo, 'c.txt'), 'from-main\n');
    await ex('git', ['add', '.'], { cwd: repo });
    await ex('git', [...IDENT, 'commit', '-qm', 'main'], { cwd: repo });

    const beforeHead = await head(repo);

    let err: GitRpcError | undefined;
    try {
      await gitRpc({ op: 'merge', root, cwd: repo, source: 'feat' });
    } catch (e) {
      err = e as GitRpcError;
    }

    expect(err?.code).toBe('conflict');
    expect(err?.files?.sort()).toEqual(['a.txt', 'c.txt']);

    // Side-effect oracle — the merge was NOT auto-resolved and NOT rolled back:
    //   1. no merge commit was created (HEAD unchanged)
    //   2. the merge is still in progress (`.git/MERGE_HEAD` present)
    //   3. the worktree still carries conflict markers (the scene is preserved)
    //   4. git itself still reports the unmerged paths
    expect(await head(repo)).toBe(beforeHead);
    expect(await exists(path.join(repo, '.git', 'MERGE_HEAD'))).toBe(true);
    expect(await readFile(path.join(repo, 'a.txt'), 'utf8')).toContain('<<<<<<<');
    const unmerged = (await ex('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: repo })).stdout.trim();
    expect(unmerged.split('\n').sort()).toEqual(['a.txt', 'c.txt']);
  });

  // NEGATIVE CONTROL for the conflict case: the SAME merge op on a
  // non-conflicting history must succeed and produce a real merge commit —
  // proving the conflict branch is not simply "merge always fails".
  it('negative control — a non-conflicting merge succeeds and returns the merge sha', async () => {
    const { root, repo } = await makeWorkspace();
    await ex('git', ['switch', '-qc', 'feat'], { cwd: repo });
    await writeFile(path.join(repo, 'only-feat.txt'), 'f\n');
    await ex('git', ['add', '.'], { cwd: repo });
    await ex('git', [...IDENT, 'commit', '-qm', 'feat'], { cwd: repo });
    await ex('git', ['switch', '-q', 'main'], { cwd: repo });
    await writeFile(path.join(repo, 'only-main.txt'), 'm\n');
    await ex('git', ['add', '.'], { cwd: repo });
    await ex('git', [...IDENT, 'commit', '-qm', 'main'], { cwd: repo });

    // `git merge` writes the merge commit itself; identity comes from the repo
    // config, which `git init` inherits from the environment. Set it locally so
    // the merge cannot fail for a missing committer identity.
    await ex('git', ['config', 'user.email', 'x@y'], { cwd: repo });
    await ex('git', ['config', 'user.name', 'x'], { cwd: repo });

    const res = await gitRpc({ op: 'merge', root, cwd: repo, source: 'feat' });
    expect(res.sha).toBe(await head(repo));
    expect(await exists(path.join(repo, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(await exists(path.join(repo, 'only-feat.txt'))).toBe(true);
    // A real merge commit has two parents.
    const parents = (await ex('git', ['rev-list', '--parents', '-n', '1', 'HEAD'], { cwd: repo })).stdout.trim();
    expect(parents.split(/\s+/).length).toBe(3);
  });
});

describe('daemon git RPC — push: prod tag gate + remote allowlist', () => {
  /** Repo with a real bare remote so push side effects are observable. */
  async function withRemote(): Promise<{ root: string; repo: string; bare: string }> {
    const { root, repo } = await makeWorkspace();
    const bare = path.join(root, 'remote.git');
    await ex('git', ['init', '-q', '--bare', bare]);
    await ex('git', ['remote', 'add', 'origin', bare], { cwd: repo });
    await ex('git', ['remote', 'add', 'evil', bare], { cwd: repo });
    return { root, repo, bare };
  }

  it('pushes HEAD to a branch on an allowlisted remote', async () => {
    const { root, repo, bare } = await withRemote();
    const res = await gitRpc({ op: 'push', root, cwd: repo, branch: 'main', remote: 'origin' });
    expect(res.ref).toBe('HEAD:refs/heads/main');
    // Side-effect oracle: the BARE repo now carries the ref at our HEAD sha.
    const remoteSha = (await ex('git', ['rev-parse', 'refs/heads/main'], { cwd: bare })).stdout.trim();
    expect(remoteSha).toBe(await head(repo));
  });

  // NEGATIVE CONTROL for prod-tag: `k8s-test-*` must go through, all four prod
  // prefixes must not, and the bare repo must show exactly that.
  it('negative control — test tags push, all four prod prefixes are refused', async () => {
    const { root, repo, bare } = await withRemote();
    await ex('git', ['tag', 'k8s-test-20260724-v2.2.4'], { cwd: repo });
    await gitRpc({ op: 'push', root, cwd: repo, tag: 'k8s-test-20260724-v2.2.4', remote: 'origin' });
    expect(
      (await ex('git', ['tag', '--list'], { cwd: bare })).stdout,
    ).toContain('k8s-test-20260724-v2.2.4');

    for (const tag of [
      'k8s-prod-20260724-v2.2.4',
      'desktop-prod-20260724-v2.2.4',
      'prod-20260724',
      'ali-k8s-prod-20260724',
    ]) {
      // Tag exists locally — only the RPC gate stands between it and the remote.
      await ex('git', ['tag', tag], { cwd: repo });
      await expect(gitRpc({ op: 'push', root, cwd: repo, tag, remote: 'origin' })).rejects.toMatchObject({
        code: 'prod_tag',
      });
    }
    const remoteTags = (await ex('git', ['tag', '--list'], { cwd: bare })).stdout;
    expect(remoteTags).not.toMatch(/prod/);
  });

  // NEGATIVE CONTROL for the allowlist: `evil` points at the SAME bare repo and
  // would work fine — only the allowlist stops it. Then widening the allowlist
  // lets it through, proving the gate (not some unrelated failure) is what blocked.
  it('negative control — a working but non-allowlisted remote is refused; widening lets it through', async () => {
    const { root, repo, bare } = await withRemote();
    await expect(
      gitRpc({ op: 'push', root, cwd: repo, branch: 'main', remote: 'evil' }),
    ).rejects.toMatchObject({ code: 'remote_denied' });
    // Side-effect oracle: nothing landed on the bare repo.
    expect((await ex('git', ['branch', '--list'], { cwd: bare })).stdout.trim()).toBe('');

    await gitRpc({ op: 'push', root, cwd: repo, branch: 'main', remote: 'evil' }, { remoteAllowlist: ['evil'] });
    expect((await ex('git', ['rev-parse', 'refs/heads/main'], { cwd: bare })).stdout.trim()).toBe(await head(repo));
  });

  it('negative control — an option-shaped remote never reaches argv', async () => {
    const { root, repo } = await withRemote();
    for (const remote of ['--receive-pack=touch /tmp/pwned', '../evil', 'https://example.com/x.git', '-o']) {
      await expect(gitRpc({ op: 'push', root, cwd: repo, branch: 'main', remote })).rejects.toMatchObject({
        code: 'remote_denied',
      });
    }
  });

  it('remoteAllowlistFromEnv parses CSV and falls back to the default', () => {
    expect(remoteAllowlistFromEnv(undefined)).toBe(DEFAULT_REMOTE_ALLOWLIST);
    expect(remoteAllowlistFromEnv('  ')).toBe(DEFAULT_REMOTE_ALLOWLIST);
    expect(remoteAllowlistFromEnv('origin, upstream')).toEqual(['origin', 'upstream']);
  });
});

describe('runGitExecRequest — the `agent.git.exec` reverse-RPC payload path', () => {
  it('maps a payload to a real git side effect and an ok reply envelope', async () => {
    const { root, repo } = await makeWorkspace();
    const reply = await runGitExecRequest(
      { workspaceId: 'ws_1', cwd: repo, op: 'branch', branch: 'from-rpc' },
      () => root,
    );
    expect(reply).toMatchObject({ ok: true, data: { op: 'branch', ref: 'from-rpc' } });
    expect(await currentBranch(repo)).toBe('from-rpc');
  });

  it('renders a conflict into the reply error WITH files (this is what cloud escalates on)', async () => {
    const { root, repo } = await makeWorkspace();
    await makeConflict(repo);
    const reply = await runGitExecRequest({ workspaceId: 'ws_1', cwd: repo, op: 'merge', source: 'feat' }, () => root);
    expect(reply.ok).toBe(false);
    if (reply.ok) throw new Error('unreachable');
    expect(reply.error.code).toBe('conflict');
    expect(reply.error.files).toEqual(['a.txt']);
    // The scene is preserved for the human.
    expect(await exists(path.join(repo, '.git', 'MERGE_HEAD'))).toBe(true);
  });

  // NEGATIVE CONTROL: the jail root comes from the RESOLVER (daemon-side
  // workspace root), never from the payload — a payload naming a repo outside
  // it is refused even though the repo is real and writable.
  it('negative control — payload cwd outside the resolved root is path_escape', async () => {
    const { root } = await makeWorkspace();
    const outside = await makeWorkspace();
    const reply = await runGitExecRequest(
      { workspaceId: 'ws_1', cwd: outside.repo, op: 'branch', branch: 'pwned' },
      () => root,
    );
    expect(reply).toMatchObject({ ok: false, error: { code: 'path_escape' } });
    expect((await ex('git', ['branch', '--list'], { cwd: outside.repo })).stdout).not.toContain('pwned');
  });

  // ── F2 — the jail ROOT itself must not be steerable from the payload ──────
  //
  // `resolveRoot` is `join(paths.workspacesDir, workspaceId)` (runner.ts:2476)
  // and `path.join` normalizes `..`, so `workspaceId:'ws_ATTACKER/..'` lifted
  // the root to the workspaces dir and every workspace on the host fell inside
  // the jail. Reproduced against real git before the fix: the victim
  // workspace's repo went from `* main` to `  main / * pwned`.
  //
  // Cloud gates this today (`git.service.ts` membership + workdir ownership),
  // so this is defence in depth — but "cloud got it wrong" is the ONLY scenario
  // the daemon-side jail exists for, and that is exactly where it failed.
  it('a workspaceId with `..` cannot lift the jail root into another workspace', async () => {
    const workspacesDir = realpathSync(await mkdtemp(path.join(tmpdir(), 'git-rpc-wsdir-')));
    tmpRoots.push(workspacesDir);
    const attacker = path.join(workspacesDir, 'ws_ATTACKER');
    const victim = path.join(workspacesDir, 'ws_VICTIM');
    await mkdir(attacker, { recursive: true });
    await mkdir(victim, { recursive: true });
    const victimRepo = path.join(victim, 'repo');
    await ex('git', ['init', '-q', '-b', 'main', victimRepo]);
    await writeFile(path.join(victimRepo, 'a.txt'), 'base\n');
    await ex('git', ['add', '.'], { cwd: victimRepo });
    await ex('git', [...IDENT, 'commit', '-qm', 'init'], { cwd: victimRepo });
    const branchesBefore = (await ex('git', ['branch', '--list'], { cwd: victimRepo })).stdout;

    const resolveRoot = (wid: string) => path.join(workspacesDir, wid);

    for (const wid of ['ws_ATTACKER/..', '..', 'ws_ATTACKER/../ws_VICTIM', 'a/b', '  ']) {
      const reply = await runGitExecRequest(
        { workspaceId: wid, cwd: victimRepo, op: 'branch', branch: 'pwned' },
        resolveRoot,
      );
      expect(reply, `workspaceId='${wid}'`).toMatchObject({ ok: false, error: { code: 'bad_request' } });
    }

    // Side-effect oracle: the victim repo's refs are byte-identical.
    expect((await ex('git', ['branch', '--list'], { cwd: victimRepo })).stdout).toBe(branchesBefore);
    expect((await ex('git', ['branch', '--list'], { cwd: victimRepo })).stdout).not.toContain('pwned');
  });

  // NEGATIVE CONTROL for F2: the refusal above must come from the segment
  // guard, not from the repo/op being broken. The SAME call under the victim's
  // OWN workspaceId succeeds and really creates the branch.
  it('negative control — the same op under the owning workspaceId succeeds', async () => {
    const workspacesDir = realpathSync(await mkdtemp(path.join(tmpdir(), 'git-rpc-wsdir-')));
    tmpRoots.push(workspacesDir);
    const victim = path.join(workspacesDir, 'ws_VICTIM');
    await mkdir(victim, { recursive: true });
    const victimRepo = path.join(victim, 'repo');
    await ex('git', ['init', '-q', '-b', 'main', victimRepo]);
    await writeFile(path.join(victimRepo, 'a.txt'), 'base\n');
    await ex('git', ['add', '.'], { cwd: victimRepo });
    await ex('git', [...IDENT, 'commit', '-qm', 'init'], { cwd: victimRepo });

    const reply = await runGitExecRequest(
      { workspaceId: 'ws_VICTIM', cwd: victimRepo, op: 'branch', branch: 'legit' },
      (wid) => path.join(workspacesDir, wid),
    );
    expect(reply).toMatchObject({ ok: true, data: { ref: 'legit' } });
    expect(await currentBranch(victimRepo)).toBe('legit');
  });

  it('negative control — unknown op / missing workspaceId are bad_request, not silent no-ops', async () => {
    const { root, repo } = await makeWorkspace();
    expect(await runGitExecRequest({ workspaceId: 'ws_1', cwd: repo, op: 'rebase' }, () => root)).toMatchObject({
      ok: false,
      error: { code: 'bad_request' },
    });
    expect(await runGitExecRequest({ cwd: repo, op: 'commit', message: 'x' }, () => root)).toMatchObject({
      ok: false,
      error: { code: 'bad_request' },
    });
  });
});

// ---------------------------------------------------------------------------
// F2, runner half — PRE-EXISTING DEBT, tracked separately from the git-rpc fix.
//
// `runGitExecRequest` now validates the workspaceId itself, but three sibling
// RPCs build the SAME jail root the same way — `join(this.paths.workspacesDir,
// p.workspaceId)` in `agent.fs.list` / `agent.fs.read` / `agent.fs.write` /
// `agent.workdir.materialize`. `resolveWithinJail` cannot rescue them: the
// escape moves the ROOT, so containment is measured against the wrong boundary
// and every check still passes.
//
// Those handlers are private methods on a Runner that needs a live config + WS
// to construct, so this is a SOURCE contract (the technique
// runtime-ota-contract.test.ts uses for the same reason): every construction of
// a workspace root must be paired with a segment guard. It is deliberately
// mechanical — it catches "someone added a fifth workspace-rooted RPC without
// the guard", which is exactly how this class of hole appeared.
// ---------------------------------------------------------------------------
describe('runner — every workspace-rooted RPC guards the workspaceId segment (F2, pre-existing sites)', () => {
  const runnerSrc = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'daemon', 'runner.ts'),
    'utf8',
  );

  it('the number of workspace jail roots built equals the number of segment guards', () => {
    const roots = runnerSrc.match(/join\(this\.paths\.workspacesDir, ?p\.workspaceId\)/g) ?? [];
    const guards = runnerSrc.match(/isSafeSegment\(p\.workspaceId\)/g) ?? [];
    // 4 today: fs.list / fs.read / fs.write / workdir.materialize. The git RPC
    // builds its root through the same helper but guards inside
    // runGitExecRequest, so it is not counted here.
    expect(roots.length).toBeGreaterThanOrEqual(4);
    expect(guards.length).toBe(roots.length);
  });

  it('the guard is the shared predicate, not a local re-implementation', () => {
    // A second copy of this predicate is how the two halves drift apart.
    expect(runnerSrc).toContain(`from './path-jail.js'`);
    expect(runnerSrc).not.toMatch(/function isSafeSegment/);
  });
});
