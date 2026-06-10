/**
 * Prismer IM — Insights BFF (v2.0.7 release201/12 §7)
 *
 * 3 endpoints:
 *   GET /insights/overview?workspaceId=&range=
 *   GET /insights/project/:projectId?range=
 *   GET /insights/agent/:agentId?workspaceId=&range=
 *
 * Auth: authMiddleware + workspace member assertion in each handler.
 * Caching: 30s in-process response cache + Cache-Control: private,
 *   max-age=30 response header (12 §0.2.2).
 * Rate limit: 60 req/min/user/endpoint (uses action='insights.read').
 *
 * Forbidden patterns (12 §0.2.4):
 *   - log "[insights] aggregate N+1"     — fan-out is parallel; we never serialise
 *   - log "[insights] missing workspaceId filter" — service-layer asserts membership
 *   - log "[insights] cache stale beyond 60s" — TTL is 30s; setCached respects it
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { authMiddleware } from '../auth/middleware';
import type { ApiResponse } from '../types';
import {
  buildAgent,
  buildOverview,
  buildProject,
  cacheKey,
  getCached,
  setCached,
  getProjectActiveMemberCount,
  getProjectAcceptanceByStatus,
  getProjectActivityTimeseries,
  WorkspaceForbiddenError,
  WorkspaceNotFoundError,
  AgentNotInWorkspaceError,
  assertWorkspaceMember,
  type InsightsRange,
  type ProjectActiveMemberCount,
  type ProjectAcceptanceByStatus,
  type ProjectActivityTimeseries,
} from '../services/insights.service';
import { getCockpit, type CockpitRange } from '../services/insights-cockpit.service';
import type { ApprovalService } from '../services/approval.service';
import type { RateLimiterService } from '../services/rate-limiter.service';

const VALID_RANGES = new Set<InsightsRange>(['24h', '7d', '30d', '90d']);

function parseRange(raw: string | undefined): InsightsRange {
  if (!raw) return '7d';
  return VALID_RANGES.has(raw as InsightsRange) ? (raw as InsightsRange) : '7d';
}

const VALID_COCKPIT_RANGES = new Set<CockpitRange>(['24h', '7d', '30d', '90d']);
function parseCockpitRange(raw: string | undefined): CockpitRange {
  if (!raw) return '7d';
  return VALID_COCKPIT_RANGES.has(raw as CockpitRange) ? (raw as CockpitRange) : '7d';
}

function badRequest(c: Context, message: string, code = 'VALIDATION_ERROR') {
  return c.json({ ok: false, error: { code, message } } as ApiResponse, 400);
}

function errResp(c: Context, err: unknown) {
  if (err instanceof WorkspaceNotFoundError) {
    return c.json({ ok: false, error: { code: err.code, message: err.message } } as ApiResponse, err.status);
  }
  if (err instanceof WorkspaceForbiddenError) {
    return c.json({ ok: false, error: { code: err.code, message: err.message } } as ApiResponse, err.status);
  }
  if (err instanceof AgentNotInWorkspaceError) {
    return c.json({ ok: false, error: { code: err.code, message: err.message } } as ApiResponse, err.status);
  }
  const msg = err instanceof Error ? err.message : String(err);
  return c.json({ ok: false, error: { code: 'INTERNAL_ERROR', message: msg } } as ApiResponse, 500);
}

export function createInsightsRouter(deps?: {
  rateLimiter?: RateLimiterService;
  approvalService?: ApprovalService;
}): Hono {
  const router = new Hono();
  // eslint-disable-next-line custom/no-wildcard-sub-router-middleware -- mounted at /insights in routes.ts; wildcard scoped to that prefix
  router.use('*', authMiddleware);

  // Per-endpoint rate-limit middleware. Uses a dedicated action so it does
  // not collide with the global api.write counter.
  // eslint-disable-next-line custom/no-wildcard-sub-router-middleware -- mounted at /insights in routes.ts; wildcard scoped to that prefix
  router.use('*', async (c, next) => {
    if (!deps?.rateLimiter) return next();
    const user = c.get('user');
    if (!user?.imUserId) return next();
    const trustTier = user.trustTier ?? 0;
    const result = await deps.rateLimiter.checkAndConsume(user.imUserId, 'insights.read', trustTier);
    c.header('X-RateLimit-Limit', String(result.limit));
    c.header('X-RateLimit-Remaining', String(result.remaining));
    c.header('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));
    if (!result.allowed) {
      const retryAfter = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
      c.header('Retry-After', String(retryAfter));
      return c.json(
        {
          ok: false,
          error: { code: 'RATE_LIMITED', message: `Insights rate limit exceeded. Retry in ${retryAfter}s.` },
        } as ApiResponse,
        429,
      );
    }
    return next();
  });

  // ── GET /overview ────────────────────────────────────────────────────────
  router.get('/overview', async (c) => {
    const user = c.get('user');
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) return badRequest(c, 'workspaceId is required', 'WORKSPACE_REQUIRED');
    const range = parseRange(c.req.query('range'));
    try {
      await assertWorkspaceMember(workspaceId, user.imUserId);
      const key = cacheKey(['overview', workspaceId, range]);
      const cached = getCached<unknown>(key);
      if (cached) {
        c.header('Cache-Control', 'private, max-age=30');
        c.header('X-Insights-Cache', 'HIT');
        return c.json<ApiResponse>({ ok: true, data: cached });
      }
      const data = await buildOverview({ workspaceId, range });
      setCached(key, data);
      c.header('Cache-Control', 'private, max-age=30');
      c.header('X-Insights-Cache', 'MISS');
      return c.json<ApiResponse>({ ok: true, data });
    } catch (err) {
      return errResp(c, err);
    }
  });

  // ── GET /project/:projectId ──────────────────────────────────────────────
  router.get('/project/:projectId', async (c) => {
    const user = c.get('user');
    const projectId = c.req.param('projectId');
    if (!projectId) return badRequest(c, 'projectId is required');
    const range = parseRange(c.req.query('range'));
    try {
      const key = cacheKey(['project', projectId, range, user.imUserId]);
      const cached = getCached<unknown>(key);
      if (cached) {
        c.header('Cache-Control', 'private, max-age=30');
        c.header('X-Insights-Cache', 'HIT');
        return c.json<ApiResponse>({ ok: true, data: cached });
      }
      // buildProject handles project lookup + 404/403 + membership gate. We
      // then fan-out the 3 extra aggregates (doc 20 §3.3 Gap C F4) in
      // parallel. Doing them outside buildProject keeps the existing widget
      // contract (8 widgets, 10-aggregate fan-out) binary-compatible — see
      // insights.service.ts "Project view extras" comment.
      const base = await buildProject({ projectId, range, actorImUserId: user.imUserId });
      const [activeMemberCount, acceptanceByStatus, activityTimeseries] = await Promise.all([
        getProjectActiveMemberCount({ projectId }),
        getProjectAcceptanceByStatus({ projectId, range }),
        getProjectActivityTimeseries({ projectId, workspaceId: base.workspaceId, range }),
      ]);
      const data = {
        ...base,
        aggregates: {
          activeMemberCount,
          acceptanceByStatus,
          activityTimeseries,
        } as {
          activeMemberCount: ProjectActiveMemberCount;
          acceptanceByStatus: ProjectAcceptanceByStatus;
          activityTimeseries: ProjectActivityTimeseries;
        },
      };
      setCached(key, data);
      c.header('Cache-Control', 'private, max-age=30');
      c.header('X-Insights-Cache', 'MISS');
      return c.json<ApiResponse>({ ok: true, data });
    } catch (err) {
      return errResp(c, err);
    }
  });

  // ── GET /agent/:agentId ──────────────────────────────────────────────────
  router.get('/agent/:agentId', async (c) => {
    const user = c.get('user');
    const agentId = c.req.param('agentId');
    const workspaceId = c.req.query('workspaceId');
    if (!agentId) return badRequest(c, 'agentId is required');
    if (!workspaceId) return badRequest(c, 'workspaceId is required', 'WORKSPACE_REQUIRED');
    const range = parseRange(c.req.query('range'));
    try {
      // release201/20 Gap C F5 — include actorImUserId in cache key so a
      // prior owner hit cannot leak to a non-member caller (the cached
      // entry would short-circuit assertWorkspaceMember and silently 200
      // an outsider). Matches the /project handler's key composition above.
      const key = cacheKey(['agent', workspaceId, agentId, range, user.imUserId]);
      const cached = getCached<unknown>(key);
      if (cached) {
        c.header('Cache-Control', 'private, max-age=30');
        c.header('X-Insights-Cache', 'HIT');
        return c.json<ApiResponse>({ ok: true, data: cached });
      }
      const data = await buildAgent({
        agentId,
        workspaceId,
        range,
        actorImUserId: user.imUserId,
      });
      setCached(key, data);
      c.header('Cache-Control', 'private, max-age=30');
      c.header('X-Insights-Cache', 'MISS');
      return c.json<ApiResponse>({ ok: true, data });
    } catch (err) {
      return errResp(c, err);
    }
  });

  // ── GET /cockpit ─────────────────────────────────────────────────────────
  // One-person company cockpit BFF. Single fan-out (today / trends / agents /
  // stuckTasks) gated on workspace membership. Response shape is the strict
  // contract co-owned with FE track E-Y — DO NOT mutate without coordination.
  router.get('/cockpit', async (c) => {
    const user = c.get('user');
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) return badRequest(c, 'workspaceId is required', 'WORKSPACE_REQUIRED');
    const range = parseCockpitRange(c.req.query('range'));
    try {
      await assertWorkspaceMember(workspaceId, user.imUserId);
      const data = await getCockpit({
        workspaceId,
        range,
        approvalService: deps?.approvalService,
      });
      // Same cache header posture as the other 3 endpoints (private, max-age=30)
      // but no in-process memoisation — cockpit numbers (running / stuck /
      // pendingApprovals) are real-time and stale-by-30s would surprise the
      // owner.
      c.header('Cache-Control', 'private, max-age=5');
      return c.json<ApiResponse>({ ok: true, data });
    } catch (err) {
      return errResp(c, err);
    }
  });

  return router;
}
