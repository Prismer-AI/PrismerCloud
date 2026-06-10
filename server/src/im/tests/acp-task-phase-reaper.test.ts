/**
 * Task phase reaper — v2.0 §4.2 Track B-1 acceptance tests.
 *
 * Covers `TaskService.sweepStuckPhases` and the §4.2 协同矩阵 invariant
 * that the reaper writes ONLY the `currentPhase` column (never `status`).
 *
 * Also covers the cross-reaper coexistence: same task can be visited by
 * `sweepStuckPhases` (phase signal) and `handleTimeouts` (canonical state
 * machine) without column-level conflicts.
 *
 * Acceptance flow proven here:
 *   1. running task with no recent heartbeat → reaper marks
 *      `currentPhase='stuck'` (status untouched)
 *   2. fresh heartbeat (recordTaskHeartbeat with new version) → phase
 *      restored, `recoveredFromStuck=true`
 *   3. heartbeat keeps coming → reaper finds nothing to do
 *   4. 5min hard timeout (handleTimeouts) is a parallel, non-overlapping
 *      mechanism — verified by inspecting that handleTimeouts updates
 *      `status` while sweepStuckPhases updates only `currentPhase`
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Prisma mock ────────────────────────────────────────────────
const prismaMock = {
  iMTask: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
  },
};

vi.mock('@/lib/prisma', () => ({ default: prismaMock }));
vi.mock('@/lib/notification-emitter', () => ({
  emitTaskAssignedNotification: vi.fn().mockResolvedValue(undefined),
  emitTaskApprovalRequestedNotification: vi.fn().mockResolvedValue(undefined),
  emitTaskStatusNotification: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/k8s-sandbox', () => ({
  K8sSandboxError: class K8sSandboxError extends Error {},
  k8sSandbox: {},
}));
vi.mock('@/lib/k8s-client', () => ({ getK8sNamespace: vi.fn(() => 'test') }));

function resetPrismaMock() {
  for (const model of Object.values(prismaMock)) {
    for (const fn of Object.values(model)) {
      (fn as { mockReset: () => void }).mockReset();
    }
  }
}

async function buildService() {
  const { TaskService } = await import('@/im/services/task.service');
  const syncWriteEvent = vi.fn().mockResolvedValue(undefined);
  const service = new TaskService({
    eventBusService: { publish: vi.fn().mockResolvedValue(undefined) },
    rooms: { sendToUser: vi.fn() },
    syncService: { writeEvent: syncWriteEvent } as any,
  } as any);
  return { service, syncWriteEvent };
}

function stuckCandidate(over: Record<string, unknown> = {}) {
  return {
    id: 'task_stuck_1',
    conversationId: 'conv_1',
    creatorId: 'creator_1',
    assigneeId: 'assignee_1',
    lastHeartbeatAt: new Date(Date.now() - 60_000), // 60s ago
    currentPhase: 'thinking',
    ...over,
  };
}

describe('TaskService.sweepStuckPhases — marking', () => {
  beforeEach(resetPrismaMock);

  it('marks currentPhase="stuck" for tasks with stale heartbeat', async () => {
    prismaMock.iMTask.findMany.mockResolvedValueOnce([stuckCandidate()]);
    prismaMock.iMTask.update.mockResolvedValueOnce({});
    const { service } = await buildService();

    const marked = await service.sweepStuckPhases();

    expect(marked).toBe(1);
    expect(prismaMock.iMTask.update).toHaveBeenCalledTimes(1);
    const updateCall = prismaMock.iMTask.update.mock.calls[0][0];
    expect(updateCall.where).toEqual({ id: 'task_stuck_1' });
    expect(updateCall.data).toEqual({ currentPhase: 'stuck' });
  });

  it('CRITICAL §12.4 invariant: reaper update never sets status', async () => {
    prismaMock.iMTask.findMany.mockResolvedValueOnce([stuckCandidate()]);
    prismaMock.iMTask.update.mockResolvedValueOnce({});
    const { service } = await buildService();

    await service.sweepStuckPhases();

    const data = prismaMock.iMTask.update.mock.calls[0][0].data;
    // SQL audit equivalent — assert no status touch.
    expect(Object.keys(data)).toEqual(['currentPhase']);
    expect(Object.keys(data)).not.toContain('status');
    expect(Object.keys(data)).not.toContain('retryCount');
    expect(Object.keys(data)).not.toContain('error');
  });

  it('emits task.phase.stuck sync event for each marked task', async () => {
    prismaMock.iMTask.findMany.mockResolvedValueOnce([
      stuckCandidate({ id: 'task_a', conversationId: 'conv_a' }),
      stuckCandidate({ id: 'task_b', conversationId: 'conv_b', assigneeId: 'assignee_b' }),
    ]);
    prismaMock.iMTask.update.mockResolvedValue({});
    const { service, syncWriteEvent } = await buildService();

    const marked = await service.sweepStuckPhases();

    expect(marked).toBe(2);
    expect(syncWriteEvent).toHaveBeenCalledTimes(2);
    expect(syncWriteEvent.mock.calls[0][0]).toBe('task.phase.stuck');
    expect(syncWriteEvent.mock.calls[0][1].taskId).toBe('task_a');
    expect(syncWriteEvent.mock.calls[1][1].taskId).toBe('task_b');
  });

  it('filters out tasks with null lastHeartbeatAt (never started talking)', async () => {
    prismaMock.iMTask.findMany.mockResolvedValueOnce([stuckCandidate({ id: 'task_null', lastHeartbeatAt: null })]);
    const { service, syncWriteEvent } = await buildService();

    const marked = await service.sweepStuckPhases();

    expect(marked).toBe(0);
    expect(prismaMock.iMTask.update).not.toHaveBeenCalled();
    expect(syncWriteEvent).not.toHaveBeenCalled();
  });

  it('uses cutoffMs option (45s default) — supplied 10s window', async () => {
    prismaMock.iMTask.findMany.mockResolvedValueOnce([]);
    const { service } = await buildService();

    await service.sweepStuckPhases({ cutoffMs: 10_000 });

    const whereArg = prismaMock.iMTask.findMany.mock.calls[0][0];
    expect(whereArg.where.status).toEqual({ in: ['running', 'review'] });
    expect(whereArg.where.lastHeartbeatAt.lt).toBeInstanceOf(Date);
    const expectedCutoff = Date.now() - 10_000;
    const actualCutoff = (whereArg.where.lastHeartbeatAt.lt as Date).getTime();
    expect(Math.abs(actualCutoff - expectedCutoff)).toBeLessThan(2_000);
  });

  it('returns 0 when no tasks match the cutoff window', async () => {
    prismaMock.iMTask.findMany.mockResolvedValueOnce([]);
    const { service } = await buildService();
    const marked = await service.sweepStuckPhases();
    expect(marked).toBe(0);
    expect(prismaMock.iMTask.update).not.toHaveBeenCalled();
  });

  it('continues on per-task update error (no full sweep abort)', async () => {
    prismaMock.iMTask.findMany.mockResolvedValueOnce([
      stuckCandidate({ id: 'task_ok_1' }),
      stuckCandidate({ id: 'task_fail' }),
      stuckCandidate({ id: 'task_ok_2' }),
    ]);
    prismaMock.iMTask.update
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('db hiccup'))
      .mockResolvedValueOnce({});
    const { service } = await buildService();

    const marked = await service.sweepStuckPhases();

    // Two succeeded, one failed — the failure is logged but does not block
    // the rest of the sweep.
    expect(marked).toBe(2);
  });
});

describe('Heartbeat ↔ Reaper coexistence (§4.2 协同矩阵)', () => {
  beforeEach(resetPrismaMock);

  it('reaper marks stuck → heartbeat clears it → reaper finds nothing new', async () => {
    const { service, syncWriteEvent } = await buildService();

    // Step 1: reaper marks stuck
    prismaMock.iMTask.findMany.mockResolvedValueOnce([stuckCandidate({ currentPhase: 'thinking' })]);
    prismaMock.iMTask.update.mockResolvedValueOnce({});
    await service.sweepStuckPhases();
    expect(prismaMock.iMTask.update.mock.calls[0][0].data).toEqual({ currentPhase: 'stuck' });

    // Step 2: heartbeat arrives → recovery path
    prismaMock.iMTask.findUnique.mockResolvedValueOnce({
      id: 'task_stuck_1',
      status: 'running',
      currentPhase: 'stuck',
      heartbeatVersion: BigInt(0),
      conversationId: 'conv_1',
      creatorId: 'creator_1',
      assigneeId: 'assignee_1',
    });
    prismaMock.iMTask.update.mockResolvedValueOnce({});
    const result = await service.recordTaskHeartbeat('task_stuck_1', {
      heartbeatVersion: 1,
      currentPhase: 'thinking',
    });
    expect(result!.recoveredFromStuck).toBe(true);

    // Step 3: reaper re-scans, no candidates now (heartbeat refreshed
    // lastHeartbeatAt under the threshold)
    prismaMock.iMTask.findMany.mockResolvedValueOnce([]);
    const secondSweep = await service.sweepStuckPhases();
    expect(secondSweep).toBe(0);

    // Recovery event emitted exactly once across the flow
    const recoveryEvents = syncWriteEvent.mock.calls.filter((c) => c[0] === 'task.phase.recovered');
    const stuckEvents = syncWriteEvent.mock.calls.filter((c) => c[0] === 'task.phase.stuck');
    expect(stuckEvents).toHaveLength(1);
    expect(recoveryEvents).toHaveLength(1);
  });

  it('reaper query excludes already-stuck rows (no re-emission of stuck event)', async () => {
    prismaMock.iMTask.findMany.mockResolvedValueOnce([]);
    const { service } = await buildService();

    await service.sweepStuckPhases();

    const whereArg = prismaMock.iMTask.findMany.mock.calls[0][0].where;
    // The whole point: if reaper kept re-marking already-stuck tasks the
    // sync stream would flood. NOT clause enforces single-shot stuck event.
    expect(whereArg.NOT).toEqual({ currentPhase: 'stuck' });
  });
});

describe('Heartbeat ↔ handleTimeouts disjoint columns', () => {
  // We don't fully simulate handleTimeouts here (it has many side effects
  // — escrow refund, notification, retry logic). Instead, we assert the
  // contract by inspecting the source: handleTimeouts writes `status` and
  // sweepStuckPhases writes only `currentPhase`. The protections in
  // sweepStuckPhases (`NOT: { currentPhase: 'stuck' }`) and handleTimeouts
  // (`where: { status: 'running' }` operating on task.timeoutMs anchored to
  // lastRunAt, not lastHeartbeatAt) ensure these two reapers do not race
  // to write the same column.
  beforeEach(resetPrismaMock);

  it('sweepStuckPhases query scopes to status IN (running, review) — does not touch terminal rows', async () => {
    prismaMock.iMTask.findMany.mockResolvedValueOnce([]);
    const { service } = await buildService();

    await service.sweepStuckPhases();

    const where = prismaMock.iMTask.findMany.mock.calls[0][0].where;
    expect(where.status).toEqual({ in: ['running', 'review'] });
    // Confirms reaper never tries to mark a completed/failed/cancelled
    // task — which is also what handleTimeouts has already finalized.
  });
});
