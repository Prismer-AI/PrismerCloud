// spec 11 T1-3b (2026-09-22, review round 1) — the isolation guard's own semantics.
//
// `test/setup/node-pty-exec-bit.ts` pins HERMES_SESSION_HEALTH_FILE to a per-file
// temp path so no test file writes the developer's real
// `~/.prismer/hermes-session-health.json`. The guard must fire **only when the env
// is unset**: `session-health.ts` defines '' as "disable persistence" (module
// header + CHANGELOG), so a truthiness check (`!env`) treats an operator's
// explicit disable as "unset", overrides it with a temp path, and the suite then
// persists exactly where production would not — an isolation layer that silently
// contradicts the semantics it is protecting.
//
// Negative control: an explicit path AND the empty string survive untouched.
// Positive control: with the env genuinely unset the pin still fires, so the
// "explicit env wins" cases cannot pass by the guard doing nothing at all.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const KEY = 'HERMES_SESSION_HEALTH_FILE';
/** Only dirs the guard minted may ever be removed — never an explicit path. */
const MINTED_PREFIX = join(tmpdir(), 'prismer-session-health-');

let original: string | undefined;
let minted: string | undefined;
beforeEach(() => {
  original = process.env[KEY];
  minted = undefined;
});
afterEach(() => {
  if (original === undefined) delete process.env[KEY];
  else process.env[KEY] = original;
  // The setup module cleans up through `afterAll`; a registration made by a
  // module imported from inside a test body is silently ignored (measured), so
  // the positive control's own dir is removed here.
  if (minted !== undefined && minted.startsWith(MINTED_PREFIX)) {
    rmSync(dirname(minted), { recursive: true, force: true });
  }
  vi.resetModules();
});

/** Re-execute the setup module's top-level guard (fresh module registry). */
async function loadSetup(): Promise<string | undefined> {
  vi.resetModules();
  await import('./node-pty-exec-bit.js');
  const pinned = process.env[KEY];
  if (pinned !== undefined && pinned.startsWith(MINTED_PREFIX)) minted = pinned;
  return pinned;
}

describe('vitest session-health isolation guard', () => {
  it('positive control: unset env → pinned to a temp path (the guard really fires)', async () => {
    delete process.env[KEY];
    const pinned = await loadSetup();
    expect(pinned).toBeTruthy();
    expect(pinned?.endsWith('hermes-session-health.json')).toBe(true);
  });

  it("negative control: an explicit '' (disable persistence) is honoured, not overwritten", async () => {
    process.env[KEY] = '';
    expect(await loadSetup()).toBe('');
  });

  it('negative control: an explicit path is honoured, not overwritten', async () => {
    process.env[KEY] = '/tmp/explicit-session-health.json';
    expect(await loadSetup()).toBe('/tmp/explicit-session-health.json');
  });
});
