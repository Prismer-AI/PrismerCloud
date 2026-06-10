/**
 * Task Permission Resolver — release 200 P2 acceptance tests.
 *
 * Covers the 6-tier trust hierarchy (15-task-state-machine-and-kanban.md §3.1)
 * × the v2.0 transition matrix critical contracts (§5.2).
 *
 * Full 8×7×6 matrix coverage lives in P7 regression (out of scope here).
 * This file pins the contracts the resolver MUST honor:
 *
 *   - L0 owner / L1 admin / L2 orchestrator all-allow
 *   - L3 member creator on own task vs L3 member on others' task
 *   - L4 executor agent: assigned→running OK, review→completed DENY,
 *     running→blocked OK, blocked→running OK (self-unblock)
 *   - L5 observer all-deny
 *   - Critical contract: review → completed/assigned excludes assignee
 *   - Force-transition restricted to L0/L1
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = {
  iMUser: { findUnique: vi.fn(), findFirst: vi.fn() },
  iMTask: { findUnique: vi.fn() },
  iMAgentProfile: { findFirst: vi.fn() },
  iMWorkspace: { findFirst: vi.fn() },
  iMWorkspaceMember: { findFirst: vi.fn() },
};

vi.mock('@/lib/prisma', () => ({ default: prismaMock }));

function resetPrismaMock() {
  for (const model of Object.values(prismaMock)) {
    for (const fn of Object.values(model)) {
      (fn as { mockReset: () => void }).mockReset();
    }
  }
}

import type { TaskActor, TaskRef, TaskActionKind } from '../services/task-permission';

const baseTask: TaskRef = {
  id: 'task_1',
  creatorId: 'creator_id',
  assigneeId: 'assignee_id',
  workspaceId: 'ws_1',
  status: 'review',
};

function actor(overrides: Partial<TaskActor> = {}): TaskActor {
  return {
    id: 'actor_id',
    type: 'human',
    role: 'member',
    trustTier: 0,
    ...overrides,
  };
}

function task(overrides: Partial<TaskRef> = {}): TaskRef {
  return { ...baseTask, ...overrides };
}

describe('Task permission resolver — tier hierarchy', () => {
  beforeEach(resetPrismaMock);

  it('L0 owner (human, workspace ownerImUserId) — allows all actions', async () => {
    const { resolveTaskMutationPermission } = await import('../services/task-permission');
    const a = actor({ id: 'owner_id', type: 'human', role: 'owner' });
    const t = task();

    const actions: TaskActionKind[] = [
      { kind: 'edit-content' },
      { kind: 'assign' },
      { kind: 'reorder' },
      { kind: 'transition', from: 'review', to: 'completed' },
      { kind: 'transition', from: 'pending', to: 'cancelled' },
    ];
    for (const action of actions) {
      const decision = await resolveTaskMutationPermission(a, t, action);
      expect(decision.allow).toBe(true);
      if (decision.allow) expect(decision.via).toBe('owner');
    }
  });

  it('L1 admin (human, workspace role=admin) — allows all actions', async () => {
    const { resolveTaskMutationPermission } = await import('../services/task-permission');
    const a = actor({ id: 'admin_id', type: 'human', role: 'admin' });
    const decision = await resolveTaskMutationPermission(a, task(), {
      kind: 'transition',
      from: 'review',
      to: 'completed',
    });
    expect(decision.allow).toBe(true);
    if (decision.allow) expect(decision.via).toBe('admin');
  });

  it('admin-trust-tier (trustTier>=4) — allows even when workspace role is null', async () => {
    const { resolveTaskMutationPermission } = await import('../services/task-permission');
    const a = actor({ id: 'global_admin', type: 'agent', role: null, trustTier: 4 });
    const decision = await resolveTaskMutationPermission(a, task(), {
      kind: 'edit-content',
    });
    expect(decision.allow).toBe(true);
    if (decision.allow) expect(decision.via).toBe('admin-trust-tier');
  });

  it('L2 orchestrator (workspace.orchestratorAgentId match, not revoked) — allows all', async () => {
    const { resolveTaskMutationPermission } = await import('../services/task-permission');
    prismaMock.iMWorkspace.findFirst.mockResolvedValue({
      orchestratorAgentId: 'orch_agent',
      orchestratorRevokedAt: null,
      ownerImUserId: 'someone_else',
    });

    const a = actor({ id: 'orch_agent', type: 'agent', role: null });
    const actions: TaskActionKind[] = [
      { kind: 'edit-content' },
      { kind: 'assign' },
      { kind: 'transition', from: 'review', to: 'completed' },
      { kind: 'transition', from: 'pending', to: 'assigned' },
    ];
    for (const action of actions) {
      const decision = await resolveTaskMutationPermission(a, task(), action);
      expect(decision.allow).toBe(true);
      if (decision.allow) expect(decision.via).toBe('orchestrator');
    }
  });

  it('L2 orchestrator is denied after revocation (orchestratorRevokedAt set)', async () => {
    const { resolveTaskMutationPermission } = await import('../services/task-permission');
    prismaMock.iMWorkspace.findFirst.mockResolvedValue({
      orchestratorAgentId: 'orch_agent',
      orchestratorRevokedAt: new Date('2026-05-19'),
      ownerImUserId: 'someone_else',
    });
    prismaMock.iMAgentProfile.findFirst.mockResolvedValue(null); // no legacy fallback

    const a = actor({ id: 'orch_agent', type: 'agent', role: null });
    const decision = await resolveTaskMutationPermission(a, task(), { kind: 'edit-content' });
    expect(decision.allow).toBe(false);
  });

  it('L3 member creator — can edit/assign/transition own task', async () => {
    const { resolveTaskMutationPermission } = await import('../services/task-permission');
    const a = actor({ id: 'creator_id', type: 'human', role: 'member' });
    const t = task({ creatorId: 'creator_id', status: 'pending' });

    const edit = await resolveTaskMutationPermission(a, t, { kind: 'edit-content' });
    expect(edit.allow).toBe(true);

    const assign = await resolveTaskMutationPermission(a, t, { kind: 'assign' });
    expect(assign.allow).toBe(true);

    const transition = await resolveTaskMutationPermission(a, t, {
      kind: 'transition',
      from: 'pending',
      to: 'assigned',
    });
    expect(transition.allow).toBe(true);
  });

  it('L3 member on others task — edit/assign denied, reorder allowed', async () => {
    const { resolveTaskMutationPermission } = await import('../services/task-permission');
    const a = actor({ id: 'random_member', type: 'human', role: 'member' });

    const edit = await resolveTaskMutationPermission(a, task(), { kind: 'edit-content' });
    expect(edit.allow).toBe(false);
    if (!edit.allow) expect(edit.requiredTiers).toContain('creator');

    const assign = await resolveTaskMutationPermission(a, task(), { kind: 'assign' });
    expect(assign.allow).toBe(false);

    // Reorder is allowed for any workspace member.
    const reorder = await resolveTaskMutationPermission(a, task(), { kind: 'reorder' });
    expect(reorder.allow).toBe(true);
  });

  it('L5 observer (no workspace role) — all actions denied', async () => {
    const { resolveTaskMutationPermission } = await import('../services/task-permission');
    prismaMock.iMWorkspace.findFirst.mockResolvedValue(null); // not an orchestrator
    prismaMock.iMAgentProfile.findFirst.mockResolvedValue(null);

    const a = actor({ id: 'external', type: 'human', role: null });
    const actions: TaskActionKind[] = [
      { kind: 'edit-content' },
      { kind: 'assign' },
      { kind: 'reorder' },
      { kind: 'transition', from: 'pending', to: 'assigned' },
    ];
    for (const action of actions) {
      const decision = await resolveTaskMutationPermission(a, task(), action);
      expect(decision.allow).toBe(false);
    }
  });
});

describe('Task permission resolver — L4 executor agent', () => {
  beforeEach(resetPrismaMock);

  it('executor on assigned task: assigned → running allowed', async () => {
    const { resolveTaskMutationPermission } = await import('../services/task-permission');
    const a = actor({ id: 'assignee_id', type: 'agent', role: null });
    const t = task({ assigneeId: 'assignee_id', status: 'assigned' });
    const decision = await resolveTaskMutationPermission(a, t, {
      kind: 'transition',
      from: 'assigned',
      to: 'running',
    });
    expect(decision.allow).toBe(true);
    if (decision.allow) expect(decision.via).toBe('assignee');
  });

  it('executor on assigned task: running → review allowed (submit)', async () => {
    const { resolveTaskMutationPermission } = await import('../services/task-permission');
    const a = actor({ id: 'assignee_id', type: 'agent', role: null });
    const t = task({ assigneeId: 'assignee_id', status: 'running' });
    const decision = await resolveTaskMutationPermission(a, t, {
      kind: 'transition',
      from: 'running',
      to: 'review',
    });
    expect(decision.allow).toBe(true);
  });

  it('CRITICAL CONTRACT: executor cannot self-approve (review → completed DENIED)', async () => {
    const { resolveTaskMutationPermission } = await import('../services/task-permission');
    const a = actor({ id: 'assignee_id', type: 'agent', role: null });
    const t = task({ assigneeId: 'assignee_id', status: 'review' });
    const decision = await resolveTaskMutationPermission(a, t, {
      kind: 'transition',
      from: 'review',
      to: 'completed',
    });
    expect(decision.allow).toBe(false);
    if (!decision.allow) {
      expect(decision.requiredTiers).not.toContain('assignee');
      expect(decision.requiredTiers).toContain('creator');
    }
  });

  it('CRITICAL CONTRACT: executor cannot self-reject (review → assigned DENIED)', async () => {
    const { resolveTaskMutationPermission } = await import('../services/task-permission');
    const a = actor({ id: 'assignee_id', type: 'agent', role: null });
    const t = task({ assigneeId: 'assignee_id', status: 'review' });
    const decision = await resolveTaskMutationPermission(a, t, {
      kind: 'transition',
      from: 'review',
      to: 'assigned',
    });
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.requiredTiers).not.toContain('assignee');
  });

  it('executor: running → blocked allowed (self-report)', async () => {
    const { resolveTaskMutationPermission } = await import('../services/task-permission');
    const a = actor({ id: 'assignee_id', type: 'agent', role: null });
    const t = task({ assigneeId: 'assignee_id', status: 'running' });
    const decision = await resolveTaskMutationPermission(a, t, {
      kind: 'transition',
      from: 'running',
      to: 'blocked',
    });
    expect(decision.allow).toBe(true);
  });

  it('executor: blocked → running allowed (self-unblock — agent resolves blocker)', async () => {
    const { resolveTaskMutationPermission } = await import('../services/task-permission');
    const a = actor({ id: 'assignee_id', type: 'agent', role: null });
    const t = task({ assigneeId: 'assignee_id', status: 'blocked' });
    const decision = await resolveTaskMutationPermission(a, t, {
      kind: 'transition',
      from: 'blocked',
      to: 'running',
    });
    expect(decision.allow).toBe(true);
  });

  it('executor: running → failed allowed (self-report failure)', async () => {
    const { resolveTaskMutationPermission } = await import('../services/task-permission');
    const a = actor({ id: 'assignee_id', type: 'agent', role: null });
    const t = task({ assigneeId: 'assignee_id', status: 'running' });
    const decision = await resolveTaskMutationPermission(a, t, {
      kind: 'transition',
      from: 'running',
      to: 'failed',
    });
    expect(decision.allow).toBe(true);
  });

  it('executor: failed → assigned allowed (self-retry)', async () => {
    const { resolveTaskMutationPermission } = await import('../services/task-permission');
    const a = actor({ id: 'assignee_id', type: 'agent', role: null });
    const t = task({ assigneeId: 'assignee_id', status: 'failed' });
    const decision = await resolveTaskMutationPermission(a, t, {
      kind: 'transition',
      from: 'failed',
      to: 'assigned',
    });
    expect(decision.allow).toBe(true);
  });

  it('executor cannot edit-content or assign — only transition', async () => {
    const { resolveTaskMutationPermission } = await import('../services/task-permission');
    const a = actor({ id: 'assignee_id', type: 'agent', role: null });
    const t = task({ assigneeId: 'assignee_id', status: 'running' });

    const edit = await resolveTaskMutationPermission(a, t, { kind: 'edit-content' });
    expect(edit.allow).toBe(false);

    const assign = await resolveTaskMutationPermission(a, t, { kind: 'assign' });
    expect(assign.allow).toBe(false);
  });

  it('executor on NOT-their task — transition denied even when status would be valid', async () => {
    const { resolveTaskMutationPermission } = await import('../services/task-permission');
    const a = actor({ id: 'some_other_agent', type: 'agent', role: null });
    const t = task({ assigneeId: 'assignee_id', status: 'assigned' });
    const decision = await resolveTaskMutationPermission(a, t, {
      kind: 'transition',
      from: 'assigned',
      to: 'running',
    });
    expect(decision.allow).toBe(false);
  });
});

describe('Task permission resolver — invalid transitions', () => {
  beforeEach(resetPrismaMock);

  it('rejects structurally invalid transitions even for L3 member-creator', async () => {
    const { resolveTaskMutationPermission } = await import('../services/task-permission');
    const a = actor({ id: 'creator_id', type: 'human', role: 'member' });
    const t = task({ creatorId: 'creator_id', status: 'pending' });

    // pending → completed is not in TRANSITIONS
    const decision = await resolveTaskMutationPermission(a, t, {
      kind: 'transition',
      from: 'pending',
      to: 'completed',
    });
    expect(decision.allow).toBe(false);
    if (!decision.allow) {
      expect(decision.reason).toMatch(/invalid transition/);
    }
  });

  it('rejects transitions out of completed (terminal)', async () => {
    const { resolveTaskMutationPermission } = await import('../services/task-permission');
    const a = actor({ id: 'creator_id', type: 'human', role: 'member' });
    const t = task({ creatorId: 'creator_id', status: 'completed' });

    const decision = await resolveTaskMutationPermission(a, t, {
      kind: 'transition',
      from: 'completed',
      to: 'assigned',
    });
    expect(decision.allow).toBe(false);
  });
});

describe('Force-transition gate (L0/L1 only escape hatch)', () => {
  it('allows L0 owner', async () => {
    const { isForceTransitionAllowed } = await import('../services/task-permission');
    expect(isForceTransitionAllowed(actor({ type: 'human', role: 'owner' }))).toBe(true);
  });

  it('allows L1 admin', async () => {
    const { isForceTransitionAllowed } = await import('../services/task-permission');
    expect(isForceTransitionAllowed(actor({ type: 'human', role: 'admin' }))).toBe(true);
  });

  it('allows admin-trust-tier (trustTier>=4) even for agents', async () => {
    const { isForceTransitionAllowed } = await import('../services/task-permission');
    expect(
      isForceTransitionAllowed(actor({ type: 'agent', role: null, trustTier: 4 })),
    ).toBe(true);
  });

  it('denies L2 orchestrator (must use /transition, not /force-transition)', async () => {
    const { isForceTransitionAllowed } = await import('../services/task-permission');
    expect(
      isForceTransitionAllowed(actor({ type: 'agent', role: null, trustTier: 0 })),
    ).toBe(false);
  });

  it('denies L3 member (even for own task)', async () => {
    const { isForceTransitionAllowed } = await import('../services/task-permission');
    expect(
      isForceTransitionAllowed(actor({ type: 'human', role: 'member' })),
    ).toBe(false);
  });

  it('denies L4 executor agent', async () => {
    const { isForceTransitionAllowed } = await import('../services/task-permission');
    expect(
      isForceTransitionAllowed(actor({ type: 'agent', role: null })),
    ).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════
// release202/08 §3.2 — config-driven, role-agnostic dispatch scope
// ════════════════════════════════════════════════════════════════════════

describe('DEFAULT_DISPATCH_POLICY data table (role-agnostic)', () => {
  it('is a data constant: owner-admin/orchestrator → any, member → agents, executor → none', async () => {
    const { DEFAULT_DISPATCH_POLICY } = await import('../services/task-permission');
    expect(DEFAULT_DISPATCH_POLICY['owner-admin']).toBe('any');
    expect(DEFAULT_DISPATCH_POLICY.orchestrator).toBe('any');
    expect(DEFAULT_DISPATCH_POLICY.member).toBe('agents');
    expect(DEFAULT_DISPATCH_POLICY['executor-agent']).toBe('none');
  });
});

describe('scope × assigneeClass matrix (pure, §3.2c)', () => {
  it('matches the spec table for every combination', async () => {
    const { isAssigneeAllowedByScope } = await import('../services/task-permission');
    // any → all true
    expect(isAssigneeAllowedByScope('any', 'agent')).toBe(true);
    expect(isAssigneeAllowedByScope('any', 'human')).toBe(true);
    expect(isAssigneeAllowedByScope('any', 'self')).toBe(true);
    // agents → agent+self true, human false
    expect(isAssigneeAllowedByScope('agents', 'agent')).toBe(true);
    expect(isAssigneeAllowedByScope('agents', 'self')).toBe(true);
    expect(isAssigneeAllowedByScope('agents', 'human')).toBe(false);
    // self → only self
    expect(isAssigneeAllowedByScope('self', 'self')).toBe(true);
    expect(isAssigneeAllowedByScope('self', 'agent')).toBe(false);
    expect(isAssigneeAllowedByScope('self', 'human')).toBe(false);
    // none → all false
    expect(isAssigneeAllowedByScope('none', 'agent')).toBe(false);
    expect(isAssigneeAllowedByScope('none', 'human')).toBe(false);
    expect(isAssigneeAllowedByScope('none', 'self')).toBe(false);
  });
});

describe('resolveDispatchScope — three-layer merge (§3.2b)', () => {
  beforeEach(resetPrismaMock);

  it('Layer 3 default: human owner → any (no overrides)', async () => {
    const { resolveDispatchScope } = await import('../services/task-permission');
    prismaMock.iMWorkspace.findFirst.mockResolvedValue(null); // no metadata override
    const a = actor({ id: 'owner_id', type: 'human', role: 'owner' });
    expect(await resolveDispatchScope(a, 'ws_1')).toBe('any');
  });

  it('Layer 3 default: human member → agents', async () => {
    const { resolveDispatchScope } = await import('../services/task-permission');
    prismaMock.iMWorkspace.findFirst.mockResolvedValue(null);
    const a = actor({ id: 'member_id', type: 'human', role: 'member' });
    expect(await resolveDispatchScope(a, 'ws_1')).toBe('agents');
  });

  it('Layer 3 default: non-orchestrator agent → none', async () => {
    const { resolveDispatchScope } = await import('../services/task-permission');
    // not orchestrator, no profile override, no ws override
    prismaMock.iMWorkspace.findFirst.mockResolvedValue(null);
    prismaMock.iMAgentProfile.findFirst.mockResolvedValue(null);
    const a = actor({ id: 'exec_agent', type: 'agent', role: null });
    expect(await resolveDispatchScope(a, 'ws_1')).toBe('none');
  });

  it('Layer 3 default: orchestrator agent → any', async () => {
    const { resolveDispatchScope } = await import('../services/task-permission');
    // isOrchestratorOf reads iMWorkspace.findFirst; also used for ws-policy.
    prismaMock.iMWorkspace.findFirst.mockResolvedValue({
      orchestratorAgentId: 'orch_agent',
      orchestratorRevokedAt: null,
      ownerImUserId: 'someone',
      metadata: null,
    });
    prismaMock.iMAgentProfile.findFirst.mockResolvedValue(null);
    const a = actor({ id: 'orch_agent', type: 'agent', role: null });
    expect(await resolveDispatchScope(a, 'ws_1')).toBe('any');
  });

  it('Layer 2 role/profile config overrides default: executor agent declaring agents', async () => {
    const { resolveDispatchScope } = await import('../services/task-permission');
    prismaMock.iMWorkspace.findFirst.mockResolvedValue(null); // not orchestrator, no ws override
    prismaMock.iMAgentProfile.findFirst.mockResolvedValue({
      config: JSON.stringify({ taskDispatchScope: 'agents' }),
    });
    const a = actor({ id: 'pm_agent', type: 'agent', role: null });
    // tier default would be 'none'; profile declaration lifts it to 'agents'.
    expect(await resolveDispatchScope(a, 'ws_1')).toBe('agents');
  });

  it('Layer 2 reads nested roleTemplate.taskDispatchScope (ceo-style shape)', async () => {
    const { resolveDispatchScope } = await import('../services/task-permission');
    prismaMock.iMWorkspace.findFirst.mockResolvedValue(null);
    prismaMock.iMAgentProfile.findFirst.mockResolvedValue({
      config: JSON.stringify({ roleTemplate: { taskDispatchScope: 'any' } }),
    });
    const a = actor({ id: 'some_agent', type: 'agent', role: null });
    expect(await resolveDispatchScope(a, 'ws_1')).toBe('any');
  });

  it('Layer 1 workspace policy (per-tier) overrides BOTH config and default', async () => {
    const { resolveDispatchScope } = await import('../services/task-permission');
    // member tier default is 'agents'; workspace tightens member → self.
    prismaMock.iMWorkspace.findFirst.mockResolvedValue({
      orchestratorAgentId: null,
      orchestratorRevokedAt: null,
      ownerImUserId: 'someone',
      metadata: JSON.stringify({ dispatchPolicy: { member: 'self' } }),
    });
    const a = actor({ id: 'member_id', type: 'human', role: 'member' });
    expect(await resolveDispatchScope(a, 'ws_1')).toBe('self');
  });

  it('Layer 1 workspace policy global default applies to all tiers', async () => {
    const { resolveDispatchScope } = await import('../services/task-permission');
    prismaMock.iMWorkspace.findFirst.mockResolvedValue({
      orchestratorAgentId: null,
      orchestratorRevokedAt: null,
      ownerImUserId: 'someone',
      metadata: JSON.stringify({ dispatchPolicy: { default: 'none' } }),
    });
    const a = actor({ id: 'member_id', type: 'human', role: 'member' });
    expect(await resolveDispatchScope(a, 'ws_1')).toBe('none');
  });

  it('Layer 1 workspace policy beats Layer 2 profile config', async () => {
    const { resolveDispatchScope } = await import('../services/task-permission');
    prismaMock.iMWorkspace.findFirst.mockResolvedValue({
      orchestratorAgentId: null,
      orchestratorRevokedAt: null,
      ownerImUserId: 'someone',
      metadata: JSON.stringify({ dispatchPolicy: { 'executor-agent': 'self' } }),
    });
    prismaMock.iMAgentProfile.findFirst.mockResolvedValue({
      config: JSON.stringify({ taskDispatchScope: 'agents' }),
    });
    const a = actor({ id: 'exec_agent', type: 'agent', role: null });
    // ws override for executor-agent tier wins over the profile 'agents'.
    expect(await resolveDispatchScope(a, 'ws_1')).toBe('self');
  });

  it('invalid config/policy values are ignored (fall through to next layer)', async () => {
    const { resolveDispatchScope } = await import('../services/task-permission');
    prismaMock.iMWorkspace.findFirst.mockResolvedValue({
      orchestratorAgentId: null,
      orchestratorRevokedAt: null,
      ownerImUserId: 'someone',
      metadata: JSON.stringify({ dispatchPolicy: { member: 'garbage' } }),
    });
    const a = actor({ id: 'member_id', type: 'human', role: 'member' });
    // garbage ws value ignored → member default 'agents'.
    expect(await resolveDispatchScope(a, 'ws_1')).toBe('agents');
  });
});

describe('EXTENSIBILITY PROOF: a brand-new role works with zero resolver code change', () => {
  beforeEach(resetPrismaMock);

  it('a never-before-seen role "qa-lead" declaring taskDispatchScope=agents resolves to agents', async () => {
    const { resolveDispatchScope, resolveDispatchPermission } = await import(
      '../services/task-permission'
    );
    // No workspace policy, NOT an orchestrator — purely a new role whose ONLY
    // signal is its declared config.taskDispatchScope. The resolver has no
    // knowledge of "qa-lead" anywhere; it reads the data.
    prismaMock.iMWorkspace.findFirst.mockResolvedValue(null);
    prismaMock.iMAgentProfile.findFirst.mockResolvedValue({
      config: JSON.stringify({
        roleTemplate: { slug: 'qa-lead' },
        taskDispatchScope: 'agents',
      }),
    });
    const a = actor({ id: 'qa_lead_agent', type: 'agent', role: null });
    expect(await resolveDispatchScope(a, 'ws_1')).toBe('agents');

    // And the capability resolves correctly per assignee class — assign to an
    // agent OK, assign to a human DENIED — all without a code edit.
    prismaMock.iMUser.findUnique.mockResolvedValue({ role: 'agent' });
    const okAgent = await resolveDispatchPermission(a, 'ws_1', 'other_agent');
    expect(okAgent.allow).toBe(true);

    prismaMock.iMUser.findUnique.mockResolvedValue({ role: 'human' });
    const denyHuman = await resolveDispatchPermission(a, 'ws_1', 'a_human');
    expect(denyHuman.allow).toBe(false);
    if (!denyHuman.allow) expect(denyHuman.reason).toBe('member-cannot-assign-human');
  });
});

describe('resolveDispatchPermission — scope × assigneeClass end to end', () => {
  beforeEach(resetPrismaMock);

  function mockWs(over: Record<string, unknown> = {}) {
    prismaMock.iMWorkspace.findFirst.mockResolvedValue({
      orchestratorAgentId: null,
      orchestratorRevokedAt: null,
      ownerImUserId: 'owner_id',
      metadata: null,
      ...over,
    });
  }

  it('owner (any) → can dispatch to a human', async () => {
    const { resolveDispatchPermission } = await import('../services/task-permission');
    mockWs();
    prismaMock.iMUser.findUnique.mockResolvedValue({ role: 'human' });
    const a = actor({ id: 'owner_id', type: 'human', role: 'owner' });
    const d = await resolveDispatchPermission(a, 'ws_1', 'some_human');
    expect(d.allow).toBe(true);
  });

  it('member (agents) → can dispatch to an agent', async () => {
    const { resolveDispatchPermission } = await import('../services/task-permission');
    mockWs();
    prismaMock.iMUser.findUnique.mockResolvedValue({ role: 'agent' });
    const a = actor({ id: 'member_id', type: 'human', role: 'member' });
    const d = await resolveDispatchPermission(a, 'ws_1', 'some_agent');
    expect(d.allow).toBe(true);
  });

  it('member (agents) → CANNOT dispatch to a human → member-cannot-assign-human', async () => {
    const { resolveDispatchPermission } = await import('../services/task-permission');
    mockWs();
    prismaMock.iMUser.findUnique.mockResolvedValue({ role: 'human' });
    const a = actor({ id: 'member_id', type: 'human', role: 'member' });
    const d = await resolveDispatchPermission(a, 'ws_1', 'some_human');
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.reason).toBe('member-cannot-assign-human');
      expect(d.requiredTiers).toContain('orchestrator');
    }
  });

  it('member (agents) → can always self-assign (no user lookup needed)', async () => {
    const { resolveDispatchPermission } = await import('../services/task-permission');
    mockWs();
    const a = actor({ id: 'member_id', type: 'human', role: 'member' });
    const d = await resolveDispatchPermission(a, 'ws_1', 'member_id'); // self
    expect(d.allow).toBe(true);
  });

  it('executor agent (none) → cannot dispatch at all', async () => {
    const { resolveDispatchPermission } = await import('../services/task-permission');
    mockWs();
    prismaMock.iMAgentProfile.findFirst.mockResolvedValue(null);
    prismaMock.iMUser.findUnique.mockResolvedValue({ role: 'agent' });
    const a = actor({ id: 'exec_agent', type: 'agent', role: null });
    const d = await resolveDispatchPermission(a, 'ws_1', 'some_agent');
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe('dispatch-not-permitted');
  });

  it('create action and assign action share the SAME resolver (no-bypass §3.4)', async () => {
    const { resolveTaskMutationPermission, resolveDispatchPermission } = await import(
      '../services/task-permission'
    );
    mockWs();
    prismaMock.iMUser.findUnique.mockResolvedValue({ role: 'human' });
    const a = actor({ id: 'member_id', type: 'human', role: 'member' });

    // create via the mutation resolver routing (uses task.assigneeId as the
    // intended initial assignee).
    const createDecision = await resolveTaskMutationPermission(
      a,
      task({ workspaceId: 'ws_1', assigneeId: 'a_human' }),
      { kind: 'create' },
    );
    // direct dispatch resolver — same inputs.
    const assignDecision = await resolveDispatchPermission(a, 'ws_1', 'a_human');

    // Both deny a member→human dispatch identically.
    expect(createDecision.allow).toBe(false);
    expect(assignDecision.allow).toBe(false);
    if (!createDecision.allow && !assignDecision.allow) {
      expect(createDecision.reason).toBe(assignDecision.reason);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
// release202/08 §3.3 — entry-point × actor resolution (E1 kanban / E2 DM /
// E3 group @). These pin the *actor → scope → assigneeClass → allow* chain at
// each of the three dispatch entrypoints. The scope resolver itself is exercised
// above; this block asserts the entrypoint-specific actor shapes resolve to the
// doc §3.3 outcomes (allow/deny + reason).
// ════════════════════════════════════════════════════════════════════════

describe('§3.3 entry-point actor resolution', () => {
  beforeEach(resetPrismaMock);

  // Workspace lookup helper. orchestratorAgentId/metadata configurable so a
  // single helper serves owner / member / orchestrator / executor scenarios.
  function mockWs(over: Record<string, unknown> = {}) {
    prismaMock.iMWorkspace.findFirst.mockResolvedValue({
      orchestratorAgentId: null,
      orchestratorRevokedAt: null,
      ownerImUserId: 'owner_id',
      metadata: null,
      ...over,
    });
  }

  // ── E1 Kanban manual create — actor is the logged-in human ───────────────
  describe('E1 kanban manual create (actor = logged-in human)', () => {
    it('owner can dispatch to any assignee class: agent / human / self', async () => {
      const { resolveDispatchPermission } = await import('../services/task-permission');
      const a = actor({ id: 'owner_id', type: 'human', role: 'owner' });

      mockWs();
      prismaMock.iMUser.findUnique.mockResolvedValue({ role: 'agent' });
      expect((await resolveDispatchPermission(a, 'ws_1', 'an_agent')).allow).toBe(true);

      mockWs();
      prismaMock.iMUser.findUnique.mockResolvedValue({ role: 'human' });
      expect((await resolveDispatchPermission(a, 'ws_1', 'a_human')).allow).toBe(true);

      // self — no user lookup needed.
      mockWs();
      expect((await resolveDispatchPermission(a, 'ws_1', 'owner_id')).allow).toBe(true);
    });

    it('admin can dispatch to any assignee class (same as owner)', async () => {
      const { resolveDispatchPermission } = await import('../services/task-permission');
      const a = actor({ id: 'admin_id', type: 'human', role: 'admin' });
      mockWs();
      prismaMock.iMUser.findUnique.mockResolvedValue({ role: 'human' });
      expect((await resolveDispatchPermission(a, 'ws_1', 'a_human')).allow).toBe(true);
    });

    it('member CAN dispatch to an agent', async () => {
      const { resolveDispatchPermission } = await import('../services/task-permission');
      const a = actor({ id: 'member_id', type: 'human', role: 'member' });
      mockWs();
      prismaMock.iMUser.findUnique.mockResolvedValue({ role: 'agent' });
      const d = await resolveDispatchPermission(a, 'ws_1', 'an_agent');
      expect(d.allow).toBe(true);
    });

    it('member dispatching to a HUMAN is denied → member-cannot-assign-human', async () => {
      const { resolveDispatchPermission } = await import('../services/task-permission');
      const a = actor({ id: 'member_id', type: 'human', role: 'member' });
      mockWs();
      prismaMock.iMUser.findUnique.mockResolvedValue({ role: 'human' });
      const d = await resolveDispatchPermission(a, 'ws_1', 'a_human');
      expect(d.allow).toBe(false);
      if (!d.allow) {
        expect(d.reason).toBe('member-cannot-assign-human');
        // 403 envelope should point the client at the tiers that COULD do it.
        expect(d.requiredTiers).toEqual(
          expect.arrayContaining(['orchestrator', 'admin', 'owner']),
        );
        expect(d.requiredTiers).not.toContain('creator');
      }
    });

    it('member CAN self-create / self-assign (self bucket)', async () => {
      const { resolveDispatchPermission } = await import('../services/task-permission');
      const a = actor({ id: 'member_id', type: 'human', role: 'member' });
      mockWs();
      // self target → classifyAssignee short-circuits, no user lookup.
      const dSelf = await resolveDispatchPermission(a, 'ws_1', 'member_id');
      expect(dSelf.allow).toBe(true);
      // null assignee (create unassigned, self-owned work) is also 'self'.
      mockWs();
      const dNull = await resolveDispatchPermission(a, 'ws_1', null);
      expect(dNull.allow).toBe(true);
    });

    it('E1 member→human via the create action mirrors resolveDispatchPermission (no-bypass)', async () => {
      const { resolveTaskMutationPermission } = await import('../services/task-permission');
      const a = actor({ id: 'member_id', type: 'human', role: 'member' });
      mockWs();
      prismaMock.iMUser.findUnique.mockResolvedValue({ role: 'human' });
      const d = await resolveTaskMutationPermission(
        a,
        task({ workspaceId: 'ws_1', assigneeId: 'a_human' }),
        { kind: 'create' },
      );
      expect(d.allow).toBe(false);
      if (!d.allow) expect(d.reason).toBe('member-cannot-assign-human');
    });
  });

  // ── E2 DM orchestrator create+assign — actor is the orchestrator agent ────
  describe('E2 DM orchestrator create+assign (actor = orchestrator agent)', () => {
    it('orchestrator can dispatch to any class incl. a human peer', async () => {
      const { resolveDispatchPermission } = await import('../services/task-permission');
      // orchestratorAgentId match (not revoked) → tier orchestrator → scope any.
      mockWs({ orchestratorAgentId: 'orch_agent' });
      prismaMock.iMAgentProfile.findFirst.mockResolvedValue(null);
      prismaMock.iMUser.findUnique.mockResolvedValue({ role: 'human' });
      const a = actor({ id: 'orch_agent', type: 'agent', role: null });
      const d = await resolveDispatchPermission(a, 'ws_1', 'a_human');
      expect(d.allow).toBe(true);
      if (d.allow) expect(d.via).toBe('orchestrator');
    });

    it('orchestrator can dispatch to another agent', async () => {
      const { resolveDispatchPermission } = await import('../services/task-permission');
      mockWs({ orchestratorAgentId: 'orch_agent' });
      prismaMock.iMAgentProfile.findFirst.mockResolvedValue(null);
      prismaMock.iMUser.findUnique.mockResolvedValue({ role: 'agent' });
      const a = actor({ id: 'orch_agent', type: 'agent', role: null });
      expect((await resolveDispatchPermission(a, 'ws_1', 'other_agent')).allow).toBe(true);
    });

    it('NON-orchestrator executor agent in a DM cannot dispatch to ANY class', async () => {
      const { resolveDispatchPermission } = await import('../services/task-permission');
      // not the orchestrator, no profile scope override → tier executor-agent → none.
      mockWs({ orchestratorAgentId: 'someone_else' });
      prismaMock.iMAgentProfile.findFirst.mockResolvedValue(null);
      const a = actor({ id: 'exec_agent', type: 'agent', role: null });

      prismaMock.iMUser.findUnique.mockResolvedValue({ role: 'agent' });
      const toAgent = await resolveDispatchPermission(a, 'ws_1', 'other_agent');
      expect(toAgent.allow).toBe(false);
      if (!toAgent.allow) expect(toAgent.reason).toBe('dispatch-not-permitted');

      mockWs({ orchestratorAgentId: 'someone_else' });
      prismaMock.iMAgentProfile.findFirst.mockResolvedValue(null);
      prismaMock.iMUser.findUnique.mockResolvedValue({ role: 'human' });
      const toHuman = await resolveDispatchPermission(a, 'ws_1', 'a_human');
      expect(toHuman.allow).toBe(false);

      // even self is denied under scope 'none' (no peer/self delegation).
      mockWs({ orchestratorAgentId: 'someone_else' });
      prismaMock.iMAgentProfile.findFirst.mockResolvedValue(null);
      const toSelf = await resolveDispatchPermission(a, 'ws_1', 'exec_agent');
      expect(toSelf.allow).toBe(false);
    });

    it('orchestrator authority revoked → executor-agent → none (DM dispatch denied)', async () => {
      const { resolveDispatchPermission } = await import('../services/task-permission');
      mockWs({
        orchestratorAgentId: 'orch_agent',
        orchestratorRevokedAt: new Date('2026-05-19'),
      });
      prismaMock.iMAgentProfile.findFirst.mockResolvedValue(null);
      prismaMock.iMUser.findUnique.mockResolvedValue({ role: 'agent' });
      const a = actor({ id: 'orch_agent', type: 'agent', role: null });
      const d = await resolveDispatchPermission(a, 'ws_1', 'other_agent');
      expect(d.allow).toBe(false);
    });
  });

  // ── E3 group @ — initiator tier decides (member @agent ✅, member @human ❌)─
  describe('E3 group @-mention (actor = initiator; tier decides)', () => {
    it('member @agent in a group → task dispatch allowed (member→agent)', async () => {
      const { resolveDispatchPermission } = await import('../services/task-permission');
      const a = actor({ id: 'member_id', type: 'human', role: 'member' });
      mockWs();
      prismaMock.iMUser.findUnique.mockResolvedValue({ role: 'agent' });
      const d = await resolveDispatchPermission(a, 'ws_1', 'engineer_agent');
      expect(d.allow).toBe(true);
    });

    it('member @human in a group → not a task (member-cannot-assign-human)', async () => {
      // §3.3: a member @-mentioning another human does not become a task; the
      // resolver surfaces the same member-cannot-assign-human deny that the API
      // layer uses to fall back to a plain @-mention instead of creating one.
      const { resolveDispatchPermission } = await import('../services/task-permission');
      const a = actor({ id: 'member_id', type: 'human', role: 'member' });
      mockWs();
      prismaMock.iMUser.findUnique.mockResolvedValue({ role: 'human' });
      const d = await resolveDispatchPermission(a, 'ws_1', 'another_human');
      expect(d.allow).toBe(false);
      if (!d.allow) expect(d.reason).toBe('member-cannot-assign-human');
    });

    it('owner @anyone in a group → allowed (initiator tier = owner)', async () => {
      const { resolveDispatchPermission } = await import('../services/task-permission');
      const a = actor({ id: 'owner_id', type: 'human', role: 'owner' });
      mockWs();
      prismaMock.iMUser.findUnique.mockResolvedValue({ role: 'human' });
      expect((await resolveDispatchPermission(a, 'ws_1', 'a_human')).allow).toBe(true);
    });

    it('non-orchestrator agent @another agent in a group → not a task (scope none)', async () => {
      const { resolveDispatchPermission } = await import('../services/task-permission');
      mockWs({ orchestratorAgentId: 'someone_else' });
      prismaMock.iMAgentProfile.findFirst.mockResolvedValue(null);
      prismaMock.iMUser.findUnique.mockResolvedValue({ role: 'agent' });
      const a = actor({ id: 'exec_agent', type: 'agent', role: null });
      const d = await resolveDispatchPermission(a, 'ws_1', 'peer_agent');
      expect(d.allow).toBe(false);
      if (!d.allow) expect(d.reason).toBe('dispatch-not-permitted');
    });
  });

  // ── workspace policy override at the entrypoint (E1 tightening) ──────────
  describe('§3.2 policy override interacts with entrypoint tier', () => {
    it('workspace tightening member→self denies an E1 member→agent dispatch', async () => {
      const { resolveDispatchPermission } = await import('../services/task-permission');
      mockWs({ metadata: JSON.stringify({ dispatchPolicy: { member: 'self' } }) });
      prismaMock.iMUser.findUnique.mockResolvedValue({ role: 'agent' });
      const a = actor({ id: 'member_id', type: 'human', role: 'member' });
      const d = await resolveDispatchPermission(a, 'ws_1', 'an_agent');
      expect(d.allow).toBe(false);
      if (!d.allow) expect(d.reason).toBe('dispatch-self-only');
      // but self still works under the tightened policy.
      mockWs({ metadata: JSON.stringify({ dispatchPolicy: { member: 'self' } }) });
      expect((await resolveDispatchPermission(a, 'ws_1', 'member_id')).allow).toBe(true);
    });

    it('workspace loosening executor-agent→agents lets an E2 executor delegate to agents (zero code change)', async () => {
      const { resolveDispatchPermission } = await import('../services/task-permission');
      // executor-agent default is none; a workspace explicitly grants 'agents'.
      mockWs({
        orchestratorAgentId: 'someone_else',
        metadata: JSON.stringify({ dispatchPolicy: { 'executor-agent': 'agents' } }),
      });
      prismaMock.iMAgentProfile.findFirst.mockResolvedValue(null);
      prismaMock.iMUser.findUnique.mockResolvedValue({ role: 'agent' });
      const a = actor({ id: 'exec_agent', type: 'agent', role: null });
      const toAgent = await resolveDispatchPermission(a, 'ws_1', 'peer_agent');
      expect(toAgent.allow).toBe(true);
      // still cannot reach a human (scope 'agents' bars the human class).
      mockWs({
        orchestratorAgentId: 'someone_else',
        metadata: JSON.stringify({ dispatchPolicy: { 'executor-agent': 'agents' } }),
      });
      prismaMock.iMAgentProfile.findFirst.mockResolvedValue(null);
      prismaMock.iMUser.findUnique.mockResolvedValue({ role: 'human' });
      const toHuman = await resolveDispatchPermission(a, 'ws_1', 'a_human');
      expect(toHuman.allow).toBe(false);
    });
  });
});

describe('TRANSITIONS matrix critical contracts', () => {
  it('review → completed allowed actors must exclude assignee', async () => {
    const { TRANSITIONS } = await import('../services/task-permission');
    const rule = TRANSITIONS.review?.completed;
    expect(rule).toBeDefined();
    expect(rule?.allowedActors).not.toContain('assignee');
    expect(rule?.allowedActors).toEqual(
      expect.arrayContaining(['owner', 'admin', 'orchestrator', 'creator']),
    );
  });

  it('review → assigned (rejection) allowed actors must exclude assignee', async () => {
    const { TRANSITIONS } = await import('../services/task-permission');
    const rule = TRANSITIONS.review?.assigned;
    expect(rule).toBeDefined();
    expect(rule?.allowedActors).not.toContain('assignee');
  });

  it('blocked → running allows assignee (self-unblock)', async () => {
    const { TRANSITIONS } = await import('../services/task-permission');
    const rule = TRANSITIONS.blocked?.running;
    expect(rule).toBeDefined();
    expect(rule?.allowedActors).toContain('assignee');
  });

  it('completed is terminal (no outgoing rules)', async () => {
    const { TRANSITIONS } = await import('../services/task-permission');
    expect(Object.keys(TRANSITIONS.completed)).toHaveLength(0);
  });
});
