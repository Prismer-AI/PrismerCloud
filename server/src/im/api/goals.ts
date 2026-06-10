/**
 * Prismer IM — Task-backed Goals API.
 *
 * Goals are IMTask projections with metadata.kind='goal'. This router is a
 * semantic wrapper only; it does not introduce a second canonical store.
 */

import { Hono } from 'hono';
import { authMiddleware } from '../auth/middleware';
import type { ApiResponse } from '../types';
import { TaskAccessError, TaskNotFoundError, TaskService } from '../services/task.service';

function goalMetadata(input: {
  status?: string;
  priority?: string;
  linkedTaskIds?: string[];
  linkedConversationIds?: string[];
  extra?: Record<string, unknown>;
}) {
  return {
    ...(input.extra ?? {}),
    kind: 'goal',
    schemaVersion: 1,
    intent: 'standing_objective',
    goal: {
      status: input.status ?? 'active',
      priority: input.priority ?? 'medium',
      linkedTaskIds: input.linkedTaskIds ?? [],
      linkedConversationIds: input.linkedConversationIds ?? [],
      lastActivityAt: new Date().toISOString(),
    },
  };
}

function mergeGoalMetadata(existing: Record<string, unknown>, patch: Record<string, unknown>) {
  const existingGoal =
    existing.goal && typeof existing.goal === 'object' && !Array.isArray(existing.goal)
      ? (existing.goal as Record<string, unknown>)
      : {};
  const patchGoal =
    patch.goal && typeof patch.goal === 'object' && !Array.isArray(patch.goal)
      ? (patch.goal as Record<string, unknown>)
      : {};
  return {
    ...existing,
    ...patch,
    kind: 'goal',
    schemaVersion: typeof existing.schemaVersion === 'number' ? existing.schemaVersion : 1,
    intent: 'standing_objective',
    goal: {
      ...existingGoal,
      ...patchGoal,
      lastActivityAt: new Date().toISOString(),
    },
  };
}

function assertGoal(task: { metadata?: Record<string, unknown> }) {
  const meta = task.metadata ?? {};
  if (meta.kind !== 'goal' && meta.intent !== 'standing_objective') {
    throw Object.assign(new Error('Task is not a goal'), { status: 400, code: 'NOT_GOAL' });
  }
}

function handleGoalError(err: unknown, c: any): Response {
  if (err instanceof TaskNotFoundError) {
    return c.json({ ok: false, error: { code: 'GOAL_NOT_FOUND', message: err.message } }, 404);
  }
  if (err instanceof TaskAccessError) {
    return c.json({ ok: false, error: { code: 'GOAL_ACCESS_DENIED', message: err.message } }, 403);
  }
  const maybe = err as { status?: number; code?: string; message?: string };
  if (maybe.status && maybe.code) {
    return c.json(
      { ok: false, error: { code: maybe.code, message: maybe.message ?? maybe.code } },
      maybe.status as any,
    );
  }
  return c.json({ ok: false, error: { code: 'INTERNAL_ERROR', message: (err as Error).message } }, 500);
}

export function createGoalsRouter(taskService: TaskService): Hono {
  const router = new Hono();
  // eslint-disable-next-line custom/no-wildcard-sub-router-middleware -- mounted at /goals in routes.ts; wildcard scoped to that prefix
  router.use('*', authMiddleware);

  router.get('/', async (c) => {
    const user = c.get('user');
    const query = {
      workspaceId: c.req.query('workspaceId') ?? c.req.query('workspace_id'),
      conversationId: c.req.query('conversationId') ?? c.req.query('conversation_id'),
      status: c.req.query('status') as any,
      kind: 'goal',
      view: 'board',
      limit: c.req.query('limit') ? parseInt(c.req.query('limit')!, 10) : undefined,
      cursor: c.req.query('cursor') ?? undefined,
    };
    const [created, assigned] = await Promise.all([
      taskService.listTasks({ ...query, creatorId: user.imUserId }),
      taskService.listTasks({ ...query, assigneeId: user.imUserId }),
    ]);
    const seen = new Set<string>();
    const goals = [...created, ...assigned].filter((goal) => {
      if (seen.has(goal.id)) return false;
      seen.add(goal.id);
      return true;
    });
    return c.json<ApiResponse>({ ok: true, data: goals, meta: { total: goals.length } });
  });

  router.post('/', async (c) => {
    const user = c.get('user');
    const body = await c.req.json().catch(() => ({}));
    if (!body.title || typeof body.title !== 'string') {
      return c.json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'title is required' } }, 400);
    }
    try {
      const goal = await taskService.createTask(user.imUserId, {
        title: body.title,
        description: body.description,
        capability: body.capability,
        input: body.input,
        contextUri: body.contextUri ?? body.context_uri,
        assigneeId: body.assigneeId ?? body.assignee_id,
        workspaceId: body.workspaceId ?? body.workspace_id,
        conversationId: body.conversationId ?? body.conversation_id,
        metadata: goalMetadata({
          status: body.status,
          priority: body.priority,
          linkedTaskIds: Array.isArray(body.linkedTaskIds) ? body.linkedTaskIds : [],
          linkedConversationIds: Array.isArray(body.linkedConversationIds) ? body.linkedConversationIds : [],
          extra: body.metadata && typeof body.metadata === 'object' ? body.metadata : undefined,
        }),
      });
      return c.json<ApiResponse>({ ok: true, data: goal }, 201);
    } catch (err) {
      return handleGoalError(err, c);
    }
  });

  router.get('/:goalId', async (c) => {
    const user = c.get('user');
    try {
      const goal = await taskService.getTask(c.req.param('goalId'), user.imUserId);
      assertGoal(goal);
      return c.json<ApiResponse>({ ok: true, data: goal });
    } catch (err) {
      return handleGoalError(err, c);
    }
  });

  router.patch('/:goalId', async (c) => {
    const user = c.get('user');
    const body = await c.req.json().catch(() => ({}));
    try {
      const existing = await taskService.getTask(c.req.param('goalId'), user.imUserId);
      assertGoal(existing);
      const metadata = mergeGoalMetadata(existing.metadata ?? {}, {
        ...(body.metadata && typeof body.metadata === 'object' ? body.metadata : {}),
        goal: {
          ...(body.status ? { status: body.status } : {}),
          ...(body.priority ? { priority: body.priority } : {}),
          ...(Array.isArray(body.linkedTaskIds) ? { linkedTaskIds: body.linkedTaskIds } : {}),
          ...(Array.isArray(body.linkedConversationIds) ? { linkedConversationIds: body.linkedConversationIds } : {}),
        },
      });
      const goal = await taskService.updateTask(c.req.param('goalId'), user.imUserId, {
        title: body.title,
        description: body.description,
        assigneeId: body.assigneeId ?? body.assignee_id,
        metadata,
      });
      return c.json<ApiResponse>({ ok: true, data: goal });
    } catch (err) {
      return handleGoalError(err, c);
    }
  });

  for (const [path, status] of [
    ['/pause', 'paused'],
    ['/resume', 'active'],
    ['/complete', 'completed'],
  ] as const) {
    router.patch(`/:goalId${path}`, async (c) => {
      const user = c.get('user');
      try {
        const existing = await taskService.getTask(c.req.param('goalId'), user.imUserId);
        assertGoal(existing);
        const metadata = mergeGoalMetadata(existing.metadata ?? {}, { goal: { status } });
        const goal = await taskService.updateTask(c.req.param('goalId'), user.imUserId, {
          ...(status === 'completed' ? { status: 'completed' as any, forceExecutionStatus: true } : {}),
          metadata,
        });
        return c.json<ApiResponse>({ ok: true, data: goal });
      } catch (err) {
        return handleGoalError(err, c);
      }
    });
  }

  return router;
}
