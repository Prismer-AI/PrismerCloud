/**
 * Test suite for KAIROS (daily-log) observation mode.
 *
 * KAIROS is a CC feature gate that switches memory writes from whole-file
 * MEMORY.md-style files to **append-only daily logs**: `logs/YYYY/MM/DD.md`.
 *
 * For KAIROS files the hook must:
 *   - Detect the path as `mode: 'kairos'`
 *   - Maintain a per-file cursor in `$CLAUDE_PLUGIN_DATA/.kairos-cursors.json`
 *   - On each event, POST only the delta (bytes appended since last event),
 *     falling back to whole-file on first observation or on rotation
 *   - Use `operation: 'append'` so the server does create-or-append
 *   - Skip entirely when delta is empty (no-op)
 *   - Fall back to whole-file upsert when `PRISMER_CC_KAIROS_DIFF=0`
 *
 * Covers:
 *   - Path detection for all 4 supported root shapes
 *   - Malformed / non-zero-padded date path rejection
 *   - computeKairosDelta: initial / delta / reset / noop
 *   - Cursor persist/read roundtrip
 *   - Dry-run body shape (operation='append' + content=delta)
 *   - Env kill-switch PRISMER_CC_KAIROS_DIFF=0 → whole-file path
 *   - Non-regression: T18 non-KAIROS paths still detect as mode='file'
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

import {
  detectCCMemoryPath,
  isKairosRelPath,
  computeKairosDelta,
  buildRequestBody,
  readKairosCursors,
  writeKairosCursors,
} from '../scripts/post-memory-observe.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(__dirname, '..', 'scripts', 'post-memory-observe.mjs');

// ─── Harness ─────────────────────────────────────────────────────────────────

let TEST_DIR;
function freshDir() {
  const d = join(tmpdir(), `prismer-kairos-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

function runHook(stdinData = '{}', env = {}) {
  const input = typeof stdinData === 'string' ? stdinData : JSON.stringify(stdinData);
  const fullEnv = {
    ...process.env,
    CLAUDE_PLUGIN_DATA: TEST_DIR,
    PRISMER_API_KEY: '',
    PRISMER_BASE_URL: 'http://localhost:19999',
    HOME: TEST_DIR,
    // Unset this by default; tests that need it will re-enable.
    PRISMER_CC_KAIROS_DIFF: undefined,
    ...env,
  };
  // Drop undefined keys (spawnSync doesn't like them).
  for (const k of Object.keys(fullEnv)) {
    if (fullEnv[k] === undefined) delete fullEnv[k];
  }
  const result = spawnSync('node', [SCRIPT_PATH], {
    input,
    env: fullEnv,
    encoding: 'utf8',
    timeout: 10000,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status ?? 1,
  };
}

// ─── isKairosRelPath — Unit Tests ────────────────────────────────────────────

describe('isKairosRelPath()', () => {
  it('matches logs/YYYY/MM/DD.md at relPath root', () => {
    expect(isKairosRelPath('logs/2026/04/18.md')).toBe(true);
    expect(isKairosRelPath('logs/2025/12/31.md')).toBe(true);
  });

  it('matches logs/YYYY/MM/DD.md nested under subdirs', () => {
    // When scope detection leaves a nested prefix, /logs/ still anchors.
    expect(isKairosRelPath('team/acme/logs/2026/04/18.md')).toBe(true);
  });

  it('rejects non-zero-padded dates', () => {
    expect(isKairosRelPath('logs/2026/4/18.md')).toBe(false);
    expect(isKairosRelPath('logs/2026/04/8.md')).toBe(false);
  });

  it('rejects non-.md or missing segments', () => {
    expect(isKairosRelPath('logs/2026/04/18.txt')).toBe(false);
    expect(isKairosRelPath('logs/2026/04.md')).toBe(false);
    expect(isKairosRelPath('notes/2026/04/18.md')).toBe(false);
    expect(isKairosRelPath('')).toBe(false);
    expect(isKairosRelPath(null)).toBe(false);
  });
});

// ─── detectCCMemoryPath — KAIROS mode detection ──────────────────────────────

describe('detectCCMemoryPath() → mode', () => {
  const CLAUDE_DIR = '/home/tom/.claude';

  it('tags regular ~/.claude/memory file as mode=file', () => {
    const r = detectCCMemoryPath('/home/tom/.claude/memory/feedback_ui.md', { configDir: CLAUDE_DIR });
    expect(r).toEqual({ scope: 'global', relPath: 'feedback_ui.md', mode: 'file' });
  });

  it('tags ~/.claude/memory/logs/YYYY/MM/DD.md as mode=kairos', () => {
    const r = detectCCMemoryPath('/home/tom/.claude/memory/logs/2026/04/18.md', { configDir: CLAUDE_DIR });
    expect(r).toEqual({ scope: 'global', relPath: 'logs/2026/04/18.md', mode: 'kairos' });
  });

  it('tags ~/.claude/projects/<proj>/memory/logs/YYYY/MM/DD.md as mode=kairos', () => {
    const r = detectCCMemoryPath(
      '/home/tom/.claude/projects/my-app/memory/logs/2026/04/18.md',
      { configDir: CLAUDE_DIR },
    );
    expect(r).toEqual({ scope: 'project:my-app', relPath: 'logs/2026/04/18.md', mode: 'kairos' });
  });

  it('tags $CLAUDE_CODE_REMOTE_MEMORY_DIR/logs/YYYY/MM/DD.md as mode=kairos', () => {
    const r = detectCCMemoryPath(
      '/mnt/remote/logs/2026/04/18.md',
      { configDir: CLAUDE_DIR, remoteDir: '/mnt/remote' },
    );
    expect(r).toEqual({ scope: 'global', relPath: 'logs/2026/04/18.md', mode: 'kairos' });
  });

  it('tags $CLAUDE_CONFIG_DIR/memory/logs/YYYY/MM/DD.md as mode=kairos', () => {
    const r = detectCCMemoryPath(
      '/custom/cfg/memory/logs/2026/04/18.md',
      { configDir: '/custom/cfg' },
    );
    expect(r).toEqual({ scope: 'global', relPath: 'logs/2026/04/18.md', mode: 'kairos' });
  });

  it('does NOT tag malformed date path as kairos (still tags as file if .md)', () => {
    const r = detectCCMemoryPath('/home/tom/.claude/memory/logs/2026/4/18.md', { configDir: CLAUDE_DIR });
    // Path is still matched as a memory file, but mode='file' since date is malformed.
    expect(r).toEqual({ scope: 'global', relPath: 'logs/2026/4/18.md', mode: 'file' });
  });

  it('still returns null for non-memory paths', () => {
    expect(detectCCMemoryPath('/tmp/logs/2026/04/18.md', { configDir: CLAUDE_DIR })).toBeNull();
  });
});

// ─── computeKairosDelta — Unit Tests ─────────────────────────────────────────

describe('computeKairosDelta()', () => {
  it('returns initial on first observation (no cursor)', () => {
    const r = computeKairosDelta('hello world', undefined);
    expect(r.kind).toBe('initial');
    expect(r.content).toBe('hello world');
    expect(r.newLength).toBe(11);
  });

  it('returns delta when content grew', () => {
    const r = computeKairosDelta('hello world tail', { lastLength: 11, lastMTime: 1 });
    expect(r.kind).toBe('delta');
    expect(r.content).toBe(' tail');
    expect(r.newLength).toBe(16);
  });

  it('returns noop when content unchanged', () => {
    const r = computeKairosDelta('hello world', { lastLength: 11, lastMTime: 1 });
    expect(r.kind).toBe('noop');
  });

  it('returns reset when content shrank (rotation / rewrite)', () => {
    const r = computeKairosDelta('short', { lastLength: 100, lastMTime: 1 });
    expect(r.kind).toBe('reset');
    expect(r.content).toBe('short');
    expect(r.newLength).toBe(5);
  });

  it('treats invalid cursor shape as initial', () => {
    const r = computeKairosDelta('hello', { lastLength: undefined });
    expect(r.kind).toBe('initial');
  });
});

// ─── Cursor persistence — roundtrip ──────────────────────────────────────────

describe('Kairos cursor persistence', () => {
  let dir;
  let cursorPath;

  beforeEach(() => {
    dir = freshDir();
    cursorPath = join(dir, '.kairos-cursors.json');
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  it('returns empty object when file does not exist', () => {
    expect(readKairosCursors(cursorPath)).toEqual({});
  });

  it('returns empty object when file is malformed JSON', () => {
    writeFileSync(cursorPath, 'not-json');
    expect(readKairosCursors(cursorPath)).toEqual({});
  });

  it('writes and reads back a cursor map', () => {
    const cursors = {
      '/a/b/logs/2026/04/18.md': { lastLength: 123, lastMTime: 1700000000000 },
    };
    writeKairosCursors(cursors, cursorPath);
    const readBack = readKairosCursors(cursorPath);
    expect(readBack).toEqual(cursors);
  });

  it('atomic write: no .tmp residue on success', () => {
    writeKairosCursors({ '/x.md': { lastLength: 1, lastMTime: 1 } }, cursorPath);
    // Temp files should have been renamed away.
    const parent = dirname(cursorPath);
    const entries = readdirSync(parent);
    const leftover = entries.filter((e) => e.startsWith('.kairos-cursors.json.tmp'));
    expect(leftover).toEqual([]);
  });
});

// ─── buildRequestBody — operation field ──────────────────────────────────────

describe('buildRequestBody() operation field', () => {
  it('omits operation when not specified', () => {
    const body = buildRequestBody({ scope: 'global', relPath: 'x.md', content: 'hi' });
    expect(body).not.toHaveProperty('operation');
  });

  it("includes operation: 'append' when specified", () => {
    const body = buildRequestBody({
      scope: 'global',
      relPath: 'logs/2026/04/18.md',
      content: '+new line',
      operation: 'append',
    });
    expect(body.operation).toBe('append');
    expect(body.content).toBe('+new line');
  });

  it("includes operation: 'upsert' when specified (S3 fix — explicit replace)", () => {
    // After ship-blocker S3 fix, we emit 'upsert' on the wire for initial/reset
    // KAIROS events so the server unambiguously replaces any stale baseline.
    const body = buildRequestBody({
      scope: 'global',
      relPath: 'logs/2026/04/18.md',
      content: 'full content',
      operation: 'upsert',
    });
    expect(body.operation).toBe('upsert');
    expect(body.content).toBe('full content');
  });

  it('ignores unrecognized operation values', () => {
    const body = buildRequestBody({
      scope: 'global',
      relPath: 'x.md',
      content: 'hi',
      operation: 'delete',
    });
    expect(body).not.toHaveProperty('operation');
  });
});

// ─── Integration: process-level KAIROS behavior ──────────────────────────────

describe('post-memory-observe.mjs KAIROS (process-level)', () => {
  beforeEach(() => {
    TEST_DIR = freshDir();
  });
  afterEach(() => {
    try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  });

  function setupKairosFile(content) {
    const dir = join(TEST_DIR, '.claude', 'memory', 'logs', '2026', '04');
    mkdirSync(dir, { recursive: true });
    const fp = join(dir, '18.md');
    writeFileSync(fp, content);
    return fp;
  }

  it('first event: full content posted with operation=upsert + kairosKind=initial (S3 fix)', () => {
    const fp = setupKairosFile('line 1\nline 2\n');

    const r = runHook(
      { tool_name: 'Write', tool_input: { file_path: fp } },
      {
        PRISMER_API_KEY: 'sk-prismer-test-key',
        CLAUDE_CONFIG_DIR: join(TEST_DIR, '.claude'),
        _PRISMER_MEMORY_OBSERVE_DRY_RUN: '1',
      },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toBe('');
    const parsed = JSON.parse(r.stdout);
    expect(parsed.mode).toBe('kairos');
    expect(parsed.kairosKind).toBe('initial');
    // S3: initial event must upsert (replace), not append — we don't know what
    // the server holds from a prior process and appending would corrupt.
    expect(parsed.body.operation).toBe('upsert');
    expect(parsed.body.path).toBe('logs/2026/04/18.md');
    expect(parsed.body.scope).toBe('global');
    expect(parsed.body.content).toBe('line 1\nline 2\n');

    // Cursor established.
    const cursors = JSON.parse(readFileSync(join(TEST_DIR, '.kairos-cursors.json'), 'utf8'));
    expect(cursors[fp].lastLength).toBe('line 1\nline 2\n'.length);
  });

  it('second event (growth): only delta is posted, cursor advances', () => {
    const fp = setupKairosFile('line 1\n');

    const r1 = runHook(
      { tool_name: 'Write', tool_input: { file_path: fp } },
      {
        PRISMER_API_KEY: 'sk-prismer-test-key',
        CLAUDE_CONFIG_DIR: join(TEST_DIR, '.claude'),
        _PRISMER_MEMORY_OBSERVE_DRY_RUN: '1',
      },
    );
    expect(r1.exitCode).toBe(0);

    // Grow the file.
    writeFileSync(fp, 'line 1\nline 2 appended\n');

    const r2 = runHook(
      { tool_name: 'Edit', tool_input: { file_path: fp } },
      {
        PRISMER_API_KEY: 'sk-prismer-test-key',
        CLAUDE_CONFIG_DIR: join(TEST_DIR, '.claude'),
        _PRISMER_MEMORY_OBSERVE_DRY_RUN: '1',
      },
    );
    expect(r2.exitCode).toBe(0);
    const parsed2 = JSON.parse(r2.stdout);
    expect(parsed2.kairosKind).toBe('delta');
    expect(parsed2.body.operation).toBe('append');
    expect(parsed2.body.content).toBe('line 2 appended\n');

    const cursors = JSON.parse(readFileSync(join(TEST_DIR, '.kairos-cursors.json'), 'utf8'));
    expect(cursors[fp].lastLength).toBe('line 1\nline 2 appended\n'.length);
  });

  it('unchanged file (noop): no stdout, cursor unchanged', () => {
    const fp = setupKairosFile('stable content\n');

    // First event to prime cursor.
    const r1 = runHook(
      { tool_name: 'Write', tool_input: { file_path: fp } },
      {
        PRISMER_API_KEY: 'sk-prismer-test-key',
        CLAUDE_CONFIG_DIR: join(TEST_DIR, '.claude'),
        _PRISMER_MEMORY_OBSERVE_DRY_RUN: '1',
      },
    );
    expect(r1.exitCode).toBe(0);
    const cursorsBefore = JSON.parse(readFileSync(join(TEST_DIR, '.kairos-cursors.json'), 'utf8'));

    // Second event with no change.
    const r2 = runHook(
      { tool_name: 'Edit', tool_input: { file_path: fp } },
      {
        PRISMER_API_KEY: 'sk-prismer-test-key',
        CLAUDE_CONFIG_DIR: join(TEST_DIR, '.claude'),
        _PRISMER_MEMORY_OBSERVE_DRY_RUN: '1',
      },
    );
    expect(r2.exitCode).toBe(0);
    // No POST body emitted on noop.
    expect(r2.stdout).toBe('');
    const cursorsAfter = JSON.parse(readFileSync(join(TEST_DIR, '.kairos-cursors.json'), 'utf8'));
    expect(cursorsAfter[fp].lastLength).toBe(cursorsBefore[fp].lastLength);
  });

  it('shrink / rotation: full content re-posted with operation=upsert + cursor resets (S3 fix)', () => {
    const fp = setupKairosFile('original long content here\n');

    const r1 = runHook(
      { tool_name: 'Write', tool_input: { file_path: fp } },
      {
        PRISMER_API_KEY: 'sk-prismer-test-key',
        CLAUDE_CONFIG_DIR: join(TEST_DIR, '.claude'),
        _PRISMER_MEMORY_OBSERVE_DRY_RUN: '1',
      },
    );
    expect(r1.exitCode).toBe(0);
    const cursorsBefore = JSON.parse(readFileSync(join(TEST_DIR, '.kairos-cursors.json'), 'utf8'));

    // Simulate rotation: file shrinks.
    writeFileSync(fp, 'tiny\n');

    const r2 = runHook(
      { tool_name: 'Write', tool_input: { file_path: fp } },
      {
        PRISMER_API_KEY: 'sk-prismer-test-key',
        CLAUDE_CONFIG_DIR: join(TEST_DIR, '.claude'),
        _PRISMER_MEMORY_OBSERVE_DRY_RUN: '1',
      },
    );
    expect(r2.exitCode).toBe(0);
    const parsed2 = JSON.parse(r2.stdout);
    expect(parsed2.kairosKind).toBe('reset');
    // S3: reset MUST upsert to blow away the corrupted baseline. Using append
    // here would concat the smaller content onto the larger stale server copy
    // and permanently desync the cursor from the content.
    expect(parsed2.body.operation).toBe('upsert');
    expect(parsed2.body.content).toBe('tiny\n');
    const cursorsAfter = JSON.parse(readFileSync(join(TEST_DIR, '.kairos-cursors.json'), 'utf8'));
    // Cursor advances to the NEW (shorter) length so subsequent deltas anchor
    // off the freshly-replaced baseline, not the pre-rotation length.
    expect(cursorsAfter[fp].lastLength).toBe('tiny\n'.length);
    expect(cursorsAfter[fp].lastLength).toBeLessThan(cursorsBefore[fp].lastLength);
  });

  it('PRISMER_CC_KAIROS_DIFF=0 disables diff mode — posts full content as upsert', () => {
    const fp = setupKairosFile('line 1\nline 2\n');

    const r = runHook(
      { tool_name: 'Write', tool_input: { file_path: fp } },
      {
        PRISMER_API_KEY: 'sk-prismer-test-key',
        CLAUDE_CONFIG_DIR: join(TEST_DIR, '.claude'),
        _PRISMER_MEMORY_OBSERVE_DRY_RUN: '1',
        PRISMER_CC_KAIROS_DIFF: '0',
      },
    );
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.mode).toBe('kairos');
    // kairosKind is not set when diff mode is disabled.
    expect(parsed.kairosKind).toBeUndefined();
    // No operation field → server defaults to upsert.
    expect(parsed.body).not.toHaveProperty('operation');
    // Full file content posted.
    expect(parsed.body.content).toBe('line 1\nline 2\n');
    // Cursor file NOT created when diff disabled.
    expect(existsSync(join(TEST_DIR, '.kairos-cursors.json'))).toBe(false);
  });

  it('non-KAIROS memory file still posts whole-file (T18 regression guard)', () => {
    const memDir = join(TEST_DIR, '.claude', 'memory');
    mkdirSync(memDir, { recursive: true });
    const fp = join(memDir, 'feedback_ui.md');
    writeFileSync(fp, '# body\n');

    const r = runHook(
      { tool_name: 'Write', tool_input: { file_path: fp } },
      {
        PRISMER_API_KEY: 'sk-prismer-test-key',
        CLAUDE_CONFIG_DIR: join(TEST_DIR, '.claude'),
        _PRISMER_MEMORY_OBSERVE_DRY_RUN: '1',
      },
    );
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.mode).toBe('file');
    expect(parsed.body).not.toHaveProperty('operation');
    expect(parsed.body.path).toBe('feedback_ui.md');
  });
});
