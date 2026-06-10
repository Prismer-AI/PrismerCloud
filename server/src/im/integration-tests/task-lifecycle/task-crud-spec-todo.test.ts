/**
 * Phase 2C — Task lifecycle rev 2: SPEC.md + TODO.md asset writeback.
 *
 * Covers (release201/10 rev 2 §6.3):
 *   - POST /tasks creation with metadata.kind='work_item'
 *   - PUT  /tasks/:id/spec   → IMAsset filename='SPEC.md', boundKind='task-bound',
 *                              new IMAssetRevision per call (revision +1).
 *   - GET  /tasks/:id/spec
 *   - POST /tasks/:id/todo/items → append item.
 *   - GET  /tasks/:id/todo   → items[], markdown, progressPct.
 *   - PATCH /tasks/:id/todo/items/:idx { done: true } → checkbox toggle.
 *   - DELETE /tasks/:id/todo/items/:idx → removes item.
 *
 * No mocking — real HTTP against live cloud (127.0.0.1:3000). Cleanup after.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { api, bootstrapSuite, type SuiteContext } from '../_helpers';

describe('task-lifecycle — SPEC.md + TODO.md writeback', () => {
  let ctx: SuiteContext;
  let taskId: string;

  beforeAll(async () => {
    ctx = await bootstrapSuite('p2cspec');
  });

  afterAll(async () => {
    await ctx?.cleanup?.();
  });

  test('POST /tasks creates a work_item task', async () => {
    const r = await api<{
      ok: boolean;
      data?: { id: string; title: string; workspaceId: string; status: string };
    }>('POST', '/tasks', {
      actor: ctx.owner,
      body: {
        workspaceId: ctx.workspace.id,
        title: 'P2C SPEC/TODO lifecycle task',
        capability: 'generic',
        metadata: { kind: 'work_item' },
      },
    });
    expect(r.status).toBe(201);
    expect(r.data.ok).toBe(true);
    expect(r.data.data?.id).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(r.data.data?.workspaceId).toBe(ctx.workspace.id);
    taskId = r.data.data!.id;
  });

  test('PUT /tasks/:id/spec creates IMAsset SPEC.md @ revision=1', async () => {
    const r = await api<{
      ok: boolean;
      data?: { revision: number; updatedAt: string };
    }>('PUT', `/tasks/${taskId}/spec`, {
      actor: ctx.owner,
      body: {
        markdown: '## Goal\nShip the lifecycle harness.\n\n## Constraints\nDo not break prod.',
      },
    });
    expect(r.status).toBe(200);
    expect(r.data.ok).toBe(true);
    expect(r.data.data?.revision).toBe(1);

    // Asset must exist as task-bound SPEC.md.
    const listed = await api<{
      ok: boolean;
      data?: Array<{ id: string; filename: string; boundKind: string; sourceTaskId: string; revision: number }>;
    }>('GET', '/assets', {
      actor: ctx.owner,
      query: { workspaceId: ctx.workspace.id, taskId },
    });
    expect(listed.status).toBe(200);
    const specAsset = listed.data.data?.find((a) => a.filename === 'SPEC.md');
    expect(specAsset, 'SPEC.md asset must be discoverable via GET /assets?taskId=').toBeTruthy();
    expect(specAsset!.boundKind).toBe('task-bound');
    expect(specAsset!.sourceTaskId).toBe(taskId);
    expect(specAsset!.revision).toBe(1);
  });

  test('GET /tasks/:id/spec returns latest markdown + revision', async () => {
    const r = await api<{
      ok: boolean;
      data?: { markdown: string; revision: number; updatedAt: string | null };
    }>('GET', `/tasks/${taskId}/spec`, { actor: ctx.owner });
    expect(r.status).toBe(200);
    expect(r.data.ok).toBe(true);
    expect(r.data.data?.markdown).toContain('## Goal');
    expect(r.data.data?.revision).toBe(1);
  });

  test('PUT spec a second time → revision +1', async () => {
    const r = await api<{ ok: boolean; data?: { revision: number } }>('PUT', `/tasks/${taskId}/spec`, {
      actor: ctx.owner,
      body: {
        markdown:
          '## Goal\nShip the lifecycle harness (rev 2).\n\n## Background\nPhase 2C tests.\n\n## Constraints\nDo not break prod.',
      },
    });
    expect(r.status).toBe(200);
    expect(r.data.data?.revision).toBe(2);

    const g = await api<{ ok: boolean; data?: { markdown: string; revision: number } }>(
      'GET',
      `/tasks/${taskId}/spec`,
      { actor: ctx.owner },
    );
    expect(g.data.data?.revision).toBe(2);
    expect(g.data.data?.markdown).toContain('rev 2');
  });

  test('POST 3 TODO items, then GET /tasks/:id/todo shows 3 unchecked', async () => {
    const texts = ['Do A', 'Do B', 'Do C'];
    for (const text of texts) {
      const r = await api<{ ok: boolean; data?: { items: unknown[] } }>('POST', `/tasks/${taskId}/todo/items`, {
        actor: ctx.owner,
        body: { text },
      });
      expect(r.status).toBe(200);
      expect(r.data.ok).toBe(true);
    }

    const g = await api<{
      ok: boolean;
      data?: {
        markdown: string;
        items: Array<{ index: number; status: 'pending' | 'done'; text: string }>;
        doneCount: number;
        totalCount: number;
        progressPct: number;
      };
    }>('GET', `/tasks/${taskId}/todo`, { actor: ctx.owner });
    expect(g.status).toBe(200);
    expect(g.data.data?.items.length).toBe(3);
    expect(g.data.data?.totalCount).toBe(3);
    expect(g.data.data?.doneCount).toBe(0);
    expect(g.data.data?.progressPct).toBe(0);
    expect(g.data.data?.markdown).toContain('- [ ] Do A');
    expect(g.data.data?.markdown).toContain('- [ ] Do B');
    expect(g.data.data?.markdown).toContain('- [ ] Do C');
  });

  test('PATCH /tasks/:id/todo/items/0 { done: true } flips checkbox in markdown', async () => {
    const r = await api<{
      ok: boolean;
      data?: {
        markdown: string;
        items: Array<{ index: number; status: 'pending' | 'done' }>;
        doneCount: number;
        totalCount: number;
        progressPct: number;
      };
    }>('PATCH', `/tasks/${taskId}/todo/items/0`, {
      actor: ctx.owner,
      body: { done: true },
    });
    expect(r.status).toBe(200);
    expect(r.data.data?.items[0]?.status).toBe('done');
    expect(r.data.data?.doneCount).toBe(1);
    expect(r.data.data?.totalCount).toBe(3);
    expect(r.data.data?.progressPct).toBeCloseTo(1 / 3, 5);
    expect(r.data.data?.markdown).toContain('- [x] Do A');
    expect(r.data.data?.markdown).toContain('- [ ] Do B');
  });

  test('DELETE /tasks/:id/todo/items/2 leaves 2 items', async () => {
    const r = await api<{
      ok: boolean;
      data?: {
        markdown: string;
        items: Array<{ text: string }>;
        totalCount: number;
        doneCount: number;
        progressPct: number;
      };
    }>('DELETE', `/tasks/${taskId}/todo/items/2`, { actor: ctx.owner });
    expect(r.status).toBe(200);
    expect(r.data.data?.totalCount).toBe(2);
    expect(r.data.data?.items.length).toBe(2);
    expect(r.data.data?.items.map((i) => i.text)).toEqual(['Do A', 'Do B']);
    // Do A is still done, Do B still pending → 1/2 = 0.5.
    expect(r.data.data?.doneCount).toBe(1);
    expect(r.data.data?.progressPct).toBeCloseTo(0.5, 5);
    expect(r.data.data?.markdown).not.toContain('Do C');
  });

  test('progressPct rises to 1.0 once last pending item is ticked', async () => {
    const r = await api<{
      ok: boolean;
      data?: { doneCount: number; totalCount: number; progressPct: number };
    }>('PATCH', `/tasks/${taskId}/todo/items/1`, {
      actor: ctx.owner,
      body: { done: true },
    });
    expect(r.status).toBe(200);
    expect(r.data.data?.doneCount).toBe(2);
    expect(r.data.data?.totalCount).toBe(2);
    expect(r.data.data?.progressPct).toBe(1);
  });
});
