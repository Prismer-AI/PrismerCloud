// S10 (2.2.9) — session-health persistence across daemon restarts.
//
// 2026-08-07: Hermes sessions turn EMPTY reply after a process-level interrupt
// (daemon OTA kill1 restart / gateway kill). The interrupted/empty-streak state
// used to live in process memory only — a daemon restart wiped the "this
// session is polluted" signal, so the next turn reused the polluted hermes
// session and came back empty. Contracts under test:
//   1. recordInterrupted / recordEmptyReply persist to a health file;
//   2. a fresh module instance (simulated daemon restart) reloads the file and
//      shouldRotate() still returns true for the interrupted key;
//   3. default EMPTY rotation threshold is 2 (spec 11 T1-3, 2026-09-22) — the
//      first empty reply does NOT rotate, the second one does. The env
//      override stays as the operator escape hatch, including the legacy 1.
//   4. NO ENV AT ALL resolves to the documented default
//      ($HOME/.prismer/hermes-session-health.json) — spec 11 T1-3b (2026-09-22).
//      The 2.2.9 default-path branch was dead code (`?? null` made the
//      `=== undefined` guard unreachable), so with no env the streak only ever
//      lived in process memory: a restart between two EMPTY replies zeroed it
//      and the polluted session was never rotated. Covered here by pointing
//      HOME at a tmp dir — the module must resolve the path itself (no env, no
//      setSessionHealthFile call), which is exactly what production does.
//
// Negative control: an empty health file yields no rotation (fresh daemon);
// a second one pairs with the default-path case — an explicit env path must
// still win and leave the default location untouched.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hermes-health-'));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

async function loadHealth(file?: string) {
  vi.resetModules();
  if (file) process.env.HERMES_SESSION_HEALTH_FILE = file;
  else delete process.env.HERMES_SESSION_HEALTH_FILE;
  return await import('../src/adapters/persistence/hermes/session-health.js');
}

/**
 * Point `$HOME` at a throwaway dir for the duration of `fn` — `os.homedir()`
 * reads it, so the module's default path resolves under the tmp dir instead of
 * the developer's real `~/.prismer`.
 */
async function withHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }
}

describe('session-health persistence (daemon restart)', () => {
  it('recordInterrupted persists; a fresh module instance (restart) still rotates', async () => {
    const file = join(tmpDir, 'health.json');
    const first = await loadHealth(file);
    first.setSessionHealthFile(file);
    first.recordInterrupted('cv_1::u_1');
    expect(existsSync(file)).toBe(true);

    // Simulated daemon restart: brand-new module instance, same health file.
    const second = await loadHealth(file);
    expect(second.shouldRotate('cv_1::u_1')).toBe(true);
  });

  it('recordEmptyReply persists the streak across restart', async () => {
    const file = join(tmpDir, 'health.json');
    const first = await loadHealth(file);
    first.setSessionHealthFile(file);
    first.recordEmptyReply('cv_2::u_2'); // 1
    first.recordEmptyReply('cv_2::u_2'); // 2

    const second = await loadHealth(file);
    expect(second.shouldRotate('cv_2::u_2')).toBe(true); // 2 >= 2 threshold
  });

  it('default path (no env): the streak lands in ~/.prismer and survives a restart', async () => {
    const home = join(tmpDir, 'home');
    await withHome(home, async () => {
      const key = 'cv_default::u_default';
      const first = await loadHealth(undefined); // no env, no setSessionHealthFile
      expect(first.shouldRotate(key)).toBe(false);
      first.recordEmptyReply(key); // 1
      first.recordEmptyReply(key); // 2

      const file = join(home, '.prismer', 'hermes-session-health.json');
      expect(existsSync(file)).toBe(true);
      expect(JSON.parse(readFileSync(file, 'utf8')).emptyStreak[key]).toBe(2);

      // Simulated daemon restart: fresh module instance, same default path.
      const second = await loadHealth(undefined);
      expect(second.shouldRotate(key)).toBe(true); // 2 >= 2 threshold
    });
  });

  it('negative control: an explicit env path wins and leaves the default location untouched', async () => {
    const home = join(tmpDir, 'home');
    await withHome(home, async () => {
      const explicit = join(tmpDir, 'explicit.json');
      const h = await loadHealth(explicit);
      h.recordInterrupted('cv_env::u_env');

      expect(existsSync(explicit)).toBe(true);
      expect(JSON.parse(readFileSync(explicit, 'utf8')).interrupted).toContain('cv_env::u_env');
      // The default-path branch must not have been taken alongside the override.
      expect(existsSync(join(home, '.prismer', 'hermes-session-health.json'))).toBe(false);
    });
  });

  it('recordSuccess clears persisted interrupted state', async () => {
    const file = join(tmpDir, 'health.json');
    const first = await loadHealth(file);
    first.setSessionHealthFile(file);
    first.recordInterrupted('cv_3::u_3');

    const second = await loadHealth(file);
    expect(second.shouldRotate('cv_3::u_3')).toBe(true);
    second.recordSuccess('cv_3::u_3');
    expect(second.shouldRotate('cv_3::u_3')).toBe(false);
  });

  it('negative control: empty/missing health file yields no rotation', async () => {
    const file = join(tmpDir, 'health.json'); // never written
    const h = await loadHealth(file);
    h.setSessionHealthFile(file);
    expect(h.shouldRotate('cv_4::u_4')).toBe(false);
  });

  it('file records the interrupted keys (auditable on disk)', async () => {
    const file = join(tmpDir, 'health.json');
    const h = await loadHealth(file);
    h.setSessionHealthFile(file);
    h.recordInterrupted('cv_5::u_5');
    const persisted = JSON.parse(readFileSync(file, 'utf8'));
    expect(persisted.interrupted).toContain('cv_5::u_5');
  });
});

describe('session-health EMPTY rotation threshold', () => {
  afterEach(() => {
    delete process.env.HERMES_SESSION_EMPTY_ROTATE_THRESHOLD;
  });

  it('default threshold is 2 — the first empty_reply does NOT rotate, the second does', async () => {
    const file = join(tmpDir, 'health.json');
    const h = await loadHealth(file);
    h.setSessionHealthFile(file);
    expect(h.emptyRotateThreshold()).toBe(2);
    h.recordEmptyReply('cv_6::u_6');
    expect(h.shouldRotate('cv_6::u_6')).toBe(false); // still under the bar
    h.recordEmptyReply('cv_6::u_6');
    expect(h.shouldRotate('cv_6::u_6')).toBe(true); // bar reached
  });

  it('env override 3 — two empty_replies are still below the bar (real threshold, not a one-turn delay)', async () => {
    process.env.HERMES_SESSION_EMPTY_ROTATE_THRESHOLD = '3';
    const h = await loadHealth(undefined);
    h.setSessionHealthFile(null);
    expect(h.emptyRotateThreshold()).toBe(3);
    h.recordEmptyReply('cv_7::u_7');
    h.recordEmptyReply('cv_7::u_7');
    expect(h.shouldRotate('cv_7::u_7')).toBe(false);
    h.recordEmptyReply('cv_7::u_7');
    expect(h.shouldRotate('cv_7::u_7')).toBe(true);
  });

  it('env override 1 restores the 2.2.9 semantics (incident escape hatch)', async () => {
    process.env.HERMES_SESSION_EMPTY_ROTATE_THRESHOLD = '1';
    const h = await loadHealth(undefined);
    h.setSessionHealthFile(null);
    h.recordEmptyReply('cv_8::u_8');
    expect(h.shouldRotate('cv_8::u_8')).toBe(true);
  });

  it('negative control: a non-numeric override falls back to the default instead of disabling rotation', async () => {
    process.env.HERMES_SESSION_EMPTY_ROTATE_THRESHOLD = 'two';
    const h = await loadHealth(undefined);
    h.setSessionHealthFile(null);
    // NaN would compare false against every streak — i.e. rotation would
    // silently never fire. The override must fail back to 2, not to "never".
    expect(h.emptyRotateThreshold()).toBe(2);
    h.recordEmptyReply('cv_9::u_9');
    expect(h.shouldRotate('cv_9::u_9')).toBe(false);
    h.recordEmptyReply('cv_9::u_9');
    expect(h.shouldRotate('cv_9::u_9')).toBe(true);
  });

  it('boundary: an override below 1 clamps to 1 (rotation can never be "always")', async () => {
    process.env.HERMES_SESSION_EMPTY_ROTATE_THRESHOLD = '0';
    const h = await loadHealth(undefined);
    h.setSessionHealthFile(null);
    expect(h.emptyRotateThreshold()).toBe(1);
  });
});
