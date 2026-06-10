/**
 * Phase 2A integration — Project cascade semantics (doc release201/09 §4.4).
 *
 * Two cascade modes are exercised end-to-end against real im_tasks rows:
 *   - cascade=archive : project.status='archived', linked tasks RETAIN projectId
 *   - cascade=null    : project.status='archived', linked tasks projectId=NULL
 *
 * Tasks list endpoint (src/im/api/tasks.ts:948) accepts the `projectId` query
 * param with sentinel values:
 *   - `<id>`        → equals filter (parseProjectIdFilter at task.service.ts:111)
 *   - `__unscoped`  → projectId IS NULL
 *
 * cascade=hard is covered by projects.test.ts (405); not duplicated here.
 *
 * Task creation: POST /tasks { workspaceId, title, projectId? } — projectId
 * is forwarded when caller explicitly sends it (tasks.ts:926-929). When
 * omitted, projectId stays NULL.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { bootstrapSuite, api } from '../_helpers';

interface ProjectEnvelope {
  ok: boolean;
  data?: { id: string; status: string; workspaceId: string };
}

interface TaskDTO {
  id: string;
  title: string;
  workspaceId: string;
  projectId: string | null;
  status: string;
}

interface TaskEnvelope {
  ok: boolean;
  data?: TaskDTO;
  error?: unknown;
}

interface TaskListEnvelope {
  ok: boolean;
  data?: { items?: TaskDTO[]; tasks?: TaskDTO[] } | TaskDTO[];
}

interface DeleteEnvelope {
  ok: boolean;
  data?: {
    project: { id: string; status: string };
    cascade: 'archive' | 'null' | 'hard';
    cascadeReport: { taskUnscoped: number };
  };
}

function uniqSlug(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`.toLowerCase();
}

function extractTaskList(env: TaskListEnvelope): TaskDTO[] {
  const d = env.data;
  if (!d) return [];
  if (Array.isArray(d)) return d;
  if ('items' in d && Array.isArray(d.items)) return d.items;
  if ('tasks' in d && Array.isArray(d.tasks)) return d.tasks;
  return [];
}

async function createScopedTask(
  workspaceId: string,
  projectId: string | null,
  title: string,
  owner: Parameters<typeof api>[2] extends infer T ? (T extends { actor?: infer A } ? NonNullable<A> : never) : never,
): Promise<TaskDTO> {
  const body: Record<string, unknown> = { workspaceId, title };
  if (projectId !== null) body.projectId = projectId;
  const r = await api<TaskEnvelope>('POST', '/tasks', {
    actor: owner,
    body,
    expectStatus: 201,
  });
  return r.data.data!;
}

describe('project-cascade — doc 09 §4.4', () => {
  let ctx: Awaited<ReturnType<typeof bootstrapSuite>>;

  beforeAll(async () => {
    ctx = await bootstrapSuite('phase2acas');
  }, 60_000);

  afterAll(async () => {
    await ctx.cleanup();
  });

  test('cascade=archive — linked tasks retain projectId', async () => {
    // 1 project + 3 scoped tasks + 1 unscoped task.
    const projRes = await api<ProjectEnvelope>('POST', '/projects', {
      actor: ctx.owner,
      body: { workspaceId: ctx.workspace.id, slug: uniqSlug('cascA'), name: 'cascade-archive proj' },
      expectStatus: 201,
    });
    const projectId = projRes.data.data!.id;

    const scopedTasks = await Promise.all([
      createScopedTask(ctx.workspace.id, projectId, 'archive-scoped-1', ctx.owner),
      createScopedTask(ctx.workspace.id, projectId, 'archive-scoped-2', ctx.owner),
      createScopedTask(ctx.workspace.id, projectId, 'archive-scoped-3', ctx.owner),
    ]);
    const _unscoped = await createScopedTask(ctx.workspace.id, null, 'archive-unscoped', ctx.owner);
    expect(_unscoped.projectId).toBeNull();
    for (const t of scopedTasks) expect(t.projectId).toBe(projectId);

    // Default cascade is 'archive' — pass no cascade param.
    const delRes = await api<DeleteEnvelope>('DELETE', `/projects/${projectId}`, { actor: ctx.owner });
    expect(delRes.status).toBe(200);
    expect(delRes.data.data?.cascade).toBe('archive');
    expect(delRes.data.data?.project.status).toBe('archived');
    // archive does NOT unscope tasks — count must be 0.
    expect(delRes.data.data?.cascadeReport.taskUnscoped).toBe(0);

    // List tasks scoped to the (now-archived) project — the 3 tasks should
    // still be there with projectId intact (cascade=archive preserves linkage).
    const listRes = await api<TaskListEnvelope>('GET', '/tasks', {
      actor: ctx.owner,
      query: { projectId, workspaceId: ctx.workspace.id },
    });
    expect(listRes.status).toBe(200);
    const tasks = extractTaskList(listRes.data);
    const scopedIds = scopedTasks.map((t) => t.id);
    const stillScoped = tasks.filter((t) => scopedIds.includes(t.id));
    expect(stillScoped.length).toBe(3);
    for (const t of stillScoped) expect(t.projectId).toBe(projectId);
  });

  test('cascade=null — linked tasks projectId becomes NULL', async () => {
    const projRes = await api<ProjectEnvelope>('POST', '/projects', {
      actor: ctx.owner,
      body: { workspaceId: ctx.workspace.id, slug: uniqSlug('cascN'), name: 'cascade-null proj' },
      expectStatus: 201,
    });
    const projectId = projRes.data.data!.id;

    const scopedTasks = await Promise.all([
      createScopedTask(ctx.workspace.id, projectId, 'null-scoped-1', ctx.owner),
      createScopedTask(ctx.workspace.id, projectId, 'null-scoped-2', ctx.owner),
      createScopedTask(ctx.workspace.id, projectId, 'null-scoped-3', ctx.owner),
    ]);
    for (const t of scopedTasks) expect(t.projectId).toBe(projectId);

    const delRes = await api<DeleteEnvelope>('DELETE', `/projects/${projectId}`, {
      actor: ctx.owner,
      query: { cascade: 'null' },
    });
    expect(delRes.status).toBe(200);
    expect(delRes.data.data?.cascade).toBe('null');
    expect(delRes.data.data?.project.status).toBe('archived');
    // cascade=null SHOULD report N unscoped tasks (3 here).
    expect(delRes.data.data?.cascadeReport.taskUnscoped).toBe(3);

    // The 3 tasks should now appear under projectId=__unscoped, not under the
    // now-archived project id.
    const unscopedList = await api<TaskListEnvelope>('GET', '/tasks', {
      actor: ctx.owner,
      query: { projectId: '__unscoped', workspaceId: ctx.workspace.id },
    });
    expect(unscopedList.status).toBe(200);
    const unscopedTasks = extractTaskList(unscopedList.data);
    const scopedIds = scopedTasks.map((t) => t.id);
    const foundUnscoped = unscopedTasks.filter((t) => scopedIds.includes(t.id));
    expect(foundUnscoped.length).toBe(3);
    for (const t of foundUnscoped) expect(t.projectId).toBeNull();

    // And conversely, querying for projectId=<archivedId> must return none of them.
    const stillScopedList = await api<TaskListEnvelope>('GET', '/tasks', {
      actor: ctx.owner,
      query: { projectId, workspaceId: ctx.workspace.id },
    });
    const stillScoped = extractTaskList(stillScopedList.data).filter((t) => scopedIds.includes(t.id));
    expect(stillScoped.length).toBe(0);
  });
});
