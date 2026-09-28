/**
 * device-metrics/index.ts — G2-R R-1 (docs/bugfix211/g2-terminal-and-monitor-spec.md §R-1).
 *
 * Plugin module assembly for the workspace 设备监视卡 telemetry: composes
 * the device sampler + inventory + WS pusher behind one start/stop surface
 * and declares the `runtime.metrics` capability bit on `agent.host.declare`.
 *
 * PLUGIN ISOLATION (the ironclad rule): `mountDeviceMetrics` is the only
 * thing the runner calls. It is fail-safe BY CONTRACT — any throw during
 * assembly or start is logged, torn down and answered with `null`; the
 * runner then simply runs without telemetry. Dispatch / declare / sync /
 * OTA never observe the module, mounted or not.
 */

import { DeviceMetricsSampler, type DeviceSample } from './sampler.js';
import { collectDeviceInventory, type DeviceInventory } from './inventory.js';
import { DeviceMetricsPusher, type DaemonMetricsPayload, type PusherStats } from './push.js';
import {
  DEFAULT_DEVICE_METRICS_INTERVAL_MS,
  MIN_DEVICE_METRICS_INTERVAL_MS,
  resolveDeviceMetricsIntervalMs,
} from './interval.js';

export { DeviceMetricsSampler, readHostCpuTimes, computeCpuPct, computeProcCpuPct, parseSwapUsedBytesFromMeminfo, defaultStatfsPath } from './sampler.js';
export type { DeviceSample, CpuTimes, StatFsLike, SamplerDeps } from './sampler.js';
export { collectDeviceInventory } from './inventory.js';
export type { DeviceInventory } from './inventory.js';
export { DeviceMetricsPusher } from './push.js';
export type { DaemonMetricsPayload, PusherStats, PusherDeps } from './push.js';
export {
  DEFAULT_DEVICE_METRICS_INTERVAL_MS,
  MIN_DEVICE_METRICS_INTERVAL_MS,
  resolveDeviceMetricsIntervalMs,
} from './interval.js';

/**
 * Capability bit declared on `agent.host.declare` (runtimeCapabilities[])
 * when — and only when — the module actually mounted. Cloud-side consumers
 * treat an absent claim as "device telemetry not offered" (G2-R task 3);
 * the strict-mode memory gate is a subset check, so the extra entry is
 * additive and safe.
 */
export const RUNTIME_CAPABILITY_DEVICE_METRICS = 'runtime.metrics';

export interface DeviceMetricsModuleOptions {
  daemonId: string;
  runtimeVersion: string;
  /** Outbound transport — the runner passes `(frame) => this.ws.send(frame)`. */
  send: (frame: unknown) => void;
  /** Sampling interval. Default 10s, floor 2s (see interval.ts). */
  intervalMs?: number;
  /** Work volume for the disk figures. Defaults to ~/.prismer. */
  statfsPath?: string;
  now?: () => number;
  /**
   * Assembly override — injection seam for the runner-wiring negative
   * control (a throwing factory proves the mount is fail-safe). Production
   * callers never set it.
   */
  createModule?: (opts: DeviceMetricsModuleOptions) => DeviceMetricsModule;
}

/** Composed plugin module: sampler + inventory + pusher behind start/stop. */
export class DeviceMetricsModule {
  readonly pusher: DeviceMetricsPusher;
  private readonly inventoryProvider: () => Promise<DeviceInventory>;

  constructor(opts: DeviceMetricsModuleOptions) {
    if (!opts.daemonId) throw new TypeError('DeviceMetricsModule: daemonId is required');
    if (typeof opts.send !== 'function') {
      throw new TypeError('DeviceMetricsModule: send must be a function');
    }
    this.inventoryProvider = () =>
      collectDeviceInventory({
        daemonId: opts.daemonId,
        runtimeVersion: opts.runtimeVersion,
        ...(opts.statfsPath !== undefined ? { statfsPath: opts.statfsPath } : {}),
      });
    this.pusher = new DeviceMetricsPusher({
      daemonId: opts.daemonId,
      intervalMs: opts.intervalMs,
      send: opts.send,
      now: opts.now,
      sampler: new DeviceMetricsSampler({
        ...(opts.now !== undefined ? { now: opts.now } : {}),
        ...(opts.statfsPath !== undefined ? { statfsPath: opts.statfsPath } : {}),
      }),
      inventoryProvider: this.inventoryProvider,
    });
  }

  start(): void {
    this.pusher.start();
  }

  stop(): void {
    this.pusher.stop();
  }

  setIntervalMs(ms: number): void {
    this.pusher.setIntervalMs(ms);
  }

  getStats(): PusherStats {
    return this.pusher.getStats();
  }
}

/**
 * Fail-safe mount — the runner's ONLY entry point into this module.
 * Returns the started module, or null when assembly/start failed (the
 * failure is logged to stderr and swallowed: plugin stays off, startup
 * continues untouched). A throwing start() gets a defensive stop() so no
 * timer can leak half-mounted.
 */
export function mountDeviceMetrics(opts: DeviceMetricsModuleOptions): DeviceMetricsModule | null {
  let module: DeviceMetricsModule | null = null;
  try {
    module = (opts.createModule ?? ((o) => new DeviceMetricsModule(o)))(opts);
    module.start();
    return module;
  } catch (err) {
    try {
      module?.stop();
    } catch {
      /* teardown of a half-built module is best-effort */
    }
    process.stderr.write(
      `[DeviceMetrics] mount failed (non-fatal — plugin stays off, startup unaffected): ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return null;
  }
}
