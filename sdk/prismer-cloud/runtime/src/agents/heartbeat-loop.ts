/**
 * Prismer Runtime — Background heartbeat loop (Sprint A2.3, D3 liveness).
 *
 * For every agent in `~/.prismer/published-agents.toml`, send a single
 * bulk heartbeat to cloud every `intervalMs` (default 30s). Cloud's
 * sweep job marks agents offline after `heartbeatTimeoutMs` (default 90s)
 * of silence — so 3 missed beats == offline.
 *
 * Design notes:
 *
 *   • Bulk in one HTTP call per tick so 5 agents = 1 request, not 5.
 *   • Best-effort: a 4xx/5xx or network error is logged but never throws
 *     up the call stack — the loop just retries on the next tick. The
 *     daemon itself stays alive even if cloud is unreachable.
 *   • Local "offline protection": if cloud has been unreachable for
 *     more than `offlineProtectMs`, we keep the daemon's local view
 *     of the world (don't surface the cloud-side `offline` to local
 *     consumers). This is policy that the supervisor can read via
 *     `consecutiveFailures`.
 *   • Stop is cooperative — the loop checks `running` between ticks.
 */

import {
  loadPublishedRegistry,
  type PublishedAgent,
} from './published-registry.js';

export interface HeartbeatLoopOptions {
  apiKey: string;
  daemonId: string;
  cloudApiBase: string;
  /** Tick interval in ms. Default 30_000. */
  intervalMs?: number;
  /** ms after which we treat the cloud as durably unreachable. Default 5*60_000. */
  offlineProtectMs?: number;
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Override registry path (tests). */
  registryFile?: string;
  /** Status reporter — defaults to "online" for everything. Override to surface
   *  per-agent crashes from the supervisor. */
  statusFor?: (agent: PublishedAgent) => 'online' | 'busy' | 'idle' | 'crashed';
  /** Fire the first tick synchronously on start. Default true (production:
   *  don't make the user wait `intervalMs` to see initial liveness). Tests
   *  set this to false so they can drive ticks deterministically. */
  fireImmediately?: boolean;
}

export interface HeartbeatLoopHandle {
  stop(): void;
  /** Number of consecutive ticks where the cloud round-trip failed. */
  consecutiveFailures(): number;
  /** Last successful tick timestamp (ms epoch), or 0 if never. */
  lastSuccessAt(): number;
  /** Trigger one tick immediately (test helper / manual flush). */
  tick(): Promise<void>;
}

interface HeartbeatRequest {
  cloudAgentId: string;
  status: 'online' | 'busy' | 'idle' | 'crashed';
  load?: number;
}

export function startHeartbeatLoop(opts: HeartbeatLoopOptions): HeartbeatLoopHandle {
  const intervalMs = opts.intervalMs ?? 30_000;
  const offlineProtectMs = opts.offlineProtectMs ?? 5 * 60_000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const statusFor = opts.statusFor ?? (() => 'online' as const);

  let running = true;
  let consecutiveFailures = 0;
  let lastSuccessAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function tick(): Promise<void> {
    if (!running) return;

    let agents: PublishedAgent[];
    try {
      agents = loadPublishedRegistry(opts.registryFile);
    } catch (err) {
      // Registry corruption shouldn't take the daemon down.
      console.error('[heartbeat] failed to load registry:', (err as Error).message);
      return;
    }

    if (agents.length === 0) return;

    const body: { daemonId: string; agents: HeartbeatRequest[] } = {
      daemonId: opts.daemonId,
      agents: agents.map((a) => ({
        cloudAgentId: a.cloudAgentId,
        status: statusFor(a),
      })),
    };

    try {
      const resp = await fetchImpl(`${opts.cloudApiBase}/api/im/me/agents/heartbeat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        consecutiveFailures++;
        // Read the body for the log but do not let parse errors propagate.
        let text = '';
        try {
          text = (await resp.text()).slice(0, 200);
        } catch {
          /* ignore */
        }
        if (consecutiveFailures % 10 === 1) {
          // Log every 1st, 11th, 21st failure to avoid log spam during
          // sustained outages while still surfacing the issue.
          console.warn(`[heartbeat] tick failed ${consecutiveFailures}× (HTTP ${resp.status}): ${text}`);
        }
        if (consecutiveFailures * intervalMs > offlineProtectMs) {
          // Past the protection window — let the supervisor decide whether
          // to flip local state. We don't take action ourselves so the
          // daemon stays useful for LAN-only consumers.
        }
        return;
      }
      consecutiveFailures = 0;
      lastSuccessAt = Date.now();
    } catch (err) {
      consecutiveFailures++;
      if (consecutiveFailures % 10 === 1) {
        console.warn('[heartbeat] tick failed (network):', (err as Error).message);
      }
    }
  }

  function schedule(): void {
    if (!running) return;
    timer = setTimeout(async () => {
      await tick();
      schedule();
    }, intervalMs);
    // Don't keep the event loop alive just for the heartbeat — daemon
    // stops when its other resources stop.
    if (timer && typeof (timer as any).unref === 'function') {
      (timer as any).unref();
    }
  }

  if (opts.fireImmediately !== false) {
    // Fire one tick immediately so we don't wait `intervalMs` on startup.
    void tick();
  }
  schedule();

  return {
    stop() {
      running = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    consecutiveFailures: () => consecutiveFailures,
    lastSuccessAt: () => lastSuccessAt,
    tick,
  };
}
