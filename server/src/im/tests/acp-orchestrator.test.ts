/**
 * acp-orchestrator.test.ts — release 200 P4 Orchestrator lifecycle.
 *
 * Coverage:
 *   1. getOrchestrator: returns null when none active
 *   2. getOrchestrator: returns enriched info when active
 *   3. appointOrchestrator: owner appoints — happy path
 *   4. appointOrchestrator: appointing a second agent auto-revokes the first
 *   5. appointOrchestrator: non-owner → NotWorkspaceOwnerError (403)
 *   6. appointOrchestrator: target user is not an agent → AgentNotAnAgentError (400)
 *   7. appointOrchestrator: target agent not in workspace → AgentNotInWorkspaceError (400)
 *   8. revokeOrchestrator: owner revokes — happy path (orchestratorRevokedAt set)
 *   9. revokeOrchestrator: non-owner → NotWorkspaceOwnerError (403)
 *  10. revokeOrchestrator: idempotent when none active (no-op, no throw)
 *
 * Strategy: in-memory prisma mock that mirrors only the fields the service
 * touches. Keeps the test self-contained (no DB / no server).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface MockWorkspace {
  id: string;
  ownerImUserId: string;
  deletedAt: Date | null;
  orchestratorAgentId: string | null;
  orchestratorAuthorizedAt: Date | null;
  orchestratorAuthorizedByImUserId: string | null;
  orchestratorRevokedAt: Date | null;
}

interface MockUser {
  id: string;
  username: string;
  displayName: string;
  role: 'human' | 'agent' | 'admin';
}

interface MockAgentCard {
  id: string;
  imUserId: string;
  workspaceId: string;
}

const state = vi.hoisted(() => ({
  workspaces: [] as MockWorkspace[],
  users: [] as MockUser[],
  cards: [] as MockAgentCard[],
}));

vi.mock('../db', () => ({
  default: {
    iMWorkspace: {
      findFirst: vi.fn(async ({ where, select: _select }: any) => {
        return state.workspaces.find(
          (w) => w.id === where.id && (where.deletedAt === null ? w.deletedAt === null : true),
        );
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const ws = state.workspaces.find((w) => w.id === where.id);
        if (!ws) throw new Error('workspace not found');
        Object.assign(ws, data);
        return ws;
      }),
    },
    iMUser: {
      findUnique: vi.fn(async ({ where }: any) => {
        return state.users.find((u) => u.id === where.id) ?? null;
      }),
    },
    iMAgentCard: {
      findFirst: vi.fn(async ({ where }: any) => {
        return (
          state.cards.find(
            (c) => c.imUserId === where.imUserId && c.workspaceId === where.workspaceId,
          ) ?? null
        );
      }),
    },
  },
}));

// Import after mock so the service picks up the mocked prisma.
import {
  WorkspaceOrchestratorService,
  NotWorkspaceOwnerError,
  WorkspaceNotFoundError,
  AgentNotInWorkspaceError,
  AgentNotAnAgentError,
} from '../services/workspace-orchestrator.service';

function seed() {
  state.workspaces.length = 0;
  state.users.length = 0;
  state.cards.length = 0;

  state.users.push(
    { id: 'human-1', username: 'alice', displayName: 'Alice', role: 'human' },
    { id: 'human-2', username: 'bob', displayName: 'Bob', role: 'human' },
    { id: 'agent-1', username: 'ceo-bot', displayName: 'CEO Agent', role: 'agent' },
    { id: 'agent-2', username: 'cs-bot', displayName: 'COO Agent', role: 'agent' },
    { id: 'agent-3', username: 'free-agent', displayName: 'Floating Agent', role: 'agent' },
  );
  state.workspaces.push({
    id: 'ws-1',
    ownerImUserId: 'human-1',
    deletedAt: null,
    orchestratorAgentId: null,
    orchestratorAuthorizedAt: null,
    orchestratorAuthorizedByImUserId: null,
    orchestratorRevokedAt: null,
  });
  // agent-1 and agent-2 belong to ws-1; agent-3 does NOT belong to any workspace.
  state.cards.push(
    { id: 'card-1', imUserId: 'agent-1', workspaceId: 'ws-1' },
    { id: 'card-2', imUserId: 'agent-2', workspaceId: 'ws-1' },
  );
}

describe('WorkspaceOrchestratorService', () => {
  let svc: WorkspaceOrchestratorService;

  beforeEach(() => {
    seed();
    svc = new WorkspaceOrchestratorService();
  });

  it('getOrchestrator returns null when no orchestrator is active', async () => {
    const result = await svc.getOrchestrator('ws-1');
    expect(result).toBeNull();
  });

  it('getOrchestrator returns enriched info after appointment', async () => {
    await svc.appointOrchestrator('ws-1', 'agent-1', 'human-1');
    const result = await svc.getOrchestrator('ws-1');
    expect(result).not.toBeNull();
    expect(result!.agentImUserId).toBe('agent-1');
    expect(result!.agentUsername).toBe('ceo-bot');
    expect(result!.agentDisplayName).toBe('CEO Agent');
    expect(result!.authorizedByImUserId).toBe('human-1');
    expect(result!.authorizedByDisplayName).toBe('Alice');
    // ISO string
    expect(() => new Date(result!.authorizedAt)).not.toThrow();
  });

  it('appointOrchestrator (owner) — happy path', async () => {
    await svc.appointOrchestrator('ws-1', 'agent-1', 'human-1');
    const ws = state.workspaces.find((w) => w.id === 'ws-1')!;
    expect(ws.orchestratorAgentId).toBe('agent-1');
    expect(ws.orchestratorAuthorizedByImUserId).toBe('human-1');
    expect(ws.orchestratorAuthorizedAt).toBeInstanceOf(Date);
    expect(ws.orchestratorRevokedAt).toBeNull();
  });

  it('appointOrchestrator — replacing active orchestrator auto-revokes the old one', async () => {
    await svc.appointOrchestrator('ws-1', 'agent-1', 'human-1');
    await svc.appointOrchestrator('ws-1', 'agent-2', 'human-1');
    const ws = state.workspaces.find((w) => w.id === 'ws-1')!;
    // The single UPDATE overwrites orchestratorAgentId: there is no
    // intermediate "two active orchestrators" state. orchestratorRevokedAt
    // remains null because the new appointment is itself active.
    expect(ws.orchestratorAgentId).toBe('agent-2');
    expect(ws.orchestratorRevokedAt).toBeNull();
    const info = await svc.getOrchestrator('ws-1');
    expect(info!.agentImUserId).toBe('agent-2');
  });

  it('appointOrchestrator — non-owner gets NotWorkspaceOwnerError (403)', async () => {
    await expect(svc.appointOrchestrator('ws-1', 'agent-1', 'human-2')).rejects.toBeInstanceOf(
      NotWorkspaceOwnerError,
    );
  });

  it('appointOrchestrator — target user is not an agent gets AgentNotAnAgentError (400)', async () => {
    await expect(svc.appointOrchestrator('ws-1', 'human-2', 'human-1')).rejects.toBeInstanceOf(
      AgentNotAnAgentError,
    );
  });

  it('appointOrchestrator — target agent not in workspace gets AgentNotInWorkspaceError (400)', async () => {
    await expect(svc.appointOrchestrator('ws-1', 'agent-3', 'human-1')).rejects.toBeInstanceOf(
      AgentNotInWorkspaceError,
    );
  });

  it('appointOrchestrator — unknown agent id surfaces AgentNotInWorkspaceError', async () => {
    await expect(
      svc.appointOrchestrator('ws-1', 'agent-does-not-exist', 'human-1'),
    ).rejects.toBeInstanceOf(AgentNotInWorkspaceError);
  });

  it('revokeOrchestrator — owner revokes (sets orchestratorRevokedAt; agentId preserved for audit)', async () => {
    await svc.appointOrchestrator('ws-1', 'agent-1', 'human-1');
    await svc.revokeOrchestrator('ws-1', 'human-1');
    const ws = state.workspaces.find((w) => w.id === 'ws-1')!;
    expect(ws.orchestratorAgentId).toBe('agent-1'); // preserved
    expect(ws.orchestratorRevokedAt).toBeInstanceOf(Date);
    const info = await svc.getOrchestrator('ws-1');
    expect(info).toBeNull();
  });

  it('revokeOrchestrator — non-owner gets NotWorkspaceOwnerError (403)', async () => {
    await svc.appointOrchestrator('ws-1', 'agent-1', 'human-1');
    await expect(svc.revokeOrchestrator('ws-1', 'human-2')).rejects.toBeInstanceOf(
      NotWorkspaceOwnerError,
    );
  });

  it('revokeOrchestrator — idempotent when no orchestrator is active (no throw)', async () => {
    // Never appointed: revoke is a no-op
    await expect(svc.revokeOrchestrator('ws-1', 'human-1')).resolves.toBeUndefined();
    // Already revoked: still no throw
    await svc.appointOrchestrator('ws-1', 'agent-1', 'human-1');
    await svc.revokeOrchestrator('ws-1', 'human-1');
    await expect(svc.revokeOrchestrator('ws-1', 'human-1')).resolves.toBeUndefined();
  });

  it('getOrchestrator throws WorkspaceNotFoundError for unknown workspace', async () => {
    await expect(svc.getOrchestrator('ws-missing')).rejects.toBeInstanceOf(WorkspaceNotFoundError);
  });
});
