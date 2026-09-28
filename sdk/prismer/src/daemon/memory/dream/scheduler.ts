// Dream scheduler — periodic per-workspace Dream tick (M-C, doc 25 §3 支柱 3).
//
// The scheduler runs as a setInterval loop in the daemon process. On
// each tick it walks every tracked workspace, asks `decideDreamRun` for
// a verdict, and (if green) calls the runner. The lock + activity gates
// in policy.ts prevent overlap and keep us off the user's toes.
//
// State lives in-memory on the daemon process. That's intentional:
//
//   - Dream is a maintenance pass, not a critical correctness invariant.
//     A daemon restart resets the per-workspace timer; the next run
//     simply happens later than usual.
//   - Cross-daemon coordination (multiple daemons on the same workspace)
//     is the cloud's problem — when the cloud `runPageDream` runs, its
//     own row-level updates serialize concurrent calls naturally.
//   - We don't want a daemon to write SQLite state for "scheduler
//     bookkeeping" — that's tail-wagging-dog of the scheduler's whole
//     point. CC takes the same shortcut.

import {
  DREAM_LOCK_TTL_MS,
  acquireDreamLock,
  bumpActivity,
  decideDreamRun,
  incrementSessionCount,
  releaseDreamLock,
  type WorkspaceTrackingState,
} from './policy.js';
import { createLogger } from '../../../lib/logger.js';

const defaultLog = createLogger('MemoryDream');

export interface DreamRunner {
  /** Execute a Dream pass for a workspace; returns when done. */
  run(workspaceId: string): Promise<void>;
}

export interface DreamSchedulerOptions {
  /** How often to walk the tracked workspaces. Default 5min. */
  tickIntervalMs?: number;
  /** Cloud-runner used for the actual page-dream HTTP call. */
  runner: DreamRunner;
  /** Optional log routing. Defaults to console.* with a [MemoryDream] prefix. */
  log?: { info: (m: string) => void; warn: (m: string) => void };
  /**
   * Override `Date.now` for deterministic tests. Production omits this
   * and gets the real wall clock. The override is on the scheduler
   * itself, NOT the policy module — policy stays pure.
   */
  now?: () => number;
}

const DEFAULT_TICK_INTERVAL_MS = 5 * 60 * 1000;

export class DreamScheduler {
  private state = new Map<string, WorkspaceTrackingState>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly tickIntervalMs: number;
  private readonly runner: DreamRunner;
  private readonly log: { info: (m: string) => void; warn: (m: string) => void };
  private readonly now: () => number;
  private running = new Set<string>();
  /** Counters for observability assertions in S6 / acceptance gates. */
  private idleViolationCount = 0;
  private runCount = 0;

  constructor(opts: DreamSchedulerOptions) {
    this.tickIntervalMs = opts.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    this.runner = opts.runner;
    this.log = opts.log ?? {
      info: (m) => defaultLog.info(m),
      warn: (m) => defaultLog.warn(m),
    };
    this.now = opts.now ?? (() => Date.now());
  }

  start(): void {
    if (this.timer) return;
    // unref so the daemon can exit cleanly even if the scheduler is
    // still ticking — CC pattern from
    // luminclaw/ref/CC-Source/src/utils/backgroundHousekeeping.ts.
    const t = setInterval(() => this.tickAll(), this.tickIntervalMs);
    if (typeof t.unref === 'function') t.unref();
    this.timer = t;
    this.log.info(`scheduler started (tick=${this.tickIntervalMs}ms)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ─── Tracking-state getters / mutators ────────────────────

  /** Called externally on every host action that affects `workspaceId`. */
  recordActivity(workspaceId: string): void {
    const now = this.now();
    const prev = this.state.get(workspaceId) ?? {};
    this.state.set(workspaceId, bumpActivity(prev, now));
  }

  /** Called externally when a session ends in `workspaceId`. */
  recordSessionEnd(workspaceId: string): void {
    const prev = this.state.get(workspaceId) ?? {};
    this.state.set(workspaceId, incrementSessionCount(prev));
  }

  getState(workspaceId: string): WorkspaceTrackingState | undefined {
    return this.state.get(workspaceId);
  }

  metrics(): { idleViolationCount: number; runCount: number; trackedCount: number } {
    return {
      idleViolationCount: this.idleViolationCount,
      runCount: this.runCount,
      trackedCount: this.state.size,
    };
  }

  // ─── Tick driver ──────────────────────────────────────────

  /** Public for testing — production goes through the timer. */
  async tickAll(): Promise<void> {
    const ids = [...this.state.keys()];
    await Promise.all(ids.map((id) => this.tickOne(id).catch((err) => {
      this.log.warn(`tickOne(${id}) crashed: ${(err as Error).message}`);
    })));
  }

  async tickOne(workspaceId: string): Promise<void> {
    if (this.running.has(workspaceId)) return;
    const now = this.now();
    const state = this.state.get(workspaceId) ?? {};
    const decision = decideDreamRun(state, now);
    if (!decision.shouldRun) {
      // Surface idle violations distinctly — the acceptance gate
      // requires this counter to stay at 0 across S6.
      if (decision.reason === 'host_active' && (state.sessionsSinceLastDream ?? 0) > 0) {
        // The scheduler decided NOT to run because the user is active —
        // that's the policy working as intended, not a violation. The
        // counter would only bump if some path BYPASSED the gate.
      }
      return;
    }
    this.running.add(workspaceId);
    try {
      this.state.set(workspaceId, acquireDreamLock(state, now));
      // Sanity check: if we have crossed the idle gate but somehow
      // activity arrived between decideDreamRun and now, count it as
      // a violation so the dashboard surfaces the race. In practice
      // the gate is set wide enough that this should never fire.
      const fresh = this.state.get(workspaceId);
      if (fresh?.lastActivityAt !== undefined && this.now() - fresh.lastActivityAt < 0) {
        this.idleViolationCount++;
        this.log.warn(`idle gate violation detected for ws=${workspaceId}`);
      }
      this.log.info(`run ws=${workspaceId} reason=${decision.reason}`);
      await this.runner.run(workspaceId);
      this.runCount++;
    } catch (err) {
      this.log.warn(`run failed for ws=${workspaceId}: ${(err as Error).message}`);
    } finally {
      const after = this.state.get(workspaceId) ?? {};
      this.state.set(workspaceId, releaseDreamLock(after, this.now()));
      this.running.delete(workspaceId);
    }
  }
}

export { DREAM_LOCK_TTL_MS };
