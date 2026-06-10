/**
 * Prismer IM — Task API (v1.8.2 + v2.0 release 200 P3)
 *
 * POST   /tasks                          Create task
 * GET    /tasks                          List tasks (?status=pending&capability=X&conversationId=Y)
 * GET    /tasks/marketplace              Browse available tasks (pending, unassigned)
 * GET    /tasks/events                   SSE task event stream (Phase 3)
 * GET    /tasks/:id                     Task details (with logs)
 * PATCH  /tasks/:id                     Update task (creator: title/desc/assign/cancel, assignee: progress/status)
 * DELETE /tasks/:id                     Cancel task (soft delete, creator only)
 * POST   /tasks/:id/claim               Agent claims a pending task
 * POST   /tasks/:id/transition          [v2.0] Unified state-machine transition (kanban / approve / reject / cancel / blocked)
 * POST   /tasks/:id/force-transition    [v2.0] Admin escape-hatch (owner / admin / trustTier>=4)
 * POST   /tasks/:id/progress            [DEPRECATED] Use PATCH with progress/statusMessage
 * POST   /tasks/:id/complete            Mark completed
 * POST   /tasks/:id/fail                Mark failed
 * POST   /tasks/:id/approve             Approve task in review (creator only)
 * POST   /tasks/:id/reject              Reject task in review (creator only)
 * POST   /tasks/:id/reward              Issue credit reward to completer
 * GET    /tasks/:id/subtasks            List subtasks of a parent task
 * GET    /tasks/:id/summary             Subtask progress summary
 */

import { Hono } from 'hono';
import { authMiddleware } from '../auth/middleware';
import { TaskService } from '../services/task.service';
import { getTaskAcceptanceService, AcceptanceError } from '../services/task-acceptance.service';
import { getTodoService, TodoError } from '../services/todo.service';
import { getTaskSpecService, SpecError } from '../services/task-spec.service';
import { TaskStepRecorderService } from '../services/task-step-recorder.service';
import type { RateLimiterService } from '../services/rate-limiter.service';
import { createRateLimitMiddleware } from '../middleware/rate-limit';
import type { ApiResponse, TaskInfo, TaskStatus, ScheduleType } from '../types';
import type { EventBusService } from '../services/event-bus.service';
import { verifyToken } from '../auth/jwt';
import { streamSSE } from 'hono/streaming';
import { createModuleLogger } from '../../lib/logger';
import prisma from '../db';
import { requireAgentToolAllowed, requireAgentToolAllowedForTask } from '../security/mcp-allowlist';

const log = createModuleLogger('TaskAPI');

// ─── Structured error helper (v1.8.2) ───────────────────────
// Returns { ok:false, error: { code, message } } per docs/DESIGN-v1.8.2 §2b.
// Codes: TASK_NOT_FOUND | TASK_ACCESS_DENIED | INVALID_STATE_TRANSITION |
//        TASK_CLAIM_FAILED | INSUFFICIENT_BUDGET | VALIDATION_ERROR | INTERNAL_ERROR |
//        ORCHESTRATOR_REQUIRED

type TaskErrorResult = { status: 400 | 402 | 403 | 404 | 409 | 422 | 500; code: string; message: string };

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
    case 'OrchestratorRequiredError':
      return { code: 'ORCHESTRATOR_REQUIRED', message: err.message, status: 403 };
    case 'InsufficientBudgetError':
      return { code: 'INSUFFICIENT_BUDGET', message: err.message, status: 402 };
    // v2.0 release 200 P3 — structured transition errors (matrix-aware).
    case 'InvalidTransitionError':
      return { code: 'invalid-transition', message: err.message, status: 409 };
    case 'TaskForbiddenError':
      return { code: 'forbidden', message: err.message, status: 403 };
    // release201/10 rev 2 §4.4 — acceptance gate errors must surface as 422
    // with structured error.code (acceptance_evidence_missing /
    // acceptance_self_check_incomplete / todo_completion_below_threshold /
    // etc). AcceptanceError can leak out of `handleTaskError` when raised
    // from the transition path (running→review gate). v2.0.7.1 hotfix B4.
    case 'AcceptanceError': {
      const e = err as AcceptanceError;
      // AcceptanceError carries its own status (400 / 404 / 422). Respect
      // it but clamp to the supported union.
      const allowed = [400, 404, 422] as const;
      const status = (allowed as readonly number[]).includes(e.status) ? (e.status as 400 | 404 | 422) : 422;
      return { code: e.code, message: e.message, status };
    }
    default:
      return null;
  }
}

/**
 * Handle a task error: return a JSON response or re-throw if unknown.
 *
 * v2.0 release 200 P3 — `InvalidTransitionError` and `TaskForbiddenError`
 * carry structured fields (allowedFromHere, actorTier, requiredTiers).
 * We inline them into the error envelope per spec §6.1.
 */
function handleTaskError(err: unknown, c: any): Response | never {
  const classified = classifyTaskError(err);
  if (classified) {
    const envelope: Record<string, unknown> = {
      code: classified.code,
      message: classified.message,
    };
    if (err instanceof Error && err.name === 'InvalidTransitionError') {
      const e = err as { from?: string; to?: string; allowedFromHere?: string[] };
      envelope.from = e.from;
      envelope.to = e.to;
      envelope.allowedFromHere = e.allowedFromHere ?? [];
    }
    if (err instanceof Error && err.name === 'TaskForbiddenError') {
      const e = err as { actorTier?: string; requiredTiers?: string[] };
      envelope.actorTier = e.actorTier;
      envelope.requiredTiers = e.requiredTiers ?? [];
    }
    // AcceptanceError carries an optional `detail` map (e.g. progressPct
    // for todo_completion_below_threshold). Mirror handleAcceptanceError
    // by spreading it onto the envelope so callers see the same shape on
    // either error path.
    if (err instanceof Error && err.name === 'AcceptanceError') {
      const e = err as AcceptanceError;
      if (e.detail) Object.assign(envelope, e.detail);
    }
    return c.json({ ok: false, error: envelope }, classified.status);
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

// ─── Asset reference validation (Wave-8 W1 — L1 task creation) ─────────────
//
// Wave-8 W1 wired the daemon side: `DispatchPayload.assetRefs` is hydrated
// by `task.service.ts::resolveAssetRefs` from `metadata.assets.linkedAssetIds`
// and the daemon's `resolveAssetRefs` inlines text / exposes binaries as
// `file://<cache>`. The cloud API had no surface for callers to attach
// assets when CREATING a task — production `assetRefs[]` was always empty.
//
// L1 closes that gap. Callers send `assetRefs: [{ assetId, contentHash?, ... }]`;
// we validate (workspace-scoped, must exist, deletedAt IS NULL) and fold the
// asset IDs into `metadata.assets.linkedAssetIds` so the existing dispatch
// hydrator picks them up at dispatch time. Both this path AND the legacy
// `prismer://...`-in-prompt-text path coexist — daemon's `uriResolver.rewrite`
// handles the in-text URIs, and `assetRefs[]` is the structured channel.
type AssetRefInput = {
  assetId: string;
  contentHash?: string;
  mime?: string | null;
  sizeBytes?: number | null;
  workspaceId?: string;
};

/**
 * Validate `body.assetRefs` against `im_assets` for the given workspace.
 *
 * Returns either:
 *   - `{ ok: true, assetIds }` — dedup'd id list (preserves order) to fold
 *     into `metadata.assets.linkedAssetIds`. Empty array is treated as no-op.
 *   - `{ ok: false, status, message }` — caller should short-circuit with
 *     the indicated HTTP status (400 cross-workspace / bad shape, 404
 *     missing row).
 */
async function validateAssetRefs(
  raw: unknown,
  workspaceId: string,
): Promise<{ ok: true; assetIds: string[] } | { ok: false; status: 400 | 404; message: string }> {
  if (raw === undefined || raw === null) return { ok: true, assetIds: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, status: 400, message: 'assetRefs must be an array' };
  }
  if (raw.length === 0) return { ok: true, assetIds: [] };
  // Generous cap so a runaway client can't ship 10k refs and trigger an
  // OOM in JSON.stringify (metadata column stores JSON as TEXT).
  if (raw.length > 100) {
    return { ok: false, status: 400, message: 'assetRefs[] is capped at 100 entries' };
  }

  const seen = new Set<string>();
  const ids: string[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') {
      return { ok: false, status: 400, message: 'assetRefs[] entries must be objects with an assetId field' };
    }
    const e = entry as AssetRefInput;
    if (typeof e.assetId !== 'string' || e.assetId.length === 0) {
      return { ok: false, status: 400, message: 'assetRefs[].assetId is required (string)' };
    }
    // Reject cross-workspace ref BEFORE we hit the DB so callers see a
    // 400 instead of a 404 (cross-workspace is "you asked the wrong
    // workspace," missing row is "the row doesn't exist anywhere").
    if (e.workspaceId !== undefined && e.workspaceId !== workspaceId) {
      return {
        ok: false,
        status: 400,
        message: `assetRefs[].workspaceId mismatch — ${e.workspaceId} vs task workspaceId ${workspaceId}`,
      };
    }
    if (!seen.has(e.assetId)) {
      seen.add(e.assetId);
      ids.push(e.assetId);
    }
  }

  const rows = await prisma.iMAsset.findMany({
    where: { id: { in: ids }, workspaceId, deletedAt: null },
    select: { id: true },
  });
  const found = new Set(rows.map((r: { id: string }) => r.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    return {
      ok: false,
      status: 404,
      message: `assetRefs reference missing asset(s) in workspace ${workspaceId}: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ` (+${missing.length - 3} more)` : ''}`,
    };
  }
  return { ok: true, assetIds: ids };
}

/**
 * Fold the validated asset id list into a metadata object's
 * `metadata.assets.linkedAssetIds` slot, preserving any other `metadata.assets.*`
 * (e.g. `aggregatedAssetIds` written by message.service).
 *
 * Two intents the caller can express:
 *   - `force: true` — caller EXPLICITLY sent `assetRefs` in the body, even
 *     if the resulting `assetIds` list is empty. We write `linkedAssetIds`
 *     (including `[]`) so the field clears. This is the only way for a
 *     PATCH to drop previously-attached refs once the user removes the
 *     last URI from the description.
 *   - `force: false` (default) — caller didn't send `assetRefs`. We skip
 *     the write entirely (and an empty new-list is treated as "nothing to
 *     write" rather than "explicit clear") so a status/progress PATCH
 *     never accidentally wipes attachments.
 */
function mergeLinkedAssetIds(
  metadata: Record<string, unknown> | undefined,
  assetIds: string[],
  opts: { force?: boolean } = {},
): Record<string, unknown> | undefined {
  if (!opts.force && assetIds.length === 0) return metadata;
  const base: Record<string, unknown> = metadata ? { ...metadata } : {};
  const existingAssets =
    base.assets && typeof base.assets === 'object' && !Array.isArray(base.assets)
      ? { ...(base.assets as Record<string, unknown>) }
      : {};
  existingAssets.linkedAssetIds = assetIds;
  base.assets = existingAssets;
  return base;
}

// ─── Deprecation helpers (v2.0 release 200 P8) ────────────────
// See docs/release200/15-task-state-machine-and-kanban.md §6.3 +
// docs/migrations/v2.0/tasks-endpoint-migration.md.
//
// 5 task action endpoints (start / complete / approve / reject /
// cancel-via-DELETE) plus the status / assigneeId / forceExecutionStatus
// / progress / statusMessage fields on PATCH have been superseded by
// the unified POST /tasks/:id/transition endpoint (P3).
//
// During the v2.0 → 2026-09-01 window the legacy paths still work
// unchanged (backward compat); they only emit RFC 8594-style headers
// + a non-blocking `_deprecation` envelope and a server-side warning
// log. Hard rejection lands 3 sprints later — do **not** add rejection
// logic here.
const DEPRECATION_SUNSET = '2026-09-01';
const DEPRECATION_SUCCESSOR = '/api/im/tasks/:id/transition';

interface DeprecationInfo {
  endpoint: string;
  successor: string;
  sunset: string;
  note: string;
  fields?: string[]; // optional list of deprecated body fields (for PATCH)
}

function markDeprecated(c: any, endpoint: string, opts: { fields?: string[]; actorId?: string } = {}): DeprecationInfo {
  c.header('Deprecation', 'true');
  c.header('Sunset', DEPRECATION_SUNSET);
  c.header('Link', `<${DEPRECATION_SUCCESSOR}>; rel="successor-version"`);
  const fieldSuffix = opts.fields && opts.fields.length > 0 ? ` (fields: ${opts.fields.join(',')})` : '';
  log.warn(
    {
      endpoint,
      successor: DEPRECATION_SUCCESSOR,
      sunset: DEPRECATION_SUNSET,
      fields: opts.fields,
      caller: opts.actorId,
    },
    `[tasks API] DEPRECATED endpoint called: ${endpoint}${fieldSuffix}; use POST /tasks/:id/transition instead. caller=${opts.actorId ?? 'unknown'}`,
  );
  const info: DeprecationInfo = {
    endpoint,
    successor: DEPRECATION_SUCCESSOR,
    sunset: DEPRECATION_SUNSET,
    note: 'Use the unified /transition endpoint',
  };
  if (opts.fields && opts.fields.length > 0) info.fields = opts.fields;
  return info;
}

/**
 * Body fields on PATCH /tasks/:id that should route through /transition
 * instead. Detection lives here (not the route handler) so the test suite
 * can cover the snake_case aliases without re-implementing the logic.
 */
function detectDeprecatedPatchFields(body: Record<string, unknown>): string[] {
  const deprecated: string[] = [];
  if ('status' in body) deprecated.push('status');
  if ('assigneeId' in body || 'assignee_id' in body) deprecated.push('assigneeId');
  if ('forceExecutionStatus' in body || 'force_execution_status' in body) deprecated.push('forceExecutionStatus');
  if ('progress' in body) deprecated.push('progress');
  if ('statusMessage' in body || 'status_message' in body) deprecated.push('statusMessage');
  return deprecated;
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

/**
 * P2 (2026-05-25) — cursor-based replay cap. See sync-stream.ts header
 * for rationale. Same value (500) — both endpoints share the same
 * "stale client allowance" budget.
 */
const TASK_EVENTS_BACKFILL_CAP = 500;

/**
 * GET /tasks/events — SSE task lifecycle stream.
 *
 * Query params:
 *   token  — JWT auth (api_key_proxy or platform JWT both accepted)
 *   since  — (P2 2026-05-25) optional IMSyncEvent.id cursor. When > 0,
 *            cloud replays persisted `task.*` events with seq > since
 *            (capped at TASK_EVENTS_BACKFILL_CAP), marks each envelope
 *            `replayed: true`, then emits `sync.backfill.done` or
 *            `sync.backfill.truncated` before attaching the live
 *            EventBus subscription. When 0 / absent, falls back to the
 *            legacy 30s time-based catch-up via IMTask.updatedAt.
 *
 * Reconnect protocol mirrors /sync/stream — clients persist last-seen
 * seq via sse-cursor.ts (stream key 'tasks-events') and pass it back on
 * EventSource reconnect.
 */
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

    // P2 (2026-05-25) — cursor-based replay. `since` is the last
    // IMSyncEvent.id the client persisted. When provided we prefer it
    // over the time-based catch-up below since it's gap-free for
    // persisted `task.*` events (task.phase.stuck / .recovered /
    // .step.appended). EventBus-only events (task.completed etc) are
    // still surfaced via the IMTask.updatedAt snapshot fallback so a
    // long-disconnected client still sees terminal states.
    const sinceCursor = parseInt(c.req.query('since') ?? '0', 10);
    const useCursorBackfill = Number.isFinite(sinceCursor) && sinceCursor > 0;

    return streamSSE(c, async (stream) => {
      let closed = false;
      let truncated = false;
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

      // ─── P2: cursor backfill from IMSyncEvent (persisted task.* events) ──
      // When client provided a `since` cursor, replay persisted task.*
      // sync events with id > since (capped at TASK_EVENTS_BACKFILL_CAP).
      // This covers task.phase.stuck/.recovered/.step.appended which
      // syncService.writeEvent persists per recipient. EventBus-only
      // events (task.completed / .failed / .progress) are not in
      // IMSyncEvent — the time-based IMTask.updatedAt snapshot below
      // catches their terminal state regardless.
      if (useCursorBackfill) {
        try {
          let drained = 0;
          let cursor = sinceCursor;
          let firstReplayedSeq: number | null = null;
          let lastReplayedSeq: number | null = null;
          let hasMore = true;

          while (!closed && hasMore && drained < TASK_EVENTS_BACKFILL_CAP) {
            const pageLimit = Math.min(100, TASK_EVENTS_BACKFILL_CAP - drained);
            const page = await prisma.iMSyncEvent.findMany({
              where: {
                imUserId: userId,
                id: { gt: cursor },
                type: { startsWith: 'task.' },
              },
              orderBy: { id: 'asc' },
              take: pageLimit + 1,
            });
            hasMore = page.length > pageLimit;
            const batch = hasMore ? page.slice(0, pageLimit) : page;
            for (const row of batch) {
              if (closed) break;
              if (firstReplayedSeq === null) firstReplayedSeq = row.id;
              lastReplayedSeq = row.id;
              let parsed: Record<string, unknown> = {};
              try {
                parsed = JSON.parse(row.data ?? '{}');
              } catch {
                /* malformed row — emit empty payload */
              }
              const payload = buildTaskSSEPayload(row.type, parsed as Record<string, unknown>);
              await stream.writeSSE({
                event: row.type,
                data: JSON.stringify({ ...payload, replayed: true, seq: row.id }),
                id: String(row.id),
              });
              drained += 1;
              cursor = row.id;
              if (drained >= TASK_EVENTS_BACKFILL_CAP) break;
            }
          }

          if (!closed) {
            if (hasMore && drained >= TASK_EVENTS_BACKFILL_CAP) {
              truncated = true;
              await stream.writeSSE({
                event: 'sync.backfill.truncated',
                data: JSON.stringify({
                  type: 'sync.backfill.truncated',
                  oldestSeq: firstReplayedSeq,
                  newestSeq: lastReplayedSeq,
                  totalSeen: drained,
                  replayed: true,
                }),
              });
            } else {
              await stream.writeSSE({
                event: 'sync.backfill.done',
                data: JSON.stringify({
                  type: 'sync.backfill.done',
                  seq: lastReplayedSeq ?? sinceCursor,
                  replayed: true,
                }),
              });
            }
          }
        } catch (err) {
          log.warn({ err }, `SSE cursor backfill failed for user ${userId} (continuing with time-based catch-up)`);
        }

        if (truncated) {
          // Close the stream — client will reconnect with the newest
          // replayed seq (or a refreshed bootstrap) on its own.
          clearInterval(keepalive);
          return;
        }
      }

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
        // Filter: this user must be on the task in one of the documented
        // payload shapes.
        //
        //   Shape A — legacy task lifecycle events (task.created /
        //             task.assigned / task.progress / etc) carry
        //             `creatorId` + `assigneeId` directly.
        //   Shape B — task.spec.updated / task.todo.changed (release201/10
        //             rev 2 §6.5) carry `byActorId` + `recipientHint`. The
        //             recipientHint is the assignee (for spec.updated, doc
        //             §6.5 line 928) or the creator (for todo.changed,
        //             line 929). The actor that wrote the event also sees
        //             it (so the writing user's own UI updates).
        //
        // v2.0.7.1 hotfix B8 — Shape B was dropping events for both creator
        // and assignee, breaking doc 10 §4.2's "creator subscribes" promise.
        // A future v2.0.8 pass should probably fold a single canonical
        // shape (carrying both creatorId + assigneeId) on the publisher
        // side; the dual-shape acceptance here is a back-compat shim.
        const matchesShapeA = data.creatorId === userId || data.assigneeId === userId;
        const matchesShapeB = data.byActorId === userId || data.recipientHint === userId;
        if (!matchesShapeA && !matchesShapeB) return;

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
    case 'task.run.started':
      // 2026-05-22 — fired by task.service.ts autoTransitionAssignedToRunning
      // the moment the daemon actually receives the dispatch frame. Carries
      // the same shape as task.assigned (downstream useTaskStream refetches
      // /tasks anyway, so payload is mostly cosmetic).
      return {
        ...base,
        assigneeId: data.assigneeId ?? null,
        trigger: typeof data.trigger === 'string' ? data.trigger : null,
      };
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

// ─── Task LIST visibility scope (release202/09) ──────────────

/**
 * Decide how `GET /tasks` should scope its result set for the caller.
 *
 * - `'pass-through'` — the query is already self-scoped (`--mine` → assigneeId,
 *   or creatorId == self; both validated == self by the handler). Run as-is.
 * - `'self-scope'`   — restrict to cards the caller created OR is assigned to.
 *   Applies to EVERY regular (executor) agent regardless of filters, so it
 *   cannot enumerate (and therefore poach) other roles' cards; also the
 *   no-filter default for whole-board viewers ("show me my tasks").
 * - `'whole-board'`  — every card, any assignee. Only for humans / admins /
 *   system and the workspace's active orchestrator, and only when they passed
 *   an explicit filter (otherwise no-filter falls back to `'self-scope'`).
 *
 * Pure on purpose: the handler resolves the one async input
 * (`isWorkspaceOrchestrator`) and delegates the matrix here so it's unit-tested.
 */
export function decideTaskListScope(opts: {
  role: string | undefined;
  isWorkspaceOrchestrator: boolean;
  query: {
    view?: unknown;
    kind?: unknown;
    status?: unknown;
    capability?: unknown;
    assigneeId?: string;
    creatorId?: string;
  };
  selfImUserId: string;
}): 'pass-through' | 'self-scope' | 'whole-board' {
  const { role, isWorkspaceOrchestrator, query, selfImUserId } = opts;

  if (query.assigneeId === selfImUserId || query.creatorId === selfImUserId) {
    return 'pass-through';
  }

  const canSeeWholeBoard =
    role === 'human' || role === 'admin' || role === 'system' || isWorkspaceOrchestrator;

  const noFilter =
    !query.view && !query.kind && !query.status && !query.capability && !query.assigneeId && !query.creatorId;

  if (!canSeeWholeBoard || noFilter) return 'self-scope';
  return 'whole-board';
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

  // eslint-disable-next-line custom/no-wildcard-sub-router-middleware -- mounted at /tasks in routes.ts; wildcard scoped to that prefix
  router.use('*', authMiddleware);

  // release202/09 §3.2 — reject a chat-dispatch RUN id (`run_…`) on any
  // `:id`-bound TASK route. Run / task / conversation ids used to be the same
  // bare-cuid shape, so `cloud task complete <runId>` would 404
  // (TASK_NOT_FOUND) deep in the handler. The `run_` prefix lets us fail fast
  // with a clear 400 RUN_ID_ON_TASK_ROUTE up front.
  //
  // Scope note: Hono's `use('/:id', …)` binds the FIRST path segment as `:id`
  // and runs for EVERY `/tasks/<seg>/…` route — including `/:taskRunId/timeline`
  // (param name differs, but the segment still matches `:id`). An earlier note
  // here claimed the timeline route was exempt "verified empirically"; that was
  // wrong — `/tasks/run_…/timeline` was being rejected with RUN_ID_ON_TASK_ROUTE,
  // so every chat-run reply failed to hydrate its activity timeline → empty
  // `model.steps` → the "展开过程" entry vanished the moment the reply landed
  // (release202/09 regression). The activity timeline IS keyed by `IMTaskRun.id`
  // (steps row `taskRunId = run_…`), so a run id is LEGAL there — explicitly
  // exempt `/timeline`. The guard still fast-fails run ids on the mutating
  // task ops (complete / transition / claim / …) where they're genuinely wrong.
  const rejectRunIdOnTaskRoute = async (c: any, next: any) => {
    const id = c.req.param('id');
    if (typeof id === 'string' && id.startsWith('run_') && !c.req.path.endsWith('/timeline')) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'RUN_ID_ON_TASK_ROUTE',
            message:
              `'${id}' is a run id, not a task id — the chat-run turn closes from the agent's reply. ` +
              `Use the runs API (/api/im/runs/${id}) or simply reply; no 'cloud task' op is needed.`,
          },
        },
        400,
      );
    }
    return next();
  };
  router.use('/:id', rejectRunIdOnTaskRoute);
  router.use('/:id/*', rejectRunIdOnTaskRoute);

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

    const conversationId = body.conversationId ?? body.conversation_id;

    // When the caller pins a task to a conversation, validate that the
    // conversation is real and use its workspace as the authoritative scope.
    // This prevents agent tools from accidentally persisting a task against a
    // task_run id or any other opaque id that only looked like a conversation.
    let workspaceId: string | undefined = body.workspaceId ?? body.workspace_id;
    if (conversationId) {
      const conversation = await prisma.iMConversation.findUnique({
        where: { id: conversationId },
        select: { id: true, workspaceId: true },
      });
      if (!conversation) {
        return validationErr(c, `conversationId does not reference an existing conversation: ${conversationId}`);
      }
      if (workspaceId && conversation.workspaceId && workspaceId !== conversation.workspaceId) {
        return validationErr(c, 'workspaceId does not match the conversation workspace');
      }
      workspaceId = workspaceId ?? conversation.workspaceId ?? undefined;
    }

    // workspaceId is NOT NULL on im_tasks (migration 120). If a human caller
    // didn't pass one, fall back to the user's default Personal workspace.
    // Agent MCP calls should normally pass PRISMER_WORKSPACE_ID; if they do
    // not, the MCP tool now fails before reaching this route.
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
    const denied = await requireAgentToolAllowed(c, 'prismer.task.create', workspaceId);
    if (denied) return denied;

    // Wave-8 W1 / L1: validate optional `assetRefs[]` against im_assets in
    // the same workspace and fold the ids into metadata.assets.linkedAssetIds
    // so the existing dispatch path (task.service::resolveAssetRefs) picks
    // them up. workspaceId is required at this point — the fallback chain
    // above guarantees it.
    if (!workspaceId) {
      return validationErr(c, 'workspaceId is required for asset-referencing tasks');
    }
    // `'assetRefs' in body` distinguishes "caller explicitly sent the
    // field" (force write, including empty array to clear) from "caller
    // didn't touch it" (skip merge entirely). The empty-array case only
    // ever fires on create when the client computed refs from an empty
    // description — harmless either way.
    const hasExplicitAssetRefs = 'assetRefs' in body;
    const assetValidation = await validateAssetRefs(body.assetRefs, workspaceId);
    if (!assetValidation.ok) {
      return c.json(
        { ok: false, error: { code: 'VALIDATION_ERROR', message: assetValidation.message } },
        assetValidation.status,
      );
    }
    const metadataWithAssets = hasExplicitAssetRefs
      ? mergeLinkedAssetIds(body.metadata, assetValidation.assetIds, { force: true })
      : body.metadata;

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
        conversationId,
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
        metadata: metadataWithAssets,
        runtimeRoute,
        // release201/09 §4.1 — forward projectId when caller sent it (null
        // and string both pass through; undefined means "not specified").
        ...(body.projectId !== undefined ? { projectId: body.projectId } : {}),
        ...(body.project_id !== undefined ? { projectId: body.project_id } : {}),
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
      // release201/09 §4.2 — Project scope filter. accepts `all` / `__unscoped`
      // / `<id>` / `id1,id2`. Parsed in task.service.ts:parseProjectIdFilter.
      projectId: c.req.query('projectId') ?? c.req.query('project_id'),
      requesterId: user.imUserId,
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

    // release202/09 — Task LIST is the discovery surface. A regular executor
    // agent must only ever see its OWN cards (created or assigned): if it can
    // enumerate OTHER roles' cards here, weak models poach them despite the
    // skill's "don't poach" rule (and the page that motivated this fix —
    // "我指派给CEO的任务为什么其他角色可以看到并开始处理"). Whole-board
    // visibility (every card, any assignee) is reserved for humans / admins
    // (the UI Kanban + the busy-state poller) and the workspace orchestrator
    // (which needs the full board to coordinate delegation). The decision
    // matrix lives in the pure `decideTaskListScope` (unit-tested) — here we
    // only resolve the one async input it can't compute itself: is this agent
    // the workspace's active orchestrator?
    const isPrivilegedViewer = user.role === 'human' || user.role === 'admin' || user.role === 'system';
    let isWorkspaceOrchestrator = false;
    if (!isPrivilegedViewer && query.workspaceId) {
      const ws = await prisma.iMWorkspace.findUnique({
        where: { id: query.workspaceId },
        select: { orchestratorAgentId: true, orchestratorRevokedAt: true },
      });
      isWorkspaceOrchestrator = !!ws && ws.orchestratorAgentId === user.imUserId && ws.orchestratorRevokedAt === null;
    }

    const scope = decideTaskListScope({
      role: user.role,
      isWorkspaceOrchestrator,
      query,
      selfImUserId: user.imUserId,
    });

    if (scope === 'self-scope') {
      // Force self-scope: only cards the caller created or is assigned to.
      // Any explicit filters (status / kind / view) still apply — they're in
      // `query` and get ANDed onto the creator/assignee self-scope.
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

    // 'pass-through' (already self-scoped via --mine) or 'whole-board'
    // (privileged viewer) — both run the query as-is.
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
   * GET /tasks/in-flight?daemonId=X — Resume sweep for daemon cold-start (P0-2).
   *
   * The daemon calls this once on boot to discover IMTaskRun rows it owned
   * before a crash / pod restart so it can re-enqueue them locally instead of
   * waiting ~5min for cloud-side sweepTimedOut() to flip them to `failed`.
   *
   * Auth: this route sits behind `authMiddleware`. Any authenticated caller
   * passing `daemonId=X` only sees IMAgentBinding rows where
   * `boundDaemonId=X` — a malicious caller can enumerate which agents bind
   * to a daemon they don't own, but cannot redispatch the runs (that
   * requires owning the daemon's ws connection + WS-side binding check in
   * handler.ts). Cap at 100 runs per call so this can't be turned into a
   * DOS amplifier against the DB.
   *
   * Returns: { ok, data: { runs: Array<{ id, taskId, assigneeId,
   *   conversationId, createdAt, metadata, task: {...} }> } }
   */
  router.get('/in-flight', async (c) => {
    const daemonId = c.req.query('daemonId');
    if (!daemonId || typeof daemonId !== 'string' || daemonId.trim().length === 0) {
      return c.json<ApiResponse>({ ok: false, error: 'daemonId query required' }, 400);
    }
    const trimmed = daemonId.trim();

    // Step 1: which agents are bound to this daemon? IMAgentBinding is the
    // authoritative source post-migration 410. We do NOT fall back to the
    // legacy metadata.daemonId path here — daemons that have never declared
    // simply see no runs to resume, which is correct (cloud-side sweep can
    // still handle the cold case).
    let assigneeIds: string[];
    try {
      const bindings = await prisma.iMAgentBinding.findMany({
        where: { boundDaemonId: trimmed },
        select: { agentImUserId: true },
      });
      assigneeIds = bindings.map((b: { agentImUserId: string }) => b.agentImUserId);
    } catch (err) {
      log.warn({ err: (err as Error).message, daemonId: trimmed }, '/tasks/in-flight: im_agent_bindings lookup failed');
      return c.json<ApiResponse>({ ok: true, data: { runs: [] } });
    }

    if (assigneeIds.length === 0) {
      return c.json<ApiResponse>({ ok: true, data: { runs: [] } });
    }

    // Step 2: pull running IMTaskRun rows for those agents. Cap at 100 so a
    // pathological daemon with thousands of stuck runs can't DOS itself on
    // resume. Newest-first so freshest in-flight work resumes before older
    // stuck rows (which the cloud sweep will eventually finalize anyway).
    type RunRow = {
      id: string;
      taskId: string | null;
      assigneeId: string | null;
      conversationId: string | null;
      createdAt: Date;
      metadata: string;
    };
    const runs = (await prisma.iMTaskRun.findMany({
      where: {
        status: 'running',
        assigneeId: { in: assigneeIds },
        taskId: { not: null },
      },
      select: {
        id: true,
        taskId: true,
        assigneeId: true,
        conversationId: true,
        createdAt: true,
        metadata: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    })) as RunRow[];

    if (runs.length === 0) {
      return c.json<ApiResponse>({ ok: true, data: { runs: [] } });
    }

    // Step 3: hydrate the parent IMTask row so the daemon can rebuild a
    // `task.dispatch.request` payload without another roundtrip. We mirror
    // the field set that v19x-helpers.buildTaskDispatchRequest reads.
    const taskIds = Array.from(new Set(runs.map((r: RunRow) => r.taskId).filter((id): id is string => !!id)));
    type TaskRow = {
      id: string;
      title: string;
      description: string | null;
      capability: string | null;
      input: string | null;
      metadata: string | null;
      timeoutMs: number | null;
      conversationId: string | null;
      runtimeRoute: string | null;
    };
    const tasks = (await prisma.iMTask.findMany({
      where: { id: { in: taskIds } },
      select: {
        id: true,
        title: true,
        description: true,
        capability: true,
        input: true,
        metadata: true,
        timeoutMs: true,
        conversationId: true,
        runtimeRoute: true,
      },
    })) as TaskRow[];
    const taskById = new Map<string, TaskRow>(tasks.map((t: TaskRow) => [t.id, t]));

    const enrichedRuns = runs.map((r: RunRow) => ({
      id: r.id,
      taskId: r.taskId,
      assigneeId: r.assigneeId,
      conversationId: r.conversationId,
      createdAt: r.createdAt,
      metadata: r.metadata,
      task: r.taskId ? (taskById.get(r.taskId) ?? null) : null,
    }));

    return c.json<ApiResponse>({ ok: true, data: { runs: enrichedRuns } });
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

  // ─── Activity timeline (v2.0 §4.4 Wave 3.5 W4-P4a) ─────────
  //
  // GET /tasks/:taskRunId/timeline — replay the per-run observable-step
  // log written by daemon's StepRecorder. Keyed by `IMTaskRun.id`, NOT
  // `IMTask.id` (one task can have multiple runs / retries; timeline is
  // per-run). Front-end InlineActivityStream (P4c — Wave 4) reads this
  // endpoint on mount to hydrate before subscribing to the live
  // `task.step.appended` IMSyncEvent stream.
  //
  // Auth: requester must own the run (creator/assignee) OR be a
  // participant of its conversation. Reuses TaskService access checks
  // via getTaskRunWithEvents — if that resolves without throwing, the
  // caller is authorized to see the timeline.
  //
  // Pagination: `afterSeq` (exclusive cursor) + `limit` (default 200,
  // cap 500). `cursor` field is non-null while more rows remain.
  const stepRecorder = new TaskStepRecorderService();
  router.get('/:taskRunId/timeline', async (c) => {
    const user = c.get('user');
    const taskRunId = c.req.param('taskRunId');
    const afterSeqRaw = c.req.query('afterSeq');
    const limitRaw = c.req.query('limit');
    const afterSeq = afterSeqRaw != null && afterSeqRaw !== '' ? Number(afterSeqRaw) : null;
    const limit = limitRaw != null && limitRaw !== '' ? Number(limitRaw) : null;
    if (afterSeq != null && (!Number.isFinite(afterSeq) || afterSeq < 0)) {
      return validationErr(c, 'afterSeq must be a non-negative integer');
    }
    if (limit != null && (!Number.isFinite(limit) || limit < 1)) {
      return validationErr(c, 'limit must be a positive integer');
    }
    try {
      // Authorize via TaskService — throws TaskNotFoundError /
      // TaskAccessError if the requester isn't allowed to read this run.
      // We discard the returned events (we have our own per-step axis).
      await taskService.getTaskRunWithEvents(taskRunId, user.imUserId);
      const result = await stepRecorder.listSteps(taskRunId, { afterSeq, limit });
      return c.json<ApiResponse>({ ok: true, data: result });
    } catch (err) {
      return handleTaskError(err, c);
    }
  });

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
   *
   * v2.0 release 200 P8 partial deprecation: the `status`, `assigneeId`,
   * `forceExecutionStatus`, `progress`, `statusMessage` fields (any
   * combination) are flagged with Deprecation / Sunset headers + a
   * `_deprecation` envelope. Callers should migrate to POST /transition;
   * hard rejection lands 3 sprints later. PATCH with content-only fields
   * (title / description / metadata) emits NO deprecation signal — that
   * usage stays supported. See docs/migrations/v2.0/tasks-endpoint-migration.md.
   */
  router.patch('/:id', async (c) => {
    const user = c.get('user');
    const body = await c.req.json();
    const denied = await requireAgentToolAllowedForTask(c, 'prismer.task.update', c.req.param('id'));
    if (denied) return denied;

    // Validate progress range
    if (body.progress !== undefined) {
      const p = Number(body.progress);
      if (isNaN(p) || p < 0 || p > 1) {
        return validationErr(c, 'progress must be a number between 0.0 and 1.0');
      }
      body.progress = p;
    }

    const deprecatedFields = detectDeprecatedPatchFields(body);
    const deprecation =
      deprecatedFields.length > 0
        ? markDeprecated(c, 'PATCH /tasks/:id', { fields: deprecatedFields, actorId: user.imUserId })
        : null;

    // Wave-8 W1 / L1: same `assetRefs[]` validation as POST /tasks. We must
    // know the task's workspaceId BEFORE we can validate cross-workspace, so
    // a one-off lookup is needed here. Skip the lookup entirely when the
    // caller didn't include assetRefs (most PATCHes are status / progress
    // updates — no need to read the task row twice).
    let metadataForUpdate: Record<string, unknown> | undefined = body.metadata;
    if (body.assetRefs !== undefined) {
      const taskRow = await prisma.iMTask.findUnique({
        where: { id: c.req.param('id') },
        select: { workspaceId: true },
      });
      if (!taskRow) {
        return c.json({ ok: false, error: { code: 'TASK_NOT_FOUND', message: 'Task not found' } }, 404);
      }
      if (!taskRow.workspaceId) {
        return validationErr(c, 'task has no workspaceId; cannot validate assetRefs');
      }
      const assetValidation = await validateAssetRefs(body.assetRefs, taskRow.workspaceId);
      if (!assetValidation.ok) {
        return c.json(
          { ok: false, error: { code: 'VALIDATION_ERROR', message: assetValidation.message } },
          assetValidation.status,
        );
      }
      // `body.assetRefs !== undefined` IS the explicit-clear signal — even
      // an empty array must wipe `linkedAssetIds` so the daemon dispatch
      // stops re-attaching dropped refs.
      metadataForUpdate = mergeLinkedAssetIds(body.metadata, assetValidation.assetIds, { force: true });
    }

    try {
      const rawAssigneeId =
        'assigneeId' in body ? body.assigneeId : 'assignee_id' in body ? body.assignee_id : undefined;
      const assigneeId =
        rawAssigneeId === undefined
          ? undefined
          : typeof rawAssigneeId === 'string' && rawAssigneeId.trim() === ''
            ? null
            : rawAssigneeId;
      const task = await taskService.updateTask(c.req.param('id'), user.imUserId, {
        title: body.title,
        description: body.description,
        assigneeId,
        status: body.status,
        forceExecutionStatus: Boolean(body.forceExecutionStatus ?? body.force_execution_status),
        progress: body.progress,
        statusMessage: body.statusMessage ?? body.status_message,
        metadata: metadataForUpdate,
      });
      const payload: ApiResponse = { ok: true, data: await enrichTask(task) };
      if (deprecation) payload._deprecation = deprecation;
      return c.json<ApiResponse>(payload);
    } catch (err) {
      return handleTaskError(err, c);
    }
  });

  /**
   * DELETE /tasks/:id — [DEPRECATED v2.0, sunset 2026-09-01]
   * Use POST /tasks/:id/transition { to: 'cancelled' } instead. Spec
   * §6.3 lists `POST /tasks/:id/cancel`; this route is the actual cancel
   * code path (no POST /cancel ever existed). Kept for backward compat —
   * see docs/migrations/v2.0/tasks-endpoint-migration.md.
   *
   * Cancel task (soft delete). Creator only.
   * Idempotent: re-deleting a cancelled task returns 200.
   * Returns 409 for completed/failed tasks.
   */
  router.delete('/:id', async (c) => {
    const user = c.get('user');
    const denied = await requireAgentToolAllowedForTask(c, 'prismer.task.cancel', c.req.param('id'));
    if (denied) return denied;
    const deprecation = markDeprecated(c, 'DELETE /tasks/:id', { actorId: user.imUserId });
    try {
      const task = await taskService.cancelTask(c.req.param('id'), user.imUserId);
      return c.json<ApiResponse>({ ok: true, data: await enrichTask(task), _deprecation: deprecation });
    } catch (err) {
      return handleTaskError(err, c);
    }
  });

  /**
   * POST /tasks/:id/move-project — release201/09 §6.4 + §4.3.
   *
   * Move (or unscoped) a task to a different project. Permission contract:
   *   - actor must be the workspace owner, OR
   *   - actor must be owner of the source project (if currently scoped), OR
   *   - actor must be owner of the target project (if scoping to one)
   *
   * Body: { targetProjectId: string | null }
   *   - non-null → move task into that project (must be in same workspace, active status)
   *   - null     → unset projectId (set to NULL, i.e. workspace-level)
   *
   * 200 → task DTO with updated projectId
   * 400 → invalid body
   * 403 → actor lacks permission
   * 404 → task not found
   * 422 → target project archived / cross-workspace
   */
  router.post('/:id/move-project', async (c) => {
    const user = c.get('user');
    const taskId = c.req.param('id');
    let body: { targetProjectId?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return validationErr(c, 'expected JSON body { targetProjectId: string | null }');
    }
    const raw = body.targetProjectId;
    let targetProjectId: string | null;
    if (raw === null) {
      targetProjectId = null;
    } else if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (trimmed.length === 0) {
        targetProjectId = null;
      } else {
        targetProjectId = trimmed;
      }
    } else {
      return validationErr(c, 'targetProjectId must be string or null');
    }

    try {
      const result = await taskService.moveTaskProject(taskId, user.imUserId, targetProjectId);
      return c.json<ApiResponse>({ ok: true, data: await enrichTask(result) });
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
   * POST /tasks/:id/transition — v2.0 release 200 §6.1.
   *
   * Unified state-machine transition. The single canonical entry point
   * for kanban drag / unassign / approve / reject / cancel / blocked
   * self-report / retry / restore.
   *
   * Body:
   *   { to, assigneeId?, position?, reason?, reviewComment? }
   *
   * Responses:
   *   200 { task, transition: { from, to, by, at, via } }
   *   403 { code:'forbidden', actorTier, requiredTiers }
   *   409 { code:'invalid-transition', from, to, allowedFromHere }
   */
  router.post('/:id/transition', async (c) => {
    const user = c.get('user');
    const taskId = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const denied = await requireAgentToolAllowedForTask(c, 'prismer.task.update', taskId);
    if (denied) return denied;

    const to = typeof body.to === 'string' ? (body.to as TaskStatus) : undefined;
    if (!to) {
      return validationErr(c, 'to is required');
    }
    const allowedTo: TaskStatus[] = [
      'pending',
      'assigned',
      'running',
      'review',
      'blocked',
      'failed',
      'completed',
      'cancelled',
    ];
    if (!allowedTo.includes(to)) {
      return validationErr(c, `to must be one of ${allowedTo.join(' | ')}`);
    }

    const assigneeIdRaw =
      'assigneeId' in body
        ? body.assigneeId
        : 'assignee_id' in body
          ? (body as Record<string, unknown>).assignee_id
          : undefined;
    const assigneeId =
      assigneeIdRaw === undefined
        ? undefined
        : assigneeIdRaw === null
          ? null
          : typeof assigneeIdRaw === 'string' && assigneeIdRaw.trim() === ''
            ? null
            : (assigneeIdRaw as string);

    const position = typeof body.position === 'number' ? body.position : undefined;
    const reason = typeof body.reason === 'string' ? body.reason : undefined;
    const reviewComment =
      typeof body.reviewComment === 'string'
        ? body.reviewComment
        : typeof (body as Record<string, unknown>).review_comment === 'string'
          ? ((body as Record<string, unknown>).review_comment as string)
          : undefined;

    try {
      const before = await taskService.getTask(taskId).catch(() => null);
      const fromStatus = before?.status ?? null;
      const task = await taskService.transitionTask(taskId, user.imUserId, {
        to,
        assigneeId,
        position,
        reason,
        reviewComment,
      });
      return c.json<ApiResponse>({
        ok: true,
        data: await enrichTask(task),
        meta: {
          transition: {
            from: fromStatus,
            to: task.status,
            by: user.imUserId,
            at: new Date().toISOString(),
          },
        },
      });
    } catch (err) {
      return handleTaskError(err, c);
    }
  });

  /**
   * POST /tasks/:id/force-transition — v2.0 release 200 §5.3.
   *
   * Admin escape-hatch — skips the TRANSITIONS matrix. Owner / admin /
   * trustTier>=4 only (enforced by `isForceTransitionAllowed`). UI does
   * NOT expose this; only ops curl / admin tools should call it.
   *
   * Body: { to, reason: required }
   * Responses:
   *   200 { task, transition: { from, to, by, at } }
   *   403 if not owner / admin
   */
  router.post('/:id/force-transition', async (c) => {
    const user = c.get('user');
    const taskId = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const denied = await requireAgentToolAllowedForTask(c, 'prismer.task.update', taskId);
    if (denied) return denied;

    const to = typeof body.to === 'string' ? (body.to as TaskStatus) : undefined;
    if (!to) return validationErr(c, 'to is required');
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!reason) return validationErr(c, 'reason is required for force-transition');

    try {
      const before = await taskService.getTask(taskId).catch(() => null);
      const fromStatus = before?.status ?? null;
      const task = await taskService.forceTransitionTask(taskId, user.imUserId, { to, reason });
      return c.json<ApiResponse>({
        ok: true,
        data: await enrichTask(task),
        meta: {
          transition: {
            from: fromStatus,
            to: task.status,
            by: user.imUserId,
            at: new Date().toISOString(),
            forced: true,
            reason,
          },
        },
      });
    } catch (err) {
      return handleTaskError(err, c);
    }
  });

  /**
   * POST /tasks/:id/approve — [DEPRECATED v2.0, sunset 2026-09-01]
   * Use POST /tasks/:id/transition { to: 'completed' } instead.
   * Kept for backward compat; emits Deprecation / Sunset / Link headers
   * and a `_deprecation` envelope on the response. See
   * docs/migrations/v2.0/tasks-endpoint-migration.md.
   *
   * Approve task in review status → completed. Creator only.
   * Idempotent: re-approving a completed task returns 200.
   */
  router.post('/:id/approve', async (c) => {
    const user = c.get('user');
    const denied = await requireAgentToolAllowedForTask(c, 'prismer.task.approve', c.req.param('id'));
    if (denied) return denied;
    const deprecation = markDeprecated(c, 'POST /tasks/:id/approve', { actorId: user.imUserId });
    try {
      const task = await taskService.approveTask(c.req.param('id'), user.imUserId);
      return c.json<ApiResponse>({ ok: true, data: await enrichTask(task), _deprecation: deprecation });
    } catch (err) {
      return handleTaskError(err, c);
    }
  });

  /**
   * POST /tasks/:id/start — [DEPRECATED v2.0, sunset 2026-09-01]
   * Use POST /tasks/:id/transition { to: 'running' } instead. Kept for
   * backward compat — see docs/migrations/v2.0/tasks-endpoint-migration.md.
   *
   * Force task into running status. Sugar over forceExecutionStatus('running').
   */
  router.post('/:id/start', async (c) => {
    const user = c.get('user');
    const body = await c.req.json().catch(() => ({}));
    const denied = await requireAgentToolAllowedForTask(c, 'prismer.task.update', c.req.param('id'));
    if (denied) return denied;
    const deprecation = markDeprecated(c, 'POST /tasks/:id/start', { actorId: user.imUserId });
    try {
      const task = await taskService.forceExecutionStatus(c.req.param('id'), user.imUserId, 'running', {
        reason: body.reason,
      });
      return c.json<ApiResponse>({ ok: true, data: await enrichTask(task), _deprecation: deprecation });
    } catch (err) {
      return handleTaskError(err, c);
    }
  });

  /**
   * POST /tasks/:id/pause — Force task back into pending status (paused).
   */
  router.post('/:id/pause', async (c) => {
    const user = c.get('user');
    const body = await c.req.json().catch(() => ({}));
    const denied = await requireAgentToolAllowedForTask(c, 'prismer.task.update', c.req.param('id'));
    if (denied) return denied;
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
   * POST /tasks/:id/reopen — Force task back into pending status (reopened).
   */
  router.post('/:id/reopen', async (c) => {
    const user = c.get('user');
    const body = await c.req.json().catch(() => ({}));
    const denied = await requireAgentToolAllowedForTask(c, 'prismer.task.update', c.req.param('id'));
    if (denied) return denied;
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
   * POST /tasks/:id/reject — [DEPRECATED v2.0, sunset 2026-09-01]
   * Use POST /tasks/:id/transition { to: 'assigned', reviewComment } instead.
   * Kept for backward compat — see docs/migrations/v2.0/tasks-endpoint-migration.md.
   *
   * Reject task in review status → failed. Creator only.
   */
  router.post('/:id/reject', async (c) => {
    const user = c.get('user');
    const body = await c.req.json().catch(() => ({}));
    const denied = await requireAgentToolAllowedForTask(c, 'prismer.task.reject', c.req.param('id'));
    if (denied) return denied;

    if (!body.reason || typeof body.reason !== 'string') {
      return validationErr(c, 'reason is required');
    }

    const deprecation = markDeprecated(c, 'POST /tasks/:id/reject', { actorId: user.imUserId });
    try {
      const task = await taskService.rejectTask(c.req.param('id'), user.imUserId, body.reason);
      return c.json<ApiResponse>({ ok: true, data: await enrichTask(task), _deprecation: deprecation });
    } catch (err) {
      return handleTaskError(err, c);
    }
  });

  /**
   * POST /tasks/:id/complete — [DEPRECATED v2.0, sunset 2026-09-01]
   * Use POST /tasks/:id/transition { to: 'review' or 'completed' } instead.
   * Kept for backward compat — see docs/migrations/v2.0/tasks-endpoint-migration.md.
   *
   * Mark task completed. Assignee only.
   */
  router.post('/:id/complete', async (c) => {
    const user = c.get('user');
    const body = await c.req.json().catch(() => ({}));
    const denied = await requireAgentToolAllowedForTask(c, 'prismer.task.complete', c.req.param('id'));
    if (denied) return denied;

    const deprecation = markDeprecated(c, 'POST /tasks/:id/complete', { actorId: user.imUserId });
    try {
      const task = await taskService.completeTask(c.req.param('id')!, user.imUserId, {
        result: body.result,
        resultUri: body.resultUri ?? body.result_uri,
        cost: body.cost,
      });
      return c.json<ApiResponse>({ ok: true, data: await enrichTask(task), _deprecation: deprecation });
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

  /**
   * POST /tasks/:id/heartbeat — v2.0 §4.2 Track B-1.
   *
   * HTTP fallback for the canonical WS `task.heartbeat` channel. Daemons
   * are expected to use the WS path in production; this endpoint exists
   * so SDK tests and degraded networks (WS blocked, HTTP only) can still
   * keep the phase signal alive.
   *
   * Authorization: the caller must be the task assignee (the assignee is
   * the IMUser representation of the agent the daemon hosts). Other
   * actors get 403.
   *
   * Body: `{ heartbeatVersion: number, currentPhase: string,
   * lastStepAt?: ISO|epoch_ms }`.
   *
   * Response (200): `{ ok: true, data: { taskId, currentPhase,
   * heartbeatVersion, lastHeartbeatAt, recoveredFromStuck } }`. Returns
   * `recoveredFromStuck=false, currentPhase as recorded` when the task
   * is in a terminal status or the heartbeat version is stale — the
   * daemon should treat that as "stop sending heartbeats for this task".
   *
   * Per §12.4 contract, this endpoint NEVER touches the `status` column.
   */
  router.post('/:id/heartbeat', async (c) => {
    const user = c.get('user');
    const taskId = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

    if (typeof body.heartbeatVersion !== 'number' || !Number.isFinite(body.heartbeatVersion)) {
      return validationErr(c, 'heartbeatVersion (number) is required');
    }
    if (typeof body.currentPhase !== 'string' || body.currentPhase.length === 0) {
      return validationErr(c, 'currentPhase (non-empty string) is required');
    }
    if (body.currentPhase.length > 40) {
      return validationErr(c, 'currentPhase must be ≤40 chars (matches schema VARCHAR(40))');
    }

    // Authorization: only the task assignee may report heartbeats. This
    // mirrors the WS path which restricts to the declared daemon hosting
    // the agent (assignee). Creator/orchestrator cannot proxy a heartbeat —
    // by design, the signal must come from whoever is actually executing.
    const task = await prisma.iMTask.findUnique({
      where: { id: taskId },
      select: { id: true, assigneeId: true },
    });
    if (!task) {
      return c.json<ApiResponse>({ ok: false, error: { code: 'TASK_NOT_FOUND', message: 'task not found' } }, 404);
    }
    if (!task.assigneeId || task.assigneeId !== user.imUserId) {
      return accessErr(c, 'only the task assignee can post heartbeats');
    }

    try {
      const result = await taskService.recordTaskHeartbeat(taskId, {
        heartbeatVersion: body.heartbeatVersion,
        currentPhase: body.currentPhase,
        lastStepAt:
          typeof body.lastStepAt === 'number' || typeof body.lastStepAt === 'string'
            ? (body.lastStepAt as number | string)
            : undefined,
      });
      if (!result) {
        // Stale heartbeat / terminal task — non-error: return a 200 body
        // describing the no-op so the SDK can stop the heartbeat loop.
        return c.json<ApiResponse>({
          ok: true,
          data: { taskId, accepted: false, reason: 'stale_or_terminal' },
        });
      }
      return c.json<ApiResponse>({
        ok: true,
        data: {
          taskId: result.taskId,
          accepted: true,
          currentPhase: result.currentPhase,
          heartbeatVersion: result.heartbeatVersion,
          lastHeartbeatAt: result.lastHeartbeatAt.toISOString(),
          recoveredFromStuck: result.recoveredFromStuck,
        },
      });
    } catch (err) {
      return handleTaskError(err, c);
    }
  });

  /**
   * Wave 3.5 W1 — POST /tasks/:id/retry-dispatch
   *
   * Manually re-fire the daemon dispatch for a stuck task. Wired to the
   * "重试 dispatch" button on TaskDigestCard.StuckWarning (§4.4.6).
   *
   * Body: `{}` (empty) or `{ reason?: string }` — reason is recorded in the
   * task log only; no other effect.
   *
   * Auth: creator / orchestrator / owner / admin (matches §15 control-op
   * matrix). Assignee cannot self-retry — by design "stuck" means the
   * assignee is unresponsive.
   *
   * State pre-conditions enforced in service:
   *   - task.status === 'running'  → otherwise 409 INVALID_STATE_TRANSITION
   *   - task.currentPhase === 'stuck' → otherwise 409 INVALID_STATE_TRANSITION
   *
   * Idempotency: §4.3 two-phase commit on the daemon side (daemon dedupes by
   * task.id). Cloud does not maintain a separate retry rate-limit beyond the
   * dispatch path's existing pendingDispatch tracking.
   */
  router.post('/:id/retry-dispatch', async (c) => {
    const user = c.get('user');
    const taskId = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const reason = typeof body.reason === 'string' ? body.reason : undefined;

    try {
      const task = await taskService.retryDispatchTask(taskId, user.imUserId, { reason });
      return c.json<ApiResponse>({
        ok: true,
        data: {
          taskId: task.id,
          status: task.status,
          currentPhase: (task as { currentPhase?: string }).currentPhase ?? null,
          assigneeId: task.assigneeId,
          retriedAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      return handleTaskError(err, c);
    }
  });

  /**
   * POST /tasks/:id/event — Daemon-side task event reporter (F2B).
   *
   * Daemon (sdk/.../daemon/outbox-watcher.ts) posts here when an outbox file
   * is rejected for MIME_MISMATCH so the task carries an auditable record
   * instead of the failure being a silent quarantine-only event.
   *
   * Body shape:
   *   {
   *     code: 'OUTBOX_MIME_MISMATCH' | <other future codes>,
   *     payload?: Record<string, unknown>,  // serialised into metadata JSON
   *     message?: string,                   // human-readable summary
   *   }
   *
   * The endpoint is intentionally tolerant — daemon best-effort calls must
   * not loop on cloud-side validation failures. We accept any string `code`,
   * store it as the IMTaskLog.action, and surface the rest as metadata.
   *
   * TODO(F2B prompt-surfacing): dispatch.ts (cloud) should pull the most
   * recent N task logs with action='outbox_*' into the agent's next prompt's
   * "Recent events" section so the agent learns its previous output was
   * rejected (right now it only lands in the audit trail). Tracked separately;
   * not in scope for this hotfix because the prompt-builder is being
   * refactored under release200/14.
   */
  router.post('/:id/event', async (c) => {
    const user = c.get('user');
    const taskId = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

    const code = typeof body.code === 'string' && body.code ? body.code : null;
    if (!code) {
      return validationErr(c, 'code (non-empty string) is required');
    }
    if (code.length > 64) {
      return validationErr(c, 'code must be ≤64 chars');
    }
    const message = typeof body.message === 'string' && body.message ? body.message.slice(0, 2000) : null;
    const payload =
      body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)
        ? (body.payload as Record<string, unknown>)
        : {};

    const task = await prisma.iMTask.findUnique({
      where: { id: taskId },
      select: { id: true, assigneeId: true, creatorId: true },
    });
    if (!task) {
      return c.json<ApiResponse>({ ok: false, error: { code: 'TASK_NOT_FOUND', message: 'task not found' } }, 404);
    }
    // Only the assignee (the agent / daemon executing the task) may post
    // task events. Mirrors the heartbeat endpoint's authorization model.
    if (!task.assigneeId || task.assigneeId !== user.imUserId) {
      return accessErr(c, 'only the task assignee can post task events');
    }

    // Map to a stable lowercase action so SQL filters can pivot on it.
    // OUTBOX_MIME_MISMATCH → outbox_mime_mismatch, etc.
    const action = code.toLowerCase();
    try {
      await prisma.iMTaskLog.create({
        data: {
          taskId,
          actorId: user.imUserId,
          action,
          message,
          metadata: JSON.stringify({ code, ...payload }),
        },
      });
      return c.json<ApiResponse>({ ok: true, data: { taskId, action } });
    } catch (err) {
      log.warn({ err: (err as Error).message, taskId, code }, 'task event log write failed');
      return c.json<ApiResponse>(
        { ok: false, error: { code: 'INTERNAL_ERROR', message: 'failed to record task event' } },
        500,
      );
    }
  });

  // ═══════════════════════════════════════════════════════════
  // release201/10 — Acceptance criteria & verification
  // ═══════════════════════════════════════════════════════════

  const acceptance = getTaskAcceptanceService(eventBusService ? ({ eventBusService } as any) : undefined);

  function handleAcceptanceError(c: any, err: unknown) {
    if (err instanceof AcceptanceError) {
      return c.json(
        {
          ok: false,
          error: { code: err.code, message: err.message, ...(err.detail ?? {}) },
        } as ApiResponse,
        err.status as 400 | 403 | 404 | 422,
      );
    }
    return handleTaskError(err, c);
  }

  /** GET /tasks/:id/acceptance — overall + criteria list. */
  router.get('/:id/acceptance', async (c) => {
    const taskId = c.req.param('id');
    try {
      const view = await acceptance.getAcceptance(taskId);
      return c.json<ApiResponse>({ ok: true, data: view });
    } catch (err) {
      return handleAcceptanceError(c, err);
    }
  });

  /** POST /tasks/:id/criteria — add a criterion (rev 2). */
  router.post('/:id/criteria', async (c) => {
    const user = c.get('user');
    const taskId = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const denied = await requireAgentToolAllowedForTask(c, 'prismer.task.update', taskId);
    if (denied) return denied;
    try {
      const { task, criterion } = await acceptance.addCriterion(
        taskId,
        {
          verifyMode: body.verifyMode as any,
          expectation: typeof body.expectation === 'string' ? body.expectation : '',
          verifierAgentId: typeof body.verifierAgentId === 'string' ? (body.verifierAgentId as string) : null,
          required: body.required !== false,
          weight: typeof body.weight === 'number' ? body.weight : 1,
          evidenceRefs: Array.isArray(body.evidenceRefs) ? (body.evidenceRefs as any) : [],
        },
        user.imUserId,
      );
      return c.json<ApiResponse>({ ok: true, data: { acceptance: task, criterion } });
    } catch (err) {
      return handleAcceptanceError(c, err);
    }
  });

  /** PATCH /tasks/:id/criteria/:cid — update a criterion (rev 2).
   *
   * v2.0.7.1 hotfix B6 — PATCH is partial-update semantics. Build the patch
   * object only from keys that are PRESENT in the body; do not synthesize
   * `undefined` for omitted keys, otherwise the service's `{ ...target,
   * ...patch }` spread overwrites existing fields with `undefined` and
   * the JSON column round-trips them to null. */
  router.patch('/:id/criteria/:cid', async (c) => {
    const user = c.get('user');
    const taskId = c.req.param('id');
    const cid = c.req.param('cid');
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const denied = await requireAgentToolAllowedForTask(c, 'prismer.task.update', taskId);
    if (denied) return denied;
    const patch: Record<string, unknown> = {};
    if ('expectation' in body) {
      if (typeof body.expectation !== 'string') {
        return validationErr(c, 'expectation must be a string');
      }
      patch.expectation = body.expectation;
    }
    if ('verifyMode' in body) {
      // Service validates allowed values; we just forward.
      patch.verifyMode = body.verifyMode;
    }
    if ('verifierAgentId' in body) {
      // null is meaningful (explicit clear). Reject other non-string types.
      if (body.verifierAgentId !== null && typeof body.verifierAgentId !== 'string') {
        return validationErr(c, 'verifierAgentId must be a string or null');
      }
      patch.verifierAgentId = body.verifierAgentId;
    }
    if ('weight' in body) {
      if (typeof body.weight !== 'number') {
        return validationErr(c, 'weight must be a number');
      }
      patch.weight = body.weight;
    }
    if ('required' in body) {
      if (typeof body.required !== 'boolean') {
        return validationErr(c, 'required must be a boolean');
      }
      patch.required = body.required;
    }
    if ('evidenceRefs' in body) {
      if (!Array.isArray(body.evidenceRefs)) {
        return validationErr(c, 'evidenceRefs must be an array');
      }
      patch.evidenceRefs = body.evidenceRefs;
    }
    try {
      const view = await acceptance.updateCriterion(taskId, cid, patch as any, user.imUserId);
      return c.json<ApiResponse>({ ok: true, data: view });
    } catch (err) {
      return handleAcceptanceError(c, err);
    }
  });

  /** DELETE /tasks/:id/criteria/:cid — remove a criterion. */
  router.delete('/:id/criteria/:cid', async (c) => {
    const user = c.get('user');
    const taskId = c.req.param('id');
    const cid = c.req.param('cid');
    const denied = await requireAgentToolAllowedForTask(c, 'prismer.task.update', taskId);
    if (denied) return denied;
    try {
      const view = await acceptance.removeCriterion(taskId, cid, user.imUserId);
      return c.json<ApiResponse>({ ok: true, data: view });
    } catch (err) {
      return handleAcceptanceError(c, err);
    }
  });

  /**
   * POST /tasks/:id/criteria/:cid/verify — unified verify entry (rev 2 §6.2).
   *
   * Body: { outcome: 'passed' | 'failed' | 'n/a' | 'waived', note?, evidenceRefs?, waiveReason? }
   *
   * Service routes the call by actor identity:
   *   - actorId == task.assigneeId          → agent-self-check report
   *   - actorId == criterion.verifierAgentId → verifier-agent report
   *   - actorId == 人类 reviewer             → manual report
   *
   * Cloud no longer ships any specific verifier implementation. Verifier
   * agents decide the method at runtime and call this endpoint to report.
   */
  router.post('/:id/criteria/:cid/verify', async (c) => {
    const user = c.get('user');
    const taskId = c.req.param('id');
    const cid = c.req.param('cid');
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const denied = await requireAgentToolAllowedForTask(c, 'prismer.task.update', taskId);
    if (denied) return denied;
    // Accept legacy `status` field as synonym for `outcome` (transitional —
    // remove once SDKs/UIs all on rev 2).
    const outcome = (body.outcome ?? body.status) as any;
    if (!['passed', 'failed', 'n/a', 'waived'].includes(outcome)) {
      return validationErr(c, "outcome must be one of 'passed' | 'failed' | 'n/a' | 'waived'");
    }
    try {
      const view = await acceptance.verify(
        taskId,
        cid,
        {
          outcome,
          note: typeof body.note === 'string' ? body.note : '',
          evidenceRefs: Array.isArray(body.evidenceRefs) ? (body.evidenceRefs as string[]) : undefined,
          waiveReason: typeof body.waiveReason === 'string' ? body.waiveReason : undefined,
        },
        user.imUserId,
      );
      return c.json<ApiResponse>({ ok: true, data: view });
    } catch (err) {
      return handleAcceptanceError(c, err);
    }
  });

  /** POST /tasks/:id/apply-template — copy a template's criteria onto task. */
  router.post('/:id/apply-template', async (c) => {
    const user = c.get('user');
    const taskId = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const denied = await requireAgentToolAllowedForTask(c, 'prismer.task.update', taskId);
    if (denied) return denied;
    const templateId = typeof body.templateId === 'string' ? body.templateId : '';
    if (!templateId) return validationErr(c, 'templateId is required');
    try {
      const view = await acceptance.applyTemplate(taskId, templateId, user.imUserId);
      return c.json<ApiResponse>({ ok: true, data: view });
    } catch (err) {
      return handleAcceptanceError(c, err);
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // release201/10 rev 2 — SPEC.md endpoints (§6.3)
  // ────────────────────────────────────────────────────────────────────

  function handleSpecError(c: any, err: unknown) {
    if (err instanceof SpecError) {
      return c.json(
        { ok: false, error: { code: err.code, message: err.message } } as ApiResponse,
        err.status as 400 | 404 | 422,
      );
    }
    return handleTaskError(err, c);
  }

  /** GET /tasks/:id/spec — read latest SPEC.md (markdown + revision). */
  router.get('/:id/spec', async (c) => {
    const taskId = c.req.param('id');
    try {
      const spec = await getTaskSpecService({ eventBusService }).get(taskId);
      return c.json<ApiResponse>({ ok: true, data: spec });
    } catch (err) {
      return handleSpecError(c, err);
    }
  });

  /** PUT /tasks/:id/spec — owner writes/updates SPEC.md (writes a new revision). */
  router.put('/:id/spec', async (c) => {
    const user = c.get('user');
    const taskId = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const denied = await requireAgentToolAllowedForTask(c, 'prismer.task.update', taskId);
    if (denied) return denied;
    const md = typeof body.markdown === 'string' ? body.markdown : '';
    try {
      const view = await getTaskSpecService({ eventBusService }).set(taskId, md, user.imUserId);
      return c.json<ApiResponse>({ ok: true, data: view });
    } catch (err) {
      return handleSpecError(c, err);
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // release201/10 rev 2 — TODO.md endpoints (§6.3)
  // ────────────────────────────────────────────────────────────────────

  function handleTodoError(c: any, err: unknown) {
    if (err instanceof TodoError) {
      return c.json(
        { ok: false, error: { code: err.code, message: err.message } } as ApiResponse,
        err.status as 400 | 404,
      );
    }
    return handleTaskError(err, c);
  }

  async function resolveTodoOpts(taskId: string): Promise<{ workspaceId: string; creatorId: string | null }> {
    const t = (await prisma.iMTask.findUnique({
      where: { id: taskId },
      select: { workspaceId: true, creatorId: true } as never,
    })) as unknown as { workspaceId: string; creatorId: string } | null;
    return {
      workspaceId: t?.workspaceId ?? '',
      creatorId: t?.creatorId ?? null,
    };
  }

  /** GET /tasks/:id/todo — list TODO.md items + raw markdown. */
  router.get('/:id/todo', async (c) => {
    const taskId = c.req.param('id');
    try {
      const view = await getTodoService({ eventBusService }).get(taskId);
      return c.json<ApiResponse>({ ok: true, data: view });
    } catch (err) {
      return handleTodoError(c, err);
    }
  });

  /** POST /tasks/:id/todo/items — append an item. body: { text, depth? } */
  router.post('/:id/todo/items', async (c) => {
    const user = c.get('user');
    const taskId = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const denied = await requireAgentToolAllowedForTask(c, 'prismer.task.update', taskId);
    if (denied) return denied;
    const text = typeof body.text === 'string' ? body.text : '';
    const depth = typeof body.depth === 'number' ? body.depth : 0;
    try {
      const opts = await resolveTodoOpts(taskId);
      const view = await getTodoService({ eventBusService }).appendItem(taskId, text, user.imUserId, {
        ...opts,
        depth,
      });
      return c.json<ApiResponse>({ ok: true, data: view });
    } catch (err) {
      return handleTodoError(c, err);
    }
  });

  /** PATCH /tasks/:id/todo/items/:idx — toggle done or set text. */
  router.patch('/:id/todo/items/:idx', async (c) => {
    const user = c.get('user');
    const taskId = c.req.param('id');
    const idx = Number(c.req.param('idx'));
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const denied = await requireAgentToolAllowedForTask(c, 'prismer.task.update', taskId);
    if (denied) return denied;
    if (!Number.isFinite(idx) || idx < 0) return validationErr(c, 'invalid idx');
    try {
      const opts = await resolveTodoOpts(taskId);
      const svc = getTodoService({ eventBusService });
      let view;
      if (typeof body.text === 'string') {
        view = await svc.setText(taskId, idx, body.text, user.imUserId, opts);
      } else {
        const done = typeof body.done === 'boolean' ? (body.done as boolean) : undefined;
        view = await svc.toggleItem(taskId, idx, done, user.imUserId, opts);
      }
      return c.json<ApiResponse>({ ok: true, data: view });
    } catch (err) {
      return handleTodoError(c, err);
    }
  });

  /** DELETE /tasks/:id/todo/items/:idx — remove an item. */
  router.delete('/:id/todo/items/:idx', async (c) => {
    const user = c.get('user');
    const taskId = c.req.param('id');
    const idx = Number(c.req.param('idx'));
    const denied = await requireAgentToolAllowedForTask(c, 'prismer.task.update', taskId);
    if (denied) return denied;
    if (!Number.isFinite(idx) || idx < 0) return validationErr(c, 'invalid idx');
    try {
      const opts = await resolveTodoOpts(taskId);
      const view = await getTodoService({ eventBusService }).removeItem(taskId, idx, user.imUserId, opts);
      return c.json<ApiResponse>({ ok: true, data: view });
    } catch (err) {
      return handleTodoError(c, err);
    }
  });

  return router;
}
