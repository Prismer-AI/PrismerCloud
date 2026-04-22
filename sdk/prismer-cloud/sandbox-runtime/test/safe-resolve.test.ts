import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { safeResolvePath, UncPathError } from '../src/safe-resolve.js';

// ============================================================
// Temp directory setup — cleaned up after all tests
// ============================================================

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-runtime-test-'));

afterAll(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

// ============================================================
// Tests
// ============================================================

describe('safeResolvePath', () => {
  it('rejects UNC path // prefix', () => {
    let threw = false;
    try {
      safeResolvePath('//server/share', '/workspace');
    } catch (err: unknown) {
      threw = true;
      // Use err.name per project convention — instanceof is unreliable after SWC compilation
      expect((err as Error).name).toBe('UncPathError');
    }
    expect(threw, 'should have thrown UncPathError').toBe(true);
  });

  it('rejects UNC path \\\\ prefix', () => {
    let threw = false;
    try {
      safeResolvePath('\\\\server\\share', '/workspace');
    } catch (err: unknown) {
      threw = true;
      expect((err as Error).name).toBe('UncPathError');
    }
    expect(threw, 'should have thrown UncPathError').toBe(true);
  });

  it('expands ~ to home directory', () => {
    // Use a real file that lives in home, or just test the expansion path.
    // We need the file to exist so realpathSync does not throw.
    const home = os.homedir();
    // Find any file that actually exists under home to avoid depends on machine state.
    // Use the home dir itself (which always exists).
    const result = safeResolvePath('~', home);
    expect(result.resolvedPath).toBe(fs.realpathSync(home));
  });

  it('expands $HOME env var', () => {
    const home = os.homedir();
    const result = safeResolvePath('$HOME', home);
    expect(result.resolvedPath).toBe(fs.realpathSync(home));
  });

  it('expands ${VAR} env var syntax', () => {
    const tmpFile = path.join(tmpBase, 'envvar-test.txt');
    fs.writeFileSync(tmpFile, '');
    process.env['SANDBOX_TEST_DIR'] = tmpBase;

    try {
      const result = safeResolvePath('${SANDBOX_TEST_DIR}/envvar-test.txt', tmpBase);
      expect(result.resolvedPath).toBe(fs.realpathSync(tmpFile));
    } finally {
      delete process.env['SANDBOX_TEST_DIR'];
    }
  });

  it('detects symlinks: isSymlink true, resolved != input', () => {
    const realFile = path.join(tmpBase, 'real-file.txt');
    const linkFile = path.join(tmpBase, 'link-file.txt');
    fs.writeFileSync(realFile, '');
    fs.symlinkSync(realFile, linkFile);

    const result = safeResolvePath(linkFile, tmpBase);

    expect(result.isSymlink).toBe(true);
    expect(result.resolvedPath).toBe(fs.realpathSync(realFile));
    expect(result.resolvedPath).not.toBe(linkFile);
  });

  it('inSandbox: true for path inside workspace', () => {
    const innerFile = path.join(tmpBase, 'inner.txt');
    fs.writeFileSync(innerFile, '');

    const result = safeResolvePath(innerFile, tmpBase);
    expect(result.inSandbox).toBe(true);
  });

  it('inSandbox: false for path outside workspace', () => {
    // /tmp itself is "outside" tmpBase (which is a subdirectory of /tmp)
    const outerFile = path.join(os.tmpdir(), 'outside-sandbox.txt');
    fs.writeFileSync(outerFile, '');

    try {
      const result = safeResolvePath(outerFile, tmpBase);
      expect(result.inSandbox).toBe(false);
    } finally {
      fs.unlinkSync(outerFile);
    }
  });

  // D17 regression: macOS /var/folders/... is a symlink to /private/var/folders/...
  // Without realpathSync on the workspace, startsWith always fails for files
  // created under os.tmpdir() on macOS even when they live inside the workspace.
  it('D17 regression: tmpdir workspace resolves correctly on macOS (/var -> /private/var)', () => {
    const workspace = os.tmpdir();
    const wsFile    = path.join(workspace, `d17-test-${Date.now()}.txt`);
    fs.writeFileSync(wsFile, '');

    try {
      const result = safeResolvePath(wsFile, workspace);
      expect(result.inSandbox, 'D17: file inside os.tmpdir() workspace must be inSandbox').toBe(true);
    } finally {
      fs.unlinkSync(wsFile);
    }
  });

  it('throws for non-existent path (lets realpathSync propagate)', () => {
    const missing = path.join(tmpBase, 'does-not-exist-xyz.txt');
    expect(() => safeResolvePath(missing, tmpBase)).toThrow();
  });

  it('workspace itself is in-sandbox', () => {
    const result = safeResolvePath(tmpBase, tmpBase);
    expect(result.inSandbox).toBe(true);
  });
});
