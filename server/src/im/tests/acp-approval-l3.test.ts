import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  iMApproval: {
    rows: [] as any[],
    create: vi.fn(async ({ data }: any) => {
      const row = {
        id: data.id ?? `approval-${prisma.iMApproval.rows.length + 1}`,
        status: 'pending',
        selectedValue: null,
        decidedById: null,
        decidedAt: null,
        createdAt: new Date('2026-05-13T00:00:00.000Z'),
        updatedAt: new Date('2026-05-13T00:00:00.000Z'),
        ...data,
      };
      prisma.iMApproval.rows.push(row);
      return row;
    }),
    findUnique: vi.fn(async ({ where }: any) => prisma.iMApproval.rows.find((row) => row.id === where.id) ?? null),
    // v2.0 §4.4.8.3 — intent dedup lookup. createApproval calls findFirst
    // before insert to dedup same-intent pending approvals. The mock honors
    // (workspaceId, conversationId, intentHash, status) so existing tests
    // (each test minted only one approval per intentHash) keep passing —
    // dedup-specific behaviour is covered in approval-intent-dedup.test.ts.
    findFirst: vi.fn(async ({ where }: any) => {
      let rows = [...prisma.iMApproval.rows];
      if (where?.workspaceId) rows = rows.filter((row) => row.workspaceId === where.workspaceId);
      if (where?.conversationId !== undefined)
        rows = rows.filter((row) => (row.conversationId ?? null) === where.conversationId);
      if (where?.intentHash !== undefined) rows = rows.filter((row) => row.intentHash === where.intentHash);
      if (where?.status) rows = rows.filter((row) => row.status === where.status);
      return rows[0] ?? null;
    }),
    findMany: vi.fn(async ({ where, take }: any) => {
      let rows = [...prisma.iMApproval.rows];
      if (where?.workspaceId) {
        rows = Array.isArray(where.workspaceId.in)
          ? rows.filter((row) => where.workspaceId.in.includes(row.workspaceId))
          : rows.filter((row) => row.workspaceId === where.workspaceId);
      }
      if (where?.conversationId) rows = rows.filter((row) => row.conversationId === where.conversationId);
      if (where?.taskId) rows = rows.filter((row) => row.taskId === where.taskId);
      if (where?.status) rows = rows.filter((row) => row.status === where.status);
      return rows.slice(0, take);
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const row = prisma.iMApproval.rows.find((item) => item.id === where.id);
      if (!row) throw new Error('approval not found');
      Object.assign(row, data, { updatedAt: new Date('2026-05-13T00:01:00.000Z') });
      return row;
    }),
  },
  iMWorkspace: {
    create: vi.fn(async ({ data }: any) => ({ id: 'ws-created', ...data })),
    findUnique: vi.fn(async ({ where }: any) =>
      where.id === 'ws-1' ? { id: 'ws-1', ownerImUserId: 'human-1' } : null,
    ),
    findFirst: vi.fn(async ({ where }: any) => {
      if (where.id !== 'ws-1') return null;
      const actor = where.OR?.[0]?.ownerImUserId ?? where.OR?.[1]?.members?.some?.memberImUserId;
      return ['human-1', 'agent-1'].includes(actor) ? { id: 'ws-1', ownerImUserId: 'human-1' } : null;
    }),
    findMany: vi.fn(async ({ where }: any) => (where.ownerImUserId === 'human-1' ? [{ id: 'ws-1' }] : [])),
  },
  iMWorkspaceMember: {
    findMany: vi.fn(async ({ where }: any) =>
      where.workspaceId === 'ws-1'
        ? [{ memberImUserId: 'agent-1' }]
        : where.memberImUserId === 'agent-1'
          ? [{ workspaceId: 'ws-1' }]
          : [],
    ),
  },
  iMConversation: {
    findUnique: vi.fn(async ({ where }: any) => (where.id === 'conv-1' ? { id: 'conv-1', workspaceId: 'ws-1' } : null)),
  },
  iMParticipant: {
    findUnique: vi.fn(async ({ where }: any) => {
      const userId = where.conversationId_imUserId?.imUserId;
      const conversationId = where.conversationId_imUserId?.conversationId;
      return conversationId === 'conv-1' && ['human-1', 'agent-1'].includes(userId) ? { id: 'part-1' } : null;
    }),
  },
  iMTask: {
    findUnique: vi.fn(async ({ where }: any) =>
      where.id === 'task-1' ? { id: 'task-1', workspaceId: 'ws-1', creatorId: 'human-1', assigneeId: 'agent-1' } : null,
    ),
  },
  iMTaskRun: {
    findUnique: vi.fn(async () => null),
  },
  iMUser: {
    create: vi.fn(async ({ data }: any) => ({
      id: data.id,
      username: data.username,
      displayName: data.displayName,
      role: data.role,
      userId: data.userId,
      trustTier: 0,
      suspendedUntil: null,
      primaryDid: null,
      banned: false,
      createdAt: new Date('2026-05-13T00:00:00.000Z'),
    })),
    findFirst: vi.fn(async ({ where }: any) => {
      const ownerOr = where.AND?.[0]?.OR;
      const ownsCloud1 =
        where.userId === 'cloud-1' ||
        (Array.isArray(ownerOr) && ownerOr.some((clause: any) => clause.userId === 'cloud-1'));
      if (ownsCloud1 && where.username === 'agent-name' && (!where.role || where.role === 'agent')) {
        return {
          id: 'agent-1',
          username: 'agent-name',
          role: 'agent',
          userId: 'cloud-1',
          createdAt: new Date('2026-05-13T00:00:00.000Z'),
        };
      }
      if (ownsCloud1 && where.role === 'human') {
        return {
          id: 'human-1',
          username: 'human',
          role: 'human',
          userId: 'cloud-1',
          createdAt: new Date('2026-05-13T00:00:00.000Z'),
        };
      }
      return null;
    }),
    findUnique: vi.fn(async ({ where }: any) => {
      const roles: Record<string, string> = {
        'human-1': 'human',
        'agent-1': 'agent',
        'agent-2': 'agent',
        'admin-1': 'admin',
      };
      const role = roles[where.id];
      return role ? { id: where.id, role, trustTier: 0, suspendedUntil: null, primaryDid: null, banned: false } : null;
    }),
  },
  iMAgentProfile: {
    findFirst: vi.fn<() => Promise<unknown>>(async () => null),
  },
}));

const emittedNotifications = vi.hoisted(() => ({
  humanApproval: vi.fn(async () => undefined),
}));

vi.mock('../db', () => ({ default: prisma }));
vi.mock('../../lib/notification-emitter', () => ({
  emitHumanApprovalRequestedNotification: emittedNotifications.humanApproval,
}));
vi.mock('../../lib/logger', () => ({
  createModuleLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function resetPrisma() {
  prisma.iMApproval.rows.splice(0);
  vi.clearAllMocks();
  prisma.iMWorkspace.findUnique.mockImplementation(async ({ where }: any) =>
    where.id === 'ws-1' ? { id: 'ws-1', ownerImUserId: 'human-1' } : null,
  );
  prisma.iMWorkspace.findFirst.mockImplementation(async ({ where }: any) => {
    if (where.id !== 'ws-1') return null;
    const actor = where.OR?.[0]?.ownerImUserId ?? where.OR?.[1]?.members?.some?.memberImUserId;
    return ['human-1', 'agent-1'].includes(actor) ? { id: 'ws-1', ownerImUserId: 'human-1' } : null;
  });
  prisma.iMParticipant.findUnique.mockImplementation(async ({ where }: any) => {
    const userId = where.conversationId_imUserId?.imUserId;
    const conversationId = where.conversationId_imUserId?.conversationId;
    return conversationId === 'conv-1' && ['human-1', 'agent-1'].includes(userId) ? { id: 'part-1' } : null;
  });
  prisma.iMUser.findUnique.mockImplementation(async ({ where }: any) => {
    const roles: Record<string, string> = {
      'human-1': 'human',
      'agent-1': 'agent',
      'agent-2': 'agent',
      'admin-1': 'admin',
    };
    const role = roles[where.id];
    return role ? { id: where.id, role, trustTier: 0, suspendedUntil: null, primaryDid: null, banned: false } : null;
  });
  prisma.iMUser.findFirst.mockImplementation(async ({ where }: any) => {
    const ownerOr = where.AND?.[0]?.OR;
    const ownsCloud1 =
      where.userId === 'cloud-1' ||
      (Array.isArray(ownerOr) && ownerOr.some((clause: any) => clause.userId === 'cloud-1'));
    if (ownsCloud1 && where.username === 'agent-name' && (!where.role || where.role === 'agent')) {
      return {
        id: 'agent-1',
        username: 'agent-name',
        role: 'agent',
        userId: 'cloud-1',
        createdAt: new Date('2026-05-13T00:00:00.000Z'),
      };
    }
    if (ownsCloud1 && where.role === 'human') {
      return {
        id: 'human-1',
        username: 'human',
        role: 'human',
        userId: 'cloud-1',
        createdAt: new Date('2026-05-13T00:00:00.000Z'),
      };
    }
    return null;
  });
  prisma.iMUser.create.mockImplementation(async ({ data }: any) => ({
    id: data.id,
    username: data.username,
    displayName: data.displayName,
    role: data.role,
    userId: data.userId,
    trustTier: 0,
    suspendedUntil: null,
    primaryDid: null,
    banned: false,
    createdAt: new Date('2026-05-13T00:00:00.000Z'),
  }));
  prisma.iMAgentProfile.findFirst.mockResolvedValue(null);
}

function makeRooms() {
  return {
    broadcastToRoom: vi.fn(),
    sendToUser: vi.fn(),
  };
}

function makeTaskService() {
  return {
    dispatchApprovalDecisionToAgent: vi.fn(async () => undefined),
    applyApprovalDecisionAndRedispatch: vi.fn(async () => undefined),
    fanOutApprovalBellSync: vi.fn(async () => undefined),
  };
}

describe('ACP L3 approval service', () => {
  beforeEach(resetPrisma);

  it('creates, lists, emits approval.requested, and creates notification fanout', async () => {
    const { ApprovalService } = await import('../services/approval.service');
    const rooms = makeRooms();
    const taskService = makeTaskService();
    const service = new ApprovalService({ rooms: rooms as any, taskService: taskService as any });

    const created = await service.createApproval('agent-1', {
      conversationId: 'conv-1',
      category: 'delete',
      title: 'Delete workspace file',
      context: 'This cannot be undone.',
    });
    const listed = await service.listApprovals('human-1', {
      workspaceId: 'ws-1',
      conversationId: 'conv-1',
      status: 'pending',
    });

    expect(created.workspaceId).toBe('ws-1');
    expect(listed).toHaveLength(1);
    expect(rooms.broadcastToRoom).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({ type: 'approval.requested' }),
    );
    expect(emittedNotifications.humanApproval).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: created.id, recipientImUserId: 'human-1' }),
    );
    expect(taskService.fanOutApprovalBellSync).toHaveBeenCalledWith(
      'human-1',
      expect.objectContaining({ approvalId: created.id }),
    );
  });

  it('lets a workspace agent profile request approval for a workspace conversation without direct participation', async () => {
    const { ApprovalService } = await import('../services/approval.service');
    prisma.iMParticipant.findUnique.mockResolvedValue(null);
    prisma.iMAgentProfile.findFirst.mockResolvedValue({ id: 'profile-2', workspaceId: 'ws-1' });
    const rooms = makeRooms();
    const service = new ApprovalService({ rooms: rooms as any, taskService: makeTaskService() as any });

    const created = await service.createApproval('agent-2', {
      conversationId: 'conv-1',
      category: 'review',
      title: 'Review campaign task',
    });

    expect(created.workspaceId).toBe('ws-1');
    expect(rooms.broadcastToRoom).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({ type: 'approval.requested' }),
    );
  });

  it('decides once, stores comment, emits approval.decided, and redispatches conversation approvals', async () => {
    const { ApprovalConflictError, ApprovalService } = await import('../services/approval.service');
    const rooms = makeRooms();
    const taskService = makeTaskService();
    const service = new ApprovalService({ rooms: rooms as any, taskService: taskService as any });
    const created = await service.createApproval('agent-1', {
      conversationId: 'conv-1',
      category: 'access',
      title: 'Grant token',
    });

    const decided = await service.decideApproval(created.id, 'human-1', {
      selectedValue: 'reject',
      comment: 'Too broad',
    });
    await Promise.resolve();

    expect(decided.status).toBe('rejected');
    expect(decided.decidedById).toBe('human-1');
    expect(decided.metadata.decisionComment).toBe('Too broad');
    expect(rooms.broadcastToRoom).toHaveBeenCalledWith('conv-1', expect.objectContaining({ type: 'approval.decided' }));
    expect(taskService.dispatchApprovalDecisionToAgent).toHaveBeenCalledWith(
      'agent-1',
      expect.objectContaining({ comment: 'Too broad', status: 'rejected' }),
    );
    await expect(service.decideApproval(created.id, 'human-1', { selectedValue: 'approve' })).rejects.toBeInstanceOf(
      ApprovalConflictError,
    );
  });

  it('uses task-flow redispatch semantics for task-scoped decisions', async () => {
    const { ApprovalService } = await import('../services/approval.service');
    const taskService = makeTaskService();
    const service = new ApprovalService({ rooms: makeRooms() as any, taskService: taskService as any });
    const created = await service.createApproval('agent-1', {
      taskId: 'task-1',
      category: 'deploy',
      title: 'Deploy release',
    });

    await service.decideApproval(created.id, 'human-1', { selectedValue: 'approve' });
    await Promise.resolve();

    expect(taskService.applyApprovalDecisionAndRedispatch).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({ approvalId: created.id, status: 'approved' }),
    );
    expect(taskService.dispatchApprovalDecisionToAgent).not.toHaveBeenCalled();
  });

  it('rejects non-human deciders and expired approvals', async () => {
    const { ApprovalAccessError, ApprovalConflictError, ApprovalService } =
      await import('../services/approval.service');
    const service = new ApprovalService({ rooms: makeRooms() as any, taskService: makeTaskService() as any });
    const created = await service.createApproval('agent-1', {
      conversationId: 'conv-1',
      category: 'spend',
      title: 'Spend credits',
      expiresInSeconds: 1,
    });

    await expect(service.decideApproval(created.id, 'agent-1', { selectedValue: 'approve' })).rejects.toBeInstanceOf(
      ApprovalAccessError,
    );
    prisma.iMApproval.rows[0].expiresAt = new Date('2020-01-01T00:00:00.000Z');
    await expect(service.decideApproval(created.id, 'human-1', { selectedValue: 'approve' })).rejects.toBeInstanceOf(
      ApprovalConflictError,
    );
    expect(prisma.iMApproval.rows[0].status).toBe('expired');
  });
});

describe('ACP L3 approval API access control', () => {
  beforeEach(resetPrisma);

  it('returns 409 for duplicate decision conflicts', async () => {
    const { createApprovalsRouter, ApprovalConflictError } = await import('../api/approvals');
    const { signToken } = await import('../auth/jwt');
    const app = createApprovalsRouter({
      decideApproval: vi.fn(async () => {
        throw new ApprovalConflictError('approval is already approved');
      }),
      createApproval: vi.fn(),
      listApprovals: vi.fn(),
    } as any);

    const res = await app.request('/approval-1/decision', {
      method: 'POST',
      headers: { Authorization: `Bearer ${signToken({ sub: 'human-1', username: 'human', role: 'human' })}` },
      body: JSON.stringify({ selectedValue: 'approve' }),
    });
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error.code).toBe('APPROVAL_CONFLICT');
  });

  it('enforces MCP allowlist for agent approval creation', async () => {
    const { createApprovalsRouter } = await import('../api/approvals');
    const { signToken } = await import('../auth/jwt');
    prisma.iMAgentProfile.findFirst.mockResolvedValue({
      config: JSON.stringify({ mcpAllowlist: ['prismer.task.*'] }),
    });
    const app = createApprovalsRouter({
      createApproval: vi.fn(),
      decideApproval: vi.fn(),
      listApprovals: vi.fn(),
    } as any);

    const res = await app.request('/', {
      method: 'POST',
      headers: { Authorization: `Bearer ${signToken({ sub: 'agent-1', username: 'agent', role: 'agent' })}` },
      body: JSON.stringify({ conversationId: 'conv-1', category: 'delete', title: 'Delete file' }),
    });
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body.error.code).toBe('TOOL_NOT_ALLOWED_FOR_AGENT');
  });
});

describe('ACP auth boundary for X-IM-Agent', () => {
  beforeEach(resetPrisma);

  function makeWhoamiApp() {
    const app = new Hono();
    // eslint-disable-next-line custom/no-wildcard-sub-router-middleware -- test-only Hono app used to isolate approval-router middleware; not mounted in production routes
    return app
      .use('*', async (c, next) => {
        const { authMiddleware } = await import('../auth/middleware');
        return authMiddleware(c, next);
      })
      .get('/whoami', (c) => c.json({ ok: true, data: c.get('user') }));
  }

  it('ignores X-IM-Agent on ordinary human JWT requests', async () => {
    const { signToken } = await import('../auth/jwt');
    const app = makeWhoamiApp();

    const res = await app.request('/whoami', {
      headers: {
        Authorization: `Bearer ${signToken({ sub: 'human-1', username: 'human', role: 'human' })}`,
        'X-IM-Agent': 'agent-name',
      },
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.imUserId).toBe('human-1');
    expect(body.data.role).toBe('human');
    expect(prisma.iMUser.findFirst).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ username: 'agent-name' }),
      }),
    );
  });

  it('allows X-IM-Agent only for API-key proxy identity selection', async () => {
    const { signToken } = await import('../auth/jwt');
    const app = makeWhoamiApp();

    const res = await app.request('/whoami', {
      headers: {
        Authorization: `Bearer ${signToken({
          sub: 'cloud-1',
          username: 'human@example.com',
          role: 'human',
          type: 'api_key_proxy' as any,
        })}`,
        'X-IM-Agent': 'agent-name',
      },
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.imUserId).toBe('agent-1');
    expect(body.data.role).toBe('agent');
    expect(prisma.iMUser.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          username: 'agent-name',
          role: 'agent',
          banned: false,
          AND: [
            expect.objectContaining({ OR: expect.arrayContaining([expect.objectContaining({ userId: 'cloud-1' })]) }),
          ],
        }),
      }),
    );
  });

  it('returns a structured proxy error when X-IM-Agent cannot resolve an active agent', async () => {
    const { signToken } = await import('../auth/jwt');
    const app = makeWhoamiApp();

    const res = await app.request('/whoami', {
      headers: {
        Authorization: `Bearer ${signToken({
          sub: 'cloud-1',
          username: 'human@example.com',
          role: 'human',
          type: 'api_key_proxy' as any,
        })}`,
        'X-IM-Agent': 'missing-agent',
        'X-IM-Workspace': 'ws-1',
      },
    });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({
      ok: false,
      error: {
        code: 'AGENT_PROXY_NOT_FOUND',
        message: "Agent 'missing-agent' is not active for this API key in workspace ws-1",
      },
    });
  });

  it('resolves X-IM-Agent through workspace ownership when agent owner fields are stale', async () => {
    const { signToken } = await import('../auth/jwt');
    const app = makeWhoamiApp();

    prisma.iMUser.findFirst.mockImplementation(async ({ where }: any) => {
      const ownerOr = where.AND?.[0]?.OR;
      const ownsCloud1 =
        where.userId === 'cloud-1' ||
        (Array.isArray(ownerOr) && ownerOr.some((clause: any) => clause.userId === 'cloud-1'));

      if (ownsCloud1 && where.role === 'human') {
        return {
          id: 'human-1',
          username: 'human',
          role: 'human',
          userId: 'cloud-1',
          createdAt: new Date('2026-05-13T00:00:00.000Z'),
        };
      }

      const workspaceId = where.agentCard?.is?.workspaceId;
      if (!ownerOr && where.username === 'agent-name' && where.role === 'agent' && workspaceId === 'ws-1') {
        return {
          id: 'agent-1',
          username: 'agent-name',
          role: 'agent',
          userId: 'stale-owner',
          createdAt: new Date('2026-05-13T00:00:00.000Z'),
        };
      }

      return null;
    });

    const res = await app.request('/whoami', {
      headers: {
        Authorization: `Bearer ${signToken({
          sub: 'cloud-1',
          username: 'human@example.com',
          role: 'human',
          type: 'api_key_proxy' as any,
        })}`,
        'X-IM-Agent': 'agent-name',
        'X-IM-Workspace': 'ws-1',
      },
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.imUserId).toBe('agent-1');
    expect(body.data.role).toBe('agent');
    expect(prisma.iMWorkspace.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'ws-1',
          OR: expect.arrayContaining([expect.objectContaining({ ownerImUserId: 'human-1' })]),
        }),
      }),
    );
  });
});

describe('ACP L3 MCP request-human-approval tool', () => {
  afterEach(() => vi.restoreAllMocks());

  it('posts a pending approval request through prismerFetch', async () => {
    vi.resetModules();
    const prismerFetch = vi.fn(async () => ({ ok: true, data: { id: 'approval-1' } }));
    vi.doMock('../../../sdk/prismer-cloud/mcp/src/lib/client.js', () => ({ prismerFetch }));
    const { registerRequestHumanApproval } =
      await import('../../../sdk/prismer-cloud/mcp/src/tools/request-human-approval');
    let handler: ((args: Record<string, unknown>) => Promise<any>) | undefined;
    const server = {
      tool: vi.fn(
        (
          _name: string,
          _description: string,
          _schema: unknown,
          cb: (args: Record<string, unknown>) => Promise<any>,
        ) => {
          handler = cb;
        },
      ),
    };

    registerRequestHumanApproval(server as any);
    if (!handler) throw new Error('MCP handler was not registered');
    const result = await handler({
      conversation_id: 'conv-1',
      category: 'delete',
      title: 'Delete file',
      context: 'Cannot be undone',
    });

    expect(prismerFetch).toHaveBeenCalledWith('/api/im/approvals', expect.objectContaining({ method: 'POST' }));
    expect(((prismerFetch.mock.calls as any)[0][1] as { toolName?: string }).toolName).toBe(
      'prismer.approval.request_human_approval',
    );
    expect(result.content[0].text).toContain('Approval ID');
    expect(result.content[0].text).toContain('pending');
  });
});
