/**
 * declare-guard.test.ts — product206/13 §4-R5, unit layer.
 *
 * The end-to-end gate is `scripts/test203/journeys/j48-declare-rejection-backoff.ts`
 * (real daemon process, real WS, frame counting). This file covers the parts a
 * wall-clock journey cannot express cheaply: the exact classification table and
 * the exact ladder arithmetic, on an injected clock.
 *
 * Usage: npx vitest run test/declare-guard.test.ts
 */
import { describe, expect, it } from 'vitest';
import { DeclareGuard, classifyDeclareError } from '../src/daemon/declare-guard';

const TICK = 30_000;

function guardAt(clock: { t: number }): DeclareGuard {
  return new DeclareGuard({ tickMs: TICK, now: () => clock.t });
}

describe('classifyDeclareError — the table R5 turns on', () => {
  it('auth codes stay fatal (a bad credential is not something to back off on)', () => {
    for (const c of ['AUTH_FAILED', 'AUTH_REQUIRED', 'auth_invalid']) {
      expect(classifyDeclareError(c).kind).toBe('fatal');
    }
  });

  it('claim / forgotten / no-user are terminal — a retry can never fix them', () => {
    for (const c of ['DAEMON_ID_CLAIMED', 'DAEMON_FORGOTTEN', 'NO_USER']) {
      expect(classifyDeclareError(c).kind).toBe('terminal');
    }
  });

  it('busy / identity-store / provisioning / internal are transient', () => {
    for (const c of [
      'WORKSPACE_ACTIVE_DEVICE_BUSY',
      'DAEMON_IDENTITY_UNAVAILABLE',
      'NO_IMUSER_LINKED',
      'SHADOW_JOIN_FAILED',
      'INTERNAL',
    ]) {
      expect(classifyDeclareError(c).kind).toBe('transient');
    }
  });

  it('errors answering OTHER frames never touch the declare state machine', () => {
    expect(classifyDeclareError('WITHDRAW_DAEMON_MISMATCH').kind).toBe('ignore');
    expect(classifyDeclareError('UNKNOWN_EVENT').kind).toBe('ignore');
  });

  it('an UNKNOWN code degrades to transient, never to permanent silence', () => {
    // A newer cloud inventing a code must not be able to kill an older daemon.
    expect(classifyDeclareError('SOME_FUTURE_CODE').kind).toBe('transient');
    expect(classifyDeclareError(undefined).kind).toBe('transient');
  });

  it('the wire hint outranks the local table (cloud knows codes we do not)', () => {
    expect(classifyDeclareError('SOME_FUTURE_CODE', false).kind).toBe('terminal');
    expect(classifyDeclareError('DAEMON_ID_CLAIMED', { afterMs: 5_000 })).toEqual({
      kind: 'transient',
      afterMs: 5_000,
    });
    // …but never for auth: a fatal credential failure is not negotiable.
    expect(classifyDeclareError('AUTH_FAILED', { afterMs: 1_000 }).kind).toBe('fatal');
  });
});

describe('DeclareGuard — transient refusals back off, they do not hammer', () => {
  it('the interval grows on every refusal instead of staying at the tick', () => {
    const clock = { t: 1_000_000 };
    const g = guardAt(clock);
    const delays: number[] = [];
    for (let i = 0; i < 5; i++) {
      const v = g.onError('WORKSPACE_ACTIVE_DEVICE_BUSY', 'busy');
      expect(v.kind).toBe('transient');
      const delay = (v as { nextRetryInMs: number }).nextRetryInMs;
      delays.push(delay);
      // the guard actually holds declares off for that long
      expect(g.shouldDeclare(clock.t + delay - 1)).toBe(false);
      expect(g.shouldDeclare(clock.t + delay)).toBe(true);
      clock.t += delay;
    }
    expect(delays).toEqual([2 * TICK, 4 * TICK, 8 * TICK, 10 * TICK, 10 * TICK]);
    // strictly increasing until the cap — this is the property j48 asserts on
    // the wire, restated here without a 20-minute wall clock.
    expect(delays[0]).toBeLessThan(delays[1]!);
    expect(delays[1]).toBeLessThan(delays[2]!);
  });

  it("honours the cloud's afterMs floor while still growing underneath it", () => {
    const clock = { t: 0 };
    const g = guardAt(clock);
    // floor larger than the first ladder step ⇒ floor wins
    expect((g.onError('X', 'm', { afterMs: 5 * TICK }) as { nextRetryInMs: number }).nextRetryInMs).toBe(5 * TICK);
    // ladder has grown past the floor ⇒ ladder wins (a 60s hint must not pin
    // the daemon at 60s forever)
    g.onError('X', 'm', { afterMs: 5 * TICK });
    expect((g.onError('X', 'm', { afterMs: 5 * TICK }) as { nextRetryInMs: number }).nextRetryInMs).toBe(8 * TICK);
  });

  it('publishes a retryable blocked state with the reason and the next attempt', () => {
    const clock = { t: 1_700_000_000_000 };
    const g = guardAt(clock);
    g.onError('WORKSPACE_ACTIVE_DEVICE_BUSY', 'Workspace already has an active device.');
    const b = g.snapshot()!;
    expect(b.code).toBe('WORKSPACE_ACTIVE_DEVICE_BUSY');
    expect(b.retryable).toBe(true);
    expect(b.message).toContain('active device');
    expect(b.hint).toMatch(/Another device/);
    expect(b.nextRetryAt).toBe(new Date(clock.t + 2 * TICK).toISOString());
  });
});

describe('DeclareGuard — terminal refusals are bounded, not infinite', () => {
  it('probes twice, then stops declaring entirely', () => {
    const clock = { t: 0 };
    const g = guardAt(clock);

    const v1 = g.onError('DAEMON_ID_CLAIMED', 'claimed');
    expect(v1).toEqual({ kind: 'terminal', code: 'DAEMON_ID_CLAIMED', nextRetryInMs: 10 * TICK });
    clock.t += 10 * TICK;
    expect(g.shouldDeclare(clock.t)).toBe(true); // probe 1 allowed

    const v2 = g.onError('DAEMON_ID_CLAIMED', 'claimed');
    expect(v2).toEqual({ kind: 'terminal', code: 'DAEMON_ID_CLAIMED', nextRetryInMs: 20 * TICK });
    clock.t += 20 * TICK;
    expect(g.shouldDeclare(clock.t)).toBe(true); // probe 2 allowed

    const v3 = g.onError('DAEMON_ID_CLAIMED', 'claimed');
    expect(v3).toEqual({ kind: 'terminal', code: 'DAEMON_ID_CLAIMED', nextRetryInMs: null });
    // parked: no amount of elapsed time re-opens it.
    expect(g.shouldDeclare(clock.t)).toBe(false);
    expect(g.shouldDeclare(clock.t + 365 * 24 * 3_600_000)).toBe(false);
    expect(g.snapshot()!.nextRetryAt).toBeNull();
    expect(g.snapshot()!.retryable).toBe(false);
    expect(g.snapshot()!.hint).toMatch(/Release it|another account/);
  });

  it('keeps `since` pinned to the first refusal while attempts accumulate', () => {
    const clock = { t: 1_700_000_000_000 };
    const g = guardAt(clock);
    g.onError('DAEMON_FORGOTTEN', 'gone');
    const since = g.snapshot()!.since;
    clock.t += 10 * TICK;
    g.onError('DAEMON_FORGOTTEN', 'gone');
    expect(g.snapshot()!.since).toBe(since);
    expect(g.snapshot()!.attempts).toBe(2);
  });
});

describe('DeclareGuard — the invariants R5 must not break', () => {
  it('a normal reconnect pays NO backoff (the high-frequency path)', () => {
    const clock = { t: 0 };
    const g = guardAt(clock);
    g.onError('WORKSPACE_ACTIVE_DEVICE_BUSY', 'busy');
    expect(g.shouldDeclare(clock.t)).toBe(false);
    g.onConnected();
    expect(g.shouldDeclare(clock.t)).toBe(true);
  });

  it('a reconnect does NOT prematurely clear the reason (only an ack does)', () => {
    const g = guardAt({ t: 0 });
    g.onError('DAEMON_ID_CLAIMED', 'claimed');
    g.onConnected();
    expect(g.snapshot()?.code).toBe('DAEMON_ID_CLAIMED');
    g.onAccepted();
    expect(g.snapshot()).toBeNull();
  });

  it('a parked daemon is revived by explicit user intent (install / workspace switch)', () => {
    const clock = { t: 0 };
    const g = guardAt(clock);
    g.onError('DAEMON_FORGOTTEN', 'gone');
    g.onError('DAEMON_FORGOTTEN', 'gone');
    g.onError('DAEMON_FORGOTTEN', 'gone');
    expect(g.shouldDeclare(clock.t)).toBe(false);
    g.onExplicitDeclare();
    expect(g.shouldDeclare(clock.t)).toBe(true);
  });

  it('errors for other frames leave the declare loop and the surface untouched', () => {
    const g = guardAt({ t: 0 });
    expect(g.onError('WITHDRAW_DAEMON_MISMATCH', 'nope').kind).toBe('ignore');
    expect(g.snapshot()).toBeNull();
    expect(g.shouldDeclare(0)).toBe(true);
  });

  it('never refused ⇒ no blocked state at all (healthz shape unchanged)', () => {
    const g = guardAt({ t: 0 });
    expect(g.snapshot()).toBeNull();
    expect(g.shouldDeclare(0)).toBe(true);
  });
});
