// F14 (2026-05-20) — daemon-id stability tests.
//
// Same (hostname, apiKey) → same daemonId → cloud-side host.declare upsert
// dedupes the IMContainer row instead of accumulating one per fresh setup.
// This is the root-cause fix for the "Devices page shows 25+ rows for one
// physical Mac" symptom.

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { isDaemonId, newDaemonId } from '../src/daemon-id.js';

describe('newDaemonId', () => {
  it('isDaemonId recognises the daemon- prefix', () => {
    expect(isDaemonId('daemon-MyMac-abc123def456')).toBe(true);
    expect(isDaemonId('something-else')).toBe(false);
    expect(isDaemonId('daemon-')).toBe(false); // prefix only — no suffix
  });

  describe('stable mode (apiKey provided)', () => {
    it('same (hostname, apiKey) yields identical daemonId every call', () => {
      const a = newDaemonId({ apiKey: 'sk-prismer-test-1', hostnameOverride: 'MyMac' });
      const b = newDaemonId({ apiKey: 'sk-prismer-test-1', hostnameOverride: 'MyMac' });
      expect(a).toBe(b);
      expect(a).toMatch(/^daemon-MyMac-[a-f0-9]{12}$/);
    });

    it('different apiKey yields different daemonId on the same host', () => {
      const a = newDaemonId({ apiKey: 'sk-prismer-test-A', hostnameOverride: 'MyMac' });
      const b = newDaemonId({ apiKey: 'sk-prismer-test-B', hostnameOverride: 'MyMac' });
      expect(a).not.toBe(b);
    });

    it('different hostname yields different daemonId with the same key', () => {
      const a = newDaemonId({ apiKey: 'sk-prismer-test', hostnameOverride: 'MacA' });
      const b = newDaemonId({ apiKey: 'sk-prismer-test', hostnameOverride: 'MacB' });
      expect(a).not.toBe(b);
    });

    it('embeds the host segment so the id stays readable', () => {
      const id = newDaemonId({ apiKey: 'sk-prismer-test', hostnameOverride: 'Prismer-de-Studio' });
      expect(id).toMatch(/^daemon-Prismer-de-Studio-[a-f0-9]{12}$/);
    });
  });

  describe('legacy random mode (no apiKey)', () => {
    it('yields a fresh random suffix every call when apiKey is absent', () => {
      const a = newDaemonId();
      const b = newDaemonId();
      expect(a).not.toBe(b); // random — should differ with overwhelming probability
      expect(a).toMatch(/^daemon-.+-[a-f0-9]{12}$/);
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// G2 — daemon_id separation gate (docs/desktop205/03-acceptance.md §2 G2)
//
// The desktop's embedded daemon and a standalone CLI daemon are TWO devices on
// ONE machine. They are pulled apart by the **api key**, not by PRISMER_HOME:
// `daemon_id = f(hostname, apiKey)` and nothing else. If someone weakens that
// derivation (drops apiKey from the seed, or makes it host-independent), the
// two same-machine daemons collide on identity ⇒ cloud-side first-declare-wins
// steals agents and artifacts land on the wrong machine.
//
// This block states the three invariants as a *predicate over a derivation
// function*, so the exact same predicate can be aimed at deliberately broken
// derivations (§ negative control). A gate that cannot go red is not a gate.
// ───────────────────────────────────────────────────────────────────────────

/** A daemon-id derivation under test: (hostname, apiKey) -> id. */
type Derivation = (host: string, apiKey: string) => string;

const HOST_A = 'MacA';
const HOST_B = 'MacB';
const KEY_DESKTOP = 'sk-prismer-live-desktop-0001';
const KEY_CLI = 'sk-prismer-live-cli-0002';

/** Separation: same host, two different keys ⇒ ids MUST differ. */
function holdsSeparation(derive: Derivation): boolean {
  return derive(HOST_A, KEY_DESKTOP) !== derive(HOST_A, KEY_CLI);
}

/** Stability: same host + same key ⇒ id MUST be identical (F14). */
function holdsStability(derive: Derivation): boolean {
  return derive(HOST_A, KEY_DESKTOP) === derive(HOST_A, KEY_DESKTOP);
}

/** Host participation: two hosts, same key ⇒ ids MUST differ. */
function holdsHostParticipation(derive: Derivation): boolean {
  return derive(HOST_A, KEY_DESKTOP) !== derive(HOST_B, KEY_DESKTOP);
}

/** The hash suffix — everything after the last '-' (hostnames may contain '-'). */
function suffixOf(id: string): string {
  return id.slice(id.lastIndexOf('-') + 1);
}

/**
 * Host participation *in the hash seed*, not merely in the readable prefix.
 *
 * Why this is a separate, stronger predicate: the id is
 * `daemon-<host>-<suffix>`, so the host segment alone already makes two hosts'
 * ids differ. A derivation that dropped hostname from the seed would still
 * satisfy `holdsHostParticipation` — verified by mutating the real
 * `daemon-id.ts` (see the ignoresHostname negative control below). The seed
 * matters because `sanitizeHostname()` is lossy: `My Mac` and `My.Mac` both
 * collapse to `My-Mac`, so the prefix is not a reliable discriminator.
 */
function holdsHostInSeed(derive: Derivation): boolean {
  return suffixOf(derive(HOST_A, KEY_DESKTOP)) !== suffixOf(derive(HOST_B, KEY_DESKTOP));
}

/** The real thing. */
const canonical: Derivation = (host, apiKey) =>
  newDaemonId({ apiKey, hostnameOverride: host });

describe('G2 — daemon_id separation invariants', () => {
  describe('positive control (the shipped derivation)', () => {
    it('separation: same host + two api keys ⇒ different daemon_id', () => {
      // This is what keeps the desktop daemon (port 3215) and the CLI daemon
      // (port 3210) from colliding on one Mac.
      expect(holdsSeparation(canonical)).toBe(true);
      expect(canonical(HOST_A, KEY_DESKTOP)).toMatch(/^daemon-MacA-[a-f0-9]{12}$/);
      expect(canonical(HOST_A, KEY_CLI)).toMatch(/^daemon-MacA-[a-f0-9]{12}$/);
    });

    it('stability: same host + same api key ⇒ identical daemon_id', () => {
      // F14: re-running `prismer setup` must NOT mint a new device row.
      expect(holdsStability(canonical)).toBe(true);
    });

    it('host participation: two hosts + same api key ⇒ different daemon_id', () => {
      expect(holdsHostParticipation(canonical)).toBe(true);
      // …and the hostname is genuinely in the seed, not just in the prefix.
      expect(holdsHostInSeed(canonical)).toBe(true);
    });
  });

  // ── Negative control ─────────────────────────────────────────────────────
  // Feed deliberately broken derivations to the SAME three predicates. Each
  // breakage must flip exactly the invariant it violates and leave the others
  // standing — that pins down which predicate is doing the catching, so none
  // of the three can be silently degraded into a tautology.
  describe('negative control (broken derivations must trip the predicates)', () => {
    /** Regression shape #1: the seed forgets the api key. Both same-machine
     *  daemons then compute the SAME id ⇒ identity collision. */
    const ignoresApiKey: Derivation = (host) =>
      `daemon-${host}-${createHash('sha256').update(host).digest('hex').slice(0, 12)}`;

    /** Regression shape #2: the seed forgets the hostname (but the readable
     *  prefix keeps it — this is the shape an actual edit to daemon-id.ts
     *  produces). Two Macs whose hostnames sanitize to the same segment and
     *  share an api key then collide outright. */
    const ignoresHostname: Derivation = (host, apiKey) =>
      `daemon-${host}-${createHash('sha256').update(apiKey).digest('hex').slice(0, 12)}`;

    /** Regression shape #3: back to the pre-F14 random suffix. Every setup
     *  mints a new device row again. */
    const nonDeterministic: Derivation = (host) =>
      `daemon-${host}-${randomBytes(6).toString('hex')}`;

    it('a derivation that ignores apiKey FAILS separation (and only separation)', () => {
      expect(holdsSeparation(ignoresApiKey)).toBe(false);
      // Sanity: the other two still hold, so the red above is attributable.
      expect(holdsStability(ignoresApiKey)).toBe(true);
      expect(holdsHostParticipation(ignoresApiKey)).toBe(true);
      expect(holdsHostInSeed(ignoresApiKey)).toBe(true);
    });

    it('a derivation that ignores hostname FAILS host-in-seed', () => {
      expect(holdsHostInSeed(ignoresHostname)).toBe(false);
      // Documented weakness: the readable prefix alone keeps the whole-id
      // comparison green, which is exactly why holdsHostInSeed exists.
      expect(holdsHostParticipation(ignoresHostname)).toBe(true);
      expect(holdsSeparation(ignoresHostname)).toBe(true);
      expect(holdsStability(ignoresHostname)).toBe(true);
    });

    it('a non-deterministic derivation FAILS stability (pre-F14 regression)', () => {
      expect(holdsStability(nonDeterministic)).toBe(false);
      // Random ids trivially "separate", which is exactly why separation alone
      // is not sufficient — stability is a load-bearing, independent invariant.
      expect(holdsSeparation(nonDeterministic)).toBe(true);
    });
  });

  // ── Drift guard: apps/desktop/electron/daemon-link.ts::computeDaemonId ────
  // The desktop main process cannot import @prismer/runtime (it writes
  // config.toml *before* the daemon exists, and apps/desktop is a separate npm
  // project outside the workspaces). It therefore carries a hand-copied clone
  // of the derivation. A clone is a drift hazard: if it and the runtime ever
  // disagree, the id written into config.toml stops matching what the daemon
  // self-derives.
  //
  // Rather than regex-matching the source (which would only prove it *looks*
  // right), we extract the clone's body and RUN it against the same inputs.
  // No cross-package import, no bundler, no mock — the real source text.
  describe('desktop clone must not drift from the runtime derivation', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const desktopElectronDir = resolve(here, '../../../apps/desktop/electron');
    const desktopFile = join(desktopElectronDir, 'daemon-link.ts');

    // sdk/ is rsync'd into the open-source repo, where apps/desktop does not
    // exist. Discriminate that honestly instead of skipping: if the desktop
    // tree is absent it must be absent *wholesale*, not because someone moved
    // this one file.
    const inMonorepo = existsSync(desktopElectronDir);

    it('the desktop electron tree is either fully present or fully absent', () => {
      if (!inMonorepo) {
        expect(
          existsSync(resolve(here, '../../../apps/desktop')),
          'apps/desktop exists but apps/desktop/electron does not — the desktop ' +
            'daemon-id clone moved; re-point this drift guard.',
        ).toBe(false);
        return;
      }
      expect(
        existsSync(desktopFile),
        `${desktopFile} is gone — the desktop daemon-id clone moved or was ` +
          'deleted; re-point this drift guard before trusting it.',
      ).toBe(true);
    });

    it('computeDaemonId() produces byte-identical ids to newDaemonId()', () => {
      if (!inMonorepo) return; // covered by the presence assertion above

      const src = readFileSync(desktopFile, 'utf8');
      const marker = 'export function computeDaemonId(apiKey: string): string {';
      const start = src.indexOf(marker);
      expect(
        start,
        'computeDaemonId signature not found verbatim in daemon-link.ts — the ' +
          'desktop clone was refactored. Re-verify by hand that it still yields ' +
          'sha256("<host>|<apiKey>").slice(0,12), then update this guard.',
      ).toBeGreaterThan(-1);

      // Brace-match the body so the guard survives formatting churn.
      let depth = 0;
      let end = -1;
      for (let i = start + marker.length - 1; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      expect(end, 'unbalanced braces while extracting computeDaemonId').toBeGreaterThan(start);
      const body = src.slice(start + marker.length, end);

      // Execute the extracted clone with a stubbed hostname() so the comparison
      // is deterministic. Injecting createHash/hostname is *supplying the
      // clone's own free variables*, not stubbing the logic under test.
      let clone: Derivation;
      try {
        const factory = new Function(
          'createHash',
          'hostname',
          `return function computeDaemonId(apiKey) {${body}\n}`,
        ) as (c: typeof createHash, h: () => string) => (apiKey: string) => string;
        clone = (host, apiKey) => factory(createHash, () => host)(apiKey);
      } catch (err) {
        throw new Error(
          'could not evaluate the extracted computeDaemonId body (TS-only syntax ' +
            'or a new helper dependency?). Re-verify the clone by hand and update ' +
            `this guard. Cause: ${(err as Error).message}`,
        );
      }

      // Same inputs ⇒ same output, across the whole invariant surface.
      for (const host of [HOST_A, HOST_B, 'Prismer-de-Studio']) {
        for (const key of [KEY_DESKTOP, KEY_CLI]) {
          expect(clone(host, key)).toBe(canonical(host, key));
        }
      }

      // And the clone must satisfy the invariants in its own right.
      expect(holdsSeparation(clone)).toBe(true);
      expect(holdsStability(clone)).toBe(true);
      expect(holdsHostParticipation(clone)).toBe(true);
    });
  });
});
