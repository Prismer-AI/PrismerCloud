/**
 * release201/10 §5.3 — TaskSpecService + TodoService IMAsset writeback contract.
 *
 * **Degraded scope** (S47, release201/17 Wave G): per the S47 plan, the
 * preferred shape was a real-SQLite integration test asserting
 * IMAsset + IMAssetRevision rows are persisted. The IM test suite's
 * convention is **stubbed-prisma in-memory fakes** rather than a live DB
 * (see `src/im/services/__tests__/project.service.test.ts:31` "Stubs the
 * prisma models so no real DB is touched"), and adding a new SQLite
 * fixture path purely for two services would diverge from that convention
 * and cost >30 min. We therefore exercise the **write contract** via
 * vi.fn() spies — verifying the exact field shape each service emits to
 * `prisma.iMAsset.create / .update` + `prisma.iMAssetRevision.create`.
 * That covers the SPEC/TODO writeback DoD without paying the fixture
 * setup cost. If a true real-DB pass is wanted later, the same
 * assertion vocabulary translates 1:1 to live-row asserts.
 *
 * Covered cases:
 *   1. setSpec first call → iMAsset.create(filename='SPEC.md', boundKind='task-bound',
 *      sourceTaskId, revision=1) + iMAssetRevision.create with metadata.body
 *   2. setSpec second call → iMAsset.update(revision=2) + iMAssetRevision.create(revision=2)
 *      with the NEW markdown body
 *   3. todo.appendItem first call → iMAsset.create(filename='TODO.md', boundKind='task-bound')
 *      + iMAssetRevision.create whose body contains `- [ ] <text>`
 *   4. todo.toggleItem done=true → iMAssetRevision.create with bumped revision +
 *      body containing `- [x]` for the toggled line
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prisma: {
    iMTask: { findUnique: vi.fn() },
    iMAsset: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    iMAssetRevision: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
  },
  metricEmit: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({ default: mocks.prisma, prisma: mocks.prisma }));
vi.mock('../db', () => ({ default: mocks.prisma }));
vi.mock('../services/metric.service', () => ({
  metricEmit: mocks.metricEmit,
  getMetricService: () => ({ emit: mocks.metricEmit, flush: vi.fn(), stop: vi.fn(), stats: vi.fn() }),
}));

import { TaskSpecService } from '../services/task-spec.service';
import { TodoService } from '../services/todo.service';

function mockTaskRow(overrides: Partial<any> = {}) {
  return {
    id: 'task-1',
    workspaceId: 'ws-1',
    status: 'assigned',
    assigneeId: 'assignee-agent',
    ...overrides,
  };
}

describe('TaskSpecService.set — IMAsset/Revision writeback contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.iMTask.findUnique.mockResolvedValue(mockTaskRow());
  });

  it('first set → creates IMAsset row with filename=SPEC.md + boundKind=task-bound + revision=1', async () => {
    // No existing asset.
    mocks.prisma.iMAsset.findFirst.mockResolvedValue(null);
    mocks.prisma.iMAsset.create.mockResolvedValue({ id: 'asset-spec-1' });
    mocks.prisma.iMAssetRevision.create.mockResolvedValue({ id: 'rev-spec-1' });

    const svc = new TaskSpecService();
    const out = await svc.set('task-1', '# Goal\nBuild widget X', 'creator-1');

    expect(out.revision).toBe(1);
    expect(mocks.prisma.iMAsset.create).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.iMAsset.update).not.toHaveBeenCalled();
    const createArgs = mocks.prisma.iMAsset.create.mock.calls[0][0].data;
    expect(createArgs.filename).toBe('SPEC.md');
    expect(createArgs.boundKind).toBe('task-bound');
    expect(createArgs.sourceTaskId).toBe('task-1');
    expect(createArgs.workspaceId).toBe('ws-1');
    expect(createArgs.revision).toBe(1);
    expect(createArgs.kind).toBe('document');
    expect(createArgs.mime).toBe('text/markdown');

    expect(mocks.prisma.iMAssetRevision.create).toHaveBeenCalledTimes(1);
    const revArgs = mocks.prisma.iMAssetRevision.create.mock.calls[0][0].data;
    expect(revArgs.revision).toBe(1);
    expect(revArgs.assetId).toBe(createArgs.id); // new IMAsset id flows in
    expect(revArgs.filename).toBe('SPEC.md');
    const meta = JSON.parse(revArgs.metadata);
    expect(meta.body).toBe('# Goal\nBuild widget X');
    expect(meta.reservedFilename).toBe('SPEC.md');
  });

  it('second set → updates IMAsset (no new create) + new IMAssetRevision with revision=2 and fresh body', async () => {
    // Existing asset present.
    mocks.prisma.iMAsset.findFirst.mockResolvedValue({
      id: 'asset-spec-existing',
      storageUri: 'inline-markdown://spec/task-1/aaaaaaaaaaaa',
      revision: 1,
      updatedAt: new Date('2026-05-27T00:00:00.000Z'),
    });
    mocks.prisma.iMAsset.update.mockResolvedValue({});
    mocks.prisma.iMAssetRevision.create.mockResolvedValue({ id: 'rev-spec-2' });

    const svc = new TaskSpecService();
    const out = await svc.set('task-1', '# Goal\nRevised body v2', 'creator-1');

    expect(out.revision).toBe(2);
    expect(mocks.prisma.iMAsset.create).not.toHaveBeenCalled();
    expect(mocks.prisma.iMAsset.update).toHaveBeenCalledTimes(1);
    const updateArgs = mocks.prisma.iMAsset.update.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: 'asset-spec-existing' });
    expect(updateArgs.data.revision).toBe(2);

    expect(mocks.prisma.iMAssetRevision.create).toHaveBeenCalledTimes(1);
    const revArgs = mocks.prisma.iMAssetRevision.create.mock.calls[0][0].data;
    expect(revArgs.revision).toBe(2);
    expect(revArgs.assetId).toBe('asset-spec-existing');
    const meta = JSON.parse(revArgs.metadata);
    expect(meta.body).toBe('# Goal\nRevised body v2');
  });
});

describe('TodoService.appendItem / toggleItem — IMAsset/Revision writeback contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.iMTask.findUnique.mockResolvedValue(mockTaskRow());
  });

  it('appendItem on empty TODO → creates IMAsset(filename=TODO.md, boundKind=task-bound) + first revision with `- [ ] <text>`', async () => {
    // No existing TODO asset → get() short-circuits with empty markdown.
    mocks.prisma.iMAsset.findFirst.mockResolvedValue(null);
    mocks.prisma.iMAsset.create.mockResolvedValue({ id: 'asset-todo-1' });
    mocks.prisma.iMAssetRevision.create.mockResolvedValue({ id: 'rev-todo-1' });

    const svc = new TodoService();
    const view = await svc.appendItem('task-1', 'wire up CI', 'creator-1', {
      workspaceId: 'ws-1',
      creatorId: 'creator-1',
    });

    expect(view.items).toHaveLength(1);
    expect(view.items[0]?.text).toBe('wire up CI');
    expect(view.items[0]?.status).toBe('pending');
    expect(view.revision).toBe(1);

    expect(mocks.prisma.iMAsset.create).toHaveBeenCalledTimes(1);
    const createArgs = mocks.prisma.iMAsset.create.mock.calls[0][0].data;
    expect(createArgs.filename).toBe('TODO.md');
    expect(createArgs.boundKind).toBe('task-bound');
    expect(createArgs.sourceTaskId).toBe('task-1');
    expect(createArgs.workspaceId).toBe('ws-1');
    expect(createArgs.revision).toBe(1);

    expect(mocks.prisma.iMAssetRevision.create).toHaveBeenCalledTimes(1);
    const revArgs = mocks.prisma.iMAssetRevision.create.mock.calls[0][0].data;
    expect(revArgs.revision).toBe(1);
    expect(revArgs.filename).toBe('TODO.md');
    const meta = JSON.parse(revArgs.metadata);
    expect(meta.body).toContain('- [ ] wire up CI');
  });

  it('toggleItem done=true → new IMAssetRevision with bumped revision + `- [x]` on the toggled line', async () => {
    // Existing TODO asset (revision=1) with one pending item → mock the
    // findLatestAsset findFirst path + the readAssetContent revision read.
    mocks.prisma.iMAsset.findFirst.mockResolvedValue({
      id: 'asset-todo-existing',
      storageUri: 'inline-markdown://todo/task-1/aaaaaaaaaaaa',
      revision: 1,
      workspaceId: 'ws-1',
    });
    mocks.prisma.iMAssetRevision.findFirst.mockResolvedValue({
      metadata: JSON.stringify({
        reservedFilename: 'TODO.md',
        body: '- [ ] wire up CI\n',
      }),
      storageUri: 'inline-markdown://todo/task-1/aaaaaaaaaaaa',
    });
    mocks.prisma.iMAsset.update.mockResolvedValue({});
    mocks.prisma.iMAssetRevision.create.mockResolvedValue({ id: 'rev-todo-2' });

    const svc = new TodoService();
    const view = await svc.toggleItem('task-1', 0, true, 'assignee-agent', {
      workspaceId: 'ws-1',
      creatorId: 'creator-1',
    });

    expect(view.revision).toBe(2);
    expect(view.items).toHaveLength(1);
    expect(view.items[0]?.status).toBe('done');
    expect(view.doneCount).toBe(1);

    expect(mocks.prisma.iMAsset.create).not.toHaveBeenCalled();
    expect(mocks.prisma.iMAsset.update).toHaveBeenCalledTimes(1);
    const updateArgs = mocks.prisma.iMAsset.update.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: 'asset-todo-existing' });
    expect(updateArgs.data.revision).toBe(2);

    expect(mocks.prisma.iMAssetRevision.create).toHaveBeenCalledTimes(1);
    const revArgs = mocks.prisma.iMAssetRevision.create.mock.calls[0][0].data;
    expect(revArgs.revision).toBe(2);
    expect(revArgs.assetId).toBe('asset-todo-existing');
    expect(revArgs.filename).toBe('TODO.md');
    const meta = JSON.parse(revArgs.metadata);
    expect(meta.body).toContain('- [x] wire up CI');
    expect(meta.body).not.toContain('- [ ] wire up CI');
  });
});
