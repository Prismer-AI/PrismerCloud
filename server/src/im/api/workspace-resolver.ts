import type { Context } from 'hono';
import prisma from '../db';
import type { ApiResponse } from '../types/index';

export class WorkspaceResolutionError extends Error {
  constructor(
    message: string,
    public status: 400 | 404 = 400,
  ) {
    super(message);
    this.name = 'WorkspaceResolutionError';
  }
}

function normalizeExplicitWorkspaceId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function resolveMemoryWorkspaceIdForRequest(c: Context, explicit?: unknown): Promise<string> {
  const user = c.get('user');
  const explicitWorkspaceId =
    normalizeExplicitWorkspaceId(explicit) ?? normalizeExplicitWorkspaceId(c.req.header('X-Workspace-Id'));

  if (user.role === 'agent') {
    const card = await prisma.iMAgentCard.findUnique({
      where: { imUserId: user.imUserId },
      select: { workspaceId: true },
    });
    if (!card?.workspaceId) {
      throw new WorkspaceResolutionError('Agent is not bound to a workspace');
    }
    if (explicitWorkspaceId && explicitWorkspaceId !== card.workspaceId) {
      throw new WorkspaceResolutionError('Agent workspaceId does not match its workspace binding');
    }
    return card.workspaceId;
  }

  if (explicitWorkspaceId) {
    const workspace = await prisma.iMWorkspace.findFirst({
      where: { id: explicitWorkspaceId, ownerImUserId: user.imUserId, deletedAt: null },
      select: { id: true },
    });
    if (!workspace) {
      throw new WorkspaceResolutionError('Workspace not found', 404);
    }
    return workspace.id;
  }

  const defaultWorkspace = await prisma.iMWorkspace.findFirst({
    where: { ownerImUserId: user.imUserId, deletedAt: null },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    select: { id: true },
  });
  if (!defaultWorkspace) {
    throw new WorkspaceResolutionError('No default workspace found for caller');
  }
  return defaultWorkspace.id;
}

export function memoryWorkspaceErrorResponse(c: Context, err: unknown) {
  if (err instanceof WorkspaceResolutionError) {
    return c.json<ApiResponse>({ ok: false, error: err.message }, err.status);
  }
  throw err;
}
