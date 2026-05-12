/**
 * Prismer IM — Workspaces API (v1.9.x Track A m1)
 *
 * Workspace = first-class user data context. 1.9.x phase: 1:1 with IMUser.
 * See docs/refactor/02-workspace-data-model.md.
 *
 * Endpoints:
 *   GET    /workspaces            — list caller's workspaces (1:1 → 1 row)
 *   POST   /workspaces            — create (backend-only in 1.9.x)
 *   GET    /workspaces/sync       — daemon delta sync (?since=<ISO>)
 *   GET    /workspaces/:id        — get single
 *   PATCH  /workspaces/:id        — update name / metadata
 *   DELETE /workspaces/:id        — 405 in 1.9.x (deleting default = account close)
 *
 * Note: route file is plural (workspaces.ts) to coexist with the legacy 1.8.2
 * singular `workspace.ts` (workspace-IM bridge using scope strings).
 */

import { Hono } from 'hono';
import { authMiddleware } from '../auth/middleware';
import prisma from '../db';
import type { ApiResponse } from '../types/index';

interface WorkspaceDTO {
  id: string;
  ownerImUserId: string;
  name: string;
  slug: string;
  isDefault: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

function toDTO(row: {
  id: string;
  ownerImUserId: string;
  name: string;
  slug: string;
  isDefault: boolean;
  metadata: string;
  createdAt: Date;
  updatedAt: Date;
}): WorkspaceDTO {
  let metadata: Record<string, unknown> = {};
  try {
    metadata = row.metadata ? JSON.parse(row.metadata) : {};
  } catch {
    metadata = {};
  }
  return {
    id: row.id,
    ownerImUserId: row.ownerImUserId,
    name: row.name,
    slug: row.slug,
    isDefault: row.isDefault,
    metadata,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function createWorkspacesRouter() {
  const router = new Hono();

  router.use('*', authMiddleware);

  // GET /workspaces — list caller's active workspaces
  router.get('/', async (c) => {
    const user = c.get('user');
    const rows = await prisma.iMWorkspace.findMany({
      where: { ownerImUserId: user.imUserId, deletedAt: null },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
    return c.json<ApiResponse<WorkspaceDTO[]>>({ ok: true, data: rows.map(toDTO) });
  });

  // POST /workspaces — create (1.9.x backend-only; frontend should not call)
  router.post('/', async (c) => {
    const user = c.get('user');
    let body: { name?: string; slug?: string; isDefault?: boolean; metadata?: Record<string, unknown> };
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Invalid JSON body' }, 400);
    }
    const name = (body.name ?? '').trim();
    const slug = (body.slug ?? '').trim().toLowerCase();
    if (!name || !slug) {
      return c.json<ApiResponse>({ ok: false, error: 'name and slug are required' }, 400);
    }
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) {
      return c.json<ApiResponse>({ ok: false, error: 'slug must be 1-64 chars [a-z0-9-], leading alnum' }, 400);
    }

    // 1.9.x invariant: at most one default workspace per owner. The first workspace
    // is always default; subsequent ones are non-default. Reject explicit
    // `isDefault: true` if a default already exists (multi-workspace promotion is
    // a 1.10+ concern).
    const existingDefault = await prisma.iMWorkspace.findFirst({
      where: { ownerImUserId: user.imUserId, isDefault: true, deletedAt: null },
      select: { id: true },
    });
    if (body.isDefault === true && existingDefault) {
      return c.json<ApiResponse>({ ok: false, error: 'Owner already has a default workspace' }, 409);
    }
    const isDefault = !existingDefault;

    try {
      const created = await prisma.iMWorkspace.create({
        data: {
          ownerImUserId: user.imUserId,
          name,
          slug,
          isDefault,
          metadata: JSON.stringify(body.metadata ?? {}),
        },
      });
      return c.json<ApiResponse<WorkspaceDTO>>({ ok: true, data: toDTO(created) }, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Unique') || msg.includes('UNIQUE')) {
        return c.json<ApiResponse>({ ok: false, error: 'slug already taken for this owner' }, 409);
      }
      return c.json<ApiResponse>({ ok: false, error: msg }, 500);
    }
  });

  // GET /workspaces/sync — daemon delta sync (registered before /:id)
  router.get('/sync', async (c) => {
    const user = c.get('user');
    const sinceParam = c.req.query('since');
    const sinceDate = sinceParam ? new Date(sinceParam) : null;
    if (sinceParam && (!sinceDate || isNaN(sinceDate.getTime()))) {
      return c.json<ApiResponse>({ ok: false, error: 'since must be a valid ISO timestamp' }, 400);
    }
    const rows = await prisma.iMWorkspace.findMany({
      where: {
        ownerImUserId: user.imUserId,
        ...(sinceDate ? { updatedAt: { gt: sinceDate } } : {}),
      },
      orderBy: { updatedAt: 'asc' },
    });
    const cursor = rows.length > 0 ? rows[rows.length - 1].updatedAt.toISOString() : (sinceParam ?? null);
    return c.json<ApiResponse<{ items: WorkspaceDTO[]; cursor: string | null }>>({
      ok: true,
      data: { items: rows.map(toDTO), cursor },
    });
  });

  // GET /workspaces/:id
  router.get('/:id', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const row = await prisma.iMWorkspace.findFirst({
      where: { id, deletedAt: null },
    });
    if (!row || row.ownerImUserId !== user.imUserId) {
      return c.json<ApiResponse>({ ok: false, error: 'Workspace not found' }, 404);
    }
    return c.json<ApiResponse<WorkspaceDTO>>({ ok: true, data: toDTO(row) });
  });

  // PATCH /workspaces/:id — update name / metadata (slug + isDefault immutable in 1.9.x)
  router.patch('/:id', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const row = await prisma.iMWorkspace.findFirst({
      where: { id, deletedAt: null },
    });
    if (!row || row.ownerImUserId !== user.imUserId) {
      return c.json<ApiResponse>({ ok: false, error: 'Workspace not found' }, 404);
    }
    let body: { name?: string; metadata?: Record<string, unknown> };
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Invalid JSON body' }, 400);
    }
    const data: Record<string, unknown> = {};
    if (typeof body.name === 'string' && body.name.trim()) {
      data.name = body.name.trim();
    }
    if (body.metadata && typeof body.metadata === 'object') {
      data.metadata = JSON.stringify(body.metadata);
    }
    if (Object.keys(data).length === 0) {
      return c.json<ApiResponse>({ ok: false, error: 'No updatable fields supplied' }, 400);
    }
    const updated = await prisma.iMWorkspace.update({ where: { id }, data });
    return c.json<ApiResponse<WorkspaceDTO>>({ ok: true, data: toDTO(updated) });
  });

  // DELETE /workspaces/:id — disabled in 1.9.x (deleting default = account close)
  router.delete('/:id', (c) => {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: 'Workspace deletion is disabled in 1.9.x (deleting default = account close)',
      },
      405,
    );
  });

  return router;
}
