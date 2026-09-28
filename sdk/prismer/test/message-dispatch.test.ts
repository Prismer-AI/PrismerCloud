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

const PKF_START = '<!-- prismer-pkf:inline:start -->';
const PKF_END = '<!-- prismer-pkf:inline:end -->';
const VALID_PKF = `<script type="application/prismer+json">{"type":"note","title":"Dispatch note","description":"d","pkfVersion":"1.1"}</script><h2 id="a">A</h2><p>inline fixture</p>`;

function inlinePkfOutput(source = VALID_PKF): string {
  return `Short Markdown projection.\n\n${PKF_START}\n${source}\n${PKF_END}`;
}

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

  it('extracts exactly one structure-valid inline PKF block and keeps the Markdown projection', async () => {
    const output = `${inlinePkfOutput()}\n\nReadable by stale clients.`;
    const handle = handleAgentMessageDispatch(baseRequest, {
      findAgent: () => ({
        agentImUserId: 'agent_1',
        dispatch: vi.fn().mockResolvedValue({ ok: true, output }),
      }),
      postReply: vi.fn(),
      now: () => new Date('2026-05-18T00:00:00.000Z'),
    });

    await expect(handle.done).resolves.toMatchObject({
      status: 'ok',
      replyText: 'Short Markdown projection.\n\nReadable by stale clients.',
      contentBlocks: [{ kind: 'pkf', source: VALID_PKF, title: 'Dispatch note' }],
    });
  });

  it.each([
    ['plain Markdown', inlinePkfOutput('# Not a complete PKF document')],
    [
      'v1.0 metadata',
      inlinePkfOutput(
        `<script type="application/prismer+json">{"type":"note","title":"Legacy","description":"d"}</script><h2 id="a">A</h2><p>legacy fixture</p>`,
      ),
    ],
    [
      'invalid',
      inlinePkfOutput(
        `<script type="application/prismer+json">{"type":"note","title":"bad","description":"d","pkfVersion":"1.1"}</script><p><img src="prismer://asset/abc"></p>`,
      ),
    ],
    ['multiple', `${inlinePkfOutput()}\n${inlinePkfOutput()}`],
    ['oversize', inlinePkfOutput(`${VALID_PKF}<p>${'x'.repeat(40_000)}</p>`)],
  ])('falls back to the complete plain-text output for %s inline PKF', async (_case, output) => {
    const handle = handleAgentMessageDispatch(baseRequest, {
      findAgent: () => ({
        agentImUserId: 'agent_1',
        dispatch: vi.fn().mockResolvedValue({ ok: true, output }),
      }),
      postReply: vi.fn(),
      now: () => new Date('2026-05-18T00:00:00.000Z'),
    });

    await expect(handle.done).resolves.toMatchObject({
      status: 'ok',
      replyText: output,
    });
    expect((await handle.done).contentBlocks).toBeUndefined();
  });
});

// product210/03 W1-3 — chat-line inline-PKF marker extraction. The task-line
// terminal state (dispatch.ts) resolves BOTH inline carriers (sentinel +
// pkf_reply_inline marker) into validated contentBlocks and strips the
// sentinel bytes from the output text; the daemon bridge hands the chat line
// the resulting TaskResult. The chat line must attach those validated blocks
// to the posted reply with the SAME semantics as the task line: sentinel
// authoritative when both fired, fail-closed on any invalid carried source.
describe('chat-line inline-PKF marker extraction (product210/03 W1-3)', () => {
  const MARKER_PKF = `<script type="application/prismer+json">{"type":"note","title":"Marker memo","description":"d","pkfVersion":"1.1"}</script><h2 id="a">A</h2><p>marker fixture</p>`;
  const SENTINEL_PKF = VALID_PKF.replace('Dispatch note', 'Sentinel carrier');

  it('emits contentBlocks from the pkf_reply_inline marker carrier when the reply text carries no sentinel', async () => {
    const handle = handleAgentMessageDispatch(baseRequest, {
      findAgent: () => ({
        agentImUserId: 'agent_1',
        dispatch: vi.fn().mockResolvedValue({
          ok: true,
          output: 'Done — memo delivered inline.',
          metadata: { inlineContentBlocks: [{ kind: 'pkf', source: MARKER_PKF, title: 'Marker memo' }] },
        }),
      }),
      postReply: vi.fn(),
      now: () => new Date('2026-05-18T00:00:00.000Z'),
    });

    await expect(handle.done).resolves.toMatchObject({
      status: 'ok',
      replyText: 'Done — memo delivered inline.',
      contentBlocks: [{ kind: 'pkf', source: MARKER_PKF, title: 'Marker memo' }],
    });
  });

  it('keeps the sentinel carrier authoritative when both the sentinel and the marker carrier fired', async () => {
    const output = `Readable projection.\n\n${PKF_START}\n${SENTINEL_PKF}\n${PKF_END}`;
    const handle = handleAgentMessageDispatch(baseRequest, {
      findAgent: () => ({
        agentImUserId: 'agent_1',
        dispatch: vi.fn().mockResolvedValue({
          ok: true,
          output,
          metadata: { inlineContentBlocks: [{ kind: 'pkf', source: MARKER_PKF, title: 'Marker memo' }] },
        }),
      }),
      postReply: vi.fn(),
      now: () => new Date('2026-05-18T00:00:00.000Z'),
    });

    await expect(handle.done).resolves.toMatchObject({
      status: 'ok',
      replyText: 'Readable projection.',
      contentBlocks: [{ kind: 'pkf', source: SENTINEL_PKF, title: 'Sentinel carrier' }],
    });
  });

  it('fail-closed: an invalid carried source emits NO contentBlock and the plain reply survives', async () => {
    const invalidPkf = `<script type="application/prismer+json">{"type":"note","title":"bad","description":"d","pkfVersion":"1.1"}</script><p><img src="prismer://asset/abc"></p>`;
    const handle = handleAgentMessageDispatch(baseRequest, {
      findAgent: () => ({
        agentImUserId: 'agent_1',
        dispatch: vi.fn().mockResolvedValue({
          ok: true,
          output: 'Delivered inline.',
          metadata: { inlineContentBlocks: [{ kind: 'pkf', source: invalidPkf, title: 'bad' }] },
        }),
      }),
      postReply: vi.fn(),
      now: () => new Date('2026-05-18T00:00:00.000Z'),
    });

    await expect(handle.done).resolves.toMatchObject({
      status: 'ok',
      replyText: 'Delivered inline.',
    });
    expect((await handle.done).contentBlocks).toBeUndefined();
  });

  it('negative control: no marker carrier in the dispatch result → no contentBlocks', async () => {
    const handle = handleAgentMessageDispatch(baseRequest, {
      findAgent: () => ({
        agentImUserId: 'agent_1',
        dispatch: vi.fn().mockResolvedValue({ ok: true, output: 'plain markdown reply' }),
      }),
      postReply: vi.fn(),
      now: () => new Date('2026-05-18T00:00:00.000Z'),
    });

    const reply = await handle.done;
    expect(reply.replyText).toBe('plain markdown reply');
    expect(reply.contentBlocks).toBeUndefined();
  });
});
