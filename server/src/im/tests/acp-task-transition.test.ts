/**
 * Task transition API — release 200 P3 acceptance tests.
 *
 * Covers `TaskService.transitionTask` + `TaskService.forceTransitionTask`
 * — the unified state-machine entry points introduced in v2.0 (§5 + §6.1).
 *
 * Test surface (28 cases):
 *   - Happy paths for each TRANSITIONS rule that exercises a non-trivial
 *     actor tier (covers all 8 status keys at least once).
 *   - Critical contract: `review → completed`/`review → assigned` by
 *     assignee → 403 (the v2.0 "no self-approval" rule).
 *   - Workspace owner / orchestrator / creator all succeed on review →
 *     completed.
 *   - Invalid transitions (e.g. backlog→completed) → 409 with
 *     `allowedFromHere`.
 *   - force-transition by non-admin → 403; by admin → 200 (bypass matrix);
 *     reason required.
 *   - Structural preconditions: pending → assigned needs assigneeId; the
 *     `position` field flows through to the DB write.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Prisma mock (mirrors acp-task-permission-resolver.test.ts) ─────
const prismaMock = {
  iMUser: { findUnique: vi.fn(), findFirst: vi.fn() },
  iMTask: { findUnique: vi.fn() },
  iMTaskRun: { findUnique: vi.fn() },
  iMAgentProfile: { findFirst: vi.fn() },
  iMConversation: { findUnique: vi.fn() },
  iMWorkspace: { findUnique: vi.fn(), findFirst: vi.fn() },
  iMWorkspaceMember: { findFirst: vi.fn() },
  iMAsset: { count: vi.fn(), findMany: vi.fn() },
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
      (fn as { mockReset: () => void }).mockReset();
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────
type Status = 'pending' | 'assigned' | 'running' | 'review' | 'blocked' | 'failed' | 'completed' | 'cancelled';

function taskRecord(overrides: Record<string, unknown> = {}) {
  const now = new Date('2026-05-19T00:00:00.000Z');
  return {
    id: 'task_1',
    title: 'Task',
    description: null,
    capability: null,
    input: '{}',
    contextUri: null,
    creatorId: 'creator',
    assigneeId: 'assignee',
    workspaceId: 'ws_1',
    conversationId: null,
    status: 'assigned' as Status,
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

/**
 * Build a TaskService instance with stubbed side-effect helpers so the
 * tests can focus on the permission + state machine logic without firing
 * actual WebSocket / EventBus / DB writes for collateral effects.
 */
async function buildService(
  baseTask: ReturnType<typeof taskRecord>,
  afterUpdate?: Partial<ReturnType<typeof taskRecord>>,
) {
  const { TaskService } = await import('@/im/services/task.service');
  const service = new TaskService({
    eventBusService: { publish: vi.fn().mockResolvedValue(undefined) },
    rooms: { sendToUser: vi.fn() },
  } as any);
  // Stub side-effect helpers (none of these is the unit under test).
  (service as any).notifyAgent = vi.fn().mockResolvedValue(undefined);
  (service as any).notifyUser = vi.fn().mockResolvedValue(undefined);
  (service as any).fanOutBellSync = vi.fn().mockResolvedValue(undefined);
  (service as any).emitTaskStatusChat = vi.fn().mockResolvedValue(undefined);
  (service as any).emitDaemonDispatchRequest = vi.fn().mockResolvedValue(undefined);
  (service as any).emitShellDispatchRequest = vi.fn().mockResolvedValue(undefined);
  (service as any).emitDaemonCancel = vi.fn();
  (service as any).emitRuntimeCancel = vi.fn();
  (service as any).recordEvolutionOutcome = vi.fn().mockResolvedValue(undefined);
  const updateMock = vi.fn().mockResolvedValue({ ...baseTask, ...(afterUpdate ?? {}) });
  (service as any).taskModel = {
    findById: vi.fn().mockResolvedValue(baseTask),
    update: updateMock,
    createLog: vi.fn().mockResolvedValue(undefined),
  };
  return { service, updateMock };
}

// Convenience: stand-up the user/workspace mock for a given actor profile.
function mockActor(opts: {
  imUserId: string;
  role?: 'human' | 'agent' | 'admin';
  trustTier?: number;
  workspaceOwnerImUserId?: string | null;
  memberRole?: 'owner' | 'admin' | 'member' | null;
  orchestratorAgentId?: string | null;
  orchestratorRevokedAt?: Date | null;
}) {
  prismaMock.iMUser.findUnique.mockResolvedValue({
    id: opts.imUserId,
    role: opts.role ?? 'human',
    trustTier: opts.trustTier ?? 0,
  });
  prismaMock.iMWorkspace.findFirst.mockResolvedValue({
    id: 'ws_1',
    ownerImUserId: opts.workspaceOwnerImUserId ?? null,
    orchestratorAgentId: opts.orchestratorAgentId ?? null,
    orchestratorRevokedAt: opts.orchestratorRevokedAt ?? null,
  });
  if (opts.memberRole) {
    prismaMock.iMWorkspaceMember.findFirst.mockResolvedValue({ role: opts.memberRole });
  } else {
    prismaMock.iMWorkspaceMember.findFirst.mockResolvedValue(null);
  }
  // Default — no legacy 30-acp agent profile fallback unless overridden.
  prismaMock.iMAgentProfile.findFirst.mockResolvedValue(null);
  // S20 (doc 10 rev 2) — running → review goes through
  // validateAcceptanceEvidenceForReview which calls
  // task-acceptance.service::getAcceptance → prisma.iMTask.findUnique. Default
  // to "no acceptance criteria" (opt-out path) so transition tests that don't
  // exercise the acceptance gate continue to focus on permission/state-machine.
  prismaMock.iMTask.findUnique.mockResolvedValue({
    acceptanceCriteriaJson: null,
    acceptanceStatus: null,
  });
}

// ─── Happy paths covering each TRANSITIONS rule once ────────────────

describe('transitionTask — happy paths (every transition rule)', () => {
  beforeEach(resetPrismaMock);

  it('pending → assigned by creator (with assigneeId)', async () => {
    const t = taskRecord({ status: 'pending', assigneeId: null, creatorId: 'creator' });
    const { service, updateMock } = await buildService(t, { status: 'assigned', assigneeId: 'agent_1' });
    mockActor({ imUserId: 'creator', memberRole: 'member' });

    const result = await service.transitionTask('task_1', 'creator', {
      to: 'assigned',
      assigneeId: 'agent_1',
    });
    expect(result.status).toBe('assigned');
    expect(updateMock).toHaveBeenCalled();
    const data = updateMock.mock.calls[0][1];
    expect(data.status).toBe('assigned');
    expect(data.assigneeId).toBe('agent_1');
  });

  it('pending → cancelled by creator', async () => {
    const t = taskRecord({ status: 'pending', assigneeId: null, creatorId: 'creator' });
    const { service } = await buildService(t, { status: 'cancelled' });
    mockActor({ imUserId: 'creator', memberRole: 'member' });

    await expect(service.transitionTask('task_1', 'creator', { to: 'cancelled' })).resolves.toMatchObject({
      status: 'cancelled',
    });
  });

  it('assigned → running by assignee (enqueue-run side effect)', async () => {
    const t = taskRecord({ status: 'assigned', assigneeId: 'assignee_id' });
    const { service, updateMock } = await buildService(t, { status: 'running', assigneeId: 'assignee_id' });
    mockActor({ imUserId: 'assignee_id', role: 'agent' });

    const result = await service.transitionTask('task_1', 'assignee_id', { to: 'running' });
    expect(result.status).toBe('running');
    const data = updateMock.mock.calls[0][1];
    expect(data.status).toBe('running');
    // Mirror forceExecutionStatus behaviour — clear completedAt + bump runCount.
    expect(data.completedAt).toBeNull();
    expect(data.runCount).toEqual({ increment: 1 });
  });

  it('assigned → pending (unassign) by creator', async () => {
    const t = taskRecord({ status: 'assigned', creatorId: 'creator' });
    const { service } = await buildService(t, { status: 'pending' });
    mockActor({ imUserId: 'creator', memberRole: 'member' });

    await expect(service.transitionTask('task_1', 'creator', { to: 'pending' })).resolves.toMatchObject({
      status: 'pending',
    });
  });

  it('assigned → cancelled by creator', async () => {
    const t = taskRecord({ status: 'assigned', creatorId: 'creator' });
    const { service } = await buildService(t, { status: 'cancelled' });
    mockActor({ imUserId: 'creator', memberRole: 'member' });

    await expect(service.transitionTask('task_1', 'creator', { to: 'cancelled' })).resolves.toMatchObject({
      status: 'cancelled',
    });
  });

  it('running → review by assignee (submit for verification)', async () => {
    const t = taskRecord({ status: 'running', assigneeId: 'assignee_id' });
    const { service } = await buildService(t, { status: 'review' });
    mockActor({ imUserId: 'assignee_id', role: 'agent' });

    await expect(service.transitionTask('task_1', 'assignee_id', { to: 'review' })).resolves.toMatchObject({
      status: 'review',
    });
  });

  it('running → blocked by assignee (self-report)', async () => {
    const t = taskRecord({ status: 'running', assigneeId: 'assignee_id' });
    const { service } = await buildService(t, { status: 'blocked' });
    mockActor({ imUserId: 'assignee_id', role: 'agent' });

    await expect(
      service.transitionTask('task_1', 'assignee_id', {
        to: 'blocked',
        reason: 'Need OPENAI_API_KEY',
      }),
    ).resolves.toMatchObject({ status: 'blocked' });
  });

  it('running → failed by assignee (self-report failure, reason recorded)', async () => {
    const t = taskRecord({ status: 'running', assigneeId: 'assignee_id' });
    const { service, updateMock } = await buildService(t, { status: 'failed', error: 'crashed' });
    mockActor({ imUserId: 'assignee_id', role: 'agent' });

    await expect(
      service.transitionTask('task_1', 'assignee_id', {
        to: 'failed',
        reason: 'crashed',
      }),
    ).resolves.toMatchObject({ status: 'failed' });
    const data = updateMock.mock.calls[0][1];
    expect(data.error).toBe('crashed');
  });

  it('running → cancelled by creator', async () => {
    const t = taskRecord({ status: 'running', creatorId: 'creator', assigneeId: 'assignee_id' });
    const { service } = await buildService(t, { status: 'cancelled' });
    mockActor({ imUserId: 'creator', memberRole: 'member' });

    await expect(
      service.transitionTask('task_1', 'creator', { to: 'cancelled', reason: 'no longer needed' }),
    ).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('review → completed by creator (record-completion side effect)', async () => {
    const t = taskRecord({ status: 'review', creatorId: 'creator', assigneeId: 'assignee_id' });
    const { service, updateMock } = await buildService(t, { status: 'completed' });
    mockActor({ imUserId: 'creator', memberRole: 'member' });

    await expect(service.transitionTask('task_1', 'creator', { to: 'completed' })).resolves.toMatchObject({
      status: 'completed',
    });
    const data = updateMock.mock.calls[0][1];
    expect(data.completedAt).toBeInstanceOf(Date);
    expect(data.progress).toBe(1);
  });

  it('review → assigned (rejection) by creator with reviewComment', async () => {
    const t = taskRecord({ status: 'review', creatorId: 'creator', assigneeId: 'assignee_id' });
    const { service } = await buildService(t, { status: 'assigned' });
    mockActor({ imUserId: 'creator', memberRole: 'member' });

    await expect(
      service.transitionTask('task_1', 'creator', {
        to: 'assigned',
        reviewComment: 'please tighten the introduction',
      }),
    ).resolves.toMatchObject({ status: 'assigned' });
  });

  it('review → cancelled by creator', async () => {
    const t = taskRecord({ status: 'review', creatorId: 'creator' });
    const { service } = await buildService(t, { status: 'cancelled' });
    mockActor({ imUserId: 'creator', memberRole: 'member' });

    await expect(service.transitionTask('task_1', 'creator', { to: 'cancelled' })).resolves.toMatchObject({
      status: 'cancelled',
    });
  });

  it('blocked → running by assignee (self-unblock once blocker resolved)', async () => {
    const t = taskRecord({ status: 'blocked', assigneeId: 'assignee_id' });
    const { service } = await buildService(t, { status: 'running' });
    mockActor({ imUserId: 'assignee_id', role: 'agent' });

    await expect(service.transitionTask('task_1', 'assignee_id', { to: 'running' })).resolves.toMatchObject({
      status: 'running',
    });
  });

  it('blocked → cancelled by creator', async () => {
    const t = taskRecord({ status: 'blocked', creatorId: 'creator' });
    const { service } = await buildService(t, { status: 'cancelled' });
    mockActor({ imUserId: 'creator', memberRole: 'member' });

    await expect(service.transitionTask('task_1', 'creator', { to: 'cancelled' })).resolves.toMatchObject({
      status: 'cancelled',
    });
  });

  it('failed → assigned (retry) by assignee', async () => {
    const t = taskRecord({ status: 'failed', assigneeId: 'assignee_id' });
    const { service } = await buildService(t, { status: 'assigned' });
    mockActor({ imUserId: 'assignee_id', role: 'agent' });

    await expect(service.transitionTask('task_1', 'assignee_id', { to: 'assigned' })).resolves.toMatchObject({
      status: 'assigned',
    });
  });

  it('failed → cancelled by creator', async () => {
    const t = taskRecord({ status: 'failed', creatorId: 'creator' });
    const { service } = await buildService(t, { status: 'cancelled' });
    mockActor({ imUserId: 'creator', memberRole: 'member' });

    await expect(service.transitionTask('task_1', 'creator', { to: 'cancelled' })).resolves.toMatchObject({
      status: 'cancelled',
    });
  });

  it('cancelled → pending (restore from recycle-bin) by creator', async () => {
    const t = taskRecord({ status: 'cancelled', creatorId: 'creator' });
    const { service, updateMock } = await buildService(t, { status: 'pending' });
    mockActor({ imUserId: 'creator', memberRole: 'member' });

    await expect(service.transitionTask('task_1', 'creator', { to: 'pending' })).resolves.toMatchObject({
      status: 'pending',
    });
    const data = updateMock.mock.calls[0][1];
    // Restore clears terminal fields.
    expect(data.completedAt).toBeNull();
    expect(data.error).toBeNull();
    expect(data.result).toBeNull();
  });
});

// ─── Core contract: no self-approval (review → completed/assigned) ──

describe('transitionTask — CRITICAL CONTRACT: no self-approval', () => {
  beforeEach(resetPrismaMock);

  it('review → completed by assignee → 403 TaskForbiddenError', async () => {
    const t = taskRecord({ status: 'review', assigneeId: 'assignee_id', creatorId: 'creator' });
    const { service } = await buildService(t);
    mockActor({ imUserId: 'assignee_id', role: 'agent' });

    let captured: any;
    try {
      await service.transitionTask('task_1', 'assignee_id', { to: 'completed' });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeDefined();
    expect(captured.name).toBe('TaskForbiddenError');
    expect(captured.requiredTiers).not.toContain('assignee');
    expect(captured.requiredTiers).toEqual(expect.arrayContaining(['owner', 'admin', 'orchestrator', 'creator']));
  });

  it('review → assigned (rejection) by assignee → 403 TaskForbiddenError', async () => {
    const t = taskRecord({ status: 'review', assigneeId: 'assignee_id', creatorId: 'creator' });
    const { service } = await buildService(t);
    mockActor({ imUserId: 'assignee_id', role: 'agent' });

    let captured: any;
    try {
      await service.transitionTask('task_1', 'assignee_id', { to: 'assigned' });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeDefined();
    expect(captured.name).toBe('TaskForbiddenError');
    expect(captured.requiredTiers).not.toContain('assignee');
  });

  it('review → completed by workspace owner → 200', async () => {
    const t = taskRecord({ status: 'review', creatorId: 'someone_else', assigneeId: 'assignee_id' });
    const { service } = await buildService(t, { status: 'completed' });
    mockActor({
      imUserId: 'workspace_owner_id',
      role: 'human',
      workspaceOwnerImUserId: 'workspace_owner_id',
    });

    await expect(service.transitionTask('task_1', 'workspace_owner_id', { to: 'completed' })).resolves.toMatchObject({
      status: 'completed',
    });
  });

  it('review → completed by orchestrator agent → 200', async () => {
    const t = taskRecord({ status: 'review', creatorId: 'someone_else', assigneeId: 'assignee_id' });
    const { service } = await buildService(t, { status: 'completed' });
    // Orchestrator agent — registered on workspace, not revoked.
    mockActor({
      imUserId: 'orch_agent',
      role: 'agent',
      orchestratorAgentId: 'orch_agent',
      orchestratorRevokedAt: null,
    });

    await expect(service.transitionTask('task_1', 'orch_agent', { to: 'completed' })).resolves.toMatchObject({
      status: 'completed',
    });
  });
});

// ─── Invalid transitions (409) ───────────────────────────────────

describe('transitionTask — invalid transitions (409)', () => {
  beforeEach(resetPrismaMock);

  it('pending → completed (skip the matrix) → 409 InvalidTransitionError', async () => {
    const t = taskRecord({ status: 'pending', creatorId: 'creator', assigneeId: null });
    const { service } = await buildService(t);
    mockActor({ imUserId: 'creator', memberRole: 'member' });

    let captured: any;
    try {
      await service.transitionTask('task_1', 'creator', { to: 'completed' });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeDefined();
    expect(captured.name).toBe('InvalidTransitionError');
    expect(captured.from).toBe('pending');
    expect(captured.to).toBe('completed');
    expect(captured.allowedFromHere).toEqual(expect.arrayContaining(['assigned', 'cancelled']));
  });

  it('completed (terminal) → assigned → 409 InvalidTransitionError, empty allowedFromHere', async () => {
    const t = taskRecord({ status: 'completed', creatorId: 'creator' });
    const { service } = await buildService(t);
    mockActor({ imUserId: 'creator', memberRole: 'member' });

    let captured: any;
    try {
      await service.transitionTask('task_1', 'creator', { to: 'assigned' });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeDefined();
    expect(captured.name).toBe('InvalidTransitionError');
    expect(captured.allowedFromHere).toEqual([]);
  });
});

// ─── Structural preconditions ────────────────────────────────────

describe('transitionTask — structural preconditions', () => {
  beforeEach(resetPrismaMock);

  it('pending → assigned without assigneeId → TaskStateError', async () => {
    const { TaskService } = await import('@/im/services/task.service');
    const t = taskRecord({ status: 'pending', assigneeId: null, creatorId: 'creator' });
    const { service } = await buildService(t);
    mockActor({ imUserId: 'creator', memberRole: 'member' });

    await expect(service.transitionTask('task_1', 'creator', { to: 'assigned' })).rejects.toMatchObject({
      name: 'TaskStateError',
    });
    // Guard against the TaskService import being optimized away by the
    // bundler — it's load-bearing for the error class.
    expect(TaskService).toBeDefined();
  });

  it('position is written through to the DB update payload', async () => {
    const t = taskRecord({ status: 'assigned', assigneeId: 'assignee_id' });
    const { service, updateMock } = await buildService(t, { status: 'running' });
    mockActor({ imUserId: 'assignee_id', role: 'agent' });

    await service.transitionTask('task_1', 'assignee_id', {
      to: 'running',
      position: 1234.5,
    });
    const data = updateMock.mock.calls[0][1];
    expect(data.position).toBe(1234.5);
  });

  it('blocked / failed without reason succeeds but logs warning', async () => {
    // Soft-warn behaviour: the spec accepts the call but expects the audit
    // log to capture the missing reason. We assert the call returns 200
    // here; the warning is best-effort and not part of the contract.
    const t = taskRecord({ status: 'running', assigneeId: 'assignee_id' });
    const { service } = await buildService(t, { status: 'blocked' });
    mockActor({ imUserId: 'assignee_id', role: 'agent' });

    await expect(service.transitionTask('task_1', 'assignee_id', { to: 'blocked' })).resolves.toMatchObject({
      status: 'blocked',
    });
  });
});

// ─── Force-transition (admin escape-hatch) ──────────────────────

describe('forceTransitionTask — admin escape-hatch (L0/L1 only)', () => {
  beforeEach(resetPrismaMock);

  it('non-admin (member) → 403 TaskForbiddenError', async () => {
    const t = taskRecord({ status: 'running', creatorId: 'someone_else' });
    const { service } = await buildService(t);
    mockActor({ imUserId: 'random_member', memberRole: 'member' });

    let captured: any;
    try {
      await service.forceTransitionTask('task_1', 'random_member', {
        to: 'cancelled',
        reason: 'cleanup',
      });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeDefined();
    expect(captured.name).toBe('TaskForbiddenError');
    expect(captured.requiredTiers).toEqual(expect.arrayContaining(['owner', 'admin']));
  });

  it('executor agent → 403 TaskForbiddenError', async () => {
    const t = taskRecord({ status: 'running', assigneeId: 'assignee_id' });
    const { service } = await buildService(t);
    mockActor({ imUserId: 'assignee_id', role: 'agent' });

    await expect(
      service.forceTransitionTask('task_1', 'assignee_id', {
        to: 'cancelled',
        reason: 'whatever',
      }),
    ).rejects.toMatchObject({ name: 'TaskForbiddenError' });
  });

  it('workspace owner → 200, bypass TRANSITIONS matrix', async () => {
    // Owner force-jumps running → completed (a transition NOT in TRANSITIONS
    // matrix). This is the precise raison d'être of force-transition.
    const t = taskRecord({ status: 'running', assigneeId: 'assignee_id', creatorId: 'someone_else' });
    const { service, updateMock } = await buildService(t, { status: 'completed' });
    mockActor({
      imUserId: 'workspace_owner_id',
      role: 'human',
      workspaceOwnerImUserId: 'workspace_owner_id',
    });

    const result = await service.forceTransitionTask('task_1', 'workspace_owner_id', {
      to: 'completed',
      reason: 'incident — agent crashed but work is correct',
    });
    expect(result.status).toBe('completed');
    const data = updateMock.mock.calls[0][1];
    expect(data.status).toBe('completed');
    expect(data.completedAt).toBeInstanceOf(Date);
    expect(data.progress).toBe(1);
  });

  it('force → completed forwards metadata.outputAssetIds as resultAssetIds to the digest (B-line)', async () => {
    // A force-complete still produced deliverables; the digest chip must
    // surface them just like the normal record-completion path. Regression
    // for the gap found in e2e verification (force path was unwired).
    const t = taskRecord({
      status: 'running',
      assigneeId: 'assignee_id',
      creatorId: 'someone_else',
      metadata: JSON.stringify({ outputAssetIds: ['asset_a', 'asset_b'] }),
    });
    const { service } = await buildService(t, {
      status: 'completed',
      metadata: JSON.stringify({ outputAssetIds: ['asset_a', 'asset_b'] }),
    });
    mockActor({
      imUserId: 'workspace_owner_id',
      role: 'human',
      workspaceOwnerImUserId: 'workspace_owner_id',
    });

    await service.forceTransitionTask('task_1', 'workspace_owner_id', {
      to: 'completed',
      reason: 'incident — agent crashed but deliverables are valid',
    });

    const emit = (service as any).emitTaskStatusChat as ReturnType<typeof vi.fn>;
    expect(emit).toHaveBeenCalled();
    const [, statusArg, optsArg] = emit.mock.calls[0];
    expect(statusArg).toBe('completed');
    expect(optsArg.resultAssetIds).toEqual(['asset_a', 'asset_b']);
  });

  it('force → cancelled does NOT attach resultAssetIds (only completed surfaces deliverables)', async () => {
    const t = taskRecord({
      status: 'running',
      assigneeId: 'assignee_id',
      creatorId: 'someone_else',
      metadata: JSON.stringify({ outputAssetIds: ['asset_a'] }),
    });
    const { service } = await buildService(t, { status: 'cancelled' });
    mockActor({
      imUserId: 'workspace_owner_id',
      role: 'human',
      workspaceOwnerImUserId: 'workspace_owner_id',
    });

    await service.forceTransitionTask('task_1', 'workspace_owner_id', {
      to: 'cancelled',
      reason: 'no longer needed',
    });

    const emit = (service as any).emitTaskStatusChat as ReturnType<typeof vi.fn>;
    const [, statusArg, optsArg] = emit.mock.calls[0];
    expect(statusArg).toBe('cancelled');
    expect(optsArg.resultAssetIds).toBeUndefined();
  });

  it('admin-trust-tier (trustTier>=4) → 200, bypass matrix even without workspace role', async () => {
    const t = taskRecord({ status: 'review', assigneeId: 'assignee_id' });
    const { service } = await buildService(t, { status: 'cancelled' });
    mockActor({
      imUserId: 'global_admin',
      role: 'human',
      trustTier: 4,
    });

    await expect(
      service.forceTransitionTask('task_1', 'global_admin', {
        to: 'cancelled',
        reason: 'ops escape hatch',
      }),
    ).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('reason is required → TaskStateError when missing', async () => {
    const t = taskRecord({ status: 'running', assigneeId: 'assignee_id' });
    const { service } = await buildService(t);
    mockActor({
      imUserId: 'workspace_owner_id',
      role: 'human',
      workspaceOwnerImUserId: 'workspace_owner_id',
    });

    await expect(
      service.forceTransitionTask('task_1', 'workspace_owner_id', {
        to: 'cancelled',
        reason: '',
      }),
    ).rejects.toMatchObject({ name: 'TaskStateError' });
  });

  it('force-transition into terminal from running cancels in-flight daemon run', async () => {
    const t = taskRecord({ status: 'running', assigneeId: 'assignee_id', runtimeRoute: 'agent' });
    const { service } = await buildService(t, { status: 'cancelled' });
    const cancelStub = vi.fn();
    (service as any).emitDaemonCancel = cancelStub;
    mockActor({
      imUserId: 'workspace_owner_id',
      role: 'human',
      workspaceOwnerImUserId: 'workspace_owner_id',
    });

    await service.forceTransitionTask('task_1', 'workspace_owner_id', {
      to: 'cancelled',
      reason: 'killing the run',
    });
    expect(cancelStub).toHaveBeenCalledWith('assignee_id', 'task_1', 'killing the run');
  });
});

// ─── B-line: resultAssetCount must not over-count deleted assets ──────
//
// emitTaskStatusChat resolves `resultAssetCount` via an independent
// `prisma.iMAsset.count({ deletedAt: null })` so the chat chip count equals
// what the drawer (also `deletedAt: null`) actually shows. These tests drive
// the REAL emitTaskStatusChat (not the stub used elsewhere) against a mocked
// IMAsset count/findMany.
describe('emitTaskStatusChat — resultAssetCount excludes deleted assets (B-line)', () => {
  beforeEach(resetPrismaMock);

  async function buildServiceWithDigestCapture() {
    const { TaskService } = await import('@/im/services/task.service');
    const service = new TaskService({
      eventBusService: { publish: vi.fn().mockResolvedValue(undefined) },
      rooms: { sendToUser: vi.fn() },
    } as any);
    (service as any).fanOutBellSync = vi.fn().mockResolvedValue(undefined);
    const upsertTaskDigest = vi.fn().mockResolvedValue(undefined);
    // Inject a fake digest service so we can capture the payload without a DB.
    (service as any)._taskDigestService = { upsertTaskDigest };
    return { service, upsertTaskDigest };
  }

  const baseTaskArg = {
    id: 'task_1',
    title: 'Task',
    conversationId: 'conv_1',
    assigneeId: 'assignee',
    creatorId: 'creator',
    metadata: '{}',
    workspaceId: 'ws_1',
  };

  it('count reflects live (non-deleted) assets, not the raw id list', async () => {
    const { service, upsertTaskDigest } = await buildServiceWithDigestCapture();
    // 3 ids supplied, but one asset (a3) was deleted → count() returns 2.
    prismaMock.iMAsset.count.mockResolvedValue(2);
    prismaMock.iMAsset.findMany.mockResolvedValue([
      { id: 'a1', filename: 'f1.md', mime: 'text/markdown' },
      { id: 'a2', filename: 'f2.md', mime: 'text/markdown' },
    ]);

    await (service as any).emitTaskStatusChat(baseTaskArg, 'completed', {
      resultAssetIds: ['a1', 'a2', 'a3'],
    });

    expect(prismaMock.iMAsset.count).toHaveBeenCalledWith({
      where: { id: { in: ['a1', 'a2', 'a3'] }, deletedAt: null },
    });
    expect(upsertTaskDigest).toHaveBeenCalled();
    const [, digestPayload] = upsertTaskDigest.mock.calls[0];
    expect(digestPayload.resultAssetCount).toBe(2); // NOT 3 — deleted asset excluded
    expect(digestPayload.resultAssets).toHaveLength(2);
  });

  it('count dedups repeated ids before querying', async () => {
    const { service, upsertTaskDigest } = await buildServiceWithDigestCapture();
    prismaMock.iMAsset.count.mockResolvedValue(1);
    prismaMock.iMAsset.findMany.mockResolvedValue([{ id: 'a1', filename: 'f1.md', mime: 'text/markdown' }]);

    await (service as any).emitTaskStatusChat(baseTaskArg, 'completed', {
      resultAssetIds: ['a1', 'a1'],
    });

    expect(prismaMock.iMAsset.count).toHaveBeenCalledWith({
      where: { id: { in: ['a1'] }, deletedAt: null },
    });
    const [, digestPayload] = upsertTaskDigest.mock.calls[0];
    expect(digestPayload.resultAssetCount).toBe(1);
  });

  it('degrades to raw id count if the count query throws (best-effort)', async () => {
    const { service, upsertTaskDigest } = await buildServiceWithDigestCapture();
    prismaMock.iMAsset.count.mockRejectedValue(new Error('db down'));
    prismaMock.iMAsset.findMany.mockResolvedValue([{ id: 'a1', filename: 'f1.md', mime: 'text/markdown' }]);

    await (service as any).emitTaskStatusChat(baseTaskArg, 'completed', {
      resultAssetIds: ['a1', 'a2'],
    });

    const [, digestPayload] = upsertTaskDigest.mock.calls[0];
    expect(digestPayload.resultAssetCount).toBe(2); // fell back to deduped id length
  });
});
