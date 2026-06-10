/**
 * Task heartbeat — v2.0 §4.2 Track B-1 acceptance tests.
 *
 * Covers `TaskService.recordTaskHeartbeat` (the unit that both the WS
 * `task.heartbeat` handler and the HTTP fallback `POST /tasks/:id/heartbeat`
 * delegate to), plus the §4.2 协同矩阵 invariant that recordTaskHeartbeat
 * never writes the `status` column.
 *
 * Test surface:
 *   - happy path: heartbeat writes lastHeartbeatAt + heartbeatVersion + currentPhase
 *   - stuck → recovered: previous phase='stuck' is cleared on new heartbeat
 *     and a `task.phase.recovered` sync event is emitted
 *   - stale heartbeat: lower heartbeatVersion is dropped silently
 *   - terminal status: heartbeats on completed/failed/cancelled are no-op
 *   - status column NEVER appears in update payload (§12.4 invariant)
 *   - missing task: returns null without throwing
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Prisma mock ────────────────────────────────────────────────
const prismaMock = {
  iMTask: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  iMUser: { findUnique: vi.fn() },
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

async function buildService(opts: { withSync?: boolean } = {}) {
  const { TaskService } = await import('@/im/services/task.service');
  const syncWriteEvent = vi.fn().mockResolvedValue(undefined);
  const service = new TaskService({
    eventBusService: { publish: vi.fn().mockResolvedValue(undefined) },
    rooms: { sendToUser: vi.fn() },
    syncService: opts.withSync === false ? undefined : ({ writeEvent: syncWriteEvent } as any),
  } as any);
  return { service, syncWriteEvent };
}

function taskFixture(over: Record<string, unknown> = {}) {
  return {
    id: 'task_1',
    status: 'running' as const,
    currentPhase: null as string | null,
    heartbeatVersion: BigInt(0),
    conversationId: 'conv_1',
    creatorId: 'creator_1',
    assigneeId: 'assignee_1',
    ...over,
  };
}

describe('TaskService.recordTaskHeartbeat — happy path', () => {
  beforeEach(resetPrismaMock);

  it('writes lastHeartbeatAt + heartbeatVersion + currentPhase, returns triple', async () => {
    prismaMock.iMTask.findUnique.mockResolvedValueOnce(taskFixture());
    prismaMock.iMTask.update.mockResolvedValueOnce({});
    const { service } = await buildService();

    const result = await service.recordTaskHeartbeat('task_1', {
      heartbeatVersion: 5,
      currentPhase: 'thinking',
    });

    expect(result).not.toBeNull();
    expect(result!.currentPhase).toBe('thinking');
    expect(result!.heartbeatVersion).toBe(5);
    expect(result!.recoveredFromStuck).toBe(false);

    expect(prismaMock.iMTask.update).toHaveBeenCalledTimes(1);
    const call = prismaMock.iMTask.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'task_1' });
    expect(call.data.currentPhase).toBe('thinking');
    expect(call.data.lastHeartbeatAt).toBeInstanceOf(Date);
    expect(typeof call.data.heartbeatVersion).toBe('bigint');
  });

  it('CRITICAL §12.4 invariant: update payload never contains status field', async () => {
    prismaMock.iMTask.findUnique.mockResolvedValueOnce(taskFixture({ status: 'running' }));
    prismaMock.iMTask.update.mockResolvedValueOnce({});
    const { service } = await buildService();

    await service.recordTaskHeartbeat('task_1', { heartbeatVersion: 1, currentPhase: 'tool_use' });

    const data = prismaMock.iMTask.update.mock.calls[0][0].data;
    // The phase signal must never write status. This is the load-bearing
    // contract between the reaper / heartbeat path and the canonical state
    // machine.
    expect(Object.keys(data)).not.toContain('status');
  });

  it('emits task.phase.recovered when previous phase was stuck', async () => {
    prismaMock.iMTask.findUnique.mockResolvedValueOnce(
      taskFixture({ currentPhase: 'stuck', heartbeatVersion: BigInt(3) }),
    );
    prismaMock.iMTask.update.mockResolvedValueOnce({});
    const { service, syncWriteEvent } = await buildService();

    const result = await service.recordTaskHeartbeat('task_1', {
      heartbeatVersion: 4,
      currentPhase: 'thinking',
    });

    expect(result!.recoveredFromStuck).toBe(true);
    expect(syncWriteEvent).toHaveBeenCalledTimes(1);
    const [eventType, eventData, convId, recipient] = syncWriteEvent.mock.calls[0];
    expect(eventType).toBe('task.phase.recovered');
    expect(eventData.taskId).toBe('task_1');
    expect(eventData.currentPhase).toBe('thinking');
    expect(convId).toBe('conv_1');
    expect(recipient).toBe('assignee_1');
  });

  it('does NOT emit task.phase.recovered when phase was not stuck', async () => {
    prismaMock.iMTask.findUnique.mockResolvedValueOnce(taskFixture({ currentPhase: 'thinking' }));
    prismaMock.iMTask.update.mockResolvedValueOnce({});
    const { service, syncWriteEvent } = await buildService();

    await service.recordTaskHeartbeat('task_1', { heartbeatVersion: 1, currentPhase: 'tool_use' });

    expect(syncWriteEvent).not.toHaveBeenCalled();
  });
});

describe('TaskService.recordTaskHeartbeat — drop conditions', () => {
  beforeEach(resetPrismaMock);

  it('returns null and skips update for terminal status (completed)', async () => {
    prismaMock.iMTask.findUnique.mockResolvedValueOnce(taskFixture({ status: 'completed' }));
    const { service } = await buildService();

    const result = await service.recordTaskHeartbeat('task_1', {
      heartbeatVersion: 1,
      currentPhase: 'tool_use',
    });

    expect(result).toBeNull();
    expect(prismaMock.iMTask.update).not.toHaveBeenCalled();
  });

  it('returns null for failed status', async () => {
    prismaMock.iMTask.findUnique.mockResolvedValueOnce(taskFixture({ status: 'failed' }));
    const { service } = await buildService();
    const result = await service.recordTaskHeartbeat('task_1', { heartbeatVersion: 1, currentPhase: 'tool_use' });
    expect(result).toBeNull();
    expect(prismaMock.iMTask.update).not.toHaveBeenCalled();
  });

  it('returns null for cancelled status', async () => {
    prismaMock.iMTask.findUnique.mockResolvedValueOnce(taskFixture({ status: 'cancelled' }));
    const { service } = await buildService();
    const result = await service.recordTaskHeartbeat('task_1', { heartbeatVersion: 1, currentPhase: 'tool_use' });
    expect(result).toBeNull();
    expect(prismaMock.iMTask.update).not.toHaveBeenCalled();
  });

  it('drops stale heartbeat (heartbeatVersion < persistedVersion)', async () => {
    prismaMock.iMTask.findUnique.mockResolvedValueOnce(taskFixture({ heartbeatVersion: BigInt(10) }));
    const { service } = await buildService();

    const result = await service.recordTaskHeartbeat('task_1', { heartbeatVersion: 5, currentPhase: 'thinking' });

    expect(result).toBeNull();
    expect(prismaMock.iMTask.update).not.toHaveBeenCalled();
  });

  it('returns null when task not found', async () => {
    prismaMock.iMTask.findUnique.mockResolvedValueOnce(null);
    const { service } = await buildService();

    const result = await service.recordTaskHeartbeat('nope', { heartbeatVersion: 1, currentPhase: 'thinking' });

    expect(result).toBeNull();
    expect(prismaMock.iMTask.update).not.toHaveBeenCalled();
  });
});

describe('TaskService.recordTaskHeartbeat — sync service optional', () => {
  beforeEach(resetPrismaMock);

  it('works without syncService dep (recovery path is silent)', async () => {
    prismaMock.iMTask.findUnique.mockResolvedValueOnce(taskFixture({ currentPhase: 'stuck' }));
    prismaMock.iMTask.update.mockResolvedValueOnce({});
    const { service } = await buildService({ withSync: false });

    const result = await service.recordTaskHeartbeat('task_1', {
      heartbeatVersion: 1,
      currentPhase: 'thinking',
    });

    expect(result!.recoveredFromStuck).toBe(true);
    // Update still happened, just no event emission (no syncService).
    expect(prismaMock.iMTask.update).toHaveBeenCalledTimes(1);
  });
});
