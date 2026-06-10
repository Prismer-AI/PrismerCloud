import { beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = {
  iMTask: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  iMTaskRun: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  iMAsset: {
    findMany: vi.fn(),
  },
  iMAgentCard: {
    findUnique: vi.fn(),
  },
  iMWorkspace: {
    findFirst: vi.fn(),
  },
};

vi.mock('@/lib/prisma', () => ({ default: prismaMock, prisma: prismaMock }));
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
      fn.mockReset();
    }
  }
}

function makeRooms() {
  return {
    getClientConnections: vi.fn(() => new Set([{}])),
    sendToUser: vi.fn(),
  };
}

describe('TaskService asset dispatch hydration', () => {
  beforeEach(resetPrismaMock);

  it('hydrates run metadata assets into daemon payload.assetRefs and records run observability', async () => {
    const { TaskService } = await import('@/im/services/task.service');
    const rooms = makeRooms();
    const runMetadata = JSON.stringify({
      profileId: 'prof_1',
      assets: { aggregatedAssetIds: ['asset_xlsx'] },
    });
    const run = {
      id: 'run_asset_1',
      taskId: null,
      workspaceId: 'ws_1',
      conversationId: 'conv_1',
      triggerMessageId: 'msg_1',
      creatorId: 'human_1',
      assigneeId: 'agent_1',
      actorId: 'human_1',
      sourceKind: 'chat',
      capability: 'chat',
      status: 'assigned',
      runtimeRoute: 'agent',
      input: JSON.stringify({ prompt: 'read the attached spreadsheet' }),
      output: null,
      outputUri: null,
      error: null,
      startedAt: null,
      completedAt: null,
      metadata: runMetadata,
      createdAt: new Date('2026-05-18T00:00:00.000Z'),
      updatedAt: new Date('2026-05-18T00:00:00.000Z'),
    };

    prismaMock.iMAsset.findMany.mockResolvedValue([
      {
        id: 'asset_xlsx',
        contentHash: 'a'.repeat(64),
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        sizeBytes: BigInt(15962),
        kind: 'file',
        workspaceId: 'ws_1',
      },
    ]);
    prismaMock.iMTask.findUnique.mockResolvedValue(null);
    prismaMock.iMTaskRun.findUnique.mockResolvedValue({ metadata: runMetadata });
    prismaMock.iMTaskRun.update.mockResolvedValue({});
    prismaMock.iMAgentCard.findUnique.mockResolvedValue(null);

    const service = new TaskService({
      rooms,
      redis: {},
      messageService: {},
      conversationService: {},
      syncService: { writeEvent: vi.fn().mockResolvedValue(undefined) },
    } as unknown as ConstructorParameters<typeof TaskService>[0]);
    (service as unknown as { taskModel: { findRunById: ReturnType<typeof vi.fn> } }).taskModel = {
      findRunById: vi.fn().mockResolvedValue(run),
    };

    await service.dispatchTaskRun('run_asset_1', 'agent_1', 'task.assigned');

    expect(rooms.sendToUser).toHaveBeenCalledTimes(1);
    const [routeKey, message] = rooms.sendToUser.mock.calls[0];
    expect(routeKey).toBe('agent_1');
    expect(message.type).toBe('task.dispatch.request');
    expect(message.payload.assetRefs).toEqual([
      {
        assetId: 'asset_xlsx',
        contentHash: 'a'.repeat(64),
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        sizeBytes: 15962,
        kind: 'file',
        workspaceId: 'ws_1',
        role: 'attachment',
      },
    ]);
    expect(message.payload.metadata.assets).toBeUndefined();

    expect(prismaMock.iMTaskRun.update).toHaveBeenCalledTimes(1);
    const updateArg = prismaMock.iMTaskRun.update.mock.calls[0][0];
    const updatedMeta = JSON.parse(updateArg.data.metadata);
    expect(updatedMeta.observability.assets.requested).toBe(1);
    expect(updatedMeta.observability.assets.requestedRefs[0].assetId).toBe('asset_xlsx');
  });
});
