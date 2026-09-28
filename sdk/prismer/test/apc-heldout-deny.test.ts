// apc/14 D6 (dispatch side) — held-out write-DENY handed to Claude Code
// PER RUN. docs/apc/02 §2 R4 double-constraint, dispatch half.
//
// desktop205 W4: the rules used to be read-merge-written into the per-daemon
// hermetic ~/.prismer/claude-config/settings.json. That merge was additive
// only, so one APC run permanently narrowed every other coding agent on the
// machine. The boundary is now a pure value carried on the spawn's
// `Options.settings` (== CC's `--settings` flag), and the shared settings.json
// is never touched — which is what the side-effect assertions below check.
//
// Contract/side-effect tests (CLAUDE.md 验收纪律 §1): assertions read real
// bytes off disk (the shared settings.json, the source-of-truth guard file) or
// the exact payload handed to the spawn — never a self-report. Every positive
// has a paired negative control so a test that would pass regardless of
// correctness is impossible.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  APC_HELD_OUT_PATHS,
  apcHeldOutDenyRules,
  apcHeldOutDenySettings,
  apcHeldOutSettingsArg,
  isApcHeldOutDenyEnabled,
  resolveIsolatedClaudeConfigDir,
} from '../src/adapters/coding/claude-code/config-isolation.js';

// Point HOME at a throwaway dir so the isolated config
// (~/.prismer/claude-config/.claude) lands under a temp tree and the real user
// ~/.claude / ~/.prismer is never touched.
let prevHome: string | undefined;
let prevUserProfile: string | undefined;
let tmpHome: string;

function baseEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { HOME: tmpHome, USERPROFILE: tmpHome, ...overrides } as NodeJS.ProcessEnv;
}

function sharedSettingsPath(): string {
  return path.join(resolveIsolatedClaudeConfigDir(), 'settings.json');
}

function denyFor(env: NodeJS.ProcessEnv): string[] {
  const settings = apcHeldOutDenySettings(env);
  if (settings === null) throw new Error('expected APC settings, got null');
  return settings.permissions.deny;
}

beforeEach(() => {
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  tmpHome = mkdtempSync(path.join(os.tmpdir(), 'apc-heldout-'));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
});

describe('apc held-out deny — switch gating', () => {
  it('only APC_HELDOUT_DENY=1 enables', () => {
    expect(isApcHeldOutDenyEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isApcHeldOutDenyEnabled({ APC_HELDOUT_DENY: '0' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isApcHeldOutDenyEnabled({ APC_HELDOUT_DENY: 'true' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isApcHeldOutDenyEnabled({ APC_HELDOUT_DENY: '1' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('does NOTHING for a normal (non-APC) agent — no settings carried', () => {
    // negative control: without the switch, the boundary must not exist.
    expect(apcHeldOutDenySettings(baseEnv())).toBeNull();
    expect(apcHeldOutSettingsArg(baseEnv())).toBeNull();
  });

  it('does NOTHING when isolation is off — never narrows the real ~/.claude', () => {
    // APC on but isolation off → the spawned CC reads the user's own
    // ~/.claude; silently narrowing that setup is out of scope.
    expect(
      apcHeldOutDenySettings(baseEnv({ APC_HELDOUT_DENY: '1', PRISMER_CC_NO_ISOLATION: '1' })),
    ).toBeNull();
  });
});

describe('apc held-out deny — per-run settings payload', () => {
  it('denies EVERY held-out path via Edit(path) + Edit(path/**)', () => {
    const deny = denyFor(baseEnv({ APC_HELDOUT_DENY: '1' }));
    for (const p of APC_HELD_OUT_PATHS) {
      expect(deny).toContain(`Edit(${p})`);
      expect(deny).toContain(`Edit(${p}/**)`);
    }
    // Spot-check the marquee held-out file the gate exists to protect.
    expect(deny).toContain('Edit(scripts/test203/baseline.json)');

    // desktop205 W3 — this test used to ALSO assert `Write(p)` / `Write(p/**)`
    // (and the generation test asserted `NotebookEdit(...)` / a 4-tool count).
    // Those assertions are DELETED, not relaxed: they encoded a proposition
    // Claude Code does not hold. CC 2.1.220, run against the real binary
    // (docs/desktop205/01-evidence §F1), answers a Write(path) deny rule with
    //   "Write(p) is not matched by file permission checks — only Edit(path)
    //    rules are. Use Edit(p) instead (Edit rules cover all file-editing
    //    tools)."
    // and a MultiEdit(path) rule with "matches no known tool". So `Edit(path)`
    // is the whole boundary and the deleted assertions were asserting dead
    // rules. The live proof that this is CC's actual grammar — not our reading
    // of it — is test/apc-heldout-cc-syntax.test.ts, which feeds THIS payload
    // to a real `claude` binary and fails on any rule warning.
  });

  it('does NOT deny a NON-held-out path (负控 — no over-broad write ban)', () => {
    const deny = denyFor(baseEnv({ APC_HELDOUT_DENY: '1' }));

    // Ordinary files an APC coding agent legitimately edits must NOT be denied.
    // scripts/test203/run.ts (the runner) is editable; only journeys/baseline
    // are held out.
    for (const ordinary of [
      'src/index.ts',
      'sdk/prismer/src/adapters/coding/claude-code/agent.ts',
      'scripts/test203/run.ts',
      'README.md',
    ]) {
      expect(deny).not.toContain(`Edit(${ordinary})`);
    }
    // Must not be a blanket write ban.
    expect(deny).not.toContain('Edit(**)');
    expect(deny.some((r) => /^Edit\(\*\*?\)$/.test(r))).toBe(false);
  });

  it('the `--settings` arg is exactly the JSON the SDK hands to CC', () => {
    const arg = apcHeldOutSettingsArg(baseEnv({ APC_HELDOUT_DENY: '1' }));
    expect(arg).not.toBeNull();
    // The SDK does `settings: typeof W === "object" ? JSON.stringify(W) : W`,
    // so these are the literal bytes CC parses.
    expect(JSON.parse(arg!)).toEqual({
      permissions: { deny: denyFor(baseEnv({ APC_HELDOUT_DENY: '1' })) },
    });
  });
});

describe('apc held-out deny — W4: the shared settings.json is never written', () => {
  // The regression this replaces: `ensureApcHeldOutDeny` merged the rules into
  // the per-daemon ~/.prismer/claude-config/.claude/settings.json with
  // `new Set([...existing, ...rules])` — additive only. One APC run therefore
  // left the deny list behind for every later coding agent on the machine.
  it('computing the payload creates NO file under the hermetic config dir', () => {
    expect(existsSync(sharedSettingsPath())).toBe(false); // pre-condition
    apcHeldOutDenySettings(baseEnv({ APC_HELDOUT_DENY: '1' }));
    apcHeldOutSettingsArg(baseEnv({ APC_HELDOUT_DENY: '1' }));
    expect(existsSync(sharedSettingsPath())).toBe(false);
  });

  it('leaves a pre-existing hermetic settings.json byte-identical (负控)', () => {
    // Negative control for the assertion above: if the function still wrote to
    // the shared file, THIS comparison — not just an existsSync — would catch
    // it, including the additive-merge form that preserves unrelated keys.
    const settingsPath = sharedSettingsPath();
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    const before = `${JSON.stringify({ model: 'sonnet', permissions: { deny: ['Bash(rm -rf /)'] } }, null, 2)}\n`;
    writeFileSync(settingsPath, before);

    apcHeldOutDenySettings(baseEnv({ APC_HELDOUT_DENY: '1' }));
    apcHeldOutSettingsArg(baseEnv({ APC_HELDOUT_DENY: '1' }));

    expect(readFileSync(settingsPath, 'utf8')).toBe(before);
  });
});

describe('apc held-out deny — rule generation is derived, not hand-written', () => {
  it('derives exactly 2 Edit matchers per path, nothing else', () => {
    const rules = apcHeldOutDenyRules(['a/b', 'c.json']);
    // desktop205 W3: 1 tool (Edit) × 2 matchers × 2 paths = 4. Was 16 across
    // Write/Edit/MultiEdit/NotebookEdit; the other three are not matched by
    // CC's file permission check (see the comment in the payload suite above),
    // so the count assertion now also guards against re-adding dead rules.
    expect(rules).toHaveLength(4);
    expect(rules).toContain('Edit(a/b)');
    expect(rules).toContain('Edit(a/b/**)');
    expect(rules).toContain('Edit(c.json)');
    expect(rules.every((r) => r.startsWith('Edit('))).toBe(true);
    // Mutation guard: a changed path list changes the rules (not 各写各的).
    expect(apcHeldOutDenyRules(['x'])).toContain('Edit(x)');
    expect(apcHeldOutDenyRules(['x'])).not.toContain('Edit(a/b)');
  });
});

describe('apc held-out deny — SINGLE SOURCE OF TRUTH drift guard', () => {
  // The runtime package roots at ./src and cannot import
  // scripts/test203/heldout-guard.ts (outside rootDir → tsc breaks), so the
  // list is MIRRORED. This test reads the real source file off disk and fails
  // if the mirror drifts — proving the two enforcement halves cannot diverge.
  it('APC_HELD_OUT_PATHS equals heldout-guard.ts::HELD_OUT_PATHS (set equality)', () => {
    // Walk up from the runtime package cwd to the repo root (marked by the
    // guard file itself).
    let dir = process.cwd();
    let guardSrc = '';
    for (let i = 0; i < 12; i++) {
      const candidate = path.join(dir, 'scripts', 'test203', 'heldout-guard.ts');
      try {
        guardSrc = readFileSync(candidate, 'utf8');
        break;
      } catch {
        dir = path.dirname(dir);
      }
    }
    expect(guardSrc, 'could not locate scripts/test203/heldout-guard.ts').not.toBe('');

    const block = guardSrc.match(/HELD_OUT_PATHS\s*=\s*\[([\s\S]*?)\]/);
    expect(block, 'HELD_OUT_PATHS array not found in source of truth').not.toBeNull();
    // Strip `//` line comments first — the source annotates entries with
    // comments that themselves contain quoted phrases we must not capture.
    const body = block![1]!
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    const sourcePaths = [...body.matchAll(/['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);

    expect([...sourcePaths].sort()).toEqual([...APC_HELD_OUT_PATHS].sort());
  });
});
