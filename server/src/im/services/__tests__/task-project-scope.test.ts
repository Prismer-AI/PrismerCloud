/**
 * Unit tests for release201/09 task project scope gates.
 *
 * Run:
 *   npx tsx src/im/services/__tests__/task-project-scope.test.ts
 */

import assert from 'node:assert/strict';
import { TaskAccessError, TaskService } from '../task.service';
import { MetricService, __setMetricServiceForTests } from '../metric.service';
import { prisma } from '@/lib/prisma';

type Workspace = { id: string; ownerImUserId: string; deletedAt: Date | null };
type User = { id: string; role: string };
type Project = { id: string; workspaceId: string; status: string; ownerUserId: string };
type Membership = { projectId: string; principalKind: string; principalId: string; role: string };
type TaskRow = ReturnType<typeof makeTask>;

const workspaces: Workspace[] = [];
const users: User[] = [];
const projects: Project[] = [];
const memberships: Membership[] = [];
const tasks: TaskRow[] = [];
let taskSeq = 0;

function makeTask(
  partial: Partial<{
    id: string;
    title: string;
    creatorId: string;
    assigneeId: string | null;
    workspaceId: string;
    projectId: string | null;
    status: string;
    metadata: string;
  }> = {},
) {
  const now = new Date();
  return {
    id: partial.id ?? `task_${++taskSeq}`,
    title: partial.title ?? 'Task',
    description: null,
    capability: null,
    input: '{}',
    contextUri: null,
    creatorId: partial.creatorId ?? 'u_owner',
    assigneeId: partial.assigneeId ?? null,
    workspaceId: partial.workspaceId ?? 'ws_1',
    projectId: partial.projectId ?? null,
    conversationId: null,
    status: partial.status ?? 'pending',
    progress: null,
    statusMessage: null,
    scheduleType: null,
    scheduleAt: null,
    scheduleCron: null,
    intervalMs: null,
    nextRunAt: null,
    lastRunAt: null,
    runCount: 0,
    maxRuns: null,
    result: null,
    resultUri: null,
    error: null,
    budget: null,
    cost: 0,
    timeoutMs: 300000,
    deadline: null,
    completedAt: null,
    maxRetries: 3,
    retryDelayMs: 60000,
    retryCount: 0,
    metadata: partial.metadata ?? '{"skipAcceptanceTemplate":true,"kind":"work_item"}',
    runtimeRoute: 'agent',
    createdAt: now,
    updatedAt: now,
    acceptanceCriteriaJson: null,
    acceptanceStatus: null,
  };
}

function matchesWhere(row: Record<string, unknown>, where: Record<string, unknown> = {}): boolean {
  for (const [key, value] of Object.entries(where)) {
    if (value === undefined) continue;
    const cell = row[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const cond = value as Record<string, unknown>;
      if ('in' in cond) {
        if (!(cond.in as unknown[]).includes(cell)) return false;
        continue;
      }
    }
    if (cell !== value) return false;
  }
  return true;
}

(prisma as any).iMWorkspace = {
  async findFirst({ where }: any) {
    return (
      workspaces.find((w) => w.id === where.id && (where.deletedAt === undefined || w.deletedAt === where.deletedAt)) ??
      null
    );
  },
  async findUnique({ where }: any) {
    return (
      workspaces.find((w) => w.id === where.id && (where.deletedAt === undefined || w.deletedAt === where.deletedAt)) ??
      null
    );
  },
};

(prisma as any).iMUser = {
  async findUnique({ where }: any) {
    return users.find((u) => u.id === where.id) ?? null;
  },
};

(prisma as any).iMProject = {
  async findUnique({ where }: any) {
    return projects.find((p) => p.id === where.id) ?? null;
  },
};

(prisma as any).iMAgentProjectMembership = {
  async findUnique({ where }: any) {
    const key = where.projectId_principalKind_principalId;
    if (!key) return null;
    return (
      memberships.find(
        (m) =>
          m.projectId === key.projectId && m.principalKind === key.principalKind && m.principalId === key.principalId,
      ) ?? null
    );
  },
};

(prisma as any).iMTask = {
  async create({ data }: any) {
    const row = makeTask({
      title: data.title,
      creatorId: data.creatorId,
      assigneeId: data.assigneeId ?? null,
      workspaceId: data.workspaceId,
      projectId: data.projectId ?? null,
      status: data.status ?? 'pending',
      metadata: data.metadata ?? '{"skipAcceptanceTemplate":true,"kind":"work_item"}',
    });
    tasks.push(row);
    return row;
  },
  async findMany({ where, take }: any) {
    const rows = tasks.filter((t) => matchesWhere(t as unknown as Record<string, unknown>, where));
    return take ? rows.slice(0, take) : rows;
  },
  async findUnique({ where }: any) {
    return tasks.find((t) => t.id === where.id) ?? null;
  },
  async update({ where, data }: any) {
    const idx = tasks.findIndex((t) => t.id === where.id);
    if (idx === -1) throw new Error('not found');
    tasks[idx] = { ...tasks[idx], ...data, updatedAt: new Date() };
    return tasks[idx];
  },
};

(prisma as any).iMTaskLog = {
  async create({ data }: any) {
    return { id: `log_${data.taskId}_${data.action}`, ...data, createdAt: new Date() };
  },
};

function reset() {
  workspaces.length = 0;
  users.length = 0;
  projects.length = 0;
  memberships.length = 0;
  tasks.length = 0;
  taskSeq = 0;
  workspaces.push({ id: 'ws_1', ownerImUserId: 'u_owner', deletedAt: null });
  users.push(
    { id: 'u_owner', role: 'human' },
    { id: 'u_contrib', role: 'human' },
    { id: 'u_observer', role: 'human' },
    { id: 'u_outsider', role: 'human' },
    { id: 'u_project_owner', role: 'human' },
    { id: 'agent_contrib', role: 'agent' },
  );
  projects.push(
    { id: 'proj_a', workspaceId: 'ws_1', status: 'active', ownerUserId: 'u_owner' },
    { id: 'proj_b', workspaceId: 'ws_1', status: 'active', ownerUserId: 'u_owner' },
    { id: 'proj_archived', workspaceId: 'ws_1', status: 'archived', ownerUserId: 'u_owner' },
  );
  memberships.push(
    { projectId: 'proj_a', principalKind: 'user', principalId: 'u_contrib', role: 'contributor' },
    { projectId: 'proj_a', principalKind: 'user', principalId: 'u_observer', role: 'observer' },
    { projectId: 'proj_a', principalKind: 'agent', principalId: 'agent_contrib', role: 'contributor' },
    { projectId: 'proj_a', principalKind: 'user', principalId: 'u_project_owner', role: 'owner' },
    { projectId: 'proj_b', principalKind: 'user', principalId: 'u_project_owner', role: 'owner' },
  );
  tasks.push(
    makeTask({ id: 'task_a', creatorId: 'u_owner', workspaceId: 'ws_1', projectId: 'proj_a' }),
    makeTask({ id: 'task_b', creatorId: 'u_owner', workspaceId: 'ws_1', projectId: 'proj_b' }),
    makeTask({ id: 'task_null', creatorId: 'u_owner', workspaceId: 'ws_1', projectId: null }),
  );
}

async function expectReject(name: string, fn: () => Promise<unknown>) {
  let caught: unknown = null;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof TaskAccessError, `${name}: expected TaskAccessError`);
}

async function run() {
  __setMetricServiceForTests(new MetricService({ disableTimer: true }));
  const service = new TaskService({} as any);

  reset();
  const createdByContributor = await service.createTask('u_contrib', {
    title: 'Contributor task',
    workspaceId: 'ws_1',
    projectId: 'proj_a',
    metadata: { skipAcceptanceTemplate: true, kind: 'work_item' },
  });
  assert.equal(createdByContributor.projectId, 'proj_a');

  const createdByAgent = await service.createTask('agent_contrib', {
    title: 'Agent task',
    workspaceId: 'ws_1',
    projectId: 'proj_a',
    metadata: { skipAcceptanceTemplate: true, kind: 'work_item' },
  });
  assert.equal(createdByAgent.projectId, 'proj_a');

  await expectReject('observer create', () =>
    service.createTask('u_observer', {
      title: 'Observer task',
      workspaceId: 'ws_1',
      projectId: 'proj_a',
      metadata: { skipAcceptanceTemplate: true, kind: 'work_item' },
    }),
  );
  await expectReject('outsider create', () =>
    service.createTask('u_outsider', {
      title: 'Outsider task',
      workspaceId: 'ws_1',
      projectId: 'proj_a',
      metadata: { skipAcceptanceTemplate: true, kind: 'work_item' },
    }),
  );
  await expectReject('archived project create', () =>
    service.createTask('u_owner', {
      title: 'Archived task',
      workspaceId: 'ws_1',
      projectId: 'proj_archived',
      metadata: { skipAcceptanceTemplate: true, kind: 'work_item' },
    }),
  );

  reset();
  assert.deepEqual(
    (await service.listTasks({ workspaceId: 'ws_1', projectId: 'proj_a', requesterId: 'u_observer' })).map((t) => t.id),
    ['task_a'],
  );
  assert.deepEqual(
    (await service.listTasks({ workspaceId: 'ws_1', projectId: 'proj_a', requesterId: 'u_outsider' })).map((t) => t.id),
    [],
  );
  assert.deepEqual(
    (await service.listTasks({ workspaceId: 'ws_1', projectId: 'proj_a,proj_b', requesterId: 'u_contrib' })).map(
      (t) => t.id,
    ),
    ['task_a'],
  );

  reset();
  await expectReject('target-owner-only move rejected', () => service.moveTaskProject('task_a', 'u_contrib', 'proj_b'));
  const moved = await service.moveTaskProject('task_a', 'u_project_owner', 'proj_b');
  assert.equal(moved.projectId, 'proj_b');

  console.log('✓ task project scope gates passed');
}

void run().catch((err) => {
  console.error(err);
  process.exit(1);
});
