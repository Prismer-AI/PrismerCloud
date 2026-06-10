import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  iMUser: {
    findMany: vi.fn(),
  },
  iMAgentProfile: {
    findFirst: vi.fn(),
  },
  iMParticipant: {
    findMany: vi.fn(),
  },
}));

vi.mock('../db', () => ({ default: prisma }));

function resetMocks() {
  vi.clearAllMocks();
  prisma.iMUser.findMany.mockResolvedValue([]);
  prisma.iMAgentProfile.findFirst.mockResolvedValue(null);
  prisma.iMParticipant.findMany.mockResolvedValue([]);
}

describe('MessageService asset attachments', () => {
  beforeEach(resetMocks);

  it('dispatches only the primary mentioned agent once and carries pending targets', async () => {
    const { MessageService } = await import('../services/message.service');
    const service = new MessageService({ publish: vi.fn() } as never);
    service.setTaskService({} as never);

    const dispatchToAgent = vi.fn().mockResolvedValue(undefined);
    (service as unknown as { dispatchToAgent: typeof dispatchToAgent }).dispatchToAgent = dispatchToAgent;

    await (
      service as unknown as {
        dispatchToMentionedAgents: (
          triggerMessage: unknown,
          routing: unknown,
          hopCount: number,
          conversationType: 'direct' | 'group',
        ) => Promise<void>;
      }
    ).dispatchToMentionedAgents(
      {
        id: 'msg_1',
        conversationId: 'conv_1',
        senderId: 'human_1',
        content: '@alpha @beta read the file',
      },
      {
        targets: [
          { userId: 'agent_alpha', username: 'alpha', role: 'agent' },
          { userId: 'agent_beta', username: 'beta', role: 'agent' },
        ],
      },
      1,
      'group',
    );

    expect(dispatchToAgent).toHaveBeenCalledTimes(1);
    expect(dispatchToAgent).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'agent_alpha' }),
      expect.objectContaining({ id: 'msg_1' }),
      1,
      'group',
      ['agent_beta'],
    );
  });

  it('hydrates root message.attachments into task run asset metadata for daemon reads', async () => {
    const { MessageService } = await import('../services/message.service');
    const service = new MessageService({ publish: vi.fn() } as never);
    const createTaskRun = vi.fn().mockResolvedValue({ id: 'run_1' });
    const dispatchTaskRun = vi.fn().mockResolvedValue(undefined);
    service.setTaskService({ createTaskRun, dispatchTaskRun } as never);

    const createdAt = new Date('2026-05-18T00:00:00.000Z');
    (service as unknown as { messageModel: { list: typeof vi.fn } }).messageModel = {
      list: vi.fn().mockResolvedValue([
        {
          id: 'msg_root',
          conversationId: 'conv_1',
          senderId: 'human_1',
          type: 'markdown',
          content: 'attached as a first-class field',
          metadata: '{}',
          attachments: [{ kind: 'file', assetId: 'asset_root' }],
          createdAt,
        },
        {
          id: 'msg_legacy',
          conversationId: 'conv_1',
          senderId: 'human_1',
          type: 'markdown',
          content: 'legacy attachment metadata',
          metadata: JSON.stringify({
            kind: 'workspace_asset_attachment',
            assetIds: ['asset_legacy'],
            asset: { id: 'asset_legacy' },
          }),
          attachments: null,
          createdAt,
        },
      ]),
    };

    prisma.iMUser.findMany.mockResolvedValue([{ id: 'human_1', username: 'human', role: 'human' }]);
    prisma.iMAgentProfile.findFirst.mockResolvedValue({ id: 'profile_1', workspaceId: 'ws_1' });
    prisma.iMParticipant.findMany.mockResolvedValue([
      {
        imUserId: 'human_1',
        imUser: { username: 'human', displayName: 'Human', role: 'human', agentType: null },
      },
      {
        imUserId: 'agent_1',
        imUser: { username: 'agent', displayName: 'Agent', role: 'agent', agentType: 'assistant' },
      },
    ]);

    await (
      service as unknown as {
        dispatchToAgent: (
          agent: unknown,
          triggerMessage: unknown,
          hopCount: number,
          conversationType: 'direct' | 'group',
        ) => Promise<void>;
      }
    ).dispatchToAgent(
      { userId: 'agent_1', username: 'agent', role: 'agent' },
      {
        id: 'msg_trigger',
        conversationId: 'conv_1',
        senderId: 'human_1',
        content: '@agent read the attached file',
      },
      1,
      'group',
    );

    expect(createTaskRun).toHaveBeenCalledTimes(1);
    const taskInput = createTaskRun.mock.calls[0][2];
    expect(taskInput.metadata.assets.aggregatedAssetIds).toEqual(['asset_root', 'asset_legacy']);
    expect(taskInput.metadata.context).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attachedAssetIds: ['asset_root'] }),
        expect.objectContaining({ attachedAssetIds: ['asset_legacy'] }),
      ]),
    );
    expect(dispatchTaskRun).toHaveBeenCalledWith('run_1', 'agent_1', 'task.assigned');
  });
});
