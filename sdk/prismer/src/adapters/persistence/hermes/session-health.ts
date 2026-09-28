// release203/27 S10 — hermes session single-flight + pollution rotation.
//
// Hermes sessions are STATEFUL: the server holds the transcript and reuses it
// across turns. Two hazards make a session go "polluted":
//   1. Concurrent turns on the SAME session interleave writes into one
//      transcript → the second turn reads the first's half-written state.
//   2. An aborted/interrupted turn leaves an orphaned server-side generation
//      that flushes late into the transcript (hermes /stop is a no-op for
//      sessions runs today — see sessions-dispatcher.ts §W5), so the NEXT turn
//      inherits the pollution and returns `empty_reply`.
//
// This module holds the small state (per daemon process + persisted) that
// guards both:
//   - single-flight: at most one in-flight turn per (conversation, agent)
//     session key; a second concurrent dispatch is rejected → transient
//     re-queue (cloud spaces the retry).
//   - rotation: after N consecutive `empty_reply`, or when the previous turn on
//     the session ended in an interrupt/abort, the next resolveSession mints a
//     FRESH hermes session instead of reusing the polluted one.
//
// 2.2.9 (2026-08-07) — the rotation state used to be process-local only: a
// daemon restart (OTA kill1, sandbox re-adoption, crash) wiped the "this
// session is polluted" signal, so the next turn reused the polluted hermes
// session and came back EMPTY (observed live: sandbox agent after the 2.2.8
// OTA). interrupted/emptyStreak now persist to a small JSON file under
// ~/.prismer (HERMES_SESSION_HEALTH_FILE to override, null to disable).
// Keyed on the STABLE (conversationId, agentImUserId) identity so it survives
// a rotation (the hermesSessionId changes, the key doesn't).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// spec 11 T1-3 (2026-09-22, owner re-ruling) — TWO, not one.
//
// 2.2.9 rotated on the first EMPTY on the theory that hermes only completes
// empty on recoverable-but-empty paths, so waiting for a second EMPTY burned a
// failed turn for nothing. Production says otherwise: the first EMPTY is often
// a transient upstream blip (provider stall mid-stream, cold gateway), and
// rotating on it throws away a HEALTHY server-side transcript the next turn
// would have reused — the user pays a full reseed (envelope FULL seed +
// transcript read-back) and the agent loses what it had. So the first EMPTY is
// recorded and made visible WITHOUT rotating (sessions-dispatcher posts an
// `empty_reply_observed` system_event so the timeline explains the failed turn
// and what happens next); the second CONSECUTIVE one rotates.
//
// Env override kept as the operator escape hatch (fleet tuning / incident
// rollback to the 2.2.9 semantics). The `Math.max(1, …)` lower bound is KEPT
// deliberately: 1 is a meaningful value (legacy semantics) while 0/negative is
// meaningless — rotation only ever happens at the START of a turn, so the
// threshold can never be "always" — and would silently defeat the guard. A
// non-numeric override falls back to the default for the same reason: NaN
// compares false against every streak, i.e. it would silently disable rotation
// forever instead of failing visibly.
const DEFAULT_EMPTY_ROTATE_THRESHOLD = 2;
const EMPTY_ROTATE_THRESHOLD = (() => {
  const raw = Number(process.env.HERMES_SESSION_EMPTY_ROTATE_THRESHOLD ?? DEFAULT_EMPTY_ROTATE_THRESHOLD);
  return Number.isFinite(raw) ? Math.max(1, raw) : DEFAULT_EMPTY_ROTATE_THRESHOLD;
})();

const inFlight = new Set<string>();
const emptyStreak = new Map<string, number>();
const interrupted = new Set<string>();

// spec 11 T1-3b (2026-09-22) — this used to read
//   `let healthFile = process.env.HERMES_SESSION_HEALTH_FILE ?? null;`
// followed by an `if (healthFile === undefined)` default. `?? null` removed
// `undefined` from the type, so that branch could never be taken: with no env
// set, healthFile was null and BOTH persist() and load() early-returned. The
// "survives a daemon restart" promise above was therefore false in production
// unless the operator set the env — the streak stayed in process memory and a
// restart between two EMPTY replies (threshold 2) zeroed it, so a polluted
// session could never reach the rotation bar. Undefined (unset) must mean the
// default file; only an EMPTY env value means "disable".
const envHealthFile = process.env.HERMES_SESSION_HEALTH_FILE;
let healthFile: string | null;
if (envHealthFile === undefined) {
  // Default under the daemon root, alongside config.toml / local.db.
  healthFile = join(homedir(), '.prismer', 'hermes-session-health.json');
} else if (envHealthFile === '') {
  healthFile = null;
} else {
  healthFile = envHealthFile;
}

/**
 * Test/ops hook: point the persistence file elsewhere, or pass null to disable
 * persistence entirely (in-memory only — the pre-2.2.9 behaviour).
 */
export function setSessionHealthFile(file: string | null): void {
  healthFile = file;
}

function persist(): void {
  if (!healthFile) return;
  try {
    mkdirSync(dirname(healthFile), { recursive: true });
    writeFileSync(
      healthFile,
      JSON.stringify({
        emptyStreak: Object.fromEntries(emptyStreak),
        interrupted: [...interrupted],
      }),
      'utf8',
    );
  } catch (err) {
    // Persistence is best-effort — rotation state loss degrades to "one extra
    // EMPTY before rotation", never to a crash.
    process.stderr.write(
      `[hermes-adapter] session-health persist failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

function load(): void {
  if (!healthFile || !existsSync(healthFile)) return;
  try {
    const parsed = JSON.parse(readFileSync(healthFile, 'utf8')) as {
      emptyStreak?: Record<string, number>;
      interrupted?: string[];
    };
    for (const [k, v] of Object.entries(parsed.emptyStreak ?? {})) {
      if (typeof v === 'number' && v > 0) emptyStreak.set(k, v);
    }
    for (const k of parsed.interrupted ?? []) interrupted.add(k);
  } catch (err) {
    // Corrupt health file must not take the daemon down — start clean.
    process.stderr.write(
      `[hermes-adapter] session-health load failed (starting clean): ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}
load();

/** Stable session identity, unchanged across a rotation. */
export function sessionKeyOf(conversationId: string, agentImUserId: string): string {
  return `${conversationId}::${agentImUserId}`;
}

/**
 * Try to claim the single in-flight slot for a session. Returns false when a
 * turn is already running for this (conversation, agent) — the caller must then
 * reject with a transient (re-queue) result rather than start a second turn.
 */
export function tryAcquireInFlight(key: string): boolean {
  if (inFlight.has(key)) return false;
  inFlight.add(key);
  return true;
}

export function releaseInFlight(key: string): void {
  inFlight.delete(key);
}

/** Record an empty_reply outcome; returns the new consecutive streak. */
export function recordEmptyReply(key: string): number {
  const next = (emptyStreak.get(key) ?? 0) + 1;
  emptyStreak.set(key, next);
  persist();
  return next;
}

/** A healthy (non-empty) turn resets the streak and clears interrupt state. */
export function recordSuccess(key: string): void {
  emptyStreak.delete(key);
  interrupted.delete(key);
  persist();
}

/** The turn ended in an interrupt/abort — the session is presumed polluted. */
export function recordInterrupted(key: string): void {
  interrupted.add(key);
  persist();
}

/**
 * Should the NEXT turn rotate to a fresh hermes session? True when the empty
 * streak reached the threshold, or the previous turn was interrupted/aborted.
 */
export function shouldRotate(key: string): boolean {
  return (emptyStreak.get(key) ?? 0) >= EMPTY_ROTATE_THRESHOLD || interrupted.has(key);
}

/**
 * The active empty-reply rotation threshold (env override applied).
 *
 * spec 11 T1-3 — exported so the dispatcher can tell "this EMPTY is still
 * below the bar, nothing rotates and the timeline must say so" from "this
 * EMPTY armed the rotation" without re-reading the env and drifting from the
 * value `shouldRotate` actually uses.
 */
export function emptyRotateThreshold(): number {
  return EMPTY_ROTATE_THRESHOLD;
}

/** Reset rotation triggers after a fresh session has been minted. */
export function clearRotationState(key: string): void {
  emptyStreak.delete(key);
  interrupted.delete(key);
  persist();
}

/** Test-only: wipe all state. */
export function __resetSessionHealth(): void {
  inFlight.clear();
  emptyStreak.clear();
  interrupted.clear();
}

/**
 * Check whether any hermes session has an in-flight turn.
 * Used by ConfigDelivery drain-before-kill: gateway must not be killed
 * while a turn is running (would leave a half-written transcript).
 */
export function hasInFlight(): boolean {
  return inFlight.size > 0;
}

/** Return the number of in-flight turns (for logging / healthz). */
export function inFlightCount(): number {
  return inFlight.size;
}

export const __EMPTY_ROTATE_THRESHOLD = EMPTY_ROTATE_THRESHOLD;
