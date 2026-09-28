// desktop205 W4 migration — prune the deny rules the PRE-W4 code left on disk.
//
// W4 stopped NEW pollution (rules now ride the spawn's `Options.settings`), but
// the code it replaced did a read-merge-write into the per-daemon hermetic
// ~/.prismer/claude-config/.claude/settings.json with
// `new Set([...existing, ...rules])` — additive, with no removal path. On every
// machine that ever ran one APC run those rules are STILL THERE, narrowing every
// coding agent, and they will never leave on their own.
//
// ORACLE — the bytes of settings.json after the fact. No log lines, no return
// values standing in for the file.
//
// THE LOAD-BEARING NEGATIVE CONTROL is `preserves the user's own deny rules`:
// this migration deletes entries out of a user's config file. A prune that is
// even slightly too eager silently removes protections the user wrote by hand.
// So the removal set is exact string equality against the rules the old code
// could have generated — never a prefix/pattern match — and the test pins that
// with rules that LOOK like ours but are not.
//
// Fixtures are built in a temp dir. The real ~/.prismer is never read or written.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  APC_HELD_OUT_PATHS,
  ensureClaudeConfigIsolation,
  pruneApcHeldOutDenyFromSettings,
  resolveIsolatedClaudeConfigDir,
} from '../src/adapters/coding/claude-code/config-isolation.js';

let tmp: string;
let configDir: string;
let settingsPath: string;

/** Exactly what the pre-W4 writer emitted: 4 tool spellings × 2 matchers × path. */
function legacyRulesFor(p: string): string[] {
  return ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].flatMap((t) => [`${t}(${p})`, `${t}(${p}/**)`]);
}

function writeSettings(value: unknown): void {
  writeFileSync(settingsPath, `${JSON.stringify(value, null, 2)}\n`);
}

function readSettings(): any {
  return JSON.parse(readFileSync(settingsPath, 'utf8'));
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'apc-prune-'));
  configDir = path.join(tmp, '.claude');
  mkdirSync(configDir, { recursive: true });
  settingsPath = path.join(configDir, 'settings.json');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('W4 migration — prunes exactly the rules the old writer produced', () => {
  it('正控: a settings.json polluted by the pre-W4 writer comes back clean', () => {
    // The real shape: every held-out path × every legacy tool spelling, merged
    // into a file that also has the user's own model choice and deny rule.
    const polluted = APC_HELD_OUT_PATHS.flatMap(legacyRulesFor);
    expect(polluted.length).toBe(APC_HELD_OUT_PATHS.length * 8); // 9 × 8 = 72
    writeSettings({
      model: 'sonnet',
      permissions: { allow: ['Bash(git status)'], deny: ['Bash(rm -rf /)', ...polluted] },
    });

    const result = pruneApcHeldOutDenyFromSettings(configDir);

    expect(result.status).toBe('pruned');
    const after = readSettings();
    // The oracle: the file's own bytes.
    expect(after.permissions.deny).toEqual(['Bash(rm -rf /)']);
    // Everything else is untouched — the prune is not a rewrite.
    expect(after.model).toBe('sonnet');
    expect(after.permissions.allow).toEqual(['Bash(git status)']);
  });

  it('负控 (THE important one): the user’s own deny rules survive, including look-alikes', () => {
    // These are the rules a prune that matched on shape rather than identity
    // would eat. `Edit(scripts/test203/run.ts)` is one character-class away from
    // a held-out rule; `Edit(scripts/test203)` is a PREFIX of held-out paths.
    const mine = [
      'Edit(src/secret.ts)',
      'Edit(scripts/test203/run.ts)', // the runner IS editable — not held out
      'Edit(scripts/test203)', // a prefix of four held-out paths
      'Edit(scripts/test203/baseline.json.bak)', // superstring of a held-out rule
      'Edit(scripts/test203/journeys/j11-community-follow.ts)', // INSIDE a held-out dir
      'Write(src/secret.ts)',
      'Bash(curl:*)',
      'Read(~/.ssh/**)',
    ];
    writeSettings({
      permissions: { deny: [...mine, ...legacyRulesFor('scripts/test203/baseline.json')] },
    });

    pruneApcHeldOutDenyFromSettings(configDir);

    // Byte-for-byte, in the original order. Not a set comparison — the prune
    // must not reorder a user's file either.
    expect(readSettings().permissions.deny).toEqual(mine);
  });

  it('drops the `deny` key when nothing but our debris was in it', () => {
    writeSettings({ model: 'opus', permissions: { deny: legacyRulesFor('scripts/contract-tests') } });

    pruneApcHeldOutDenyFromSettings(configDir);

    const after = readSettings();
    expect('deny' in after.permissions).toBe(false);
    // …and nothing else moves — `permissions` itself stays, `model` stays.
    expect(after).toEqual({ model: 'opus', permissions: {} });
  });

  it('is idempotent — the second run is a no-op and does not rewrite the file', () => {
    writeSettings({ permissions: { deny: ['Edit(src/x.ts)', ...legacyRulesFor('scripts/product205')] } });

    expect(pruneApcHeldOutDenyFromSettings(configDir).status).toBe('pruned');
    const afterFirst = readFileSync(settingsPath, 'utf8');
    expect(pruneApcHeldOutDenyFromSettings(configDir).status).toBe('unchanged');
    expect(readFileSync(settingsPath, 'utf8')).toBe(afterFirst);
  });

  it('a clean settings.json is left byte-identical (no gratuitous reformat)', () => {
    const before = '{"model":"sonnet","permissions":{"deny":["Bash(rm -rf /)"]}}';
    writeFileSync(settingsPath, before);

    expect(pruneApcHeldOutDenyFromSettings(configDir).status).toBe('unchanged');
    expect(readFileSync(settingsPath, 'utf8')).toBe(before);
  });
});

describe('W4 migration — failure can never cost a dispatch', () => {
  it('absent settings.json → reported, not thrown, and no file is created', () => {
    expect(pruneApcHeldOutDenyFromSettings(configDir).status).toBe('absent');
    expect(existsSync(settingsPath)).toBe(false);
  });

  it('malformed JSON is left exactly as-is (never rewrite what we cannot parse)', () => {
    const garbage = '{ this is not json';
    writeFileSync(settingsPath, garbage);

    expect(pruneApcHeldOutDenyFromSettings(configDir).status).toBe('absent');
    expect(readFileSync(settingsPath, 'utf8')).toBe(garbage);
  });

  it('a non-array `permissions.deny` is left alone', () => {
    writeSettings({ permissions: { deny: 'Edit(x)' } });

    expect(pruneApcHeldOutDenyFromSettings(configDir).status).toBe('unchanged');
    expect(readSettings().permissions.deny).toBe('Edit(x)');
  });
});

// ── the wiring: the migration must actually RUN on the dispatch path ─────────
// A prune nobody calls is dead code. The landing site is
// ensureClaudeConfigIsolation() — the function buildSdkEnv calls before every
// Claude Code spawn, already once-per-daemon-process cached.
describe('W4 migration — landing site', () => {
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;
  let home: string;

  beforeEach(() => {
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    home = mkdtempSync(path.join(os.tmpdir(), 'apc-prune-home-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    rmSync(home, { recursive: true, force: true });
  });

  it('ensureClaudeConfigIsolation prunes the hermetic settings.json it owns', () => {
    const isolated = resolveIsolatedClaudeConfigDir();
    mkdirSync(isolated, { recursive: true });
    const file = path.join(isolated, 'settings.json');
    writeFileSync(
      file,
      `${JSON.stringify({ permissions: { deny: ['Edit(mine)', ...legacyRulesFor('scripts/test203/artifacts')] } }, null, 2)}\n`,
    );

    ensureClaudeConfigIsolation({ HOME: home, USERPROFILE: home } as NodeJS.ProcessEnv);

    // Side effect on disk — the polluted rules are gone, the user's is not.
    expect(JSON.parse(readFileSync(file, 'utf8')).permissions.deny).toEqual(['Edit(mine)']);
  });

  it('负控: with isolation OFF the user’s real ~/.claude is never touched', () => {
    // PRISMER_CC_NO_ISOLATION=1 means the spawned CC reads the user's own
    // config. Reaching into that file — even to clean up our own mess — is out
    // of scope; we never wrote there in the first place.
    const isolated = resolveIsolatedClaudeConfigDir();
    mkdirSync(isolated, { recursive: true });
    const file = path.join(isolated, 'settings.json');
    const before = `${JSON.stringify({ permissions: { deny: legacyRulesFor('scripts/product205') } }, null, 2)}\n`;
    writeFileSync(file, before);

    const overlay = ensureClaudeConfigIsolation({
      HOME: home,
      USERPROFILE: home,
      PRISMER_CC_NO_ISOLATION: '1',
    } as NodeJS.ProcessEnv);

    expect(overlay).toBeUndefined();
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
});
