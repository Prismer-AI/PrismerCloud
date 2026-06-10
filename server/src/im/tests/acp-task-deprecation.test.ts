/**
 * Task endpoint deprecation — release 200 P8 acceptance tests.
 *
 * Verifies that the 5 legacy task action endpoints (start / complete /
 * approve / reject / cancel-via-DELETE) and the `status / assigneeId /
 * forceExecutionStatus / progress / statusMessage` fields on PATCH emit
 * RFC 8594-style Deprecation / Sunset / Link headers + a non-blocking
 * `_deprecation` envelope on the response body, while the new
 * POST /:id/transition endpoint and content-only PATCH calls emit NO
 * deprecation signal.
 *
 * See:
 *   - docs/release200/15-task-state-machine-and-kanban.md §6.3
 *   - docs/migrations/v2.0/tasks-endpoint-migration.md
 *   - src/im/api/tasks.ts `markDeprecated` / `detectDeprecatedPatchFields`
 */

import { Hono, type Context, type Next } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Hoisted mocks ───────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  user: { imUserId: 'human-1', role: 'human' as const, userId: '1' },
  taskService: {
    approveTask: vi.fn(),
    rejectTask: vi.fn(),
    cancelTask: vi.fn(),
    completeTask: vi.fn(),
    forceExecutionStatus: vi.fn(),
    updateTask: vi.fn(),
    transitionTask: vi.fn(),
    forceTransitionTask: vi.fn(),
    getTask: vi.fn(),
  },
  prisma: {
    iMUser: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}));

vi.mock('../auth/middleware', () => ({
  authMiddleware: async (c: Context, next: Next) => {
    c.set('user', mocks.user);
    await next();
  },
}));
vi.mock('../db', () => ({ default: mocks.prisma }));
vi.mock('../security/mcp-allowlist', () => ({
  requireAgentToolAllowed: vi.fn().mockResolvedValue(null),
  requireAgentToolAllowedForTask: vi.fn().mockResolvedValue(null),
}));

import { createTasksRouter } from '../api/tasks';

// ─── Fixtures ────────────────────────────────────────────────
const now = new Date('2026-05-19T00:00:00.000Z').toISOString();

function taskInfo(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    title: 'Demo task',
    description: null,
    capability: null,
    input: null,
    contextUri: null,
    creatorId: 'human-1',
    assigneeId: 'human-2',
    workspaceId: 'ws-1',
    conversationId: null,
    status: 'assigned',
    progress: null,
    statusMessage: null,
    completedAt: null,
    quotedMessageId: null,
    metadata: null,
    parentTaskId: null,
    rewardCredits: null,
    cost: null,
    result: null,
    resultUri: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function buildApp() {
  // taskService is fully mocked; rate limiter + event bus not needed here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const router = createTasksRouter(mocks.taskService as any);
  return new Hono().route('/tasks', router);
}

describe('Tasks API — release 200 P8 deprecation signals', () => {
  beforeEach(() => {
    Object.values(mocks.taskService).forEach((fn) => (fn as { mockReset: () => void }).mockReset());
    mocks.taskService.approveTask.mockResolvedValue(taskInfo({ status: 'completed' }));
    mocks.taskService.rejectTask.mockResolvedValue(taskInfo({ status: 'failed' }));
    mocks.taskService.cancelTask.mockResolvedValue(taskInfo({ status: 'cancelled' }));
    mocks.taskService.completeTask.mockResolvedValue(taskInfo({ status: 'completed' }));
    mocks.taskService.forceExecutionStatus.mockResolvedValue(taskInfo({ status: 'running' }));
    mocks.taskService.updateTask.mockResolvedValue(taskInfo());
    mocks.taskService.transitionTask.mockResolvedValue(taskInfo({ status: 'running' }));
    mocks.taskService.getTask.mockResolvedValue(taskInfo({ status: 'assigned' }));
    mocks.prisma.iMUser.findMany.mockResolvedValue([]);
  });

  // ─── 5 legacy action endpoints ─────────────────────────────

  it('POST /tasks/:id/start emits Deprecation headers + _deprecation envelope', async () => {
    const app = buildApp();
    const res = await app.request('/tasks/task-1/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Deprecation')).toBe('true');
    expect(res.headers.get('Sunset')).toBe('2026-09-01');
    expect(res.headers.get('Link')).toBe('</api/im/tasks/:id/transition>; rel="successor-version"');
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body._deprecation).toMatchObject({
      endpoint: 'POST /tasks/:id/start',
      successor: '/api/im/tasks/:id/transition',
      sunset: '2026-09-01',
      note: expect.stringContaining('transition'),
    });
  });

  it('POST /tasks/:id/complete emits Deprecation headers + _deprecation envelope', async () => {
    const app = buildApp();
    const res = await app.request('/tasks/task-1/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ result: 'ok' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Deprecation')).toBe('true');
    const body = await res.json();
    expect(body._deprecation?.endpoint).toBe('POST /tasks/:id/complete');
    expect(body._deprecation?.successor).toBe('/api/im/tasks/:id/transition');
  });

  it('POST /tasks/:id/approve emits Deprecation headers + _deprecation envelope', async () => {
    const app = buildApp();
    const res = await app.request('/tasks/task-1/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Deprecation')).toBe('true');
    expect(res.headers.get('Sunset')).toBe('2026-09-01');
    const body = await res.json();
    expect(body._deprecation?.endpoint).toBe('POST /tasks/:id/approve');
  });

  it('POST /tasks/:id/reject emits Deprecation headers + _deprecation envelope', async () => {
    const app = buildApp();
    const res = await app.request('/tasks/task-1/reject', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'incomplete' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Deprecation')).toBe('true');
    const body = await res.json();
    expect(body._deprecation?.endpoint).toBe('POST /tasks/:id/reject');
  });

  it('DELETE /tasks/:id (legacy cancel) emits Deprecation headers + _deprecation envelope', async () => {
    const app = buildApp();
    const res = await app.request('/tasks/task-1', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Deprecation')).toBe('true');
    expect(res.headers.get('Sunset')).toBe('2026-09-01');
    const body = await res.json();
    expect(body._deprecation?.endpoint).toBe('DELETE /tasks/:id');
    expect(body._deprecation?.successor).toBe('/api/im/tasks/:id/transition');
  });

  // ─── PATCH /tasks/:id partial deprecation ──────────────────

  it('PATCH /tasks/:id with status field flags deprecation', async () => {
    const app = buildApp();
    const res = await app.request('/tasks/task-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'running' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Deprecation')).toBe('true');
    const body = await res.json();
    expect(body._deprecation?.endpoint).toBe('PATCH /tasks/:id');
    expect(body._deprecation?.fields).toEqual(expect.arrayContaining(['status']));
  });

  it('PATCH /tasks/:id with assigneeId field flags deprecation', async () => {
    const app = buildApp();
    const res = await app.request('/tasks/task-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assigneeId: 'human-9' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Deprecation')).toBe('true');
    const body = await res.json();
    expect(body._deprecation?.fields).toEqual(expect.arrayContaining(['assigneeId']));
  });

  it('PATCH /tasks/:id with snake_case assignee_id alias still flags deprecation', async () => {
    const app = buildApp();
    const res = await app.request('/tasks/task-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assignee_id: 'human-9' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Deprecation')).toBe('true');
    const body = await res.json();
    expect(body._deprecation?.fields).toEqual(expect.arrayContaining(['assigneeId']));
  });

  it('PATCH /tasks/:id with combined status + progress + statusMessage lists all deprecated fields', async () => {
    const app = buildApp();
    const res = await app.request('/tasks/task-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'review', progress: 0.5, statusMessage: 'half done' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Deprecation')).toBe('true');
    const body = await res.json();
    expect(body._deprecation?.fields).toEqual(
      expect.arrayContaining(['status', 'progress', 'statusMessage']),
    );
  });

  it('PATCH /tasks/:id with content-only fields (title/description/metadata) emits NO deprecation signal', async () => {
    const app = buildApp();
    const res = await app.request('/tasks/task-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Renamed', description: 'edited', metadata: { tag: 'x' } }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Deprecation')).toBeNull();
    expect(res.headers.get('Sunset')).toBeNull();
    expect(res.headers.get('Link')).toBeNull();
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body._deprecation).toBeUndefined();
  });

  // ─── New /transition endpoint stays clean ──────────────────

  it('POST /tasks/:id/transition emits NO deprecation signal', async () => {
    const app = buildApp();
    const res = await app.request('/tasks/task-1/transition', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'running', reason: 'pickup' }),
    });
    // Service mock returns a task — handler should pass through.
    expect([200, 409]).toContain(res.status); // matrix validation may run; either way no deprecation
    expect(res.headers.get('Deprecation')).toBeNull();
    expect(res.headers.get('Sunset')).toBeNull();
    expect(res.headers.get('Link')).toBeNull();
    const body = await res.json();
    expect(body._deprecation).toBeUndefined();
  });
});
