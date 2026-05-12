/**
 * Prismer IM — Workspace Files API (v1.9.x Track A m1)
 *
 * Workspace files = mutable path → asset binding. Same path can be re-bound to
 * a different asset over time; previous bindings are preserved as soft-deleted
 * rows linked through parentVersionId.
 *
 * See docs/refactor/10-asset-network-drive.md §三 / §四.
 *
 * Endpoints (mounted under /workspaces):
 *   GET    /workspaces/:wsId/files                — list active file tree
 *   GET    /workspaces/:wsId/files?path=...       — single file by path
 *   POST   /workspaces/:wsId/files                — bind path → assetId (auto-versions)
 *   DELETE /workspaces/:wsId/files?path=...       — soft delete
 *   GET    /workspaces/:wsId/files/sync           — daemon delta sync (?since=<ISO>)
 *   GET    /workspaces/:wsId/files/:fileId/history — version chain
 */

import { Hono } from 'hono';
import { authMiddleware } from '../auth/middleware';
import prisma from '../db';
import type { ApiResponse } from '../types/index';
import { ServerEvents } from '../ws/events';
import type { RoomManager } from '../ws/rooms';

interface WorkspaceFileDTO {
  id: string;
  workspaceId: string;
  path: string;
  assetId: string;
  contentHash?: string; // joined from im_assets
  version: number;
  parentVersionId: string | null;
  modifierImUserId: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

interface WorkspaceFileRow {
  id: string;
  workspaceId: string;
  path: string;
  assetId: string;
  version: number;
  parentVersionId: string | null;
  modifierImUserId: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  asset?: { contentHash: string } | null;
}

function toDTO(row: WorkspaceFileRow): WorkspaceFileDTO {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    path: row.path,
    assetId: row.assetId,
    contentHash: row.asset?.contentHash,
    version: row.version,
    parentVersionId: row.parentVersionId,
    modifierImUserId: row.modifierImUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
  };
}

async function loadOwnedWorkspace(workspaceId: string, callerImUserId: string) {
  const ws = await prisma.iMWorkspace.findFirst({
    where: { id: workspaceId, deletedAt: null },
    select: { id: true, ownerImUserId: true },
  });
  if (!ws || ws.ownerImUserId !== callerImUserId) return null;
  return ws;
}

function normalizePath(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Reject path traversal and absolute paths.
  if (trimmed.startsWith('/') || trimmed.includes('..') || trimmed.includes('\\')) return null;
  if (trimmed.length > 700) return null;
  return trimmed;
}

/**
 * Wave-54 B6: passing `rooms` here lets create/update/delete publish
 * `workspace_file.changed` to the workspace owner's WS connection so the
 * daemon mirror can pull the delta within 100ms. When `rooms` is undefined
 * (e.g. unit tests that hit the router without a WS layer), publication is
 * silently skipped — the daemon's periodic pull still catches up.
 */
export function createWorkspaceFilesRouter(rooms?: RoomManager) {
  const router = new Hono();

  router.use('*', authMiddleware);

  // GET /:wsId/files/sync — registered before /:wsId/files/:fileId/* to avoid collision
  router.get('/:wsId/files/sync', async (c) => {
    const user = c.get('user');
    const wsId = c.req.param('wsId');
    const ws = await loadOwnedWorkspace(wsId, user.imUserId);
    if (!ws) return c.json<ApiResponse>({ ok: false, error: 'Workspace not found' }, 404);

    const sinceParam = c.req.query('since');
    const sinceDate = sinceParam ? new Date(sinceParam) : null;
    if (sinceParam && (!sinceDate || isNaN(sinceDate.getTime()))) {
      return c.json<ApiResponse>({ ok: false, error: 'since must be a valid ISO timestamp' }, 400);
    }
    const rows = await prisma.iMWorkspaceFile.findMany({
      where: {
        workspaceId: wsId,
        ...(sinceDate ? { updatedAt: { gt: sinceDate } } : {}),
      },
      include: { asset: { select: { contentHash: true } } },
      orderBy: { updatedAt: 'asc' },
    });
    const cursor = rows.length > 0 ? rows[rows.length - 1].updatedAt.toISOString() : (sinceParam ?? null);
    return c.json<ApiResponse<{ items: WorkspaceFileDTO[]; cursor: string | null }>>({
      ok: true,
      data: { items: rows.map((r: WorkspaceFileRow) => toDTO(r)), cursor },
    });
  });

  // GET /:wsId/files/:fileId/history — version chain
  router.get('/:wsId/files/:fileId/history', async (c) => {
    const user = c.get('user');
    const wsId = c.req.param('wsId');
    const fileId = c.req.param('fileId');
    const ws = await loadOwnedWorkspace(wsId, user.imUserId);
    if (!ws) return c.json<ApiResponse>({ ok: false, error: 'Workspace not found' }, 404);

    // Walk parentVersionId chain. Cap at 1000 hops to defend against cycles.
    const chain: WorkspaceFileRow[] = [];
    let cursor: string | null = fileId;
    let safety = 1000;
    while (cursor && safety-- > 0) {
      const row: WorkspaceFileRow | null = await prisma.iMWorkspaceFile.findFirst({
        where: { id: cursor, workspaceId: wsId },
        include: { asset: { select: { contentHash: true } } },
      });
      if (!row) break;
      chain.push(row);
      cursor = row.parentVersionId;
    }
    if (chain.length === 0) {
      return c.json<ApiResponse>({ ok: false, error: 'File not found' }, 404);
    }
    return c.json<ApiResponse<WorkspaceFileDTO[]>>({
      ok: true,
      data: chain.map((r) => toDTO(r)),
    });
  });

  // GET /:wsId/files — list tree, or single by ?path=
  router.get('/:wsId/files', async (c) => {
    const user = c.get('user');
    const wsId = c.req.param('wsId');
    const ws = await loadOwnedWorkspace(wsId, user.imUserId);
    if (!ws) return c.json<ApiResponse>({ ok: false, error: 'Workspace not found' }, 404);

    const pathParam = c.req.query('path');
    if (pathParam) {
      const normalized = normalizePath(pathParam);
      if (!normalized) return c.json<ApiResponse>({ ok: false, error: 'Invalid path' }, 400);
      const row: WorkspaceFileRow | null = await prisma.iMWorkspaceFile.findFirst({
        where: { workspaceId: wsId, path: normalized, deletedAt: null },
        include: { asset: { select: { contentHash: true } } },
      });
      if (!row) return c.json<ApiResponse>({ ok: false, error: 'File not found' }, 404);
      return c.json<ApiResponse<WorkspaceFileDTO>>({ ok: true, data: toDTO(row) });
    }

    const rows = await prisma.iMWorkspaceFile.findMany({
      where: { workspaceId: wsId, deletedAt: null },
      include: { asset: { select: { contentHash: true } } },
      orderBy: { path: 'asc' },
    });
    return c.json<ApiResponse<WorkspaceFileDTO[]>>({
      ok: true,
      data: rows.map((r: WorkspaceFileRow) => toDTO(r)),
    });
  });

  // POST /:wsId/files — bind path → asset (auto-versioning + soft-delete previous)
  router.post('/:wsId/files', async (c) => {
    const user = c.get('user');
    const wsId = c.req.param('wsId');
    const ws = await loadOwnedWorkspace(wsId, user.imUserId);
    if (!ws) return c.json<ApiResponse>({ ok: false, error: 'Workspace not found' }, 404);

    let body: { path?: string; assetId?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Invalid JSON body' }, 400);
    }
    const normalized = body.path ? normalizePath(body.path) : null;
    if (!normalized)
      return c.json<ApiResponse>({ ok: false, error: 'path is required and must be relative without ..' }, 400);
    if (!body.assetId) return c.json<ApiResponse>({ ok: false, error: 'assetId is required' }, 400);

    // Asset must exist and belong to the same workspace.
    const asset = await prisma.iMAsset.findUnique({
      where: { id: body.assetId },
      select: { id: true, workspaceId: true, contentHash: true },
    });
    if (!asset || asset.workspaceId !== wsId) {
      return c.json<ApiResponse>({ ok: false, error: 'Asset not found in this workspace' }, 404);
    }

    // Find existing active binding at this path.
    const existing = await prisma.iMWorkspaceFile.findFirst({
      where: { workspaceId: wsId, path: normalized, deletedAt: null },
    });

    // Idempotent shortcut: same path + same asset → no-op.
    if (existing && existing.assetId === asset.id) {
      const reread: WorkspaceFileRow | null = await prisma.iMWorkspaceFile.findFirst({
        where: { id: existing.id },
        include: { asset: { select: { contentHash: true } } },
      });
      return c.json<ApiResponse<WorkspaceFileDTO>>({ ok: true, data: toDTO(reread!) });
    }

    const result = await prisma.$transaction(async (tx: typeof prisma) => {
      let parentVersionId: string | null = null;
      let nextVersion = 1;
      if (existing) {
        await tx.iMWorkspaceFile.update({
          where: { id: existing.id },
          data: { deletedAt: new Date() },
        });
        parentVersionId = existing.id;
        nextVersion = existing.version + 1;
      }
      const created = await tx.iMWorkspaceFile.create({
        data: {
          workspaceId: wsId,
          path: normalized,
          assetId: asset.id,
          version: nextVersion,
          parentVersionId,
          modifierImUserId: user.imUserId,
        },
        include: { asset: { select: { contentHash: true } } },
      });
      return created as WorkspaceFileRow;
    });

    // Wave-54 B6: notify the workspace owner's daemon so it can pull the
    // delta. The DB commit is the source of truth; publish failures (transport
    // closed, serialization bug) must not fail the request — the daemon will
    // catch up via the next periodic /files/sync poll.
    try {
      rooms?.sendToUser(
        ws.ownerImUserId,
        ServerEvents.workspaceFileChanged({
          workspaceId: wsId,
          path: normalized,
          operation: existing ? 'update' : 'create',
          assetId: asset.id,
          contentHash: asset.contentHash,
          version: result.version,
        }),
      );
    } catch (err) {
      console.error('[WorkspaceFiles] WS publish failed', {
        wsId,
        path: normalized,
        operation: existing ? 'update' : 'create',
        err: err instanceof Error ? err.message : String(err),
      });
    }
    return c.json<ApiResponse<WorkspaceFileDTO>>({ ok: true, data: toDTO(result) }, 201);
  });

  // DELETE /:wsId/files?path=... — soft delete active binding
  router.delete('/:wsId/files', async (c) => {
    const user = c.get('user');
    const wsId = c.req.param('wsId');
    const ws = await loadOwnedWorkspace(wsId, user.imUserId);
    if (!ws) return c.json<ApiResponse>({ ok: false, error: 'Workspace not found' }, 404);

    const pathParam = c.req.query('path');
    const normalized = pathParam ? normalizePath(pathParam) : null;
    if (!normalized) {
      return c.json<ApiResponse>({ ok: false, error: 'path query param is required' }, 400);
    }
    const existing = await prisma.iMWorkspaceFile.findFirst({
      where: { workspaceId: wsId, path: normalized, deletedAt: null },
    });
    if (!existing) {
      return c.json<ApiResponse>({ ok: false, error: 'File not found' }, 404);
    }
    await prisma.iMWorkspaceFile.update({
      where: { id: existing.id },
      data: { deletedAt: new Date() },
    });
    // Wave-54 B6: emit the delete signal so the daemon can drop the row
    // from its mirror without waiting for the next periodic pull. Same
    // error-isolation discipline as the create/update branch above.
    try {
      rooms?.sendToUser(
        ws.ownerImUserId,
        ServerEvents.workspaceFileChanged({
          workspaceId: wsId,
          path: normalized,
          operation: 'delete',
          version: existing.version,
        }),
      );
    } catch (err) {
      console.error('[WorkspaceFiles] WS publish failed', {
        wsId,
        path: normalized,
        operation: 'delete',
        err: err instanceof Error ? err.message : String(err),
      });
    }
    return c.json<ApiResponse>({ ok: true });
  });

  return router;
}
