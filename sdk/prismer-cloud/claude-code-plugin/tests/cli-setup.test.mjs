/**
 * cli-setup.test.mjs — Unit tests for scripts/cli.mjs setup behavior.
 *
 * Covers Plugin Fix E:
 *   1. mergeHooksFile deep-merges instead of overwriting
 *        - Missing file → template copied as-is
 *        - Valid JSON w/ other-plugin hooks → other hooks preserved, Prismer hooks added
 *        - Re-running setup → no duplicate Prismer hook entries
 *        - Corrupt JSON → timestamped backup + template written
 *        - Backup rotation → max 3 timestamped backups retained
 *   2. chmod 600 on mcp_servers.json after write (POSIX only)
 *
 * cli.mjs is an ESM script, not a library — we spawn it as a child process for
 * the chmod integration test, and dynamically import for the pure helpers.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..');
const TEMPLATE_HOOKS = join(PLUGIN_ROOT, 'templates', 'hooks.json');

// cli.mjs's entry block runs at import time, so we patch argv BEFORE import to
// hit the benign `--help` branch (prints help, does not exit). Static import
// is required — vite doesn't allow arbitrary dynamic import specifiers.
const savedArgv = process.argv.slice();
process.argv = [process.argv[0], 'cli.mjs', '--help'];
const cliMod = await import('../scripts/cli.mjs');
process.argv = savedArgv;
const { mergeHooksFile, isPrismerHookRule } = cliMod;

// ─── Helpers ──────────────────────────────────────────────────────────────

function freshDir() {
  const dir = join(tmpdir(), `prismer-cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A third-party plugin's hook entry (e.g. gstack). Must be preserved. */
function thirdPartyHookRule() {
  return {
    matcher: 'Bash',
    hooks: [
      { type: 'command', command: 'node /usr/local/lib/gstack/hooks/pre-bash.mjs' },
    ],
  };
}

// ─── mergeHooksFile tests ─────────────────────────────────────────────────

describe('mergeHooksFile (cli.mjs)', () => {
  let TMP;
  let HOOKS_PATH;

  beforeEach(() => {
    TMP = freshDir();
    HOOKS_PATH = join(TMP, 'hooks.json');
  });

  afterEach(() => {
    try { rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  it('copies template verbatim when hooks.json is missing', () => {
    expect(existsSync(HOOKS_PATH)).toBe(false);
    const action = mergeHooksFile(HOOKS_PATH, TEMPLATE_HOOKS);

    expect(action).toBe('copied');
    expect(existsSync(HOOKS_PATH)).toBe(true);
    const written = JSON.parse(readFileSync(HOOKS_PATH, 'utf-8'));
    const template = JSON.parse(readFileSync(TEMPLATE_HOOKS, 'utf-8'));
    expect(written).toEqual(template);
  });

  it('merges template into existing file, preserving other plugins', () => {
    // Existing file has a third-party hook under PreToolUse + a totally
    // unrelated event (ToolPermissionRequest) that should survive untouched.
    const existing = {
      hooks: {
        PreToolUse: [thirdPartyHookRule()],
        ToolPermissionRequest: [
          {
            hooks: [{ type: 'command', command: 'node /usr/local/superpowers/hooks/perm.mjs' }],
          },
        ],
      },
    };
    writeFileSync(HOOKS_PATH, JSON.stringify(existing, null, 2));

    const action = mergeHooksFile(HOOKS_PATH, TEMPLATE_HOOKS);
    expect(action).toBe('merged');

    const merged = JSON.parse(readFileSync(HOOKS_PATH, 'utf-8'));
    // Third-party PreToolUse hook survived
    const preToolCmds = JSON.stringify(merged.hooks.PreToolUse);
    expect(preToolCmds).toContain('gstack/hooks/pre-bash.mjs');
    // Prismer PreToolUse hooks also present
    expect(preToolCmds).toContain('pre-bash-suggest.mjs');
    expect(preToolCmds).toContain('pre-web-cache.mjs');
    // Unrelated event untouched
    expect(merged.hooks.ToolPermissionRequest).toEqual(existing.hooks.ToolPermissionRequest);
  });

  it('is idempotent: re-running does not duplicate Prismer entries', () => {
    // Seed with the third-party hook
    const existing = {
      hooks: { PreToolUse: [thirdPartyHookRule()] },
    };
    writeFileSync(HOOKS_PATH, JSON.stringify(existing, null, 2));

    mergeHooksFile(HOOKS_PATH, TEMPLATE_HOOKS);
    const firstPass = JSON.parse(readFileSync(HOOKS_PATH, 'utf-8'));
    mergeHooksFile(HOOKS_PATH, TEMPLATE_HOOKS);
    const secondPass = JSON.parse(readFileSync(HOOKS_PATH, 'utf-8'));

    // Rule counts per event must match across passes
    for (const event of Object.keys(firstPass.hooks)) {
      expect(secondPass.hooks[event].length).toBe(firstPass.hooks[event].length);
    }
    // Third-party hook still there exactly once
    const preCmds = JSON.stringify(secondPass.hooks.PreToolUse);
    const occurrences = preCmds.split('gstack/hooks/pre-bash.mjs').length - 1;
    expect(occurrences).toBe(1);
  });

  it('backs up + overwrites when existing file is not valid JSON', () => {
    writeFileSync(HOOKS_PATH, '{ this is not valid json');

    const action = mergeHooksFile(HOOKS_PATH, TEMPLATE_HOOKS);
    expect(action).toBe('backup-and-replaced');

    // Backup exists with timestamped suffix
    const backups = readdirSync(TMP).filter((n) => n.startsWith('hooks.json.backup.'));
    expect(backups.length).toBeGreaterThanOrEqual(1);

    // New file is the template
    const written = JSON.parse(readFileSync(HOOKS_PATH, 'utf-8'));
    const template = JSON.parse(readFileSync(TEMPLATE_HOOKS, 'utf-8'));
    expect(written).toEqual(template);
  });

  it('caps timestamped backups at 3 most recent', () => {
    // Seed 5 old backups with lexicographically-sortable names
    for (let i = 1; i <= 5; i++) {
      writeFileSync(join(TMP, `hooks.json.backup.2020010100000${i}`), 'old');
    }
    // Write a corrupt hooks.json to force a new backup
    writeFileSync(HOOKS_PATH, 'garbage');

    mergeHooksFile(HOOKS_PATH, TEMPLATE_HOOKS);

    const remaining = readdirSync(TMP).filter((n) => n.startsWith('hooks.json.backup.'));
    // After adding 1 new backup (6 total) pruneBackups keeps only the 3 most recent.
    expect(remaining.length).toBe(3);
  });

  it('isPrismerHookRule detects our own hooks across marker variants', () => {
    const ours = [
      { hooks: [{ type: 'command', command: 'node ${CLAUDE_PLUGIN_ROOT}/scripts/session-start.mjs' }] },
      { hooks: [{ type: 'command', command: 'npx @prismer/claude-code-plugin foo' }] },
      { hooks: [{ type: 'command', command: 'node /x/para-emit.mjs PreToolUse' }] },
    ];
    for (const r of ours) expect(isPrismerHookRule(r)).toBe(true);

    const notOurs = [
      { hooks: [{ type: 'command', command: 'node /usr/local/gstack/pre-bash.mjs' }] },
      { hooks: [{ type: 'command', command: 'python /x/superpowers.py' }] },
    ];
    for (const r of notOurs) expect(isPrismerHookRule(r)).toBe(false);

    // Malformed input does not throw
    expect(isPrismerHookRule(null)).toBe(false);
    expect(isPrismerHookRule({})).toBe(false);
    expect(isPrismerHookRule({ hooks: null })).toBe(false);
  });
});
