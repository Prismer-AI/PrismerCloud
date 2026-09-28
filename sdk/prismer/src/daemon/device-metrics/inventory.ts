/**
 * device-metrics/inventory.ts — G2-R R-1 (docs/bugfix211/g2-terminal-and-monitor-spec.md §R-1).
 *
 * Static device self-description (R1-1 static set). Collected once at mount
 * and then re-checked per push tick — the pusher only WIREs it on the first
 * report or when it actually changed (变更重报), so a resized disk volume
 * reaches the cloud without a re-declare.
 *
 * Zero new dependencies: `os` + `fs.statfs` (Node 18+ built-in).
 */

import * as os from 'node:os';
import { defaultStatfsPath, statfsWorkVolume, type StatFsLike } from './sampler.js';

export interface DeviceInventory {
  hostname: string;
  osType: string;
  osRelease: string;
  arch: string;
  cpuCores: number;
  cpuModel: string;
  memTotal: number;
  /** Work-volume total bytes, or null when statfs fails. */
  diskTotal: number | null;
  runtimeVersion: string;
  daemonId: string;
}

export interface InventoryDeps {
  daemonId: string;
  runtimeVersion: string;
  /** Work volume for diskTotal. Defaults to ~/.prismer. */
  statfsPath?: string;
  /** statfs override (tests). Defaults to fs.promises.statfs. */
  statfs?: (path: string) => Promise<StatFsLike>;
}

export async function collectDeviceInventory(deps: InventoryDeps): Promise<DeviceInventory> {
  let diskTotal: number | null = null;
  try {
    const st = await (deps.statfs ?? statfsWorkVolume)(deps.statfsPath ?? defaultStatfsPath());
    const unit = st.frsize ?? st.bsize;
    diskTotal = Math.max(0, st.blocks * unit);
  } catch {
    // 留白不编数 — volume unreadable ⇒ null, cloud renders 留白.
  }
  const cpus = os.cpus();
  return {
    hostname: os.hostname(),
    osType: os.type(),
    osRelease: os.release(),
    arch: process.arch,
    cpuCores: cpus.length,
    cpuModel: cpus[0]?.model ?? '',
    memTotal: os.totalmem(),
    diskTotal,
    runtimeVersion: deps.runtimeVersion,
    daemonId: deps.daemonId,
  };
}
