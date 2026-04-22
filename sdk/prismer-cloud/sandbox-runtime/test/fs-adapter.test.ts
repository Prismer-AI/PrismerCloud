import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fsRead,
  fsWrite,
  fsDelete,
  fsEdit,
  fsList,
  fsSearch,
  PermissionDeniedError,
  OutsideSandboxError,
} from '../src/fs-adapter.js';
import { UncPathError } from '../src/safe-resolve.js';
import { setAuditWriter, __resetAuditWriterForTests } from '../src/audit.js';
import type { AuditEntry, AuditWriter } from '../src/audit.js';
import type { FsContext } from '../src/fs-adapter.js';

// ============================================================
// In-memory audit writer for capturing entries in tests
// ============================================================

function makeMemWriter(): { writer: AuditWriter; entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  const writer: AuditWriter = {
    append: (e) => { entries.push({ ...e }); },
    flush:  async () => {},
    close:  async () => {},
  };
  return { writer, entries };
}

// ============================================================
// Test fixtures
// ============================================================

let workspace: string;
let captured: AuditEntry[];

function makeCtx(overrides?: Partial<FsContext>): FsContext {
  return {
    agentId: 'test-agent',
    workspace,
    mode: 'bypassPermissions',
    rules: [],
    ...overrides,
  };
}

beforeEach(() => {
  // Fresh workspace for each test
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'prismer-fs-test-'));

  // Inject in-memory audit writer
  const { writer, entries } = makeMemWriter();
  captured = entries;
  setAuditWriter(writer);
});

afterEach(() => {
  // Clean up workspace
  fs.rmSync(workspace, { recursive: true, force: true });
  __resetAuditWriterForTests();
});

// ============================================================
// Tests
// ============================================================

describe('fs-adapter', () => {

  // Test 1: fsRead on a plain text file
  it('fsRead returns file content and audits executed', async () => {
    const file = path.join(workspace, 'hello.txt');
    fs.writeFileSync(file, 'hello world');

    const result = await fsRead(makeCtx(), { path: file });

    expect(result.content).toBe('hello world');
    expect(result.encoding).toBe('utf8');
    expect(result.bytes).toBe(11);

    expect(captured).toHaveLength(1);
    expect(captured[0].decision).toBe('executed');
    expect(captured[0].operation).toBe('read');
  });

  // Test 2: fsWrite creates file and audits bytes
  it('fsWrite creates file and nested parent dirs, audits bytes', async () => {
    const file = path.join(workspace, 'nested', 'dir', 'out.txt');
    const result = await fsWrite(makeCtx(), { path: file, content: 'data' });

    expect(result.bytes).toBe(4);
    expect(fs.readFileSync(file, 'utf8')).toBe('data');

    expect(captured).toHaveLength(1);
    expect(captured[0].decision).toBe('executed');
    expect(captured[0].bytes).toBe(4);
  });

  // Test 3: fsWrite outside workspace throws OutsideSandboxError
  it('fsWrite outside workspace throws OutsideSandboxError and audits deny', async () => {
    // Create a real temp file outside the workspace so safeResolvePath can resolve it
    const outsideFile = path.join(os.tmpdir(), `prismer-outside-${Date.now()}.txt`);
    fs.writeFileSync(outsideFile, '');

    try {
      await expect(
        fsWrite(makeCtx(), { path: outsideFile, content: 'bad' })
      ).rejects.toBeInstanceOf(OutsideSandboxError);

      expect(captured).toHaveLength(1);
      expect(captured[0].decision).toBe('deny');
      expect(captured[0].reason).toBe('outside-sandbox');
    } finally {
      fs.rmSync(outsideFile, { force: true });
    }
  });

  it('fsRead outside workspace is denied unless explicitly allowed or bypassed', async () => {
    const outsideFile = path.join(os.tmpdir(), `prismer-outside-read-${Date.now()}.txt`);
    fs.writeFileSync(outsideFile, 'outside');

    try {
      const outsideReal = fs.realpathSync(outsideFile);
      await expect(
        fsRead(makeCtx({ mode: 'default' }), { path: outsideFile }),
      ).rejects.toBeInstanceOf(OutsideSandboxError);

      const explicit = await fsRead(makeCtx({
        mode: 'default',
        rules: [{ source: 'session', behavior: 'allow', value: { tool: 'Read', pattern: outsideReal } }],
      }), { path: outsideFile });
      expect(explicit.content).toBe('outside');

      const bypass = await fsRead(makeCtx({ mode: 'bypassPermissions' }), { path: outsideFile });
      expect(bypass.content).toBe('outside');
    } finally {
      fs.rmSync(outsideFile, { force: true });
    }
  });

  it('fsList and fsSearch outside workspace are denied by default', async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prismer-outside-list-'));
    fs.writeFileSync(path.join(outsideDir, 'note.txt'), 'needle');

    try {
      await expect(
        fsList(makeCtx({ mode: 'default' }), { path: outsideDir }),
      ).rejects.toBeInstanceOf(OutsideSandboxError);

      await expect(
        fsSearch(makeCtx({ mode: 'default' }), { query: 'needle', path: outsideDir }),
      ).rejects.toBeInstanceOf(OutsideSandboxError);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  // Test 4: fsWrite to a FROZEN file throws PermissionDeniedError
  it('fsWrite to FROZEN file throws PermissionDeniedError and audits deny with frozen reason', async () => {
    // .gitconfig is in FROZEN_FILES. Write inside the workspace but with a frozen filename.
    // The permission engine normalizes paths by stripping home-dir prefix, so FROZEN_FILES
    // (e.g. '.gitconfig') match by basename. To exercise the FROZEN path without the
    // outside-sandbox check firing first, we must put a frozen-named file inside the workspace.
    // However FROZEN_FILES matches by basename regardless of directory, so this works.
    const frozenInWorkspace = path.join(workspace, '.gitconfig');

    await expect(
      fsWrite(makeCtx(), { path: frozenInWorkspace, content: 'bad' })
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    const denyEntry = captured.find(e => e.decision === 'deny');
    expect(denyEntry).toBeDefined();
    expect(denyEntry?.reason).toMatch(/FROZEN/);
  });

  // Test 5: fsDelete removes a file and audits executed
  it('fsDelete removes in-sandbox file, audits executed', async () => {
    const file = path.join(workspace, 'to-delete.txt');
    fs.writeFileSync(file, 'bye');

    const result = await fsDelete(makeCtx(), { path: file });
    expect(result.deleted).toBe(true);
    expect(fs.existsSync(file)).toBe(false);

    expect(captured).toHaveLength(1);
    expect(captured[0].decision).toBe('executed');
  });

  // Test 6: fsEdit replaces one occurrence, audits bytes and replaced
  it('fsEdit replaces one occurrence and writes back', async () => {
    const file = path.join(workspace, 'edit-me.ts');
    fs.writeFileSync(file, 'const a = 1;\nconst b = 1;\n');

    const result = await fsEdit(makeCtx(), {
      path: file,
      oldString: 'const a = 1;',
      newString: 'const a = 99;',
    });

    expect(result.replaced).toBe(1);
    const content = fs.readFileSync(file, 'utf8');
    expect(content).toContain('const a = 99;');
    // Only first occurrence replaced
    expect(content).toContain('const b = 1;');

    expect(captured).toHaveLength(1);
    expect(captured[0].decision).toBe('executed');
    expect(typeof captured[0].bytes).toBe('number');
  });

  // Test 7: fsEdit with missing oldString throws and audits failed
  it('fsEdit with missing oldString throws and audits failed', async () => {
    const file = path.join(workspace, 'nochange.ts');
    fs.writeFileSync(file, 'hello world');

    await expect(
      fsEdit(makeCtx(), { path: file, oldString: 'NOT_PRESENT', newString: 'x' })
    ).rejects.toThrow('oldString not found');

    expect(captured).toHaveLength(1);
    expect(captured[0].decision).toBe('failed');
  });

  // Test 8: fsList returns file and directory entries
  it('fsList returns file and directory entries including dotfiles', async () => {
    fs.writeFileSync(path.join(workspace, 'file.txt'), 'a');
    fs.mkdirSync(path.join(workspace, 'subdir'));
    fs.writeFileSync(path.join(workspace, '.hidden'), 'h');

    const result = await fsList(makeCtx(), { path: workspace });
    const names = result.entries.map(e => e.path);

    expect(names).toContain('file.txt');
    expect(names).toContain('subdir');
    expect(names).toContain('.hidden');

    const dirEntry = result.entries.find(e => e.path === 'subdir');
    expect(dirEntry?.type).toBe('directory');
    const fileEntry = result.entries.find(e => e.path === 'file.txt');
    expect(fileEntry?.type).toBe('file');
    expect(typeof fileEntry?.size).toBe('number');

    expect(captured).toHaveLength(1);
    expect(captured[0].decision).toBe('executed');
  });

  // Test 9: fsSearch finds a literal query in a file
  it('fsSearch finds literal query in a file, returns path + line + snippet', async () => {
    const file = path.join(workspace, 'search-me.ts');
    fs.writeFileSync(file, 'line one\nhello world\nline three\n');

    const result = await fsSearch(makeCtx(), { query: 'hello world', path: workspace });

    expect(result.matches.length).toBeGreaterThanOrEqual(1);
    const match = result.matches.find(m => m.line === 2);
    expect(match).toBeDefined();
    expect(match?.snippet).toContain('hello world');
    // Match path uses realpath (e.g. /private/var on macOS), so compare basename
    expect(match?.path.endsWith('search-me.ts')).toBe(true);

    expect(captured).toHaveLength(1);
    expect(captured[0].decision).toBe('executed');
  });

  // Test 10: approvalGate flow
  describe('approvalGate', () => {
    it('gate returning true allows write', async () => {
      const file = path.join(workspace, 'gated.txt');
      // Use 'default' mode — Write tool requires 'ask' in default mode
      const ctx = makeCtx({
        mode: 'default',
        approvalGate: async () => true,
      });
      // Must create the file first so safeResolvePath can resolve it
      fs.writeFileSync(file, 'before');

      const result = await fsWrite(ctx, { path: file, content: 'approved' });
      expect(result.bytes).toBeGreaterThan(0);
      expect(fs.readFileSync(file, 'utf8')).toBe('approved');

      // Should have executed (not denied)
      const executedEntry = captured.find(e => e.decision === 'executed');
      expect(executedEntry).toBeDefined();
    });

    it('gate returning false denies write and audits deny', async () => {
      const file = path.join(workspace, 'gated-deny.txt');
      fs.writeFileSync(file, 'before');
      const ctx = makeCtx({
        mode: 'default',
        approvalGate: async () => false,
      });

      await expect(
        fsWrite(ctx, { path: file, content: 'rejected' })
      ).rejects.toBeInstanceOf(PermissionDeniedError);

      const denyEntry = captured.find(e => e.decision === 'deny');
      expect(denyEntry).toBeDefined();
    });

    it('gate throwing causes PermissionDeniedError with approval-gate-error reason', async () => {
      const file = path.join(workspace, 'gated-err.txt');
      fs.writeFileSync(file, 'before');
      const ctx = makeCtx({
        mode: 'default',
        approvalGate: async () => { throw new Error('gate exploded'); },
      });

      await expect(
        fsWrite(ctx, { path: file, content: 'bad' })
      ).rejects.toBeInstanceOf(PermissionDeniedError);

      const denyEntry = captured.find(e => e.decision === 'deny');
      expect(denyEntry).toBeDefined();
      expect(denyEntry?.reason).toMatch(/approval-gate-error/);
    });

    it('no approvalGate in default mode throws PermissionDeniedError', async () => {
      const file = path.join(workspace, 'no-gate.txt');
      fs.writeFileSync(file, 'before');
      const ctx = makeCtx({ mode: 'default' }); // no approvalGate

      await expect(
        fsWrite(ctx, { path: file, content: 'bad' })
      ).rejects.toBeInstanceOf(PermissionDeniedError);

      const denyEntry = captured.find(e => e.decision === 'deny');
      expect(denyEntry).toBeDefined();
      expect(denyEntry?.reason).toMatch(/approval gate not configured/);
    });
  });

  // Test 11: UncPath — fsRead throws UncPathError with no audit entry
  it('fsRead with UNC path throws UncPathError without producing an audit entry', async () => {
    await expect(
      fsRead(makeCtx(), { path: '//server/share/file.txt' })
    ).rejects.toBeInstanceOf(UncPathError);

    // No audit entry should have been written — the call never started
    expect(captured).toHaveLength(0);
  });

  // Test 12: fsEdit replaceAll replaces all occurrences
  it('fsEdit replaceAll=true replaces all occurrences', async () => {
    const file = path.join(workspace, 'multi.ts');
    fs.writeFileSync(file, 'foo bar foo baz foo\n');

    const result = await fsEdit(makeCtx(), {
      path: file,
      oldString: 'foo',
      newString: 'qux',
      replaceAll: true,
    });

    expect(result.replaced).toBe(3);
    expect(fs.readFileSync(file, 'utf8')).toBe('qux bar qux baz qux\n');
  });

  // Test 13: fsWrite with base64 encoding
  it('fsWrite with base64 encoding writes binary correctly', async () => {
    const file = path.join(workspace, 'binary.bin');
    const data = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    const b64 = data.toString('base64');

    const result = await fsWrite(makeCtx(), { path: file, content: b64, encoding: 'base64' });
    expect(result.bytes).toBe(4);

    const read = fs.readFileSync(file);
    expect(read.equals(data)).toBe(true);
  });

  // Test 14: fsRead returns base64 for binary files
  it('fsRead returns base64 encoding for binary content', async () => {
    const file = path.join(workspace, 'bin.dat');
    // A buffer with a null byte (triggers binary detection)
    fs.writeFileSync(file, Buffer.from([0x48, 0x65, 0x00, 0x6c, 0x6f]));

    const result = await fsRead(makeCtx(), { path: file });
    expect(result.encoding).toBe('base64');
    const decoded = Buffer.from(result.content, 'base64');
    expect(decoded[2]).toBe(0x00);
  });

  // Test 15: fsDelete on a directory removes it recursively
  it('fsDelete removes a directory recursively', async () => {
    const dir = path.join(workspace, 'subdir');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'file.txt'), 'x');

    const result = await fsDelete(makeCtx(), { path: dir });
    expect(result.deleted).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
  });

  // ---- I2: fsSearch FROZEN-file protection ----

  // Test I2-a: .env inside workspace is skipped by fsSearch
  it('I2: fsSearch does NOT return snippets from FROZEN .env files', async () => {
    // Plant a .env with a secret-looking value and a plain file with the same content.
    const envFile = path.join(workspace, '.env');
    const plainFile = path.join(workspace, 'regular.txt');
    fs.writeFileSync(envFile, 'AWS_SECRET=supersecret\n');
    fs.writeFileSync(plainFile, 'AWS_SECRET=supersecret\n');

    const result = await fsSearch(makeCtx(), { query: 'AWS_SECRET', path: workspace });

    // The plain file should be found.
    expect(result.matches.some(m => m.path.endsWith('regular.txt'))).toBe(true);
    // The .env file must NOT appear in matches (FROZEN via FROZEN_GLOBS **/.env*).
    expect(result.matches.some(m => m.path.endsWith('.env'))).toBe(false);
  });

  // Test I2-b: only plain file found when both .env and regular.txt match query
  it('I2: fsSearch finds regular.txt but skips .env when both match', async () => {
    fs.writeFileSync(path.join(workspace, '.env'), 'TOKEN=secret\n');
    fs.writeFileSync(path.join(workspace, 'config.ts'), 'TOKEN=secret\n');

    const result = await fsSearch(makeCtx(), { query: 'TOKEN', path: workspace });

    const paths = result.matches.map(m => m.path);
    expect(paths.some(p => p.endsWith('config.ts'))).toBe(true);
    expect(paths.some(p => p.endsWith('.env'))).toBe(false);
  });

  // Test I2-c: .gitconfig inside workspace is skipped by fsSearch (FROZEN_FILES basename match)
  it('I2: fsSearch skips FROZEN_FILES (.gitconfig) found during workspace scan', async () => {
    fs.writeFileSync(path.join(workspace, '.gitconfig'), 'SECRET=hidden\n');
    fs.writeFileSync(path.join(workspace, 'readme.md'), 'SECRET=visible\n');

    const result = await fsSearch(makeCtx(), { query: 'SECRET', path: workspace });

    expect(result.matches.some(m => m.path.endsWith('readme.md'))).toBe(true);
    expect(result.matches.some(m => m.path.endsWith('.gitconfig'))).toBe(false);
  });

  // ---- I3: fsWrite / fsEdit symlink TOCTOU protection ----

  // Test I3-a: fsWrite on a symlink pointing outside workspace throws OutsideSandboxError
  it('I3: fsWrite on relative symlink escaping workspace throws OutsideSandboxError', async () => {
    // Create an escape target outside the workspace so the symlink target exists.
    const escapeTarget = path.join(os.tmpdir(), `prismer-i3-escape-${Date.now()}.txt`);
    fs.writeFileSync(escapeTarget, 'original');

    // Plant a symlink inside the workspace pointing to the outside target.
    const symlinkPath = path.join(workspace, 'pwned');
    fs.symlinkSync(escapeTarget, symlinkPath);

    try {
      await expect(
        fsWrite(makeCtx(), { path: symlinkPath, content: 'injected' }),
      ).rejects.toBeInstanceOf(OutsideSandboxError);

      // The outside file must NOT be modified.
      expect(fs.readFileSync(escapeTarget, 'utf8')).toBe('original');
    } finally {
      fs.rmSync(escapeTarget, { force: true });
    }
  });

  // Test I3-b: fsWrite on an absolute symlink to /tmp throws OutsideSandboxError
  // (caught by the boundary check — target resolves outside workspace)
  it('I3: fsWrite on absolute symlink to /tmp throws OutsideSandboxError', async () => {
    const absTarget = path.join(os.tmpdir(), `prismer-i3-abs-${Date.now()}.txt`);
    fs.writeFileSync(absTarget, 'safe');

    const symlinkPath = path.join(workspace, 'abs-pwned');
    fs.symlinkSync(absTarget, symlinkPath);

    try {
      await expect(
        fsWrite(makeCtx(), { path: symlinkPath, content: 'bad' }),
      ).rejects.toBeInstanceOf(OutsideSandboxError);

      // The outside file must NOT be modified.
      expect(fs.readFileSync(absTarget, 'utf8')).toBe('safe');
    } finally {
      fs.rmSync(absTarget, { force: true });
    }
  });

  // Test I3-b2: fsWrite TOCTOU — the symlink target does NOT exist on disk (so
  // realpathSync cannot follow through to the outside path, boundary check passes
  // because the parent workspace/ is in-sandbox). O_NOFOLLOW then catches the planted
  // symlink at the leaf and throws OutsideSandboxError mentioning symlink.
  it('I3: fsWrite with O_NOFOLLOW catches symlink to non-existent outside target', async () => {
    // The escape target path does NOT exist — resolveWritePath cannot resolve the
    // symlink via realpathSync and falls back to the workspace-relative path (inSandbox=true).
    // O_NOFOLLOW on the open() then catches the symlink at the leaf.
    const targetPath = path.join(workspace, 'new-file.txt');
    const nonExistentTarget = path.join(os.tmpdir(), `prismer-i3-nonexistent-${Date.now()}.txt`);
    // Ensure target does NOT exist (it's a fresh unique path).
    fs.symlinkSync(nonExistentTarget, targetPath);

    let caught: Error | undefined;
    try {
      await fsWrite(makeCtx(), { path: targetPath, content: 'injected' });
    } catch (e) {
      caught = e as Error;
    }

    // O_NOFOLLOW should have rejected the symlink.
    expect(caught).toBeDefined();
    expect(caught).toBeInstanceOf(OutsideSandboxError);
    expect(caught?.message).toMatch(/symlink/);
    // Verify the non-existent target was NOT created.
    expect(fs.existsSync(nonExistentTarget)).toBe(false);
  });

  // Test I3-c: regular file write still works (no regression)
  it('I3: fsWrite to a regular file (no symlink) still succeeds', async () => {
    const file = path.join(workspace, 'plain.txt');
    const result = await fsWrite(makeCtx(), { path: file, content: 'hello' });
    expect(result.bytes).toBe(5);
    expect(fs.readFileSync(file, 'utf8')).toBe('hello');
  });

  // Test I3-d: fsEdit on a symlinked file throws OutsideSandboxError
  it('I3: fsEdit on a symlinked file throws OutsideSandboxError', async () => {
    const realFile = path.join(os.tmpdir(), `prismer-i3-edit-${Date.now()}.txt`);
    fs.writeFileSync(realFile, 'original content');

    const symlinkPath = path.join(workspace, 'edit-pwned');
    fs.symlinkSync(realFile, symlinkPath);

    try {
      await expect(
        fsEdit(makeCtx(), { path: symlinkPath, oldString: 'original', newString: 'injected' }),
      ).rejects.toBeInstanceOf(OutsideSandboxError);

      expect(fs.readFileSync(realFile, 'utf8')).toBe('original content');
    } finally {
      fs.rmSync(realFile, { force: true });
    }
  });

  // Test I3-e: fsEdit on a regular file still works (no regression)
  it('I3: fsEdit on a regular file (no symlink) still succeeds', async () => {
    const file = path.join(workspace, 'edit-plain.ts');
    fs.writeFileSync(file, 'const x = 1;');

    const result = await fsEdit(makeCtx(), {
      path: file,
      oldString: 'const x = 1;',
      newString: 'const x = 2;',
    });

    expect(result.replaced).toBe(1);
    expect(fs.readFileSync(file, 'utf8')).toBe('const x = 2;');
  });

  // Test 16: fsSearch glob filters by path, not content
  it('fsSearch glob filters by file path only', async () => {
    fs.writeFileSync(path.join(workspace, 'match.ts'), 'hello');
    fs.writeFileSync(path.join(workspace, 'skip.js'), 'hello');

    // glob **/*.ts should only match match.ts
    const result = await fsSearch(makeCtx(), {
      query: 'hello',
      path: workspace,
      glob: '**/*.ts',
    });

    const paths = result.matches.map(m => m.path);
    expect(paths.some(p => p.endsWith('match.ts'))).toBe(true);
    expect(paths.some(p => p.endsWith('skip.js'))).toBe(false);
  });

  // Test 17: fsRead with offset and limit returns the correct slice
  it('fsRead with offset and limit returns the correct byte slice', async () => {
    const file = path.join(workspace, 'slice.txt');
    fs.writeFileSync(file, 'ABCDEFGHIJ');

    const result = await fsRead(makeCtx(), { path: file, offset: 3, limit: 4 });
    expect(result.content).toBe('DEFG');
    expect(result.bytes).toBe(4);
  });

  // Test 18: fsList with maxDepth=3 recurses three levels
  it('fsList with maxDepth=3 returns entries three levels deep', async () => {
    fs.mkdirSync(path.join(workspace, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'a', 'b', 'deep.txt'), 'x');

    // maxDepth=1: only 'a' (direct child of workspace)
    // maxDepth=2: 'a' and 'a/b'
    // maxDepth=3: 'a', 'a/b', 'a/b/deep.txt'
    const result = await fsList(makeCtx(), { path: workspace, maxDepth: 3 });
    const names = result.entries.map(e => e.path);
    expect(names.some(n => n.includes('deep.txt'))).toBe(true);
    expect(names.some(n => n === 'a' || n === 'a/')).toBe(true);
  });

  // ---- G2: callPath field in FsContext propagates to audit entries ----

  // Test G2-a: FsContext with callPath 'http' emits audit entries with callPath: 'http'
  it('G2: FsContext with callPath: http emits audit entry with callPath http', async () => {
    const file = path.join(workspace, 'g2.txt');
    fs.writeFileSync(file, 'g2 test');

    const ctx = makeCtx({ callPath: 'http' });
    await fsRead(ctx, { path: file });

    expect(captured.length).toBeGreaterThanOrEqual(1);
    expect(captured[0].callPath).toBe('http');
  });

  // Test G2-b: FsContext with callPath 'relay' emits audit entries with callPath: 'relay'
  it('G2: FsContext with callPath: relay emits audit entry with callPath relay', async () => {
    const file = path.join(workspace, 'g2r.txt');
    fs.writeFileSync(file, 'g2 relay');

    const ctx = makeCtx({ callPath: 'relay' });
    await fsRead(ctx, { path: file });

    expect(captured[0].callPath).toBe('relay');
  });

  // Test G2-c: default FsContext (no callPath) emits callPath: 'native'
  it('G2: FsContext without callPath defaults audit entry callPath to native', async () => {
    const file = path.join(workspace, 'g2n.txt');
    fs.writeFileSync(file, 'g2 native');

    await fsRead(makeCtx(), { path: file });

    expect(captured[0].callPath).toBe('native');
  });
});
