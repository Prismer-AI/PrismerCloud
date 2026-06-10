/**
 * release201/08 — Skill Lifecycle Service unit tests.
 *
 * Covers:
 *  • promote() state-machine validation + status/publishedAt mirroring
 *  • Reviewer ≠ ownerAgentId guard at review→published
 *  • startEvalRun creates queued row + emits SSE
 *  • recordEvalFinish auto-promotes eval→review when pass rate ≥ threshold
 *  • publish() requires license + valid scope; rejects 'private'; runs
 *    promote + scope mirror + README/sample-task autogen
 *  • Snapshot one-time consumption + import flow
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

import { SkillLifecycleService, SkillLifecycleError, decideAutoOptimize } from '../services/skill-lifecycle.service';

function skillRow(overrides: Partial<any> = {}): any {
  return {
    id: 'skill-1',
    slug: 'demo-skill',
    name: 'Demo Skill',
    description: 'A demo skill description that passes the 50-char minimum easily.',
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

describe('SkillLifecycleService.promote', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.iMSkill.findUnique.mockResolvedValue(skillRow());
    mocks.prisma.iMSkill.update.mockImplementation(async (args: any) => ({ ...skillRow(), ...args.data }));
    mocks.prisma.iMTask.create.mockResolvedValue({ id: 'task-1' });
    mocks.prisma.iMWorkspace.findUnique.mockResolvedValue({ ownerImUserId: 'owner-1' });
    mocks.prisma.iMAgentSkill.updateMany.mockResolvedValue({ count: 0 });
    mocks.acceptanceApply.mockResolvedValue({ applied: true, templateId: 'tpl-x' });
  });

  it('rejects invalid transitions (draft → published direct)', async () => {
    const svc = new SkillLifecycleService();
    await expect(svc.promote('skill-1', { to: 'published', actorId: 'reviewer-1' })).rejects.toMatchObject({
      code: 'invalid_transition',
      statusCode: 409,
    });
  });

  it('rejects draft → eval when no sampleTasks', async () => {
    mocks.prisma.iMSkill.findUnique.mockResolvedValue(
      skillRow({ metadata: JSON.stringify({ skillJson: { sampleTasks: [] } }) }),
    );
    const svc = new SkillLifecycleService();
    await expect(svc.promote('skill-1', { to: 'eval', actorId: 'agent-1' })).rejects.toMatchObject({
      code: 'no_sample_tasks',
      statusCode: 400,
    });
  });

  it('promotes draft → eval and mirrors status', async () => {
    const svc = new SkillLifecycleService();
    const { skill, taskId } = await svc.promote('skill-1', { to: 'eval', actorId: 'agent-1' });
    expect(skill.lifecycleStage).toBe('eval');
    expect(skill.status).toBe('draft');
    expect(taskId).toBe('task-1');
    // creates a skill-eval IMTask
    const taskCall = mocks.prisma.iMTask.create.mock.calls[0][0];
    expect(taskCall.data.capability).toBe('skill-eval');
  });

  it('review → published rejects when reviewer === ownerAgentId', async () => {
    mocks.prisma.iMSkill.findUnique.mockResolvedValue(skillRow({ lifecycleStage: 'review' }));
    const svc = new SkillLifecycleService();
    await expect(svc.promote('skill-1', { to: 'published', actorId: 'agent-1' })).rejects.toMatchObject({
      code: 'self_review',
      statusCode: 403,
    });
  });

  it('review → published sets publishedAt + status=active', async () => {
    mocks.prisma.iMSkill.findUnique.mockResolvedValue(skillRow({ lifecycleStage: 'review' }));
    const svc = new SkillLifecycleService();
    const { skill } = await svc.promote('skill-1', { to: 'published', actorId: 'reviewer-1' });
    const updateCall = mocks.prisma.iMSkill.update.mock.calls[0][0];
    expect(updateCall.data.lifecycleStage).toBe('published');
    expect(updateCall.data.status).toBe('active');
    expect(updateCall.data.publishedAt).toBeInstanceOf(Date);
    expect(skill.lifecycleStage).toBe('published');
  });

  it('* → archived unbinds IMAgentSkill rows', async () => {
    mocks.prisma.iMSkill.findUnique.mockResolvedValue(skillRow({ lifecycleStage: 'published', status: 'active' }));
    const svc = new SkillLifecycleService();
    await svc.archive('skill-1', 'reviewer-1', 'no longer needed');
    expect(mocks.prisma.iMAgentSkill.updateMany).toHaveBeenCalledWith({
      where: { skillId: 'skill-1', status: 'active' },
      data: { status: 'unbound' },
    });
  });
});

describe('SkillLifecycleService.startEvalRun + recordEvalFinish', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    mocks.prisma.iMSkillEvalRun.update.mockImplementation(async (args: any) => ({
      id: args.where.id,
      ...args.data,
      skillId: 'skill-1',
      createdAt: new Date(),
      testCasesJson: JSON.stringify({ testCases: [{ id: 'tc-1', input: 'x' }] }),
    }));
    mocks.prisma.iMSkillEvalRun.findUnique.mockResolvedValue({
      id: 'er_abc',
      skillId: 'skill-1',
      status: 'running',
      testCasesJson: JSON.stringify({ testCases: [{ id: 'tc-1' }, { id: 'tc-2' }] }),
      passCount: 0,
      failCount: 0,
      createdAt: new Date(),
    });
    mocks.prisma.iMSkill.update.mockImplementation(async (args: any) => ({
      ...skillRow({ lifecycleStage: 'eval' }),
      ...args.data,
    }));
    mocks.prisma.iMTask.create.mockResolvedValue({ id: 'task-2' });
    mocks.prisma.iMWorkspace.findUnique.mockResolvedValue({ ownerImUserId: 'owner-1' });
  });

  it('creates queued row with non-empty testCases', async () => {
    const svc = new SkillLifecycleService();
    const run = await svc.startEvalRun('skill-1', [{ id: 'tc-1', input: 'hi' }], 'agent-1');
    expect(run.status).toBe('queued');
    expect(run.testCases.length).toBe(1);
  });

  it('rejects empty testCases', async () => {
    const svc = new SkillLifecycleService();
    await expect(svc.startEvalRun('skill-1', [], 'agent-1')).rejects.toMatchObject({
      code: 'no_test_cases',
    });
  });

  it('auto-promotes eval → review when pass rate ≥ 0.8', async () => {
    const svc = new SkillLifecycleService();
    const result = await svc.recordEvalFinish('er_abc', {
      results: [
        { id: 'tc-1', passed: true, durationMs: 1 },
        { id: 'tc-2', passed: true, durationMs: 1 },
      ],
      actorId: 'agent-1',
    });
    expect(result.autoPromoted).toBe(true);
    // the lifecycle update path was invoked (one call to iMSkill.update with lifecycleStage='review')
    const updates = mocks.prisma.iMSkill.update.mock.calls;
    expect(updates.some((c: any[]) => c[0]?.data?.lifecycleStage === 'review')).toBe(true);
  });

  it('does NOT auto-promote when pass rate < 0.8', async () => {
    const svc = new SkillLifecycleService();
    const result = await svc.recordEvalFinish('er_abc', {
      results: [
        { id: 'tc-1', passed: false, durationMs: 1 },
        { id: 'tc-2', passed: true, durationMs: 1 },
      ],
      actorId: 'agent-1',
    });
    expect(result.autoPromoted).toBe(false);
  });

  // release201 S13 P0-4 — eval finish must emit skill.eval.run_finished.
  it('P0-4: emits skill.eval.run_finished with pass/fail value + counts in dims', async () => {
    const svc = new SkillLifecycleService();
    await svc.recordEvalFinish('er_abc', {
      results: [
        { id: 'tc-1', passed: true, durationMs: 1 },
        { id: 'tc-2', passed: true, durationMs: 1 },
      ],
      actorId: 'agent-1',
    });

    const evalCall = mocks.metricEmit.mock.calls
      .map((c) => c[0])
      .find((c) => c.namespace === 'skill.eval' && c.name === 'run_finished');
    expect(evalCall).toBeTruthy();
    expect(evalCall!.value).toBe('pass');
    expect(evalCall!.dims.workspaceId).toBe('ws-1');
    expect(evalCall!.dims.skillId).toBe('skill-1');
    expect(evalCall!.dims.runId).toBe('er_abc');
    expect(evalCall!.dims.passCount).toBe('2');
    expect(evalCall!.dims.failCount).toBe('0');
  });

  it('P0-4: emits skill.eval.run_finished value=fail when any case fails', async () => {
    const svc = new SkillLifecycleService();
    await svc.recordEvalFinish('er_abc', {
      results: [
        { id: 'tc-1', passed: false, durationMs: 1 },
        { id: 'tc-2', passed: true, durationMs: 1 },
      ],
      actorId: 'agent-1',
    });
    const evalCall = mocks.metricEmit.mock.calls
      .map((c) => c[0])
      .find((c) => c.namespace === 'skill.eval' && c.name === 'run_finished');
    expect(evalCall!.value).toBe('fail');
  });
});

// release201/24 §Phase2 — auto-optimize loop.
describe('release201/24 — auto-optimize loop', () => {
  it('decideAutoOptimize: publish when >= threshold', () => {
    expect(decideAutoOptimize({ passRate: 0.9, threshold: 0.8, iteration: 0, maxIterations: 3, autoOptimize: true })).toBe('publish');
    expect(decideAutoOptimize({ passRate: 0.8, threshold: 0.8, iteration: 2, maxIterations: 3, autoOptimize: false })).toBe('publish');
  });
  it('decideAutoOptimize: regenerate when below threshold + autoOptimize on + under cap', () => {
    expect(decideAutoOptimize({ passRate: 0.5, threshold: 0.8, iteration: 0, maxIterations: 3, autoOptimize: true })).toBe('regenerate');
    expect(decideAutoOptimize({ passRate: 0.5, threshold: 0.8, iteration: 2, maxIterations: 3, autoOptimize: true })).toBe('regenerate');
  });
  it('decideAutoOptimize: stop when bypass (autoOptimize off) or cap reached', () => {
    expect(decideAutoOptimize({ passRate: 0.5, threshold: 0.8, iteration: 0, maxIterations: 3, autoOptimize: false })).toBe('stop');
    expect(decideAutoOptimize({ passRate: 0.5, threshold: 0.8, iteration: 3, maxIterations: 3, autoOptimize: true })).toBe('stop');
  });

  it('recordEvalFinish triggers a real regenerate when autoOptimize=on + below threshold', async () => {
    vi.clearAllMocks();
    const autoOptRow = skillRow({
      lifecycleStage: 'eval',
      metadata: JSON.stringify({
        skillJson: { sampleTasks: [{ title: 't', prompt: 'p', acceptanceCriteria: ['c'] }] },
        authoring: { autoOptimize: true, maxIterations: 3, autoOptimizeIteration: 0 },
      }),
    });
    mocks.prisma.iMSkill.findUnique.mockResolvedValue(autoOptRow);
    mocks.prisma.iMSkill.update.mockImplementation(async (args: any) => ({ ...autoOptRow, ...args.data }));
    mocks.prisma.iMSkillEvalRun.findUnique.mockResolvedValue({
      id: 'er_x',
      skillId: 'skill-1',
      status: 'running',
      testCasesJson: JSON.stringify({ testCases: [{ id: 'tc-1' }, { id: 'tc-2' }] }),
      passCount: 0,
      failCount: 0,
      createdAt: new Date(),
    });
    mocks.prisma.iMSkillEvalRun.update.mockImplementation(async (args: any) => ({ id: 'er_x', skillId: 'skill-1', createdAt: new Date(), ...args.data }));

    const regenSpy = vi.fn().mockResolvedValue(undefined);
    const svc = new SkillLifecycleService();
    svc.setAutoOptimizeRegenerator(regenSpy);

    const res = await svc.recordEvalFinish('er_x', {
      results: [
        { id: 'tc-1', passed: false, durationMs: 1, error: 'pattern miss' },
        { id: 'tc-2', passed: true, durationMs: 1 },
      ],
      actorId: 'agent-1',
    });

    expect(res.autoPromoted).toBe(false);
    expect(regenSpy).toHaveBeenCalledTimes(1);
    const [skillId, ownerAgentId, reason, failedCases] = regenSpy.mock.calls[0];
    expect(skillId).toBe('skill-1');
    expect(ownerAgentId).toBe('agent-1');
    expect(reason).toContain('auto-optimize iteration 1');
    expect(failedCases).toEqual([{ id: 'tc-1', error: 'pattern miss' }]);
  });

  it('recordEvalFinish does NOT regenerate when autoOptimize=off (bypass → manual)', async () => {
    vi.clearAllMocks();
    const row = skillRow({
      lifecycleStage: 'eval',
      metadata: JSON.stringify({
        skillJson: { sampleTasks: [{ title: 't', prompt: 'p', acceptanceCriteria: ['c'] }] },
        authoring: { autoOptimize: false },
      }),
    });
    mocks.prisma.iMSkill.findUnique.mockResolvedValue(row);
    mocks.prisma.iMSkill.update.mockImplementation(async (args: any) => ({ ...row, ...args.data }));
    mocks.prisma.iMSkillEvalRun.findUnique.mockResolvedValue({
      id: 'er_y', skillId: 'skill-1', status: 'running',
      testCasesJson: JSON.stringify({ testCases: [{ id: 'tc-1' }] }), passCount: 0, failCount: 0, createdAt: new Date(),
    });
    mocks.prisma.iMSkillEvalRun.update.mockImplementation(async (args: any) => ({ id: 'er_y', skillId: 'skill-1', createdAt: new Date(), ...args.data }));

    const regenSpy = vi.fn().mockResolvedValue(undefined);
    const svc = new SkillLifecycleService();
    svc.setAutoOptimizeRegenerator(regenSpy);
    await svc.recordEvalFinish('er_y', { results: [{ id: 'tc-1', passed: false, durationMs: 1 }], actorId: 'agent-1' });
    expect(regenSpy).not.toHaveBeenCalled();
  });
});

describe('SkillLifecycleService.publish', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.iMSkill.findUnique.mockResolvedValue(skillRow({ lifecycleStage: 'review', license: 'MIT' }));
    mocks.prisma.iMSkill.update.mockImplementation(async (args: any) => ({
      ...skillRow({ lifecycleStage: 'review' }),
      ...args.data,
    }));
    mocks.prisma.iMTask.create.mockResolvedValue({ id: 'task-3' });
    mocks.prisma.iMWorkspace.findUnique.mockResolvedValue({ ownerImUserId: 'owner-1' });
    mocks.prisma.iMAsset.create.mockResolvedValue({ id: 'asset-1' });
    mocks.prisma.iMWorkspaceFile.create.mockResolvedValue({ id: 'file-1' });
    mocks.acceptanceApply.mockResolvedValue({ applied: true, templateId: 'tpl-skill-tryout' });
  });

  it('rejects scope=private', async () => {
    const svc = new SkillLifecycleService();
    await expect(svc.publish('skill-1', { scope: 'private' as any, actorId: 'reviewer-1' })).rejects.toMatchObject({
      code: 'invalid_scope',
      statusCode: 400,
    });
  });

  it('rejects when reviewer is the ownerAgentId', async () => {
    const svc = new SkillLifecycleService();
    await expect(svc.publish('skill-1', { scope: 'workspace', actorId: 'agent-1' })).rejects.toMatchObject({
      code: 'self_review',
      statusCode: 403,
    });
  });

  it('publishes + writes scope + sample task + README asset', async () => {
    const svc = new SkillLifecycleService();
    const out = await svc.publish('skill-1', {
      scope: 'workspace',
      actorId: 'reviewer-1',
      includeBoilerplateTask: true,
    });
    expect(out.skill.publishScope).toBe('workspace');
    expect(out.sampleTaskId).toBe('task-3');
    expect(out.readmeFileId).toBe('file-1');
  });

  // release201 S13 P0-4 — publish must emit skill.published.
  it('P0-4: emits skill.published with publishScope dim', async () => {
    const svc = new SkillLifecycleService();
    await svc.publish('skill-1', {
      scope: 'workspace',
      actorId: 'reviewer-1',
      includeBoilerplateTask: false,
    });
    const pub = mocks.metricEmit.mock.calls
      .map((c) => c[0])
      .find((c) => c.namespace === 'skill' && c.name === 'published');
    expect(pub).toBeTruthy();
    expect(pub!.value).toBe(1);
    expect(pub!.dims.workspaceId).toBe('ws-1');
    expect(pub!.dims.skillId).toBe('skill-1');
    expect(pub!.dims.publishScope).toBe('workspace');
  });

  // release201 S13 P0-2 — sample tryout task auto-created during publish
  // must carry the default skill-tryout acceptance template.
  it('P0-2: boilerplate skill-tryout task receives the default acceptance template', async () => {
    const svc = new SkillLifecycleService();
    await svc.publish('skill-1', {
      scope: 'workspace',
      actorId: 'reviewer-1',
      includeBoilerplateTask: true,
    });
    expect(mocks.acceptanceApply).toHaveBeenCalled();
    // Find the call for skill-tryout capability (publish may also create a
    // skill-review task in upstream flows; we explicitly check tryout here).
    const tryoutCall = mocks.acceptanceApply.mock.calls.find((c: any[]) => c[1] === 'skill-tryout');
    expect(tryoutCall).toBeTruthy();
    expect(tryoutCall![2]).toBe('ws-1'); // workspaceId
  });
});

describe('SkillLifecycleService.makeSnapshot + importSnapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.iMSkill.findUnique.mockResolvedValue(skillRow({ lifecycleStage: 'published' }));
    mocks.prisma.iMSkill.update.mockImplementation(async (args: any) => ({
      ...skillRow({ lifecycleStage: 'published' }),
      ...args.data,
    }));
    mocks.prisma.iMSkill.create.mockImplementation(async (args: any) => ({
      id: 'skill-2',
      ...args.data,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
  });

  it('rejects snapshot when skill not published', async () => {
    mocks.prisma.iMSkill.findUnique.mockResolvedValue(skillRow({ lifecycleStage: 'draft' }));
    const svc = new SkillLifecycleService();
    await expect(svc.makeSnapshot('skill-1', 'reviewer-1', 7)).rejects.toMatchObject({
      code: 'wrong_stage_for_snapshot',
    });
  });

  it('round-trips: makeSnapshot then importSnapshot succeeds; second import fails (one-time)', async () => {
    const svc = new SkillLifecycleService();
    const snap = await svc.makeSnapshot('skill-1', 'reviewer-1', 7);
    expect(snap.snapshotKey.length).toBe(32);
    expect(snap.snapshotUrl).toMatch(/^prismer-snapshot:\/\//);

    // After makeSnapshot, the stored metadata includes one snapshot row.
    // Wire findMany to return our skill so importSnapshot can locate it.
    const updateCall = mocks.prisma.iMSkill.update.mock.calls[0][0];
    const persistedMeta = JSON.parse(updateCall.data.metadata);
    mocks.prisma.iMSkill.findMany.mockResolvedValue([
      { ...skillRow({ lifecycleStage: 'published' }), metadata: updateCall.data.metadata },
    ]);
    // first import — should succeed
    const result = await svc.importSnapshot(snap.snapshotUrl, snap.snapshotKey, 'ws-2', 'importer-1');
    expect(result.newSkillId).toBe('skill-2');
    expect(result.importedFrom.sourceSkillId).toBe('skill-1');

    // second import — service should reject with snapshot_reused (consumed flag set)
    const secondUpdate = mocks.prisma.iMSkill.update.mock.calls.find(
      (c: any[]) =>
        c[0]?.where?.id === 'skill-1' && JSON.parse(c[0].data.metadata).shareSnapshots?.[0]?.consumed === true,
    );
    expect(secondUpdate).toBeTruthy();
    const consumedMeta = JSON.parse(secondUpdate![0].data.metadata);
    mocks.prisma.iMSkill.findMany.mockResolvedValue([
      { ...skillRow({ lifecycleStage: 'published' }), metadata: JSON.stringify(consumedMeta) },
    ]);
    await expect(svc.importSnapshot(snap.snapshotUrl, snap.snapshotKey, 'ws-3', 'importer-2')).rejects.toMatchObject({
      code: 'snapshot_reused',
    });

    // assert serialized meta is shaped as we expect
    expect(persistedMeta.shareSnapshots.length).toBe(1);
    expect(persistedMeta.shareSnapshots[0].consumed).toBe(false);
  });

  it('rejects import with wrong snapshotKey', async () => {
    const svc = new SkillLifecycleService();
    const snap = await svc.makeSnapshot('skill-1', 'reviewer-1', 7);
    const updateCall = mocks.prisma.iMSkill.update.mock.calls[0][0];
    mocks.prisma.iMSkill.findMany.mockResolvedValue([
      { ...skillRow({ lifecycleStage: 'published' }), metadata: updateCall.data.metadata },
    ]);
    await expect(
      svc.importSnapshot(snap.snapshotUrl, 'wrong-key-0000000000000000000000', 'ws-2', 'importer-1'),
    ).rejects.toMatchObject({ code: 'invalid_snapshot_key' });
  });
});

describe('SkillLifecycleError', () => {
  it('exposes code + statusCode', () => {
    const err = new SkillLifecycleError('x', 'y', 410);
    expect(err.code).toBe('x');
    expect(err.message).toBe('y');
    expect(err.statusCode).toBe(410);
  });
});
