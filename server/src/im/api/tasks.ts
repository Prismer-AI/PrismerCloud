/**
 * Prismer IM — Task API (v1.8.2)
 *
 * POST   /tasks                    Create task
 * GET    /tasks                    List tasks (?status=pending&capability=X&conversationId=Y)
 * GET    /tasks/marketplace        Browse available tasks (pending, unassigned)
 * GET    /tasks/events             SSE task event stream (Phase 3)
 * GET    /tasks/:id               Task details (with logs)
 * PATCH  /tasks/:id               Update task (creator: title/desc/assign/cancel, assignee: progress/status)
 * DELETE /tasks/:id               Cancel task (soft delete, creator only)
 * POST   /tasks/:id/claim         Agent claims a pending task
 * POST   /tasks/:id/progress      [DEPRECATED] Use PATCH with progress/statusMessage
 * POST   /tasks/:id/complete      Mark completed
 * POST   /tasks/:id/fail          Mark failed
 * POST   /tasks/:id/approve       Approve task in review (creator only)
 * POST   /tasks/:id/reject        Reject task in review (creator only)
 * POST   /tasks/:id/reward        Issue credit reward to completer
 * GET    /tasks/:id/subtasks      List subtasks of a parent task
 * GET    /tasks/:id/summary       Subtask progress summary
 */

import { Hono } from 'hono';
import { authMiddleware } from '../auth/middleware';
import { TaskService } from '../services/task.service';
import type { RateLimiterService } from '../services/rate-limiter.service';
import { createRateLimitMiddleware } from '../middleware/rate-limit';
import type { ApiResponse, TaskInfo, TaskStatus, ScheduleType } from '../types';
import type { EventBusService } from '../services/event-bus.service';
import { verifyToken } from '../auth/jwt';
import { streamSSE } from 'hono/streaming';
import { createModuleLogger } from '../../lib/logger';
import prisma from '../db';

const log = createModuleLogger('TaskAPI');

// ─── Structured error helper (v1.8.2) ───────────────────────
// Returns { ok:false, error: { code, message } } per docs/DESIGN-v1.8.2 §2b.
// Codes: TASK_NOT_FOUND | TASK_ACCESS_DENIED | INVALID_STATE_TRANSITION |
//        TASK_CLAIM_FAILED | INSUFFICIENT_BUDGET | VALIDATION_ERROR | INTERNAL_ERROR

type TaskErrorResult = { status: 400 | 402 | 403 | 404 | 409 | 500; code: string; message: string };

/**
 * Map known task errors to structured { code, message, status }.
 * Uses err.name for reliability (instanceof can fail across module boundaries).
 */
function classifyTaskError(err: unknown): TaskErrorResult | null {
  if (!(err instanceof Error)) return null;
  switch (err.name) {
    case 'TaskNotFoundError':
      return { code: 'TASK_NOT_FOUND', message: err.message, status: 404 };
    case 'TaskAccessError':
      return { code: 'TASK_ACCESS_DENIED', message: err.message, status: 403 };
    case 'TaskStateError':
      return { code: 'INVALID_STATE_TRANSITION', message: err.message, status: 409 };
    case 'TaskClaimError':
      return { code: 'TASK_CLAIM_FAILED', message: err.message, status: 409 };
    case 'InsufficientBudgetError':
      return { code: 'INSUFFICIENT_BUDGET', message: err.message, status: 402 };
    default:
      return null;
  }
}

/** Handle a task error: return a JSON response or re-throw if unknown. */
function handleTaskError(err: unknown, c: any): Response | never {
  const classified = classifyTaskError(err);
  if (classified) {
    return c.json({ ok: false, error: { code: classified.code, message: classified.message } }, classified.status);
  }
  throw err;
}

/** Shorthand for validation error responses. */
function validationErr(c: any, msg: string) {
  return c.json({ ok: false, error: { code: 'VALIDATION_ERROR', message: msg } }, 400);
}

/** Shorthand for access denied error responses. */
function accessErr(c: any, msg: string) {
  return c.json({ ok: false, error: { code: 'TASK_ACCESS_DENIED', message: msg } }, 403);
}

// ─── Response enrichment (v1.8.2) ────────────────────────────

interface EnrichedTask extends TaskInfo {
  ownerId: string; // alias for creatorId
  ownerType: string | null;
  ownerName: string | null;
  assigneeType: string | null;
  assigneeName: string | null;
}

async function enrichTasks(tasks: TaskInfo[]): Promise<EnrichedTask[]> {
  if (tasks.length === 0) return [];
  // Best-effort enrichment: if user lookup fails, return with null enrichment fields
  let userMap = new Map<string, UserInfo>();
  try {
    const userIds = [...new Set(tasks.flatMap((t) => [t.creatorId, t.assigneeId].filter(Boolean) as string[]))];
    const users = await prisma.iMUser.findMany({
      where: { id: { in: userIds } },
      select: { id: true, type: true, displayName: true, username: true },
    });
    userMap = new Map<string, UserInfo>(users.map((u: any) => [u.id, u]));
  } catch (err) {
    log.warn({ err }, `enrichTasks: user lookup failed for ${tasks.length} tasks, returning un-enriched`);
  }
  return tasks.map((t) => {
    const creator = userMap.get(t.creatorId);
    const assignee = t.assigneeId ? userMap.get(t.assigneeId) : null;
    return {
      ...t,
      ownerId: t.creatorId,
      ownerType: creator?.type ?? null,
      ownerName: creator?.displayName ?? creator?.username ?? null,
      assigneeType: assignee?.type ?? null,
      assigneeName: assignee?.displayName ?? assignee?.username ?? null,
    };
  });
}

type UserInfo = { id: string; type: string; displayName: string | null; username: string };

async function enrichTask(task: TaskInfo): Promise<EnrichedTask> {
  const [enriched] = await enrichTasks([task]);
  return enriched;
}

// ─── SSE (registered before authMiddleware) ─────────────────

const MAX_SSE_ERRORS = 10;

function registerSSERoute(router: Hono, eventBusService?: EventBusService) {
  router.get('/events', async (c) => {
    const token = c.req.query('token');
    if (!token) {
      return c.json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'token query parameter required' } }, 401);
    }

    let payload;
    try {
      payload = verifyToken(token);
    } catch {
      return c.json({ ok: false, error: { code: 'INVALID_TOKEN', message: 'Invalid or expired token' } }, 401);
    }

    if (!eventBusService) {
      return c.json({ ok: false, error: { code: 'SERVICE_UNAVAILABLE', message: 'Event bus not available' } }, 503);
    }

    const userId = payload.sub;
    // Support reconnection: use Last-Event-ID timestamp if available
    const lastEventIdHeader = c.req.header('Last-Event-ID');
    const initialTime = lastEventIdHeader ? parseInt(lastEventIdHeader, 10) || Date.now() : Date.now();

    return streamSSE(c, async (stream) => {
      let closed = false;
      let consecutiveErrors = 0;
      stream.onAbort(() => {
        closed = true;
      });

      const keepalive = setInterval(() => {
        if (!closed) {
          stream.writeSSE({ event: 'ping', data: '' }).catch(() => {
            closed = true;
          });
        }
      }, 30000);

      let lastEventTime = initialTime;

      while (!closed) {
        try {
          const tasks = await prisma.iMTask.findMany({
            where: {
              OR: [{ creatorId: userId }, { assigneeId: userId }],
              updatedAt: { gt: new Date(lastEventTime) },
            },
            orderBy: { updatedAt: 'asc' },
            take: 10,
          });

          consecutiveErrors = 0; // Reset on success

          for (const task of tasks) {
            if (closed) break;
            const eventTime = task.updatedAt.getTime();
            await stream.writeSSE({
              event: 'task.updated',
              data: JSON.stringify({
                taskId: task.id,
                title: task.title,
                status: task.status,
                progress: (task as any).progress,
                statusMessage: (task as any).statusMessage,
                updatedAt: task.updatedAt,
              }),
              id: String(eventTime),
            });
            lastEventTime = Math.max(lastEventTime, eventTime);
          }

          await new Promise((resolve) => setTimeout(resolve, 2000));
        } catch (err) {
          consecutiveErrors++;
          log.warn({ err }, `SSE poll error for user ${userId} (${consecutiveErrors}/${MAX_SSE_ERRORS})`);
          if (consecutiveErrors >= MAX_SSE_ERRORS) {
            log.error(`SSE stream closing after ${consecutiveErrors} consecutive errors for user ${userId}`);
            closed = true;
            break;
          }
          if (!closed) {
            await new Promise((resolve) => setTimeout(resolve, 5000));
          }
        }
      }

      clearInterval(keepalive);
    });
  });
}

// ─── Router ─────────────────────────────────────────────────

export function createTasksRouter(
  taskService: TaskService,
  rateLimiter?: RateLimiterService,
  eventBusService?: EventBusService,
) {
  const router = new Hono();

  // SSE events endpoint uses token query param auth (EventSource can't set headers)
  // Must be registered BEFORE the global authMiddleware
  registerSSERoute(router, eventBusService);

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
      return validationErr(c, 'title is required');
    }

    // Validate schedule
    if (body.scheduleType) {
      if (!['once', 'interval', 'cron'].includes(body.scheduleType)) {
        return validationErr(c, "scheduleType must be 'once', 'interval', or 'cron'");
      }
      if (body.scheduleType === 'once' && !body.scheduleAt) {
        return validationErr(c, 'scheduleAt is required for schedule_type=once');
      }
      if (body.scheduleType === 'cron' && !body.scheduleCron) {
        return validationErr(c, 'scheduleCron is required for schedule_type=cron');
      }
      if (body.scheduleType === 'interval' && !body.intervalMs) {
        return validationErr(c, 'intervalMs is required for schedule_type=interval');
      }
    }

    // Validate numeric fields (must be positive)
    const intervalMs = body.intervalMs ?? body.interval_ms;
    if (intervalMs !== undefined && (typeof intervalMs !== 'number' || intervalMs <= 0)) {
      return validationErr(c, 'intervalMs must be a positive number');
    }
    const timeoutMs = body.timeoutMs ?? body.timeout_ms;
    if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || timeoutMs <= 0)) {
      return validationErr(c, 'timeoutMs must be a positive number');
    }
    const retryDelayMs = body.retryDelayMs ?? body.retry_delay_ms;
    if (retryDelayMs !== undefined && (typeof retryDelayMs !== 'number' || retryDelayMs <= 0)) {
      return validationErr(c, 'retryDelayMs must be a positive number');
    }

    // Validate date fields
    const scheduleAt = body.scheduleAt ?? body.schedule_at;
    if (scheduleAt && isNaN(new Date(scheduleAt).getTime())) {
      return validationErr(c, 'scheduleAt must be a valid ISO 8601 date');
    }
    if (body.deadline && isNaN(new Date(body.deadline).getTime())) {
      return validationErr(c, 'deadline must be a valid ISO 8601 date');
    }

    try {
      const task = await taskService.createTask(user.imUserId, {
        title: body.title,
        description: body.description,
        capability: body.capability,
        input: body.input,
        contextUri: body.contextUri ?? body.context_uri,
        assigneeId: body.assigneeId ?? body.assignee_id,
        scope: body.scope,
        conversationId: body.conversationId ?? body.conversation_id,
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

      return c.json<ApiResponse>({ ok: true, data: await enrichTask(task) }, 201);
    } catch (err) {
      const classified = classifyTaskError(err);
      if (classified)
        return c.json({ ok: false, error: { code: classified.code, message: classified.message } }, classified.status);
      log.error({ err }, 'Create error');
      return c.json({ ok: false, error: { code: 'INTERNAL_ERROR', message: (err as Error).message } }, 500);
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
      scope: c.req.query('scope'),
      conversationId: c.req.query('conversationId') ?? c.req.query('conversation_id'),
      scheduleType: c.req.query('scheduleType') as ScheduleType | undefined,
      limit: c.req.query('limit') ? parseInt(c.req.query('limit')!) : undefined,
      cursor: c.req.query('cursor'),
    };

    // Prevent querying other users' tasks by creatorId/assigneeId
    if (query.creatorId && query.creatorId !== user.imUserId) {
      return accessErr(c, "Cannot query other users' tasks by creatorId");
    }
    if (query.assigneeId && query.assigneeId !== user.imUserId) {
      return accessErr(c, "Cannot query other users' tasks by assigneeId");
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

      const enriched = await enrichTasks(merged);
      const nextCursor = merged.length > 0 ? merged[merged.length - 1].id : null;
      return c.json({ ok: true, data: enriched, meta: { total: enriched.length, nextCursor } });
    }

    const tasks = await taskService.listTasks(query);
    const enriched = await enrichTasks(tasks);
    const nextCursor = tasks.length > 0 ? tasks[tasks.length - 1].id : null;
    return c.json({ ok: true, data: enriched, meta: { total: enriched.length, nextCursor } });
  });

  // ═══════════════════════════════════════════════════════════
  // Marketplace (static path MUST be registered before /:id)
  // ═══════════════════════════════════════════════════════════

  /**
   * GET /tasks/marketplace — Browse available tasks (pending, unassigned)
   */
  router.get('/marketplace', async (c) => {
    const capability = c.req.query('capability');
    const minReward = c.req.query('minReward') ? Number(c.req.query('minReward')) : undefined;
    const sort = (c.req.query('sort') as 'reward' | 'newest') || 'newest';
    const limit = c.req.query('limit') ? parseInt(c.req.query('limit')!) : 20;

    const tasks = await taskService.browseMarketplace({ capability, minReward, sort, limit });
    const enriched = await enrichTasks(tasks);
    return c.json<ApiResponse>({ ok: true, data: enriched, meta: { total: enriched.length } });
  });

  // SSE route registered before authMiddleware via registerSSERoute()

  /**
   * GET /tasks/:id — Task details with logs (creator, assignee, or marketplace)
   */
  router.get('/:id', async (c) => {
    const user = c.get('user');
    try {
      const result = await taskService.getTaskWithLogs(c.req.param('id')!, user.imUserId);
      const enrichedTask = await enrichTask(result.task);
      return c.json<ApiResponse>({ ok: true, data: { ...result, task: enrichedTask } });
    } catch (err) {
      return handleTaskError(err, c);
    }
  });

  /**
   * PATCH /tasks/:id — Update task.
   * Creator can update: title, description, assigneeId, status=cancelled, metadata
   * Assignee can update: progress (0.0-1.0), statusMessage, status (running/review/completed/failed)
   */
  router.patch('/:id', async (c) => {
    const user = c.get('user');
    const body = await c.req.json();

    // Validate progress range
    if (body.progress !== undefined) {
      const p = Number(body.progress);
      if (isNaN(p) || p < 0 || p > 1) {
        return validationErr(c, 'progress must be a number between 0.0 and 1.0');
      }
      body.progress = p;
    }

    try {
      const task = await taskService.updateTask(c.req.param('id')!, user.imUserId, {
        title: body.title,
        description: body.description,
        assigneeId: body.assigneeId ?? body.assignee_id,
        status: body.status,
        progress: body.progress,
        statusMessage: body.statusMessage ?? body.status_message,
        metadata: body.metadata,
      });
      return c.json<ApiResponse>({ ok: true, data: await enrichTask(task) });
    } catch (err) {
      return handleTaskError(err, c);
    }
  });

  /**
   * DELETE /tasks/:id — Cancel task (soft delete). Creator only.
   * Idempotent: re-deleting a cancelled task returns 200.
   * Returns 409 for completed/failed tasks.
   */
  router.delete('/:id', async (c) => {
    const user = c.get('user');
    try {
      const task = await taskService.cancelTask(c.req.param('id'), user.imUserId);
      return c.json<ApiResponse>({ ok: true, data: await enrichTask(task) });
    } catch (err) {
      return handleTaskError(err, c);
    }
  });

  /**
   * POST /tasks/:id/reward — Issue credit reward to task completer
   */
  router.post('/:id/reward', async (c) => {
    const user = c.get('user');
    try {
      const result = await taskService.rewardTask(c.req.param('id'), user.imUserId);
      return c.json<ApiResponse>({ ok: true, data: result });
    } catch (err) {
      return handleTaskError(err, c);
    }
  });

  /**
   * GET /tasks/:id/subtasks — List subtasks of a parent task
   */
  router.get('/:id/subtasks', async (c) => {
    const user = c.get('user');
    try {
      const subtasks = await taskService.listSubtasks(c.req.param('id'), user.imUserId);
      const enriched = await enrichTasks(subtasks);
      return c.json<ApiResponse>({ ok: true, data: enriched, meta: { total: enriched.length } });
    } catch (err) {
      return handleTaskError(err, c);
    }
  });

  /**
   * GET /tasks/:id/summary — Subtask progress summary for a parent task
   */
  router.get('/:id/summary', async (c) => {
    const user = c.get('user');
    try {
      const summary = await taskService.getSubtaskSummary(c.req.param('id'), user.imUserId);
      return c.json<ApiResponse>({ ok: true, data: summary });
    } catch (err) {
      return handleTaskError(err, c);
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
      const task = await taskService.claimTask(c.req.param('id')!, user.imUserId);
      return c.json<ApiResponse>({ ok: true, data: await enrichTask(task) });
    } catch (err) {
      return handleTaskError(err, c);
    }
  });

  /**
   * POST /tasks/:id/progress — Report progress. Assignee only.
   * DEPRECATED: Use PATCH /tasks/:id with { progress, statusMessage } instead.
   */
  router.post('/:id/progress', async (c) => {
    const user = c.get('user');
    const body = await c.req.json();

    c.header('Deprecation', 'true');
    c.header('Sunset', '2026-07-01');
    c.header('Link', '</api/im/tasks/:id>; rel="successor-version"');

    try {
      await taskService.reportProgress(c.req.param('id')!, user.imUserId, {
        message: body.message,
        metadata: body.metadata,
      });
      return c.json<ApiResponse>({
        ok: true,
        meta: { deprecated: true, alternative: 'PATCH /tasks/:id with { progress, statusMessage }' },
      });
    } catch (err) {
      return handleTaskError(err, c);
    }
  });

  /**
   * POST /tasks/:id/approve — Approve task in review status → completed. Creator only.
   * Idempotent: re-approving a completed task returns 200.
   */
  router.post('/:id/approve', async (c) => {
    const user = c.get('user');
    try {
      const task = await taskService.approveTask(c.req.param('id'), user.imUserId);
      return c.json<ApiResponse>({ ok: true, data: await enrichTask(task) });
    } catch (err) {
      return handleTaskError(err, c);
    }
  });

  /**
   * POST /tasks/:id/reject — Reject task in review status → failed. Creator only.
   */
  router.post('/:id/reject', async (c) => {
    const user = c.get('user');
    const body = await c.req.json().catch(() => ({}));

    if (!body.reason || typeof body.reason !== 'string') {
      return validationErr(c, 'reason is required');
    }

    try {
      const task = await taskService.rejectTask(c.req.param('id'), user.imUserId, body.reason);
      return c.json<ApiResponse>({ ok: true, data: await enrichTask(task) });
    } catch (err) {
      return handleTaskError(err, c);
    }
  });

  /**
   * POST /tasks/:id/complete — Mark task completed. Assignee only.
   */
  router.post('/:id/complete', async (c) => {
    const user = c.get('user');
    const body = await c.req.json().catch(() => ({}));

    try {
      const task = await taskService.completeTask(c.req.param('id')!, user.imUserId, {
        result: body.result,
        resultUri: body.resultUri ?? body.result_uri,
        cost: body.cost,
      });
      return c.json<ApiResponse>({ ok: true, data: await enrichTask(task) });
    } catch (err) {
      return handleTaskError(err, c);
    }
  });

  /**
   * POST /tasks/:id/fail — Mark task failed. Assignee only.
   */
  router.post('/:id/fail', async (c) => {
    const user = c.get('user');
    const body = await c.req.json();

    if (!body.error || typeof body.error !== 'string') {
      return validationErr(c, 'error message is required');
    }

    try {
      const task = await taskService.failTask(c.req.param('id')!, user.imUserId, {
        error: body.error,
        metadata: body.metadata,
      });
      return c.json<ApiResponse>({ ok: true, data: await enrichTask(task) });
    } catch (err) {
      return handleTaskError(err, c);
    }
  });

  return router;
}
