/**
 * release201/08 S25 — `publish()` README/sample-task auto-gen + reviewer-guard.
 *
 * Covers:
 *  • README content shape (no TBD/TODO placeholders, contains required sections)
 *  • IMAsset write uses boundKind='workspace-file' + sourceKind='skill-readme'
 *    (library-files-panel default filter — release201/09 §9.4a)
 *  • IMAsset write supplies all required schema columns
 *    (workspaceId / contentHash / storageUri / kind)
 *  • `includeBoilerplateTask: false` skips sample task BUT still writes README
 *  • Reviewer ≠ ownerAgentId enforced at publish() and at promote(to='published')
 *  • VerifierDispatchService falls back to manual when criterion verifier
 *    equals skill.ownerAgentId (release201/08 §0.2.3 service-layer enforcement)
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
import { VerifierDispatchService } from '../services/verifier-dispatch.service';

function skillRow(overrides: Partial<any> = {}): any {
  return {
    id: 'skill-1',
    slug: 'demo-skill',
    name: 'Demo Skill',
    description: 'A demo skill that summarises documents into concise bullet points.',
    status: 'draft',
    lifecycleStage: 'review',
    publishScope: 'private',
    ownerAgentId: 'agent-owner',
    workspaceId: 'ws-1',
    publishedAt: null,
    license: 'MIT',
    author: 'agent-owner',
    metadata: JSON.stringify({
      skillJson: {
        sampleTasks: [{ title: 't1', prompt: 'p1', acceptanceCriteria: ['c1'] }],
        inputs: [{ name: 'document', type: 'string', required: true, description: 'source markdown' }],
        outputs: [{ name: 'summary', type: 'string', required: true, description: 'bullet list' }],
        security: { dataAccess: ['workspace.files.read'] },
        provenance: { authoredBy: 'agent-owner' },
      },
    }),
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

// ─────────────────────────────────────────────────────────────────────────
// README auto-gen
// ─────────────────────────────────────────────────────────────────────────

describe('SkillLifecycleService.publish — README auto-gen (S25)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.iMSkill.findUnique.mockResolvedValue(skillRow());
    mocks.prisma.iMSkill.update.mockImplementation(async (args: any) => ({ ...skillRow(), ...args.data }));
    mocks.prisma.iMTask.create.mockResolvedValue({ id: 'task-tryout' });
    mocks.prisma.iMWorkspace.findUnique.mockResolvedValue({ ownerImUserId: 'owner-user' });
    mocks.prisma.iMAsset.create.mockResolvedValue({ id: 'asset-readme' });
    mocks.prisma.iMWorkspaceFile.create.mockResolvedValue({ id: 'file-readme' });
    mocks.acceptanceApply.mockResolvedValue({ applied: true, templateId: 'tpl-skill-tryout' });
  });

  it('writes README IMAsset with boundKind=workspace-file + sourceKind=skill-readme', async () => {
    const svc = new SkillLifecycleService();
    await svc.publish('skill-1', { scope: 'workspace', actorId: 'reviewer-1', includeBoilerplateTask: true });

    expect(mocks.prisma.iMAsset.create).toHaveBeenCalledTimes(1);
    const assetCall = mocks.prisma.iMAsset.create.mock.calls[0][0].data;
    // §9.4a — workspace-file means it shows up under the Library default filter.
    expect(assetCall.boundKind).toBe('workspace-file');
    // sourceKind distinguishes auto-gen READMEs from user uploads.
    expect(assetCall.sourceKind).toBe('skill-readme');
    // Schema-required columns must all be populated.
    expect(assetCall.workspaceId).toBe('ws-1');
    expect(typeof assetCall.contentHash).toBe('string');
    expect(assetCall.contentHash.length).toBe(64); // sha256 hex
    expect(typeof assetCall.storageUri).toBe('string');
    expect(assetCall.storageUri.startsWith('inline-markdown://skill-readme/')).toBe(true);
    expect(assetCall.mime).toBe('text/markdown');
    expect(assetCall.kind).toBe('document');
    expect(assetCall.ingestStatus).toBe('ready');
  });

  it('writes IMWorkspaceFile bound to the README asset at skills/<slug>/README.md (v2.0.7.1 B7: no leading slash)', async () => {
    const svc = new SkillLifecycleService();
    await svc.publish('skill-1', { scope: 'workspace', actorId: 'reviewer-1', includeBoilerplateTask: true });

    expect(mocks.prisma.iMWorkspaceFile.create).toHaveBeenCalledTimes(1);
    const fileCall = mocks.prisma.iMWorkspaceFile.create.mock.calls[0][0].data;
    // v2.0.7.1 hotfix (B7): workspace-files normalizePath rejects leading '/'
    // so path is stored without leading slash to allow direct GET ?path= lookup.
    expect(fileCall.path).toBe('skills/demo-skill/README.md');
    expect(fileCall.assetId).toBe('asset-readme');
    expect(fileCall.workspaceId).toBe('ws-1');
  });

  it('README body contains required sections + zero TBD/TODO placeholders', async () => {
    const svc = new SkillLifecycleService();
    await svc.publish('skill-1', { scope: 'workspace', actorId: 'reviewer-1', includeBoilerplateTask: true });

    const assetCall = mocks.prisma.iMAsset.create.mock.calls[0][0].data;
    const meta = JSON.parse(assetCall.metadata);
    const body: string = meta.body;
    expect(body).toContain('# Demo Skill');
    expect(body).toContain('## What it does');
    expect(body).toContain('## Install');
    expect(body).toContain('cloud skill install demo-skill');
    expect(body).toContain('## Inputs / Outputs');
    expect(body).toContain('## Sample tasks');
    expect(body).toContain('## Security');
    expect(body).toContain('workspace.files.read');
    // Forbidden placeholders (release201/08 — README must not ship TBD/TODO).
    expect(body).not.toMatch(/\bTBD\b/);
    expect(body).not.toMatch(/\bTODO\b/);
  });

  it('skips boilerplate sample task when includeBoilerplateTask=false but still writes README', async () => {
    const svc = new SkillLifecycleService();
    const out = await svc.publish('skill-1', {
      scope: 'workspace',
      actorId: 'reviewer-1',
      includeBoilerplateTask: false,
    });
    expect(out.sampleTaskId).toBeUndefined();
    expect(out.readmeFileId).toBeUndefined(); // README is gated by the same flag
    // No tryout task created.
    const tryoutCalls = mocks.prisma.iMTask.create.mock.calls.filter(
      (c: any[]) => c[0]?.data?.capability === 'skill-tryout',
    );
    expect(tryoutCalls.length).toBe(0);
  });

  it('README soft-fails if asset write throws (publish still succeeds)', async () => {
    mocks.prisma.iMAsset.create.mockRejectedValueOnce(new Error('asset store unreachable'));
    const svc = new SkillLifecycleService();
    const out = await svc.publish('skill-1', {
      scope: 'workspace',
      actorId: 'reviewer-1',
      includeBoilerplateTask: true,
    });
    expect(out.skill.publishScope).toBe('workspace');
    expect(out.sampleTaskId).toBe('task-tryout'); // sample task still created
    expect(out.readmeFileId).toBeUndefined(); // README soft-failed
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Reviewer ≠ ownerAgentId enforcement (§0.2.3)
// ─────────────────────────────────────────────────────────────────────────

describe('SkillLifecycleService — Reviewer ≠ ownerAgentId enforcement (S25)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.iMTask.create.mockResolvedValue({ id: 'task-x' });
    mocks.prisma.iMWorkspace.findUnique.mockResolvedValue({ ownerImUserId: 'owner-user' });
    mocks.prisma.iMAsset.create.mockResolvedValue({ id: 'asset-1' });
    mocks.prisma.iMWorkspaceFile.create.mockResolvedValue({ id: 'file-1' });
    mocks.acceptanceApply.mockResolvedValue({ applied: true, templateId: 'tpl' });
  });

  it('publish() rejects when actorId === ownerAgentId (self-review block)', async () => {
    mocks.prisma.iMSkill.findUnique.mockResolvedValue(skillRow({ ownerAgentId: 'agent-A' }));
    const svc = new SkillLifecycleService();
    await expect(svc.publish('skill-1', { scope: 'workspace', actorId: 'agent-A' })).rejects.toMatchObject({
      code: 'self_review',
      statusCode: 403,
    });
  });

  it('promote(to=published) rejects when actorId === ownerAgentId', async () => {
    mocks.prisma.iMSkill.findUnique.mockResolvedValue(skillRow({ ownerAgentId: 'agent-A', lifecycleStage: 'review' }));
    const svc = new SkillLifecycleService();
    await expect(svc.promote('skill-1', { to: 'published', actorId: 'agent-A' })).rejects.toMatchObject({
      code: 'self_review',
      statusCode: 403,
    });
  });

  it('publish() succeeds when actor differs from ownerAgentId', async () => {
    mocks.prisma.iMSkill.findUnique.mockResolvedValue(skillRow({ ownerAgentId: 'agent-A' }));
    mocks.prisma.iMSkill.update.mockImplementation(async (args: any) => ({
      ...skillRow({ ownerAgentId: 'agent-A' }),
      ...args.data,
    }));
    const svc = new SkillLifecycleService();
    const out = await svc.publish('skill-1', { scope: 'workspace', actorId: 'reviewer-B' });
    expect(out.skill.publishScope).toBe('workspace');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// VerifierDispatchService self-review fallback (§0.2.3)
// ─────────────────────────────────────────────────────────────────────────

describe('VerifierDispatchService — self-review fallback to manual (S25)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.taskSpecGet.mockResolvedValue({ markdown: '## Goal\n...', revision: 1, updatedAt: null });
  });

  it('falls back to manual when verifierAgentId equals skill.ownerAgentId', async () => {
    const taskId = 'task-skill-review';
    mocks.prisma.iMTask.findUnique.mockResolvedValue({
      id: taskId,
      title: 'Review skill demo-skill',
      workspaceId: 'ws-1',
      creatorId: 'orchestrator-1',
      assigneeId: 'owner-user',
      capability: 'skill-review',
      metadata: JSON.stringify({ skillId: 'skill-1' }),
    });
    mocks.prisma.iMSkill.findUnique.mockResolvedValue({ ownerAgentId: 'agent-author' });
    mocks.acceptanceGet.mockResolvedValue({
      criteria: [
        {
          id: 'c-1',
          verifyMode: 'qualitative',
          expectation: 'manifest looks sane',
          verifierAgentId: 'agent-author', // ⚠ same as ownerAgentId → must be blocked
          status: 'pending',
        },
        {
          id: 'c-2',
          verifyMode: 'qualitative',
          expectation: 'README clearly described',
          verifierAgentId: 'agent-reviewer', // distinct → must dispatch
          status: 'pending',
        },
      ],
    });

    const svc = new VerifierDispatchService();
    const out = await svc.dispatchVerifyRequest(taskId);
    expect(out.dispatched).toBe(1);
    expect(out.fallbackToManual).toBe(1);
    const c1 = out.perCriterion.find((c) => c.criterionId === 'c-1');
    const c2 = out.perCriterion.find((c) => c.criterionId === 'c-2');
    expect(c1?.result).toBe('manual-fallback');
    expect(c1?.targetAgentId).toBeNull();
    expect(c2?.result).toBe('dispatched');
    expect(c2?.targetAgentId).toBe('agent-reviewer');
  });

  it('dispatches normally when task has no skillId metadata (not a skill lifecycle task)', async () => {
    mocks.prisma.iMTask.findUnique.mockResolvedValue({
      id: 'task-generic',
      title: 'Generic task',
      workspaceId: 'ws-1',
      creatorId: 'creator-1',
      assigneeId: 'assignee-1',
      capability: 'doc-write',
      metadata: JSON.stringify({}),
    });
    mocks.prisma.iMSkill.findUnique.mockResolvedValue(null);
    mocks.acceptanceGet.mockResolvedValue({
      criteria: [
        {
          id: 'c-1',
          verifyMode: 'qualitative',
          expectation: 'looks good',
          verifierAgentId: 'agent-author',
          status: 'pending',
        },
      ],
    });

    const svc = new VerifierDispatchService();
    const out = await svc.dispatchVerifyRequest('task-generic');
    // No skill linkage → no self-review check; the dispatch proceeds.
    expect(out.dispatched).toBe(1);
    expect(out.fallbackToManual).toBe(0);
  });

  it('dryRunDispatch applies the same self-review check', async () => {
    mocks.prisma.iMTask.findUnique.mockResolvedValue({
      creatorId: 'orchestrator-1',
      metadata: JSON.stringify({ skillId: 'skill-1' }),
    });
    mocks.prisma.iMSkill.findUnique.mockResolvedValue({ ownerAgentId: 'agent-author' });
    mocks.acceptanceGet.mockResolvedValue({
      criteria: [
        {
          id: 'c-1',
          verifyMode: 'quantitative',
          expectation: 'pass rate ≥ 0.8',
          verifierAgentId: 'agent-author',
          status: 'pending',
        },
      ],
    });

    const svc = new VerifierDispatchService();
    const out = await svc.dryRunDispatch('task-x');
    expect(out.fallbackToManual).toBe(1);
    expect(out.perCriterion[0].result).toBe('manual-fallback');
  });
});
