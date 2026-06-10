/**
 * Prismer IM — Skill Lifecycle API (release201/08).
 *
 * Endpoints (mounted at /api/im/skills/...):
 *   POST   /:id/promote                — main state machine transition
 *   POST   /:id/eval/runs              — start an eval session
 *   GET    /:id/eval/runs/:runId       — eval run status / per-case results
 *   POST   /:id/eval/runs/:runId/finish — daemon callback after eval completes
 *   POST   /:id/share/snapshot         — produce cross-org snapshot URL + key
 *   POST   /import-snapshot            — accept snapshot at target workspace
 *   POST   /:id/publish-template       — reviewer-driven publish + autogen
 *
 * Authentication: all routes require an authenticated user (JWT or API key).
 * Authorization is service-layer enforced (ownerAgentId / workspace owner
 * relationship + reviewer-distinct invariant for review→published).
 */

import { Hono } from 'hono';
import { authMiddleware } from '../auth/middleware';
import type { ApiResponse } from '../types/index';
import {
  SkillLifecycleService,
  SkillLifecycleError,
  type LifecycleStage,
  type PublishScope,
  type EvalTestCase,
} from '../services/skill-lifecycle.service';

export function createSkillLifecycleRouter(service: SkillLifecycleService) {
  const router = new Hono();

  /**
   * POST /api/im/skills/:id/promote
   * Body: { to: 'eval'|'review'|'published'|'archived', reason?: string }
   */
  router.post('/:id/promote', authMiddleware, async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Invalid JSON body' }, 400);
    }
    const to = body.to as LifecycleStage | undefined;
    if (!to || !['eval', 'review', 'published', 'archived', 'draft'].includes(to)) {
      return c.json<ApiResponse>({ ok: false, error: 'to is required (draft|eval|review|published|archived)' }, 400);
    }
    try {
      const result = await service.promote(id, {
        to,
        actorId: user.imUserId,
        reason: body.reason,
      });
      return c.json<ApiResponse>({
        ok: true,
        data: {
          skill: { id: result.skill.id, lifecycleStage: result.skill.lifecycleStage, status: result.skill.status },
          taskId: result.taskId ?? null,
        },
      });
    } catch (err) {
      return errToResponse(c, err);
    }
  });

  /**
   * POST /api/im/skills/:id/eval/runs
   * Body: { testCases: EvalTestCase[], allowlistBuiltins?: string[] }
   */
  router.post('/:id/eval/runs', authMiddleware, async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Invalid JSON body' }, 400);
    }
    const testCases = Array.isArray(body.testCases) ? (body.testCases as EvalTestCase[]) : [];
    try {
      const run = await service.startEvalRun(id, testCases, user.imUserId, {
        allowlistBuiltins: Array.isArray(body.allowlistBuiltins) ? body.allowlistBuiltins : undefined,
      });
      return c.json<ApiResponse>({ ok: true, data: run }, 202);
    } catch (err) {
      return errToResponse(c, err);
    }
  });

  /**
   * GET /api/im/skills/:id/eval/runs/:runId
   */
  router.get('/:id/eval/runs/:runId', authMiddleware, async (c) => {
    const runId = c.req.param('runId');
    const run = await service.getEvalRun(runId);
    if (!run) {
      return c.json<ApiResponse>({ ok: false, error: 'Eval run not found' }, 404);
    }
    return c.json<ApiResponse>({ ok: true, data: run });
  });

  /**
   * POST /api/im/skills/:id/eval/runs/:runId/finish
   * Daemon callback after eval completes — writes per-case results and
   * triggers auto-promote to review when pass rate ≥ threshold.
   *
   * Body: { results: EvalTestCaseResult[], agentTraceUrl?: string }
   */
  router.post('/:id/eval/runs/:runId/finish', authMiddleware, async (c) => {
    const user = c.get('user');
    const runId = c.req.param('runId');
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Invalid JSON body' }, 400);
    }
    if (!Array.isArray(body.results)) {
      return c.json<ApiResponse>({ ok: false, error: 'results[] is required' }, 400);
    }
    try {
      const result = await service.recordEvalFinish(runId, {
        results: body.results,
        agentTraceUrl: body.agentTraceUrl,
        actorId: user.imUserId,
      });
      return c.json<ApiResponse>({ ok: true, data: result });
    } catch (err) {
      return errToResponse(c, err);
    }
  });

  /**
   * POST /api/im/skills/:id/share/snapshot
   * Body: { ttlDays?: 7 }
   */
  router.post('/:id/share/snapshot', authMiddleware, async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    try {
      const result = await service.makeSnapshot(id, user.imUserId, body.ttlDays ?? 7);
      return c.json<ApiResponse>({ ok: true, data: result });
    } catch (err) {
      return errToResponse(c, err);
    }
  });

  /**
   * release201/19 D6 — POST /api/im/skills/:id/share/snapshot/:snapshotId/revoke
   *
   * Owner-only flip of `revoked=true` on a previously-issued snapshot row.
   * doc 08 §4.3 lists `revoked` as an invariant; importSnapshot already
   * returns 410 `snapshot_revoked` when the flag is set, but until v2.0.8
   * there was no HTTP path to flip it (service-internal only).
   */
  router.post('/:id/share/snapshot/:snapshotId/revoke', authMiddleware, async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const snapshotId = c.req.param('snapshotId');
    try {
      const result = await service.revokeSnapshot(id, snapshotId, user.imUserId);
      return c.json<ApiResponse>({ ok: true, data: result });
    } catch (err) {
      return errToResponse(c, err);
    }
  });

  /**
   * POST /api/im/skills/import-snapshot
   * Body: { snapshotUrl, snapshotKey, targetWorkspaceId }
   */
  router.post('/import-snapshot', authMiddleware, async (c) => {
    const user = c.get('user');
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Invalid JSON body' }, 400);
    }
    if (!body.snapshotUrl || !body.snapshotKey || !body.targetWorkspaceId) {
      return c.json<ApiResponse>({ ok: false, error: 'snapshotUrl, snapshotKey, targetWorkspaceId are required' }, 400);
    }
    try {
      const result = await service.importSnapshot(
        body.snapshotUrl,
        body.snapshotKey,
        body.targetWorkspaceId,
        user.imUserId,
      );
      return c.json<ApiResponse>({ ok: true, data: result }, 201);
    } catch (err) {
      return errToResponse(c, err);
    }
  });

  /**
   * POST /api/im/skills/:id/publish-template
   * Body: { scope: 'workspace'|'org'|'community', license?, changelog?, includeBoilerplateTask?: boolean }
   *
   * Reviewer-driven publish — bundles the review→published promotion with
   * sample-task + README auto-generation in one call so UI doesn't have to
   * chain 3 endpoints.
   */
  router.post('/:id/publish-template', authMiddleware, async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Invalid JSON body' }, 400);
    }
    const scope = body.scope as PublishScope | undefined;
    if (!scope) {
      return c.json<ApiResponse>({ ok: false, error: 'scope is required' }, 400);
    }
    try {
      const result = await service.publish(id, {
        scope,
        actorId: user.imUserId,
        license: body.license,
        changelog: body.changelog,
        includeBoilerplateTask: body.includeBoilerplateTask !== false,
      });
      return c.json<ApiResponse>({
        ok: true,
        data: {
          skillId: result.skill.id,
          publishScope: result.skill.publishScope,
          publishedAt: result.skill.publishedAt,
          sampleTaskId: result.sampleTaskId ?? null,
          readmeFileId: result.readmeFileId ?? null,
        },
      });
    } catch (err) {
      return errToResponse(c, err);
    }
  });

  return router;
}

function errToResponse(c: any, err: unknown) {
  if (err instanceof SkillLifecycleError) {
    return c.json({ ok: false, error: err.message, code: err.code } as ApiResponse, err.statusCode as any);
  }
  const e = err as { message?: string };
  console.error('[SkillsLifecycle] failed', { err: e?.message });
  return c.json({ ok: false, error: 'skill lifecycle operation failed' } as ApiResponse, 500);
}
