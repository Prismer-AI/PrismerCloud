/**
 * Prismer IM — Execution Run API.
 *
 * Runs are execution attempts from chat mentions, tasks, goals, cron, hooks,
 * or shell dispatch. They are not Kanban cards.
 */

import { Hono } from 'hono';
import { authMiddleware } from '../auth/middleware';
import type { ApiResponse } from '../types';
import { TaskService, TaskAccessError, TaskNotFoundError } from '../services/task.service';

function handleRunError(err: unknown, c: any): Response {
  if (err instanceof TaskNotFoundError) {
    return c.json({ ok: false, error: { code: 'RUN_NOT_FOUND', message: err.message } }, 404);
  }
  if (err instanceof TaskAccessError) {
    return c.json({ ok: false, error: { code: 'RUN_ACCESS_DENIED', message: err.message } }, 403);
  }
  return c.json({ ok: false, error: { code: 'INTERNAL_ERROR', message: (err as Error).message } }, 500);
}

export function createRunsRouter(taskService: TaskService): Hono {
  const router = new Hono();
  // eslint-disable-next-line custom/no-wildcard-sub-router-middleware -- mounted at /runs in routes.ts; wildcard scoped to that prefix
  router.use('*', authMiddleware);

  router.get('/', async (c) => {
    const user = c.get('user');
    const mine = c.req.query('mine');
    const baseQuery = {
      workspaceId: c.req.query('workspaceId') ?? c.req.query('workspace_id'),
      conversationId: c.req.query('conversationId') ?? c.req.query('conversation_id'),
      taskId: c.req.query('taskId') ?? c.req.query('task_id'),
      status: c.req.query('status') ?? undefined,
      sourceKind: c.req.query('sourceKind') ?? c.req.query('source_kind'),
      limit: c.req.query('limit') ? parseInt(c.req.query('limit')!, 10) : undefined,
      cursor: c.req.query('cursor') ?? undefined,
    };
    const [createdRuns, assignedRuns] = await Promise.all([
      mine === 'assigned'
        ? Promise.resolve([])
        : taskService.listTaskRuns({ ...baseQuery, creatorId: user.imUserId }, user.imUserId),
      mine === 'created'
        ? Promise.resolve([])
        : taskService.listTaskRuns({ ...baseQuery, assigneeId: user.imUserId }, user.imUserId),
    ]);
    const seen = new Set<string>();
    const runs = [...createdRuns, ...assignedRuns].filter((run) => {
      if (seen.has(run.id)) return false;
      seen.add(run.id);
      return true;
    });
    return c.json<ApiResponse>({
      ok: true,
      data: runs,
      meta: { total: runs.length, nextCursor: runs.at(-1)?.id ?? null },
    });
  });

  router.get('/:runId', async (c) => {
    const user = c.get('user');
    try {
      const result = await taskService.getTaskRunWithEvents(c.req.param('runId'), user.imUserId);
      return c.json<ApiResponse>({ ok: true, data: result });
    } catch (err) {
      return handleRunError(err, c);
    }
  });

  /**
   * GET /runs/:runId/result — canonical run result (Wave-9 Phase 1).
   * Same shape as /tasks/:id/result; backed by IMTaskRun.output JSON.
   */
  router.get('/:runId/result', async (c) => {
    const user = c.get('user');
    try {
      const data = await taskService.getRunResult(c.req.param('runId'), user.imUserId);
      return c.json<ApiResponse>({ ok: true, data });
    } catch (err) {
      return handleRunError(err, c);
    }
  });

  router.get('/:runId/events', async (c) => {
    const user = c.get('user');
    try {
      const result = await taskService.getTaskRunWithEvents(c.req.param('runId'), user.imUserId);
      return c.json<ApiResponse>({ ok: true, data: result.events, meta: { total: result.events.length } });
    } catch (err) {
      return handleRunError(err, c);
    }
  });

  router.patch('/:runId', async (c) => {
    const user = c.get('user');
    const body = await c.req.json().catch(() => ({}));
    try {
      const run = await taskService.updateTaskRun(c.req.param('runId'), user.imUserId, {
        status: typeof body.status === 'string' ? body.status : undefined,
        output: body.output,
        outputUri: body.outputUri ?? body.output_uri,
        error: typeof body.error === 'string' ? body.error : undefined,
        metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : undefined,
      });
      return c.json<ApiResponse>({ ok: true, data: run });
    } catch (err) {
      return handleRunError(err, c);
    }
  });

  router.post('/:runId/events', async (c) => {
    const user = c.get('user');
    const body = await c.req.json().catch(() => ({}));
    if (!body.type || typeof body.type !== 'string') {
      return c.json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'type is required' } }, 400);
    }
    try {
      const event = await taskService.appendTaskRunEvent(c.req.param('runId'), user.imUserId, {
        type: body.type,
        level: typeof body.level === 'string' ? body.level : undefined,
        message: typeof body.message === 'string' ? body.message : undefined,
        payload: body.payload && typeof body.payload === 'object' ? body.payload : undefined,
      });
      return c.json<ApiResponse>({ ok: true, data: event }, 201);
    } catch (err) {
      return handleRunError(err, c);
    }
  });

  return router;
}
