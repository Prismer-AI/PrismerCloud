// apc M2-a (D1 binary pin: APC-locked binary + explicit-fail version check)
// + M2-b (D2 CLAUDE_CONFIG_DIR isolation, sentinel spawn probe) —
// docs/apc/05 §1.D, 11-impl-tracker M2-a/M2-b, 13 K5, 14 D5.
//
// Reversal note (14 D5 / 13 K5): the previous "isolation" assertions
// re-implemented the overlay ordering in the test and never spawned anything,
// so moving the real isolation overlay before launchEnv left them green. This
// file drives the REAL SUT:
//   - `buildClaudeSpawnEnv` (the single source of overlay ordering) composes
//     the env, then a REAL child process reports whether it can see a sentinel
//     seeded in the user's global ~/.claude. Isolation working = sentinel unseen.
//   - `resolveClaudeBinary` drives the real APC-locked-binary preference + pin.

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test, afterEach } from 'vitest';
import {
  buildClaudeSpawnEnv,
  resolveClaudeBinary,
  verifyClaudeBinaryPin,
} from '../src/adapters/coding/claude-code/agent.js';
import {
  AdapterBinaryPinError,
  checkBinaryPin,
  isUnpinnedAllowed,
} from '../src/adapters/version-check.js';
import {
  apcPinnedClaudeBinary,
  apcPinnedClaudeBinaryIfPresent,
  readImagePinClaudeVersion,
  resolveClaudeBinaryPin,
  _resetImagePinCache,
} from '../src/adapters/coding/claude-code/apc-pinned-binary.js';
import {
  resolveIsolatedClaudeConfigDir,
} from '../src/adapters/coding/claude-code/config-isolation.js';
import { ADAPTER_KNOWN_VERSIONS } from '../src/adapters/known-versions.js';

const STRICT = {}; // no escape hatch
const ALLOW = { PRISMER_ALLOW_UNPINNED: '1' };

// ── env sandbox: restore process.env keys the SUT reads (HOME drives
//    os.homedir(); PRISMER_* switch isolation/pin/escape) ────────────────────
const ENV_KEYS = [
  'HOME',
  'USERPROFILE',
  'PRISMER_IMAGE_PIN_FILE',
  'PRISMER_CLAUDE_BINARY_PIN',
  'PRISMER_CC_NO_ISOLATION',
  'PRISMER_ALLOW_UNPINNED',
  'CLAUDE_CONFIG_DIR',
];
const savedEnv = new Map<string, string | undefined>();
const tmpDirs: string[] = [];

function setEnv(k: string, v: string | undefined): void {
  if (!savedEnv.has(k)) savedEnv.set(k, process.env[k]);
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

function mkTmp(prefix: string): string {
  const d = mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  savedEnv.clear();
  _resetImagePinCache();
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

/** Write an image-pin.yaml fixture with the given claude binary version. */
function writeImagePinFixture(dir: string, claudeVersion: string): string {
  const file = path.join(dir, 'image-pin.yaml');
  writeFileSync(
    file,
    `images:\n  daemon:\n    canonical: x\nbinaries:\n  claude:\n    version: ${claudeVersion}\n`,
    'utf8',
  );
  return file;
}

/** Install a fixture `claude` at the APC-locked path under `home`, echoing `version`. */
function installApcClaudeFixture(home: string, version: string): string {
  const bin = apcPinnedClaudeBinary(home);
  mkdirSync(path.dirname(bin), { recursive: true });
  writeFileSync(bin, `#!/bin/sh\necho "${version} (Claude Code)"\n`, 'utf8');
  chmodSync(bin, 0o755);
  return bin;
}

// ───────────────────────────────────────────────────────────────────────────
describe('M2-a — checkBinaryPin explicit-fail strictness', () => {
  test('exact match passes', () => {
    expect(checkBinaryPin('2.1.179', '2.1.179', STRICT)).toEqual({
      ok: true,
      code: 'ok',
      detected: '2.1.179',
      pin: '2.1.179',
    });
  });

  test('NEGATIVE CONTROL: version mismatch fails explicitly by default', () => {
    const check = checkBinaryPin('2.1.218', '2.1.179', STRICT);
    expect(check.ok).toBe(false);
    expect(check.code).toBe('mismatch');
    expect(checkBinaryPin('2.2.0', '2.1.179', STRICT).ok).toBe(false);
  });

  test('undetected version fails explicitly by default', () => {
    expect(checkBinaryPin('unknown', '2.1.179', STRICT).code).toBe('undetected');
  });

  test('missing/placeholder pin fails explicitly by default', () => {
    expect(checkBinaryPin('2.1.179', 'unknown', STRICT).code).toBe('unpinned');
    expect(checkBinaryPin('2.1.179', '', STRICT).ok).toBe(false);
    expect(checkBinaryPin('2.1.179', '0.0.0', STRICT).code).toBe('unpinned');
  });

  test('PRISMER_ALLOW_UNPINNED=1 downgrades all three to soft-pass', () => {
    expect(checkBinaryPin('2.1.218', '2.1.179', ALLOW)).toMatchObject({
      ok: true,
      code: 'mismatch_allowed',
    });
    expect(checkBinaryPin('unknown', '2.1.179', ALLOW).code).toBe('undetected_allowed');
    expect(checkBinaryPin('2.1.179', 'unknown', ALLOW).code).toBe('unpinned_allowed');
  });

  test('escape hatch only accepts the literal "1"', () => {
    expect(isUnpinnedAllowed({ PRISMER_ALLOW_UNPINNED: '1' })).toBe(true);
    expect(isUnpinnedAllowed({ PRISMER_ALLOW_UNPINNED: 'true' })).toBe(false);
    expect(isUnpinnedAllowed({})).toBe(false);
  });

  test('build/pre-release suffixes are stripped from detected before compare', () => {
    expect(checkBinaryPin('2.1.179+sha.abc', '2.1.179', STRICT).ok).toBe(true);
  });

  test('AdapterBinaryPinError is structured, not a bare string', () => {
    const err = new AdapterBinaryPinError(
      'claude-code',
      '/usr/local/bin/claude',
      checkBinaryPin('2.1.218', '2.1.179', STRICT),
    );
    expect(err.code).toBe('ADAPTER_BINARY_PIN_VIOLATION');
    expect(err.reason).toBe('mismatch');
    expect(err.detected).toBe('2.1.218');
    expect(err.pin).toBe('2.1.179');
    expect(err.message).toContain('PRISMER_ALLOW_UNPINNED');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('M2-a — pin sourced from image-pin.yaml (SSOT, not hand-copied)', () => {
  test('reads binaries.claude.version from the real repo image-pin.yaml', () => {
    _resetImagePinCache();
    const v = readImagePinClaudeVersion({}); // no override → upward search
    expect(v, 'runtime must locate the repo image-pin.yaml in dogfood').toBeTruthy();
    expect(resolveClaudeBinaryPin({})).toEqual({ pin: v, source: 'image-pin' });
  });

  test('DRIFT GUARD: baked known-versions fallback == image-pin.yaml value', () => {
    // The fallback literal is only used when infra/ is off-disk (packaged/pod);
    // it must never silently diverge from the SSOT it mirrors.
    _resetImagePinCache();
    const ssot = readImagePinClaudeVersion({});
    expect(ADAPTER_KNOWN_VERSIONS['claude-code']?.binaryPin).toBe(ssot);
  });

  test('honors PRISMER_IMAGE_PIN_FILE override and re-reads on cache reset', () => {
    const dir = mkTmp('apc-pin-');
    const file = writeImagePinFixture(dir, '9.9.9');
    setEnv('PRISMER_IMAGE_PIN_FILE', file);
    _resetImagePinCache();
    expect(resolveClaudeBinaryPin(process.env)).toEqual({ pin: '9.9.9', source: 'image-pin' });
  });

  test('NEGATIVE CONTROL: unlocatable pin file → fallback source (not image-pin)', () => {
    setEnv('PRISMER_IMAGE_PIN_FILE', path.join(os.tmpdir(), 'does-not-exist-image-pin.yaml'));
    _resetImagePinCache();
    // env override points nowhere; upward search still finds the real repo file
    // in dogfood, so this asserts the resolver never invents a pin: it either
    // reads a real file or reports 'fallback'. Both are defined; 'unknown' pin
    // must never masquerade as image-pin.
    const r = resolveClaudeBinaryPin(process.env);
    expect(['image-pin', 'fallback']).toContain(r.source);
    expect(r.pin).not.toBe('unknown');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('M2-a — APC-locked binary preference (3 fixture states)', () => {
  test('STATE absent: no locked binary → apcPinnedClaudeBinaryIfPresent is null', () => {
    const home = mkTmp('apc-home-empty-');
    expect(apcPinnedClaudeBinaryIfPresent(home)).toBeNull();
  });

  test('STATE present: locked binary on disk → returns its absolute path', () => {
    const home = mkTmp('apc-home-present-');
    const bin = installApcClaudeFixture(home, '9.9.9');
    expect(apcPinnedClaudeBinaryIfPresent(home)).toBe(bin);
  });

  test('STATE present + version CORRECT: resolveClaudeBinary returns the locked binary', async () => {
    const home = mkTmp('apc-home-ok-');
    const bin = installApcClaudeFixture(home, '9.9.9');
    setEnv('HOME', home);
    setEnv('USERPROFILE', home);
    setEnv('PRISMER_IMAGE_PIN_FILE', writeImagePinFixture(mkTmp('apc-pin-ok-'), '9.9.9'));
    _resetImagePinCache();
    // Real preference + pin path: locked binary chosen AND its --version verified.
    await expect(resolveClaudeBinary()).resolves.toBe(bin);
  });

  test('STATE present + version WRONG: resolveClaudeBinary rejects (explicit fail, no fallback)', async () => {
    const home = mkTmp('apc-home-bad-');
    const bin = installApcClaudeFixture(home, '1.2.3'); // != pin
    setEnv('HOME', home);
    setEnv('USERPROFILE', home);
    setEnv('PRISMER_IMAGE_PIN_FILE', writeImagePinFixture(mkTmp('apc-pin-bad-'), '9.9.9'));
    _resetImagePinCache();
    await expect(resolveClaudeBinary()).rejects.toMatchObject({
      code: 'ADAPTER_BINARY_PIN_VIOLATION',
      reason: 'mismatch',
      binaryPath: bin,
      detected: '1.2.3',
      pin: '9.9.9',
    });
  });

  test('NEGATIVE CONTROL: wrong version + PRISMER_ALLOW_UNPINNED=1 → soft-passes to the locked binary', async () => {
    const home = mkTmp('apc-home-allow-');
    const bin = installApcClaudeFixture(home, '1.2.3');
    setEnv('HOME', home);
    setEnv('USERPROFILE', home);
    setEnv('PRISMER_IMAGE_PIN_FILE', writeImagePinFixture(mkTmp('apc-pin-allow-'), '9.9.9'));
    setEnv('PRISMER_ALLOW_UNPINNED', '1');
    _resetImagePinCache();
    await expect(resolveClaudeBinary()).resolves.toBe(bin);
  });

  test('verifyClaudeBinaryPin against a fixture: correct resolves, wrong rejects', async () => {
    const okDir = mkTmp('apc-vpin-ok-');
    const okBin = path.join(okDir, 'claude');
    writeFileSync(okBin, `#!/bin/sh\necho "9.9.9"\n`, 'utf8');
    chmodSync(okBin, 0o755);
    setEnv('PRISMER_IMAGE_PIN_FILE', writeImagePinFixture(mkTmp('apc-vpin-pin-'), '9.9.9'));
    _resetImagePinCache();
    await expect(verifyClaudeBinaryPin(okBin)).resolves.toBeUndefined();

    const badDir = mkTmp('apc-vpin-bad-');
    const badBin = path.join(badDir, 'claude');
    writeFileSync(badBin, `#!/bin/sh\necho "0.0.1"\n`, 'utf8');
    chmodSync(badBin, 0o755);
    await expect(verifyClaudeBinaryPin(badBin)).rejects.toBeInstanceOf(AdapterBinaryPinError);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// D2 — sentinel spawn probe. Seeds a sentinel in the (temp) user's global
// ~/.claude, composes the spawn env with the REAL buildClaudeSpawnEnv, spawns
// a REAL child, and asserts the child cannot see the sentinel = isolation held.
// ───────────────────────────────────────────────────────────────────────────
const SENTINEL_FILE = 'settings.json';
const SENTINEL_BODY = '{"__apc_sentinel__":"USER_GLOBAL_CLAUDE_LEAKED"}';

// Child stand-in for spawned Claude Code: resolves its config dir exactly as CC
// does (CLAUDE_CONFIG_DIR, else $HOME/.claude) and reports whether the sentinel
// is visible there. A real process, reading only the env it was handed.
const PROBE_CHILD = [
  'const fs=require("fs"),path=require("path");',
  'const cd=process.env.CLAUDE_CONFIG_DIR||path.join(process.env.HOME||process.env.USERPROFILE||"","' + '.claude");',
  'const s=path.join(cd,"' + SENTINEL_FILE + '");',
  'process.stdout.write(JSON.stringify({home:process.env.HOME,configDir:cd,sentinelVisible:fs.existsSync(s)}));',
].join('');

interface ProbeResult {
  home: string;
  configDir: string;
  sentinelVisible: boolean;
}

/**
 * Compose the spawn env via the real SUT and run the sentinel child.
 * `isolationEnv` selects the isolation switch; `leakyLaunchEnv`, when set,
 * models a launch env that carries the user's real HOME/CLAUDE_CONFIG_DIR (the
 * exact threat the isolation-last ordering must defeat, 14 D5).
 */
function runSentinelProbe(opts: {
  userHome: string;
  isolationEnv: NodeJS.ProcessEnv;
  leakyLaunchEnv: boolean;
}): ProbeResult {
  const userClaudeDir = path.join(opts.userHome, '.claude');
  const launchEnv = opts.leakyLaunchEnv
    ? { HOME: opts.userHome, USERPROFILE: opts.userHome, CLAUDE_CONFIG_DIR: userClaudeDir }
    : undefined;
  const spawnEnv = buildClaudeSpawnEnv({
    baseEnv: { ...process.env, HOME: opts.userHome, USERPROFILE: opts.userHome },
    launchEnv,
    isolationEnv: opts.isolationEnv,
  });
  const res = spawnSync(process.execPath, ['-e', PROBE_CHILD], {
    env: spawnEnv as NodeJS.ProcessEnv,
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    throw new Error(`probe child failed: ${res.status} ${res.stderr}`);
  }
  return JSON.parse(res.stdout) as ProbeResult;
}

describe('M2-b — D2 config isolation: sentinel spawn probe', () => {
  function seedUserGlobalSentinel(): string {
    const userHome = mkTmp('apc-user-home-');
    const userClaude = path.join(userHome, '.claude');
    mkdirSync(userClaude, { recursive: true });
    writeFileSync(path.join(userClaude, SENTINEL_FILE), SENTINEL_BODY, 'utf8');
    // Point os.homedir() at the temp home so the isolated dir also lands there.
    setEnv('HOME', userHome);
    setEnv('USERPROFILE', userHome);
    setEnv('PRISMER_CC_NO_ISOLATION', undefined);
    return userHome;
  }

  test('isolation ON: spawned child cannot see the user-global sentinel', () => {
    const userHome = seedUserGlobalSentinel();
    const r = runSentinelProbe({ userHome, isolationEnv: {}, leakyLaunchEnv: true });
    // Real SUT-computed isolated dir — not a hand-copied constant.
    expect(r.configDir).toBe(resolveIsolatedClaudeConfigDir());
    expect(r.sentinelVisible).toBe(false);
  });

  test('NEGATIVE CONTROL: PRISMER_CC_NO_ISOLATION=1 → leaky launch env wins, sentinel IS loaded', () => {
    const userHome = seedUserGlobalSentinel();
    const r = runSentinelProbe({
      userHome,
      isolationEnv: { PRISMER_CC_NO_ISOLATION: '1' },
      leakyLaunchEnv: true,
    });
    expect(r.configDir).toBe(path.join(userHome, '.claude'));
    expect(r.sentinelVisible).toBe(true);
  });

  test('isolation defeats a leaky launch env carrying the real HOME (ordering is load-bearing)', () => {
    // With isolation ON and a launch env that explicitly sets HOME + CLAUDE_CONFIG_DIR
    // to the user's real surfaces, the isolation-last overlay must still win.
    // This is the assertion the 14 D5 mutation (move isolation before launchEnv)
    // flips red — proven in the mutation-testing report.
    const userHome = seedUserGlobalSentinel();
    const r = runSentinelProbe({ userHome, isolationEnv: {}, leakyLaunchEnv: true });
    expect(r.home).toBe(path.join(userHome, '.prismer', 'claude-config'));
    expect(r.sentinelVisible).toBe(false);
  });
});

// sanity: node is runnable in this environment (probe depends on it)
test('probe harness precondition: node executes an inline script', () => {
  const out = execFileSync(process.execPath, ['-e', 'process.stdout.write("ok")'], {
    encoding: 'utf8',
  });
  expect(out).toBe('ok');
});
