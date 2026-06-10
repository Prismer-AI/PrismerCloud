import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  iMConversation: {
    findFirst: vi.fn(),
    update: vi.fn(),
  },
  iMConversationSecurity: {
    create: vi.fn(),
  },
}));

const conversationModel = vi.hoisted(() => ({
  create: vi.fn(async (input: { type: string; workspaceId?: string }) => ({
    id: 'conv-created',
    type: input.type,
    status: 'active',
    workspaceId: input.workspaceId,
  })),
}));
const participantModel = vi.hoisted(() => ({
  add: vi.fn(),
  listByConversation: vi.fn(async () => []),
}));

vi.mock('../db', () => ({ default: prisma }));
vi.mock('../models/conversation', () => ({ ConversationModel: vi.fn(() => conversationModel) }));
vi.mock('../models/participant', () => ({ ParticipantModel: vi.fn(() => participantModel) }));

function resetMocks() {
  prisma.iMConversation.findFirst.mockReset();
  prisma.iMConversation.update.mockReset();
  prisma.iMConversationSecurity.create.mockReset().mockResolvedValue({});
  conversationModel.create.mockClear();
  participantModel.add.mockClear();
  participantModel.listByConversation.mockClear();
}

describe('ACP conversation service workspace direct sessions', () => {
  beforeEach(resetMocks);

  it('creates a workspace-scoped direct instead of reusing another workspace direct', async () => {
    const { ConversationService } = await import('../services/conversation.service');
    prisma.iMConversation.findFirst.mockResolvedValue(null);

    const service = new ConversationService({} as never);
    const conv = await service.createDirect({
      createdBy: 'human-1',
      otherUserId: 'agent-1',
      workspaceId: 'ws-current',
    });

    expect(prisma.iMConversation.findFirst).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({ workspaceId: 'ws-current' }),
      }),
    );
    expect(prisma.iMConversation.findFirst).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({ workspaceId: null }),
      }),
    );
    expect(conversationModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'direct', workspaceId: 'ws-current' }),
    );
    expect(conv.workspaceId).toBe('ws-current');
  });

  it('claims a legacy null-workspace direct for the requested workspace', async () => {
    const { ConversationService } = await import('../services/conversation.service');
    prisma.iMConversation.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'conv-legacy', status: 'archived', workspaceId: null });
    prisma.iMConversation.update.mockResolvedValue({ id: 'conv-legacy', status: 'active', workspaceId: 'ws-current' });

    const service = new ConversationService({} as never);
    const conv = await service.createDirect({
      createdBy: 'human-1',
      otherUserId: 'agent-1',
      workspaceId: 'ws-current',
    });

    expect(prisma.iMConversation.update).toHaveBeenCalledWith({
      where: { id: 'conv-legacy' },
      data: { workspaceId: 'ws-current', status: 'active' },
    });
    expect(conversationModel.create).not.toHaveBeenCalled();
    expect(conv).toEqual({ id: 'conv-legacy', status: 'active', workspaceId: 'ws-current' });
  });
});
