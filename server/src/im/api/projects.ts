/**
 * Prismer IM — Projects API (release201/09 Phase 1, v2.0.7).
 *
 * 7 endpoints (09 §6.1 + §6.2):
 *   GET    /projects?workspaceId=          — list (status/search/limit/offset)
 *   POST   /projects                       — create
 *   GET    /projects/:id                   — get + member count
 *   PATCH  /projects/:id                   — update
 *   DELETE /projects/:id                   — soft delete (cascade=archive default)
 *   GET    /projects/:id/members
 *   POST   /projects/:id/members
 *   PATCH  /projects/:id/members/:membershipId
 *   DELETE /projects/:id/members/:membershipId
 *
 * The "7 endpoint" count refers to logical endpoint groups (project CRUD = 5,
 * membership CRUD = 4); collapsed to 7 by counting CRUD methods that share the
 * same intent (list/create on /projects, list/create/update/remove on /members).
 *
 * Auth: authMiddleware (workspace-scoped permission enforced in service layer).
 * Phase 1 不修改任何已有资源 list endpoint;projectId filter 在后续 Phase 2 才接入.
 */

import { Hono } from 'hono';
import prisma from '../db';
import { authMiddleware } from '../auth/middleware';
import type { ApiResponse } from '../types/index';
import {
  ProjectService,
  ProjectNotFoundError,
  WorkspaceNotFoundError,
  ProjectForbiddenError,
  ProjectValidationError,
  ProjectConflictError,
  MembershipNotFoundError,
  NotWorkspaceMemberError,
  HardCascadeNotImplementedError,
  type ProjectStatus,
  type MembershipRole,
  type PrincipalKind,
  type DeleteCascade,
} from '../services/project.service';

type KnownErr =
  | ProjectNotFoundError
  | WorkspaceNotFoundError
  | ProjectForbiddenError
  | ProjectValidationError
  | ProjectConflictError
  | MembershipNotFoundError
  | NotWorkspaceMemberError
  | HardCascadeNotImplementedError;

function isKnownErr(err: unknown): err is KnownErr {
  return (
    err instanceof ProjectNotFoundError ||
    err instanceof WorkspaceNotFoundError ||
    err instanceof ProjectForbiddenError ||
    err instanceof ProjectValidationError ||
    err instanceof ProjectConflictError ||
    err instanceof MembershipNotFoundError ||
    err instanceof NotWorkspaceMemberError ||
    err instanceof HardCascadeNotImplementedError
  );
}

function errorResponse(err: unknown): {
  body: ApiResponse;
  status: 400 | 403 | 404 | 405 | 409 | 422 | 500;
} {
  if (isKnownErr(err)) {
    return {
      body: { ok: false, error: { code: err.code, message: err.message } },
      status: err.status,
    };
  }
  const msg = err instanceof Error ? err.message : String(err);
  return { body: { ok: false, error: msg }, status: 500 };
}

export function createProjectsRouter() {
  const router = new Hono();
  const service = new ProjectService();

  // eslint-disable-next-line custom/no-wildcard-sub-router-middleware -- mounted at /projects in routes.ts; wildcard scoped to that prefix
  router.use('*', authMiddleware);

  // GET /projects?workspaceId=&status=&search=&limit=&offset=
  router.get('/', async (c) => {
    const user = c.get('user');
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) {
      return c.json<ApiResponse>(
        { ok: false, error: { code: 'PROJECT_VALIDATION', message: 'workspaceId is required' } },
        400,
      );
    }
    const status = c.req.query('status');
    const search = c.req.query('search');
    const limit = c.req.query('limit') ? Number(c.req.query('limit')) : undefined;
    const offset = c.req.query('offset') ? Number(c.req.query('offset')) : undefined;
    if (status && status !== 'active' && status !== 'archived') {
      return c.json<ApiResponse>(
        { ok: false, error: { code: 'PROJECT_VALIDATION', message: 'status must be active|archived' } },
        400,
      );
    }
    try {
      const result = await service.list({
        workspaceId,
        actorImUserId: user.imUserId,
        status: status as ProjectStatus | undefined,
        search: search || undefined,
        limit,
        offset,
      });
      return c.json<ApiResponse>({ ok: true, data: result });
    } catch (err) {
      const { body, status: code } = errorResponse(err);
      return c.json<ApiResponse>(body, code);
    }
  });

  // POST /projects { workspaceId, slug, name, description?, metadata? }
  router.post('/', async (c) => {
    const user = c.get('user');
    let body: {
      workspaceId?: string;
      slug?: string;
      name?: string;
      description?: string | null;
      metadata?: Record<string, unknown>;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Invalid JSON body' }, 400);
    }
    if (!body.workspaceId) {
      return c.json<ApiResponse>(
        { ok: false, error: { code: 'PROJECT_VALIDATION', message: 'workspaceId is required' } },
        400,
      );
    }
    try {
      const created = await service.create({
        workspaceId: body.workspaceId,
        actorImUserId: user.imUserId,
        slug: body.slug ?? '',
        name: body.name ?? '',
        description: body.description ?? null,
        metadata: body.metadata ?? {},
      });
      return c.json<ApiResponse>({ ok: true, data: created }, 201);
    } catch (err) {
      const { body: errBody, status: code } = errorResponse(err);
      return c.json<ApiResponse>(errBody, code);
    }
  });

  // ── Member sub-routes (registered before /:id to avoid Hono treating
  //   'members' as part of the project id tail) ─────────────────────────
  router.get('/:id/members', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    try {
      const items = await service.listMembers(id, user.imUserId);
      return c.json<ApiResponse>({ ok: true, data: items });
    } catch (err) {
      const { body, status: code } = errorResponse(err);
      return c.json<ApiResponse>(body, code);
    }
  });

  router.post('/:id/members', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    let body: { principalKind?: string; principalId?: string; role?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Invalid JSON body' }, 400);
    }
    try {
      const created = await service.addMember(id, user.imUserId, {
        principalKind: (body.principalKind ?? '') as PrincipalKind,
        principalId: body.principalId ?? '',
        role: body.role ? (body.role as MembershipRole) : undefined,
      });
      return c.json<ApiResponse>({ ok: true, data: created }, 201);
    } catch (err) {
      const { body: errBody, status: code } = errorResponse(err);
      return c.json<ApiResponse>(errBody, code);
    }
  });

  router.patch('/:id/members/:membershipId', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const membershipId = c.req.param('membershipId');
    let body: { role?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Invalid JSON body' }, 400);
    }
    try {
      const updated = await service.updateMember(id, user.imUserId, membershipId, {
        role: (body.role ?? '') as MembershipRole,
      });
      return c.json<ApiResponse>({ ok: true, data: updated });
    } catch (err) {
      const { body: errBody, status: code } = errorResponse(err);
      return c.json<ApiResponse>(errBody, code);
    }
  });

  router.delete('/:id/members/:membershipId', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const membershipId = c.req.param('membershipId');
    try {
      await service.removeMember(id, user.imUserId, membershipId);
      return c.json<ApiResponse>({ ok: true });
    } catch (err) {
      const { body, status: code } = errorResponse(err);
      return c.json<ApiResponse>(body, code);
    }
  });

  // GET /projects/:id/overview — release201/09 Phase 4 §15.1 (S31 C).
  // Drawer-facing BFF: aggregate everything the 4-tab overview drawer needs
  // in a single roundtrip so the client doesn't fan out 5 separate fetches.
  // Returns:
  //   { project, taskStats: { open, running, review, completed, failed },
  //     recentTasks: TaskOverviewRow[], memberCount, agentCount,
  //     conversationCount } — conversationCount is 0 in v2.0.7 (IMConversation
  //     has no projectId column until v2.0.8 / 09 §10.2 Phase 5).
  //
  // Permission: ProjectService.get already enforces workspace owner /
  // membership; service throws ProjectForbiddenError for non-members.
  router.get('/:id/overview', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    try {
      const project = await service.get(id, user.imUserId);

      // Aggregate task stats inline. IMTask.projectId may be NULL across the
      // table; we look up only rows belonging to this project.
      // Distinct buckets (09 §0.2 + 10 doc enum):
      //   open       — pending | assigned
      //   running    — running
      //   review     — review | blocked
      //   completed  — completed
      //   failed     — failed | cancelled
      const tasksGrouped = await prisma.iMTask.groupBy({
        by: ['status'],
        where: { projectId: id },
        _count: { _all: true },
      });
      const taskStats = {
        open: 0,
        running: 0,
        review: 0,
        completed: 0,
        failed: 0,
        total: 0,
      };
      for (const row of tasksGrouped) {
        const n = row._count?._all ?? 0;
        taskStats.total += n;
        switch (row.status) {
          case 'pending':
          case 'assigned':
            taskStats.open += n;
            break;
          case 'running':
            taskStats.running += n;
            break;
          case 'review':
          case 'blocked':
            taskStats.review += n;
            break;
          case 'completed':
            taskStats.completed += n;
            break;
          case 'failed':
          case 'cancelled':
            taskStats.failed += n;
            break;
          default:
            // unknown status → bucket as "open" so it stays visible
            taskStats.open += n;
        }
      }

      // Recent task rows for the Tasks tab. Hard-cap at 20 (drawer pagination
      // can drill into the board surface for more); v2.0.8 may add cursor.
      const recentTasksRows = await prisma.iMTask.findMany({
        where: { projectId: id },
        orderBy: [{ updatedAt: 'desc' }],
        take: 20,
        select: {
          id: true,
          title: true,
          status: true,
          assigneeId: true,
          currentPhase: true,
          updatedAt: true,
          createdAt: true,
          completedAt: true,
        },
      });
      const recentTasks = recentTasksRows.map((row: (typeof recentTasksRows)[number]) => ({
        id: row.id,
        title: row.title,
        status: row.status,
        assigneeId: row.assigneeId,
        currentPhase: row.currentPhase,
        updatedAt: row.updatedAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
        completedAt: row.completedAt ? row.completedAt.toISOString() : null,
      }));

      // Agent membership count — IMAgentProjectMembership.principalKind='agent'
      const agentCount = await prisma.iMAgentProjectMembership.count({
        where: { projectId: id, principalKind: 'agent' },
      });

      // Conversation count is 0 until v2.0.8 (09 §10.2 Phase 5 — IMConversation
      // has no projectId column yet). We still ship the field so the client
      // can render the tab without a special v2.0.7 branch.
      const conversationCount = 0;

      return c.json<ApiResponse>({
        ok: true,
        data: {
          project,
          taskStats,
          recentTasks,
          memberCount: project.memberCount,
          agentCount,
          conversationCount,
          // 09 §0.2 — explicit deferred flag so UI can surface "v2.0.8+ 后启用"
          // without hard-coding the version literal in 3 places.
          deferred: {
            conversations: true, // 09 §10.2 Phase 5
            assets: true, // 09 §10.2 Phase 5
            memory: true, // 09 §10.2 Phase 7+
          },
        },
      });
    } catch (err) {
      const { body, status: code } = errorResponse(err);
      return c.json<ApiResponse>(body, code);
    }
  });

  // ── /:id project-scoped CRUD ────────────────────────────────────────
  router.get('/:id', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    try {
      const project = await service.get(id, user.imUserId);
      return c.json<ApiResponse>({ ok: true, data: project });
    } catch (err) {
      const { body, status: code } = errorResponse(err);
      return c.json<ApiResponse>(body, code);
    }
  });

  router.patch('/:id', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    let body: {
      name?: string;
      description?: string | null;
      status?: string;
      metadata?: Record<string, unknown>;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Invalid JSON body' }, 400);
    }
    try {
      const updated = await service.update(id, user.imUserId, {
        name: body.name,
        description: body.description,
        status: body.status as ProjectStatus | undefined,
        metadata: body.metadata,
      });
      return c.json<ApiResponse>({ ok: true, data: updated });
    } catch (err) {
      const { body: errBody, status: code } = errorResponse(err);
      return c.json<ApiResponse>(errBody, code);
    }
  });

  // DELETE /projects/:id?cascade=archive|null|hard
  // 09 §4.4 + §15.1 Phase 4:
  //   - cascade=archive (默) → soft archive; 关联资源 projectId 不变
  //   - cascade=null         → unscope 关联 im_tasks.projectId → NULL, 再软删
  //   - cascade=hard         → v2.0.7 NOT implemented → 405 +
  //                            'hard_cascade_not_implemented' (forbidden:
  //                            §15.1 Phase 4 explicitly defers to v2.1+)
  router.delete('/:id', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const cascade = (c.req.query('cascade') ?? 'archive') as DeleteCascade;
    if (cascade !== 'archive' && cascade !== 'null' && cascade !== 'hard') {
      return c.json<ApiResponse>(
        { ok: false, error: { code: 'PROJECT_VALIDATION', message: 'cascade must be archive|null|hard' } },
        400,
      );
    }
    try {
      const result = await service.remove(id, user.imUserId, cascade);
      return c.json<ApiResponse>({ ok: true, data: result });
    } catch (err) {
      const { body, status: code } = errorResponse(err);
      return c.json<ApiResponse>(body, code);
    }
  });

  return router;
}
