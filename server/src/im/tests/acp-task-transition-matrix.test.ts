/**
 * Task transition matrix — release 200 P7 全覆盖回归 (§5.2 + §11).
 *
 * Complements `acp-task-transition.test.ts` (P3 acceptance — 32 happy/契约
 * cases). This file is the **exhaustive matrix verifier**:
 *
 *   - 17 valid `TRANSITIONS[from][to]` rules — each is checked against 4 actor
 *     tiers (allowed-actor / forbidden-actor / non-member observer / external).
 *   - Critical contract slice (§3.2 / §5.2 — "no self-approval"):
 *       review → completed by assignee → 403
 *       review → assigned (rejection) by assignee → 403
 *       running → review by non-assignee non-creator member → 403
 *       pending → assigned by external → 403
 *       * → cancelled by L4 executor agent → 403 (only creator/orch/admin/owner)
 *       cancelled → pending (restore) by assignee → 403
 *   - Invalid-transition slice — non-rule pairs across the 8 statuses → 409
 *     with `allowedFromHere` carrying the correct exit set.
 *   - Force-transition is intentionally OUT-OF-SCOPE here (see the dedicated
 *     `forceTransitionTask — admin escape-hatch` block in acp-task-transition).
 *
 * Total target: ≥ 80 cases (achieved via describe.each / it.each pattern over
 * the 17 transitions × 4 tiers + slices).
 *
 * Source of truth: `src/im/services/task-permission.ts::TRANSITIONS`. If that
 * constant changes, update `MATRIX` below in lockstep — drift will cascade
 * into pages of red.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Prisma mock (mirror of acp-task-transition.test.ts) ──────────────────
const prismaMock = {
  iMUser: { findUnique: vi.fn(), findFirst: vi.fn() },
  iMTask: { findUnique: vi.fn() },
  iMTaskRun: { findUnique: vi.fn() },
  iMAgentProfile: { findFirst: vi.fn() },
  iMConversation: { findUnique: vi.fn() },
  iMWorkspace: { findUnique: vi.fn(), findFirst: vi.fn() },
  iMWorkspaceMember: { findFirst: vi.fn() },
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

// ─── Types + fixtures ─────────────────────────────────────────────────────

type Status =
  | 'pending'
  | 'assigned'
  | 'running'
  | 'review'
  | 'blocked'
  | 'awaiting_approval'
  | 'failed'
  | 'completed'
  | 'cancelled';

/** Actor tiers we exercise. `external` = no workspace membership at all. */
type Tier = 'owner' | 'admin' | 'orchestrator' | 'creator' | 'assignee' | 'member' | 'external';

const CREATOR_ID = 'creator';
const ASSIGNEE_ID = 'assignee_id';
const WORKSPACE_OWNER_ID = 'workspace_owner_id';
const WORKSPACE_ADMIN_ID = 'workspace_admin_id';
const ORCH_AGENT_ID = 'orch_agent';
const OTHER_MEMBER_ID = 'other_member';
const EXTERNAL_ID = 'external_actor';

function taskRecord(overrides: Record<string, unknown> = {}) {
  const now = new Date('2026-05-19T00:00:00.000Z');
  return {
    id: 'task_1',
    title: 'Task',
    description: null,
    capability: null,
    input: '{}',
    contextUri: null,
    creatorId: CREATOR_ID,
    assigneeId: ASSIGNEE_ID,
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

async function buildService(
  baseTask: ReturnType<typeof taskRecord>,
  afterUpdate?: Partial<ReturnType<typeof taskRecord>>,
) {
  const { TaskService } = await import('@/im/services/task.service');
  const service = new TaskService({
    eventBusService: { publish: vi.fn().mockResolvedValue(undefined) },
    rooms: { sendToUser: vi.fn() },
  } as any);
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

/**
 * Stand-up the user/workspace mock for a single canonical actor (the
 * one calling transitionTask). Default settings yield "this actor is a
 * plain workspace member, with no orchestrator role".
 */
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
  prismaMock.iMWorkspaceMember.findFirst.mockResolvedValue(opts.memberRole ? { role: opts.memberRole } : null);
  prismaMock.iMAgentProfile.findFirst.mockResolvedValue(null);
  // S20 (doc 10 rev 2) — running → review goes through
  // validateAcceptanceEvidenceForReview which calls
  // task-acceptance.service::getAcceptance → prisma.iMTask.findUnique. Default
  // to "no acceptance criteria" (opt-out path) so matrix tests focus on
  // permission/state-machine semantics.
  prismaMock.iMTask.findUnique.mockResolvedValue({
    acceptanceCriteriaJson: null,
    acceptanceStatus: null,
  });
}

/**
 * Configure the prisma mock so that calling transitionTask as `tier`
 * resolves to the appropriate trust profile. Returns the canonical
 * actorId the test should pass to `transitionTask(taskId, actorId, ...)`.
 */
function mockTier(tier: Tier): string {
  switch (tier) {
    case 'owner':
      mockActor({
        imUserId: WORKSPACE_OWNER_ID,
        role: 'human',
        workspaceOwnerImUserId: WORKSPACE_OWNER_ID,
      });
      return WORKSPACE_OWNER_ID;
    case 'admin':
      mockActor({
        imUserId: WORKSPACE_ADMIN_ID,
        role: 'human',
        memberRole: 'admin',
      });
      return WORKSPACE_ADMIN_ID;
    case 'orchestrator':
      mockActor({
        imUserId: ORCH_AGENT_ID,
        role: 'agent',
        orchestratorAgentId: ORCH_AGENT_ID,
        orchestratorRevokedAt: null,
      });
      return ORCH_AGENT_ID;
    case 'creator':
      mockActor({ imUserId: CREATOR_ID, role: 'human', memberRole: 'member' });
      return CREATOR_ID;
    case 'assignee':
      // assignee is the agent that holds the task.assigneeId.
      mockActor({ imUserId: ASSIGNEE_ID, role: 'agent' });
      return ASSIGNEE_ID;
    case 'member':
      // workspace member, but NOT creator and NOT assignee.
      mockActor({ imUserId: OTHER_MEMBER_ID, role: 'human', memberRole: 'member' });
      return OTHER_MEMBER_ID;
    case 'external':
      // not in workspace at all — null memberRole, null ownerImUserId.
      mockActor({ imUserId: EXTERNAL_ID, role: 'human', memberRole: null });
      return EXTERNAL_ID;
  }
}

// ─── Transition matrix (mirrors TRANSITIONS in task-permission.ts) ────────

interface TransitionSpec {
  from: Status;
  to: Status;
  /** Tiers that the matrix says are allowed for this rule. */
  allowed: ReadonlyArray<'owner' | 'admin' | 'orchestrator' | 'creator' | 'assignee' | 'system'>;
}

/**
 * The 17 valid transitions per §5.2. Kept in declaration order matching
 * the spec doc so reviewers can diff visually.
 */
const MATRIX: ReadonlyArray<TransitionSpec> = [
  // pending → *
  { from: 'pending', to: 'assigned', allowed: ['owner', 'admin', 'orchestrator', 'creator'] },
  { from: 'pending', to: 'cancelled', allowed: ['owner', 'admin', 'orchestrator', 'creator'] },
  // assigned → *
  { from: 'assigned', to: 'pending', allowed: ['owner', 'admin', 'orchestrator', 'creator', 'assignee'] },
  { from: 'assigned', to: 'running', allowed: ['owner', 'admin', 'orchestrator', 'assignee'] },
  { from: 'assigned', to: 'cancelled', allowed: ['owner', 'admin', 'orchestrator', 'creator'] },
  // running → *
  { from: 'running', to: 'review', allowed: ['owner', 'admin', 'orchestrator', 'assignee'] },
  { from: 'running', to: 'blocked', allowed: ['owner', 'admin', 'orchestrator', 'assignee'] },
  { from: 'running', to: 'failed', allowed: ['owner', 'admin', 'orchestrator', 'assignee', 'system'] },
  { from: 'running', to: 'cancelled', allowed: ['owner', 'admin', 'orchestrator', 'creator'] },
  // review → * (⚠️ no 'assignee' — the no-self-approval contract)
  { from: 'review', to: 'completed', allowed: ['owner', 'admin', 'orchestrator', 'creator'] },
  { from: 'review', to: 'assigned', allowed: ['owner', 'admin', 'orchestrator', 'creator'] },
  { from: 'review', to: 'cancelled', allowed: ['owner', 'admin', 'orchestrator', 'creator'] },
  // blocked → *
  { from: 'blocked', to: 'running', allowed: ['owner', 'admin', 'orchestrator', 'creator', 'assignee'] },
  { from: 'blocked', to: 'cancelled', allowed: ['owner', 'admin', 'orchestrator', 'creator'] },
  // failed → *
  { from: 'failed', to: 'assigned', allowed: ['owner', 'admin', 'orchestrator', 'creator', 'assignee'] },
  { from: 'failed', to: 'cancelled', allowed: ['owner', 'admin', 'orchestrator', 'creator'] },
  // cancelled → pending (restore)
  { from: 'cancelled', to: 'pending', allowed: ['owner', 'admin', 'orchestrator', 'creator'] },
];

/**
 * Tiers we systematically test against each transition. For brevity (and to
 * keep the test wall-clock cheap) we sample 4 tiers per transition:
 *   - 1 allowed (any allowed tier — picks the most informative one)
 *   - 1 forbidden among {creator, assignee} (whichever is NOT in `allowed`)
 *   - 1 non-creator non-assignee member ('member') — should always 403
 *   - 1 external                                   — should always 403
 *
 * The "allowed" sample is the lowest-trust tier that's allowed (after
 * owner/admin/orch) — usually `creator` or `assignee` — because that's
 * the most interesting check (it exercises the resolver's per-actor logic
 * rather than the L0/L1 short-circuit).
 */
function pickAllowedSample(spec: TransitionSpec): Tier {
  // Prefer creator > assignee > orchestrator > owner > admin so that the
  // happy-path test exercises the §3.2 contract (not just admin override).
  if (spec.allowed.includes('creator')) return 'creator';
  if (spec.allowed.includes('assignee')) return 'assignee';
  if (spec.allowed.includes('orchestrator')) return 'orchestrator';
  if (spec.allowed.includes('admin')) return 'admin';
  return 'owner';
}

function pickForbiddenContractTier(spec: TransitionSpec): Tier | null {
  // The most contractually significant denial is when the COUNTERPARTY
  // (creator if assignee is allowed; assignee if creator is allowed)
  // is missing from the allowed list.
  const hasCreator = spec.allowed.includes('creator');
  const hasAssignee = spec.allowed.includes('assignee');
  if (hasCreator && !hasAssignee) return 'assignee';
  if (hasAssignee && !hasCreator) return 'creator';
  // Both or neither — no clean counterparty contract to verify here;
  // the 'member' / 'external' cases below still cover the deny path.
  return null;
}

// ─── 1. Valid transitions: allowed-tier acceptance + forbidden-tier deny ──

describe('TRANSITION MATRIX — exhaustive coverage (17 rules × ≥4 tiers)', () => {
  beforeEach(resetPrismaMock);

  for (const spec of MATRIX) {
    describe(`${spec.from} → ${spec.to}`, () => {
      const allowedTier = pickAllowedSample(spec);
      const forbiddenCounterparty = pickForbiddenContractTier(spec);

      it(`allowed: ${allowedTier} → 200`, async () => {
        const taskOverrides: Record<string, unknown> = { status: spec.from };
        if (spec.from === 'pending') taskOverrides.assigneeId = null;
        const t = taskRecord(taskOverrides);
        const { service, updateMock } = await buildService(t, { status: spec.to });
        const actorId = mockTier(allowedTier);

        const input: Record<string, unknown> = { to: spec.to };
        // Structural precondition — pending → assigned must carry assigneeId.
        if (spec.from === 'pending' && spec.to === 'assigned') {
          input.assigneeId = ASSIGNEE_ID;
        }

        const result = await service.transitionTask('task_1', actorId, input as any);
        expect(result.status).toBe(spec.to);
        expect(updateMock).toHaveBeenCalled();
        expect(updateMock.mock.calls[0][1].status).toBe(spec.to);
      });

      if (forbiddenCounterparty) {
        it(`forbidden counterparty: ${forbiddenCounterparty} → 403 with requiredTiers`, async () => {
          const taskOverrides: Record<string, unknown> = { status: spec.from };
          if (spec.from === 'pending') taskOverrides.assigneeId = null;
          const t = taskRecord(taskOverrides);
          const { service } = await buildService(t);
          const actorId = mockTier(forbiddenCounterparty);

          let captured: any;
          try {
            await service.transitionTask('task_1', actorId, {
              to: spec.to,
              ...(spec.from === 'pending' && spec.to === 'assigned' ? { assigneeId: ASSIGNEE_ID } : {}),
            });
          } catch (err) {
            captured = err;
          }
          expect(captured, `${spec.from}→${spec.to} by ${forbiddenCounterparty} should throw`).toBeDefined();
          expect(captured.name).toBe('TaskForbiddenError');
          // The denied counterparty must not appear in the per-rule requiredTiers.
          //
          // Exception: when from='pending' the task has assigneeId=null, so a
          // mocked 'assignee' actor is not actually any task's assignee — the
          // resolver short-circuits at the L4 executor branch and returns
          // ['assignee','orchestrator','admin'] (the generic "you'd need to BE
          // the assignee" message). That's a stricter deny than the per-rule
          // matrix would have produced, so we only assert the matrix
          // counterparty exclusion when the relationship is meaningful.
          const isPendingAssigneeFallback = spec.from === 'pending' && forbiddenCounterparty === 'assignee';
          if (!isPendingAssigneeFallback) {
            expect(captured.requiredTiers).not.toContain(forbiddenCounterparty);
          }
          // At least one structural higher tier is always required.
          expect(captured.requiredTiers.length).toBeGreaterThan(0);
        });
      }

      it(`non-creator non-assignee member → 403`, async () => {
        const taskOverrides: Record<string, unknown> = { status: spec.from };
        if (spec.from === 'pending') taskOverrides.assigneeId = null;
        const t = taskRecord(taskOverrides);
        const { service } = await buildService(t);
        const actorId = mockTier('member');

        let captured: any;
        try {
          await service.transitionTask('task_1', actorId, {
            to: spec.to,
            ...(spec.from === 'pending' && spec.to === 'assigned' ? { assigneeId: ASSIGNEE_ID } : {}),
          });
        } catch (err) {
          captured = err;
        }
        expect(captured, `${spec.from}→${spec.to} by 'member' should throw`).toBeDefined();
        expect(captured.name).toBe('TaskForbiddenError');
      });

      it(`external (non-member) → 403`, async () => {
        const taskOverrides: Record<string, unknown> = { status: spec.from };
        if (spec.from === 'pending') taskOverrides.assigneeId = null;
        const t = taskRecord(taskOverrides);
        const { service } = await buildService(t);
        const actorId = mockTier('external');

        let captured: any;
        try {
          await service.transitionTask('task_1', actorId, {
            to: spec.to,
            ...(spec.from === 'pending' && spec.to === 'assigned' ? { assigneeId: ASSIGNEE_ID } : {}),
          });
        } catch (err) {
          captured = err;
        }
        expect(captured, `${spec.from}→${spec.to} by external should throw`).toBeDefined();
        expect(captured.name).toBe('TaskForbiddenError');
        expect(captured.actorTier).toBe('observer');
      });
    });
  }
});

// ─── 2. Override: owner / admin / orchestrator always pass ────────────────
// (Two transitions chosen as a smoke test — the matrix should never deny
//  these tiers for ANY valid rule.)

describe('Override tiers — owner / admin / orchestrator pass every rule', () => {
  beforeEach(resetPrismaMock);

  for (const overrideTier of ['owner', 'admin', 'orchestrator'] as const) {
    for (const spec of [
      // Pick 3 representative rules: one creator-restricted (no assignee), one
      // assignee-restricted, one balanced.
      { from: 'review' as Status, to: 'completed' as Status }, // creator-only
      { from: 'running' as Status, to: 'review' as Status }, // assignee-only
      { from: 'blocked' as Status, to: 'running' as Status }, // both
    ]) {
      it(`${overrideTier} can ${spec.from} → ${spec.to}`, async () => {
        const t = taskRecord({
          status: spec.from,
          creatorId: 'someone_else',
          assigneeId: ASSIGNEE_ID,
        });
        const { service } = await buildService(t, { status: spec.to });
        const actorId = mockTier(overrideTier);

        await expect(service.transitionTask('task_1', actorId, { to: spec.to })).resolves.toMatchObject({
          status: spec.to,
        });
      });
    }
  }
});

// ─── 3. Critical contracts (§3.2 / §5.2) — restated explicitly ────────────

describe('CRITICAL CONTRACTS — assignee cannot self-approve / self-cancel', () => {
  beforeEach(resetPrismaMock);

  it('review → completed by assignee → 403 (no self-approval)', async () => {
    const t = taskRecord({ status: 'review' });
    const { service } = await buildService(t);
    const actorId = mockTier('assignee');

    let captured: any;
    try {
      await service.transitionTask('task_1', actorId, { to: 'completed' });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeDefined();
    expect(captured.name).toBe('TaskForbiddenError');
    expect(captured.actorTier).toBe('executor');
    expect(captured.requiredTiers).not.toContain('assignee');
    expect(captured.requiredTiers).toEqual(expect.arrayContaining(['owner', 'admin', 'orchestrator', 'creator']));
  });

  it('review → assigned (rejection) by assignee → 403', async () => {
    const t = taskRecord({ status: 'review' });
    const { service } = await buildService(t);
    const actorId = mockTier('assignee');

    await expect(service.transitionTask('task_1', actorId, { to: 'assigned' })).rejects.toMatchObject({
      name: 'TaskForbiddenError',
    });
  });

  it('running → review by non-assignee non-creator member → 403', async () => {
    const t = taskRecord({ status: 'running' });
    const { service } = await buildService(t);
    const actorId = mockTier('member');

    let captured: any;
    try {
      await service.transitionTask('task_1', actorId, { to: 'review' });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeDefined();
    expect(captured.name).toBe('TaskForbiddenError');
  });

  it('pending → assigned by external → 403 (actorTier=observer)', async () => {
    const t = taskRecord({ status: 'pending', assigneeId: null });
    const { service } = await buildService(t);
    const actorId = mockTier('external');

    let captured: any;
    try {
      await service.transitionTask('task_1', actorId, {
        to: 'assigned',
        assigneeId: ASSIGNEE_ID,
      });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeDefined();
    expect(captured.name).toBe('TaskForbiddenError');
    expect(captured.actorTier).toBe('observer');
  });

  it('running → cancelled by L4 executor (assignee) → 403 — only creator+ can cancel', async () => {
    const t = taskRecord({ status: 'running' });
    const { service } = await buildService(t);
    const actorId = mockTier('assignee');

    let captured: any;
    try {
      await service.transitionTask('task_1', actorId, { to: 'cancelled' });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeDefined();
    expect(captured.name).toBe('TaskForbiddenError');
    expect(captured.actorTier).toBe('executor');
    // assignee absent from cancel-allowed list (matrix §5.2 running→cancelled).
    expect(captured.requiredTiers).not.toContain('assignee');
  });

  it('pending → cancelled by L4 executor agent → 403', async () => {
    const t = taskRecord({ status: 'pending', assigneeId: null });
    const { service } = await buildService(t);
    // Mock an agent who happens to be the (would-be) assignee but isn't.
    mockActor({ imUserId: 'rogue_agent', role: 'agent' });

    await expect(service.transitionTask('task_1', 'rogue_agent', { to: 'cancelled' })).rejects.toMatchObject({
      name: 'TaskForbiddenError',
    });
  });

  it('cancelled → pending (restore) by assignee → 403 — only creator+ can restore', async () => {
    const t = taskRecord({ status: 'cancelled' });
    const { service } = await buildService(t);
    const actorId = mockTier('assignee');

    let captured: any;
    try {
      await service.transitionTask('task_1', actorId, { to: 'pending' });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeDefined();
    expect(captured.name).toBe('TaskForbiddenError');
    expect(captured.requiredTiers).not.toContain('assignee');
  });

  it('completed (terminal) → anything by owner → 409 invalid-transition (not 403)', async () => {
    // Owner has all permissions, but the matrix is terminal at `completed`.
    // The route must surface 409 invalid-transition, not 200 or 403.
    const t = taskRecord({ status: 'completed' });
    const { service } = await buildService(t);
    const actorId = mockTier('owner');

    let captured: any;
    try {
      await service.transitionTask('task_1', actorId, { to: 'assigned' });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeDefined();
    expect(captured.name).toBe('InvalidTransitionError');
    expect(captured.allowedFromHere).toEqual([]);
  });
});

// ─── 4. Invalid transitions — exhaustive across statuses ──────────────────

describe('INVALID TRANSITIONS — 409 invalid-transition with allowedFromHere', () => {
  beforeEach(resetPrismaMock);

  // Sample invalid pairs across all 8 statuses. Each represents a "kanban
  // skip" (e.g. drag from BACKLOG straight to DONE) that the matrix must
  // refuse with a precise `allowedFromHere` set.
  const INVALID_PAIRS: ReadonlyArray<{ from: Status; to: Status; allowedFromHere: Status[] }> = [
    { from: 'pending', to: 'completed', allowedFromHere: ['assigned', 'cancelled'] },
    { from: 'pending', to: 'review', allowedFromHere: ['assigned', 'cancelled'] },
    { from: 'pending', to: 'running', allowedFromHere: ['assigned', 'cancelled'] },
    { from: 'assigned', to: 'completed', allowedFromHere: ['pending', 'running', 'cancelled'] },
    { from: 'assigned', to: 'review', allowedFromHere: ['pending', 'running', 'cancelled'] },
    {
      from: 'running',
      to: 'assigned',
      allowedFromHere: ['review', 'blocked', 'awaiting_approval', 'failed', 'cancelled'],
    },
    {
      from: 'running',
      to: 'completed',
      allowedFromHere: ['review', 'blocked', 'awaiting_approval', 'failed', 'cancelled'],
    },
    {
      from: 'running',
      to: 'pending',
      allowedFromHere: ['review', 'blocked', 'awaiting_approval', 'failed', 'cancelled'],
    },
    { from: 'review', to: 'running', allowedFromHere: ['completed', 'assigned', 'cancelled'] },
    { from: 'review', to: 'blocked', allowedFromHere: ['completed', 'assigned', 'cancelled'] },
    { from: 'review', to: 'failed', allowedFromHere: ['completed', 'assigned', 'cancelled'] },
    { from: 'blocked', to: 'completed', allowedFromHere: ['running', 'cancelled'] },
    { from: 'blocked', to: 'review', allowedFromHere: ['running', 'cancelled'] },
    { from: 'failed', to: 'completed', allowedFromHere: ['assigned', 'cancelled'] },
    { from: 'failed', to: 'running', allowedFromHere: ['assigned', 'cancelled'] },
    { from: 'cancelled', to: 'assigned', allowedFromHere: ['pending'] },
    { from: 'cancelled', to: 'completed', allowedFromHere: ['pending'] },
    { from: 'completed', to: 'pending', allowedFromHere: [] },
    { from: 'completed', to: 'cancelled', allowedFromHere: [] },
  ];

  for (const { from, to, allowedFromHere } of INVALID_PAIRS) {
    it(`${from} → ${to} (by creator) → 409 with allowedFromHere ${JSON.stringify(allowedFromHere)}`, async () => {
      const taskOverrides: Record<string, unknown> = { status: from };
      if (from === 'pending') taskOverrides.assigneeId = null;
      const t = taskRecord(taskOverrides);
      const { service } = await buildService(t);
      const actorId = mockTier('creator');

      let captured: any;
      try {
        await service.transitionTask('task_1', actorId, { to });
      } catch (err) {
        captured = err;
      }
      expect(captured).toBeDefined();
      expect(captured.name).toBe('InvalidTransitionError');
      expect(captured.from).toBe(from);
      expect(captured.to).toBe(to);
      // The `allowedFromHere` should be exactly the set of valid `to` keys
      // from `TRANSITIONS[from]` — order-independent.
      expect(new Set(captured.allowedFromHere)).toEqual(new Set(allowedFromHere));
    });
  }
});

// ─── 5. Sanity — admin-trust-tier escape works even without workspace ─────

describe('admin-trust-tier short-circuit (trustTier >= 4)', () => {
  beforeEach(resetPrismaMock);

  it('global admin (trustTier=4, no workspace role) → 200 on review → completed', async () => {
    const t = taskRecord({ status: 'review' });
    const { service } = await buildService(t, { status: 'completed' });
    mockActor({
      imUserId: 'global_admin',
      role: 'human',
      trustTier: 4,
      memberRole: null,
    });

    await expect(service.transitionTask('task_1', 'global_admin', { to: 'completed' })).resolves.toMatchObject({
      status: 'completed',
    });
  });
});
