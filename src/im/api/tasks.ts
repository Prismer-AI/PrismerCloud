/**
 * Prismer IM — Task API
 *
 * POST   /tasks                    Create task
 * GET    /tasks                    List tasks (?status=pending&capability=X)
 * GET    /tasks/:id               Task details (with logs)
 * PATCH  /tasks/:id               Update task (assign, cancel)
 * POST   /tasks/:id/claim         Agent claims a pending task
 * POST   /tasks/:id/progress      Report progress
 * POST   /tasks/:id/complete      Mark completed
 * POST   /tasks/:id/fail          Mark failed
 */

import { Hono } from 'hono';
import { authMiddleware } from '../auth/middleware';
import {
  TaskService,
  TaskNotFoundError,
  TaskStateError,
  TaskClaimError,
  TaskAccessError,
} from '../services/task.service';
import type { RateLimiterService } from '../services/rate-limiter.service';
import { createRateLimitMiddleware } from '../middleware/rate-limit';
import type { ApiResponse, TaskStatus, ScheduleType } from '../types';

export function createTasksRouter(taskService: TaskService, rateLimiter?: RateLimiterService) {
  const router = new Hono();

  router.use('*', authMiddleware);

  // Rate limiting on task creation
  if (rateLimiter) {
    router.post('/', createRateLimitMiddleware(rateLimiter, 'conversation.create'));
  }

  // ═══════════════════════════════════════════════════════════
  // CRUD
  // ═══════════════════════════════════════════════════════════

  /**
   * POST /tasks — Create a new task
   */
  router.post('/', async (c) => {
    const user = c.get('user');
    const body = await c.req.json();

    if (!body.title || typeof body.title !== 'string') {
      return c.json<ApiResponse>({ ok: false, error: 'title is required' }, 400);
    }

    // Validate schedule
    if (body.scheduleType) {
      if (!['once', 'interval', 'cron'].includes(body.scheduleType)) {
        return c.json<ApiResponse>({ ok: false, error: "scheduleType must be 'once', 'interval', or 'cron'" }, 400);
      }
      if (body.scheduleType === 'once' && !body.scheduleAt) {
        return c.json<ApiResponse>({ ok: false, error: 'scheduleAt is required for schedule_type=once' }, 400);
      }
      if (body.scheduleType === 'cron' && !body.scheduleCron) {
        return c.json<ApiResponse>({ ok: false, error: 'scheduleCron is required for schedule_type=cron' }, 400);
      }
      if (body.scheduleType === 'interval' && !body.intervalMs) {
        return c.json<ApiResponse>({ ok: false, error: 'intervalMs is required for schedule_type=interval' }, 400);
      }
    }

    // Validate numeric fields (must be positive)
    const intervalMs = body.intervalMs ?? body.interval_ms;
    if (intervalMs !== undefined && (typeof intervalMs !== 'number' || intervalMs <= 0)) {
      return c.json<ApiResponse>({ ok: false, error: 'intervalMs must be a positive number' }, 400);
    }
    const timeoutMs = body.timeoutMs ?? body.timeout_ms;
    if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || timeoutMs <= 0)) {
      return c.json<ApiResponse>({ ok: false, error: 'timeoutMs must be a positive number' }, 400);
    }
    const retryDelayMs = body.retryDelayMs ?? body.retry_delay_ms;
    if (retryDelayMs !== undefined && (typeof retryDelayMs !== 'number' || retryDelayMs <= 0)) {
      return c.json<ApiResponse>({ ok: false, error: 'retryDelayMs must be a positive number' }, 400);
    }

    // Validate date fields
    const scheduleAt = body.scheduleAt ?? body.schedule_at;
    if (scheduleAt && isNaN(new Date(scheduleAt).getTime())) {
      return c.json<ApiResponse>({ ok: false, error: 'scheduleAt must be a valid ISO 8601 date' }, 400);
    }
    if (body.deadline && isNaN(new Date(body.deadline).getTime())) {
      return c.json<ApiResponse>({ ok: false, error: 'deadline must be a valid ISO 8601 date' }, 400);
    }

    try {
      const task = await taskService.createTask(user.imUserId, {
        title: body.title,
        description: body.description,
        capability: body.capability,
        input: body.input,
        contextUri: body.contextUri ?? body.context_uri,
        assigneeId: body.assigneeId ?? body.assignee_id,
        scheduleType: body.scheduleType ?? body.schedule_type,
        scheduleAt: body.scheduleAt ?? body.schedule_at,
        scheduleCron: body.scheduleCron ?? body.schedule_cron,
        intervalMs: body.intervalMs ?? body.interval_ms,
        maxRuns: body.maxRuns ?? body.max_runs,
        timeoutMs: body.timeoutMs ?? body.timeout_ms,
        deadline: body.deadline,
        maxRetries: body.maxRetries ?? body.max_retries,
        retryDelayMs: body.retryDelayMs ?? body.retry_delay_ms,
        budget: body.budget,
        metadata: body.metadata,
      });

      return c.json<ApiResponse>({ ok: true, data: task }, 201);
    } catch (err) {
      console.error('[TaskAPI] Create error:', err);
      return c.json<ApiResponse>({ ok: false, error: (err as Error).message }, 500);
    }
  });

  /**
   * GET /tasks — List tasks with filters
   *
   * Query params: status, capability, assigneeId, creatorId, scheduleType, limit, cursor
   */
  router.get('/', async (c) => {
    const user = c.get('user');
    const query = {
      status: c.req.query('status') as TaskStatus | undefined,
      capability: c.req.query('capability'),
      assigneeId: c.req.query('assigneeId') ?? c.req.query('assignee_id'),
      creatorId: c.req.query('creatorId') ?? c.req.query('creator_id'),
      scheduleType: c.req.query('scheduleType') as ScheduleType | undefined,
      limit: c.req.query('limit') ? parseInt(c.req.query('limit')!) : undefined,
      cursor: c.req.query('cursor'),
    };

    // Prevent querying other users' tasks by creatorId/assigneeId
    if (query.creatorId && query.creatorId !== user.imUserId) {
      return c.json<ApiResponse>({ ok: false, error: "Cannot query other users' tasks by creatorId" }, 403);
    }
    if (query.assigneeId && query.assigneeId !== user.imUserId) {
      return c.json<ApiResponse>({ ok: false, error: "Cannot query other users' tasks by assigneeId" }, 403);
    }

    // If no filter specified, default to tasks relevant to this user
    if (!query.status && !query.capability && !query.assigneeId && !query.creatorId) {
      // Show tasks where user is creator or assignee
      const [created, assigned] = await Promise.all([
        taskService.listTasks({ ...query, creatorId: user.imUserId }),
        taskService.listTasks({ ...query, assigneeId: user.imUserId }),
      ]);

      // Merge and deduplicate
      const seen = new Set<string>();
      const merged = [];
      for (const t of [...created, ...assigned]) {
        if (!seen.has(t.id)) {
          seen.add(t.id);
          merged.push(t);
        }
      }

      return c.json<ApiResponse>({
        ok: true,
        data: merged,
        meta: { total: merged.length },
      });
    }

    const tasks = await taskService.listTasks(query);
    return c.json<ApiResponse>({
      ok: true,
      data: tasks,
      meta: { total: tasks.length },
    });
  });

  /**
   * GET /tasks/:id — Task details with logs (creator, assignee, or marketplace)
   */
  router.get('/:id', async (c) => {
    const user = c.get('user');
    try {
      const result = await taskService.getTaskWithLogs(c.req.param('id'), user.imUserId);
      return c.json<ApiResponse>({ ok: true, data: result });
    } catch (err) {
      if (err instanceof TaskNotFoundError) {
        return c.json<ApiResponse>({ ok: false, error: err.message }, 404);
      }
      if (err instanceof TaskAccessError) {
        return c.json<ApiResponse>({ ok: false, error: err.message }, 403);
      }
      throw err;
    }
  });

  /**
   * PATCH /tasks/:id — Update task (assign, cancel, update metadata). Creator only.
   */
  router.patch('/:id', async (c) => {
    const user = c.get('user');
    const body = await c.req.json();

    try {
      const task = await taskService.updateTask(c.req.param('id'), user.imUserId, {
        assigneeId: body.assigneeId ?? body.assignee_id,
        status: body.status,
        metadata: body.metadata,
      });
      return c.json<ApiResponse>({ ok: true, data: task });
    } catch (err) {
      if (err instanceof TaskNotFoundError) {
        return c.json<ApiResponse>({ ok: false, error: err.message }, 404);
      }
      if (err instanceof TaskAccessError) {
        return c.json<ApiResponse>({ ok: false, error: err.message }, 403);
      }
      throw err;
    }
  });

  // ═══════════════════════════════════════════════════════════
  // Lifecycle
  // ═══════════════════════════════════════════════════════════

  /**
   * POST /tasks/:id/claim — Agent claims a pending task
   */
  router.post('/:id/claim', async (c) => {
    const user = c.get('user');
    try {
      const task = await taskService.claimTask(c.req.param('id'), user.imUserId);
      return c.json<ApiResponse>({ ok: true, data: task });
    } catch (err) {
      if (err instanceof TaskNotFoundError) {
        return c.json<ApiResponse>({ ok: false, error: err.message }, 404);
      }
      if (err instanceof TaskClaimError) {
        return c.json<ApiResponse>({ ok: false, error: err.message }, 409);
      }
      throw err;
    }
  });

  /**
   * POST /tasks/:id/progress — Report progress. Assignee only.
   */
  router.post('/:id/progress', async (c) => {
    const user = c.get('user');
    const body = await c.req.json();

    try {
      await taskService.reportProgress(c.req.param('id'), user.imUserId, {
        message: body.message,
        metadata: body.metadata,
      });
      return c.json<ApiResponse>({ ok: true });
    } catch (err) {
      if (err instanceof TaskNotFoundError) {
        return c.json<ApiResponse>({ ok: false, error: err.message }, 404);
      }
      if (err instanceof TaskAccessError) {
        return c.json<ApiResponse>({ ok: false, error: err.message }, 403);
      }
      if (err instanceof TaskStateError) {
        return c.json<ApiResponse>({ ok: false, error: err.message }, 409);
      }
      throw err;
    }
  });

  /**
   * POST /tasks/:id/complete — Mark task completed. Assignee only.
   */
  router.post('/:id/complete', async (c) => {
    const user = c.get('user');
    const body = await c.req.json().catch(() => ({}));

    try {
      const task = await taskService.completeTask(c.req.param('id'), user.imUserId, {
        result: body.result,
        resultUri: body.resultUri ?? body.result_uri,
        cost: body.cost,
      });
      return c.json<ApiResponse>({ ok: true, data: task });
    } catch (err) {
      if (err instanceof TaskNotFoundError) {
        return c.json<ApiResponse>({ ok: false, error: err.message }, 404);
      }
      if (err instanceof TaskAccessError) {
        return c.json<ApiResponse>({ ok: false, error: err.message }, 403);
      }
      if (err instanceof TaskStateError) {
        return c.json<ApiResponse>({ ok: false, error: err.message }, 409);
      }
      throw err;
    }
  });

  /**
   * POST /tasks/:id/fail — Mark task failed. Assignee only.
   */
  router.post('/:id/fail', async (c) => {
    const user = c.get('user');
    const body = await c.req.json();

    if (!body.error || typeof body.error !== 'string') {
      return c.json<ApiResponse>({ ok: false, error: 'error message is required' }, 400);
    }

    try {
      const task = await taskService.failTask(c.req.param('id'), user.imUserId, {
        error: body.error,
        metadata: body.metadata,
      });
      return c.json<ApiResponse>({ ok: true, data: task });
    } catch (err) {
      if (err instanceof TaskNotFoundError) {
        return c.json<ApiResponse>({ ok: false, error: err.message }, 404);
      }
      if (err instanceof TaskAccessError) {
        return c.json<ApiResponse>({ ok: false, error: err.message }, 403);
      }
      if (err instanceof TaskStateError) {
        return c.json<ApiResponse>({ ok: false, error: err.message }, 409);
      }
      throw err;
    }
  });

  return router;
}
