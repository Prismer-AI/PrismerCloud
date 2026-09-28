// APC Root B (2026-07-25) — churn-guard primitives.
//
// These assert the REAL cadence behaviour the daemon relies on:
//   - ExponentialBackoff: retry interval GROWS geometrically, is capped +
//     jittered, and resets on success.
//   - CoalescingRunner: N rapid triggers collapse to exactly ONE run, and a
//     failed run spaces its retry by the backoff (not the debounce window).
//
// Each block includes the mutation it is designed to catch (constant interval /
// no debounce / no backoff), so a regression that flattens the cadence turns
// these red instead of silently passing.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoalescingRunner, ExponentialBackoff } from '../src/daemon/churn-guard.js';

describe('ExponentialBackoff', () => {
  it('is healthy (zero delay, ready) with no failures', () => {
    const b = new ExponentialBackoff({ baseMs: 100, maxMs: 10_000 });
    expect(b.failureCount).toBe(0);
    expect(b.baseDelayMs()).toBe(0);
    expect(b.nextDelayMs()).toBe(0);
    expect(b.ready()).toBe(true);
  });

  it('retry interval grows EXPONENTIALLY, not constant', () => {
    // rng=0.5 ⇒ jitter term (0.5*2-1)=0 ⇒ nextDelayMs === baseDelayMs exactly.
    const b = new ExponentialBackoff({ baseMs: 100, maxMs: 1_000_000, factor: 2, rng: () => 0.5 });
    b.recordFailure();
    const d1 = b.nextDelayMs();
    b.recordFailure();
    const d2 = b.nextDelayMs();
    b.recordFailure();
    const d3 = b.nextDelayMs();

    expect(d1).toBe(100);
    expect(d2).toBe(200);
    expect(d3).toBe(400);
    // MUTATION GUARD: a constant-interval backoff makes these equal → red.
    expect(d2).toBeGreaterThan(d1);
    expect(d3).toBeGreaterThan(d2);
    expect(d2 / d1).toBeCloseTo(2);
    expect(d3 / d2).toBeCloseTo(2);
  });

  it('caps the delay at maxMs', () => {
    const b = new ExponentialBackoff({ baseMs: 100, maxMs: 250, rng: () => 0.5 });
    b.recordFailure(); // 100
    b.recordFailure(); // 200
    b.recordFailure(); // min(400,250)=250
    expect(b.nextDelayMs()).toBe(250);
    b.recordFailure(); // min(800,250)=250
    expect(b.nextDelayMs()).toBe(250);
  });

  it('applies ± jitter within bounds', () => {
    const low = new ExponentialBackoff({ baseMs: 1_000, maxMs: 10_000, jitter: 0.2, rng: () => 0 });
    const high = new ExponentialBackoff({ baseMs: 1_000, maxMs: 10_000, jitter: 0.2, rng: () => 0.999999 });
    low.recordFailure();
    high.recordFailure();
    expect(low.nextDelayMs()).toBeCloseTo(800, 0); // 1000*(1-0.2)
    expect(high.nextDelayMs()).toBeGreaterThan(1_190);
    expect(high.nextDelayMs()).toBeLessThanOrEqual(1_200); // 1000*(1+0.2)
  });

  it('gates attempts on a wall clock and clears on success', () => {
    let t = 0;
    const b = new ExponentialBackoff({ baseMs: 100, maxMs: 10_000, rng: () => 0.5, now: () => t });
    b.recordFailure(); // nextAttemptAt = 0 + 100
    expect(b.ready()).toBe(false);
    expect(b.remainingMs()).toBe(100);

    t = 99;
    expect(b.ready()).toBe(false);
    t = 100;
    expect(b.ready()).toBe(true);
    expect(b.remainingMs()).toBe(0);

    // success resets streak + gate
    b.recordFailure(); // streak grows again
    expect(b.failureCount).toBe(2);
    b.recordSuccess();
    expect(b.failureCount).toBe(0);
    expect(b.nextDelayMs()).toBe(0);
    expect(b.ready()).toBe(true);
  });
});

describe('CoalescingRunner', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function mkRunner(run: (p: number[]) => Promise<void>, opts?: { debounceMs?: number; backoff?: ExponentialBackoff }) {
    return new CoalescingRunner<number[]>({
      run,
      merge: (prev, next) => [...(prev ?? []), ...next],
      debounceMs: opts?.debounceMs ?? 50,
      backoff: opts?.backoff ?? new ExponentialBackoff({ baseMs: 1_000, maxMs: 60_000 }),
    });
  }

  it('collapses N rapid triggers into exactly ONE run with the merged payload', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    const runner = mkRunner(run);

    runner.trigger([1]);
    runner.trigger([2]);
    runner.trigger([3]);
    expect(run).not.toHaveBeenCalled(); // nothing fires synchronously

    await vi.advanceTimersByTimeAsync(50);
    // MUTATION GUARD: drop the debounce and each trigger runs immediately → 3.
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith([1, 2, 3]);
  });

  it('runs again for triggers that arrive after a completed run', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    const runner = mkRunner(run);

    runner.trigger([1]);
    await vi.advanceTimersByTimeAsync(50);
    expect(run).toHaveBeenCalledTimes(1);

    runner.trigger([2]);
    await vi.advanceTimersByTimeAsync(50);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenLastCalledWith([2]);
  });

  it('spaces the retry of a FAILED run by the backoff, not the debounce', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {
      throw new Error('cloud down');
    });
    // base 1s, rng=0.5 ⇒ deterministic 1s first-failure window.
    const backoff = new ExponentialBackoff({ baseMs: 1_000, maxMs: 60_000, rng: () => 0.5 });
    const runner = mkRunner(run, { debounceMs: 50, backoff });

    runner.trigger([1]);
    await vi.advanceTimersByTimeAsync(50);
    expect(run).toHaveBeenCalledTimes(1); // first run fires + fails → backoff arms

    await vi.advanceTimersByTimeAsync(500); // still inside the ~1s backoff window
    // MUTATION GUARD: without backoff the failed payload re-runs every 50ms →
    // this would already be well above 1.
    expect(run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000); // now past the backoff window
    expect(run).toHaveBeenCalledTimes(2);
  });
});
