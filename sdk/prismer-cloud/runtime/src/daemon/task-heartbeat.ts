// TaskHeartbeat — daemon-side 15s phase heartbeat loop.
//
// See docs/release200/14-messaging-state-machine-reliability.md
//   §3.0.2 Gap B-④ + §4.2 (Daemon heartbeat 协议)
//
// Wire protocol:
//   { type: 'task.heartbeat', payload: TaskHeartbeatPayload }
//
//   TaskHeartbeatPayload {
//     taskId: string
//     heartbeatVersion: number    // monotonically increasing per (daemon, task)
//     currentPhase: string        // daemon-defined free-form ('thinking' | 'tool_use' | ...)
//     lastStepAt?: number          // ms epoch; informational only
//   }
//
// Server-side handler: src/im/ws/handler.ts:1285+ — last-write-wins on
// heartbeatVersion, drops stale frames silently. Cloud's
// sweepStuckPhases reaper flags `currentPhase = 'stuck'` after 45s
// with no fresh heartbeat — it does NOT touch the canonical `status`
// column, so daemon reconnect restoring heartbeats naturally un-sticks
// the task.
//
// Failure semantics (per Wave 3 D2 spec):
//   - ws.send failure → retry 3 times with exponential backoff
//     (100ms / 200ms / 400ms), then give up for this tick.
//   - heartbeat give-up MUST NOT cascade into ws reconnect — heartbeat
//     dying ≠ ws dying. The ws-client owns its own reconnect logic.
//   - next 15s tick attempts fresh send.

import { envelope } from '../envelope.js';

/**
 * Minimal sender contract used by TaskHeartbeat / StepRecorder.
 *
 * The full {@link WsClient} satisfies this trivially, but the narrow
 * shape lets tests inject a fake without standing up a real socket.
 */
export interface WsSender {
  send(msg: unknown): void;
  /** Optional — heartbeat will skip the send when reachable=false. */
  isOpen?(): boolean;
}

export interface TaskHeartbeatOptions {
  ws: WsSender;
  /** Interval between heartbeats. Defaults to 15_000ms (matches §4.2). */
  intervalMs?: number;
  /** Number of retry attempts on ws.send failure. Defaults to 3. */
  maxRetries?: number;
  /** Initial retry backoff (ms). Doubles each retry. Defaults to 100. */
  retryBackoffMs?: number;
  /** Hook for tests/observability — invoked when a give-up happens. */
  onGiveUp?: (taskId: string, err: Error) => void;
  /** Override the wall-clock for tests. Defaults to Date.now. */
  now?: () => number;
}

/**
 * Per-task heartbeat loop.
 *
 * Usage:
 *   const hb = new TaskHeartbeat({ ws });
 *   hb.start(taskId, () => currentPhase);
 *   // ... when adapter changes phase:
 *   hb.setPhase('tool_use');  // immediate push, doesn't wait for tick
 *   // ... when task finishes:
 *   hb.stop();
 *
 * The heartbeat object owns the timer + the heartbeatVersion counter
 * for a single task. Construct a fresh instance per task.
 */
export class TaskHeartbeat {
  private timer?: NodeJS.Timeout;
  private version = 0;
  private taskId?: string;
  private getPhase?: () => string;
  /** Tracks the last step time pushed via touchStep() — informational. */
  private lastStepAt?: number;

  private readonly intervalMs: number;
  private readonly maxRetries: number;
  private readonly retryBackoffMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: TaskHeartbeatOptions) {
    this.intervalMs = opts.intervalMs ?? 15_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.retryBackoffMs = opts.retryBackoffMs ?? 100;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Begin heartbeating for `taskId`. `getPhase` is invoked at every tick to
   * pick up the live phase string — adapters can mutate their phase state
   * freely and the heartbeat will surface it on the next 15s boundary.
   *
   * Calling start() twice on the same instance replaces the active task
   * (previous timer is cleared). Returns silently when already started for
   * the same taskId.
   */
  start(taskId: string, getPhase: () => string): void {
    if (this.taskId === taskId && this.timer) return;
    this.stop();
    this.taskId = taskId;
    this.getPhase = getPhase;
    this.timer = setInterval(() => {
      void this.push();
    }, this.intervalMs);
    // Don't keep the event loop alive solely for heartbeats — if the
    // daemon is otherwise idle, the heartbeat shouldn't block exit.
    this.timer.unref?.();
  }

  /**
   * Stop the heartbeat loop. Idempotent.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.taskId = undefined;
    this.getPhase = undefined;
  }

  /**
   * Phase transition — push immediately AND update what the timer-driven
   * tick will report next time. Adapter calls this whenever the lifecycle
   * advances (thinking → tool_use → reasoning → responding → ...).
   *
   * No-op when no task is active.
   */
  setPhase(phase: string): void {
    if (!this.taskId) return;
    // Replace the cached phase getter so subsequent timer ticks see the
    // new value even if the caller didn't update its own state in lockstep.
    this.getPhase = () => phase;
    void this.push();
  }

  /**
   * Mark "I just made observable progress." Updates lastStepAt; next push
   * (timer-driven or setPhase-driven) carries it. Lightweight — no immediate
   * send. Adapters call this around tool calls / token boundaries so the
   * cloud reaper can distinguish "alive but slow" from "truly stuck".
   */
  touchStep(): void {
    this.lastStepAt = this.now();
  }

  /**
   * Manually trigger one heartbeat send (does not affect the timer). Mainly
   * useful for tests that don't want to await a 15s tick. Returns the
   * heartbeatVersion that was sent, or undefined if no task is active.
   */
  async forceTick(): Promise<number | undefined> {
    if (!this.taskId) return undefined;
    return this.push();
  }

  /** Test helper: current heartbeatVersion (last value sent, may be 0 before first tick). */
  get currentVersion(): number {
    return this.version;
  }

  private async push(): Promise<number | undefined> {
    if (!this.taskId || !this.getPhase) return undefined;
    const taskId = this.taskId;
    const phase = this.getPhase();
    const heartbeatVersion = ++this.version;
    const payload = {
      taskId,
      heartbeatVersion,
      currentPhase: phase,
      ...(this.lastStepAt !== undefined ? { lastStepAt: this.lastStepAt } : {}),
    };
    const msg = envelope('task.heartbeat', payload);

    let lastErr: Error | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        if (this.opts.ws.isOpen && !this.opts.ws.isOpen()) {
          // Socket clearly not OPEN — don't burn retries on a known-down
          // transport. Heartbeats are best-effort; the next 15s tick will
          // try again when the ws may have reconnected.
          return heartbeatVersion;
        }
        this.opts.ws.send(msg);
        return heartbeatVersion;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (attempt < this.maxRetries) {
          const backoff = this.retryBackoffMs * Math.pow(2, attempt);
          await sleep(backoff);
        }
      }
    }

    // Exhausted retries — give up for this tick. Critical: do NOT close
    // ws, do NOT throw out of the timer (would unhandle-reject). The
    // next 15s tick will try again with a fresh heartbeatVersion.
    if (lastErr) {
      try {
        this.opts.onGiveUp?.(taskId, lastErr);
      } catch {
        /* hooks must not propagate */
      }
    }
    return heartbeatVersion;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const handle = setTimeout(resolve, ms);
    handle.unref?.();
  });
}
