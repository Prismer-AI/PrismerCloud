import * as cp from 'node:child_process';
import type { EventBus } from './event-bus.js';

// ============================================================
// Types
// ============================================================

export type AgentState =
  | 'registered'  // in registry, not yet spawned
  | 'spawning'
  | 'running'
  | 'degraded'    // health probes failing but process up
  | 'crashed'
  | 'backoff'     // waiting for restart
  | 'stopping'
  | 'stopped'
  | 'failed';     // exceeded max restarts

export interface AgentDescriptor {
  id: string;
  name: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  // Called periodically while 'running'. Consecutive failures beyond the threshold
  // cause state → 'degraded'. Returns false or throws to signal unhealthy.
  healthCheck?: () => Promise<boolean> | boolean;
  backoff?: {
    initialMs?: number;    // default 50
    multiplier?: number;   // default 2
    maxMs?: number;        // default 30000
    maxRestarts?: number;  // default 5 — then 'failed'
    resetAfterMs?: number; // default 60000 — clean uptime resets the counter
  };
  // Attach (don't spawn): supervisor tracks this pid but does NOT own lifecycle.
  // stop() sends SIGTERM only — if the process ignores it, the caller must handle it.
  // Crash recovery does NOT restart attached agents.
  attachPid?: number;
}

export interface AgentStatus {
  id: string;
  state: AgentState;
  pid?: number;
  startedAt?: number;
  restarts: number;
  lastExitCode?: number;
  lastSignal?: NodeJS.Signals | null;
  lastHealthError?: string;
  nextRestartAt?: number;
}

export interface SupervisorOptions {
  eventBus: EventBus;
  healthProbeIntervalMs?: number; // default 5000
  degradedThreshold?: number;     // default 3 consecutive failures → 'degraded'
  stopTimeoutMs?: number;         // default 5000 — SIGTERM grace period before SIGKILL
}

// ============================================================
// Internal per-agent runtime record
// ============================================================

interface AgentEntry {
  descriptor: AgentDescriptor;
  status: AgentStatus;
  // Owned child process (spawn path). Absent for attached agents.
  child?: cp.ChildProcess;
  // Whether supervisor owns this pid (false for attached agents).
  owned: boolean;
  // Backoff timer handle for pending restart.
  backoffTimer?: NodeJS.Timeout;
  // Health probe interval handle.
  probeInterval?: NodeJS.Timeout;
  // Consecutive health-check failures since last reset.
  consecutiveHealthFailures: number;
  // Timestamp when the current run started (to support resetAfterMs).
  runStartedAt?: number;
}

// Maximum bytes forwarded per stdout/stderr event (1 KB).
const MAX_IO_BYTES = 1024;

// ============================================================
// AgentSupervisor
// ============================================================

export class AgentSupervisor {
  private readonly _bus: EventBus;
  private readonly _probeIntervalMs: number;
  private readonly _degradedThreshold: number;
  private readonly _stopTimeoutMs: number;
  private readonly _agents = new Map<string, AgentEntry>();

  constructor(opts: SupervisorOptions) {
    this._bus = opts.eventBus;
    this._probeIntervalMs = opts.healthProbeIntervalMs ?? 5000;
    this._degradedThreshold = opts.degradedThreshold ?? 3;
    this._stopTimeoutMs = opts.stopTimeoutMs ?? 5000;
  }

  // ----------------------------------------------------------
  // Public API
  // ----------------------------------------------------------

  register(descriptor: AgentDescriptor): void {
    if (this._agents.has(descriptor.id)) {
      throw new Error(`Agent '${descriptor.id}' is already registered`);
    }
    const entry: AgentEntry = {
      descriptor,
      status: {
        id: descriptor.id,
        state: 'registered',
        restarts: 0,
      },
      owned: true,
      consecutiveHealthFailures: 0,
    };
    this._agents.set(descriptor.id, entry);
    this._publish('agent.registered', { id: descriptor.id });
  }

  async unregister(id: string): Promise<void> {
    const entry = this._require(id);
    const { state } = entry.status;
    if (state !== 'registered' && state !== 'stopped' && state !== 'failed') {
      await this.stop(id, 'unregister');
    }
    this._agents.delete(id);
  }

  async spawn(id: string): Promise<void> {
    const entry = this._require(id);
    if (entry.status.state !== 'registered') {
      throw new Error(
        `Agent '${id}' must be in 'registered' state to spawn (current: '${entry.status.state}')`,
      );
    }
    await this._doSpawn(entry);
  }

  async stop(id: string, reason?: string): Promise<void> {
    const entry = this._require(id);
    const { state } = entry.status;

    // Cancel any pending restart first so we don't re-spawn after stopping.
    this._cancelBackoff(entry);
    this._stopProbe(entry);

    if (state === 'stopped' || state === 'registered' || state === 'failed') {
      entry.status.state = 'stopped';
      return;
    }

    entry.status.state = 'stopping';
    this._publish('agent.stopping', { id, reason });

    if (entry.owned && entry.child) {
      await this._killOwned(entry);
    } else if (!entry.owned && entry.status.pid !== undefined) {
      // Attached agent: polite SIGTERM only — we do not SIGKILL.
      try {
        process.kill(entry.status.pid, 'SIGTERM');
      } catch {
        // Already gone — treat as stopped.
      }
    }

    entry.status.state = 'stopped';
    entry.status.pid = undefined;
    entry.child = undefined;
    this._publish('agent.stopped', { id });
  }

  async restart(id: string): Promise<void> {
    const entry = this._require(id);
    this._cancelBackoff(entry);
    this._stopProbe(entry);

    if (entry.child) {
      await this._killOwned(entry);
      entry.child = undefined;
    }

    entry.status.state = 'registered';
    entry.status.restarts = 0;
    await this._doSpawn(entry);
  }

  // Track an external PID without spawning or owning its lifecycle.
  // Health probes still run if the descriptor has healthCheck.
  // On exit, transitions to 'stopped' (not 'crashed') — no restart.
  async attach(id: string, pid: number): Promise<void> {
    const entry = this._require(id);

    entry.owned = false;
    entry.status.pid = pid;
    entry.status.state = 'running';
    entry.status.startedAt = Date.now();
    entry.runStartedAt = entry.status.startedAt;

    this._publish('agent.running', { id, pid });
    this._startProbe(entry);

    // Poll for PID disappearance on a best-effort basis (1-second tick).
    // When the attached process exits, emit agent.exited and move to stopped.
    this._pollAttached(entry);
  }

  get(id: string): AgentStatus | undefined {
    const entry = this._agents.get(id);
    return entry ? { ...entry.status } : undefined;
  }

  list(): AgentStatus[] {
    return Array.from(this._agents.values()).map((e) => ({ ...e.status }));
  }

  async shutdown(): Promise<void> {
    const ids = Array.from(this._agents.keys());
    await Promise.all(ids.map((id) => this.stop(id, 'shutdown').catch(() => undefined)));
    this._agents.clear();
  }

  // ----------------------------------------------------------
  // Spawn internals
  // ----------------------------------------------------------

  private async _doSpawn(entry: AgentEntry): Promise<void> {
    const { descriptor, status } = entry;
    const id = descriptor.id;

    status.state = 'spawning';
    entry.consecutiveHealthFailures = 0;
    this._publish('agent.spawning', { id });

    let child: cp.ChildProcess;
    try {
      child = cp.spawn(descriptor.command, descriptor.args ?? [], {
        cwd: descriptor.cwd,
        env: descriptor.env,
        stdio: 'pipe',
      });
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      status.state = 'crashed';
      this._publish('agent.crashed', { id, reason });
      this._scheduleRestart(entry);
      return;
    }

    entry.child = child;
    entry.owned = true;
    status.pid = child.pid;
    status.startedAt = Date.now();
    entry.runStartedAt = status.startedAt;

    // Forward stdout/stderr as events, capped at MAX_IO_BYTES per chunk.
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').slice(0, MAX_IO_BYTES);
      this._publish('agent.stdout', { id, text });
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').slice(0, MAX_IO_BYTES);
      this._publish('agent.stderr', { id, text });
    });

    // Spawn-time error (e.g. ENOENT — process never started).
    child.once('error', (err) => {
      if (status.state === 'stopping' || status.state === 'stopped') return;
      status.state = 'crashed';
      this._publish('agent.crashed', { id, reason: err.message });
      this._stopProbe(entry);
      entry.child = undefined;
      this._scheduleRestart(entry);
    });

    child.once('exit', (code, signal) => {
      if (status.state === 'stopping' || status.state === 'stopped') return;
      this._stopProbe(entry);
      entry.child = undefined;
      status.lastExitCode = code ?? undefined;
      status.lastSignal = signal;
      status.pid = undefined;
      this._publish('agent.exited', { id, code, signal });
      this._handleCrash(entry);
    });

    status.state = 'running';
    this._publish('agent.running', { id, pid: child.pid });
    this._startProbe(entry);
  }

  // ----------------------------------------------------------
  // Crash recovery
  // ----------------------------------------------------------

  private _handleCrash(entry: AgentEntry): void {
    const { status } = entry;
    const id = entry.descriptor.id;

    status.state = 'crashed';
    this._publish('agent.crashed', { id, reason: `exited: code=${status.lastExitCode ?? 'null'} signal=${status.lastSignal ?? 'null'}` });

    this._scheduleRestart(entry);
  }

  private _scheduleRestart(entry: AgentEntry): void {
    const { descriptor, status } = entry;
    const id = descriptor.id;
    const cfg = descriptor.backoff ?? {};
    const initialMs = cfg.initialMs ?? 50;
    const multiplier = cfg.multiplier ?? 2;
    const maxMs = cfg.maxMs ?? 30000;
    const maxRestarts = cfg.maxRestarts ?? 5;
    const resetAfterMs = cfg.resetAfterMs ?? 60000;

    // If the agent ran cleanly for more than resetAfterMs before this crash, reset counter.
    if (entry.runStartedAt !== undefined) {
      const uptime = Date.now() - entry.runStartedAt;
      if (uptime >= resetAfterMs) {
        status.restarts = 0;
      }
    }

    if (status.restarts >= maxRestarts) {
      status.state = 'failed';
      this._publish('agent.failed', { id, reason: `exceeded maxRestarts (${maxRestarts})` });
      return;
    }

    const delay = Math.min(initialMs * Math.pow(multiplier, status.restarts), maxMs);
    const attempt = status.restarts + 1;
    const nextRestartAt = Date.now() + delay;
    status.nextRestartAt = nextRestartAt;
    status.state = 'backoff';
    this._publish('agent.restarting', { id, attempt, delayMs: delay });

    const timer = setTimeout(async () => {
      entry.backoffTimer = undefined;
      status.nextRestartAt = undefined;
      status.restarts++;
      await this._doSpawn(entry);
    }, delay);

    // unref so the timer does not prevent the event loop from exiting in tests.
    timer.unref();
    entry.backoffTimer = timer;
  }

  // ----------------------------------------------------------
  // Stop helpers
  // ----------------------------------------------------------

  // SIGTERM → wait stopTimeoutMs → SIGKILL if still alive → await exit event.
  private _killOwned(entry: AgentEntry): Promise<void> {
    const child = entry.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(killTimer);
        resolve();
      };

      child.once('exit', done);

      try {
        child.kill('SIGTERM');
      } catch {
        // Already dead.
        done();
        return;
      }

      const killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already dead.
        }
      }, this._stopTimeoutMs);
    });
  }

  private _cancelBackoff(entry: AgentEntry): void {
    if (entry.backoffTimer !== undefined) {
      clearTimeout(entry.backoffTimer);
      entry.backoffTimer = undefined;
      entry.status.nextRestartAt = undefined;
    }
  }

  // ----------------------------------------------------------
  // Health probe
  // ----------------------------------------------------------

  private _startProbe(entry: AgentEntry): void {
    if (!entry.descriptor.healthCheck) return;
    this._stopProbe(entry); // clear any stale interval

    const interval = setInterval(async () => {
      await this._runProbe(entry);
    }, this._probeIntervalMs);

    interval.unref();
    entry.probeInterval = interval;
  }

  private _stopProbe(entry: AgentEntry): void {
    if (entry.probeInterval !== undefined) {
      clearInterval(entry.probeInterval);
      entry.probeInterval = undefined;
    }
  }

  private async _runProbe(entry: AgentEntry): Promise<void> {
    const { status, descriptor } = entry;
    if (!descriptor.healthCheck) return;
    if (status.state !== 'running' && status.state !== 'degraded') return;

    let healthy = false;
    let errorMsg: string | undefined;

    try {
      healthy = await descriptor.healthCheck();
    } catch (err: unknown) {
      healthy = false;
      errorMsg = err instanceof Error ? err.message : String(err);
    }

    if (healthy) {
      if (status.state === 'degraded') {
        // Recovery: reset counter, return to running.
        entry.consecutiveHealthFailures = 0;
        status.state = 'running';
        delete status.lastHealthError;
      } else {
        entry.consecutiveHealthFailures = 0;
      }
    } else {
      entry.consecutiveHealthFailures++;
      if (errorMsg !== undefined) {
        status.lastHealthError = errorMsg;
      }
      if (entry.consecutiveHealthFailures >= this._degradedThreshold) {
        status.state = 'degraded';
        this._publish('agent.degraded', { id: descriptor.id, lastHealthError: status.lastHealthError });
      }
    }
  }

  // ----------------------------------------------------------
  // Attach poll
  // ----------------------------------------------------------

  // Periodically check whether an attached (non-owned) PID is still alive.
  // This uses process.kill(pid, 0) as a probe — zero-cost on most platforms.
  private _pollAttached(entry: AgentEntry): void {
    const { status, descriptor } = entry;
    const id = descriptor.id;

    const tick = (): void => {
      if (status.state !== 'running' && status.state !== 'degraded') return;
      const pid = status.pid;
      if (pid === undefined) return;

      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        alive = false;
      }

      if (!alive) {
        this._stopProbe(entry);
        status.state = 'stopped';
        status.pid = undefined;
        this._publish('agent.exited', { id, code: null, signal: null });
        // Attached agents do NOT restart — transition to stopped, not crashed.
        return;
      }

      // Schedule the next poll with unref so it does not block the event loop.
      const t = setTimeout(tick, 1000);
      t.unref();
    };

    const t = setTimeout(tick, 1000);
    t.unref();
  }

  // ----------------------------------------------------------
  // Utilities
  // ----------------------------------------------------------

  private _require(id: string): AgentEntry {
    const entry = this._agents.get(id);
    if (!entry) throw new Error(`Agent '${id}' not found`);
    return entry;
  }

  private _publish(topic: string, payload: Record<string, unknown>): void {
    this._bus.publish(topic, payload, { source: 'supervisor' });
  }
}
