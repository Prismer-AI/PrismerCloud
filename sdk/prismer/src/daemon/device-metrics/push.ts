/**
 * device-metrics/push.ts — G2-R R-1 (docs/bugfix211/g2-terminal-and-monitor-spec.md §R-1).
 *
 * Pushes `daemon.metrics` frames over the daemon's EXISTING cloud WS
 * connection (same envelope helper as `agent.host.declare` /
 * `task.dispatch.reply`). Payload shape:
 *
 *   { samples: [最新一份], inventory?: {...} }
 *
 * `inventory` rides only the first push or when it actually changed
 * (变更重报) — steady-state pushes are one small sample object.
 *
 * PLUGIN ISOLATION (the ironclad rule): every tick is fire-and-forget and
 * self-capturing. Sampler failure, inventory failure and send failure are
 * each counted and swallowed INSIDE the tick — nothing is retried, nothing
 * is buffered to disk, and nothing ever propagates into the caller's loop.
 * A broken socket costs one counter increment per tick, nothing more.
 */

import { envelope } from '../../envelope.js';
import type { DeviceSample } from './sampler.js';
import type { DeviceInventory } from './inventory.js';
import { resolveDeviceMetricsIntervalMs } from './interval.js';

/** Wire payload of the `daemon.metrics` frame (cloud side: G2-R task 3). */
export interface DaemonMetricsPayload {
  samples: DeviceSample[];
  inventory?: DeviceInventory;
}

export interface PusherDeps {
  daemonId: string;
  intervalMs?: number;
  /** Outbound transport — the runner passes `(frame) => this.ws.send(frame)`. May throw. */
  send: (frame: unknown) => void;
  now?: () => number;
  sampler: { sample(): Promise<DeviceSample> };
  inventoryProvider: () => Promise<DeviceInventory>;
}

export interface PusherStats {
  pushes: number;
  sendErrors: number;
  sampleErrors: number;
  lastPushAt: number | null;
}

export class DeviceMetricsPusher {
  private readonly daemonId: string;
  private readonly send: (frame: unknown) => void;
  private readonly now: () => number;
  private readonly sampler: { sample(): Promise<DeviceSample> };
  private readonly inventoryProvider: () => Promise<DeviceInventory>;

  private timer?: NodeJS.Timeout;
  private intervalMs: number;
  private lastInventoryJson: string | null = null;
  private readonly stats: PusherStats = {
    pushes: 0,
    sendErrors: 0,
    sampleErrors: 0,
    lastPushAt: null,
  };

  constructor(deps: PusherDeps) {
    if (typeof deps.send !== 'function') {
      throw new TypeError('DeviceMetricsPusher: send must be a function');
    }
    if (!deps.daemonId) {
      throw new TypeError('DeviceMetricsPusher: daemonId is required');
    }
    this.daemonId = deps.daemonId;
    this.send = deps.send;
    this.now = deps.now ?? Date.now;
    this.sampler = deps.sampler;
    this.inventoryProvider = deps.inventoryProvider;
    this.intervalMs = resolveDeviceMetricsIntervalMs(deps.intervalMs);
  }

  /** Start pushing. First tick fires immediately, then every interval. Idempotent. */
  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    // Telemetry must never keep the process alive on its own.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Live interval change (spec R1-1 事件性: ConfigDelivery 下发即时生效).
   * Applies from the next tick onward; sub-floor values are clamped by the
   * same resolution rule as boot.
   */
  setIntervalMs(ms: number): void {
    this.intervalMs = resolveDeviceMetricsIntervalMs(ms);
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = setInterval(() => void this.tick(), this.intervalMs);
      this.timer.unref?.();
    }
  }

  getStats(): PusherStats {
    return { ...this.stats };
  }

  private async tick(): Promise<void> {
    // Sampler failure — no sample to push this tick; loop continues.
    let sample: DeviceSample;
    try {
      sample = await this.sampler.sample();
    } catch {
      this.stats.sampleErrors++;
      return;
    }

    // Inventory failure must not block the samples push — degrade to
    // "unchanged" and keep the cadence.
    let inventory: DeviceInventory | undefined;
    try {
      const inv = await this.inventoryProvider();
      if (JSON.stringify(inv) !== this.lastInventoryJson) inventory = inv;
    } catch {
      /* inventory unavailable this tick — samples-only push */
    }

    // Send failure — counted, never retried, never surfaced.
    try {
      const payload: DaemonMetricsPayload = { samples: [sample] };
      if (inventory) payload.inventory = inventory;
      this.send(envelope('daemon.metrics', payload, this.daemonId));
      if (inventory) this.lastInventoryJson = JSON.stringify(inventory);
      this.stats.pushes++;
      this.stats.lastPushAt = this.now();
    } catch {
      this.stats.sendErrors++;
    }
  }
}
