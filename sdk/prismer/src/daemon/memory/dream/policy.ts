// Dream scheduler policy — pure functions, no side effects (M-C, doc 25 §3 支柱 3).
//
// The scheduler asks two questions every tick:
//
//   1. canRunNow(host activity timestamp) — is the host idle enough that
//      a Dream pass won't visibly impact the user? (idle gate)
//   2. shouldDreamSchedule(per-workspace tracking state) — has enough
//      time / activity passed since the last Dream that we should run
//      one now?
//
// Both functions are pure so the scheduler test can drive them without
// faking timers. The tracking state is owned by the scheduler module —
// see scheduler.ts for the Map<workspaceId, WorkspaceTrackingState>.

/**
 * Idle window: the host must NOT have made an LLM-relevant call within
 * this many milliseconds for Dream to fire. Mirrors CC's
 * `getLastInteractionTime() > now - 60s` check from
 * `luminclaw/ref/CC-Source/src/utils/backgroundHousekeeping.ts:31-94`.
 */
export const DREAM_IDLE_WINDOW_MS = 60 * 1000;

/** Minimum interval between Dream runs for the same workspace. Prevents
 *  the scheduler from re-running every tick after a long-idle period. */
export const DREAM_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Number of completed sessions since last Dream that lowers the bar
 *  to "run anyway", even before DREAM_MIN_INTERVAL_MS elapses. */
export const DREAM_SESSION_THRESHOLD = 5;

/** Per-workspace lock TTL. If a Dream run is in flight (or crashed),
 *  the lock prevents duplicate ticks from racing for this duration. */
export const DREAM_LOCK_TTL_MS = 30 * 60 * 1000;

export interface WorkspaceTrackingState {
  /** Wallclock of the last Dream tick that COMPLETED (success or failure). */
  lastDreamAt?: number;
  /** Wallclock of the most recent host activity that affected this
   *  workspace (any LLM call, tool dispatch, fork). Updated externally. */
  lastActivityAt?: number;
  /** Count of agent sessions that ended in this workspace since the
   *  last Dream tick. Used by the session-count gate. */
  sessionsSinceLastDream?: number;
  /** When set, Dream is currently running (or crashed mid-run); skip
   *  ticks until either the run finishes or the lock expires. */
  lockHeldUntil?: number;
}

export interface SchedulerDecision {
  shouldRun: boolean;
  reason: string;
}

/**
 * Decide whether the scheduler should run a Dream pass for this
 * workspace right now. The combined idle + interval + session-count
 * gates approximate CC's `initAutoDream` policy.
 */
export function decideDreamRun(
  state: WorkspaceTrackingState,
  now: number,
): SchedulerDecision {
  if (state.lockHeldUntil !== undefined && state.lockHeldUntil > now) {
    return { shouldRun: false, reason: 'lock_held' };
  }
  // Idle gate: doc 25 acceptance §M-C explicitly requires
  // `dream_run_idle_violation_count == 0`. Skip the run if the user
  // touched the workspace within the idle window.
  if (state.lastActivityAt !== undefined && now - state.lastActivityAt < DREAM_IDLE_WINDOW_MS) {
    return { shouldRun: false, reason: 'host_active' };
  }
  // First-time path: run if any session has happened.
  if (state.lastDreamAt === undefined) {
    if ((state.sessionsSinceLastDream ?? 0) > 0) {
      return { shouldRun: true, reason: 'first_run_with_sessions' };
    }
    return { shouldRun: false, reason: 'no_sessions_yet' };
  }
  const elapsed = now - state.lastDreamAt;
  if (elapsed >= DREAM_MIN_INTERVAL_MS) {
    return { shouldRun: true, reason: 'interval_elapsed' };
  }
  if ((state.sessionsSinceLastDream ?? 0) >= DREAM_SESSION_THRESHOLD) {
    return { shouldRun: true, reason: 'session_threshold' };
  }
  return { shouldRun: false, reason: 'too_soon' };
}

/**
 * Acquire the per-workspace Dream lock by mutating tracking state.
 * Returns the same state object for fluent chaining. Caller is the
 * scheduler tick — it must release via `releaseDreamLock` after the
 * runner finishes (success or failure).
 */
export function acquireDreamLock(state: WorkspaceTrackingState, now: number): WorkspaceTrackingState {
  return { ...state, lockHeldUntil: now + DREAM_LOCK_TTL_MS };
}

export function releaseDreamLock(state: WorkspaceTrackingState, now: number): WorkspaceTrackingState {
  const next: WorkspaceTrackingState = { ...state, lastDreamAt: now, sessionsSinceLastDream: 0 };
  delete next.lockHeldUntil;
  return next;
}

/** Stamp the workspace as touched by the host. Called by adapter glue
 *  on every LLM call / tool dispatch so the idle gate can see live
 *  activity. */
export function bumpActivity(state: WorkspaceTrackingState, now: number): WorkspaceTrackingState {
  return { ...state, lastActivityAt: now };
}

/** Increment the session counter — called from Hermes provider's
 *  on_session_end equivalent path. */
export function incrementSessionCount(state: WorkspaceTrackingState): WorkspaceTrackingState {
  return { ...state, sessionsSinceLastDream: (state.sessionsSinceLastDream ?? 0) + 1 };
}
