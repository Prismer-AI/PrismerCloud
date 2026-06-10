import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  iMWorkspace: {
    findFirst: vi.fn(),
  },
  iMAgentProfile: {
    findMany: vi.fn(),
  },
  iMAgentCard: {
    findUnique: vi.fn(),
  },
  iMConversation: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
  },
  iMParticipant: {
    findUnique: vi.fn(),
  },
}));

vi.mock('../db', () => ({ default: prisma }));
vi.mock('../auth/middleware', () => ({ authMiddleware: vi.fn(async (_c, next) => next()) }));

function resetPrisma() {
  prisma.iMWorkspace.findFirst.mockReset();
  prisma.iMAgentProfile.findMany.mockReset();
  prisma.iMAgentCard.findUnique.mockReset();
  prisma.iMConversation.findUnique.mockReset();
  prisma.iMConversation.findMany.mockReset();
  prisma.iMParticipant.findUnique.mockReset();
}

describe('ACP conversation visibility', () => {
  beforeEach(resetPrisma);

  it('resolves agent-agent direct workspace from shared active profiles', async () => {
    const { resolveDirectWorkspaceId } = await import('../api/conversations');

    prisma.iMWorkspace.findFirst.mockResolvedValue(null);
    prisma.iMAgentProfile.findMany
      .mockResolvedValueOnce([{ workspaceId: 'ws-shared' }, { workspaceId: 'ws-creator' }])
      .mockResolvedValueOnce([{ workspaceId: 'ws-shared' }]);
    prisma.iMAgentCard.findUnique.mockResolvedValue(null);

    await expect(resolveDirectWorkspaceId('agent-ceo', 'agent-market')).resolves.toBe('ws-shared');
  });

  it('falls back to the creator agent card workspace when profiles do not intersect', async () => {
    const { resolveDirectWorkspaceId } = await import('../api/conversations');

    prisma.iMWorkspace.findFirst.mockResolvedValue(null);
    prisma.iMAgentProfile.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ workspaceId: 'ws-other' }]);
    prisma.iMAgentCard.findUnique
      .mockResolvedValueOnce({ workspaceId: 'ws-creator-card' })
      .mockResolvedValueOnce({ workspaceId: 'ws-other-card' });

    await expect(resolveDirectWorkspaceId('agent-ceo', 'agent-market')).resolves.toBe('ws-creator-card');
  });

  it('filters participant conversations to the requested workspace', async () => {
    const { filterConversationsForWorkspace } = await import('../api/conversations');

    const rows = [
      { id: 'conv-old', workspaceId: 'ws-old' },
      { id: 'conv-current', workspaceId: 'ws-current' },
      { id: 'conv-null', workspaceId: null },
    ];

    expect(filterConversationsForWorkspace(rows, 'ws-current')).toEqual([
      { id: 'conv-current', workspaceId: 'ws-current' },
    ]);
    expect(filterConversationsForWorkspace(rows, null)).toEqual(rows);
  });

  it('allows owner/admin observation of workspace conversations but not member observation', async () => {
    const { canObserveWorkspaceConversation } = await import('../api/conversation-visibility');

    prisma.iMConversation.findUnique.mockResolvedValue({
      workspaceId: 'ws-1',
      participants: [],
    });
    prisma.iMWorkspace.findFirst.mockImplementation(async ({ where }: any) => {
      if (where.OR?.[0]?.ownerImUserId === 'owner-1') return { id: 'ws-1' };
      const memberRole = where.OR?.[1]?.members?.some?.role?.in;
      if (where.OR?.[1]?.members?.some?.memberImUserId === 'admin-1' && memberRole?.includes('admin')) {
        return { id: 'ws-1' };
      }
      return null;
    });

    await expect(canObserveWorkspaceConversation('conv-1', 'owner-1')).resolves.toBe(true);
    await expect(canObserveWorkspaceConversation('conv-1', 'admin-1')).resolves.toBe(true);
    await expect(canObserveWorkspaceConversation('conv-1', 'member-1')).resolves.toBe(false);
  });

  it('allows only workspace owners to globally manage observed conversations', async () => {
    const { canManageObservedWorkspaceConversation } = await import('../api/conversation-visibility');

    prisma.iMConversation.findUnique.mockResolvedValue({
      workspaceId: 'ws-1',
      participants: [],
    });
    prisma.iMWorkspace.findFirst.mockImplementation(async ({ where }: any) => {
      if (where.OR?.[0]?.ownerImUserId === 'owner-1') return { id: 'ws-1' };
      if (where.OR?.[1]?.members?.some?.memberImUserId === 'admin-1') return null;
      return null;
    });

    await expect(canManageObservedWorkspaceConversation('conv-1', 'owner-1')).resolves.toBe(true);
    await expect(canManageObservedWorkspaceConversation('conv-1', 'admin-1')).resolves.toBe(false);
  });

  it('allows workspace owners to observe conversations that include a human participant', async () => {
    const { canObserveWorkspaceConversation } = await import('../api/conversation-visibility');

    prisma.iMConversation.findUnique.mockResolvedValue({
      workspaceId: 'ws-1',
      participants: [],
    });
    prisma.iMWorkspace.findFirst.mockImplementation(async ({ where }: any) =>
      where.OR?.[0]?.ownerImUserId === 'owner-1' ? { id: 'ws-1' } : null,
    );

    await expect(canObserveWorkspaceConversation('conv-1', 'owner-1')).resolves.toBe(true);
  });

  it('resolves workspace owner access for an already-left participant as workspace management', async () => {
    const { resolveConversationViewerAccess } = await import('../api/conversation-visibility');

    prisma.iMConversation.findUnique.mockResolvedValue({
      workspaceId: 'ws-1',
      participants: [{ role: 'member', leftAt: new Date('2026-05-01T00:00:00Z') }],
    });
    prisma.iMWorkspace.findFirst.mockImplementation(async ({ where }: any) =>
      where.OR?.[0]?.ownerImUserId === 'owner-1' ? { id: 'ws-1' } : null,
    );

    await expect(resolveConversationViewerAccess('conv-1', 'owner-1')).resolves.toMatchObject({
      source: 'workspace',
      role: 'observer',
      canObserve: true,
      canDelete: true,
      canLeave: false,
      canSendMessage: false,
    });
  });

  it('keeps active participants writable but workspace observers read-only', async () => {
    const { buildConversationViewerAccess } = await import('../api/conversation-visibility');

    expect(
      buildConversationViewerAccess({
        participant: { role: 'member', leftAt: null },
      }),
    ).toMatchObject({
      source: 'participant',
      role: 'member',
      canObserve: true,
      canLeave: true,
      canSendMessage: true,
      canDelete: false,
    });

    expect(
      buildConversationViewerAccess({
        participant: null,
        workspaceCanObserve: true,
        workspaceCanManage: false,
      }),
    ).toMatchObject({
      source: 'workspace',
      role: 'observer',
      canObserve: true,
      canSendMessage: false,
      canDelete: false,
    });
  });

  it('lists all workspace conversations for workspace observers, including human participants', async () => {
    const { createConversationsRouter } = await import('../api/conversations');
    const { Hono } = await import('hono');

    prisma.iMWorkspace.findFirst.mockResolvedValue({ id: 'ws-1' });
    prisma.iMConversation.findMany.mockResolvedValue([
      {
        id: 'conv-human',
        type: 'group',
        title: 'Human Group',
        description: null,
        workspaceId: 'ws-1',
        status: 'active',
        createdById: 'human-2',
        lastMessageAt: new Date('2026-05-01T00:00:00Z'),
        updatedAt: new Date('2026-05-01T00:00:00Z'),
        participants: [
          {
            imUserId: 'human-2',
            role: 'owner',
            leftAt: null,
            imUser: {
              id: 'human-2',
              username: 'human2',
              displayName: 'Human Two',
              role: 'human',
              agentType: null,
            },
          },
        ],
      },
    ]);

    const service = {
      listByUser: vi.fn().mockResolvedValue([]),
    };
    const app = new Hono();
    // eslint-disable-next-line custom/no-wildcard-sub-router-middleware -- test-only Hono app used to isolate conversation-visibility middleware; not mounted in production routes
    app.use('*', async (c, next) => {
      c.set('user', { imUserId: 'owner-1' });
      await next();
    });
    app.route('/conversations', createConversationsRouter(service as any));

    const res = await app.request('/conversations?workspaceId=ws-1');
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      id: 'conv-human',
      myRole: 'observer',
      viewerAccess: {
        source: 'workspace',
        canObserve: true,
        canDelete: true,
        canSendMessage: false,
      },
    });
  });

  it('archives instead of leaving when workspace owner deletes a conversation they participate in', async () => {
    const { createConversationsRouter } = await import('../api/conversations');
    const { Hono } = await import('hono');

    prisma.iMParticipant.findUnique.mockResolvedValue({
      role: 'owner',
      leftAt: null,
      pinned: false,
      muted: false,
      pinnedAt: null,
    });
    prisma.iMConversation.findUnique.mockResolvedValue({
      workspaceId: 'ws-1',
      participants: [{ role: 'owner', leftAt: null }],
    });
    prisma.iMWorkspace.findFirst.mockImplementation(async ({ where }: any) =>
      where.OR?.[0]?.ownerImUserId === 'owner-1' ? { id: 'ws-1' } : null,
    );

    const service = {
      archive: vi.fn().mockResolvedValue({ id: 'conv-1', status: 'archived' }),
    };
    const app = new Hono();
    // eslint-disable-next-line custom/no-wildcard-sub-router-middleware -- test-only Hono app used to isolate conversation-visibility middleware; not mounted in production routes
    app.use('*', async (c, next) => {
      c.set('user', { imUserId: 'owner-1' });
      await next();
    });
    app.route('/conversations', createConversationsRouter(service as any));

    const res = await app.request('/conversations/conv-1', { method: 'DELETE' });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(service.archive).toHaveBeenCalledWith('conv-1');
  });
});
