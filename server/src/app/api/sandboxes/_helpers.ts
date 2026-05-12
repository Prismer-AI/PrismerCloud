/**
 * Shared auth + ownership helpers for /api/sandboxes/* routes.
 *
 * Phase 1: ownership = `IMWorkspace.ownerImUserId === identity.id`.
 * Phase 2 (post-1.10): extend to `IMWorkspaceMember.role` RBAC. The
 * `im_workspace_members` table exists schema-only in 1.9.x — actively
 * querying it is deferred until collab UX lands.
 *
 * Identity resolution is delegated to `requireAuthIdentity` (NextAuth
 * session ➜ JWT bearer ➜ dev fallback). API-key auth (sk-prismer-*) is
 * intentionally NOT supported here — sandbox routes are session-bound.
 */

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireAuthIdentity, AuthError, type AuthIdentity } from '@/lib/auth/guard';

export interface WorkspaceLite {
  id: string;
  ownerImUserId: string;
}

export interface IMContainerRow {
  id: string;
  workspaceId: string;
  tenantId: string;
  agentImUserId: string | null;
  taskId: string | null;
  podName: string;
  namespace: string;
  image: string;
  imageTag: string;
  status: string;
  /**
   * Migration 323 — §30 §2.6 device capacity model. Optional so legacy
   * rows (pre-migration) and partial-select Prisma reads stay readable.
   * Default surfaced by the DTO is 3.
   */
  maxAgents?: number | null;
  cpuRequest: string;
  cpuLimit: string;
  memoryRequest: string;
  memoryLimit: string;
  gatewayUrl: string | null;
  startedAt: Date | null;
  stoppedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type AuthorizeResult<T> = { ok: true; user: AuthIdentity; data: T } | { ok: false; response: NextResponse };

function authFailure(err: unknown): NextResponse {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: 'unauthorized', message: err.message }, { status: err.status });
  }
  console.error('[sandboxes/_helpers] unexpected auth error', err);
  return NextResponse.json({ error: 'internal_error' }, { status: 500 });
}

/**
 * Resolve identity + verify the caller owns `workspaceId`.
 *
 *   401 → no credential
 *   404 → workspace doesn't exist (or soft-deleted)
 *   403 → workspace exists but caller is not the owner
 */
export async function authorizeWorkspace(
  req: NextRequest,
  workspaceId: string,
): Promise<AuthorizeResult<{ workspace: WorkspaceLite }>> {
  let identity: AuthIdentity;
  try {
    identity = await requireAuthIdentity(req);
  } catch (err) {
    return { ok: false, response: authFailure(err) };
  }

  const ws = (await prisma.iMWorkspace.findFirst({
    where: { id: workspaceId, deletedAt: null },
    select: { id: true, ownerImUserId: true },
  })) as WorkspaceLite | null;

  if (!ws) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'workspace_not_found' }, { status: 404 }),
    };
  }

  if (ws.ownerImUserId !== identity.id) {
    // Phase 2: also accept `IMWorkspaceMember` membership; for now, owner-only.
    return {
      ok: false,
      response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
    };
  }

  return { ok: true, user: identity, data: { workspace: ws } };
}

/**
 * Resolve identity + verify the caller owns the workspace that owns `containerId`.
 *
 *   401 → no credential
 *   404 → container missing (we deliberately do not leak existence to non-owners
 *         beyond this — the workspace check that follows also returns 404 when
 *         the workspace is missing)
 *   403 → caller is not the workspace owner
 */
export async function authorizeContainer(
  req: NextRequest,
  containerId: string,
): Promise<AuthorizeResult<{ container: IMContainerRow; workspace: WorkspaceLite }>> {
  let identity: AuthIdentity;
  try {
    identity = await requireAuthIdentity(req);
  } catch (err) {
    return { ok: false, response: authFailure(err) };
  }

  const container = (await prisma.iMContainer.findUnique({
    where: { id: containerId },
  })) as IMContainerRow | null;

  if (!container) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'container_not_found' }, { status: 404 }),
    };
  }

  // Reuse workspace ownership logic (does its own identity resolution; that
  // re-resolves the bearer once more, which is cheap and keeps the helper
  // composable).
  const wsAuth = await authorizeWorkspace(req, container.workspaceId);
  if (!wsAuth.ok) return { ok: false, response: wsAuth.response };

  return {
    ok: true,
    user: identity,
    data: { container, workspace: wsAuth.data.workspace },
  };
}
