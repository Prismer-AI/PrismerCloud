/**
 * release201/10 §5.2 — VerifierDispatchService happy paths.
 *
 * Complements `acp-skill-publish-readme.test.ts` (3 fallback cases — manual
 * fallback / self-review block / generic task) by covering the **non-fallback**
 * happy paths for `dispatchVerifyRequest(taskId)`:
 *
 *   1. **criteria mix** — 3 criteria, distinct verifierAgentIds, distinct
 *      verifyModes (qualitative / quantitative / agent-self-check); expect
 *      2 dispatched, 1 skipped, 3 per-criterion entries.
 *   2. **creator fallback** — criteria omit verifierAgentId; expect dispatch
 *      to task.creatorId for all qualitative/quantitative criteria.
 *   3. **skip self-check** — agent-self-check criteria short-circuit; cloud
 *      never pushes for them, regardless of any verifier hint.
 *
 * S47 (release201/17 Wave G) — uses the same mock style as
 * acp-skill-publish-readme.test.ts (hoisted prisma + acceptance + spec mocks)
 * so the two test files together cover the full surface.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prisma: {
    iMSkill: { findUnique: vi.fn() },
    iMTask: { findUnique: vi.fn() },
  },
  acceptanceGet: vi.fn(),
  taskSpecGet: vi.fn(),
}));

// Both `default` + named `prisma` export — verifier-dispatch.service.ts
// imports via `import { prisma } from '@/lib/prisma'` (named).
vi.mock('@/lib/prisma', () => ({ default: mocks.prisma, prisma: mocks.prisma }));
vi.mock('../db', () => ({ default: mocks.prisma }));
vi.mock('../services/task-acceptance.service', () => ({
  getTaskAcceptanceService: () => ({ getAcceptance: mocks.acceptanceGet }),
}));
vi.mock('../services/task-spec.service', () => ({
  getTaskSpecService: () => ({ get: mocks.taskSpecGet }),
}));

import { VerifierDispatchService } from '../services/verifier-dispatch.service';

function baseTaskRow(overrides: Partial<any> = {}): any {
  return {
    id: 'task-1',
    title: 'Demo task',
    workspaceId: 'ws-1',
    creatorId: 'creator-agent',
    assigneeId: 'assignee-agent',
    capability: 'doc-write',
    metadata: JSON.stringify({}),
    ...overrides,
  };
}

describe('VerifierDispatchService.dispatchVerifyRequest — happy paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.taskSpecGet.mockResolvedValue({
      markdown: '# Spec\nBody',
      revision: 1,
      updatedAt: new Date('2026-05-28T00:00:00.000Z'),
    });
    mocks.prisma.iMSkill.findUnique.mockResolvedValue(null);
  });

  it('criteria mix — qualitative + quantitative + agent-self-check → 2 dispatched, 1 skipped', async () => {
    mocks.prisma.iMTask.findUnique.mockResolvedValue(baseTaskRow());
    mocks.acceptanceGet.mockResolvedValue({
      criteria: [
        {
          id: 'c-qual',
          verifyMode: 'qualitative',
          expectation: 'UI matches design',
          verifierAgentId: 'agent-ui-reviewer',
          evidenceRefs: [],
          status: 'pending',
        },
        {
          id: 'c-quant',
          verifyMode: 'quantitative',
          expectation: 'p95 < 500ms',
          verifierAgentId: 'agent-perf-bench',
          evidenceRefs: [],
          status: 'pending',
        },
        {
          id: 'c-self',
          verifyMode: 'agent-self-check',
          expectation: 'assignee self-verified',
          verifierAgentId: 'agent-self',
          evidenceRefs: [],
          status: 'pending',
        },
      ],
    });

    const publish = vi.fn();
    const sendToUser = vi.fn();
    const writeEvent = vi.fn().mockResolvedValue(undefined);
    const svc = new VerifierDispatchService({
      eventBusService: { publish },
      rooms: { sendToUser },
      syncService: { writeEvent },
    });

    const out = await svc.dispatchVerifyRequest('task-1');

    expect(out.dispatched).toBe(2);
    expect(out.skipped).toBe(1);
    expect(out.fallbackToManual).toBe(0);
    expect(out.perCriterion).toHaveLength(3);

    const qual = out.perCriterion.find((c) => c.criterionId === 'c-qual');
    const quant = out.perCriterion.find((c) => c.criterionId === 'c-quant');
    const self = out.perCriterion.find((c) => c.criterionId === 'c-self');
    expect(qual).toMatchObject({ result: 'dispatched', targetAgentId: 'agent-ui-reviewer' });
    expect(quant).toMatchObject({ result: 'dispatched', targetAgentId: 'agent-perf-bench' });
    expect(self).toMatchObject({ result: 'skipped', targetAgentId: null });

    // 2 SSE publishes (only for dispatched criteria, never for the skipped one).
    expect(publish).toHaveBeenCalledTimes(2);
    const events = publish.mock.calls.map((c) => c[0]);
    for (const ev of events) {
      expect(ev.type).toBe('task.verify.requested');
    }
    expect(events.some((ev) => ev.data.recipientHint === 'agent-ui-reviewer')).toBe(true);
    expect(events.some((ev) => ev.data.recipientHint === 'agent-perf-bench')).toBe(true);

    // 2 WS pushes targeting distinct verifier agents.
    expect(sendToUser).toHaveBeenCalledTimes(2);
    const wsRecipients = sendToUser.mock.calls.map((c) => c[0]);
    expect(wsRecipients).toEqual(expect.arrayContaining(['agent-ui-reviewer', 'agent-perf-bench']));

    // 2 sync events.
    expect(writeEvent).toHaveBeenCalledTimes(2);
  });

  it('creator fallback — criteria without verifierAgentId dispatch to task.creatorId', async () => {
    mocks.prisma.iMTask.findUnique.mockResolvedValue(baseTaskRow({ creatorId: 'fallback-creator-agent' }));
    mocks.acceptanceGet.mockResolvedValue({
      criteria: [
        {
          id: 'c-1',
          verifyMode: 'qualitative',
          expectation: 'looks correct',
          verifierAgentId: null,
          evidenceRefs: [],
          status: 'pending',
        },
        {
          id: 'c-2',
          verifyMode: 'quantitative',
          expectation: 'latency under budget',
          verifierAgentId: null,
          evidenceRefs: [],
          status: 'pending',
        },
      ],
    });

    const publish = vi.fn();
    const sendToUser = vi.fn();
    const svc = new VerifierDispatchService({
      eventBusService: { publish },
      rooms: { sendToUser },
    });

    const out = await svc.dispatchVerifyRequest('task-1');

    expect(out.dispatched).toBe(2);
    expect(out.fallbackToManual).toBe(0);
    expect(out.skipped).toBe(0);
    for (const entry of out.perCriterion) {
      expect(entry.result).toBe('dispatched');
      expect(entry.targetAgentId).toBe('fallback-creator-agent');
    }
    // Both WS pushes go to the creator (since verifierAgentId was null).
    expect(sendToUser).toHaveBeenCalledTimes(2);
    for (const call of sendToUser.mock.calls) {
      expect(call[0]).toBe('fallback-creator-agent');
    }
  });

  it('skip self-check — agent-self-check criteria are never dispatched, others proceed', async () => {
    mocks.prisma.iMTask.findUnique.mockResolvedValue(baseTaskRow());
    mocks.acceptanceGet.mockResolvedValue({
      criteria: [
        {
          id: 'c-self-1',
          verifyMode: 'agent-self-check',
          expectation: 'assignee self-attested',
          verifierAgentId: 'agent-ui-reviewer',
          // verifyOutcome already set by the assignee — the service must
          // skip purely on verifyMode, never inspect outcome.
          status: 'passed',
          evidenceRefs: [],
        },
        {
          id: 'c-self-2',
          verifyMode: 'agent-self-check',
          expectation: 'second self-check',
          verifierAgentId: null,
          status: 'passed',
          evidenceRefs: [],
        },
        {
          id: 'c-qual',
          verifyMode: 'qualitative',
          expectation: 'reviewer verifies',
          verifierAgentId: 'agent-ui-reviewer',
          evidenceRefs: [],
          status: 'pending',
        },
      ],
    });

    const publish = vi.fn();
    const svc = new VerifierDispatchService({
      eventBusService: { publish },
    });

    const out = await svc.dispatchVerifyRequest('task-1');

    expect(out.skipped).toBe(2);
    expect(out.dispatched).toBe(1);
    expect(out.fallbackToManual).toBe(0);

    const dispatched = out.perCriterion.filter((c) => c.result === 'dispatched');
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].criterionId).toBe('c-qual');
    expect(dispatched[0].targetAgentId).toBe('agent-ui-reviewer');

    // SSE only for the qualitative criterion.
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0].data.criterionId).toBe('c-qual');
  });
});
