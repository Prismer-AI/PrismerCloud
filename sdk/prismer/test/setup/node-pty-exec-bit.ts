/**
 * node-pty-exec-bit.ts — vitest setup: darwin spawn-helper exec-bit workaround.
 *
 * node-pty@1.1.0's npm tarball ships `prebuilds/<platform>/spawn-helper` WITHOUT
 * the execute bit (upstream microsoft/node-pty#850, unfixed at this version), so
 * the first PTY spawn dies with "posix_spawnp failed". G2-R R-2 PoC reproduced
 * this on darwin-arm64 and confirmed a plain `chmod +x` fixes it.
 *
 * Best-effort and darwin-only: a missing or unfixable helper must never fail
 * the suite HERE — the real spawn surfaces the failure (never fake success).
 *
 * Second concern (spec 11 T1-3b, 2026-09-22) — session-health isolation.
 * `session-health.ts` resolves its persistence path at import time and writes
 * on every record / clearRotationState call. With `HERMES_SESSION_HEALTH_FILE`
 * unset that path is the REAL `~/.prismer/hermes-session-health.json` — the file
 * the resident sandbox manager consumes (docs/product209/09). So every test file
 * that imports the hermes dispatcher (7 of 10 do, measured) would write its
 * fixtures into the developer's live daemon state. Pin the env here: a setup
 * file runs before the test file's module graph is loaded, i.e. before
 * session-health's import-time `load()`.
 *
 * An explicitly exported HERMES_SESSION_HEALTH_FILE (including the empty string
 * that means "disable persistence") is honoured as-is — hence the guard is
 * `=== undefined`, the same "unset" the module itself distinguishes from `''`.
 * A truthiness check would treat an explicit disable as unset, pin a temp path
 * over it, and make the suite persist exactly where production would not
 * (review round 1, Important-1; covered by
 * test/setup/health-file-env-isolation.test.ts). The default-path branch itself
 * is covered by session-health-persistence.test.ts, which deletes the env and
 * points $HOME at a tmp dir instead.
 */
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

if (process.env.HERMES_SESSION_HEALTH_FILE === undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'prismer-session-health-'));
  process.env.HERMES_SESSION_HEALTH_FILE = join(dir, 'hermes-session-health.json');
  // Best-effort cleanup: without it a full run leaves one directory per test file
  // behind (317 files → 317 dirs). `process.on('exit')` is NOT an option — it
  // does not run in vitest workers (measured: the probe handler never fired),
  // while `afterAll` does. Scoped to the dir minted on this line and never
  // allowed to fail the suite; a crashed/killed worker still leaks, accepted.
  afterAll(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });
}

try {
  if (process.platform === 'darwin') {
    const require = createRequire(import.meta.url);
    const ptyRoot = require.resolve('node-pty/package.json');
    const prebuilds = join(ptyRoot, '..', 'prebuilds');
    if (existsSync(prebuilds)) {
      for (const entry of readdirSync(prebuilds)) {
        if (!entry.startsWith('darwin-')) continue;
        const helper = join(prebuilds, entry, 'spawn-helper');
        if (!existsSync(helper)) continue;
        const mode = statSync(helper).mode & 0o777;
        if ((mode & 0o111) !== 0o111) chmodSync(helper, mode | 0o111);
      }
    }
  }
} catch {
  /* no node-pty / unresolvable — the loader's degraded path covers it */
}
