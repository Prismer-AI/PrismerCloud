// Phase-1 memory subsystem wiring for the daemon Runner (T1 scope).
//
// T1 wires only the cloud-bound side of the memory subsystem:
//
//   1. instantiates `MemoryRuntime` (multi-workspace SQLite pool)
//   2. starts `MemoryOutboxWorker` against it (polls memory_outbox → cloud)
//   3. attaches `attachWsInvalidate` to the daemon's WsClient (cloud → SQLite)
//
// Returned `MemoryRunnerWiring` exposes the runtime + worker handles, plus a
// `stop()` that cleanly tears down the worker timer, detaches the WS
// listener, and closes every per-workspace SQLite handle.
//
// Out of scope for T1 — local HTTP RPC routes (`/local/memory/*` via
// `attachMemoryRpc`) are deliberately NOT wired here. They land in T2 when
// the Hermes provider integration arrives and needs them as its transport;
// `runtime` is already exposed on the returned handle so T2 can attach the
// RPC routes onto the existing `LocalServer` without re-instantiating the
// runtime or duplicating the worker/invalidate plumbing.
//
// This module is intentionally tiny — its job is composition, not behavior.
// All interesting logic lives in runtime.ts / outbox-worker.ts /
// ws-invalidate.ts and is unit-tested there. The runner-side test only
// has to verify "calling attachMemoryRunner returns a wiring whose worker
// is started, ws listener is attached, and stop() unwires both."

import type { EventEmitter } from 'node:events';
import type { CloudClient } from '../../auth.js';
import { MemoryRuntime } from './runtime.js';
import { MemoryOutboxWorker, type OutboxWorkerOptions } from './outbox-worker.js';
import { attachWsInvalidate } from './ws-invalidate.js';
import { initialSyncFromCloud } from './cloud-sync.js';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('MemorySync');

export interface AttachMemoryRunnerOptions {
  /** Daemon's primary cloud client — outbox worker POSTs to /memory/sync/inbox via this. */
  cloud: CloudClient;
  /** Daemon's primary WsClient (extends EventEmitter; emits parsed `message` events). */
  wsClient: EventEmitter;
  /** Filesystem root for per-workspace SQLite files (e.g. `${HOME}/.prismer/memory`). */
  baseDir: string;
  /** Stamped onto outbox + version rows. Defaults to the daemon_id. */
  deviceId: string;
  /**
   * Optional overrides forwarded to `MemoryOutboxWorker`. The default
   * (poll every 5s, batch 50, log to stdout/stderr) matches phase-1 spec
   * and is what production should use.
   */
  workerOptions?: Pick<OutboxWorkerOptions, 'pollIntervalMs' | 'batchSize' | 'maxConsecutiveFailures' | 'log'>;
  /** Optional log routing for the WS invalidate listener. */
  invalidateLog?: { info: (m: string) => void; warn: (m: string) => void };
}

export interface MemoryRunnerWiring {
  runtime: MemoryRuntime;
  worker: MemoryOutboxWorker;
  /** Stop worker, detach WS listener, close every workspace SQLite handle. */
  stop(): void;
}

export function attachMemoryRunner(opts: AttachMemoryRunnerOptions): MemoryRunnerWiring {
  const runtime = new MemoryRuntime({ baseDir: opts.baseDir, deviceId: opts.deviceId });
  const worker = new MemoryOutboxWorker({
    runtime,
    cloud: opts.cloud,
    ...(opts.workerOptions ?? {}),
  });
  worker.start();
  const dispose = attachWsInvalidate({
    wsClient: opts.wsClient,
    runtime,
    ...(opts.invalidateLog ? { log: opts.invalidateLog } : {}),
  });
  let stopped = false;
  return {
    runtime,
    worker,
    stop(): void {
      if (stopped) return;
      stopped = true;
      worker.stop();
      dispose();
      try {
        runtime.closeAll();
      } catch {
        /* best-effort */
      }
    },
  };
}

/**
 * One-shot initial sync from cloud for all known workspaces.
 * Fire-and-forget — failures are logged but don't block startup.
 *
 * Unlike `initialSyncFromCloud`, this function resolves each workspace
 * (creating the store if it doesn't exist) before syncing, so callers
 * (e.g. runner.ts) don't need to pre-resolve.
 */
export async function syncMemoryFromCloud(
  wiring: MemoryRunnerWiring,
  cloud: CloudClient,
  workspaceIds: string[],
): Promise<void> {
  const uniqueIds = [...new Set(workspaceIds.filter(Boolean))];
  if (uniqueIds.length === 0) return;

  log.info(`Initial cloud-to-local sync for ${uniqueIds.length} workspace(s)...`);

  for (const wsId of uniqueIds) {
    try {
      // Ensure the store exists for this workspace
      wiring.runtime.resolve(wsId);
      const result = await initialSyncFromCloud(wiring.runtime, cloud, wsId);
      if (result.pulled > 0 || result.skipped > 0) {
        log.info(
          `workspace=${wsId}: ${result.pulled} pulled, ${result.skipped} skipped`,
        );
      }
    } catch (err) {
      log.error(`workspace=${wsId} failed: ${(err as Error).message}`);
    }
  }
}
