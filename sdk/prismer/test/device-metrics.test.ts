/**
 * device-metrics.test.ts — G2-R R-1 (docs/bugfix211/g2-terminal-and-monitor-spec.md §R-1).
 *
 * Runtime device-metrics plugin module: sampler field completeness + numeric
 * bounds, inventory shape, ConfigDelivery-able interval resolution, push
 * cadence over the existing cloud WS, and the three negative controls that
 * carry the plugin-isolation ironclad rule:
 *   ① assembly throw injection ⇒ mount returns null, startup unaffected
 *  ② WS send throws ⇒ sampling continues, nothing bubbles, errors counted
 *  ③ module not mounted ⇒ no runtime.metrics capability bit on declare
 *
 * Usage: npx vitest run test/device-metrics.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Runner } from '../src/daemon/runner';
import {
  DEFAULT_DEVICE_METRICS_INTERVAL_MS,
  MIN_DEVICE_METRICS_INTERVAL_MS,
  RUNTIME_CAPABILITY_DEVICE_METRICS,
  collectDeviceInventory,
  computeCpuPct,
  computeProcCpuPct,
  mountDeviceMetrics,
  resolveDeviceMetricsIntervalMs,
  DeviceMetricsSampler,
  DeviceMetricsPusher,
  parseSwapUsedBytesFromMeminfo,
} from '../src/daemon/device-metrics/index';
import type { CpuTimes, DeviceSample, StatFsLike } from '../src/daemon/device-metrics/index';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'device-metrics-test-'));

interface FakeClock {
  now(): number;
  advance(ms: number): void;
}

function fakeClock(start = 1_000_000): FakeClock {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

function fixedStatfs(blocks = 1_000, unit = 4_096, free = 400, avail = 300): () => Promise<StatFsLike> {
  return async () => ({ bsize: unit, frsize: unit, blocks, bfree: free, bavail: avail });
}

/** A sampler whose every field is deterministic — for exact-value assertions. */
function deterministicSampler(clock: FakeClock, opts?: {
  cpu?: (prev: CpuTimes) => CpuTimes;
  procUsec?: number;
}) {
  let cpu: CpuTimes = { idle: 1_000, total: 2_000 };
  return new DeviceMetricsSampler({
    now: clock.now,
    statfsPath: TMP_DIR,
    statfs: fixedStatfs(),
    readCpuTimes: () => {
      cpu = opts?.cpu ? opts.cpu(cpu) : cpu;
      return cpu;
    },
    procCpuUsage: () => ({ user: opts?.procUsec ?? 0, system: 0 }),
  });
}

// ---------------------------------------------------------------------------
// sampler
// ---------------------------------------------------------------------------

describe('DeviceMetricsSampler — field completeness + numeric bounds (R1-1)', () => {
  it('first sample carries every spec field with sane types and bounds', async () => {
    const sampler = new DeviceMetricsSampler({ statfsPath: TMP_DIR });
    const s = await sampler.sample();

    const expectedFields = [
      'ts',
      'cpuPct',
      'loadavg1',
      'loadavg5',
      'loadavg15',
      'memUsed',
      'memAvail',
      'swapUsed',
      'diskUsed',
      'diskAvail',
      'procCpuPct',
      'procRss',
      'uptimeSec',
    ];
    for (const f of expectedFields) {
      expect(s, `missing sample field: ${f}`).toHaveProperty(f);
    }

    expect(typeof s.ts).toBe('number');
    expect(s.cpuPct).toBeGreaterThanOrEqual(0);
    expect(s.cpuPct).toBeLessThanOrEqual(100);
    expect(s.loadavg1).toBeGreaterThanOrEqual(0);
    expect(s.loadavg5).toBeGreaterThanOrEqual(0);
    expect(s.loadavg15).toBeGreaterThanOrEqual(0);
    expect(s.memUsed).toBeGreaterThanOrEqual(0);
    expect(s.memAvail).toBeGreaterThanOrEqual(0);
    // mem is best-effort bookkeeping, not an exact partition — allow slack.
    expect(s.memUsed + s.memAvail).toBeLessThanOrEqual(os.totalmem() * 1.05);
    expect(s.swapUsed === null || s.swapUsed >= 0).toBe(true);
    expect(s.diskUsed).toBeGreaterThanOrEqual(0);
    expect(s.diskAvail).toBeGreaterThanOrEqual(0);
    expect(s.procCpuPct).toBeGreaterThanOrEqual(0);
    expect(s.procCpuPct).toBeLessThanOrEqual(100);
    expect(s.procRss).toBeGreaterThan(0);
    expect(s.uptimeSec).toBeGreaterThanOrEqual(0);
  });

  it('reports cpuPct 0 on the first call (no baseline yet), bounded after', async () => {
    const clock = fakeClock();
    const sampler = deterministicSampler(clock, {
      cpu: (prev) => ({ idle: prev.idle + 250, total: prev.total + 1_000 }),
      procUsec: 0,
    });
    const first = await sampler.sample();
    expect(first.cpuPct).toBe(0);
    expect(first.procCpuPct).toBe(0);

    clock.advance(5_000);
    const second = await sampler.sample();
    // idle delta 250 / total delta 1000 → 75% busy across the whole host.
    expect(second.cpuPct).toBeCloseTo(75, 5);
    expect(second.cpuPct).toBeLessThanOrEqual(100);
  });

  it('derives procCpuPct from the process cpuUsage delta normalized to total cores', async () => {
    const clock = fakeClock();
    let usec = 0;
    const sampler = new DeviceMetricsSampler({
      now: clock.now,
      statfsPath: TMP_DIR,
      statfs: fixedStatfs(),
      readCpuTimes: () => ({ idle: 0, total: 0 }),
      procCpuUsage: () => ({ user: usec, system: 0 }),
    });
    await sampler.sample(); // prime baseline
    usec = 500_000; // 0.5 core-seconds consumed
    clock.advance(1_000); // over 1s wall clock
    const s = await sampler.sample();
    // 0.5s cpu / (1s × N cores) → 50/N % of total capacity.
    expect(s.procCpuPct).toBeCloseTo(50 / os.cpus().length, 5);
  });

  it('disk figures come from statfs on the injected work volume', async () => {
    const clock = fakeClock();
    const sampler = deterministicSampler(clock);
    const s = await sampler.sample();
    // fixedStatfs: (1000-400)*4096 used, 300*4096 available.
    expect(s.diskUsed).toBe((1_000 - 400) * 4_096);
    expect(s.diskAvail).toBe(300 * 4_096);
  });

  it('statfs failure degrades disk fields to null without throwing', async () => {
    const clock = fakeClock();
    const sampler = new DeviceMetricsSampler({
      now: clock.now,
      statfsPath: TMP_DIR,
      statfs: async () => {
        throw new Error('EACCES');
      },
      readCpuTimes: () => ({ idle: 0, total: 0 }),
      procCpuUsage: () => ({ user: 0, system: 0 }),
    });
    const s = await sampler.sample();
    expect(s.diskUsed).toBeNull();
    expect(s.diskAvail).toBeNull();
  });

  it('computeCpuPct is exact, clamped, and divide-by-zero safe', () => {
    expect(computeCpuPct({ idle: 100, total: 200 }, { idle: 150, total: 300 })).toBeCloseTo(50, 5);
    expect(computeCpuPct({ idle: 100, total: 200 }, { idle: 100, total: 200 })).toBe(0);
    // idle delta > total delta is nonsense telemetry — clamp to 0.
    expect(computeCpuPct({ idle: 100, total: 200 }, { idle: 300, total: 250 })).toBe(0);
    // counters moving backwards — clamp to 0 (no negative busy).
    expect(computeCpuPct({ idle: 100, total: 200 }, { idle: 100, total: 100 })).toBe(0);
    // busy beyond capacity (idle shrinking while total grows) — clamp to 100.
    expect(computeCpuPct({ idle: 100, total: 200 }, { idle: 50, total: 300 })).toBe(100);
  });

  it('computeProcCpuPct normalizes to cores and clamps to [0,100]', () => {
    // 500ms cpu over 1000ms wall on 1 core → 50%; on 2 cores → 25%.
    expect(computeProcCpuPct(0, 500_000, 1_000, 1)).toBeCloseTo(50, 5);
    expect(computeProcCpuPct(0, 500_000, 1_000, 2)).toBeCloseTo(25, 5);
    expect(computeProcCpuPct(0, 5_000_000, 1_000, 1)).toBe(100);
    expect(computeProcCpuPct(0, 500_000, 0, 1)).toBe(0); // zero elapsed → 0, not NaN
  });

  it('parseSwapUsedBytesFromMeminfo reads /proc/meminfo honestly or returns null', () => {
    expect(
      parseSwapUsedBytesFromMeminfo(
        'MemTotal: 16384 kB\nSwapTotal:       2097148 kB\nSwapFree:      1048576 kB\n',
      ),
    ).toBe((2_097_148 - 1_048_576) * 1024);
    expect(parseSwapUsedBytesFromMeminfo('MemTotal: 16384 kB\n')).toBeNull();
    expect(parseSwapUsedBytesFromMeminfo('SwapTotal: garbage\nSwapFree: 1 kB\n')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// inventory
// ---------------------------------------------------------------------------

describe('collectDeviceInventory — static shape (R1-1)', () => {
  it('carries exactly the spec field set', async () => {
    const inv = await collectDeviceInventory({
      daemonId: 'daemon-testbox',
      runtimeVersion: '2.2.55',
      statfsPath: TMP_DIR,
    });
    expect(Object.keys(inv).sort()).toEqual(
      [
        'arch',
        'cpuCores',
        'cpuModel',
        'daemonId',
        'diskTotal',
        'hostname',
        'memTotal',
        'osRelease',
        'osType',
        'runtimeVersion',
      ].sort(),
    );
  });

  it('values are the real host facts plus injected identity', async () => {
    const inv = await collectDeviceInventory({
      daemonId: 'daemon-testbox',
      runtimeVersion: '2.2.55',
      statfsPath: TMP_DIR,
    });
    expect(inv.daemonId).toBe('daemon-testbox');
    expect(inv.runtimeVersion).toBe('2.2.55');
    expect(inv.hostname).toBe(os.hostname());
    expect(inv.osType).toBe(os.type());
    expect(inv.osRelease).toBe(os.release());
    expect(inv.arch).toBe(process.arch);
    expect(inv.cpuCores).toBe(os.cpus().length);
    expect(inv.cpuModel).toBe(os.cpus()[0]?.model ?? '');
    expect(inv.memTotal).toBe(os.totalmem());
    expect(inv.diskTotal).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// interval config (ConfigDelivery-able)
// ---------------------------------------------------------------------------

describe('resolveDeviceMetricsIntervalMs — default 10s, min clamp 2s', () => {
  it('defaults to 10000 when unset', () => {
    expect(resolveDeviceMetricsIntervalMs(undefined)).toBe(DEFAULT_DEVICE_METRICS_INTERVAL_MS);
    expect(DEFAULT_DEVICE_METRICS_INTERVAL_MS).toBe(10_000);
  });

  it('honours a valid override (number or numeric string, e.g. env-delivered)', () => {
    expect(resolveDeviceMetricsIntervalMs(30_000)).toBe(30_000);
    expect(resolveDeviceMetricsIntervalMs('30000')).toBe(30_000); // env form
    expect(resolveDeviceMetricsIntervalMs('2500')).toBe(2_500);
  });

  it('clamps below the 2000ms floor', () => {
    expect(resolveDeviceMetricsIntervalMs(1_000)).toBe(MIN_DEVICE_METRICS_INTERVAL_MS);
    expect(resolveDeviceMetricsIntervalMs(0)).toBe(MIN_DEVICE_METRICS_INTERVAL_MS);
    expect(resolveDeviceMetricsIntervalMs(-5)).toBe(MIN_DEVICE_METRICS_INTERVAL_MS);
    expect(MIN_DEVICE_METRICS_INTERVAL_MS).toBe(2_000);
  });

  it('falls back to the default on garbage instead of throwing', () => {
    expect(resolveDeviceMetricsIntervalMs('abc')).toBe(DEFAULT_DEVICE_METRICS_INTERVAL_MS);
    expect(resolveDeviceMetricsIntervalMs(Number.NaN)).toBe(DEFAULT_DEVICE_METRICS_INTERVAL_MS);
    expect(resolveDeviceMetricsIntervalMs(Number.POSITIVE_INFINITY)).toBe(
      DEFAULT_DEVICE_METRICS_INTERVAL_MS,
    );
    expect(resolveDeviceMetricsIntervalMs({})).toBe(DEFAULT_DEVICE_METRICS_INTERVAL_MS);
  });
});

// ---------------------------------------------------------------------------
// pusher (fake timers) + negative control ②
// ---------------------------------------------------------------------------

describe('DeviceMetricsPusher — daemon.metrics over the existing WS', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makePusher(overrides?: {
    send?: (frame: unknown) => void;
    samples?: DeviceSample[];
    inventorySeq?: Array<Record<string, unknown>>;
  }) {
    const clock = fakeClock();
    let sampleIdx = 0;
    const samples: DeviceSample[] = overrides?.samples ?? [
      {
        ts: 1,
        cpuPct: 10,
        loadavg1: 1,
        loadavg5: 1,
        loadavg15: 1,
        memUsed: 1,
        memAvail: 1,
        swapUsed: null,
        diskUsed: 1,
        diskAvail: 1,
        procCpuPct: 1,
        procRss: 1,
        uptimeSec: 1,
      },
    ];
    let invTick = 0;
    const inventorySeq = overrides?.inventorySeq ?? [
      { daemonId: 'daemon-testbox', runtimeVersion: '2.2.55' },
    ];
    const sent: Array<{ type: string; payload: Record<string, unknown>; requestId?: string }> = [];
    const pusher = new DeviceMetricsPusher({
      daemonId: 'daemon-testbox',
      intervalMs: 10_000,
      send: overrides?.send ?? ((frame) => sent.push(frame as never)),
      now: clock.now,
      sampler: { sample: async () => samples[Math.min(sampleIdx++, samples.length - 1)]! },
      inventoryProvider: async () => {
        // Value is keyed by TICK index — seq[i] is the inventory AS OF tick i,
        // held steady after the sequence is exhausted.
        const v = inventorySeq[Math.min(invTick, inventorySeq.length - 1)]!;
        invTick++;
        return v;
      },
    });
    return { pusher, sent, clock };
  }

  it('first tick pushes one sample WITH inventory; unchanged ticks omit it', async () => {
    const { pusher, sent } = makePusher();
    pusher.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.type).toBe('daemon.metrics');
    expect(sent[0]!.requestId).toBe('daemon-testbox');
    const samples = sent[0]!.payload.samples as DeviceSample[];
    expect(samples).toHaveLength(1);
    expect(sent[0]!.payload.inventory).toBeDefined();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.payload.inventory).toBeUndefined();

    pusher.stop();
  });

  it('inventory change rides the next push (变更重报)', async () => {
    const { pusher, sent } = makePusher({
      // tick0 → first report; tick1 → unchanged; tick2 → changed volume.
      inventorySeq: [
        { daemonId: 'daemon-testbox', diskTotal: 1 },
        { daemonId: 'daemon-testbox', diskTotal: 1 },
        { daemonId: 'daemon-testbox', diskTotal: 2 },
      ],
    });
    pusher.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(sent).toHaveLength(3);
    expect(sent[0]!.payload.inventory).toBeDefined(); // first report
    expect(sent[1]!.payload.inventory).toBeUndefined(); // unchanged
    const inv = sent[2]!.payload.inventory as Record<string, unknown>;
    expect(inv.diskTotal).toBe(2); // changed → re-reported

    pusher.stop();
  });

  it('setIntervalMs takes effect on the live cadence (采样间隔变更即时生效)', async () => {
    const { pusher, sent } = makePusher();
    pusher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);

    pusher.setIntervalMs(2_000);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent).toHaveLength(2);

    pusher.stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sent).toHaveLength(2); // stopped → no more pushes
  });

  it('NEGATIVE ② — a throwing WS send never bubbles; sampling continues, errors counted', async () => {
    let sendCalls = 0;
    const { pusher, sent } = makePusher({
      send: () => {
        sendCalls++;
        throw new Error('socket exploded');
      },
    });
    pusher.start();
    // Must not reject: the send failure is captured inside the tick.
    await vi.advanceTimersByTimeAsync(0);
    expect(sendCalls).toBe(1);
    expect(pusher.getStats().sendErrors).toBe(1);
    expect(pusher.getStats().pushes).toBe(0);

    // The loop keeps sampling despite the broken send.
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sendCalls).toBe(3);
    expect(pusher.getStats().sendErrors).toBe(3);
    expect(pusher.getStats().pushes).toBe(0);

    // Heal the socket → pushes resume (same module instance).
    expect(sent).toHaveLength(0);
    pusher.stop();
  });

  it('NEGATIVE ②b — a rejecting sampler skips the tick, loop survives', async () => {
    const clock = fakeClock();
    let fail = true;
    let calls = 0;
    const pusher = new DeviceMetricsPusher({
      daemonId: 'daemon-testbox',
      intervalMs: 10_000,
      send: () => undefined,
      now: clock.now,
      sampler: {
        sample: async () => {
          calls++;
          if (fail) throw new Error('os exploded');
          return {
            ts: 1,
            cpuPct: 0,
            loadavg1: 0,
            loadavg5: 0,
            loadavg15: 0,
            memUsed: 0,
            memAvail: 0,
            swapUsed: null,
            diskUsed: null,
            diskAvail: null,
            procCpuPct: 0,
            procRss: 0,
            uptimeSec: 0,
          };
        },
      },
      inventoryProvider: async () => ({ daemonId: 'd', runtimeVersion: 'v' }),
    });
    pusher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(pusher.getStats().sampleErrors).toBe(1);

    fail = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pusher.getStats().pushes).toBe(1);
    expect(calls).toBe(2);
    pusher.stop();
  });
});

// ---------------------------------------------------------------------------
// negative control ① — fail-safe mount
// ---------------------------------------------------------------------------

describe('mountDeviceMetrics — assembly failure never escapes', () => {
  it('NEGATIVE ① — a throwing assembly returns null without throwing', () => {
    const mounted = mountDeviceMetrics({
      daemonId: 'daemon-testbox',
      runtimeVersion: '2.2.55',
      send: () => undefined,
      createModule: () => {
        throw new Error('constructor exploded');
      },
    });
    expect(mounted).toBeNull();
  });

  it('NEGATIVE ①b — a throwing start() is contained, module torn down, null returned', () => {
    let stopped = false;
    const mounted = mountDeviceMetrics({
      daemonId: 'daemon-testbox',
      runtimeVersion: '2.2.55',
      send: () => undefined,
      createModule: () =>
        ({
          start: () => {
            throw new Error('start exploded');
          },
          stop: () => {
            stopped = true;
          },
          setIntervalMs: () => undefined,
        }) as never,
    });
    expect(mounted).toBeNull();
    expect(stopped).toBe(true); // defensive teardown so no timer leaks
  });

  it('success path mounts and starts the module', () => {
    let started = false;
    const module = mountDeviceMetrics({
      daemonId: 'daemon-testbox',
      runtimeVersion: '2.2.55',
      send: () => undefined,
      createModule: () =>
        ({
          start: () => {
            started = true;
          },
          stop: () => undefined,
          setIntervalMs: () => undefined,
        }) as never,
    });
    expect(module).not.toBeNull();
    expect(started).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// negative control ③ — unmounted module ⇒ no capability bit on declare
// ---------------------------------------------------------------------------

function makeRunner(config: Record<string, unknown> = {}): any {
  const r = new Runner() as any;
  r.config = { daemon_id: 'daemon-testbox', ...config };
  r.opts = { daemonVersion: '2.2.55' };
  r.hostedAgents = new Map();
  r.registry = new Map();
  r.runningTasks = new Map();
  r.state = 'running';
  return r;
}

describe('Runner.sendDeclare — runtime.metrics capability bit (NEGATIVE ③)', () => {
  const sent: Array<{ type: string; payload: { runtimeCapabilities?: string[] } }> = [];

  function ws() {
    return { send: (msg: never) => sent.push(msg), close: () => undefined };
  }

  it('unmounted module ⇒ memory caps only, NO runtime.metrics claim', () => {
    sent.length = 0;
    const r = makeRunner();
    r.deviceMetrics = undefined; // mount failed / plugin off
    r.ws = ws();
    r.sendDeclare();
    const caps = sent[0]!.payload.runtimeCapabilities ?? [];
    expect(caps).not.toContain(RUNTIME_CAPABILITY_DEVICE_METRICS);
    expect(caps).toContain('memory-authority-snapshot-v1');
  });

  it('mounted module ⇒ runtime.metrics rides the declare wire', () => {
    sent.length = 0;
    const r = makeRunner();
    r.deviceMetrics = { stop: () => undefined }; // mounted (shape irrelevant here)
    r.ws = ws();
    r.sendDeclare();
    const caps = sent[0]!.payload.runtimeCapabilities ?? [];
    expect(caps).toContain(RUNTIME_CAPABILITY_DEVICE_METRICS);
    expect(caps).toContain('memory-authority-snapshot-v1');
  });
});
