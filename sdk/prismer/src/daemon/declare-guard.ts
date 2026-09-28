/**
 * declare-guard.ts — product206/13 §4-R5 · 14 §6 Step 5.
 *
 * ## Why this module exists
 *
 * `agent.host.declare` is the only way a daemon becomes usable: it registers the
 * shadow routes, the redis presence and the `im_containers` row. The cloud can
 * REFUSE it (R4's `DAEMON_ID_CLAIMED`, the forgotten-device gate, the
 * one-active-local-device gate…) — and until this module existed the daemon
 * dropped that refusal on the floor (`runner.ts` only reacted to the three
 * AUTH_* codes) and re-declared unconditionally every 30s, forever. The user
 * saw a daemon that was "connected" and hosted nothing, with no reason anywhere.
 *
 * Three things are needed and they are all here, so there is ONE place that
 * decides them:
 *
 *   1. **Classification** — which refusals can a retry ever fix?
 *      `terminal` refusals cannot: the same credential re-sending the same
 *      declare gets the same answer until a HUMAN acts (release the claim,
 *      re-add the device). Retrying them forever is pure noise.
 *      `transient` refusals can: the other device goes offline, the identity
 *      store comes back.
 *   2. **Backoff** — transient refusals must not keep hammering at the 30s
 *      heartbeat cadence.
 *   3. **A readable blocked state** — the daemon must be able to tell a user
 *      *why* it is not hosting anything (`/healthz.declareBlocked`,
 *      `prismer status`).
 *
 * ## Hard invariants (each one is a gate in j48)
 *
 *   - **local-first**: nothing here stops or degrades local execution. A blocked
 *     daemon keeps running local dispatches; being refused is a CLOUD-side
 *     membership fact, not a health problem.
 *   - **offline ≠ refused**: only a real cloud `error` frame reaches this guard.
 *     A dropped socket is handled by `ws-client.ts`'s own reconnect backoff and
 *     must NEVER produce a `declareBlocked` — otherwise every subway tunnel
 *     looks like a permission failure.
 *   - **a normal reconnect never pays backoff**: `onConnected()` resets the
 *     ladder, so the high-frequency path (daemon drops + reconnects) declares
 *     immediately, exactly as before this module existed.
 *   - **terminal refusals are bounded**: after parking, at most
 *     `PARK_PROBE_DELAY_TICKS.length` further declares are ever sent on that
 *     connection. Not zero — the common terminal cases (`DAEMON_FORGOTTEN`,
 *     released claim) are fixed by a human within minutes and the daemon should
 *     notice — but bounded, which is the whole difference from today.
 *
 * ## Wire contract
 *
 * The cloud may attach `retryable: false | { afterMs }` to an error frame
 * (`src/im/ws/events.ts::ServerEvents.error`). It is **advisory and optional**
 * in both directions (13 §5 维度4: no protocolVersion negotiation is introduced
 * here): a new daemon against an old cloud falls back to the code table below;
 * an old daemon against a new cloud ignores the field. When present it wins for
 * the retryable/terminal decision, because the cloud is the only side that
 * knows codes this daemon build has never heard of.
 */

/** Codes that mean "your credential is bad" — the pre-existing stop-the-daemon path. */
export const FATAL_AUTH_CODES = new Set(['AUTH_FAILED', 'AUTH_REQUIRED', 'auth_invalid']);

/**
 * Refusals that a retry can never fix — only a human can (release the claim on
 * the owning account, re-add the device to the workspace, fix the account).
 * Every one is code-verified against its emission site in `src/im/ws/handler.ts`.
 */
export const TERMINAL_DECLARE_CODES = new Set([
  // handler.ts (R4 claim gate) — the daemonId is claimed by ANOTHER account.
  // Re-sending the identical declare with the identical credential is
  // guaranteed to hit the identical branch.
  'DAEMON_ID_CLAIMED',
  // product206/13 §6-D2 (cloud migration 536) — the daemonId belongs to THIS
  // account, but this API key is not the one it was claimed with. Time cannot
  // fix it: the daemon has exactly one key and will keep presenting it. The
  // owner has to open a re-claim window (Devices → re-claim, i.e.
  // `POST /api/im/daemons/reclaim`), which also pushes `daemon.declare.retry`
  // back down this socket — that frame is what un-parks us, not a retry.
  'DAEMON_CREDENTIAL_MISMATCH',
  // product206/13 §6-D1 — the workspace's LOCAL SLOT is explicitly attributed
  // to a different machine, and attribution deliberately does NOT drift. Waiting
  // for the other device to go offline used to be the (accidental) recovery
  // path; that is precisely the "first to connect takes all" behaviour the
  // decision removed. Only a human reassigning the slot changes this answer.
  'WORKSPACE_DAEMON_MISMATCH',
  // handler.ts — the workspace explicitly forgot this device (user removed it).
  // Recovery requires the user re-adding it; there is nothing to wait for.
  'DAEMON_FORGOTTEN',
  // handler.ts — the authenticated connection has no IMUser row. The account is
  // gone / broken; a retry loop cannot conjure it back.
  'NO_USER',
]);

/**
 * Refusals that time (or another actor) genuinely fixes. Listed explicitly so
 * the table documents WHY each one is retryable, but note the default for an
 * UNKNOWN code is also "transient": a daemon that meets a code from a newer
 * cloud must degrade to "back off and keep trying", never to permanent silence.
 */
export const TRANSIENT_DECLARE_CODES = new Set([
  // handler.ts — another local device holds the workspace. It quits or times
  // out and this daemon takes over. The cloud sends afterMs:60000 with it.
  'WORKSPACE_ACTIVE_DEVICE_BUSY',
  // handler.ts (R4 fail-closed) — identity store read/write failed. Infra.
  'DAEMON_IDENTITY_UNAVAILABLE',
  // handler.ts — API key valid but IMUser provisioning lost a race.
  'NO_IMUSER_LINKED',
  // handler.ts — one shadow agent's auto-join failed mid-declare.
  'SHADOW_JOIN_FAILED',
  // handler.ts — unhandled server exception while handling the frame.
  'INTERNAL',
]);

/**
 * Error codes that are answers to something OTHER than `agent.host.declare`.
 * They must not touch the declare state machine at all: a rejected withdraw or
 * an unknown-event complaint is not a reason to tell the user their device was
 * refused. (The wire has no per-frame correlation id we can trust — `envelope()`
 * puts the daemonId in `requestId` for every frame type — so this explicit
 * exclusion list is the correlation.)
 */
export const NON_DECLARE_CODES = new Set(['WITHDRAW_DAEMON_MISMATCH', 'UNKNOWN_EVENT']);

export type DeclareVerdict =
  /** Credential failure — caller keeps the existing "stop the daemon" behaviour. */
  | { kind: 'fatal'; code: string }
  /** Not a declare-channel error; caller logs and does nothing else. */
  | { kind: 'ignore'; code: string }
  /** Retry later; `nextRetryInMs` is how long the guard will hold declares off. */
  | { kind: 'transient'; code: string; nextRetryInMs: number }
  /** Refused for good; `nextRetryInMs === null` once the bounded probes are spent. */
  | { kind: 'terminal'; code: string; nextRetryInMs: number | null };

/** Surfaced verbatim on `/healthz.declareBlocked` and by `prismer status`. */
export interface DeclareBlockedState {
  /** Cloud error code, stable across builds — UIs key their copy off this. */
  code: string;
  /** Cloud's own message. */
  message: string;
  /** false ⇒ a human has to act. */
  retryable: boolean;
  /** ISO time of the FIRST refusal in this blocked episode. */
  since: string;
  /** How many refusals this episode has seen. */
  attempts: number;
  /** ISO time of the next automatic declare; null ⇒ parked (none scheduled). */
  nextRetryAt: string | null;
  /** One sentence a non-engineer can act on. */
  hint: string;
}

const HINTS: Record<string, string> = {
  DAEMON_ID_CLAIMED:
    'This device id is claimed by another account. Release it from the owning account (Devices → release), or run `prismer setup --force` to mint a new device id.',
  DAEMON_FORGOTTEN:
    'This device was removed from the workspace. Add it back from the workspace Devices panel — the daemon will pick it up on its next attempt.',
  NO_USER: 'The cloud account behind this API key no longer exists. Run `prismer setup` to pair again.',
  DAEMON_CREDENTIAL_MISMATCH:
    'This device was claimed with a different API key (rotating a key or switching accounts mints a new one). Re-claim your devices in the cloud — Devices → re-claim — and this daemon is accepted again within the window; no restart needed.',
  WORKSPACE_DAEMON_MISMATCH:
    'This workspace is served by a different device, and that choice does not move on its own. Reassign it in the workspace Devices panel (or release the other device) to hand the workspace to this machine.',
  WORKSPACE_ACTIVE_DEVICE_BUSY:
    'Another device is already active in this workspace. Quit it (or wait for it to go offline) and this device takes over automatically.',
  DAEMON_IDENTITY_UNAVAILABLE: 'The cloud device registry is temporarily unavailable. Retrying automatically.',
};

const DEFAULT_TRANSIENT_HINT = 'The cloud refused this device temporarily. Retrying automatically.';
const DEFAULT_TERMINAL_HINT = 'The cloud refused this device permanently. Check the workspace Devices panel.';

/** Transient ladder, in multiples of the declare tick. Last entry is the cap. */
const TRANSIENT_DELAY_TICKS = [2, 4, 8, 10];
/**
 * Bounded probes after a TERMINAL refusal, in multiples of the declare tick
 * (default tick 30s ⇒ 5min, then 10min, then never). Two, deliberately:
 * enough that "user fixed it" is noticed without a human restarting anything,
 * few enough that a permanently-claimed daemonId stops talking.
 */
const PARK_PROBE_DELAY_TICKS = [10, 20];

export interface DeclareGuardOptions {
  /** The periodic declare interval (ms). The whole ladder is expressed in it. */
  tickMs: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

/**
 * Classify one cloud error frame. Pure — exported so the table can be tested
 * (and read) without booting a Runner.
 *
 * `retryableHint` is the optional wire field; it OVERRIDES the local table
 * because the cloud may know codes this build does not.
 */
export function classifyDeclareError(
  code: string | undefined,
  retryableHint?: boolean | { afterMs?: number },
): { kind: 'fatal' | 'ignore' | 'transient' | 'terminal'; afterMs?: number } {
  const c = (code ?? '').trim();
  if (FATAL_AUTH_CODES.has(c)) return { kind: 'fatal' };
  if (NON_DECLARE_CODES.has(c)) return { kind: 'ignore' };
  if (retryableHint === false) return { kind: 'terminal' };
  if (retryableHint && typeof retryableHint === 'object') {
    return { kind: 'transient', afterMs: typeof retryableHint.afterMs === 'number' ? retryableHint.afterMs : undefined };
  }
  if (TERMINAL_DECLARE_CODES.has(c)) return { kind: 'terminal' };
  if (TRANSIENT_DECLARE_CODES.has(c)) return { kind: 'transient' };
  // Unknown code from a newer cloud: back off, keep trying. Never park on a
  // code we don't understand — that would turn an unrecognised message into a
  // silently dead device.
  return { kind: 'transient' };
}

/**
 * Declare admission + blocked-state machine. One instance per Runner.
 *
 * The Runner asks `shouldDeclare(now)` on its periodic tick instead of the
 * guard owning a timer: one scheduler, no timer churn, and the tick keeps doing
 * exactly what it did before (its ONLY job was `sendDeclare()`).
 */
export class DeclareGuard {
  private readonly tickMs: number;
  private readonly now: () => number;
  private nextDeclareAt = 0;
  private parked = false;
  private attempts = 0;
  private blocked: DeclareBlockedState | null = null;

  constructor(opts: DeclareGuardOptions) {
    this.tickMs = Math.max(1_000, opts.tickMs);
    this.now = opts.now ?? Date.now;
  }

  /** May the periodic tick declare right now? */
  shouldDeclare(now: number = this.now()): boolean {
    if (this.parked) return false;
    return now >= this.nextDeclareAt;
  }

  /**
   * A fresh `authenticated` ack. Resets the ladder so the ordinary
   * disconnect→reconnect path declares immediately — reconnect is high
   * frequency and must not inherit a blocked episode's backoff.
   *
   * The blocked SNAPSHOT is deliberately kept until the declare is answered:
   * clearing it here would blink `/healthz` green on every socket flap while
   * the device is still refused.
   */
  onConnected(): void {
    this.nextDeclareAt = 0;
    this.parked = false;
    this.attempts = 0;
  }

  /** `host.acked` — the declare was accepted. Episode over. */
  onAccepted(): void {
    this.nextDeclareAt = 0;
    this.parked = false;
    this.attempts = 0;
    this.blocked = null;
  }

  /**
   * A user/controller-driven declare (agent installed, workspace switched).
   * Explicit intent outranks backoff: it is bounded by the user's own actions,
   * and it is the natural "I fixed it, try again" affordance.
   */
  onExplicitDeclare(): void {
    this.nextDeclareAt = 0;
    this.parked = false;
  }

  /** A cloud `error` frame arrived. Returns what the caller should do. */
  onError(code: string | undefined, message: string, retryableHint?: boolean | { afterMs?: number }): DeclareVerdict {
    const c = (code ?? '').trim() || 'UNKNOWN';
    const cls = classifyDeclareError(code, retryableHint);
    if (cls.kind === 'fatal') return { kind: 'fatal', code: c };
    if (cls.kind === 'ignore') return { kind: 'ignore', code: c };

    const now = this.now();
    this.attempts += 1;
    const since = this.blocked?.since ?? new Date(now).toISOString();

    if (cls.kind === 'transient') {
      const ladder = TRANSIENT_DELAY_TICKS[Math.min(this.attempts - 1, TRANSIENT_DELAY_TICKS.length - 1)]!;
      // The server's floor is honoured, but the ladder still grows underneath
      // it — a hint of 60s must not pin us at 60s forever.
      const delay = Math.max(ladder * this.tickMs, cls.afterMs ?? 0);
      this.nextDeclareAt = now + delay;
      this.blocked = {
        code: c,
        message,
        retryable: true,
        since,
        attempts: this.attempts,
        nextRetryAt: new Date(this.nextDeclareAt).toISOString(),
        hint: HINTS[c] ?? DEFAULT_TRANSIENT_HINT,
      };
      return { kind: 'transient', code: c, nextRetryInMs: delay };
    }

    // terminal — bounded probes, then silence.
    const probeIndex = this.attempts - 1;
    const probeTicks = PARK_PROBE_DELAY_TICKS[probeIndex];
    let nextRetryInMs: number | null = null;
    if (probeTicks === undefined) {
      this.parked = true;
      this.nextDeclareAt = Number.POSITIVE_INFINITY;
    } else {
      nextRetryInMs = probeTicks * this.tickMs;
      this.nextDeclareAt = now + nextRetryInMs;
    }
    this.blocked = {
      code: c,
      message,
      retryable: false,
      since,
      attempts: this.attempts,
      nextRetryAt: nextRetryInMs === null ? null : new Date(this.nextDeclareAt).toISOString(),
      hint: HINTS[c] ?? DEFAULT_TERMINAL_HINT,
    };
    return { kind: 'terminal', code: c, nextRetryInMs };
  }

  /** Current blocked state, or null when the daemon is accepted / never refused. */
  snapshot(): DeclareBlockedState | null {
    return this.blocked;
  }
}
