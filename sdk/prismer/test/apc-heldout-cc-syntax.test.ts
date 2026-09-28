// desktop205 G1 — Claude Code permission-rule SYNTAX gate.
//
// Why this exists: the sibling drift-guard (apc-heldout-deny.test.ts) only
// compares our held-out PATH list against scripts/test203/heldout-guard.ts. It
// says nothing about whether Claude Code still understands the RULE GRAMMAR we
// emit. CC 2.1.220 silently stopped honoring `Write(path)` / `NotebookEdit(path)`
// in file permission checks and dropped `MultiEdit` entirely — we only found
// out by running the binary by hand. This gate turns "a CC upgrade quietly
// voided our deny rules" into a red test.
//
// Oracle (CLAUDE.md 验收纪律 §1): the STDERR of a real `claude` process. Not a
// log line we wrote, not a self-report.
//
// No LLM call, no credentials, no network: CC validates permission rules while
// loading settings, which happens BEFORE authentication. With a throwaway HOME
// and no API key in the env, CC reaches the auth check, prints "Not logged in"
// and exits (~1s). Liveness is asserted per run (process really exited + it
// really produced output), so an empty stderr can never mean "CC never ran".
//
// 负控 (验收纪律 §2): the same harness, same payload plus one `MultiEdit(path)`
// rule, MUST produce a warning. A green positive alone proves nothing.

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  apcHeldOutDenyRules,
  apcHeldOutSettingsArg,
} from '../src/adapters/coding/claude-code/config-isolation.js';

const CLAUDE_BIN = process.env.PRISMER_CC_SYNTAX_CLAUDE_BIN ?? 'claude';
const RUN_TIMEOUT_MS = 45_000;

/** Repo root, located by the file the held-out list mirrors. */
function repoRoot(): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 12; i++) {
    try {
      readFileSync(path.join(dir, 'scripts', 'test203', 'heldout-guard.ts'), 'utf8');
      return dir;
    } catch {
      dir = path.dirname(dir);
    }
  }
  return null;
}

/**
 * Detect a usable `claude`. Returns its version, or null when the binary is
 * absent/unusable — in which case an evidence file is written and the tests
 * skip LOUDLY (the desktop-shell smoke's exit-77 pattern, adapted to vitest).
 * Never silently pass.
 */
function detectClaude(): { version: string } | null {
  const probe = spawnSync(CLAUDE_BIN, ['--version'], { encoding: 'utf8', timeout: 20_000 });
  if (probe.error || probe.status !== 0) {
    const reason = probe.error
      ? `${probe.error.message}`
      : `exit=${probe.status} stderr=${(probe.stderr ?? '').trim()}`;
    const root = repoRoot();
    const detail =
      `desktop205 G1 SKIPPED: no usable Claude Code binary (${CLAUDE_BIN}).\n` +
      `reason: ${reason}\n` +
      `The permission-rule syntax of the APC held-out deny payload was NOT verified.\n` +
      `Install it (npm i -g @anthropic-ai/claude-code) or set PRISMER_CC_SYNTAX_CLAUDE_BIN.\n`;
    if (root) {
      const dir = path.join(root, 'scripts', 'test203', 'artifacts');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'apc-cc-syntax-skip-evidence.txt'), detail);
    }
    console.warn(detail);
    return null;
  }
  return { version: (probe.stdout ?? '').trim() };
}

const claude = detectClaude();

interface ClaudeRun {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Permission-rule complaints CC printed while loading the settings. */
  ruleWarnings: string[];
}

/**
 * Run CC once with `settingsJson` as its `--settings` payload — the same flag
 * the Agent SDK fills from `Options.settings`, so this is the literal thing our
 * dispatch ships.
 *
 * The env is BUILT, not inherited: a throwaway HOME and no ANTHROPIC_* keys, so
 * the run is hermetic and cannot accidentally reach a real API with a
 * developer's or CI's credentials. `--setting-sources ''` keeps user/project
 * settings out, so every warning observed is attributable to our payload.
 */
async function runClaudeWithSettings(settingsJson: string): Promise<ClaudeRun> {
  const home = mkdtempSync(path.join(os.tmpdir(), 'apc-cc-syntax-'));
  const child = spawn(CLAUDE_BIN, ['ping', '--settings', settingsJson, '--setting-sources', ''], {
    cwd: home,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH ?? '', HOME: home, TMPDIR: os.tmpdir() },
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      const kill = setTimeout(() => child.kill('SIGKILL'), RUN_TIMEOUT_MS);
      child.on('exit', (code, signal) => {
        clearTimeout(kill);
        resolve({ code, signal });
      });
    },
  );

  return {
    stdout,
    stderr,
    exitCode: result.code,
    signal: result.signal,
    ruleWarnings: stderr
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^Permission (deny|allow|ask) rule\b/.test(l)),
  };
}

/**
 * Per-run liveness: CC must have exited on its own AND produced output. Without
 * this, "zero rule warnings" would also be the reading for "CC never started",
 * i.e. the positive control would be an open-book exam.
 */
function expectReachedSettingsValidation(run: ClaudeRun, label: string): void {
  expect(run.signal, `${label}: CC was killed, not exited — harness/timeout problem`).toBeNull();
  expect(
    run.stdout.trim().length,
    `${label}: CC produced no stdout — it never got past startup. stderr=${run.stderr}`,
  ).toBeGreaterThan(0);
  expect(run.stderr, `${label}: CC rejected the flags themselves`).not.toContain(
    'unknown option',
  );
}

describe('desktop205 G1 — CC accepts the APC held-out deny rule grammar', () => {
  it.skipIf(!claude)(
    '正控: the shipped --settings payload draws ZERO permission-rule warnings',
    async () => {
      const payload = apcHeldOutSettingsArg({ APC_HELDOUT_DENY: '1' } as NodeJS.ProcessEnv);
      expect(payload, 'APC payload must exist when the switch is on').not.toBeNull();

      const run = await runClaudeWithSettings(payload!);
      expectReachedSettingsValidation(run, '正控');

      expect(
        run.ruleWarnings,
        `claude ${claude?.version} rejected rules we ship:\n${run.ruleWarnings.join('\n')}`,
      ).toEqual([]);
    },
    60_000,
  );

  it.skipIf(!claude)(
    '负控: one MultiEdit(path) rule DOES draw a warning — the gate can fail',
    async () => {
      // Same payload, same harness, one rule of a kind CC no longer knows. If
      // this comes back clean the gate is decorative and the 正控 above proves
      // nothing.
      const deny = [...apcHeldOutDenyRules(), 'MultiEdit(scripts/test203/baseline.json)'];
      const run = await runClaudeWithSettings(JSON.stringify({ permissions: { deny } }));
      expectReachedSettingsValidation(run, '负控');

      expect(run.ruleWarnings.length, `stderr was:\n${run.stderr}`).toBeGreaterThan(0);
      expect(run.stderr).toContain('MultiEdit(scripts/test203/baseline.json)');
    },
    60_000,
  );
});
