/**
 * WorkspaceOrchestratorService — release 200 §4 Orchestrator Agent 形式化.
 *
 * The orchestrator is a workspace-level deputy: a single agent (per workspace)
 * authorized by the owner to act on the owner's behalf for high-trust task
 * actions (dispatch / approve / reject / cancel any task — see L2 in
 * docs/release200/15-task-state-machine-and-kanban.md §3).
 *
 * Lifecycle:
 *   - Appointed by the workspace owner via POST /workspaces/:id/orchestrator
 *   - At most one *active* orchestrator per workspace. Appointing a new one
 *     auto-revokes the current one in a single transaction.
 *   - Revoked by POST DELETE /workspaces/:id/orchestrator (soft — only sets
 *     orchestratorRevokedAt; agent and audit trail preserved).
 *
 * Storage: 4 columns on im_workspaces (migration 343):
 *   orchestratorAgentId / orchestratorAuthorizedAt /
 *   orchestratorAuthorizedByImUserId / orchestratorRevokedAt
 *
 * Resolution rule (read path):
 *   active orchestrator ⇔ orchestratorAgentId IS NOT NULL
 *                         AND orchestratorRevokedAt IS NULL
 */

import prisma from '../db';

export interface OrchestratorInfo {
  agentImUserId: string;
  agentUsername: string;
  agentDisplayName: string;
  authorizedAt: string; // ISO
  authorizedByImUserId: string;
  authorizedByDisplayName: string;
}

export class NotWorkspaceOwnerError extends Error {
  code = 'NOT_WORKSPACE_OWNER';
  status = 403 as const;
  constructor(workspaceId: string, actorImUserId: string) {
    super(`Actor ${actorImUserId} is not the owner of workspace ${workspaceId}`);
  }
}

export class WorkspaceNotFoundError extends Error {
  code = 'WORKSPACE_NOT_FOUND';
  status = 404 as const;
  constructor(workspaceId: string) {
    super(`Workspace ${workspaceId} not found`);
  }
}

export class AgentNotInWorkspaceError extends Error {
  code = 'AGENT_NOT_IN_WORKSPACE';
  status = 400 as const;
  constructor(agentImUserId: string, workspaceId: string) {
    super(`Agent ${agentImUserId} is not a member of workspace ${workspaceId}`);
  }
}

export class AgentNotAnAgentError extends Error {
  code = 'AGENT_NOT_AN_AGENT';
  status = 400 as const;
  constructor(agentImUserId: string) {
    super(`User ${agentImUserId} is not an agent (role !== 'agent')`);
  }
}

export class WorkspaceOrchestratorService {
  /**
   * GET — surface the active orchestrator (if any), enriched with names so the
   * UI can render "@ceo, authorized by you on 2026-05-19" without a follow-up
   * round-trip.
   */
  async getOrchestrator(workspaceId: string): Promise<OrchestratorInfo | null> {
    const ws = await prisma.iMWorkspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      select: {
        id: true,
        orchestratorAgentId: true,
        orchestratorAuthorizedAt: true,
        orchestratorAuthorizedByImUserId: true,
        orchestratorRevokedAt: true,
      },
    });
    if (!ws) throw new WorkspaceNotFoundError(workspaceId);
    if (!ws.orchestratorAgentId || ws.orchestratorRevokedAt !== null) return null;

    // Resolve agent + authorizer display names. Two separate findUnique calls
    // are clearer than a join here — both rows are tiny and the read path is
    // cold (only hit when settings page is open).
    const agent = await prisma.iMUser.findUnique({
      where: { id: ws.orchestratorAgentId },
      select: { id: true, username: true, displayName: true },
    });
    const authorizerImUserId = ws.orchestratorAuthorizedByImUserId ?? '';
    const authorizer = authorizerImUserId
      ? await prisma.iMUser.findUnique({
          where: { id: authorizerImUserId },
          select: { id: true, displayName: true },
        })
      : null;

    if (!agent) {
      // Agent row was deleted out from under us — treat as no orchestrator
      // (don't 500 the GET; UI will offer to appoint a fresh one).
      return null;
    }

    return {
      agentImUserId: agent.id,
      agentUsername: agent.username,
      agentDisplayName: agent.displayName,
      authorizedAt: (ws.orchestratorAuthorizedAt ?? new Date(0)).toISOString(),
      authorizedByImUserId: authorizerImUserId,
      authorizedByDisplayName: authorizer?.displayName ?? authorizerImUserId,
    };
  }

  /**
   * POST — appoint `agentImUserId` as the workspace's chief-of-staff.
   *
   * If there is already an active orchestrator (different agent), the existing
   * one is revoked atomically with the new appointment so the "one active
   * orchestrator per workspace" invariant never breaks mid-transaction.
   * Re-appointing the same agent is idempotent (refreshes authorizedAt /
   * authorizedBy and clears revokedAt if it was lingering).
   */
  async appointOrchestrator(
    workspaceId: string,
    agentImUserId: string,
    actorImUserId: string,
  ): Promise<void> {
    const ws = await prisma.iMWorkspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      select: { id: true, ownerImUserId: true, orchestratorAgentId: true, orchestratorRevokedAt: true },
    });
    if (!ws) throw new WorkspaceNotFoundError(workspaceId);
    if (ws.ownerImUserId !== actorImUserId) {
      throw new NotWorkspaceOwnerError(workspaceId, actorImUserId);
    }

    // Validate the target is a real agent user.
    const agentUser = await prisma.iMUser.findUnique({
      where: { id: agentImUserId },
      select: { id: true, role: true },
    });
    if (!agentUser) throw new AgentNotInWorkspaceError(agentImUserId, workspaceId);
    if (agentUser.role !== 'agent') throw new AgentNotAnAgentError(agentImUserId);

    // Agent must be associated with this workspace. The agent ↔ workspace edge
    // lives on IMAgentCard.workspaceId (1.9.2+). Checking the card row also
    // implicitly enforces "is an agent" (cards only exist for agent users), but
    // we keep the role check above for a clearer error message.
    const card = await prisma.iMAgentCard.findFirst({
      where: { imUserId: agentImUserId, workspaceId },
      select: { id: true },
    });
    if (!card) throw new AgentNotInWorkspaceError(agentImUserId, workspaceId);

    // Single UPDATE — Prisma's update is atomic at the row level, which is all
    // we need here. The "revoke old then appoint new" sequence collapses to
    // simply overwriting orchestratorAgentId + clearing revokedAt: only one row
    // is being touched, so there is no window where two active orchestrators
    // can coexist.
    await prisma.iMWorkspace.update({
      where: { id: workspaceId },
      data: {
        orchestratorAgentId: agentImUserId,
        orchestratorAuthorizedAt: new Date(),
        orchestratorAuthorizedByImUserId: actorImUserId,
        orchestratorRevokedAt: null,
      },
    });
  }

  /**
   * DELETE — revoke the current orchestrator. Soft revoke: keeps the
   * orchestratorAgentId column populated (for audit visibility) and sets
   * orchestratorRevokedAt = now. Idempotent: revoking when none active is a
   * no-op (returns silently rather than 404 — owner intent is "make sure no
   * orchestrator is acting", which is already the state).
   */
  async revokeOrchestrator(workspaceId: string, actorImUserId: string): Promise<void> {
    const ws = await prisma.iMWorkspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      select: { id: true, ownerImUserId: true, orchestratorAgentId: true, orchestratorRevokedAt: true },
    });
    if (!ws) throw new WorkspaceNotFoundError(workspaceId);
    if (ws.ownerImUserId !== actorImUserId) {
      throw new NotWorkspaceOwnerError(workspaceId, actorImUserId);
    }
    if (!ws.orchestratorAgentId || ws.orchestratorRevokedAt !== null) {
      return; // already revoked / never appointed — no-op
    }
    await prisma.iMWorkspace.update({
      where: { id: workspaceId },
      data: { orchestratorRevokedAt: new Date() },
    });
  }
}
