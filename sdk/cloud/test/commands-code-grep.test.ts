/**
 * Unit tests for `cloud code grep <pattern> --repo <abs-path>` —
 * release201/07 Phase 2 code-source CLI.
 *
 * Strategy: drive the Commander sub-tree against a temp repo under
 * PRISMER_WORKSPACE_ROOT (whitelist 1) so the path policy lets us through.
 * Verifies:
 *   • whitelist rejection (path outside PRISMER_WORKSPACE_ROOT exits 1)
 *   • basic pattern match → JSON output [{ path, line, snippet, sha256 }]
 *   • --glob filter (*.ts) skips other extensions
 *   • --max-matches caps the result set
 *   • node_modules / .git / dist walked-around (heavy dir skip)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { register as registerCodeGrep } from '../src/commands/code-grep';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runCodeGrepCli(argv: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const program = new Command();
  program.exitOverride();
  // code-grep doesn't use the IM / API clients but the register signature
  // demands the factory pair — pass no-op stubs.
  registerCodeGrep(program, () => ({}) as unknown, () => ({}) as unknown);

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const origStdoutWrite = process.stdout.write;
  const origStderrWrite = process.stderr.write;
  process.stdout.write = ((s: string | Uint8Array) => {
    stdoutChunks.push(typeof s === 'string' ? s : Buffer.from(s).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((s: string | Uint8Array) => {
    stderrChunks.push(typeof s === 'string' ? s : Buffer.from(s).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;

  let exitCode = 0;
  const origExit = process.exit;
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`__exit_${exitCode}`);
  }) as typeof process.exit;

  try {
    await program.parseAsync(['node', 'cloud', 'code', ...argv]);
  } catch (err) {
    if (!(err instanceof Error && err.message.startsWith('__exit_'))) throw err;
  } finally {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    process.exit = origExit;
  }
  return { exitCode, stdout: stdoutChunks.join(''), stderr: stderrChunks.join('') };
}

// ---------------------------------------------------------------------------
// Setup: build a temp "workspace" with whitelisted layout so the path policy
// permits scanning. We point PRISMER_WORKSPACE_ROOT at the temp dir for the
// suite, then restore on teardown.
// ---------------------------------------------------------------------------

let TMP_ROOT = '';
let ORIG_WS_ROOT: string | undefined;

beforeAll(() => {
  TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-code-grep-'));
  ORIG_WS_ROOT = process.env.PRISMER_WORKSPACE_ROOT;
  process.env.PRISMER_WORKSPACE_ROOT = TMP_ROOT;

  // 3 ts files, 1 js file, 1 .md file, 1 node_modules cruft (should be skipped)
  fs.writeFileSync(
    path.join(TMP_ROOT, 'a.ts'),
    [
      'function handleX() {',
      '  return 1;',
      '}',
      '',
      'function handleY() {',
      '  return 2;',
      '}',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(TMP_ROOT, 'b.ts'),
    [
      'export const handleZ = () => {',
      '  console.log("z");',
      '};',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(TMP_ROOT, 'c.js'),
    [
      'function handleX() {',
      '  return 99;',
      '}',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(TMP_ROOT, 'README.md'), '# nothing to see\nhandleX is great\n');

  // node_modules should be skipped by walk()
  fs.mkdirSync(path.join(TMP_ROOT, 'node_modules', 'foo'), { recursive: true });
  fs.writeFileSync(
    path.join(TMP_ROOT, 'node_modules', 'foo', 'index.ts'),
    'function handleX() {} // should NOT be matched',
  );
});

afterAll(() => {
  if (ORIG_WS_ROOT === undefined) {
    delete process.env.PRISMER_WORKSPACE_ROOT;
  } else {
    process.env.PRISMER_WORKSPACE_ROOT = ORIG_WS_ROOT;
  }
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cloud code grep — whitelist enforcement', () => {
  it('rejects --repo outside PRISMER_WORKSPACE_ROOT with exit 1', async () => {
    const res = await runCodeGrepCli([
      'grep',
      'handleX',
      '--repo',
      '/etc', // not in whitelist
    ]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/not whitelisted/i);
  });

  it('requires --repo flag (missing → exit 1)', async () => {
    const res = await runCodeGrepCli(['grep', 'handleX']);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/--repo/);
  });
});

describe('cloud code grep — pattern matching', () => {
  it('returns JSON array of matches with path / line / snippet / sha256', async () => {
    const res = await runCodeGrepCli(['grep', 'handleX', '--repo', TMP_ROOT]);
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    // a.ts contains handleX on line 1; c.js contains handleX on line 1;
    // README.md mentions handleX on line 2; node_modules version is skipped.
    // (No hard assertion on order — walk order is FS-dependent — just count.)
    expect(parsed.length).toBeGreaterThanOrEqual(3);
    for (const m of parsed) {
      expect(m).toHaveProperty('path');
      expect(m).toHaveProperty('line');
      expect(m).toHaveProperty('snippet');
      expect(m).toHaveProperty('sha256');
      expect(typeof m.sha256).toBe('string');
      expect(m.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    // node_modules path must not appear
    for (const m of parsed) {
      expect(m.path).not.toMatch(/node_modules/);
    }
  });

  it('--glob "*.ts" filters out .js / .md hits', async () => {
    const res = await runCodeGrepCli([
      'grep',
      'handleX',
      '--repo',
      TMP_ROOT,
      '--glob',
      '*.ts',
    ]);
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    for (const m of parsed) {
      expect(m.path).toMatch(/\.ts$/);
    }
    // Should still hit a.ts at least once
    expect(parsed.some((m: any) => m.path.endsWith('a.ts'))).toBe(true);
  });

  it('--max-matches caps the result set', async () => {
    // pattern matches every line in a.ts (7 lines) + others
    const res = await runCodeGrepCli([
      'grep',
      '.',
      '--repo',
      TMP_ROOT,
      '--max-matches',
      '2',
    ]);
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.length).toBe(2);
  });

  it('snippet contains roughly 5 lines around the match', async () => {
    // pattern 'handleY' lives on line 5 of a.ts; snippet should span lines 4-8
    const res = await runCodeGrepCli([
      'grep',
      'handleY',
      '--repo',
      TMP_ROOT,
      '--glob',
      '*.ts',
    ]);
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout);
    const aHit = parsed.find((m: any) => m.path.endsWith('a.ts'));
    expect(aHit).toBeTruthy();
    const snippetLines = aHit.snippet.split('\n');
    // start = max(0, 5-1-1) = 3 (zero-indexed line 4) → end = min(len, 5-1+4) = 8
    // → snippet should have <= 5 lines
    expect(snippetLines.length).toBeGreaterThanOrEqual(2);
    expect(snippetLines.length).toBeLessThanOrEqual(5);
    expect(aHit.snippet).toContain('handleY');
  });

  it('emits empty array when no match', async () => {
    const res = await runCodeGrepCli([
      'grep',
      'thisPatternDoesNotExistAnywhere1234',
      '--repo',
      TMP_ROOT,
    ]);
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed).toEqual([]);
  });

  it('rejects malformed regex with exit 1', async () => {
    const res = await runCodeGrepCli([
      'grep',
      '[unclosed',
      '--repo',
      TMP_ROOT,
    ]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/invalid regex/i);
  });
});
