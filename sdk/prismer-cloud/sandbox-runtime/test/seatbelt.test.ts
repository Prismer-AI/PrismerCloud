import { describe, it, expect, afterEach, afterAll, beforeAll } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  generateSeatbeltProfile,
  writeSeatbeltProfile,
  spawnInSandbox,
  SeatbeltUnavailableError,
} from '../src/seatbelt.js';

// ============================================================
// Helpers
// ============================================================

const HOME = process.env['HOME'] ?? os.homedir();

function isMacOS(): boolean {
  return os.platform() === 'darwin';
}

function isSandboxExecAvailable(): boolean {
  if (!isMacOS()) return false;
  const result = spawnSync('which', ['sandbox-exec'], { encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim().length > 0;
}

/**
 * Run a shell command inside sandbox-exec synchronously.
 * Used only in macOS tests for simpler result assertions.
 */
function runInSandboxSync(
  profilePath: string,
  shellCmd: string,
): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync('sandbox-exec', ['-f', profilePath, '/bin/sh', '-c', shellCmd], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

// ============================================================
// Cross-platform tests (always run)
// ============================================================

describe('generateSeatbeltProfile — cross-platform', () => {
  const workspace = '/tmp/sandbox-test-whatever';

  it('returns a non-empty string starting with (version 1)', () => {
    const profile = generateSeatbeltProfile({ workspace });
    expect(typeof profile).toBe('string');
    expect(profile.length).toBeGreaterThan(0);
    expect(profile.trimStart()).toMatch(/^\(version 1\)/);
  });

  it('contains (deny default)', () => {
    const profile = generateSeatbeltProfile({ workspace });
    expect(profile).toContain('(deny default)');
  });

  it('contains (allow file-read*) and does NOT allow all file-write* without parameters', () => {
    const profile = generateSeatbeltProfile({ workspace });
    expect(profile).toContain('(allow file-read*)');
    // Must not have a bare "(allow file-write*)" followed immediately by a newline or ")" —
    // all file-write* allows must have a predicate (subpath/literal inside the block).
    const bareWriteAllow = /\(allow file-write\*\s*\)/m;
    expect(profile).not.toMatch(bareWriteAllow);
  });

  it('contains workspace as a subpath in at least one allow file-write block', () => {
    const profile = generateSeatbeltProfile({ workspace });
    expect(profile).toContain(`(subpath "${workspace}")`);
  });

  it('includes deny rules for $HOME/.ssh, $HOME/.aws, $HOME/.gitconfig', () => {
    const profile = generateSeatbeltProfile({ workspace });
    expect(profile).toContain(`(subpath "${HOME}/.ssh")`);
    expect(profile).toContain(`(subpath "${HOME}/.aws")`);
    expect(profile).toContain(`(literal "${HOME}/.gitconfig")`);
  });

  it('does NOT contain a deny subpath for the workspace .git directory (D20)', () => {
    const wsWithGit = '/tmp/sandbox-test-d20';
    const profile = generateSeatbeltProfile({ workspace: wsWithGit });
    // The deny block must not contain a subpath entry ending in /.git
    const gitSubpathInDeny = /\(deny file-write\*[\s\S]*?\(subpath "[^"]*\.git"\)[\s\S]*?\)/m;
    expect(profile).not.toMatch(gitSubpathInDeny);
    // Additional targeted check: no literal "/.git" inside any subpath predicate in the deny block.
    const denyBlockMatch = profile.match(/\(deny file-write\*([\s\S]*?)\)/);
    if (denyBlockMatch) {
      expect(denyBlockMatch[1]).not.toContain('/.git');
    }
  });

  it('includes extraAllowWrite paths in the profile', () => {
    const extra = '/extra/allow/path';
    // The path won't exist so realpath will fail — the generator emits a skip comment.
    // Supply a path that does exist so we can verify the subpath entry.
    const tmpExtra = fs.mkdtempSync(path.join(os.tmpdir(), 'sbtest-extra-'));
    try {
      const profile = generateSeatbeltProfile({ workspace, extraAllowWrite: [tmpExtra] });
      expect(profile).toContain(tmpExtra);
    } finally {
      fs.rmSync(tmpExtra, { recursive: true, force: true });
    }
    // Non-existent extra path → skipped with comment, no throw.
    const profileSkip = generateSeatbeltProfile({ workspace, extraAllowWrite: [extra] });
    expect(profileSkip).toContain('skipped non-existent extraAllowWrite path: /extra/allow/path');
  });

  it('includes extraDenyWrite paths in the profile', () => {
    const sensitive = '/sensitive/custom/path';
    const profile = generateSeatbeltProfile({ workspace, extraDenyWrite: [sensitive] });
    expect(profile).toContain(`(subpath "${sensitive}")`);
  });

  it('writeSeatbeltProfile creates the file, returns its absolute path, and content matches generateSeatbeltProfile', () => {
    const uniqueName = `test-profile-${Date.now()}`;
    const expectedDir = path.join(os.homedir(), '.prismer', 'sandbox');
    const opts = { workspace };

    const returned = writeSeatbeltProfile(uniqueName, opts);
    try {
      expect(path.isAbsolute(returned)).toBe(true);
      expect(returned).toBe(path.join(expectedDir, `${uniqueName}.sb`));
      expect(fs.existsSync(returned)).toBe(true);
      const written = fs.readFileSync(returned, 'utf8');
      const expected = generateSeatbeltProfile(opts);
      expect(written).toBe(expected);
    } finally {
      fs.rmSync(returned, { force: true });
    }
  });

  it('spawnInSandbox on non-macOS throws SeatbeltUnavailableError', () => {
    if (isMacOS()) {
      // On macOS the function would succeed; we test the error class shape instead.
      const err = new SeatbeltUnavailableError('seatbelt requires macOS');
      expect(err.name).toBe('SeatbeltUnavailableError');
      expect(err.message).toContain('macOS');
      return;
    }
    expect(() => spawnInSandbox('/nonexistent.sb', '/bin/sh', [])).toThrow(SeatbeltUnavailableError);
    try {
      spawnInSandbox('/nonexistent.sb', '/bin/sh', []);
    } catch (err) {
      expect((err as Error).name).toBe('SeatbeltUnavailableError');
    }
  });
});

// ============================================================
// C1 — seatbelt injection guard tests (cross-platform)
// ============================================================

describe('generateSeatbeltProfile — C1 injection guard', () => {
  const safeWorkspace = '/tmp/ok-workspace';

  it('throws SeatbeltUnavailableError when workspace contains a double-quote', () => {
    expect(() =>
      generateSeatbeltProfile({ workspace: '/tmp/inj")\n(allow file-write*)(' }),
    ).toThrow(SeatbeltUnavailableError);
  });

  it('throws SeatbeltUnavailableError when workspace contains a newline', () => {
    expect(() =>
      generateSeatbeltProfile({ workspace: '/tmp/ws\nmalicious' }),
    ).toThrow(SeatbeltUnavailableError);
  });

  it('throws SeatbeltUnavailableError when workspace contains a backslash', () => {
    expect(() =>
      generateSeatbeltProfile({ workspace: '/tmp/ws\\evil' }),
    ).toThrow(SeatbeltUnavailableError);
  });

  it('throws SeatbeltUnavailableError when workspace contains a carriage-return', () => {
    expect(() =>
      generateSeatbeltProfile({ workspace: '/tmp/ws\revil' }),
    ).toThrow(SeatbeltUnavailableError);
  });

  it('throws SeatbeltUnavailableError when extraAllowWrite entry contains a double-quote', () => {
    expect(() =>
      generateSeatbeltProfile({ workspace: safeWorkspace, extraAllowWrite: ['/some"path'] }),
    ).toThrow(SeatbeltUnavailableError);
  });

  it('throws SeatbeltUnavailableError when extraAllowWrite entry contains a newline', () => {
    expect(() =>
      generateSeatbeltProfile({ workspace: safeWorkspace, extraAllowWrite: ['/some\npath'] }),
    ).toThrow(SeatbeltUnavailableError);
  });

  it('throws SeatbeltUnavailableError when extraDenyWrite entry contains a newline', () => {
    expect(() =>
      generateSeatbeltProfile({ workspace: safeWorkspace, extraDenyWrite: ['/some\npath'] }),
    ).toThrow(SeatbeltUnavailableError);
  });

  it('throws SeatbeltUnavailableError when extraDenyWrite entry contains a double-quote', () => {
    expect(() =>
      generateSeatbeltProfile({ workspace: safeWorkspace, extraDenyWrite: ['/deny"path'] }),
    ).toThrow(SeatbeltUnavailableError);
  });

  it('does NOT throw for a normal workspace path without forbidden chars', () => {
    expect(() =>
      generateSeatbeltProfile({ workspace: safeWorkspace }),
    ).not.toThrow();
  });

  it('does NOT throw for normal extraAllowWrite and extraDenyWrite entries', () => {
    expect(() =>
      generateSeatbeltProfile({
        workspace: safeWorkspace,
        extraAllowWrite: ['/safe/allow/path'],
        extraDenyWrite: ['/safe/deny/path'],
      }),
    ).not.toThrow();
  });
});

// ============================================================
// macOS-only tests (require sandbox-exec)
// ============================================================

describe.skipIf(!isMacOS() || !isSandboxExecAvailable())(
  'seatbelt sandbox-exec integration (macOS only)',
  () => {
    let workspace: string;
    let profilePath: string;

    beforeAll(() => {
      workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'sbtest-'));
      const profile = generateSeatbeltProfile({ workspace });
      profilePath = path.join(workspace, 'test.sb');
      fs.writeFileSync(profilePath, profile);
    });

    afterAll(() => {
      fs.rmSync(workspace, { recursive: true, force: true });
    });

    it('testWriteInWorkspace: sandbox allows writing inside workspace', () => {
      const testFile = path.join(workspace, 'sandbox-write-test.txt');
      const result = runInSandboxSync(profilePath, `echo "hello from sandbox" > "${testFile}"`);
      const written = fs.existsSync(testFile);
      if (written) {
        const content = fs.readFileSync(testFile, 'utf8').trim();
        expect(content).toBe('hello from sandbox');
        fs.rmSync(testFile, { force: true });
      } else {
        // Provide diagnostic info on failure.
        expect(written).toBe(true); // will fail with message
        console.error('[seatbelt test] write in workspace failed, stderr:', result.stderr);
      }
    });

    it('testWriteOutsideWorkspace: sandbox denies writing to $HOME directly', () => {
      const homeFile = path.join(HOME, `.prismer-sandbox-test-${Date.now()}`);
      runInSandboxSync(profilePath, `echo "should fail" > "${homeFile}" 2>&1`);
      const written = fs.existsSync(homeFile);
      if (written) fs.rmSync(homeFile, { force: true });
      expect(written).toBe(false);
    });

    it('testWriteSensitiveFile: sandbox denies appending to $HOME/.gitconfig', () => {
      const gitconfigPath = path.join(HOME, '.gitconfig');
      if (!fs.existsSync(gitconfigPath)) {
        // Cannot test modification of a non-existent file; skip gracefully.
        return;
      }
      const originalContent = fs.readFileSync(gitconfigPath, 'utf8');
      runInSandboxSync(profilePath, `echo "# malicious" >> "${gitconfigPath}" 2>&1`);
      const afterContent = fs.readFileSync(gitconfigPath, 'utf8');
      expect(afterContent).not.toContain('# malicious');
      // Restore original just in case (should be unchanged anyway).
      if (afterContent !== originalContent) {
        fs.writeFileSync(gitconfigPath, originalContent);
      }
    });
  },
);
