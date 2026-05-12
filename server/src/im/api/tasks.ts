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
      select: { id: true, role: true, displayName: true, username: true },
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
      ownerType: creator?.role ?? null,
      ownerName: creator?.displayName ?? creator?.username ?? null,
      assigneeType: assignee?.role ?? null,
      assigneeName: assignee?.displayName ?? assignee?.username ?? null,
    };
  });
}

type UserInfo = { id: string; role: string; displayName: string | null; username: string };

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

    // Accept BOTH token shapes (54release Cloud 1.5):
    //   1. IM-internal JWT (legacy api_key_proxy path) — `sub` is im_users.id
    //   2. Platform JWT signed by native auth — `sub` is im_users.id (cuid)
    //      OR `user_id`/`numericId` is the cloud-side numeric user id.
    // Both sides share JWT_SECRET (see src/lib/auth/guard.ts and
    // src/im/config.ts), so verifyToken() accepts either; the resolution
    // below normalises to a single im_users.id we can query im_tasks against.
    let payload: { sub?: string; user_id?: number | string; numericId?: number };
    try {
      payload = verifyToken(token) as typeof payload;
    } catch {
      return c.json({ ok: false, error: { code: 'INVALID_TOKEN', message: 'Invalid or expired token' } }, 401);
    }

    if (!eventBusService) {
      return c.json({ ok: false, error: { code: 'SERVICE_UNAVAILABLE', message: 'Event bus not available' } }, 503);
    }

    // Resolve to im_users.id. Three shapes can land here:
    //   a) Native-auth platform JWT (NextAuth): `sub` is im_users.id (cuid).
    //   b) Legacy Go-backend JWT:               `user_id` is the cloud
    //                                           numericId (BIGINT-as-number).
    //   c) api_key_proxy translation (see src/lib/api-guard.ts:
    //      generateIMTokenForUser): `sub` is the api_key's owning user id
    //      rendered as a decimal STRING (e.g. "1"). For IMUsers created via
    //      this path, the `userId` column on im_users stores that same
    //      decimal string; the cuid `id` column is unrelated.
    // Resolution rules:
    //   - all-digits sub OR `user_id` claim → look up by im_users.userId
    //   - non-numeric sub → treat directly as im_users.id (cuid)
    let userId: string | null = null;
    const subStr = typeof payload.sub === 'string' ? payload.sub : '';
    const subIsNumeric = subStr.length > 0 && /^\d+$/.test(subStr);

    if (subStr.length > 0 && !subIsNumeric) {
      // cuid path
      userId = subStr;
    } else {
      const numericRaw = subIsNumeric ? subStr : payload.user_id;
      const numericStr =
        numericRaw == null ? null : typeof numericRaw === 'number' ? String(numericRaw) : String(numericRaw);
      if (numericStr) {
        const imUser = await prisma.iMUser.findFirst({
          where: { userId: numericStr, role: 'human' },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        });
        userId = imUser?.id ?? null;
      }
    }
    if (!userId) {
      return c.json(
        { ok: false, error: { code: 'INVALID_TOKEN', message: 'Token payload missing user identity' } },
        401,
      );
    }

    // Active-account check: deletion (banned=true) and suspension must
    // immediately deny new SSE subscriptions, even if the JWT itself is
    // still cryptographically valid. Active streams are still bounded by
    // the SSE error budget below.
    try {
      const userRow = await prisma.iMUser.findUnique({
        where: { id: userId },
        select: { banned: true, suspendedUntil: true },
      });
      if (!userRow) {
        return c.json({ ok: false, error: { code: 'INVALID_TOKEN', message: 'Account not found' } }, 401);
      }
      if (userRow.banned || (userRow.suspendedUntil && userRow.suspendedUntil > new Date())) {
        return c.json({ ok: false, error: { code: 'ACCOUNT_INACTIVE', message: 'Account is inactive' } }, 401);
      }
    } catch (err) {
      log.warn({ err, userId }, 'SSE account-active check failed; rejecting');
      return c.json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Auth check failed' } }, 500);
    }

    // Support reconnection: use Last-Event-ID timestamp if available
    const lastEventIdHeader = c.req.header('Last-Event-ID');
    const initialTime = lastEventIdHeader ? parseInt(lastEventIdHeader, 10) || Date.now() : Date.now();

    return streamSSE(c, async (stream) => {
      let closed = false;
      stream.onAbort(() => {
        closed = true;
      });

      // Flush an initial `connected` event immediately. This forces the
      // response headers (Content-Type: text/event-stream) out of the Node
      // server's buffer right away, so EventSource on the browser side
      // transitions to OPEN within ~10ms instead of waiting for the first
      // keepalive 30s later. Otherwise Next.js holds the headers until the
      // first body byte and the client times out / falls back to polling.
      try {
        await stream.writeSSE({ event: 'connected', data: JSON.stringify({ ts: Date.now() }) });
      } catch {
        closed = true;
      }

      const keepalive = setInterval(() => {
        if (!closed) {
          stream.writeSSE({ event: 'ping', data: '' }).catch(() => {
            closed = true;
          });
        }
      }, 30000);

      // ─── Catch-up: tasks updated since reconnect cursor ───────────────
      // Replaces the pre-Wave-5 2s polling tick. We emit one snapshot per
      // recently-touched task as `task.updated` so the mobile decoder's
      // back-compat path stays warm during reconnects (it reads the same
      // shape we used to publish on every poll). Live transitions arrive
      // via the EventBus subscription below.
      try {
        const since = lastEventIdHeader ? new Date(initialTime) : new Date(Date.now() - 30_000);
        const recent = await prisma.iMTask.findMany({
          where: {
            OR: [{ creatorId: userId }, { assigneeId: userId }],
            updatedAt: { gt: since },
          },
          orderBy: { updatedAt: 'asc' },
          take: 50,
        });
        for (const task of recent) {
          if (closed) break;
          await stream.writeSSE({
            event: 'task.updated',
            data: JSON.stringify({
              taskId: task.id,
              conversationId: task.conversationId ?? null,
              title: task.title,
              status: task.status,
              progress: (task as any).progress,
              statusMessage: (task as any).statusMessage,
              updatedAt: task.updatedAt,
            }),
            id: String(task.updatedAt.getTime()),
          });
        }
      } catch (err) {
        log.warn({ err }, `SSE catch-up failed for user ${userId} (continuing without backlog)`);
      }

      // ─── Live: subscribe to typed task.* events ───────────────────────
      // EventBusService.publish emits in-process via localEmitter (added
      // Wave-5). We filter to events whose data references the connected
      // user (creator OR assignee) and project the EventBus payload into
      // the cookbook §events shape. Cookbook MD authoritative — see
      // docs/cookbook/task-agent-orchestration.md §events table.
      let consecutiveSendErrors = 0;
      const onEvent = async (evt: { type: string; timestamp?: number; data?: unknown }) => {
        if (closed) return;
        if (!evt.type.startsWith('task.')) return;
        const data = (evt.data ?? {}) as Record<string, any>;
        // Filter: this user must be creator OR assignee (or no filterable
        // identity, in which case skip — never broadcast unfiltered task
        // events to a user who isn't on the task).
        if (data.creatorId !== userId && data.assigneeId !== userId) return;

        const payload = buildTaskSSEPayload(evt.type, data);
        try {
          await stream.writeSSE({
            event: evt.type,
            data: JSON.stringify(payload),
            id: String(evt.timestamp ?? Date.now()),
          });
          consecutiveSendErrors = 0;
        } catch (err) {
          consecutiveSendErrors++;
          log.warn(
            { err },
            `SSE writeSSE failed for ${evt.type} user=${userId} (${consecutiveSendErrors}/${MAX_SSE_ERRORS})`,
          );
          if (consecutiveSendErrors >= MAX_SSE_ERRORS) {
            log.error(`SSE stream closing after ${consecutiveSendErrors} write errors for user ${userId}`);
            closed = true;
          }
        }
      };
      const unsubscribe = eventBusService.onLocalEvent(onEvent);

      // Hold the connection open until the client aborts. Hono's streamSSE
      // tears down the response when this handler returns, so we park here
      // on a 1s timer (cheap; no DB work).
      while (!closed) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      unsubscribe();
      clearInterval(keepalive);
    });
  });
}

/**
 * Project the EventBus event payload (which carries internal fields like
 * creatorId, capability) into the public SSE shape mobile + web subscribe
 * to. Cookbook §events table is authoritative — see
 * `docs/cookbook/task-agent-orchestration.md`.
 *
 * `task.failed` payload uses `error: string` (matches IMTask.error TEXT
 * column + cookbook script's `typeof === 'string'` assertion). The
 * `{code, message}` shape from cookbook §payload-shapes line 423 is the
 * daemon→cloud WS protocol (`task.dispatch.reply.error`), distinct from
 * the cloud→client SSE wire. Cloud serialises `{code, message}` to a
 * string before storing/publishing.
 */
function buildTaskSSEPayload(type: string, data: Record<string, any>): Record<string, unknown> {
  // Wave-7: conversationId is forwarded for every task.* event so the
  // chat surface (web ImChannel, mobile ChatDetailView) can render an
  // ephemeral "thinking / executing" row without a separate /tasks/:id
  // round-trip per dispatch. Producers that don't carry conversationId
  // (e.g. legacy task.updated catch-up rows) just emit null.
  const base: Record<string, unknown> = {
    taskId: data.taskId,
    conversationId: typeof data.conversationId === 'string' ? data.conversationId : null,
  };
  switch (type) {
    case 'task.created':
      return {
        ...base,
        title: data.title,
        capability: data.capability ?? null,
        status: data.assigneeId ? 'assigned' : 'pending',
      };
    case 'task.assigned':
      return { ...base, assigneeId: data.assigneeId ?? null };
    case 'task.progress':
      return {
        ...base,
        progress: typeof data.progress === 'number' ? data.progress : null,
        statusMessage: typeof data.statusMessage === 'string' ? data.statusMessage : null,
      };
    case 'task.completed':
      return {
        ...base,
        output: data.output ?? null,
        metrics: data.metrics ?? null,
      };
    case 'task.failed':
      return {
        ...base,
        // string. See doc above for why.
        error: typeof data.error === 'string' ? data.error : data.error == null ? null : String(data.error),
      };
    case 'task.cancelled':
      return { ...base, by: data.by ?? null };
    case 'task.updated':
      // Deprecated event kept for one wave so reconnecting clients with
      // Last-Event-ID still see snapshot-style data they can diff.
      return {
        ...base,
        title: data.title ?? null,
        status: data.status ?? null,
        progress: data.progress ?? null,
        statusMessage: data.statusMessage ?? null,
      };
    default:
      // Forward any other task.* event with the original data — keeps the
      // SSE stream useful when new event types ship before mobile updates.
      return { ...base, ...data };
  }
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

    // Validate runtimeRoute (Cloud 3 / S3 — execution surface)
    const runtimeRoute = body.runtimeRoute ?? body.runtime_route ?? 'agent';
    if (!['agent', 'sandbox', 'shell'].includes(runtimeRoute)) {
      return validationErr(c, "runtimeRoute must be 'agent', 'sandbox', or 'shell'");
    }

    // workspaceId is NOT NULL on im_tasks (migration 120). If the
    // caller didn't pass one, fall back to the user's default Personal
    // workspace — every human user has one (backfill ensures it).
    let workspaceId: string | undefined = body.workspaceId ?? body.workspace_id;
    if (!workspaceId) {
      try {
        const defaultWs = await prisma.iMWorkspace.findFirst({
          where: { ownerImUserId: user.imUserId, isDefault: true },
          select: { id: true },
        });
        workspaceId = defaultWs?.id;
      } catch {
        /* ignore — let create fail with a clear NOT NULL error if no default */
      }
    }

    try {
      const task = await taskService.createTask(user.imUserId, {
        title: body.title,
        description: body.description,
        capability: body.capability,
        input: body.input,
        contextUri: body.contextUri ?? body.context_uri,
        assigneeId: body.assigneeId ?? body.assignee_id,
        workspaceId,
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
        runtimeRoute,
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
   * Query params: status, capability, kind, view, assigneeId, creatorId,
   * scheduleType, limit, cursor
   */
  router.get('/', async (c) => {
    const user = c.get('user');
    const query = {
      status: c.req.query('status') as TaskStatus | undefined,
      capability: c.req.query('capability'),
      kind: c.req.query('kind'),
      view: c.req.query('view'),
      taskId: c.req.query('taskId') ?? c.req.query('task_id'),
      sourceKind: c.req.query('sourceKind') ?? c.req.query('source_kind'),
      assigneeId: c.req.query('assigneeId') ?? c.req.query('assignee_id'),
      creatorId: c.req.query('creatorId') ?? c.req.query('creator_id'),
      workspaceId: c.req.query('workspaceId') ?? c.req.query('workspace_id'),
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

    if (query.view === 'runs') {
      const [createdRuns, assignedRuns] = await Promise.all([
        taskService.listTaskRuns(
          {
            workspaceId: query.workspaceId,
            conversationId: query.conversationId,
            taskId: query.taskId,
            sourceKind: query.sourceKind,
            status: query.status,
            creatorId: user.imUserId,
            limit: query.limit,
            cursor: query.cursor,
          },
          user.imUserId,
        ),
        taskService.listTaskRuns(
          {
            workspaceId: query.workspaceId,
            conversationId: query.conversationId,
            taskId: query.taskId,
            sourceKind: query.sourceKind,
            status: query.status,
            assigneeId: user.imUserId,
            limit: query.limit,
            cursor: query.cursor,
          },
          user.imUserId,
        ),
      ]);
      const seen = new Set<string>();
      const runs = [...createdRuns, ...assignedRuns].filter((run) => {
        if (seen.has(run.id)) return false;
        seen.add(run.id);
        return true;
      });
      return c.json({ ok: true, data: runs, meta: { total: runs.length, nextCursor: runs.at(-1)?.id ?? null } });
    }

    // If no filter specified, default to tasks relevant to this user
    const hasExplicitViewOrKind = Boolean(query.view || query.kind);
    if (!hasExplicitViewOrKind && !query.status && !query.capability && !query.assigneeId && !query.creatorId) {
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

  /**
   * GET /tasks/runs — List execution runs.
   */
  router.get('/runs', async (c) => {
    const user = c.get('user');
    const runs = await taskService.listTaskRuns(
      {
        workspaceId: c.req.query('workspaceId') ?? c.req.query('workspace_id'),
        conversationId: c.req.query('conversationId') ?? c.req.query('conversation_id'),
        taskId: c.req.query('taskId') ?? c.req.query('task_id'),
        status: c.req.query('status') ?? undefined,
        sourceKind: c.req.query('sourceKind') ?? c.req.query('source_kind'),
        creatorId: c.req.query('mine') === 'assigned' ? undefined : user.imUserId,
        assigneeId: c.req.query('mine') === 'created' ? undefined : user.imUserId,
        limit: c.req.query('limit') ? parseInt(c.req.query('limit')!) : undefined,
        cursor: c.req.query('cursor') ?? undefined,
      },
      user.imUserId,
    );
    return c.json<ApiResponse>({
      ok: true,
      data: runs,
      meta: { total: runs.length, nextCursor: runs.at(-1)?.id ?? null },
    });
  });

  /**
   * POST /tasks/:id/runs — Create a task run
   */
  router.post('/:id/runs', async (c) => {
    const user = c.get('user');
    const body = await c.req.json().catch(() => ({}));
    try {
      const run = await taskService.createTaskRun(c.req.param('id'), user.imUserId, {
        status: typeof body.status === 'string' ? body.status : undefined,
        runtimeRoute: typeof body.runtimeRoute === 'string' ? body.runtimeRoute : undefined,
        input: body.input && typeof body.input === 'object' ? body.input : undefined,
        output: body.output,
        outputUri: body.outputUri ?? body.output_uri,
        error: body.error,
        metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : undefined,
      });
      return c.json<ApiResponse>({ ok: true, data: run }, 201);
    } catch (err) {
      return handleTaskError(err, c);
    }
  });

  /**
   * GET /tasks/:id/runs — List runs for a task
   */
  router.get('/:id/runs', async (c) => {
    const user = c.get('user');
    try {
      await taskService.getTask(c.req.param('id'), user.imUserId);
      const runs = await taskService.listTaskRuns(
        {
          taskId: c.req.param('id'),
          status: c.req.query('status') ?? undefined,
          limit: c.req.query('limit') ? parseInt(c.req.query('limit')!) : undefined,
          cursor: c.req.query('cursor') ?? undefined,
        },
        user.imUserId,
      );
      return c.json<ApiResponse>({ ok: true, data: runs, meta: { total: runs.length } });
    } catch (err) {
      return handleTaskError(err, c);
    }
  });

  /**
   * GET /tasks/runs/:runId — Fetch a single run
   */
  router.get('/runs/:runId', async (c) => {
    const user = c.get('user');
    try {
      const result = await taskService.getTaskRunWithEvents(c.req.param('runId'), user.imUserId);
      return c.json<ApiResponse>({ ok: true, data: result });
    } catch (err) {
      return handleTaskError(err, c);
    }
  });

  /**
   * GET /tasks/runs/:runId/events — List run events
   */
  router.get('/runs/:runId/events', async (c) => {
    const user = c.get('user');
    try {
      const result = await taskService.getTaskRunWithEvents(c.req.param('runId'), user.imUserId);
      return c.json<ApiResponse>({ ok: true, data: result.events, meta: { total: result.events.length } });
    } catch (err) {
      return handleTaskError(err, c);
    }
  });

  /**
   * PATCH /tasks/runs/:runId — Update run status/result shell
   */
  router.patch('/runs/:runId', async (c) => {
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
      return handleTaskError(err, c);
    }
  });

  /**
   * POST /tasks/runs/:runId/events — Append a run event
   */
  router.post('/runs/:runId/events', async (c) => {
    const user = c.get('user');
    const body = await c.req.json().catch(() => ({}));
    if (!body.type || typeof body.type !== 'string') {
      return validationErr(c, 'type is required');
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
      return handleTaskError(err, c);
    }
  });

  // SSE route registered before authMiddleware via registerSSERoute()

  /**
   * GET /tasks/:id — Task details with logs (creator, assignee, or marketplace)
   */
  router.get('/:id', async (c) => {
    const user = c.get('user');
    try {
      const result = await taskService.getTaskWithLogs(c.req.param('id')!, user.imUserId);
      return c.json<ApiResponse>({ ok: true, data: result });
    } catch (err) {
      return handleTaskError(err, c);
    }
  });

  /**
   * GET /tasks/:id/result — canonical task result (Wave-9 Phase 1).
   *
   * Replaces the legacy IMAsset(kind=task-result) read pattern. Shape locked:
   *   { taskId, status, output, metrics?, assetIds: string[],
   *     resultUri?: string|null, completedAt: string }
   *
   * Access: creator, assignee, or anyone with marketplace visibility on the
   * task — checkReadAccess inside TaskService is the single source of truth.
   */
  router.get('/:id/result', async (c) => {
    const user = c.get('user');
    try {
      const data = await taskService.getTaskResult(c.req.param('id'), user.imUserId);
      return c.json<ApiResponse>({ ok: true, data });
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
        assigneeId: body.assigneeId ?? body.assignee_id,
        status: body.status,
        forceExecutionStatus: Boolean(body.forceExecutionStatus ?? body.force_execution_status),
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
      return c.json<ApiResponse>({ ok: true, data: task });
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
   * POST /tasks/:id/start — Force task into running status. Creator only.
   * Sugar over forceExecutionStatus('running'); reuses creator-only permission + agent_run dispatch.
   */
  router.post('/:id/start', async (c) => {
    const user = c.get('user');
    const body = await c.req.json().catch(() => ({}));
    try {
      const task = await taskService.forceExecutionStatus(c.req.param('id'), user.imUserId, 'running', {
        reason: body.reason,
      });
      return c.json<ApiResponse>({ ok: true, data: await enrichTask(task) });
    } catch (err) {
      return handleTaskError(err, c);
    }
  });

  /**
   * POST /tasks/:id/pause — Force task back into pending status (paused). Creator only.
   */
  router.post('/:id/pause', async (c) => {
    const user = c.get('user');
    const body = await c.req.json().catch(() => ({}));
    try {
      const task = await taskService.forceExecutionStatus(c.req.param('id'), user.imUserId, 'pending', {
        reason: body.reason ?? 'Paused by user',
        metadata: { pausedBy: user.imUserId, pausedAt: new Date().toISOString() },
      });
      return c.json<ApiResponse>({ ok: true, data: await enrichTask(task) });
    } catch (err) {
      return handleTaskError(err, c);
    }
  });

  /**
   * POST /tasks/:id/reopen — Force task back into pending status (reopened). Creator only.
   */
  router.post('/:id/reopen', async (c) => {
    const user = c.get('user');
    const body = await c.req.json().catch(() => ({}));
    try {
      const task = await taskService.forceExecutionStatus(c.req.param('id'), user.imUserId, 'pending', {
        reason: body.reason ?? 'Reopened by user',
        metadata: { reopenedBy: user.imUserId, reopenedAt: new Date().toISOString() },
      });
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
