/**
 * device-metrics/sampler.ts — G2-R R-1 (docs/bugfix211/g2-terminal-and-monitor-spec.md §R-1).
 *
 * Host-level device sampler for the workspace 设备监视卡. One `sample()`
 * call produces the full R1-1 dynamic field set:
 *   cpuPct, loadavg1/5/15, memUsed/memAvail, swapUsed,
 *   diskUsed/diskAvail (statfs on the ~/.prismer work volume),
 *   procCpuPct/procRss (the daemon process itself), uptimeSec.
 *
 * Coexistence note (deliberate, NOT duplication): the runner already has a
 * cgroup-v2 sampler (`Runner#sampleCgroupResources`, release200 T11) that
 * projects CONTAINER-scoped cpu/mem into /healthz.resources. This sampler is
 * DEVICE-scoped (host `os.cpus()` deltas, `os.totalmem`, `fs.statfs`) — the
 * device card describes the machine, not the container, and the two scopes
 * legitimately differ on every k8s/ACS host. The "sampled by producer, zero
 * I/O projection" PATTERN is what carries over: sampling happens on the
 * module's own timer, never synchronously inside a hot path.
 *
 * Zero new native dependencies: `os` + `fs.statfs` (Node 18+) + `/proc/meminfo`
 * best-effort for swap. Every field degrades honestly — a value that cannot
 * be measured is `null` (留白不编数), never a fabricated zero.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';

/** Aggregated host CPU counters (ms). `idle` includes iowait. */
export interface CpuTimes {
  idle: number;
  total: number;
}

export interface StatFsLike {
  bsize: number;
  frsize?: number;
  blocks: number;
  bfree: number;
  bavail: number;
}

/** One device-metrics sample (R1-1 dynamic set). */
export interface DeviceSample {
  /** Epoch ms of the sample. */
  ts: number;
  /** Host-wide CPU busy percentage, normalized across cores, [0,100]. */
  cpuPct: number;
  loadavg1: number;
  loadavg5: number;
  loadavg15: number;
  memUsed: number;
  memAvail: number;
  /** Swap bytes in use, or null when the host does not expose swap. */
  swapUsed: number | null;
  /** Work-volume used bytes, or null when statfs fails. */
  diskUsed: number | null;
  diskAvail: number | null;
  /** Daemon-process CPU % of total host capacity, [0,100]. */
  procCpuPct: number;
  /** Daemon-process RSS bytes. */
  procRss: number;
  /** Host uptime seconds. */
  uptimeSec: number;
}

export interface SamplerDeps {
  /** Wall clock. Defaults to Date.now. */
  now?: () => number;
  /** Work volume for the disk figures. Defaults to ~/.prismer. */
  statfsPath?: string;
  /** statfs override (tests). Defaults to fs.promises.statfs. */
  statfs?: (path: string) => Promise<StatFsLike>;
  /** Host CPU counter reader (tests). Defaults to an os.cpus() sum. */
  readCpuTimes?: () => CpuTimes;
  /** Process CPU counter reader (tests). Defaults to process.cpuUsage. */
  procCpuUsage?: () => NodeJS.CpuUsage;
}

/** The ~/.prismer work volume — the default statfs target. */
export function defaultStatfsPath(): string {
  return join(os.homedir(), '.prismer');
}

/**
 * Default statfs reader. Node's StatsFs type in some @types/node versions
 * omits `frsize` even though the runtime returns it, so the result is
 * narrowed through an explicit runtime probe instead of a bare cast.
 */
export async function statfsWorkVolume(path: string): Promise<StatFsLike> {
  const st = await fs.promises.statfs(path);
  const frsize = (st as { frsize?: number }).frsize;
  return {
    bsize: st.bsize,
    ...(typeof frsize === 'number' ? { frsize } : {}),
    blocks: st.blocks,
    bfree: st.bfree,
    bavail: st.bavail,
  };
}

/** Host CPU counters from os.cpus(): idle(+iowait) and total over all cores. */
export function readHostCpuTimes(): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
    // iowait is a separate Linux bucket; Node does not fold it into idle on
    // every platform, so add it to both sides explicitly when present.
    const iowait = (t as typeof t & { iowait?: number }).iowait;
    if (typeof iowait === 'number') {
      idle += iowait;
      total += iowait;
    }
  }
  return { idle, total };
}

/**
 * Host CPU busy % between two counter snapshots, normalized to [0,100]
 * (counters already span all cores). Clamp both ends — counter jitter must
 * never produce 103% or -2%.
 */
export function computeCpuPct(prev: CpuTimes, next: CpuTimes): number {
  const dTotal = next.total - prev.total;
  const dIdle = next.idle - prev.idle;
  if (dTotal <= 0) return 0;
  const busy = 1 - dIdle / dTotal;
  return Math.min(100, Math.max(0, busy * 100));
}

/**
 * Daemon-process CPU % between two process.cpuUsage() snapshots (usec),
 * normalized to the machine's total capacity (cores × elapsed) and clamped
 * to [0,100]. Zero elapsed → 0 (never NaN).
 */
export function computeProcCpuPct(
  prevUsec: number,
  nextUsec: number,
  elapsedMs: number,
  cores: number,
): number {
  if (elapsedMs <= 0 || cores <= 0) return 0;
  const usedMs = (nextUsec - prevUsec) / 1_000;
  const pct = (usedMs / (elapsedMs * cores)) * 100;
  return Math.min(100, Math.max(0, pct));
}

/**
 * Swap-in-use bytes from /proc/meminfo content, or null when the lines are
 * missing/malformed (macOS/Windows have no /proc/meminfo — the sampler only
 * calls this on linux).
 */
export function parseSwapUsedBytesFromMeminfo(text: string): number | null {
  const total = text.match(/^SwapTotal:\s+(\d+)\s+kB$/m);
  const free = text.match(/^SwapFree:\s+(\d+)\s+kB$/m);
  if (!total || !free) return null;
  const usedKb = Number.parseInt(total[1]!, 10) - Number.parseInt(free[1]!, 10);
  if (!Number.isFinite(usedKb)) return null;
  return Math.max(0, usedKb * 1024);
}

function readSwapUsedBytes(): number | null {
  if (process.platform !== 'linux') return null;
  try {
    return parseSwapUsedBytesFromMeminfo(fs.readFileSync('/proc/meminfo', 'utf-8'));
  } catch {
    return null;
  }
}

export class DeviceMetricsSampler {
  private readonly now: () => number;
  private readonly statfsPath: string;
  private readonly statfsFn: (path: string) => Promise<StatFsLike>;
  private readonly readCpuTimes: () => CpuTimes;
  private readonly procCpuUsage: () => NodeJS.CpuUsage;

  private cpuBaseline: { times: CpuTimes; at: number } | null = null;
  private procBaseline: { usec: number; at: number } | null = null;

  constructor(deps: SamplerDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.statfsPath = deps.statfsPath ?? defaultStatfsPath();
    this.statfsFn = deps.statfs ?? statfsWorkVolume;
    this.readCpuTimes = deps.readCpuTimes ?? readHostCpuTimes;
    this.procCpuUsage = deps.procCpuUsage ?? (() => process.cpuUsage());
  }

  /**
   * Take one sample. The first call after process start reports 0% for both
   * CPU figures (no baseline yet — mirrors the cgroup sampler's contract);
   * every later call reflects the wall-clock delta against the prior sample.
   * Never throws: a failing statfs degrades the disk fields to null.
   */
  async sample(): Promise<DeviceSample> {
    const at = this.now();

    // Host CPU delta.
    let cpuPct = 0;
    const times = this.readCpuTimes();
    if (this.cpuBaseline) {
      cpuPct = computeCpuPct(this.cpuBaseline.times, times);
    }
    this.cpuBaseline = { times, at };

    // Daemon-process CPU delta.
    let procCpuPct = 0;
    const usage = this.procCpuUsage();
    const procUsec = usage.user + usage.system;
    if (this.procBaseline) {
      procCpuPct = computeProcCpuPct(
        this.procBaseline.usec,
        procUsec,
        at - this.procBaseline.at,
        os.cpus().length,
      );
    }
    this.procBaseline = { usec: procUsec, at };

    // Disk — best-effort; a missing/unreadable volume stays null.
    let diskUsed: number | null = null;
    let diskAvail: number | null = null;
    try {
      const st = await this.statfsFn(this.statfsPath);
      const unit = st.frsize ?? st.bsize;
      diskUsed = Math.max(0, (st.blocks - st.bfree) * unit);
      diskAvail = Math.max(0, st.bavail * unit);
    } catch {
      // 留白不编数 — leave null rather than reporting a made-up volume.
    }

    const memTotal = os.totalmem();
    const memFree = os.freemem();
    return {
      ts: at,
      cpuPct,
      loadavg1: os.loadavg()[0] ?? 0,
      loadavg5: os.loadavg()[1] ?? 0,
      loadavg15: os.loadavg()[2] ?? 0,
      memUsed: Math.max(0, memTotal - memFree),
      memAvail: memFree,
      swapUsed: readSwapUsedBytes(),
      diskUsed,
      diskAvail,
      procCpuPct,
      procRss: process.memoryUsage().rss,
      uptimeSec: os.uptime(),
    };
  }
}
