import { describe, expect, it, vi } from 'vitest';
import { handleAgentMessageDispatch } from '../src/daemon/message-dispatch.js';
import type { AgentDispatchRequest } from '../src/wire/dispatch-types.js';

const baseRequest: AgentDispatchRequest = {
  channelAccountId: 'ca_1',
  externalUserId: 'ext_1',
  conversationId: 'conv_1',
  mentionedAgentImUserId: 'agent_1',
  messageText: 'hello agent',
  messageId: 'msg_1',
  replyToken: 'reply_1',
  replyDeadlineMs: 1000,
};

describe('handleAgentMessageDispatch', () => {
  it('acks synchronously and posts ok reply asynchronously', async () => {
    const postReply = vi.fn();
    const agent = {
      agentImUserId: 'agent_1',
      dispatch: vi.fn().mockResolvedValue({
        ok: true,
        output: 'hello external user',
        metadata: { assetIds: ['asset_1'] },
      }),
    };

    const handle = handleAgentMessageDispatch(baseRequest, {
      findAgent: () => agent,
      postReply,
      now: () => new Date('2026-05-18T00:00:00.000Z'),
    });

    expect(handle.response).toEqual({ ok: true, acceptedAt: '2026-05-18T00:00:00.000Z' });
    const reply = await handle.done;
    expect(agent.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'external:msg_1',
        prompt: 'hello agent',
        metadata: expect.objectContaining({ source: 'external-channel', messageId: 'msg_1' }),
      }),
    );
    expect(reply).toMatchObject({
      replyToken: 'reply_1',
      replyToMessageId: 'msg_1',
      agentImUserId: 'agent_1',
      status: 'ok',
      replyText: 'hello external user',
      attachments: [{ kind: 'file', assetId: 'asset_1' }],
    });
    expect(postReply).toHaveBeenCalledWith(reply);
  });

  it('posts agent_offline fallback when the agent is not hosted', async () => {
    const postReply = vi.fn();
    const handle = handleAgentMessageDispatch(baseRequest, {
      findAgent: () => null,
      postReply,
      now: () => new Date('2026-05-18T00:00:00.000Z'),
    });

    expect(handle.response.ok).toBe(true);
    const reply = await handle.done;
    expect(reply.status).toBe('agent_offline');
    expect(reply.error?.code).toBe('agent_offline');
    expect(postReply).toHaveBeenCalledWith(reply);
  });

  it('posts agent_error fallback when dispatch fails', async () => {
    const postReply = vi.fn();
    const handle = handleAgentMessageDispatch(baseRequest, {
      findAgent: () => ({
        agentImUserId: 'agent_1',
        dispatch: vi.fn().mockResolvedValue({ ok: false, error: { code: 'adapter_error', message: 'boom' } }),
      }),
      postReply,
      now: () => new Date('2026-05-18T00:00:00.000Z'),
    });

    const reply = await handle.done;
    expect(reply.status).toBe('agent_error');
    expect(reply.error).toEqual({ code: 'adapter_error', message: 'boom' });
  });
});
