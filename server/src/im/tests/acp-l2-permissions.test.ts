import { beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = {
  iMUser: { findUnique: vi.fn(), findFirst: vi.fn() },
  iMTask: { findUnique: vi.fn() },
  iMTaskRun: { findUnique: vi.fn() },
  iMAgentProfile: { findFirst: vi.fn() },
  iMConversation: { findUnique: vi.fn() },
  iMWorkspace: { findUnique: vi.fn(), findFirst: vi.fn() },
  // v2.0 release 200 P2: loadTaskActor consults workspace-member rows for
  // role tier. Default to unmocked (no member row) so existing assertions
  // about "executor without workspace role → TaskAccessError" still hold.
  iMWorkspaceMember: { findFirst: vi.fn() },
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
      fn.mockReset();
    }
  }
}

function contextForAgent(imUserId: string) {
  return {
    get: vi.fn(() => ({ role: 'agent', imUserId })),
    json: vi.fn((body: unknown, status: number) => new Response(JSON.stringify(body), { status })),
  };
}

function taskRecord(overrides: Record<string, unknown> = {}) {
  const now = new Date('2026-05-13T00:00:00.000Z');
  return {
    id: 'task_1',
    title: 'Task',
    description: null,
    capability: null,
    input: '{}',
    contextUri: null,
    creatorId: 'creator',
    assigneeId: null,
    workspaceId: 'ws_1',
    conversationId: null,
    status: 'review',
    progress: null,
    statusMessage: null,
    scheduleType: null,
    scheduleCron: null,
    intervalMs: null,
    nextRunAt: null,
    lastRunAt: null,
    runCount: 0,
    maxRuns: null,
    result: null,
    resultUri: null,
    error: null,
    budget: null,
    cost: 0,
    timeoutMs: 300000,
    deadline: null,
    completedAt: null,
    maxRetries: 3,
    retryDelayMs: 60000,
    retryCount: 0,
    metadata: '{}',
    runtimeRoute: 'agent',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('ACP L2 cloud MCP allowlist guard', () => {
  beforeEach(resetPrismaMock);

  it('uses agent profile mcpAllowlist before role template allowlist', async () => {
    const { resolveMcpAllowlist, isMcpToolAllowed } = await import('@/im/security/mcp-allowlist');

    const allowlist = resolveMcpAllowlist({
      mcpAllowlist: ['prismer.task.create'],
      roleTemplate: {
        mcpServers: [{ package: '@prismer/mcp-server', toolsAllowlist: ['prismer.task.approve'] }],
      },
    }) as string[];

    expect(allowlist).toEqual(['prismer.task.create']);
    expect(isMcpToolAllowed('prismer.task.create', allowlist)).toBe(true);
    expect(isMcpToolAllowed('prismer.task.approve', allowlist)).toBe(false);
  });

  it('rejects direct privileged route calls from an agent without allowlist entry', async () => {
    const { requireAgentToolAllowed } = await import('@/im/security/mcp-allowlist');
    prismaMock.iMAgentProfile.findFirst.mockResolvedValue({
      config: JSON.stringify({ mcpAllowlist: ['prismer.task.create'] }),
    });

    const denied = await requireAgentToolAllowed(
      contextForAgent('agent_executor') as any,
      'prismer.task.approve',
      'ws_1',
    );

    expect(denied).toBeInstanceOf(Response);
    expect(denied?.status).toBe(403);
  });
});

describe('ACP L2 taskAuthority matrix', () => {
  beforeEach(resetPrismaMock);

  it('executor cannot assign, approve, or reject another actor task', async () => {
    const { TaskService, TaskAccessError, OrchestratorRequiredError } = await import('@/im/services/task.service');
    prismaMock.iMUser.findUnique.mockResolvedValue({ id: 'executor', role: 'agent', trustTier: 0 });
    prismaMock.iMTask.findUnique.mockResolvedValue({ workspaceId: 'ws_1' });
    prismaMock.iMAgentProfile.findFirst.mockResolvedValue({
      config: JSON.stringify({ taskAuthority: 'executor' }),
    });

    const service = new TaskService({} as any);
    const baseTask = taskRecord({ creatorId: 'creator', assigneeId: 'assignee', status: 'review' });
    (service as any).taskModel = {
      findById: vi.fn().mockResolvedValue(baseTask),
      update: vi.fn(),
      createLog: vi.fn(),
    };

    await expect(service.updateTask('task_1', 'executor', { assigneeId: 'other' })).rejects.toBeInstanceOf(
      TaskAccessError,
    );
    await expect(service.approveTask('task_1', 'executor')).rejects.toBeInstanceOf(OrchestratorRequiredError);
    await expect(service.rejectTask('task_1', 'executor', 'no')).rejects.toBeInstanceOf(OrchestratorRequiredError);
  });

  it('orchestrator needs human CEO dispatch authorization before controlling workspace tasks', async () => {
    const { TaskService, OrchestratorRequiredError } = await import('@/im/services/task.service');
    prismaMock.iMUser.findUnique
      .mockResolvedValueOnce({ id: 'orchestrator', role: 'agent', userId: 'cloud-1', trustTier: 0 })
      .mockResolvedValueOnce({ id: 'orchestrator', role: 'agent', userId: 'cloud-1', trustTier: 0 });
    prismaMock.iMTask.findUnique.mockResolvedValue({ workspaceId: 'ws_1' });
    prismaMock.iMAgentProfile.findFirst.mockResolvedValue({
      config: JSON.stringify({ taskAuthority: 'orchestrator' }),
    });
    prismaMock.iMUser.findFirst.mockResolvedValue({
      metadata: JSON.stringify({ ceoPermissions: { canDispatch: false } }),
    });
    prismaMock.iMWorkspace.findFirst.mockResolvedValue(null);

    const service = new TaskService({ eventBusService: { publish: vi.fn().mockResolvedValue(undefined) } } as any);
    (service as any).taskModel = {
      findById: vi.fn().mockResolvedValue(taskRecord({ status: 'review', assigneeId: null })),
      update: vi.fn(),
      createLog: vi.fn(),
    };

    await expect(service.approveTask('task_1', 'orchestrator')).rejects.toBeInstanceOf(OrchestratorRequiredError);
  });

  it('orchestrator can assign, approve, and reject workspace tasks when Settings dispatch is authorized', async () => {
    const { TaskService } = await import('@/im/services/task.service');
    prismaMock.iMUser.findUnique.mockResolvedValue({
      id: 'orchestrator',
      role: 'agent',
      userId: 'cloud-1',
      trustTier: 0,
    });
    prismaMock.iMTask.findUnique.mockResolvedValue({ workspaceId: 'ws_1' });
    prismaMock.iMAgentProfile.findFirst.mockResolvedValue({
      config: JSON.stringify({ taskAuthority: 'orchestrator' }),
    });
    prismaMock.iMUser.findFirst.mockResolvedValue({
      metadata: JSON.stringify({ ceoPermissions: { canDispatch: true } }),
    });

    const service = new TaskService({ eventBusService: { publish: vi.fn().mockResolvedValue(undefined) } } as any);
    (service as any).notifyAgent = vi.fn(() => Promise.resolve());
    (service as any).fanOutBellSync = vi.fn(() => Promise.resolve());
    (service as any).emitTaskStatusChat = vi.fn(() => Promise.resolve());
    const pending = taskRecord({ status: 'pending', assigneeId: null });
    const review = taskRecord({ status: 'review', assigneeId: null });
    (service as any).taskModel = {
      findById: vi.fn().mockResolvedValueOnce(pending).mockResolvedValueOnce(review).mockResolvedValueOnce(review),
      update: vi
        .fn()
        .mockResolvedValueOnce(taskRecord({ status: 'assigned', assigneeId: 'assignee' }))
        .mockResolvedValueOnce(taskRecord({ status: 'completed' }))
        .mockResolvedValueOnce(taskRecord({ status: 'failed', error: 'no' })),
      createLog: vi.fn().mockResolvedValue(undefined),
    };

    await expect(service.updateTask('task_1', 'orchestrator', { assigneeId: 'assignee' })).resolves.toMatchObject({
      assigneeId: 'assignee',
    });
    await expect(service.approveTask('task_1', 'orchestrator')).resolves.toMatchObject({ status: 'completed' });
    await expect(service.rejectTask('task_1', 'orchestrator', 'no')).resolves.toMatchObject({ status: 'failed' });
  });

  it('orchestrator status PATCH uses the control-plane execution path when Settings dispatch is authorized', async () => {
    const { TaskService } = await import('@/im/services/task.service');
    prismaMock.iMUser.findUnique.mockResolvedValue({
      id: 'orchestrator',
      role: 'agent',
      userId: 'cloud-1',
      trustTier: 0,
    });
    prismaMock.iMTask.findUnique.mockResolvedValue({ workspaceId: 'ws_1' });
    prismaMock.iMAgentProfile.findFirst.mockResolvedValue({
      config: JSON.stringify({ taskAuthority: 'orchestrator' }),
    });
    prismaMock.iMUser.findFirst.mockResolvedValue({
      metadata: JSON.stringify({ ceoPermissions: { canDispatch: true } }),
    });

    const service = new TaskService({ eventBusService: { publish: vi.fn().mockResolvedValue(undefined) } } as any);
    (service as any).notifyAgent = vi.fn(() => Promise.resolve());
    (service as any).emitTaskStatusChat = vi.fn(() => Promise.resolve());
    (service as any).taskModel = {
      findById: vi.fn().mockResolvedValue(taskRecord({ status: 'assigned', assigneeId: 'assignee' })),
      update: vi.fn().mockResolvedValue(taskRecord({ status: 'review', assigneeId: 'assignee' })),
      createLog: vi.fn().mockResolvedValue(undefined),
    };

    await expect(
      service.updateTask('task_1', 'orchestrator', { status: 'review', statusMessage: 'ready for review' }),
    ).resolves.toMatchObject({ status: 'review' });
  });

  it('orchestrator can drag a kanban card (status + assigneeId + kanban-view metadata)', async () => {
    // Regression for: "Access denied for task ... only the task creator or
    // assignee can update this task" surfaced when a workspace owner dragged
    // a card to another column. The drag PATCH sends status + assigneeId +
    // metadata containing kanban-view fields (columnId / cardOrder / kanban
    // sub-object / reason). Pre-fix the check rejected the whole shape
    // because metadata !== undefined disqualified isExecutionControlOnly.
    const { TaskService } = await import('@/im/services/task.service');
    prismaMock.iMUser.findUnique.mockResolvedValue({
      id: 'workspace-owner',
      role: 'human',
      trustTier: 0,
    });
    prismaMock.iMTask.findUnique.mockResolvedValue({ workspaceId: 'ws_1' });
    // v2.0 P2 resolver: workspace.ownerImUserId match → L0 owner tier.
    prismaMock.iMWorkspace.findFirst.mockResolvedValue({
      id: 'ws_1',
      ownerImUserId: 'workspace-owner',
    });

    const service = new TaskService({ eventBusService: { publish: vi.fn().mockResolvedValue(undefined) } } as any);
    (service as any).notifyAgent = vi.fn(() => Promise.resolve());
    (service as any).emitTaskStatusChat = vi.fn(() => Promise.resolve());
    (service as any).fanOutBellSync = vi.fn(() => Promise.resolve());
    // Stub the downstream `forceExecutionStatus` so the test focuses on the
    // access check (the unit under repair). The full execution-control
    // pipeline has its own coverage elsewhere.
    const forceStub = vi.fn().mockResolvedValue(taskRecord({ status: 'running', assigneeId: 'assignee' }));
    (service as any).forceExecutionStatus = forceStub;
    const before = taskRecord({ status: 'assigned', creatorId: 'someone-else', assigneeId: 'assignee' });
    (service as any).taskModel = {
      findById: vi.fn().mockResolvedValue(before),
      update: vi.fn().mockResolvedValue(taskRecord({ status: 'running', assigneeId: 'assignee' })),
      createLog: vi.fn().mockResolvedValue(undefined),
    };

    await expect(
      service.updateTask('task_1', 'workspace-owner', {
        status: 'running',
        assigneeId: 'assignee',
        forceExecutionStatus: true,
        metadata: {
          columnId: 'in_progress',
          cardStatus: 'running',
          cardPriority: 'medium',
          cardOrder: Date.now(),
          kanban: { columnId: 'in_progress', cardOrder: 1 },
          reason: 'Kanban move',
        },
      }),
    ).resolves.toMatchObject({ status: 'running' });
    expect(forceStub).toHaveBeenCalled();
  });

  it('human workspace owner gets full PATCH rights — no shape restriction', async () => {
    // Tier separation: orchestrator authority gates WHO can update, and a
    // shape constraint additionally gates WHAT agents can update. Humans
    // (workspace owner/admin) skip the shape constraint, because spreading
    // existing task.metadata in a kanban drag PATCH (the frontend's actual
    // payload shape) would otherwise be rejected as "non-kanban metadata".
    const { TaskService } = await import('@/im/services/task.service');
    prismaMock.iMUser.findUnique.mockResolvedValue({
      id: 'workspace-owner',
      role: 'human',
      trustTier: 0,
    });
    prismaMock.iMTask.findUnique.mockResolvedValue({ workspaceId: 'ws_1' });
    // v2.0 P2 resolver: workspace.ownerImUserId match → L0 owner tier.
    prismaMock.iMWorkspace.findFirst.mockResolvedValue({
      id: 'ws_1',
      ownerImUserId: 'workspace-owner',
    });

    const service = new TaskService({ eventBusService: { publish: vi.fn().mockResolvedValue(undefined) } } as any);
    // The real kanban drag PATCH sends forceExecutionStatus:true which
    // short-circuits to forceExecutionStatus() — stub it so the test only
    // verifies the access check, not the full execution pipeline.
    const forceStub = vi
      .fn()
      .mockResolvedValue(taskRecord({ status: 'running', assigneeId: 'assignee' }));
    (service as any).forceExecutionStatus = forceStub;
    (service as any).taskModel = {
      findById: vi.fn().mockResolvedValue(
        taskRecord({
          status: 'assigned',
          creatorId: 'someone-else',
          assigneeId: 'assignee',
          metadata: JSON.stringify({ kind: 'work_item', priority: 'high', tags: ['a', 'b'] }),
        }),
      ),
      update: vi.fn().mockResolvedValue(taskRecord({ status: 'running', assigneeId: 'assignee' })),
      createLog: vi.fn().mockResolvedValue(undefined),
    };

    // Drag payload spreads existing metadata (kind/priority/tags) plus the
    // kanban view fields — historically blocked by the metadata whitelist.
    // Now allowed because the human is workspace owner.
    await expect(
      service.updateTask('task_1', 'workspace-owner', {
        status: 'running',
        assigneeId: 'assignee',
        forceExecutionStatus: true,
        metadata: {
          kind: 'work_item',
          priority: 'high',
          tags: ['a', 'b'],
          columnId: 'in_progress',
          cardOrder: Date.now(),
          kanban: { columnId: 'in_progress' },
        },
      }),
    ).resolves.toMatchObject({ status: 'running' });
    expect(forceStub).toHaveBeenCalled();
  });

  it('orchestrator agent cannot rewrite arbitrary fields even with authority', async () => {
    // Shape constraint applies to AGENT actors only. A workspace human
    // owner is unrestricted; an orchestrator agent must stay within the
    // safe shapes (assignment-only, execution-control-only, kanban-move).
    const { TaskService, TaskAccessError } = await import('@/im/services/task.service');
    prismaMock.iMUser.findUnique.mockResolvedValue({
      id: 'orchestrator-agent',
      role: 'agent',
      userId: 'cloud-1',
      trustTier: 0,
    });
    prismaMock.iMTask.findUnique.mockResolvedValue({ workspaceId: 'ws_1' });
    prismaMock.iMAgentProfile.findFirst.mockResolvedValue({
      config: JSON.stringify({ taskAuthority: 'orchestrator' }),
    });
    prismaMock.iMUser.findFirst.mockResolvedValue({
      metadata: JSON.stringify({ ceoPermissions: { canDispatch: true } }),
    });

    const service = new TaskService({} as any);
    (service as any).taskModel = {
      findById: vi.fn().mockResolvedValue(
        taskRecord({ status: 'assigned', creatorId: 'someone-else', assigneeId: 'assignee' }),
      ),
      update: vi.fn(),
      createLog: vi.fn(),
    };

    // Title rewrite by orchestrator agent is rejected even though agent has
    // orchestrator authority — content edits are creator-only.
    await expect(
      service.updateTask('task_1', 'orchestrator-agent', {
        title: 'agent rewrote this',
      }),
    ).rejects.toBeInstanceOf(TaskAccessError);
  });

  it('orchestrator cannot operate outside its workspace', async () => {
    const { hasTaskOrchestratorAuthority } = await import('@/im/services/task.service');
    prismaMock.iMUser.findUnique.mockResolvedValue({ id: 'orchestrator', role: 'agent', trustTier: 0 });
    prismaMock.iMTask.findUnique.mockResolvedValue({ workspaceId: 'ws_2' });
    prismaMock.iMAgentProfile.findFirst.mockResolvedValue(null);

    await expect(hasTaskOrchestratorAuthority('task_1', 'orchestrator', 'creator')).resolves.toBe(false);
  });

  it('admin role and trust tier escape hatches work', async () => {
    const { hasTaskOrchestratorAuthority } = await import('@/im/services/task.service');
    prismaMock.iMTask.findUnique.mockResolvedValue({ workspaceId: 'ws_2' });
    prismaMock.iMAgentProfile.findFirst.mockResolvedValue(null);

    prismaMock.iMUser.findUnique.mockResolvedValueOnce({ id: 'admin', role: 'admin', trustTier: 0 });
    await expect(hasTaskOrchestratorAuthority('task_1', 'admin', 'creator')).resolves.toBe(true);

    prismaMock.iMUser.findUnique.mockResolvedValueOnce({ id: 'trusted', role: 'agent', trustTier: 4 });
    await expect(hasTaskOrchestratorAuthority('task_1', 'trusted', 'creator')).resolves.toBe(true);
  });
});
