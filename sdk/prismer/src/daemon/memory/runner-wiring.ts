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
//
// Maintenance boundary (spec16 §8.1 MA-0S): everything wired here is the
// daemon-internal SYSTEM channel — outbox flush uploads, WS invalidate
// write-down, key-manager unsealing (systemCap()) and post-turn extraction
// (hook-server slot.store.write) all operate IN-PROCESS directly on the
// store. They never enter the agent RPC cap gate, and agents can never
// reach them: agent memory RPC is always fail-closed (rpc.ts). Do NOT route
// maintenance writes through /local/memory/* to "share" code — that would
// either need a system-cap token round-trip or re-open the no-cap bypass
// (M-CAP-001).

import type { EventEmitter } from 'node:events';
import type { CloudClient } from '../../auth.js';
import { MemoryRuntime } from './runtime.js';
import { MemoryOutboxWorker, type OutboxWorkerOptions } from './outbox-worker.js';
import { MemoryKeyManager, isEncryptionEnabled, isEphemeralStorage } from './key-manager.js';
import { systemCap } from './cap.js';
import { attachWsInvalidate } from './ws-invalidate.js';
import { initialSyncFromCloud } from './cloud-sync.js';
import type { DreamScheduler } from './dream/index.js';
import { injectIndexTocForTarget, isIndexInjectEnabled } from './index-toc-inject.js';
import { buildMemoryDigest, setMemoryDigestProvider } from './digest.js';
import { MemoryRecallHooks } from './hooks.js';
import {
  createCloudRecallPolicyProvider,
  getCloudRecallPolicyProvider,
  setCloudRecallPolicyProvider,
  type CloudRecallPolicyProvider,
} from './recall-policy-provider.js';
import {
  getSessionRecallCoordinator,
  SessionRecallCoordinator,
  setSessionRecallCoordinator,
} from './session-recall.js';
import { createLogger } from '../../lib/logger.js';
import { CoalescingRunner, ExponentialBackoff } from '../churn-guard.js';

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
  recallCoordinator: SessionRecallCoordinator;
  recallPolicyProvider: CloudRecallPolicyProvider;
  /**
   * memory202 doc 06: per-workspace at-rest encryption key manager. Shared
   * between the outbox worker (encrypt on flush) and the cloud-sync-down
   * (decrypt on pull). Active behavior is gated on FF_MEMORY_ENCRYPTION_ENABLED;
   * the manager itself is always constructed (cheap) so the seam is wired.
   */
  keyManager: MemoryKeyManager;
  /**
   * Always null. The retired daemon scheduler is kept in source only for
   * historical compatibility tests. Canonical Dream is Cloud wiki-health
   * scheduling → one internal task → appointed workspace orchestrator.
   */
  dreamScheduler: DreamScheduler | null;
  /** Stop worker, detach WS listener, and close every workspace SQLite handle. */
  stop(): void;
}

export function attachMemoryRunner(opts: AttachMemoryRunnerOptions): MemoryRunnerWiring {
  const runtime = new MemoryRuntime({ baseDir: opts.baseDir, deviceId: opts.deviceId });

  // memory211/01 W3 轴E — the hermes adapter renders the turn-start memory
  // digest but owns NO MemoryStore, so this composition point (which owns the
  // runtime) registers the provider the adapter calls. Lazy per call: the store
  // for a workspace is opened on demand and the digest is built fresh, but the
  // TEXT is deterministic for a given store state, so the prompt tail stays
  // cache-stable (see digest.ts). Best-effort: any failure → no injection.
  setMemoryDigestProvider((workspaceId) => {
    try {
      const slot = runtime.peek(workspaceId);
      if (!slot) return null;
      const digest = buildMemoryDigest(slot.store);
      if (!digest) return null;
      return { text: digest.text, version: digest.version, tokenEstimate: digest.tokenEstimate };
    } catch (err) {
      log.warn(`memory digest build failed ws=${workspaceId}: ${(err as Error).message}`);
      return null;
    }
  });
  // spec 11 T5-1/T5-2 — the runner owns MemoryRuntime, so it is the only
  // place that can safely register live recall hooks and their Cloud-backed
  // workspace policy cache for dispatch.
  const recallPolicyProvider = createCloudRecallPolicyProvider(opts.cloud);
  setCloudRecallPolicyProvider(recallPolicyProvider);
  const recallCoordinator = new SessionRecallCoordinator(new MemoryRecallHooks(runtime, opts.deviceId));
  setSessionRecallCoordinator(recallCoordinator);

  // memory202 doc 06: one key manager rooted at the same baseDir as the SQLite
  // stores, so each `.memkey` sits beside its workspace `memory.db`.
  const keyManager = new MemoryKeyManager({
    baseDir: opts.baseDir,
    ...(opts.workerOptions?.log ? { log: opts.workerOptions.log } : {}),
  });

  // memory202 doc 06 — activate at-rest encryption for locally-authored writes.
  // A write with no explicit `encrypted` flag is marked encrypted=true ONLY when
  // ALL hold: FF_MEMORY_ENCRYPTION_ENABLED on, storage is NOT ephemeral, AND a
  // durable workspace key resolves (getKey generates+persists+verifies; null on
  // ephemeral / persist failure → fail-closed to plaintext). The same key the
  // outbox flush will use, via the same system cap, so a marked page can always
  // be encrypted at flush time. Default OFF: flag off ⇒ never auto-encrypt.
  runtime.setEncryptionPolicy((workspaceId) => {
    if (!isEncryptionEnabled() || isEphemeralStorage()) return false;
    return keyManager.getKey(workspaceId, systemCap()) !== null;
  });

  // memory203 canonical ownership: the Cloud scheduler evaluates authoritative
  // wiki-health and dispatches one internal curation task to the appointed
  // workspace orchestrator. The older daemon timer could still be revived by
  // FF_MEMORY_DREAM_ENABLED and call the retired cloud page-dream endpoint,
  // creating two competing trigger authorities. Keep the public handle for
  // compatibility, but make the legacy path unreachable.
  const dreamScheduler: DreamScheduler | null = null;

  const worker = new MemoryOutboxWorker({
    runtime,
    cloud: opts.cloud,
    keyManager,
    ...(opts.workerOptions ?? {}),
  });
  worker.start();

  const dispose = attachWsInvalidate({
    wsClient: opts.wsClient,
    runtime,
    // doc 07 §4 — re-pull fresh subset projection on non-delete invalidate.
    cloud: opts.cloud,
    keyManager,
    ...(opts.invalidateLog ? { log: opts.invalidateLog } : {}),
  });
  let stopped = false;
  return {
    runtime,
    worker,
    recallCoordinator,
    recallPolicyProvider,
    keyManager,
    dreamScheduler,
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
      if (getSessionRecallCoordinator() === recallCoordinator) setSessionRecallCoordinator(null);
      if (getCloudRecallPolicyProvider() === recallPolicyProvider) setCloudRecallPolicyProvider(null);
    },
  };
}

interface MemorySyncPayload {
  cloud: CloudClient;
  workspaceIds: Set<string>;
  resolveIndexInjectTargets?: (workspaceId: string) => string[];
}

/**
 * APC Root B (2026-07-25) — debounce window for the host.acked-driven memory
 * re-sync. A churning `ownership rejected → adopt → re-declare` loop fires
 * `host.acked` several times in a short window, and each one triggers a full
 * per-workspace re-sync. This coalesces those into one. Non-latency-critical
 * (see cloud-dispatcher.ts) so a ~1s quiet window is safe. Env kill-switch:
 * `PRISMER_DAEMON_MEMORY_SYNC_DEBOUNCE_MS` (0 disables debounce entirely).
 */
function memorySyncDebounceMs(): number {
  const n = Number(process.env.PRISMER_DAEMON_MEMORY_SYNC_DEBOUNCE_MS);
  return Number.isFinite(n) && n >= 0 ? n : 1000;
}

// One coalescing runner per wiring (i.e. per daemon Runner). WeakMap so a
// disposed wiring's runner is collectable and tests get a fresh runner per
// fresh wiring object.
const memorySyncRunners = new WeakMap<MemoryRunnerWiring, CoalescingRunner<MemorySyncPayload>>();

/**
 * The actual per-workspace cloud→local sync fan-out for one coalesced trigger.
 * Local-first: a per-workspace failure is logged and skipped (partial progress
 * kept). Rethrows ONLY when EVERY workspace failed, so the CoalescingRunner's
 * backoff engages on a wholesale-unreachable cloud instead of re-firing on the
 * next churn tick.
 */
async function runMemorySyncOnce(
  wiring: MemoryRunnerWiring,
  payload: MemorySyncPayload,
): Promise<void> {
  const uniqueIds = [...payload.workspaceIds].filter(Boolean);
  if (uniqueIds.length === 0) return;

  log.info(`Initial cloud-to-local sync for ${uniqueIds.length} workspace(s)...`);

  let failed = 0;
  for (const wsId of uniqueIds) {
    try {
      // Ensure the store exists for this workspace
      wiring.runtime.resolve(wsId);
      // memory202 doc 06: pass the key manager so encrypted ciphertext pulled
      // from the cloud is decrypted to plaintext before landing in local FTS.
      const result = await initialSyncFromCloud(wiring.runtime, payload.cloud, wsId, wiring.keyManager);
      if (result.pulled > 0 || result.skipped > 0) {
        log.info(
          `workspace=${wsId}: ${result.pulled} pulled, ${result.skipped} skipped`,
        );
      }

      // memory202 doc 05 §4.2a — INDEX dynamic core-inject (flag-gated OFF).
      // After the map has been (re)synced, push its bounded TOC into each
      // hosted agent's existing MEMORY.md core-inject carrier so the agent
      // always has the current memory map in context. No-op unless the flag is
      // on AND a target resolver supplied a MEMORY.md path.
      if (isIndexInjectEnabled() && payload.resolveIndexInjectTargets) {
        const slot = wiring.runtime.peek(wsId);
        if (slot) {
          let injected = 0;
          for (const memoryFilePath of payload.resolveIndexInjectTargets(wsId)) {
            const r = injectIndexTocForTarget({
              store: slot.store,
              memoryFilePath,
              workspaceId: wsId,
            });
            if (r.injected) injected++;
          }
          if (injected > 0) {
            log.info(`workspace=${wsId}: INDEX map injected into ${injected} carrier(s)`);
          }
        }
      }
    } catch (err) {
      failed++;
      log.error(`workspace=${wsId} failed: ${(err as Error).message}`);
    }
  }

  if (failed === uniqueIds.length) {
    // Every workspace failed ⇒ signal the runner's backoff. (Partial failures
    // were already swallowed above to preserve local-first partial progress.)
    throw new Error(`memory sync failed for all ${uniqueIds.length} workspace(s)`);
  }
}

/**
 * One-shot initial sync from cloud for all known workspaces.
 * Fire-and-forget — failures are logged but don't block startup.
 *
 * APC Root B (2026-07-25): DEBOUNCED. Rapid calls (e.g. one per `host.acked`
 * during an adopt/ownership churn) are coalesced into a single per-workspace
 * fan-out, and after a wholesale failure the next run is spaced by an
 * exponential backoff. Returns immediately after arming the (possibly
 * coalesced) run — callers are fire-and-forget and errors are logged inside
 * the fan-out, so no completion signal is lost.
 *
 * `resolveIndexInjectTargets` (memory202 doc 05 §4.2a) — optional resolver
 * mapping a just-synced workspace to the agent MEMORY.md carrier path(s) on
 * this device. Kept as an injected callback so this composition module stays
 * decoupled from the hermes adapter's profile-dir resolution. The latest
 * resolver supplied within a debounce window wins.
 */
export function syncMemoryFromCloud(
  wiring: MemoryRunnerWiring,
  cloud: CloudClient,
  workspaceIds: string[],
  resolveIndexInjectTargets?: (workspaceId: string) => string[],
): Promise<void> {
  const ids = workspaceIds.filter(Boolean);
  if (ids.length === 0) return Promise.resolve();

  let runner = memorySyncRunners.get(wiring);
  if (!runner) {
    runner = new CoalescingRunner<MemorySyncPayload>({
      debounceMs: memorySyncDebounceMs(),
      backoff: new ExponentialBackoff({ baseMs: 2_000, maxMs: 60_000 }),
      merge: (prev, next) =>
        prev === undefined
          ? next
          : {
              // Latest client + resolver win; workspace ids accumulate.
              cloud: next.cloud,
              resolveIndexInjectTargets:
                next.resolveIndexInjectTargets ?? prev.resolveIndexInjectTargets,
              workspaceIds: new Set([...prev.workspaceIds, ...next.workspaceIds]),
            },
      run: (payload) => runMemorySyncOnce(wiring, payload),
    });
    memorySyncRunners.set(wiring, runner);
  }

  runner.trigger({
    cloud,
    workspaceIds: new Set(ids),
    ...(resolveIndexInjectTargets ? { resolveIndexInjectTargets } : {}),
  });
  return Promise.resolve();
}
