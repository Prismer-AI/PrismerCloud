/**
 * Test suite for scripts/post-memory-observe.mjs
 *
 * Covers:
 *   - CC memory path detection (match + non-match)
 *   - Frontmatter parsing (with + without)
 *   - scope inference for all 5 shapes
 *   - no-op gating via CLAUDE_CODE_DISABLE_AUTO_MEMORY=1
 *   - POST body shape (via dry-run mode capture)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

// Direct imports for unit-testable helpers.
import {
  detectCCMemoryPath,
  parseFrontmatter,
  buildRequestBody,
} from '../scripts/post-memory-observe.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(__dirname, '..', 'scripts', 'post-memory-observe.mjs');

// ─── Test harness ─────────────────────────────────────────────────────────────

let TEST_DIR;
function freshDir() {
  const d = join(tmpdir(), `prismer-mem-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
    ...env,
  };
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

// ─── detectCCMemoryPath — Unit Tests ─────────────────────────────────────────

describe('detectCCMemoryPath()', () => {
  const CLAUDE_DIR = '/home/tom/.claude';

  it('returns null for non-.md paths', () => {
    expect(detectCCMemoryPath('/home/tom/.claude/memory/foo.txt', { configDir: CLAUDE_DIR })).toBeNull();
    expect(detectCCMemoryPath('/tmp/random.py', { configDir: CLAUDE_DIR })).toBeNull();
  });

  it('returns null for paths outside known CC memory roots', () => {
    expect(detectCCMemoryPath('/tmp/random.md', { configDir: CLAUDE_DIR })).toBeNull();
    expect(detectCCMemoryPath('/home/tom/docs/README.md', { configDir: CLAUDE_DIR })).toBeNull();
    // Inside .claude but not under /memory or /agent-memory.
    expect(detectCCMemoryPath('/home/tom/.claude/settings.md', { configDir: CLAUDE_DIR })).toBeNull();
  });

  it('matches ~/.claude/memory/<file>.md → scope=global', () => {
    const r = detectCCMemoryPath('/home/tom/.claude/memory/feedback_ui.md', { configDir: CLAUDE_DIR });
    expect(r).toEqual({ scope: 'global', relPath: 'feedback_ui.md', mode: 'file' });
  });

  it('matches nested ~/.claude/memory/sub/dir/file.md', () => {
    const r = detectCCMemoryPath('/home/tom/.claude/memory/notes/2026/q1.md', { configDir: CLAUDE_DIR });
    expect(r).toEqual({ scope: 'global', relPath: 'notes/2026/q1.md', mode: 'file' });
  });

  it('matches ~/.claude/projects/<proj>/memory/... → scope=project:<proj>', () => {
    const r = detectCCMemoryPath(
      '/home/tom/.claude/projects/my-app/memory/feedback_deploy.md',
      { configDir: CLAUDE_DIR },
    );
    expect(r).toEqual({ scope: 'project:my-app', relPath: 'feedback_deploy.md', mode: 'file' });
  });

  it('matches ~/.claude/agent-memory/user/... → scope=global', () => {
    const r = detectCCMemoryPath(
      '/home/tom/.claude/agent-memory/user/prefs.md',
      { configDir: CLAUDE_DIR, cwd: '/work/myproj' },
    );
    expect(r).toEqual({ scope: 'global', relPath: 'prefs.md', mode: 'file' });
  });

  it('matches ~/.claude/agent-memory/project/... → scope=project:<cwd-basename>', () => {
    const r = detectCCMemoryPath(
      '/home/tom/.claude/agent-memory/project/team-notes.md',
      { configDir: CLAUDE_DIR, cwd: '/work/myproj' },
    );
    expect(r).toEqual({ scope: 'project:myproj', relPath: 'team-notes.md', mode: 'file' });
  });

  it('matches ~/.claude/agent-memory/local/... → scope=project:<cwd-basename>:local', () => {
    const r = detectCCMemoryPath(
      '/home/tom/.claude/agent-memory/local/scratch.md',
      { configDir: CLAUDE_DIR, cwd: '/work/myproj' },
    );
    expect(r).toEqual({ scope: 'project:myproj:local', relPath: 'scratch.md', mode: 'file' });
  });

  it('matches ~/.claude/memory/team/<owner>/<repo>/... → scope=shared:team:<owner>/<repo>', () => {
    const r = detectCCMemoryPath(
      '/home/tom/.claude/memory/team/acme/webapp/architecture.md',
      { configDir: CLAUDE_DIR },
    );
    expect(r).toEqual({ scope: 'shared:team:acme/webapp', relPath: 'architecture.md', mode: 'file' });
  });

  it('respects CLAUDE_CONFIG_DIR override', () => {
    // When CLAUDE_CONFIG_DIR moves .claude elsewhere.
    const r = detectCCMemoryPath(
      '/custom/cfg/memory/foo.md',
      { configDir: '/custom/cfg' },
    );
    expect(r).toEqual({ scope: 'global', relPath: 'foo.md', mode: 'file' });
  });

  it('respects CLAUDE_CODE_REMOTE_MEMORY_DIR (with sub-structure matching the canonical layout)', () => {
    const r = detectCCMemoryPath(
      '/mnt/remote/memory/foo.md',
      { configDir: '/home/tom/.claude', remoteDir: '/mnt/remote' },
    );
    expect(r).toEqual({ scope: 'global', relPath: 'foo.md', mode: 'file' });
  });

  it('respects CLAUDE_CODE_REMOTE_MEMORY_DIR (flat content → global fallback)', () => {
    const r = detectCCMemoryPath(
      '/mnt/remote/notes.md',
      { configDir: '/home/tom/.claude', remoteDir: '/mnt/remote' },
    );
    expect(r).toEqual({ scope: 'global', relPath: 'notes.md', mode: 'file' });
  });

  it('returns null for malformed team paths (missing repo or file)', () => {
    expect(detectCCMemoryPath('/home/tom/.claude/memory/team/acme/webapp.md', { configDir: CLAUDE_DIR })).toBeNull();
    expect(detectCCMemoryPath('/home/tom/.claude/memory/team/solo.md', { configDir: CLAUDE_DIR })).toBeNull();
  });

  it('returns null for unknown agent-memory subdir', () => {
    expect(detectCCMemoryPath(
      '/home/tom/.claude/agent-memory/weird/foo.md',
      { configDir: CLAUDE_DIR, cwd: '/work/proj' },
    )).toBeNull();
  });
});

// ─── parseFrontmatter — Unit Tests ───────────────────────────────────────────

describe('parseFrontmatter()', () => {
  it('returns only body when no frontmatter', () => {
    const out = parseFrontmatter('# Heading\n\nJust a note.\n');
    expect(out.memoryType).toBeUndefined();
    expect(out.description).toBeUndefined();
    expect(out.body).toBe('# Heading\n\nJust a note.\n');
  });

  it('parses type + description', () => {
    const text = [
      '---',
      'name: My Feedback',
      'description: UI feedback for dark theme',
      'type: feedback',
      '---',
      '# Body',
      'content here',
    ].join('\n');
    const out = parseFrontmatter(text);
    expect(out.memoryType).toBe('feedback');
    expect(out.description).toBe('UI feedback for dark theme');
    expect(out.body).toContain('# Body');
    expect(out.body).toContain('content here');
  });

  it('strips surrounding quotes in values', () => {
    const text = [
      '---',
      'type: "reference"',
      "description: 'with single quotes'",
      '---',
      'body',
    ].join('\n');
    const out = parseFrontmatter(text);
    expect(out.memoryType).toBe('reference');
    expect(out.description).toBe('with single quotes');
  });

  it('ignores unrelated keys', () => {
    const text = [
      '---',
      'name: foo',
      'author: tom',
      'type: project',
      '---',
      'body',
    ].join('\n');
    const out = parseFrontmatter(text);
    expect(out.memoryType).toBe('project');
    expect(out.description).toBeUndefined();
  });

  it('returns body as-is when frontmatter is not closed', () => {
    const text = '---\ntype: foo\nstill no close';
    const out = parseFrontmatter(text);
    expect(out.memoryType).toBeUndefined();
    expect(out.body).toBe(text);
  });

  it('handles empty input safely', () => {
    expect(parseFrontmatter('')).toEqual({ body: '' });
    expect(parseFrontmatter(null)).toEqual({ body: '' });
  });

  // Whitelist-map: unknown frontmatter `type` values are dropped.
  it('drops unknown type values (whitelist against closed MemoryType union)', () => {
    const text = [
      '---',
      'type: episodic',
      'description: unknown-type example',
      '---',
      'body',
    ].join('\n');
    const out = parseFrontmatter(text);
    // 'episodic' is NOT in the v1.9.0 MemoryType union (user|feedback|project|reference|insight).
    expect(out.memoryType).toBeUndefined();
    // description still passes through.
    expect(out.description).toBe('unknown-type example');
  });

  it('keeps each known MemoryType value', () => {
    const known = ['user', 'feedback', 'project', 'reference', 'insight'];
    for (const t of known) {
      const text = `---\ntype: ${t}\n---\nbody`;
      const out = parseFrontmatter(text);
      expect(out.memoryType).toBe(t);
    }
  });
});

// ─── buildRequestBody — Unit Tests ───────────────────────────────────────────

describe('buildRequestBody()', () => {
  it('omits ownerId (server resolves from auth)', () => {
    const body = buildRequestBody({
      scope: 'global',
      relPath: 'foo.md',
      content: '# hi',
    });
    expect(body.ownerId).toBeUndefined();
    expect(body.ownerType).toBe('agent');
    expect(body.scope).toBe('global');
    expect(body.path).toBe('foo.md');
    expect(body.content).toBe('# hi');
  });

  it('includes memoryType and description when present', () => {
    const body = buildRequestBody({
      scope: 'project:app',
      relPath: 'feedback.md',
      content: 'body',
      memoryType: 'feedback',
      description: 'About X',
    });
    expect(body.memoryType).toBe('feedback');
    expect(body.description).toBe('About X');
  });

  it('omits memoryType/description when absent', () => {
    const body = buildRequestBody({
      scope: 'global',
      relPath: 'x.md',
      content: 'body',
    });
    expect(body).not.toHaveProperty('memoryType');
    expect(body).not.toHaveProperty('description');
  });
});

// ─── Integration: script-level behavior (process exit, side effects) ─────────

describe('post-memory-observe.mjs (process-level)', () => {
  beforeEach(() => {
    TEST_DIR = freshDir();
  });
  afterEach(() => {
    try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  });

  it('exits 0 on empty stdin', () => {
    const r = runHook('{}');
    expect(r.exitCode).toBe(0);
  });

  it('exits 0 on malformed JSON', () => {
    const r = runHook('not-json');
    expect(r.exitCode).toBe(0);
  });

  it('is a silent no-op when CLAUDE_CODE_DISABLE_AUTO_MEMORY=1', () => {
    // Build a real CC memory file so the path would otherwise match.
    const memDir = join(TEST_DIR, '.claude', 'memory');
    mkdirSync(memDir, { recursive: true });
    const fp = join(memDir, 'foo.md');
    writeFileSync(fp, '---\ntype: feedback\n---\nbody\n');

    const r = runHook(
      { tool_name: 'Write', tool_input: { file_path: fp } },
      {
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
        PRISMER_API_KEY: 'sk-prismer-test-key',
        _PRISMER_MEMORY_OBSERVE_DRY_RUN: '1',
      },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('is a no-op for non-CC-memory paths (e.g. /tmp/random.txt)', () => {
    const r = runHook(
      { tool_name: 'Write', tool_input: { file_path: '/tmp/random.txt' } },
      {
        PRISMER_API_KEY: 'sk-prismer-test-key',
        _PRISMER_MEMORY_OBSERVE_DRY_RUN: '1',
      },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('is a no-op when tool_name is not Write/Edit', () => {
    const r = runHook(
      { tool_name: 'Bash', tool_input: { command: 'echo hi' } },
      { PRISMER_API_KEY: 'sk-prismer-test-key' },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('is a no-op when target file is empty (pre-write race)', () => {
    const memDir = join(TEST_DIR, '.claude', 'memory');
    mkdirSync(memDir, { recursive: true });
    const fp = join(memDir, 'stub.md');
    writeFileSync(fp, '');

    const r = runHook(
      { tool_name: 'Write', tool_input: { file_path: fp } },
      {
        PRISMER_API_KEY: 'sk-prismer-test-key',
        _PRISMER_MEMORY_OBSERVE_DRY_RUN: '1',
      },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('emits URL + body shape when matching CC memory path (dry-run)', () => {
    const memDir = join(TEST_DIR, '.claude', 'memory');
    mkdirSync(memDir, { recursive: true });
    const fp = join(memDir, 'feedback_ui.md');
    writeFileSync(fp, '---\ntype: feedback\ndescription: UI note\n---\n# Body\nhello\n');

    const r = runHook(
      { tool_name: 'Write', tool_input: { file_path: fp } },
      {
        PRISMER_API_KEY: 'sk-prismer-test-key',
        PRISMER_BASE_URL: 'http://test.example:19999',
        CLAUDE_CONFIG_DIR: join(TEST_DIR, '.claude'),
        _PRISMER_MEMORY_OBSERVE_DRY_RUN: '1',
      },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toBe('');

    const parsed = JSON.parse(r.stdout);
    expect(parsed.url).toBe('http://test.example:19999/api/im/memory/files');
    expect(parsed.body.scope).toBe('global');
    expect(parsed.body.path).toBe('feedback_ui.md');
    expect(parsed.body.ownerType).toBe('agent');
    expect(parsed.body.memoryType).toBe('feedback');
    expect(parsed.body.description).toBe('UI note');
    expect(parsed.body.content).toContain('# Body');
    // ownerId is NOT in the body — server resolves from auth.
    expect(parsed.body.ownerId).toBeUndefined();
  });

  // Unknown frontmatter `type` values are dropped at the hook boundary so
  // the server never has to decide.
  it('drops unknown frontmatter type from wire body (dry-run)', () => {
    const memDir = join(TEST_DIR, '.claude', 'memory');
    mkdirSync(memDir, { recursive: true });
    const fp = join(memDir, 'unknown_type.md');
    writeFileSync(fp, '---\ntype: episodic\ndescription: mystery note\n---\n# Body\n');

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
    // memoryType should NOT appear on the wire — 'episodic' isn't in the union.
    expect(parsed.body).not.toHaveProperty('memoryType');
    // description remains (it's free-form).
    expect(parsed.body.description).toBe('mystery note');
  });

  it('emits project-scope body for ~/.claude/projects/<proj>/memory/...', () => {
    const memDir = join(TEST_DIR, '.claude', 'projects', 'my-app', 'memory');
    mkdirSync(memDir, { recursive: true });
    const fp = join(memDir, 'deploy.md');
    writeFileSync(fp, 'no frontmatter here');

    const r = runHook(
      { tool_name: 'Edit', tool_input: { file_path: fp } },
      {
        PRISMER_API_KEY: 'sk-prismer-test-key',
        CLAUDE_CONFIG_DIR: join(TEST_DIR, '.claude'),
        _PRISMER_MEMORY_OBSERVE_DRY_RUN: '1',
      },
    );
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.body.scope).toBe('project:my-app');
    expect(parsed.body.path).toBe('deploy.md');
    expect(parsed.body).not.toHaveProperty('memoryType');
    expect(parsed.body).not.toHaveProperty('description');
  });

  it('emits shared:team:<owner>/<repo> scope for team memory', () => {
    const memDir = join(TEST_DIR, '.claude', 'memory', 'team', 'acme', 'webapp');
    mkdirSync(memDir, { recursive: true });
    const fp = join(memDir, 'architecture.md');
    writeFileSync(fp, '# Architecture\n');

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
    expect(parsed.body.scope).toBe('shared:team:acme/webapp');
    expect(parsed.body.path).toBe('architecture.md');
  });

  it('is a no-op without API key (even for matching paths)', () => {
    const memDir = join(TEST_DIR, '.claude', 'memory');
    mkdirSync(memDir, { recursive: true });
    const fp = join(memDir, 'foo.md');
    writeFileSync(fp, '# body');

    const r = runHook(
      { tool_name: 'Write', tool_input: { file_path: fp } },
      {
        PRISMER_API_KEY: '',
        CLAUDE_CONFIG_DIR: join(TEST_DIR, '.claude'),
        _PRISMER_MEMORY_OBSERVE_DRY_RUN: '1',
      },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('');
  });
});
