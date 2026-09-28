// release203/06 §3.7 (block 1) — repo-scoped code-agent workdir tests.
//
// Covers:
//   1. ensureWorkdir per source (clone / init / host-pick / container-pick),
//      mocking `git` via vi.mock('node:child_process') so no real network/git.
//   2. The dispatch cwd-override decision (shouldOverrideCwdForWorkdir):
//      repo-scoped adapters (codex/claude-code) + a workdir → override;
//      conversational adapters (hermes/openclaw) or no workdir → no override.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── Mock node:child_process execFile so `git` calls are observable + offline ──
const execFileMock = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (
    cmd: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => execFileMock(cmd, args, _opts, cb),
}));

import {
  ensureWorkdir,
  resolveWorkdirCwd,
  WorkdirMaterializeError,
  type WorkdirSpec,
} from '../src/daemon/workdir-materialize.js';
import {
  isRepoScopedAdapter,
  shouldOverrideCwdForWorkdir,
} from '../src/daemon/dispatch.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'workdir-test-'));
  // Default: git succeeds with no output.
  execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(null, '', ''));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  execFileMock.mockReset();
});

function gitCalls(): string[][] {
  return execFileMock.mock.calls.map((c) => c[1] as string[]);
}

describe('ensureWorkdir — clone', () => {
  it('invokes git clone with sourceRef + cwd when cwd is absent', async () => {
    const cwd = join(tmpRoot, 'repo-absent');
    const spec: WorkdirSpec = {
      id: 'wd1',
      cwd,
      source: 'clone',
      sourceRef: 'https://example.com/foo.git',
    };
    const res = await ensureWorkdir(spec);
    expect(res.action).toBe('cloned');
    const calls = gitCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe('clone');
    expect(calls[0]).toContain('https://example.com/foo.git');
    expect(calls[0]).toContain(cwd);
  });

  it('clones into an existing but EMPTY dir', async () => {
    const cwd = join(tmpRoot, 'repo-empty');
    mkdirSync(cwd, { recursive: true });
    const res = await ensureWorkdir({
      id: 'wd2',
      cwd,
      source: 'clone',
      sourceRef: 'git@host:bar.git',
    });
    expect(res.action).toBe('cloned');
    expect(gitCalls()[0]![0]).toBe('clone');
  });

  it('is idempotent — no clone when cwd is already a git repo', async () => {
    const cwd = join(tmpRoot, 'repo-existing');
    mkdirSync(join(cwd, '.git'), { recursive: true });
    const res = await ensureWorkdir({
      id: 'wd3',
      cwd,
      source: 'clone',
      sourceRef: 'https://example.com/foo.git',
    });
    expect(res.action).toBe('reused');
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('refuses to clone over a non-empty non-git dir', async () => {
    const cwd = join(tmpRoot, 'repo-dirty');
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, 'leftover.txt'), 'x');
    await expect(
      ensureWorkdir({ id: 'wd4', cwd, source: 'clone', sourceRef: 'r' }),
    ).rejects.toThrow(WorkdirMaterializeError);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('errors when sourceRef is missing for clone', async () => {
    const cwd = join(tmpRoot, 'repo-norefs');
    await expect(
      ensureWorkdir({ id: 'wd5', cwd, source: 'clone' }),
    ).rejects.toThrow(/sourceRef/);
  });

  it('surfaces git clone failure as WorkdirMaterializeError with stderr', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) =>
      cb(new Error('exit 128'), '', 'fatal: repository not found'),
    );
    const cwd = join(tmpRoot, 'repo-fail');
    await expect(
      ensureWorkdir({ id: 'wd6', cwd, source: 'clone', sourceRef: 'bad' }),
    ).rejects.toThrow(/repository not found/);
  });
});

describe('ensureWorkdir — init', () => {
  it('invokes git init in a fresh cwd', async () => {
    const cwd = join(tmpRoot, 'init-fresh');
    const res = await ensureWorkdir({ id: 'wi1', cwd, source: 'init' });
    expect(res.action).toBe('init');
    const calls = gitCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe('init');
  });

  it('is idempotent — no init when cwd is already a git repo', async () => {
    const cwd = join(tmpRoot, 'init-existing');
    mkdirSync(join(cwd, '.git'), { recursive: true });
    const res = await ensureWorkdir({ id: 'wi2', cwd, source: 'init' });
    expect(res.action).toBe('reused');
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

describe('ensureWorkdir — host-pick / container-pick', () => {
  it('verifies an existing picked path, no git invoked', async () => {
    const cwd = join(tmpRoot, 'picked');
    mkdirSync(cwd, { recursive: true });
    const host = await ensureWorkdir({ id: 'wp1', cwd, source: 'host-pick' });
    expect(host.action).toBe('verified');
    const container = await ensureWorkdir({ id: 'wp2', cwd, source: 'container-pick' });
    expect(container.action).toBe('verified');
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('errors with a clear message when the picked path is missing', async () => {
    const cwd = join(tmpRoot, 'picked-missing');
    await expect(
      ensureWorkdir({ id: 'wp3', cwd, source: 'host-pick' }),
    ).rejects.toThrow(/does not exist/);
  });
});

describe('ensureWorkdir — guards', () => {
  it('rejects empty cwd', async () => {
    await expect(
      ensureWorkdir({ id: 'wg1', cwd: '', source: 'init' }),
    ).rejects.toThrow(/cwd is empty/);
  });
});

describe('shouldOverrideCwdForWorkdir (dispatch cwd-override decision)', () => {
  const wd = { id: 'w', cwd: '/persist/repo', source: 'clone' as const };

  it('overrides for repo-scoped adapters with a workdir', () => {
    expect(shouldOverrideCwdForWorkdir('codex', wd)).toBe(true);
    expect(shouldOverrideCwdForWorkdir('claude-code', wd)).toBe(true);
  });

  it('overrides for pi-core (runtime210/09 §2.3 — its FS jail must bind the materialized workdir)', () => {
    expect(shouldOverrideCwdForWorkdir('pi-core', wd)).toBe(true);
    expect(shouldOverrideCwdForWorkdir('pi-core', undefined)).toBe(false);
    expect(shouldOverrideCwdForWorkdir('pi-core', { cwd: '' })).toBe(false);
  });

  it('does NOT override for conversational adapters even with a workdir', () => {
    expect(shouldOverrideCwdForWorkdir('hermes', wd)).toBe(false);
  });

  it('does NOT override when no workdir is present', () => {
    expect(shouldOverrideCwdForWorkdir('codex', undefined)).toBe(false);
    expect(shouldOverrideCwdForWorkdir('claude-code', null)).toBe(false);
  });

  it('does NOT override when workdir.cwd is empty', () => {
    expect(shouldOverrideCwdForWorkdir('codex', { cwd: '' })).toBe(false);
    expect(shouldOverrideCwdForWorkdir('codex', { cwd: '   ' })).toBe(false);
  });

  it('isRepoScopedAdapter is true only for codex/claude-code', () => {
    expect(isRepoScopedAdapter('codex')).toBe(true);
    expect(isRepoScopedAdapter('claude-code')).toBe(true);
    expect(isRepoScopedAdapter('hermes')).toBe(false);
  });
});

describe('resolveWorkdirCwd (agent.workdir.materialize resolve + jail)', () => {
  // Mirror the runner: root = workspaces/<wid>, base = .../projects/_unscoped/repos
  //
  // `tmpdir()` is itself a symlink on macOS (`/var` → `/private/var`). The jail
  // now decides containment on REALPATHS (path-jail.ts), so the fixture root is
  // realpath-resolved — otherwise these cases would be asserting the platform's
  // symlink layout rather than the jail. Production roots
  // (`~/.prismer/workspaces/<wid>`) carry no symlink, so the resolved value and
  // the lexical one coincide there.
  const root = join(realpathSync(tmpdir()), 'wd-ws');
  const base = join(root, 'projects', '_unscoped', 'repos');

  it('(a) clone/init reject unsafe names (../, /, empty)', () => {
    for (const source of ['clone', 'init'] as const) {
      for (const name of ['..', '../escape', 'a/b', 'a\\b', '', '   ']) {
        const res = resolveWorkdirCwd(base, root, source, name, undefined);
        expect(res.ok, `${source} name='${name}' should be rejected`).toBe(false);
        if (res.ok) continue;
        expect(res.code).toBe('bad_request');
      }
    }
  });

  it('(a2) clone/init happy path resolves to base/<name> under jail', () => {
    const res = resolveWorkdirCwd(base, root, 'clone', 'my-repo', undefined);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.cwd).toBe(join(base, 'my-repo'));
  });

  it('(b) container-pick rejects a cwd outside the workspace root', () => {
    const res = resolveWorkdirCwd(base, root, 'container-pick', undefined, '/etc/passwd');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('path_escape');
  });

  it('(b2) container-pick rejects traversal that escapes root', () => {
    const escape = join(root, '..', 'other-ws', 'repo');
    const res = resolveWorkdirCwd(base, root, 'container-pick', undefined, escape);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('path_escape');
  });

  it('(b3) container-pick requires a non-empty cwd', () => {
    const res = resolveWorkdirCwd(base, root, 'container-pick', undefined, '   ');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('bad_request');
  });

  it('(c) container-pick valid path under root passes the jail', () => {
    const picked = join(base, 'existing-repo');
    const res = resolveWorkdirCwd(base, root, 'container-pick', undefined, picked);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.cwd).toBe(picked);
  });

  it('(c2) the workspace root itself is allowed (boundary)', () => {
    const res = resolveWorkdirCwd(base, root, 'container-pick', undefined, root);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.cwd).toBe(root);
  });

  // ── F3 (same class as git-rpc.ts's jail, tracked separately as pre-existing
  //    debt): the jail was LEXICAL, so a symlink planted inside the root by the
  //    agent that owns the tree pointed the materializer anywhere on the host.
  //    These two use REAL directories (the cases above are path-math only).
  it('(d) container-pick through a symlink that escapes the root is path_escape', () => {
    const realRoot = realpathSync(mkdtempSync(join(tmpdir(), 'wd-jail-')));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'wd-out-')));
    try {
      mkdirSync(join(outside, 'repo'), { recursive: true });
      symlinkSync(join(outside, 'repo'), join(realRoot, 'link'));
      const res = resolveWorkdirCwd(join(realRoot, 'repos'), realRoot, 'container-pick', undefined, join(realRoot, 'link'));
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.code).toBe('path_escape');
    } finally {
      rmSync(realRoot, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  // NEGATIVE CONTROL for (d): symlinks that stay INSIDE the root are still
  // allowed — the rule is "must resolve inside", not "no symlinks".
  it('(d2) negative control — a symlink resolving inside the root is allowed', () => {
    const realRoot = realpathSync(mkdtempSync(join(tmpdir(), 'wd-jail-')));
    try {
      mkdirSync(join(realRoot, 'real-repo'), { recursive: true });
      symlinkSync(join(realRoot, 'real-repo'), join(realRoot, 'link'));
      const res = resolveWorkdirCwd(join(realRoot, 'repos'), realRoot, 'container-pick', undefined, join(realRoot, 'link'));
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.cwd).toBe(join(realRoot, 'real-repo'));
    } finally {
      rmSync(realRoot, { recursive: true, force: true });
    }
  });
});
