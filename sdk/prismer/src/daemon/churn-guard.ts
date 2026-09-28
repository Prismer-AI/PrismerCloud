// Churn dampers for the daemon's cloud sync/ack paths (APC Root B, 2026-07-25).
//
// Gap A (see cloud-dispatcher.ts) capped the *blast radius* of a request storm
// with a bounded global fetch dispatcher — but it deliberately did NOT treat the
// storm's *source*. Root B is that source:
//
//   A churning adopt/ownership loop (`ownership rejected → adopt → re-declare`)
//   makes `host.acked` fire many times in a short window, and EACH `host.acked`
//   used to (a) re-run a full-workspace memory sync and (b) the skill-sync path
//   re-acks every skill — with NO backoff between attempts and NO coalescing of
//   the rapid triggers. Against a slow cloud this is a self-amplifying storm
//   (observed: `skill sync ack failed` ×85 / `Request aborted/timeout` ×107).
//
// Two primitives here, both pure + injectable (clock/rng) so they can be
// unit-tested for the REAL behaviour rather than a mock of it:
//
//   - ExponentialBackoff — failure-count → next-attempt delay (base·factor^n,
//     capped, jittered). Reset on success. Used to gate the skill-sync ack so a
//     slug that just failed is not re-acked on every churn tick.
//   - CoalescingRunner   — merges rapid triggers into a single trailing run, and
//     spaces retries by an ExponentialBackoff after a failed run. Used to
//     collapse the N-per-window memory syncs into one.
//
// Neither primitive sleeps to hide a race and neither loosens any assertion —
// they change the retry/trigger *cadence*, which is the actual defect.

export interface ExponentialBackoffOptions {
  /** Delay after the FIRST failure (un-jittered). */
  baseMs: number;
  /** Growth multiplier per additional failure. Default 2 (exponential). */
  factor?: number;
  /** Upper bound on the un-jittered delay. */
  maxMs: number;
  /** Jitter as a fraction of the delay, applied ± (default 0.2 = ±20%). */
  jitter?: number;
  /** Injectable RNG in [0,1). Default Math.random. */
  rng?: () => number;
  /** Injectable clock. Default Date.now. */
  now?: () => number;
}

/**
 * Tracks consecutive failures and derives an exponentially-growing, jittered
 * delay before the next attempt is allowed. `ready()` is the wall-clock gate;
 * `nextDelayMs()`/`baseDelayMs()` expose the schedule for callers that arm
 * their own timers.
 */
export class ExponentialBackoff {
  private failures = 0;
  private nextAttemptAt = 0;
  private readonly factor: number;
  private readonly jitter: number;
  private readonly rng: () => number;
  private readonly clock: () => number;

  constructor(private readonly opts: ExponentialBackoffOptions) {
    this.factor = opts.factor ?? 2;
    this.jitter = opts.jitter ?? 0.2;
    this.rng = opts.rng ?? Math.random;
    this.clock = opts.now ?? Date.now;
  }

  get failureCount(): number {
    return this.failures;
  }

  /** Un-jittered delay for the current failure count. 0 when healthy. */
  baseDelayMs(): number {
    if (this.failures === 0) return 0;
    const raw = this.opts.baseMs * this.factor ** (this.failures - 1);
    return Math.min(raw, this.opts.maxMs);
  }

  /**
   * Jittered delay to wait before the next attempt. 0 when healthy. Each call
   * draws fresh jitter, so it is only meaningful to call once per scheduling
   * decision (recordFailure captures it into nextAttemptAt).
   */
  nextDelayMs(): number {
    const base = this.baseDelayMs();
    if (base === 0) return 0;
    const spread = this.jitter * base;
    // rng in [0,1) → factor in [-1,1) → ±spread around base.
    return Math.max(0, base + (this.rng() * 2 - 1) * spread);
  }

  /** Record a failed attempt: bump the counter and arm the next-attempt gate. */
  recordFailure(): void {
    this.failures += 1;
    this.nextAttemptAt = this.clock() + this.nextDelayMs();
  }

  /** Record a success: clear the failure streak and the gate. */
  recordSuccess(): void {
    this.failures = 0;
    this.nextAttemptAt = 0;
  }

  /** True once the backoff window has elapsed (always true when healthy). */
  ready(): boolean {
    return this.clock() >= this.nextAttemptAt;
  }

  /** Milliseconds remaining until the next attempt is allowed (0 when ready). */
  remainingMs(): number {
    return Math.max(0, this.nextAttemptAt - this.clock());
  }
}

export interface CoalescingRunnerOptions<P> {
  /** The actual work. Rejecting engages the backoff; resolving resets it. */
  run: (payload: P) => Promise<void>;
  /** Fold a new trigger's payload into the pending one. */
  merge: (prev: P | undefined, next: P) => P;
  /** Minimum quiet window before a coalesced run fires. */
  debounceMs: number;
  /** Spaces retries after a failed run. */
  backoff: ExponentialBackoff;
}

/**
 * Collapses rapid `trigger()` calls into a single trailing `run()`. While a run
 * is in flight, further triggers are folded into a fresh pending payload and
 * one follow-up run is scheduled after it settles. After a failed run the next
 * run is delayed by the backoff (so a slow/down cloud is retried with growing
 * spacing instead of on every churn tick).
 */
export class CoalescingRunner<P> {
  private pending: P | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;

  constructor(private readonly opts: CoalescingRunnerOptions<P>) {}

  trigger(payload: P): void {
    this.pending = this.opts.merge(this.pending, payload);
    this.schedule();
  }

  /** Introspection for tests: is a flush armed or in flight? */
  get isActive(): boolean {
    return this.running || this.timer !== undefined;
  }

  private schedule(): void {
    if (this.timer !== undefined || this.running) return;
    if (this.pending === undefined) return;
    const delay = Math.max(this.opts.debounceMs, this.opts.backoff.remainingMs());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, delay);
    // A pending sync must never keep the process alive on its own.
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  private async flush(): Promise<void> {
    if (this.running || this.pending === undefined) return;
    this.running = true;
    const payload = this.pending;
    this.pending = undefined;
    try {
      await this.opts.run(payload);
      this.opts.backoff.recordSuccess();
    } catch {
      this.opts.backoff.recordFailure();
      // Re-queue the failed payload (merged under anything that arrived
      // meanwhile) so the backoff actually gets something to retry.
      this.pending =
        this.pending === undefined ? payload : this.opts.merge(payload, this.pending);
    } finally {
      this.running = false;
      this.schedule();
    }
  }
}
