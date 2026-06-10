/**
 * release201/19 G2 — verify-criterion self-review invariant.
 *
 * doc 08 §0.2.3: "Reviewer ≠ ownerAgentId（防同人审同人，service 层 403）"
 *
 * The publish-template + promote-state guards
 * (skill-lifecycle.service.ts L246 + L698) already reject self-review at the
 * lifecycle boundary. The verify-criterion endpoint was missing the same
 * invariant — a skill owner could individually mark each criterion on
 * their own `skill-review` IMTask as `passed` and slip past the
 * lifecycle gate. This test pins the new guard added in
 * task-acceptance.service.ts `verify()`.
 *
 * Scope (per the design note):
 *   - guard fires only when `task.capability === 'skill-review'` AND
 *     `task.metadata.skillId` resolves to a skill row where
 *     `ownerAgentId === actorId` AND the criterion verifyMode is NOT
 *     `agent-self-check` (self-check has its own actor-identity gate at
 *     task.service.ts L2628 `self_check_wrong_actor` and is allowed here
 *     so the assignee can self-evaluate).
 *   - non-skill-review tasks are unaffected (e.g. general workspace task
 *     verify continues to accept any actor).
 *   - a different agent (not the skill owner) can still verify the
 *     skill-review task.
 *
 * Mock surface: hoisted `prisma` model stub (iMTask + iMSkill +
 * iMConversation), since `verify()` reads
 *   • iMTask.findUnique(select: acceptanceCriteriaJson)  ← loadCriteria
 *   • iMTask.findUnique(select: capability + metadata)   ← new guard
 *   • iMSkill.findUnique(select: ownerAgentId)           ← new guard
 *   • iMTask.findUnique(select: …workspaceId…) + update  ← persistAndEmit
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prisma: {
    iMTask: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    iMSkill: {
      findUnique: vi.fn(),
    },
    iMMetricEvent: {
      createMany: vi.fn(),
    },
  },
}));

vi.mock('@/lib/prisma', () => ({ default: mocks.prisma, prisma: mocks.prisma }));
vi.mock('../db', () => ({ default: mocks.prisma }));

import { TaskAcceptanceService, AcceptanceError, type Criterion } from '../services/task-acceptance.service';

const OWNER_AGENT = 'agent-owner';
const OTHER_AGENT = 'agent-other';
const ASSIGNEE_AGENT = 'agent-assignee';
const SKILL_ID = 'skl-1';
const TASK_ID = 'task-skill-review-1';
const CRIT_QUAL = 'crit-qual';
const CRIT_SELF = 'crit-self';

function critQualitative(overrides: Partial<Criterion> = {}): Criterion {
  return {
    id: CRIT_QUAL,
    verifyMode: 'qualitative',
    expectation: 'README sections present',
    verifierAgentId: null,
    status: 'pending',
    required: true,
    evidenceRefs: [],
    verifiedAt: null,
    verifiedBy: null,
    verifyOutcomeNote: null,
    weight: 1,
    ...overrides,
  };
}

function critSelfCheck(overrides: Partial<Criterion> = {}): Criterion {
  return {
    id: CRIT_SELF,
    verifyMode: 'agent-self-check',
    expectation: 'assignee acknowledges sample task green',
    verifierAgentId: null,
    status: 'pending',
    required: true,
    evidenceRefs: [],
    verifiedAt: null,
    verifiedBy: null,
    verifyOutcomeNote: null,
    weight: 1,
    ...overrides,
  };
}

/**
 * Wire findUnique to dispatch by select-clause shape:
 *   • acceptanceCriteriaJson      → returns criteria-bearing row
 *   • capability + metadata        → returns the task identity row used by
 *     the new guard
 *   • workspaceId + capability + … → returns the persistAndEmit row
 */
function wireTaskFindUnique(opts: {
  criteria: Criterion[];
  capability: string | null;
  metadata: Record<string, unknown> | null;
}) {
  mocks.prisma.iMTask.findUnique.mockImplementation(({ select }: any) => {
    if (select?.acceptanceCriteriaJson) {
      return Promise.resolve({ acceptanceCriteriaJson: JSON.stringify(opts.criteria) });
    }
    if (select?.capability && select?.metadata && !select?.workspaceId) {
      return Promise.resolve({
        capability: opts.capability,
        metadata: opts.metadata ? JSON.stringify(opts.metadata) : null,
      });
    }
    // persistAndEmit row
    return Promise.resolve({
      acceptanceStatus: 'pending',
      workspaceId: 'ws-1',
      projectId: null,
      capability: opts.capability,
      assigneeId: ASSIGNEE_AGENT,
    });
  });
}

describe('release201/19 G2 — verify-criterion self-review guard', () => {
  let svc: TaskAcceptanceService;

  beforeEach(() => {
    vi.clearAllMocks();
    svc = new TaskAcceptanceService({});
    mocks.prisma.iMTask.update.mockResolvedValue({});
    mocks.prisma.iMMetricEvent.createMany.mockResolvedValue({ count: 0 });
  });

  it('skill owner CANNOT verify qualitative criterion on their own skill-review task → 403 forbidden_self_review', async () => {
    wireTaskFindUnique({
      criteria: [critQualitative()],
      capability: 'skill-review',
      metadata: { skillId: SKILL_ID },
    });
    mocks.prisma.iMSkill.findUnique.mockResolvedValue({ ownerAgentId: OWNER_AGENT });

    await expect(
      svc.verify(TASK_ID, CRIT_QUAL, { outcome: 'passed', note: 'lgtm' }, OWNER_AGENT),
    ).rejects.toMatchObject({
      name: 'AcceptanceError',
      code: 'forbidden_self_review',
      status: 403,
    });

    // Sanity: guard rejects BEFORE persistAndEmit, so no update issued.
    expect(mocks.prisma.iMTask.update).not.toHaveBeenCalled();
  });

  it('different agent CAN verify the same skill-review qualitative criterion → 200', async () => {
    wireTaskFindUnique({
      criteria: [critQualitative()],
      capability: 'skill-review',
      metadata: { skillId: SKILL_ID },
    });
    mocks.prisma.iMSkill.findUnique.mockResolvedValue({ ownerAgentId: OWNER_AGENT });

    const view = await svc.verify(
      TASK_ID,
      CRIT_QUAL,
      { outcome: 'passed', note: 'reviewed by other agent' },
      OTHER_AGENT,
    );

    expect(view.criteria.find((c) => c.id === CRIT_QUAL)?.status).toBe('passed');
    expect(view.criteria.find((c) => c.id === CRIT_QUAL)?.verifiedBy).toBe(OTHER_AGENT);
    expect(mocks.prisma.iMTask.update).toHaveBeenCalled();
  });

  it('non-skill-review task is unaffected — owner can verify general workspace task', async () => {
    wireTaskFindUnique({
      criteria: [critQualitative()],
      capability: 'general',
      metadata: null,
    });
    // iMSkill.findUnique MUST NOT be reached for non-skill-review tasks.
    mocks.prisma.iMSkill.findUnique.mockRejectedValue(
      new Error('iMSkill.findUnique called for non-skill-review task — guard scope leak'),
    );

    const view = await svc.verify(TASK_ID, CRIT_QUAL, { outcome: 'passed' }, OWNER_AGENT);

    expect(view.criteria.find((c) => c.id === CRIT_QUAL)?.status).toBe('passed');
    expect(view.criteria.find((c) => c.id === CRIT_QUAL)?.verifiedBy).toBe(OWNER_AGENT);
    expect(mocks.prisma.iMSkill.findUnique).not.toHaveBeenCalled();
  });

  it('agent-self-check verifyMode is allowed for skill-review task (deferred to B5 actor-identity gate)', async () => {
    // Even when capability=skill-review + actor=owner, agent-self-check
    // verifyMode bypasses the new guard so the *assignee* can self-evaluate.
    // The B5 self_check_wrong_actor gate (task.service.ts L2628) catches
    // owner-as-assignee mis-evaluation at the review→completed boundary
    // instead. So at the verify-criterion endpoint the call itself succeeds
    // — the gate fires later, on the transition.
    wireTaskFindUnique({
      criteria: [critSelfCheck()],
      capability: 'skill-review',
      metadata: { skillId: SKILL_ID },
    });
    // Because verifyMode==='agent-self-check' the guard short-circuits and
    // iMSkill.findUnique is never reached.
    mocks.prisma.iMSkill.findUnique.mockRejectedValue(
      new Error('iMSkill.findUnique called for agent-self-check criterion — guard scope leak'),
    );

    const view = await svc.verify(TASK_ID, CRIT_SELF, { outcome: 'passed', note: 'self-eval' }, ASSIGNEE_AGENT);

    expect(view.criteria.find((c) => c.id === CRIT_SELF)?.status).toBe('passed');
    expect(view.criteria.find((c) => c.id === CRIT_SELF)?.verifiedBy).toBe(ASSIGNEE_AGENT);
    expect(mocks.prisma.iMSkill.findUnique).not.toHaveBeenCalled();
  });
});

// Surface AcceptanceError import so tree-shaking + lint don't drop it.
void AcceptanceError;
