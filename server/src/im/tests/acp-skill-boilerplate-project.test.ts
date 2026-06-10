/**
 * release201 v2.0.8 G1 — createBoilerplateTask projectId injection.
 *
 * The cookbook agent-authored-skill flow publishes a skill which auto-creates
 * a sample task `Try out '<skill>'`. Prior to G1 that task was created with
 * `projectId=null`, which the workspace board hides whenever an active
 * project filter is on (release201/09 Phase 2 — project scope), so the user
 * reported the sample task as missing at cookbook step 8.
 *
 * This test pins the resolver order documented in
 * `SkillLifecycleService.resolveWorkspaceDefaultProject`:
 *   (a) workspace.metadata.defaultProjectId  (forward-compat hook — no
 *       caller persists this today, but the resolver honours it so future
 *       UX can pin a project as the workspace default)
 *   (b) earliest active iMProject in workspace
 *   (c) null   (no projects at all — preserves prior behaviour)
 *
 * Sibling to acp-skill-publish-readme.test.ts which covers the same
 * `publish()` call from the README / reviewer-guard angle.
 *
 * Run:
 *   npx vitest run src/im/tests/acp-skill-boilerplate-project.test.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prisma: {
    iMSkill: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    iMSkillEvalRun: {
      findUnique: vi.fn(),
    },
    iMAgentSkill: {
      updateMany: vi.fn(),
    },
    iMTask: {
      create: vi.fn(),
      findUnique: vi.fn(),
    },
    iMWorkspace: {
      findUnique: vi.fn(),
    },
    iMProject: {
      findFirst: vi.fn(),
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
  acceptanceGet: vi.fn(),
  taskSpecGet: vi.fn(),
}));

vi.mock('../db', () => ({ default: mocks.prisma }));
vi.mock('@/lib/prisma', () => ({ prisma: mocks.prisma }));
vi.mock('../services/metric.service', () => ({
  metricEmit: mocks.metricEmit,
  getMetricService: () => ({ emit: mocks.metricEmit, flush: vi.fn(), stop: vi.fn(), stats: vi.fn() }),
}));
vi.mock('../services/task-acceptance.service', () => ({
  getTaskAcceptanceService: () => ({
    applyDefaultTemplateOnCreate: mocks.acceptanceApply,
    getAcceptance: mocks.acceptanceGet,
  }),
}));
vi.mock('../services/task-spec.service', () => ({
  getTaskSpecService: () => ({ get: mocks.taskSpecGet }),
}));

import { SkillLifecycleService } from '../services/skill-lifecycle.service';

function skillRow(overrides: Partial<any> = {}): any {
  return {
    id: 'skill-1',
    slug: 'product-intro-md',
    name: 'product-intro-md',
    description: 'A demo skill.',
    status: 'draft',
    lifecycleStage: 'review',
    publishScope: 'private',
    ownerAgentId: 'agent-author',
    workspaceId: 'ws-1',
    publishedAt: null,
    license: 'MIT',
    author: 'agent-author',
    metadata: JSON.stringify({ skillJson: { sampleTasks: [], inputs: [], outputs: [] } }),
    contentManifest: '[]',
    contentManifestRevision: 'aaaa',
    requires: '{}',
    compatibility: '[]',
    version: '1.0.0',
    signals: '[]',
    sourceUrl: '',
    tags: '[]',
    ...overrides,
  };
}

describe('createBoilerplateTask projectId injection (G1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.iMSkill.findUnique.mockResolvedValue(skillRow());
    mocks.prisma.iMSkill.update.mockImplementation(async (args: any) => ({ ...skillRow(), ...args.data }));
    mocks.prisma.iMTask.create.mockResolvedValue({ id: 'task-tryout' });
    mocks.prisma.iMAsset.create.mockResolvedValue({ id: 'asset-readme' });
    mocks.prisma.iMWorkspaceFile.create.mockResolvedValue({ id: 'file-readme' });
    mocks.acceptanceApply.mockResolvedValue({ applied: true, templateId: 'tpl-skill-tryout' });
  });

  it('(a) sample task inherits workspace.metadata.defaultProjectId when set', async () => {
    // Owner lookup + metadata lookup share the same findUnique mock — return
    // a row that satisfies BOTH `select: { ownerImUserId: true }` and
    // `select: { metadata: true }` (extra fields are harmless on a Prisma
    // mock).
    mocks.prisma.iMWorkspace.findUnique.mockResolvedValue({
      ownerImUserId: 'owner-user',
      metadata: JSON.stringify({ defaultProjectId: 'p_default' }),
    });
    // Provide a value to prove findFirst is NOT preferred when metadata hits.
    mocks.prisma.iMProject.findFirst.mockResolvedValue({ id: 'p_should_not_be_used' });

    const svc = new SkillLifecycleService();
    await svc.publish('skill-1', { scope: 'workspace', actorId: 'reviewer-1', includeBoilerplateTask: true });

    const tryoutCalls = mocks.prisma.iMTask.create.mock.calls.filter(
      (c: any[]) => c[0]?.data?.capability === 'skill-tryout',
    );
    expect(tryoutCalls.length).toBe(1);
    expect(tryoutCalls[0][0].data.projectId).toBe('p_default');
    // metadata-hit path must skip the findFirst probe entirely.
    expect(mocks.prisma.iMProject.findFirst).not.toHaveBeenCalled();
  });

  it('(b) falls back to first active project when metadata has no defaultProjectId', async () => {
    mocks.prisma.iMWorkspace.findUnique.mockResolvedValue({
      ownerImUserId: 'owner-user',
      metadata: JSON.stringify({}),
    });
    mocks.prisma.iMProject.findFirst.mockResolvedValue({ id: 'p_first_active' });

    const svc = new SkillLifecycleService();
    await svc.publish('skill-1', { scope: 'workspace', actorId: 'reviewer-1', includeBoilerplateTask: true });

    const tryoutCalls = mocks.prisma.iMTask.create.mock.calls.filter(
      (c: any[]) => c[0]?.data?.capability === 'skill-tryout',
    );
    expect(tryoutCalls.length).toBe(1);
    expect(tryoutCalls[0][0].data.projectId).toBe('p_first_active');

    // Resolver must filter on (workspaceId, status='active') and prefer the
    // earliest createdAt — encode that contract so a regression in the
    // query shape trips this assertion.
    expect(mocks.prisma.iMProject.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: 'ws-1', status: 'active' },
        orderBy: { createdAt: 'asc' },
      }),
    );
  });

  it('(c) falls back to null when workspace has no active projects (backward compat)', async () => {
    mocks.prisma.iMWorkspace.findUnique.mockResolvedValue({
      ownerImUserId: 'owner-user',
      metadata: '{}',
    });
    mocks.prisma.iMProject.findFirst.mockResolvedValue(null);

    const svc = new SkillLifecycleService();
    await svc.publish('skill-1', { scope: 'workspace', actorId: 'reviewer-1', includeBoilerplateTask: true });

    const tryoutCalls = mocks.prisma.iMTask.create.mock.calls.filter(
      (c: any[]) => c[0]?.data?.capability === 'skill-tryout',
    );
    expect(tryoutCalls.length).toBe(1);
    // Explicit null (NOT undefined) — IMTask.projectId column is nullable
    // and `null` is the schema-legal "unscoped" value.
    expect(tryoutCalls[0][0].data.projectId).toBeNull();
  });
});
