// GAPS G-17 — pathUsableLatencyMs resolution tests
//
// The bug: initial path selection in `probeAndSelect` was gated by
// `switchLatencyThresholdMs` (default 200ms) — the same constant used
// for the path-switching heuristic. A cross-continent WSS handshake
// routinely runs 500–1500ms, so the selector rejected an otherwise-fine
// relay path and the daemon never opened the control channel.
//
// Fix: split into two constants. `switchLatencyThresholdMs` keeps its
// original role (path-switching heuristic); `pathUsableLatencyMs`
// (default 2000ms) gates the initial selectBest.
//
// These tests lock in the resolution order:
//   explicit option  >  PRISMER_PATH_USABLE_LATENCY_MS env var  >  default (2000)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TransportManager, type TransportManagerOptions } from '../src/multi-path-transport.js';
import { generateKeyPair } from '../src/e2ee-crypto.js';

function makeOpts(overrides: Partial<TransportManagerOptions> = {}): TransportManagerOptions {
  return {
    apiKey: 'sk-test',
    daemonId: 'daemon-test',
    userId: 'user-test',
    cloudApiBase: 'https://cloud.prismer.dev',
    localKeyPair: generateKeyPair(),
    ...overrides,
  };
}

describe('TransportManager — pathUsableLatencyMs resolution (GAPS G-17)', () => {
  const ENV_KEY = 'PRISMER_PATH_USABLE_LATENCY_MS';
  const savedEnv = process.env[ENV_KEY];

  beforeEach(() => {
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = savedEnv;
    }
  });

  it('defaults pathUsableLatencyMs to 2000ms when no option and no env var is set', () => {
    const tm = new TransportManager(makeOpts()) as unknown as { pathUsableLatencyMs: number };
    expect(tm.pathUsableLatencyMs).toBe(2000);
  });

  it('honors an explicit pathUsableLatencyMs option', () => {
    const tm = new TransportManager(
      makeOpts({ pathUsableLatencyMs: 500 }),
    ) as unknown as { pathUsableLatencyMs: number };
    expect(tm.pathUsableLatencyMs).toBe(500);
  });

  it('honors PRISMER_PATH_USABLE_LATENCY_MS env var when no option is passed', () => {
    process.env[ENV_KEY] = '3000';
    const tm = new TransportManager(makeOpts()) as unknown as { pathUsableLatencyMs: number };
    expect(tm.pathUsableLatencyMs).toBe(3000);
  });

  it('prefers explicit option over env var', () => {
    process.env[ENV_KEY] = '3000';
    const tm = new TransportManager(
      makeOpts({ pathUsableLatencyMs: 750 }),
    ) as unknown as { pathUsableLatencyMs: number };
    expect(tm.pathUsableLatencyMs).toBe(750);
  });

  it('ignores a NaN / non-numeric env var and falls back to the default', () => {
    process.env[ENV_KEY] = 'not-a-number';
    const tm = new TransportManager(makeOpts()) as unknown as { pathUsableLatencyMs: number };
    expect(tm.pathUsableLatencyMs).toBe(2000);
  });

  it('ignores a zero/negative env var and falls back to the default', () => {
    process.env[ENV_KEY] = '0';
    const tm1 = new TransportManager(makeOpts()) as unknown as { pathUsableLatencyMs: number };
    expect(tm1.pathUsableLatencyMs).toBe(2000);

    process.env[ENV_KEY] = '-500';
    const tm2 = new TransportManager(makeOpts()) as unknown as { pathUsableLatencyMs: number };
    expect(tm2.pathUsableLatencyMs).toBe(2000);
  });

  it('leaves switchLatencyThresholdMs at its original 200ms default (regression)', () => {
    const tm = new TransportManager(makeOpts()) as unknown as {
      switchLatencyThresholdMs: number;
      pathUsableLatencyMs: number;
    };
    // The whole point of the G-17 fix is that these two are now decoupled.
    expect(tm.switchLatencyThresholdMs).toBe(200);
    expect(tm.pathUsableLatencyMs).toBe(2000);
  });
});

// GAPS G-17 second-pass — minQualityScore resolution tests
//
// Follow-up bug: after splitting the latency threshold, the daemon *still*
// logged "No suitable path found" because ConnectionProber.selectBest
// defaults minQualityScore=50, and calculateQualityScore hardcodes a 500ms
// latency baseline — cross-continent WS at ~860ms scores <50 even with
// perfect jitter/loss. Fix mirrors pathUsableLatencyMs: expose a
// minQualityScore option on TransportManagerOptions with default 20 and
// env-var override via PRISMER_MIN_QUALITY_SCORE.
//
// These tests lock in the same resolution order:
//   explicit option  >  PRISMER_MIN_QUALITY_SCORE env var  >  default (20)

describe('TransportManager — minQualityScore resolution (GAPS G-17 second-pass)', () => {
  const ENV_KEY = 'PRISMER_MIN_QUALITY_SCORE';
  const savedEnv = process.env[ENV_KEY];

  beforeEach(() => {
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = savedEnv;
    }
  });

  it('defaults minQualityScore to 20 when no option and no env var is set', () => {
    const tm = new TransportManager(makeOpts()) as unknown as { minQualityScore: number };
    expect(tm.minQualityScore).toBe(20);
  });

  it('honors an explicit minQualityScore option', () => {
    const tm = new TransportManager(
      makeOpts({ minQualityScore: 10 }),
    ) as unknown as { minQualityScore: number };
    expect(tm.minQualityScore).toBe(10);
  });

  it('honors PRISMER_MIN_QUALITY_SCORE env var when no option is passed', () => {
    process.env[ENV_KEY] = '30';
    const tm = new TransportManager(makeOpts()) as unknown as { minQualityScore: number };
    expect(tm.minQualityScore).toBe(30);
  });

  it('prefers explicit option over env var', () => {
    process.env[ENV_KEY] = '30';
    const tm = new TransportManager(
      makeOpts({ minQualityScore: 5 }),
    ) as unknown as { minQualityScore: number };
    expect(tm.minQualityScore).toBe(5);
  });

  it('ignores a NaN / non-numeric env var and falls back to the default', () => {
    process.env[ENV_KEY] = 'not-a-number';
    const tm = new TransportManager(makeOpts()) as unknown as { minQualityScore: number };
    expect(tm.minQualityScore).toBe(20);
  });

  it('ignores a negative env var and falls back to the default', () => {
    process.env[ENV_KEY] = '-5';
    const tm = new TransportManager(makeOpts()) as unknown as { minQualityScore: number };
    expect(tm.minQualityScore).toBe(20);
  });

  it('ignores an env var above 100 and falls back to the default', () => {
    process.env[ENV_KEY] = '150';
    const tm = new TransportManager(makeOpts()) as unknown as { minQualityScore: number };
    expect(tm.minQualityScore).toBe(20);
  });

  it('regression: default minQualityScore (20) differs from old hardcoded prober default (50)', () => {
    const tm = new TransportManager(makeOpts()) as unknown as { minQualityScore: number };
    // The whole point of the second-pass fix is to loosen the gate from 50
    // so cross-continent WS (qualityScore ~50 best case) stops being rejected.
    expect(tm.minQualityScore).not.toBe(50);
    expect(tm.minQualityScore).toBeLessThan(50);
    expect(tm.minQualityScore).toBe(20);
  });
});

// ============================================================
// Stale-selection hydration bug — live client required for "path optimal"
// ============================================================
//
// Bug observed in v1.9.24 daemon on user's Mac after WS-relay fix deploy:
//
//   [TransportManager] Current path still optimal
//   Relay client not initialized
//
// Root cause: constructor calls `connectionProber.loadSelection()` from the
// on-disk cache. On restart that cache matches the fresh probe result →
// `needsSwitch` evaluates false → `switchToPath()` (which is the only path
// that constructs a `RelayClient`) is never called → `this.relayClient`
// stays undefined → `checkRelayHealth` throws "Relay client not initialized"
// on every health tick.
//
// Fix: two-pronged defense.
//   (a) Constructor no longer hydrates `currentSelection` from the cache —
//       the persisted selection is still a useful future hint for probe
//       ordering but MUST NOT be treated as live state at boot.
//   (b) `probeAndSelect` treats "selected path but no live client" as
//       needs-switch. A helper `isCurrentPathLive(type)` inspects the
//       relay client's `getStatus()` (or equivalents) for the chosen path.

// Mock the RelayClient module so every `new RelayClient(...)` returns a
// tracked stub whose `connect()` is a no-op. We control `getStatus()` on a
// per-instance basis via the shared state below — one RelayClient per
// `switchToPath('relay')` invocation.
//
// `vi.hoisted` is the vitest-supported way to share mutable state with a
// `vi.mock` factory, which is itself hoisted to the top of the file ahead
// of any top-level `const` — so a plain shared variable wouldn't work.
const relayMockState = vi.hoisted(() => {
  // Declare the FakeRelay class lazily inside hoisted so the class body is
  // evaluated in the correct order with its dependencies.
  return {
    instances: [] as Array<{
      controlConnected: boolean;
      dataConnected: boolean;
      getStatus: () => {
        controlConnected: boolean;
        dataConnected: boolean;
        lastHeartbeat?: number;
        reconnectAttempts: number;
      };
    }>,
    ctorCount: 0,
    reset(): void {
      this.instances.length = 0;
      this.ctorCount = 0;
    },
  };
});

vi.mock('../src/relay-client.js', async () => {
  const { EventEmitter } = await import('node:events');
  class FakeRelay extends EventEmitter {
    controlConnected = true;
    dataConnected = true;
    lastHeartbeat = Date.now();
    reconnectAttempts = 0;

    constructor(_opts: unknown) {
      super();
      relayMockState.instances.push(this);
      relayMockState.ctorCount += 1;
    }

    async connect(): Promise<void> {
      await Promise.resolve();
      this.emit('connected');
    }

    async disconnect(): Promise<void> {
      this.controlConnected = false;
      this.dataConnected = false;
      this.emit('disconnected');
    }

    registerRpcHandler(_method: string, _handler: unknown): void {
      /* no-op in tests */
    }

    sendCommand(_data: Buffer): boolean {
      return true;
    }

    sendControl(_message: unknown): boolean {
      return true;
    }

    getStatus(): {
      controlConnected: boolean;
      dataConnected: boolean;
      lastHeartbeat?: number;
      reconnectAttempts: number;
    } {
      return {
        controlConnected: this.controlConnected,
        dataConnected: this.dataConnected,
        lastHeartbeat: this.lastHeartbeat,
        reconnectAttempts: this.reconnectAttempts,
      };
    }
  }
  return {
    RelayClient: FakeRelay,
    OPCODE: { JSON_CONTROL: 0x00 },
  };
});

function makeTmpDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mptransport-test-'));
}

function seedSelectionFile(dataDir: string, selection: {
  type: 'relay' | 'lan' | 'http';
  endpoint: string;
  latencyMs: number;
}): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'connection-selection.json'),
    JSON.stringify({ ...selection, selectedAt: Date.now() - 60_000 }),
    'utf-8',
  );
}

/** Monkey-patch the prober's probe + select methods so we control results. */
function stubProber(tm: TransportManager, params: {
  type: 'relay' | 'lan' | 'http';
  endpoint: string;
  latencyMs?: number;
}): void {
  const prober = (tm as unknown as { connectionProber: {
    probeAll: () => Promise<unknown>;
    selectBest: (results: unknown, opts?: unknown) => unknown;
    persistSelection: (sel: unknown) => void;
  } }).connectionProber;
  prober.probeAll = vi.fn().mockResolvedValue([
    {
      candidate: { type: params.type, endpoint: params.endpoint, priority: 2 },
      latencyMs: params.latencyMs ?? 100,
      jitterMs: 10,
      success: true,
      timestamp: Date.now(),
      qualityScore: 80,
    },
  ]);
  prober.selectBest = vi.fn().mockReturnValue({
    type: params.type,
    endpoint: params.endpoint,
    latencyMs: params.latencyMs ?? 100,
    selectedAt: Date.now(),
  });
  // Leave persistSelection as a no-op to avoid touching the tmp dir twice.
  prober.persistSelection = vi.fn();
}

describe('TransportManager — stale-selection hydration / live-client gate', () => {
  const tmpDirs: string[] = [];

  beforeEach(() => {
    relayMockState.reset();
  });

  afterEach(() => {
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop();
      if (dir) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
      }
    }
  });

  function newDir(): string {
    const d = makeTmpDataDir();
    tmpDirs.push(d);
    return d;
  }

  it('regression (G-19/daemon v1.9.24): pre-existing selection file + first probe wins same path → RelayClient IS constructed', async () => {
    // This is the EXACT bug observed: cache matches fresh probe → old code
    // skipped switchToPath → relayClient was never created → health check
    // tripped "Relay client not initialized".
    const dataDir = newDir();
    seedSelectionFile(dataDir, {
      type: 'relay',
      endpoint: 'cloud.prismer.dev:443',
      latencyMs: 120,
    });

    const tm = new TransportManager(makeOpts({ dataDir }));
    stubProber(tm, { type: 'relay', endpoint: 'cloud.prismer.dev:443', latencyMs: 120 });

    // Avoid periodic probing / health timers polluting the test
    const tmInternal = tm as unknown as {
      startHealthChecks: () => void;
      startPeriodicProbing: () => void;
    };
    tmInternal.startHealthChecks = (): void => { /* disabled */ };
    tmInternal.startPeriodicProbing = (): void => { /* disabled */ };

    await tm.start();
    await tm.stop();

    expect(relayMockState.ctorCount).toBe(1);
  });

  it('second probe with same winning path AND live relay client → does NOT reconnect', async () => {
    // Once the relay is connected, a subsequent probe that picks the same
    // endpoint must NOT spawn a second RelayClient. This is the "current
    // path still optimal" branch that the hydration bug incorrectly hit
    // on *first* probe; here we verify it still works correctly when the
    // client is actually live.
    const dataDir = newDir();
    const tm = new TransportManager(makeOpts({ dataDir }));
    stubProber(tm, { type: 'relay', endpoint: 'cloud.prismer.dev:443', latencyMs: 120 });

    const tmInternal = tm as unknown as {
      startHealthChecks: () => void;
      startPeriodicProbing: () => void;
      probeAndSelect: () => Promise<void>;
    };
    tmInternal.startHealthChecks = (): void => { /* disabled */ };
    tmInternal.startPeriodicProbing = (): void => { /* disabled */ };

    await tm.start();
    expect(relayMockState.ctorCount).toBe(1);

    // Make sure the fake relay still reports live before re-probing
    expect(relayMockState.instances[0].controlConnected).toBe(true);
    expect(relayMockState.instances[0].dataConnected).toBe(true);

    // Trigger a second probe cycle — same winning path.
    await tmInternal.probeAndSelect();
    await tm.stop();

    expect(relayMockState.ctorCount).toBe(1); // no reconnect; the live check short-circuits
  });

  it('re-probe with same path but relay client is DISCONNECTED → reconnect (new RelayClient)', async () => {
    // Simulates the "cached selection says relay but client is dead" case.
    // isCurrentPathLive(type='relay') must return false → needsSwitch=true →
    // a new RelayClient is spun up.
    const dataDir = newDir();
    const tm = new TransportManager(makeOpts({ dataDir }));
    stubProber(tm, { type: 'relay', endpoint: 'cloud.prismer.dev:443', latencyMs: 120 });

    const tmInternal = tm as unknown as {
      startHealthChecks: () => void;
      startPeriodicProbing: () => void;
      probeAndSelect: () => Promise<void>;
    };
    tmInternal.startHealthChecks = (): void => { /* disabled */ };
    tmInternal.startPeriodicProbing = (): void => { /* disabled */ };

    await tm.start();
    expect(relayMockState.ctorCount).toBe(1);

    // Kill the first client's liveness — simulate socket drop
    relayMockState.instances[0].controlConnected = false;
    relayMockState.instances[0].dataConnected = false;

    // Re-probe: same selection — but since the existing relay is dead,
    // needsSwitch must flip true → a second RelayClient is constructed.
    await tmInternal.probeAndSelect();
    await tm.stop();

    expect(relayMockState.ctorCount).toBe(2);
  });

  it('no cached selection, first probe returns relay → RelayClient IS constructed (baseline)', async () => {
    // Covers the "fresh user, no selection file" case — this path has
    // always worked, but we lock it in so a future refactor doesn't
    // regress it while fixing the hydration bug.
    const dataDir = newDir();
    // NO seedSelectionFile call — directory is empty.
    const tm = new TransportManager(makeOpts({ dataDir }));
    stubProber(tm, { type: 'relay', endpoint: 'cloud.prismer.dev:443', latencyMs: 120 });

    const tmInternal = tm as unknown as {
      startHealthChecks: () => void;
      startPeriodicProbing: () => void;
    };
    tmInternal.startHealthChecks = (): void => { /* disabled */ };
    tmInternal.startPeriodicProbing = (): void => { /* disabled */ };

    await tm.start();
    await tm.stop();

    expect(relayMockState.ctorCount).toBe(1);
  });
});
