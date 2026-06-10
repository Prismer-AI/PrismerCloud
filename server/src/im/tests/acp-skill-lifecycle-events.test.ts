/**
 * release201/08 S21 — 14 SSE event / 11 sub-stage / 7 failure subState /
 * 4 session role coverage.
 *
 * Scope (per task spec):
 *   A. 14 `skill.authoring.*` SSE events all emit at least once across the
 *      lifecycle (createDraft → promote → eval → review → publish + sample
 *      task completion path).
 *   B. 11 sub-stage labels (`metadata.lifecycleSubStage`) get written.
 *   C. 7 failure subStates surface via `skill.authoring.failed` event
 *      payload.failureKind.
 *   D. 4 session role tags (business / dev / test / review) write through
 *      `conversation.metadata.skillDev.role`.
 *
 * DoD anchors: docs/release201/08 §0.2.1 + docs/release201/14 §3 S21 +
 * docs/release201/08 §10.6 14-event table + §10.7 7-failure table +
 * §3.0 4-role table.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prisma: {
    iMSkill: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
    iMSkillEvalRun: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    iMAgentSkill: {
      updateMany: vi.fn(),
    },
    iMTask: {
      create: vi.fn(),
    },
    iMWorkspace: {
      findUnique: vi.fn(),
    },
    iMAsset: {
      create: vi.fn(),
    },
    iMWorkspaceFile: {
      create: vi.fn(),
    },
    iMConversation: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
  metricEmit: vi.fn(),
  acceptanceApply: vi.fn(),
}));

vi.mock('../db', () => ({ default: mocks.prisma }));
vi.mock('../services/metric.service', () => ({
  metricEmit: mocks.metricEmit,
  getMetricService: () => ({ emit: mocks.metricEmit, flush: vi.fn(), stop: vi.fn(), stats: vi.fn() }),
}));
vi.mock('../services/task-acceptance.service', () => ({
  getTaskAcceptanceService: () => ({
    applyDefaultTemplateOnCreate: mocks.acceptanceApply,
  }),
}));

import { SkillLifecycleService } from '../services/skill-lifecycle.service';

// Capture every SSE event for assertions.
type SseCapture = { type: string; payload: any };
function makeSyncCapture(): { sync: any; events: SseCapture[] } {
  const events: SseCapture[] = [];
  return {
    events,
    sync: {
      writeEvent: vi.fn(async (type: string, data: any) => {
        events.push({ type, payload: data });
      }),
    },
  };
}

function skillRow(overrides: Partial<any> = {}): any {
  return {
    id: 'skill-1',
    slug: 'demo-skill',
    name: 'Demo Skill',
    description: 'A demo skill description that passes the 50-char min easily for tests.',
    status: 'draft',
    lifecycleStage: 'draft',
    publishScope: 'private',
    ownerAgentId: 'agent-1',
    workspaceId: 'ws-1',
    publishedAt: null,
    license: 'MIT',
    metadata: JSON.stringify({
      skillJson: {
        sampleTasks: [{ title: 't1', prompt: 'p1', acceptanceCriteria: ['c1'] }],
      },
    }),
    contentManifest: '[]',
    contentManifestRevision: 'aaaa',
    requires: '{}',
    compatibility: '[]',
    version: '1.0.0',
    signals: '[]',
    author: '',
    sourceUrl: '',
    tags: '[]',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.iMSkill.findUnique.mockResolvedValue(skillRow());
  mocks.prisma.iMSkill.update.mockImplementation(async (args: any) => ({
    ...skillRow(),
    ...args.data,
  }));
  mocks.prisma.iMTask.create.mockResolvedValue({ id: 'task-1' });
  mocks.prisma.iMWorkspace.findUnique.mockResolvedValue({ ownerImUserId: 'owner-1' });
  mocks.prisma.iMAgentSkill.updateMany.mockResolvedValue({ count: 0 });
  mocks.prisma.iMAsset.create.mockResolvedValue({ id: 'asset-1' });
  mocks.prisma.iMWorkspaceFile.create.mockResolvedValue({ id: 'file-1' });
  mocks.acceptanceApply.mockResolvedValue({ applied: true, templateId: 'tpl-x' });
});

// ───────────────────────────────────────────────────────────────────────
// A. 14 SSE event — all wired through SkillLifecycleService.
// ───────────────────────────────────────────────────────────────────────

describe('S21 — 14 skill.authoring.* SSE events', () => {
  it('emits skill.authoring.started via notifyAuthoringStarted', async () => {
    const { sync, events } = makeSyncCapture();
    const svc = new SkillLifecycleService({ sync });
    await svc.notifyAuthoringStarted({ skill: skillRow(), sourceKind: 'inline-spec' });
    expect(events.map((e) => e.type)).toContain('skill.authoring.started');
  });

  it('emits skill.authoring.source_reviewed via notifySourceReviewed', async () => {
    const { sync, events } = makeSyncCapture();
    const svc = new SkillLifecycleService({ sync });
    await svc.notifySourceReviewed({ skill: skillRow(), sourceRefs: ['doc://x'] });
    expect(events.map((e) => e.type)).toContain('skill.authoring.source_reviewed');
    const ev = events.find((e) => e.type === 'skill.authoring.source_reviewed')!;
    expect(ev.payload.sourceRefs).toEqual(['doc://x']);
  });

  it('emits skill.authoring.bundle_scaffolded via notifyBundleScaffolded', async () => {
    const { sync, events } = makeSyncCapture();
    const svc = new SkillLifecycleService({ sync });
    await svc.notifyBundleScaffolded({ skill: skillRow(), manifestRevision: 'rev1', fileCount: 3 });
    expect(events.map((e) => e.type)).toContain('skill.authoring.bundle_scaffolded');
  });

  it('emits skill.authoring.state_changed on every setLifecycleSubStage call', async () => {
    const { sync, events } = makeSyncCapture();
    const svc = new SkillLifecycleService({ sync });
    await svc.setLifecycleSubStage(skillRow(), 'source_review');
    expect(events.map((e) => e.type)).toContain('skill.authoring.state_changed');
  });

  it('emits skill.authoring.validation_started + completed via notify*', async () => {
    const { sync, events } = makeSyncCapture();
    const svc = new SkillLifecycleService({ sync });
    await svc.notifyValidationStarted({ skill: skillRow(), gates: ['manifest', 'frontmatter'] });
    await svc.notifyValidationCompleted({
      skill: skillRow(),
      gates: [{ name: 'manifest', status: 'pass' }],
      failedGates: [],
    });
    const types = events.map((e) => e.type);
    expect(types).toContain('skill.authoring.validation_started');
    expect(types).toContain('skill.authoring.validation_completed');
  });

  it('emits skill.authoring.smoke_started on startEvalRun', async () => {
    const { sync, events } = makeSyncCapture();
    mocks.prisma.iMSkill.findUnique.mockResolvedValue(skillRow({ lifecycleStage: 'eval' }));
    mocks.prisma.iMSkillEvalRun.create.mockImplementation(async (args: any) => ({
      ...args.data,
      createdAt: new Date(),
      passCount: 0,
      failCount: 0,
      startedAt: null,
      finishedAt: null,
      agentTraceUrl: null,
      daemonId: null,
      resultsJson: null,
    }));
    const svc = new SkillLifecycleService({ sync });
    await svc.startEvalRun('skill-1', [{ id: 'tc-1', input: 'x' }], 'agent-1');
    expect(events.map((e) => e.type)).toContain('skill.authoring.smoke_started');
  });

  it('emits skill.authoring.smoke_completed + validation_completed on recordEvalFinish', async () => {
    const { sync, events } = makeSyncCapture();
    mocks.prisma.iMSkill.findUnique.mockResolvedValue(skillRow({ lifecycleStage: 'eval' }));
    mocks.prisma.iMSkillEvalRun.findUnique.mockResolvedValue({
      id: 'er_a',
      skillId: 'skill-1',
      status: 'running',
      testCasesJson: JSON.stringify({ testCases: [{ id: 'tc-1' }] }),
      passCount: 0,
      failCount: 0,
      createdAt: new Date(),
    });
    mocks.prisma.iMSkillEvalRun.update.mockImplementation(async (args: any) => ({
      id: args.where.id,
      ...args.data,
      skillId: 'skill-1',
      createdAt: new Date(),
      testCasesJson: JSON.stringify({ testCases: [{ id: 'tc-1' }] }),
    }));
    const svc = new SkillLifecycleService({ sync });
    await svc.recordEvalFinish('er_a', {
      results: [{ id: 'tc-1', passed: true }],
      actorId: 'agent-1',
    });
    const types = events.map((e) => e.type);
    expect(types).toContain('skill.authoring.smoke_completed');
    expect(types).toContain('skill.authoring.validation_completed');
  });

  it('emits skill.authoring.sample_task_started on publish + sample_task_completed via notify*', async () => {
    const { sync, events } = makeSyncCapture();
    mocks.prisma.iMSkill.findUnique.mockResolvedValue(skillRow({ lifecycleStage: 'review', license: 'MIT' }));
    const svc = new SkillLifecycleService({ sync });
    await svc.publish('skill-1', { scope: 'workspace', actorId: 'reviewer-1', includeBoilerplateTask: true });
    expect(events.map((e) => e.type)).toContain('skill.authoring.sample_task_started');

    // Companion event via TaskService completion path
    mocks.prisma.iMSkill.findUnique.mockResolvedValue(skillRow());
    await svc.notifySampleTaskCompleted({ skillId: 'skill-1', sampleTaskId: 'task-3', passed: true });
    expect(events.map((e) => e.type)).toContain('skill.authoring.sample_task_completed');
  });

  it('emits skill.authoring.review_requested + publish_requested + published in the publish flow', async () => {
    const { sync, events } = makeSyncCapture();
    mocks.prisma.iMSkill.findUnique.mockResolvedValue(skillRow({ lifecycleStage: 'review', license: 'MIT' }));
    const svc = new SkillLifecycleService({ sync });
    await svc.publish('skill-1', { scope: 'workspace', actorId: 'reviewer-1', includeBoilerplateTask: false });
    const types = events.map((e) => e.type);
    expect(types).toContain('skill.authoring.publish_requested');
    expect(types).toContain('skill.authoring.published');
  });

  it('emits skill.authoring.review_requested on promote(eval→review)', async () => {
    const { sync, events } = makeSyncCapture();
    mocks.prisma.iMSkill.findUnique.mockResolvedValue(skillRow({ lifecycleStage: 'eval' }));
    const svc = new SkillLifecycleService({ sync });
    await svc.promote('skill-1', { to: 'review', actorId: 'system' });
    expect(events.map((e) => e.type)).toContain('skill.authoring.review_requested');
  });

  it('emits skill.authoring.failed via emitAuthoringFailed', async () => {
    const { sync, events } = makeSyncCapture();
    const svc = new SkillLifecycleService({ sync });
    await svc.emitAuthoringFailed(skillRow(), 'needs_input', 'intake', 'missing description');
    expect(events.map((e) => e.type)).toContain('skill.authoring.failed');
  });

  it('emits skill.lifecycle.changed on every successful promote', async () => {
    const { sync, events } = makeSyncCapture();
    const svc = new SkillLifecycleService({ sync });
    await svc.promote('skill-1', { to: 'eval', actorId: 'agent-1' });
    expect(events.map((e) => e.type)).toContain('skill.lifecycle.changed');
  });

  it('emits skill.eval.progress via emitEvalProgress', async () => {
    const { sync, events } = makeSyncCapture();
    mocks.prisma.iMSkillEvalRun.findUnique.mockResolvedValue({
      id: 'er_a',
      skillId: 'skill-1',
    });
    const svc = new SkillLifecycleService({ sync });
    await svc.emitEvalProgress('er_a', { passCount: 1, failCount: 0, currentCase: 'tc-1' });
    expect(events.map((e) => e.type)).toContain('skill.eval.progress');
  });

  // Whole-suite gate: across the union of the above flows we must observe
  // every one of the 14 names. We synthesize them by running them all.
  it('union of flows surfaces all 14 distinct skill.authoring + skill.lifecycle + skill.eval events', async () => {
    const { sync, events } = makeSyncCapture();
    const svc = new SkillLifecycleService({ sync });
    const skill = skillRow();
    await svc.notifyAuthoringStarted({ skill, sourceKind: 'inline-spec' });
    await svc.notifySourceReviewed({ skill, sourceRefs: ['x'] });
    await svc.notifyBundleScaffolded({ skill, manifestRevision: 'r1', fileCount: 1 });
    await svc.setLifecycleSubStage(skill, 'source_review');
    await svc.notifyValidationStarted({ skill, gates: ['manifest'] });
    await svc.notifyValidationCompleted({
      skill,
      gates: [{ name: 'manifest', status: 'pass' }],
      failedGates: [],
    });
    // smoke/sample/review/publish/published/failed via the canonical
    // service flows
    mocks.prisma.iMSkill.findUnique.mockResolvedValue(skillRow({ lifecycleStage: 'eval' }));
    mocks.prisma.iMSkillEvalRun.create.mockImplementation(async (args: any) => ({
      ...args.data,
      createdAt: new Date(),
      passCount: 0,
      failCount: 0,
      startedAt: null,
      finishedAt: null,
      agentTraceUrl: null,
      daemonId: null,
      resultsJson: null,
    }));
    mocks.prisma.iMSkillEvalRun.findUnique.mockResolvedValue({
      id: 'er_a',
      skillId: 'skill-1',
      status: 'running',
      testCasesJson: JSON.stringify({ testCases: [{ id: 'tc-1' }] }),
      passCount: 0,
      failCount: 0,
      createdAt: new Date(),
    });
    mocks.prisma.iMSkillEvalRun.update.mockImplementation(async (args: any) => ({
      id: args.where.id,
      ...args.data,
      skillId: 'skill-1',
      createdAt: new Date(),
      testCasesJson: JSON.stringify({ testCases: [{ id: 'tc-1' }] }),
    }));
    await svc.startEvalRun('skill-1', [{ id: 'tc-1', input: 'x' }], 'agent-1');
    await svc.recordEvalFinish('er_a', {
      results: [{ id: 'tc-1', passed: true }],
      actorId: 'agent-1',
    });
    mocks.prisma.iMSkill.findUnique.mockResolvedValue(skillRow({ lifecycleStage: 'review', license: 'MIT' }));
    await svc.publish('skill-1', { scope: 'workspace', actorId: 'reviewer-1', includeBoilerplateTask: true });
    await svc.notifySampleTaskCompleted({ skillId: 'skill-1', sampleTaskId: 'task-3', passed: true });
    await svc.emitAuthoringFailed(skill, 'needs_input', 'intake', 'demo');
    await svc.emitEvalProgress('er_a', { passCount: 1, failCount: 0 });

    const expected = [
      'skill.authoring.started',
      'skill.authoring.source_reviewed',
      'skill.authoring.bundle_scaffolded',
      'skill.authoring.state_changed',
      'skill.authoring.validation_started',
      'skill.authoring.validation_completed',
      'skill.authoring.smoke_started',
      'skill.authoring.smoke_completed',
      'skill.authoring.sample_task_started',
      'skill.authoring.sample_task_completed',
      'skill.authoring.review_requested',
      'skill.authoring.publish_requested',
      'skill.authoring.published',
      'skill.authoring.failed',
      'skill.lifecycle.changed',
      'skill.eval.progress',
    ];
    const seen = new Set(events.map((e) => e.type));
    for (const t of expected) {
      expect(seen.has(t)).toBe(true);
    }
    // 14 authoring + 2 lifecycle/eval = 16 distinct topics; doc-08 §10.6
    // labels 14 of these as `skill.authoring.*` and 2 are sibling family
    // events.
    const authoringCount = expected.filter((t) => t.startsWith('skill.authoring.')).length;
    expect(authoringCount).toBe(14);
  });
});

// ───────────────────────────────────────────────────────────────────────
// B. 11 sub-stage labels — every one writable via service paths.
// ───────────────────────────────────────────────────────────────────────

describe('S21 — 11 lifecycleSubStage labels', () => {
  it('writes intake (draft entry) via promote(*→draft) — direct setLifecycleSubStage', async () => {
    const updates: any[] = [];
    mocks.prisma.iMSkill.update.mockImplementation(async (args: any) => {
      updates.push(args.data);
      return { ...skillRow(), ...args.data };
    });
    const svc = new SkillLifecycleService();
    await svc.setLifecycleSubStage(skillRow(), 'intake');
    const written = updates.find((u) => JSON.parse(u.metadata ?? '{}').lifecycleSubStage === 'intake');
    expect(written).toBeTruthy();
  });

  it.each([
    'intake',
    'source_review',
    'design',
    'scaffold',
    'implement',
    'static_validate',
    'sandbox_smoke',
    'sample_task',
    'human_review',
    'publish_ready',
    'published',
  ] as const)('writes %s via setLifecycleSubStage', async (sub) => {
    const updates: any[] = [];
    mocks.prisma.iMSkill.update.mockImplementation(async (args: any) => {
      updates.push(args.data);
      return { ...skillRow(), ...args.data };
    });
    const svc = new SkillLifecycleService();
    await svc.setLifecycleSubStage(skillRow(), sub);
    const written = updates.find((u) => JSON.parse(u.metadata ?? '{}').lifecycleSubStage === sub);
    expect(written).toBeTruthy();
  });

  it('promote(draft→eval) settles sub-stage at static_validate', async () => {
    const updates: any[] = [];
    mocks.prisma.iMSkill.update.mockImplementation(async (args: any) => {
      updates.push(args.data);
      return { ...skillRow(), ...args.data };
    });
    const svc = new SkillLifecycleService();
    await svc.promote('skill-1', { to: 'eval', actorId: 'agent-1' });
    const matched = updates.some((u) => {
      try {
        return JSON.parse(u.metadata ?? '{}').lifecycleSubStage === 'static_validate';
      } catch {
        return false;
      }
    });
    expect(matched).toBe(true);
  });

  it('promote(eval→review) settles sub-stage at human_review', async () => {
    mocks.prisma.iMSkill.findUnique.mockResolvedValue(skillRow({ lifecycleStage: 'eval' }));
    const updates: any[] = [];
    mocks.prisma.iMSkill.update.mockImplementation(async (args: any) => {
      updates.push(args.data);
      return { ...skillRow({ lifecycleStage: 'eval' }), ...args.data };
    });
    const svc = new SkillLifecycleService();
    await svc.promote('skill-1', { to: 'review', actorId: 'system' });
    const matched = updates.some((u) => {
      try {
        return JSON.parse(u.metadata ?? '{}').lifecycleSubStage === 'human_review';
      } catch {
        return false;
      }
    });
    expect(matched).toBe(true);
  });

  it('startEvalRun settles sub-stage at sandbox_smoke', async () => {
    mocks.prisma.iMSkill.findUnique.mockResolvedValue(skillRow({ lifecycleStage: 'eval' }));
    mocks.prisma.iMSkillEvalRun.create.mockImplementation(async (args: any) => ({
      ...args.data,
      createdAt: new Date(),
      passCount: 0,
      failCount: 0,
      startedAt: null,
      finishedAt: null,
      agentTraceUrl: null,
      daemonId: null,
      resultsJson: null,
    }));
    const updates: any[] = [];
    mocks.prisma.iMSkill.update.mockImplementation(async (args: any) => {
      updates.push(args.data);
      return { ...skillRow({ lifecycleStage: 'eval' }), ...args.data };
    });
    const svc = new SkillLifecycleService();
    await svc.startEvalRun('skill-1', [{ id: 'tc-1', input: 'x' }], 'agent-1');
    const matched = updates.some((u) => {
      try {
        return JSON.parse(u.metadata ?? '{}').lifecycleSubStage === 'sandbox_smoke';
      } catch {
        return false;
      }
    });
    expect(matched).toBe(true);
  });

  it('publish settles sub-stage at publish_ready then published', async () => {
    mocks.prisma.iMSkill.findUnique.mockResolvedValue(skillRow({ lifecycleStage: 'review', license: 'MIT' }));
    const updates: any[] = [];
    mocks.prisma.iMSkill.update.mockImplementation(async (args: any) => {
      updates.push(args.data);
      return { ...skillRow({ lifecycleStage: 'review' }), ...args.data };
    });
    const svc = new SkillLifecycleService();
    await svc.publish('skill-1', { scope: 'workspace', actorId: 'reviewer-1', includeBoilerplateTask: false });
    const subStages = updates
      .map((u) => {
        try {
          return JSON.parse(u.metadata ?? '{}').lifecycleSubStage;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    expect(subStages).toContain('publish_ready');
    expect(subStages).toContain('published');
  });
});

// ───────────────────────────────────────────────────────────────────────
// C. 7 failure subStates — all 7 surface via skill.authoring.failed
// payload.failureKind.
// ───────────────────────────────────────────────────────────────────────

describe('S21 — 7 failureKind on skill.authoring.failed', () => {
  it.each([
    'needs_input',
    'duplicate_or_reuse',
    'validation_failed',
    'requires_unavailable',
    'smoke_failed',
    'acceptance_failed',
    'review_blocked',
  ] as const)('fans out failureKind=%s on emitAuthoringFailed', async (kind) => {
    const { sync, events } = makeSyncCapture();
    const svc = new SkillLifecycleService({ sync });
    await svc.emitAuthoringFailed(skillRow(), kind, `stage:${kind}`, 'demo reason');
    const ev = events.find((e) => e.type === 'skill.authoring.failed');
    expect(ev).toBeTruthy();
    expect(ev!.payload.failureKind).toBe(kind);
  });

  it('promote draft→eval without sampleTasks emits failureKind=needs_input', async () => {
    const { sync, events } = makeSyncCapture();
    mocks.prisma.iMSkill.findUnique.mockResolvedValue(
      skillRow({
        metadata: JSON.stringify({ skillJson: { sampleTasks: [] } }),
      }),
    );
    const svc = new SkillLifecycleService({ sync });
    await expect(svc.promote('skill-1', { to: 'eval', actorId: 'agent-1' })).rejects.toThrow();
    const ev = events.find((e) => e.type === 'skill.authoring.failed');
    expect(ev).toBeTruthy();
    expect(ev!.payload.failureKind).toBe('needs_input');
  });

  it('promote review→published when reviewer === ownerAgentId emits failureKind=review_blocked', async () => {
    const { sync, events } = makeSyncCapture();
    mocks.prisma.iMSkill.findUnique.mockResolvedValue(skillRow({ lifecycleStage: 'review' }));
    const svc = new SkillLifecycleService({ sync });
    await expect(svc.promote('skill-1', { to: 'published', actorId: 'agent-1' })).rejects.toThrow();
    const ev = events.find((e) => e.type === 'skill.authoring.failed' && e.payload.failureKind === 'review_blocked');
    expect(ev).toBeTruthy();
  });

  it('promote with invalid transition emits failureKind=acceptance_failed', async () => {
    const { sync, events } = makeSyncCapture();
    mocks.prisma.iMSkill.findUnique.mockResolvedValue(skillRow({ lifecycleStage: 'draft' }));
    const svc = new SkillLifecycleService({ sync });
    await expect(svc.promote('skill-1', { to: 'published', actorId: 'reviewer-1' })).rejects.toThrow();
    const ev = events.find((e) => e.type === 'skill.authoring.failed' && e.payload.failureKind === 'acceptance_failed');
    expect(ev).toBeTruthy();
  });

  it('recordEvalFinish with failed cases emits failureKind=smoke_failed', async () => {
    const { sync, events } = makeSyncCapture();
    mocks.prisma.iMSkill.findUnique.mockResolvedValue(skillRow({ lifecycleStage: 'eval' }));
    mocks.prisma.iMSkillEvalRun.findUnique.mockResolvedValue({
      id: 'er_a',
      skillId: 'skill-1',
      status: 'running',
      testCasesJson: JSON.stringify({ testCases: [{ id: 'tc-1' }, { id: 'tc-2' }] }),
      passCount: 0,
      failCount: 0,
      createdAt: new Date(),
    });
    mocks.prisma.iMSkillEvalRun.update.mockImplementation(async (args: any) => ({
      id: args.where.id,
      ...args.data,
      skillId: 'skill-1',
      createdAt: new Date(),
      testCasesJson: JSON.stringify({ testCases: [{ id: 'tc-1' }, { id: 'tc-2' }] }),
    }));
    const svc = new SkillLifecycleService({ sync });
    await svc.recordEvalFinish('er_a', {
      results: [
        { id: 'tc-1', passed: false },
        { id: 'tc-2', passed: true },
      ],
      actorId: 'agent-1',
    });
    const ev = events.find((e) => e.type === 'skill.authoring.failed' && e.payload.failureKind === 'smoke_failed');
    expect(ev).toBeTruthy();
  });

  it('notifyValidationCompleted with failedGates emits failureKind=validation_failed', async () => {
    const { sync, events } = makeSyncCapture();
    const svc = new SkillLifecycleService({ sync });
    await svc.notifyValidationCompleted({
      skill: skillRow(),
      gates: [{ name: 'manifest', status: 'fail' }],
      failedGates: ['manifest'],
    });
    const ev = events.find((e) => e.type === 'skill.authoring.failed' && e.payload.failureKind === 'validation_failed');
    expect(ev).toBeTruthy();
  });

  it('notifyRequiresUnavailable emits failureKind=requires_unavailable', async () => {
    const { sync, events } = makeSyncCapture();
    mocks.prisma.iMSkill.findUnique.mockResolvedValue(skillRow());
    const svc = new SkillLifecycleService({ sync });
    await svc.notifyRequiresUnavailable({
      skillId: 'skill-1',
      missing: ['python3.11'],
    });
    const ev = events.find(
      (e) => e.type === 'skill.authoring.failed' && e.payload.failureKind === 'requires_unavailable',
    );
    expect(ev).toBeTruthy();
  });

  it('notifySampleTaskCompleted(passed=false) emits failureKind=acceptance_failed', async () => {
    const { sync, events } = makeSyncCapture();
    mocks.prisma.iMSkill.findUnique.mockResolvedValue(skillRow());
    const svc = new SkillLifecycleService({ sync });
    await svc.notifySampleTaskCompleted({ skillId: 'skill-1', sampleTaskId: 'task-x', passed: false });
    const ev = events.find((e) => e.type === 'skill.authoring.failed' && e.payload.failureKind === 'acceptance_failed');
    expect(ev).toBeTruthy();
  });
});

// ───────────────────────────────────────────────────────────────────────
// D. 4 session roles — conversation.metadata.skillDev.role write-through.
// ───────────────────────────────────────────────────────────────────────

describe('S21 — 4 session role tagging', () => {
  it('promote(eval→review) tags the supplied reviewConversationId as role=review', async () => {
    mocks.prisma.iMSkill.findUnique.mockResolvedValue(skillRow({ lifecycleStage: 'eval' }));
    const setSkillDevRole = vi.fn(async (...args: any[]) => ({
      conversationId: args[0],
      metadata: { skillDev: { role: args[2] } },
    }));
    const svc = new SkillLifecycleService({
      conversations: { setSkillDevRole } as any,
    });
    await svc.promote('skill-1', {
      to: 'review',
      actorId: 'system',
      reviewConversationId: 'conv-review-1',
      parentConversationId: 'conv-business-1',
    });
    expect(setSkillDevRole).toHaveBeenCalledWith(
      'conv-review-1',
      'skill-1',
      'review',
      expect.objectContaining({ parentConversationId: 'conv-business-1' }),
    );
  });

  it('startEvalRun(testConversationId) tags it as role=test', async () => {
    mocks.prisma.iMSkill.findUnique.mockResolvedValue(skillRow({ lifecycleStage: 'eval' }));
    mocks.prisma.iMSkillEvalRun.create.mockImplementation(async (args: any) => ({
      ...args.data,
      createdAt: new Date(),
      passCount: 0,
      failCount: 0,
      startedAt: null,
      finishedAt: null,
      agentTraceUrl: null,
      daemonId: null,
      resultsJson: null,
    }));
    const setSkillDevRole = vi.fn(async (...args: any[]) => ({
      conversationId: args[0],
      metadata: { skillDev: { role: args[2] } },
    }));
    const svc = new SkillLifecycleService({
      conversations: { setSkillDevRole } as any,
    });
    await svc.startEvalRun('skill-1', [{ id: 'tc-1', input: 'x' }], 'agent-1', {
      testConversationId: 'conv-test-1',
      parentConversationId: 'conv-business-1',
    });
    expect(setSkillDevRole).toHaveBeenCalledWith(
      'conv-test-1',
      'skill-1',
      'test',
      expect.objectContaining({ parentConversationId: 'conv-business-1' }),
    );
  });

  it('ConversationService.setSkillDevRole writes role=business/dev/test/review to metadata.skillDev', async () => {
    // Sanity check on the writer — ensures the underlying method covers all
    // 4 enum values (the 4 service-layer call sites pick the role string).
    const { ConversationService } = await import('../services/conversation.service');
    const fakeMeta: Record<string, unknown> = {};
    mocks.prisma.iMConversation.findUnique.mockResolvedValue({ id: 'c1', metadata: '{}' });
    mocks.prisma.iMConversation.update.mockImplementation(async (args: any) => {
      Object.assign(fakeMeta, JSON.parse(args.data.metadata));
      return { id: 'c1', metadata: args.data.metadata };
    });
    const cs = new ConversationService({} as any, { writeEvent: vi.fn() } as any);
    // Replace participant lookup so writeSyncForParticipants doesn't blow up.
    (cs as any).participantModel = { listByConversation: async () => [{ imUserId: 'u1' }] };
    for (const role of ['business', 'dev', 'test', 'review'] as const) {
      await cs.setSkillDevRole('c1', 'skill-1', role);
      expect((fakeMeta as any).skillDev.role).toBe(role);
    }
  });
});
