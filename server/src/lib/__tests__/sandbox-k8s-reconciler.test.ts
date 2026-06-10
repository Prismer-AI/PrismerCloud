/**
 * Release 200 S5 — reconciler unit tests.
 *
 * Covers:
 *  - probeDaemon 30s throttle (consecutive ticks within window skip probe)
 *  - daemon miss counter: 1→2→3 → degraded transition (warn-only)
 *  - healthy probe resets misses + writes lastDaemonHealthAt + writes sample
 *  - degraded → running recovery on healthy probe
 *  - ProviderError('not_found') swallowed silently (no DB update)
 *  - writeResourceSample feeds row from raw.resources block
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mocks must be hoisted via vi.mock. We mock prisma, registry, and k8s-sandbox.
vi.mock('@/lib/prisma', () => {
  const findMany = vi.fn();
  const update = vi.fn();
  const create = vi.fn();
  const deleteMany = vi.fn();
  return {
    default: {
      iMContainer: { findMany, update },
      iMSandboxResourceSample: { create, deleteMany },
    },
  };
});

vi.mock('@/lib/k8s-sandbox', () => ({
  k8sSandbox: {
    podStatusVerdict: vi.fn(),
  },
  K8sSandboxError: class K8sSandboxError extends Error {
    code?: string;
    status?: number;
  },
}));

vi.mock('@/lib/sandbox-config', () => ({
  hasK8sConfig: () => true,
}));

vi.mock('@/lib/sandbox/registry', () => ({
  resolvePersistent: vi.fn(),
}));

// Force K8S_CONTROLLER_AVAILABLE so reconcileTick doesn't early-return.
process.env.K8S_CONTROLLER_AVAILABLE = 'true';

import prisma from '@/lib/prisma';
import { k8sSandbox } from '@/lib/k8s-sandbox';
import { resolvePersistent } from '@/lib/sandbox/registry';
import { ProviderError } from '@/lib/execution/errors';
import { reconcileTick, stopK8sReconciler } from '@/lib/sandbox-k8s-reconciler';

interface MockRow {
  id: string;
  podName: string;
  namespace: string;
  status: string;
  startedAt: Date | null;
  stoppedAt: Date | null;
  providerKind: string | null;
  daemonId: string | null;
  daemonHealthMisses: number;
  lastDaemonHealthAt: Date | null;
}

function mockRow(overrides: Partial<MockRow> = {}): MockRow {
  return {
    id: 'row-1',
    podName: 'pod-1',
    namespace: 'default',
    status: 'running',
    startedAt: new Date(Date.now() - 60_000),
    stoppedAt: null,
    providerKind: 'k8s',
    daemonId: 'daemon-a',
    daemonHealthMisses: 0,
    lastDaemonHealthAt: null,
    ...overrides,
  };
}

describe('reconcileTick — daemon health probe', () => {
  const findManyMock = prisma.iMContainer.findMany as unknown as ReturnType<typeof vi.fn>;
  const updateMock = prisma.iMContainer.update as unknown as ReturnType<typeof vi.fn>;
  const sampleCreateMock = prisma.iMSandboxResourceSample.create as unknown as ReturnType<typeof vi.fn>;
  const podStatusMock = k8sSandbox.podStatusVerdict as unknown as ReturnType<typeof vi.fn>;
  const resolveMock = resolvePersistent as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    findManyMock.mockReset();
    updateMock.mockReset();
    sampleCreateMock.mockReset();
    podStatusMock.mockReset();
    resolveMock.mockReset();
    // Reset in-memory state (lastProbeAt etc.) between tests.
    stopK8sReconciler();

    podStatusMock.mockResolvedValue({
      exists: true,
      phase: 'Running',
      reason: null,
      apiError: false,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    updateMock.mockResolvedValue({});
    sampleCreateMock.mockResolvedValue({});
  });

  it('writes lastDaemonHealthAt + resets misses + writes resource sample on healthy probe', async () => {
    findManyMock.mockResolvedValue([mockRow({ daemonHealthMisses: 2 })]);
    const probeFn = vi.fn().mockResolvedValue({
      healthy: true,
      latencyMs: 42,
      daemonId: 'daemon-a',
      daemonVersion: '2.0.0',
      readyForDispatch: true,
      raw: {
        resources: {
          cpu: { usagePct: 12.5 },
          mem: { usedBytes: 200 * 1024 * 1024, limitBytes: 1024 * 1024 * 1024 },
        },
      },
    });
    resolveMock.mockReturnValue({ probeDaemon: probeFn });

    await reconcileTick();

    expect(probeFn).toHaveBeenCalledWith('pod-1');

    // First update is pod-status decision: row.status is 'running' and pod is
    // Running → decideNextStatus returns nextStatus=null. So only the daemon-
    // health update should fire.
    const daemonUpdate = updateMock.mock.calls.find(
      (call) => call[0]?.where?.id === 'row-1' && call[0]?.data?.daemonHealthMisses === 0,
    );
    expect(daemonUpdate).toBeDefined();
    expect(daemonUpdate?.[0]?.data?.lastDaemonHealthAt).toBeInstanceOf(Date);

    // Resource sample written.
    expect(sampleCreateMock).toHaveBeenCalledTimes(1);
    const sampleArgs = sampleCreateMock.mock.calls[0][0]?.data;
    expect(sampleArgs.containerId).toBe('row-1');
    expect(sampleArgs.cpuUsagePct).toBe(12.5);
    expect(sampleArgs.memUsedBytes).toBe(BigInt(200 * 1024 * 1024));
    expect(sampleArgs.daemonRttMs).toBe(42);
  });

  it('throttles probeDaemon to once per ~30s', async () => {
    findManyMock.mockResolvedValue([mockRow()]);
    const probeFn = vi.fn().mockResolvedValue({
      healthy: true,
      latencyMs: 10,
      raw: { resources: { cpu: { usagePct: 0 }, mem: { usedBytes: 0, limitBytes: 0 } } },
    });
    resolveMock.mockReturnValue({ probeDaemon: probeFn });

    // First tick — probe should fire.
    await reconcileTick();
    expect(probeFn).toHaveBeenCalledTimes(1);

    // Second tick within the throttle window — probe should skip.
    await reconcileTick();
    expect(probeFn).toHaveBeenCalledTimes(1);
  });

  it('increments misses on unhealthy probe; transitions running → degraded on 3rd miss', async () => {
    // Simulate 3 consecutive misses by advancing daemonHealthMisses each tick.
    const row = mockRow({ daemonHealthMisses: 2 });
    findManyMock.mockResolvedValue([row]);

    const probeFn = vi.fn().mockResolvedValue({
      healthy: false,
      latencyMs: 0,
      error: 'connection refused',
    });
    resolveMock.mockReturnValue({ probeDaemon: probeFn });

    await reconcileTick();

    const daemonUpdate = updateMock.mock.calls.find(
      (call) => call[0]?.where?.id === 'row-1' && call[0]?.data?.daemonHealthMisses === 3,
    );
    expect(daemonUpdate).toBeDefined();
    expect(daemonUpdate?.[0]?.data?.status).toBe('degraded');
  });

  it('does NOT degrade on 1st or 2nd miss', async () => {
    findManyMock.mockResolvedValue([mockRow({ daemonHealthMisses: 0 })]);
    const probeFn = vi.fn().mockResolvedValue({
      healthy: false,
      latencyMs: 0,
      error: 'eof',
    });
    resolveMock.mockReturnValue({ probeDaemon: probeFn });

    await reconcileTick();

    const update = updateMock.mock.calls.find((c) => c[0]?.where?.id === 'row-1');
    expect(update?.[0]?.data?.daemonHealthMisses).toBe(1);
    expect(update?.[0]?.data?.status).toBeUndefined();
  });

  it('restores degraded → running on healthy probe (resets misses + stamps lastDaemonHealthAt)', async () => {
    findManyMock.mockResolvedValue([mockRow({ status: 'degraded', daemonHealthMisses: 5 })]);
    // Force pod-status decision to no-op so the daemon-health phase carries
    // the degraded → running transition. We do this by making the verdict an
    // ambiguous phase (so decideNextStatus returns null).
    podStatusMock.mockResolvedValueOnce({
      exists: true,
      phase: 'Running',
      reason: null,
      apiError: false,
      // No startedAt — but verdict.phase==='Running' + current.status==='degraded'
      // will still drive a pod-status transition to 'running'. Force ambiguity
      // by switching to a different phase that triggers no-op for degraded.
    });
    // Actually use a phase that returns no-op for degraded current state: the
    // implementation only fires for Pending / Running / Succeeded / Failed /
    // Unknown. Set phase='' (default branch → null).
    podStatusMock.mockReset();
    podStatusMock.mockResolvedValue({
      exists: true,
      phase: '',
      reason: null,
      apiError: false,
    });
    const probeFn = vi.fn().mockResolvedValue({
      healthy: true,
      latencyMs: 8,
      raw: { resources: { cpu: { usagePct: 1 }, mem: { usedBytes: 1, limitBytes: 10 } } },
    });
    resolveMock.mockReturnValue({ probeDaemon: probeFn });

    await reconcileTick();

    const daemonUpdate = updateMock.mock.calls.find(
      (c) => c[0]?.where?.id === 'row-1' && c[0]?.data?.daemonHealthMisses === 0,
    );
    expect(daemonUpdate).toBeDefined();
    expect(daemonUpdate?.[0]?.data?.status).toBe('running');
    expect(daemonUpdate?.[0]?.data?.lastDaemonHealthAt).toBeInstanceOf(Date);
  });

  it('swallows ProviderError(not_found) without DB update', async () => {
    findManyMock.mockResolvedValue([mockRow()]);
    const probeFn = vi.fn().mockRejectedValue(new ProviderError('not_found', 'pod missing', false));
    resolveMock.mockReturnValue({ probeDaemon: probeFn });

    await reconcileTick();

    // No daemon-health update should be issued for this row.
    const daemonUpdate = updateMock.mock.calls.find(
      (c) => c[0]?.where?.id === 'row-1' && c[0]?.data?.daemonHealthMisses !== undefined,
    );
    expect(daemonUpdate).toBeUndefined();
  });

  // T11 — illegal FSM transition: pod-status decision tries to move a `stopped`
  // row (terminal, no out-transitions) onto `running`. The assertion must throw,
  // the tick must surface it as `errors+=1`, and the DB update must NOT fire.
  it('T11 — illegal pod-status transition aborts the row without crashing the tick', async () => {
    findManyMock.mockReset();
    updateMock.mockReset();
    podStatusMock.mockReset();
    // Inject a row that already has the terminal `stopped` status but
    // somehow re-enters the active set (defensive: shouldn't happen now
    // that ACTIVE_STATUSES excludes it, but the guard must still catch it
    // if the SELECT predicate is ever loosened).
    findManyMock.mockResolvedValue([mockRow({ status: 'stopped' })]);
    podStatusMock.mockResolvedValue({
      exists: true,
      phase: 'Running',
      reason: null,
      apiError: false,
    });
    const probeFn = vi.fn().mockResolvedValue({
      healthy: true,
      latencyMs: 1,
      raw: { resources: { cpu: { usagePct: 0 }, mem: { usedBytes: 0, limitBytes: 0 } } },
    });
    resolveMock.mockReturnValue({ probeDaemon: probeFn });

    const tickResult = await reconcileTick();

    // Tick survives.
    expect(tickResult.errors).toBeGreaterThanOrEqual(1);
    // No pod-status status update issued.
    const statusUpdate = updateMock.mock.calls.find(
      (c) => c[0]?.where?.id === 'row-1' && c[0]?.data?.status === 'running',
    );
    expect(statusUpdate).toBeUndefined();
  });
});
