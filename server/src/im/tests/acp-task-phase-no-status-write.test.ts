/**
 * Reaper status-column audit — v2.0 §4.2 + §12.4 invariant.
 *
 * The phase-level heartbeat / reaper is the only mutation path in the
 * task state machine that is allowed to bypass `transitionTask` /
 * `forceTransitionTask`. The trade-off is that it MUST NOT write the
 * `status` column under any code path — that responsibility is reserved
 * for `handleTimeouts` (which is the 5min hard-timeout reaper) and the
 * canonical transition matrix.
 *
 * Violating this invariant would mean a 45s silence on a daemon could
 * silently flip a task to a different state without going through the
 * permission / log / digest pipeline — surfacing wrong states in the
 * kanban and bypassing the §12.4 force-transition escape hatch contract.
 *
 * This file is a pure audit: it intercepts every prisma.iMTask.update
 * call made by `sweepStuckPhases` and `recordTaskHeartbeat` and asserts
 * the update payload does NOT contain a `status` key.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = {
  iMTask: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
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

const FORBIDDEN_KEYS = ['status', 'retryCount', 'error', 'completedAt'] as const;

function serializeData(data: Record<string, unknown>): string {
  // BigInt is not JSON-serializable; render as decimal string for diagnostics.
  return JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
}

function assertNoStatusWrites(updateMock: ReturnType<typeof vi.fn>) {
  for (const call of updateMock.mock.calls) {
    const data = call[0]?.data ?? {};
    for (const key of FORBIDDEN_KEYS) {
      expect(
        Object.prototype.hasOwnProperty.call(data, key),
        `reaper-path update wrote forbidden key "${key}" — violates §12.4 invariant. payload=${serializeData(data)}`,
      ).toBe(false);
    }
  }
}

async function buildService() {
  const { TaskService } = await import('@/im/services/task.service');
  return new TaskService({
    eventBusService: { publish: vi.fn().mockResolvedValue(undefined) },
    rooms: { sendToUser: vi.fn() },
    syncService: { writeEvent: vi.fn().mockResolvedValue(undefined) } as any,
  } as any);
}

function reset() {
  for (const m of Object.values(prismaMock)) {
    for (const fn of Object.values(m)) (fn as { mockReset: () => void }).mockReset();
  }
}

describe('Reaper / heartbeat: status column write audit (§12.4)', () => {
  beforeEach(reset);

  it('sweepStuckPhases — single task: status untouched', async () => {
    prismaMock.iMTask.findMany.mockResolvedValueOnce([
      {
        id: 't1',
        conversationId: 'c1',
        creatorId: 'cr',
        assigneeId: 'as',
        lastHeartbeatAt: new Date(Date.now() - 60_000),
        currentPhase: 'thinking',
      },
    ]);
    prismaMock.iMTask.update.mockResolvedValueOnce({});

    const service = await buildService();
    await service.sweepStuckPhases();

    assertNoStatusWrites(prismaMock.iMTask.update);
  });

  it('sweepStuckPhases — many tasks in one sweep: all updates clean', async () => {
    const candidates = Array.from({ length: 25 }, (_, i) => ({
      id: `t_${i}`,
      conversationId: `c_${i}`,
      creatorId: 'cr',
      assigneeId: 'as',
      lastHeartbeatAt: new Date(Date.now() - 60_000),
      currentPhase: ['thinking', 'tool_use', 'reasoning', null][i % 4] as string | null,
    }));
    prismaMock.iMTask.findMany.mockResolvedValueOnce(candidates);
    prismaMock.iMTask.update.mockResolvedValue({});

    const service = await buildService();
    await service.sweepStuckPhases();

    expect(prismaMock.iMTask.update.mock.calls.length).toBe(25);
    assertNoStatusWrites(prismaMock.iMTask.update);
  });

  it('recordTaskHeartbeat — phase set: status untouched', async () => {
    prismaMock.iMTask.findUnique.mockResolvedValueOnce({
      id: 't1',
      status: 'running',
      currentPhase: 'thinking',
      heartbeatVersion: BigInt(0),
      conversationId: 'c1',
      creatorId: 'cr',
      assigneeId: 'as',
    });
    prismaMock.iMTask.update.mockResolvedValueOnce({});

    const service = await buildService();
    await service.recordTaskHeartbeat('t1', { heartbeatVersion: 1, currentPhase: 'tool_use' });

    assertNoStatusWrites(prismaMock.iMTask.update);
  });

  it('recordTaskHeartbeat — stuck recovery: status STILL untouched', async () => {
    prismaMock.iMTask.findUnique.mockResolvedValueOnce({
      id: 't1',
      status: 'running',
      currentPhase: 'stuck',
      heartbeatVersion: BigInt(3),
      conversationId: 'c1',
      creatorId: 'cr',
      assigneeId: 'as',
    });
    prismaMock.iMTask.update.mockResolvedValueOnce({});

    const service = await buildService();
    const result = await service.recordTaskHeartbeat('t1', {
      heartbeatVersion: 4,
      currentPhase: 'thinking',
    });

    expect(result!.recoveredFromStuck).toBe(true);
    assertNoStatusWrites(prismaMock.iMTask.update);
  });

  it('recordTaskHeartbeat — terminal status: update SKIPPED entirely', async () => {
    // Defense in depth — the phase path should never even attempt to
    // touch a terminal-status task, ensuring no race with handleTimeouts'
    // status update.
    prismaMock.iMTask.findUnique.mockResolvedValueOnce({
      id: 't1',
      status: 'failed',
      currentPhase: null,
      heartbeatVersion: BigInt(0),
      conversationId: 'c1',
      creatorId: 'cr',
      assigneeId: 'as',
    });

    const service = await buildService();
    await service.recordTaskHeartbeat('t1', { heartbeatVersion: 1, currentPhase: 'thinking' });

    expect(prismaMock.iMTask.update).not.toHaveBeenCalled();
  });
});
