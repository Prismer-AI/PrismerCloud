/**
 * release201/07 — skill-authoring engine unit tests.
 *
 * Covers:
 *   • 7 validation gates (manifest / frontmatter / package / requires / security / sample / runtime)
 *   • createDraft happy path (writes IMSkill row + creates skill-review task)
 *   • slug uniqueness conflict (409)
 *   • ownerAgent ↔ workspace cross-table guard (403)
 *   • patchDraft & regenerateDraft revision history
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prisma: {
    iMSkill: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    iMAgentProfile: {
      findFirst: vi.fn(),
    },
    iMWorkspace: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
    iMTask: {
      create: vi.fn(),
    },
    // release201/07 S24 — gate-7 fire-and-forget smoke writes an
    // IMSkillEvalRun row (status='queued'). Mock the create call so the
    // background setImmediate path doesn't crash unit tests.
    iMSkillEvalRun: {
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

import { SkillDraftService, SkillDraftError } from '../services/skill-draft.service';
import { buildManifest } from '../skills/manifest';

const goodSkillMd = `---
name: scrape-openclaw-tools
description: Scrape the OpenClaw tools catalog from the public docs site and bundle a JSON snapshot. Use whenever the user asks to mirror or audit the OpenClaw tool catalog.
license: MIT
---

# Scrape OpenClaw Tools

Workflow body here.

## Pipeline

1. Fetch the docs URL.
2. Parse the tool table.
3. Emit a JSON snapshot.
`;

const goodSkillJson = {
  schemaVersion: 1,
  slug: 'scrape-openclaw-tools',
  name: 'Scrape OpenClaw Tools',
  description: 'Scrape the OpenClaw tools catalog from the public docs site and bundle a JSON snapshot.',
  category: 'workflow',
  version: '0.1.0',
  license: 'MIT',
  compatibility: ['prismer-sdk'],
  runtime: {
    kind: 'text-workflow',
    requires: { capabilities: ['prismer.skill.draft.create'] },
  },
  inputs: [],
  outputs: [],
  sampleTasks: [
    {
      title: 'mirror openclaw catalog',
      prompt: 'Run the workflow against https://docs.openclaw.ai',
      acceptanceCriteria: ['JSON snapshot saved as references/openclaw-tools.json'],
    },
  ],
  security: {
    dataAccess: ['external-network'],
    humanApprovalRequiredFor: ['HTTP fetches to non-public hosts'],
  },
  provenance: {
    sourceKind: 'doc-url',
    sourceRefs: ['https://docs.openclaw.ai/skills/index'],
    authoredBy: 'agent-test',
    authoredAt: '2026-05-26T00:00:00Z',
  },
};

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

async function makeGoodInput(overrides: any = {}): Promise<any> {
  return {
    slug: 'scrape-openclaw-tools',
    name: 'Scrape OpenClaw Tools',
    description: 'Scrape OpenClaw catalog and bundle a JSON snapshot suitable for downstream consumers.',
    workspaceId: 'ws-1',
    ownerAgentId: 'agent-1',
    files: [
      { path: 'SKILL.md', content: goodSkillMd },
      { path: 'skill.json', content: JSON.stringify(goodSkillJson) },
    ],
    metadata: {
      authoring: {
        sourceKind: 'doc-url',
        sourceRefs: ['https://docs.openclaw.ai/skills/index'],
        sessionId: 'sess-1',
      },
    },
    ...overrides,
  };
}

describe('SkillDraftService.createDraft', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // default: no slug conflict; ownerAgent has a profile in the workspace
    mocks.prisma.iMSkill.findUnique.mockResolvedValue(null);
    mocks.prisma.iMAgentProfile.findFirst.mockResolvedValue({ id: 'profile-1' });
    mocks.prisma.iMWorkspace.findUnique.mockResolvedValue({ ownerImUserId: 'owner-1' });
    mocks.prisma.iMTask.create.mockResolvedValue({ id: 'task-1' });
    mocks.prisma.iMSkill.create.mockImplementation(async (args: any) => ({
      id: 'skill-1',
      ...args.data,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    // S13 P0-2: applyDefaultTemplateOnCreate returns "applied" so tests can
    // verify the call was made AND infer the resulting criteria via the spy.
    mocks.acceptanceApply.mockResolvedValue({ applied: true, templateId: 'tpl-skill-review' });
    // S24 gate-7: smoke writes to iMSkillEvalRun + refetches the IMSkill row
    // for SSE recipient resolution. Default to "no daemon" so the smoke
    // queues without crashing.
    mocks.prisma.iMSkillEvalRun.create.mockResolvedValue({ id: 'gate7-run-1' });
  });

  it('happy path: writes IMSkill row + creates skill-review task', async () => {
    const svc = new SkillDraftService();
    const result = await svc.createDraft(await makeGoodInput());

    expect(result.id).toBe('skill-1');
    expect(result.slug).toBe('scrape-openclaw-tools');
    expect(result.manifestRevision).toMatch(/^[0-9a-f]{64}$/);
    expect(result.reviewTaskId).toBe('task-1');

    const createCall = mocks.prisma.iMSkill.create.mock.calls[0][0];
    expect(createCall.data.status).toBe('draft');
    expect(createCall.data.source).toBe('community');
    expect(createCall.data.workspaceId).toBe('ws-1');
    expect(createCall.data.ownerAgentId).toBe('agent-1');
    expect(createCall.data.license).toBe('MIT');
    expect(JSON.parse(createCall.data.compatibility)).toEqual(['prismer-sdk']);
    expect(JSON.parse(createCall.data.requires)).toEqual({ capabilities: ['prismer.skill.draft.create'] });
    expect(createCall.data.contentManifest).toBeTruthy();
    expect(createCall.data.contentManifestRevision).toBe(result.manifestRevision);

    const taskCall = mocks.prisma.iMTask.create.mock.calls[0][0];
    expect(taskCall.data.capability).toBe('skill-review');
    expect(taskCall.data.assigneeId).toBe('owner-1');
    expect(taskCall.data.workspaceId).toBe('ws-1');
  });

  // release201 S13 P0-2 — skill-review task must carry the default
  // acceptance template so the reviewer sees the §10 3-criterion checklist.
  it('P0-2: applies the default skill-review acceptance template on the auto-created task', async () => {
    const svc = new SkillDraftService();
    await svc.createDraft(await makeGoodInput());

    expect(mocks.acceptanceApply).toHaveBeenCalledTimes(1);
    const [taskId, capability, workspaceId, actorId] = mocks.acceptanceApply.mock.calls[0];
    expect(taskId).toBe('task-1');
    expect(capability).toBe('skill-review');
    expect(workspaceId).toBe('ws-1');
    expect(actorId).toBe('agent-1');
  });

  // release201 S13 P0-4 — skill-draft must emit the 3 metric points so
  // Insights / dashboards can query draft activity.
  it('P0-4: emits skill.draft.created + skill.draft.review_assigned metrics', async () => {
    const svc = new SkillDraftService();
    await svc.createDraft(await makeGoodInput());

    const calls = mocks.metricEmit.mock.calls.map((c) => c[0]);
    const names = calls.map((c) => `${c.namespace}.${c.name}`);
    expect(names).toContain('skill.draft.created');
    expect(names).toContain('skill.draft.review_assigned');

    const created = calls.find((c) => c.namespace === 'skill.draft' && c.name === 'created');
    expect(created).toBeTruthy();
    expect(created!.value).toBe(1);
    expect(created!.dims.workspaceId).toBe('ws-1');
    expect(created!.dims.skillId).toBe('skill-1');
    // doc-url is the sourceKind from goodSkillJson.provenance
    expect(created!.dims.sourceKind).toBe('doc-url');

    const assigned = calls.find((c) => c.namespace === 'skill.draft' && c.name === 'review_assigned');
    expect(assigned).toBeTruthy();
    expect(assigned!.value).toBe(1);
    expect(assigned!.dims.workspaceId).toBe('ws-1');
    expect(assigned!.dims.skillId).toBe('skill-1');
    expect(assigned!.dims.reviewerUserId).toBe('owner-1');
  });

  it('Gate 1 (manifest): rejects when manifest cannot reconstruct merkle (impossible via API path but defensive)', async () => {
    // The buildManifest helper guarantees correctness; this test verifies the
    // gate is wired by recomputing on the buildManifest output.
    const svc = new SkillDraftService();
    const result = await svc.createDraft(await makeGoodInput());
    // recompute merkle from the on-disk files and ensure it matches.
    const manifest = await buildManifest([
      { path: 'SKILL.md', bytes: Buffer.from(goodSkillMd, 'utf8') },
      { path: 'skill.json', bytes: Buffer.from(JSON.stringify(goodSkillJson), 'utf8') },
    ]);
    expect(result.manifestRevision).toBe(manifest.revision);
  });

  it('Gate 2 (frontmatter): rejects when name missing', async () => {
    const svc = new SkillDraftService();
    const badSkillMd =
      '---\ndescription: a description that is long enough to pass the gate easily and provide trigger context.\n---\n\n# Body\n';
    const input = await makeGoodInput({
      files: [
        { path: 'SKILL.md', content: badSkillMd },
        { path: 'skill.json', content: JSON.stringify(goodSkillJson) },
      ],
    });
    await expect(svc.createDraft(input)).rejects.toMatchObject({
      statusCode: 400,
      gate: 'frontmatter',
    });
  });

  it('Gate 2 (frontmatter): rejects when description < 50 chars', async () => {
    const svc = new SkillDraftService();
    const shortDesc = '---\nname: scrape-openclaw-tools\ndescription: too short\n---\n\n# Body\n';
    const input = await makeGoodInput({
      files: [
        { path: 'SKILL.md', content: shortDesc },
        { path: 'skill.json', content: JSON.stringify(goodSkillJson) },
      ],
    });
    await expect(svc.createDraft(input)).rejects.toMatchObject({
      statusCode: 400,
      gate: 'frontmatter',
    });
  });

  it('Gate 3 (package): rejects when files[0] is not SKILL.md', async () => {
    const svc = new SkillDraftService();
    const input = await makeGoodInput({
      files: [
        { path: 'skill.json', content: JSON.stringify(goodSkillJson) },
        { path: 'SKILL.md', content: goodSkillMd },
      ],
    });
    await expect(svc.createDraft(input)).rejects.toMatchObject({
      statusCode: 400,
      gate: 'package',
    });
  });

  it('Gate 3 (package): rejects when files[1] is not skill.json', async () => {
    const svc = new SkillDraftService();
    const input = await makeGoodInput({
      files: [
        { path: 'SKILL.md', content: goodSkillMd },
        { path: 'references/other.md', content: 'random' },
        { path: 'skill.json', content: JSON.stringify(goodSkillJson) },
      ],
    });
    await expect(svc.createDraft(input)).rejects.toMatchObject({
      statusCode: 400,
      gate: 'package',
    });
  });

  it('Gate 3 (package): rejects when skill.json has invalid JSON', async () => {
    const svc = new SkillDraftService();
    const input = await makeGoodInput({
      files: [
        { path: 'SKILL.md', content: goodSkillMd },
        { path: 'skill.json', content: '{ not json }' },
      ],
    });
    await expect(svc.createDraft(input)).rejects.toMatchObject({
      statusCode: 400,
      gate: 'package',
    });
  });

  it('Gate 5 (security): rejects when dataAccess is empty', async () => {
    const svc = new SkillDraftService();
    const badSkillJson = {
      ...goodSkillJson,
      security: { dataAccess: [], humanApprovalRequiredFor: [] },
    };
    const input = await makeGoodInput({
      files: [
        { path: 'SKILL.md', content: goodSkillMd },
        { path: 'skill.json', content: JSON.stringify(badSkillJson) },
      ],
    });
    await expect(svc.createDraft(input)).rejects.toMatchObject({
      statusCode: 400,
      gate: 'security',
    });
  });

  it('Gate 5 (security): rejects when sensitive scope lacks humanApprovalRequiredFor', async () => {
    const svc = new SkillDraftService();
    const badSkillJson = {
      ...goodSkillJson,
      security: { dataAccess: ['secrets'], humanApprovalRequiredFor: [] },
    };
    const input = await makeGoodInput({
      files: [
        { path: 'SKILL.md', content: goodSkillMd },
        { path: 'skill.json', content: JSON.stringify(badSkillJson) },
      ],
    });
    await expect(svc.createDraft(input)).rejects.toMatchObject({
      statusCode: 400,
      gate: 'security',
    });
  });

  it('Gate 4 (requires): warns but does not block when runtime.requires is empty', async () => {
    const svc = new SkillDraftService();
    const sj = {
      ...goodSkillJson,
      runtime: { kind: 'text-workflow', requires: {} },
    };
    const input = await makeGoodInput({
      files: [
        { path: 'SKILL.md', content: goodSkillMd },
        { path: 'skill.json', content: JSON.stringify(sj) },
      ],
    });
    const result = await svc.createDraft(input);
    expect(result.id).toBe('skill-1');
    expect(result.validationWarnings.some((w) => w.gate === 'requires')).toBe(true);
  });

  it('Gate 6 (sample): warns but does not block when sampleTasks is empty', async () => {
    const svc = new SkillDraftService();
    const sj = { ...goodSkillJson, sampleTasks: [] };
    const input = await makeGoodInput({
      files: [
        { path: 'SKILL.md', content: goodSkillMd },
        { path: 'skill.json', content: JSON.stringify(sj) },
      ],
    });
    const result = await svc.createDraft(input);
    expect(result.id).toBe('skill-1');
    expect(result.validationWarnings.some((w) => w.gate === 'sample')).toBe(true);
  });

  it('rejects slug collision (409) — even when existing row is in draft status', async () => {
    mocks.prisma.iMSkill.findUnique.mockResolvedValue({ id: 'existing', status: 'draft' });
    const svc = new SkillDraftService();
    await expect(svc.createDraft(await makeGoodInput())).rejects.toMatchObject({ statusCode: 409 });
  });

  it('rejects when ownerAgent does not belong to the workspace (403)', async () => {
    mocks.prisma.iMAgentProfile.findFirst.mockResolvedValue(null);
    mocks.prisma.iMWorkspace.findFirst.mockResolvedValue(null);
    const svc = new SkillDraftService();
    await expect(svc.createDraft(await makeGoodInput())).rejects.toMatchObject({ statusCode: 403 });
  });

  it('rejects slug not matching ^[a-z][a-z0-9-]*$', async () => {
    const svc = new SkillDraftService();
    await expect(svc.createDraft(await makeGoodInput({ slug: 'Bad_Slug' }))).rejects.toMatchObject({
      statusCode: 400,
      gate: 'package',
    });
  });

  it('cross-checks skill.json.slug against top-level slug', async () => {
    const svc = new SkillDraftService();
    const input = await makeGoodInput({
      slug: 'different-slug',
      files: [
        { path: 'SKILL.md', content: goodSkillMd },
        { path: 'skill.json', content: JSON.stringify(goodSkillJson) },
      ],
    });
    await expect(svc.createDraft(input)).rejects.toMatchObject({
      statusCode: 400,
      gate: 'package',
    });
  });
});

describe('SkillDraftService.patchDraft', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('patches an existing draft and appends to revision history', async () => {
    const existingManifest = JSON.stringify([
      {
        path: 'SKILL.md',
        size: goodSkillMd.length,
        sha256: 'aaaa',
        inline: true,
        content: b64(goodSkillMd),
      },
      {
        path: 'skill.json',
        size: 200,
        sha256: 'bbbb',
        inline: true,
        content: b64(JSON.stringify(goodSkillJson)),
      },
    ]);
    mocks.prisma.iMSkill.findUnique.mockResolvedValue({
      id: 'skill-1',
      slug: 'scrape-openclaw-tools',
      status: 'draft',
      ownerAgentId: 'agent-1',
      workspaceId: 'ws-1',
      contentManifest: existingManifest,
      contentManifestRevision: 'oldrev',
      metadata: '{}',
    });
    mocks.prisma.iMSkill.update.mockResolvedValue({ id: 'skill-1' });

    const svc = new SkillDraftService();
    const result = await svc.patchDraft('skill-1', 'agent-1', {
      files: [{ path: 'references/notes.md', op: 'add', content: 'extra reference text' }],
      reason: 'add reference',
    });
    expect(result.id).toBe('skill-1');
    expect(result.manifestRevision).toMatch(/^[0-9a-f]{64}$/);

    const updateCall = mocks.prisma.iMSkill.update.mock.calls[0][0];
    const updatedMeta = JSON.parse(updateCall.data.metadata);
    expect(updatedMeta.authoring.draftRevisionHistory).toHaveLength(1);
    expect(updatedMeta.authoring.draftRevisionHistory[0]).toMatchObject({
      reason: 'add reference',
      regenerated: false,
    });
  });

  it('rejects patch when status is not draft', async () => {
    mocks.prisma.iMSkill.findUnique.mockResolvedValue({
      id: 'skill-1',
      status: 'active',
      ownerAgentId: 'agent-1',
    });
    const svc = new SkillDraftService();
    await expect(
      svc.patchDraft('skill-1', 'agent-1', { files: [{ path: 'foo.md', op: 'add', content: 'x' }] }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('rejects patch by non-owner non-workspace-owner (403)', async () => {
    mocks.prisma.iMSkill.findUnique.mockResolvedValue({
      id: 'skill-1',
      status: 'draft',
      ownerAgentId: 'agent-1',
      workspaceId: 'ws-1',
      contentManifest: '[]',
      contentManifestRevision: 'old',
      metadata: '{}',
    });
    mocks.prisma.iMWorkspace.findFirst.mockResolvedValue(null);
    const svc = new SkillDraftService();
    await expect(
      svc.patchDraft('skill-1', 'someone-else', { files: [{ path: 'foo.md', op: 'add', content: 'x' }] }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('SkillDraftService.regenerateDraft', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('appends regenerate record to history and returns sessionId', async () => {
    mocks.prisma.iMSkill.findUnique.mockResolvedValue({
      id: 'skill-1',
      status: 'draft',
      ownerAgentId: 'agent-1',
      workspaceId: 'ws-1',
      metadata: '{"authoring":{"draftRevisionHistory":[]}}',
      contentManifestRevision: 'rev1',
    });
    mocks.prisma.iMSkill.update.mockResolvedValue({ id: 'skill-1' });

    const svc = new SkillDraftService();
    const result = await svc.regenerateDraft('skill-1', 'agent-1', {
      reason: 'user feedback: simplify scripts',
    });

    expect(result.sessionId).toMatch(/^regen-/);
    const updateCall = mocks.prisma.iMSkill.update.mock.calls[0][0];
    const meta = JSON.parse(updateCall.data.metadata);
    expect(meta.authoring.draftRevisionHistory[0]).toMatchObject({
      regenerated: true,
      reason: 'user feedback: simplify scripts',
    });
  });

  // release201 S13 P0-4 — regenerate must emit skill.draft.regenerated.
  it('P0-4: emits skill.draft.regenerated on each regenerate call', async () => {
    mocks.prisma.iMSkill.findUnique.mockResolvedValue({
      id: 'skill-1',
      status: 'draft',
      ownerAgentId: 'agent-1',
      workspaceId: 'ws-1',
      metadata: '{"authoring":{"draftRevisionHistory":[]}}',
      contentManifestRevision: 'rev1',
    });
    mocks.prisma.iMSkill.update.mockResolvedValue({ id: 'skill-1' });

    const svc = new SkillDraftService();
    await svc.regenerateDraft('skill-1', 'agent-1', { reason: 'eval failed' });

    const regen = mocks.metricEmit.mock.calls
      .map((c) => c[0])
      .find((c) => c.namespace === 'skill.draft' && c.name === 'regenerated');
    expect(regen).toBeTruthy();
    expect(regen!.value).toBe(1);
    expect(regen!.dims.workspaceId).toBe('ws-1');
    expect(regen!.dims.skillId).toBe('skill-1');
    expect(regen!.dims.reason).toBe('eval failed');
  });
});

describe('SkillDraftService.listDrafts + getDraft', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('listDrafts filters by workspaceId and status=draft', async () => {
    mocks.prisma.iMSkill.findMany.mockResolvedValue([{ id: 's1', slug: 'a', name: 'A', updatedAt: new Date() }]);
    const svc = new SkillDraftService();
    const out = await svc.listDrafts('ws-1');
    expect(out).toHaveLength(1);
    expect(mocks.prisma.iMSkill.findMany.mock.calls[0][0].where).toMatchObject({
      workspaceId: 'ws-1',
      status: 'draft',
    });
  });

  it('getDraft returns null when status is not draft', async () => {
    mocks.prisma.iMSkill.findUnique.mockResolvedValue({
      id: 's1',
      status: 'active',
      metadata: '{}',
      contentManifest: '[]',
    });
    const svc = new SkillDraftService();
    expect(await svc.getDraft('s1')).toBeNull();
  });

  it('getDraft returns parsed detail for a draft', async () => {
    mocks.prisma.iMSkill.findUnique.mockResolvedValue({
      id: 's1',
      slug: 'a',
      name: 'A',
      description: 'd',
      status: 'draft',
      workspaceId: 'ws-1',
      ownerAgentId: 'agent-1',
      contentManifest: JSON.stringify([{ path: 'SKILL.md', size: 10, sha256: 'h', inline: true, content: 'YQ==' }]),
      contentManifestRevision: 'rev',
      license: 'MIT',
      compatibility: JSON.stringify(['prismer-sdk']),
      requires: '{"env":["FOO"]}',
      executableJson: { kind: 'cli' },
      metadata: '{"authoring":{}}',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const svc = new SkillDraftService();
    const out = await svc.getDraft('s1');
    expect(out?.id).toBe('s1');
    expect(out?.files).toHaveLength(1);
    expect(out?.compatibility).toEqual(['prismer-sdk']);
    expect(out?.requires).toEqual({ env: ['FOO'] });
  });
});

describe('SkillDraftError shape', () => {
  it('exposes statusCode and gate', () => {
    const e = new SkillDraftError('boom', 400, 'package');
    expect(e.statusCode).toBe(400);
    expect(e.gate).toBe('package');
  });
});

// release201/07 §2.7 S24 — gate-7 (runtime sandbox smoke) is warn-level and
// fire-and-forget. It MUST NOT block createDraft and MUST NOT promote
// draft→eval. These tests pin the contract.
describe('SkillDraftService gate-7 (runtime sandbox smoke)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.iMSkill.findUnique.mockResolvedValue(null);
    mocks.prisma.iMAgentProfile.findFirst.mockResolvedValue({ id: 'profile-1' });
    mocks.prisma.iMWorkspace.findUnique.mockResolvedValue({ ownerImUserId: 'owner-1' });
    mocks.prisma.iMTask.create.mockResolvedValue({ id: 'task-1' });
    mocks.prisma.iMSkill.create.mockImplementation(async (args: any) => ({
      id: 'skill-1',
      ...args.data,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    mocks.acceptanceApply.mockResolvedValue({ applied: true, templateId: 'tpl-skill-review' });
    mocks.prisma.iMSkillEvalRun.create.mockResolvedValue({ id: 'gate7-run-1' });
  });

  /**
   * Helper — wait until the next macrotask tick. setImmediate inside
   * createDraft means the smoke runs AFTER createDraft has returned; tests
   * need to flush the microtask queue + one tick to observe the smoke's
   * side-effects.
   */
  async function flushSmoke(): Promise<void> {
    // Two ticks: one for setImmediate to fire, one for the smoke's async
    // chain (findUnique → eval-run create → metadata update).
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
  }

  it('createDraft returns immediately without waiting for gate-7 smoke', async () => {
    const svc = new SkillDraftService();
    const t0 = Date.now();
    const result = await svc.createDraft(await makeGoodInput());
    const elapsed = Date.now() - t0;
    // The smoke MUST not block the response (release201/07 §2.7 warn-level).
    expect(result.id).toBe('skill-1');
    expect(elapsed).toBeLessThan(500); // generous; smoke would add seconds
  });

  it('gate-7 is warn-level: createDraft succeeds even when smoke enqueue would fail', async () => {
    mocks.prisma.iMSkillEvalRun.create.mockRejectedValue(new Error('eval table unavailable'));
    const svc = new SkillDraftService();
    // Should NOT throw even though the background smoke errors.
    const result = await svc.createDraft(await makeGoodInput());
    expect(result.id).toBe('skill-1');
    await flushSmoke();
  });

  it('gate-7 enqueues IMSkillEvalRun with smoke=true tag + sampleTasks[0]', async () => {
    // findUnique is called twice during the flow: first by createDraft
    // (slug uniqueness check — null), then by runGate7Smoke (refetch the
    // persisted row for SSE recipient resolution). Sequence them.
    mocks.prisma.iMSkill.findUnique
      .mockResolvedValueOnce(null) // slug uniqueness pre-flight
      .mockResolvedValue({
        id: 'skill-1',
        slug: 'scrape-openclaw-tools',
        workspaceId: 'ws-1',
        ownerAgentId: 'agent-1',
        metadata: '{}',
      });

    const svc = new SkillDraftService();
    await svc.createDraft(await makeGoodInput());
    await flushSmoke();

    expect(mocks.prisma.iMSkillEvalRun.create).toHaveBeenCalledTimes(1);
    const call = mocks.prisma.iMSkillEvalRun.create.mock.calls[0][0];
    expect(call.data.skillId).toBe('skill-1');
    expect(call.data.status).toBe('queued');
    const parsed = JSON.parse(call.data.testCasesJson);
    expect(parsed.smoke).toBe(true);
    expect(parsed.origin).toBe('release201/07 gate-7');
    expect(parsed.allowlistBuiltins).toEqual(['tasks', 'memory']);
    expect(parsed.testCases).toHaveLength(1);
    // sampleTasks[0] from goodSkillJson — first sample's prompt is the smoke
    // test input.
    expect(parsed.testCases[0].input).toBe('Run the workflow against https://docs.openclaw.ai');
  });

  it('gate-7 does NOT promote draft → eval (lifecycleStage stays draft)', async () => {
    // If gate-7 ever called startEvalRun, it would promote draft → eval via
    // SkillLifecycleService.promote. We verify by ensuring iMSkill.update is
    // NOT called with lifecycleStage='eval' from the smoke path.
    mocks.prisma.iMSkill.findUnique.mockResolvedValueOnce(null).mockResolvedValue({
      id: 'skill-1',
      slug: 'scrape-openclaw-tools',
      workspaceId: 'ws-1',
      ownerAgentId: 'agent-1',
      metadata: '{}',
    });

    const svc = new SkillDraftService();
    await svc.createDraft(await makeGoodInput());
    await flushSmoke();

    // appendGate7Warning calls iMSkill.update with metadata only; ensure no
    // call ever sets lifecycleStage='eval' or status='active'.
    for (const call of mocks.prisma.iMSkill.update.mock.calls) {
      const data = call[0].data;
      expect(data.lifecycleStage).not.toBe('eval');
      expect(data.status).not.toBe('active');
    }
  });

  it('gate-7 short-circuits with warning when skill.json.sampleTasks is empty', async () => {
    const noSampleSkillJson = { ...goodSkillJson, sampleTasks: [] };
    mocks.prisma.iMSkill.findUnique.mockResolvedValueOnce(null).mockResolvedValue({
      id: 'skill-1',
      slug: 'scrape-openclaw-tools',
      workspaceId: 'ws-1',
      ownerAgentId: 'agent-1',
      metadata: '{}',
    });

    const svc = new SkillDraftService();
    const result = await svc.createDraft(
      await makeGoodInput({
        files: [
          { path: 'SKILL.md', content: goodSkillMd },
          { path: 'skill.json', content: JSON.stringify(noSampleSkillJson) },
        ],
      }),
    );
    await flushSmoke();

    expect(result.id).toBe('skill-1');
    // No IMSkillEvalRun row when there's no sample to smoke against.
    expect(mocks.prisma.iMSkillEvalRun.create).not.toHaveBeenCalled();
    // The synchronous gate-6 (sample) warning + the gate-7 (runtime) skip
    // warning both surface — verify at least one runtime warning landed.
    const updateCalls = mocks.prisma.iMSkill.update.mock.calls;
    const sawRuntimeWarning = updateCalls.some((c: any) => {
      try {
        const meta = JSON.parse(c[0].data.metadata || '{}');
        const ws: any[] = Array.isArray(meta.validationWarnings) ? meta.validationWarnings : [];
        return ws.some((w) => w.gate === 'runtime');
      } catch {
        return false;
      }
    });
    expect(sawRuntimeWarning).toBe(true);
  });
});
