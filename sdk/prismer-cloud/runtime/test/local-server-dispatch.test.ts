import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { LocalServer, type LocalServerState } from '../src/daemon/local-server.js';
import type { AgentDispatchRequest } from '../src/wire/dispatch-types.js';

let server: LocalServer | undefined;
let baseUrl = '';
const TEST_DISPATCH_SECRET = 'test-dispatch-secret';

const baseState: LocalServerState = {
  daemonId: 'dev_test',
  daemonVersion: '0.0.0-test',
  cloudBaseUrl: 'http://cloud.test',
  workspaceId: null,
  pid: 99999,
  startedAt: Date.now(),
  wsConnected: false,
  hostedAgents: [],
  runningTaskIds: [],
};

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

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function startServer(opts: Partial<ConstructorParameters<typeof LocalServer>[0]> = {}): Promise<void> {
  const port = 40100 + Math.floor(Math.random() * 1000);
  server = new LocalServer({
    port,
    getState: () => baseState,
    messageDispatchSecret: TEST_DISPATCH_SECRET,
    ...opts,
  });
  await server.start();
  baseUrl = `http://127.0.0.1:${port}`;
}

async function postJson(
  path: string,
  body: unknown,
  opts: { signed?: boolean } = {},
): Promise<{ status: number; body: unknown }> {
  const rawBody = JSON.stringify(body);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.signed !== false) {
    Object.assign(headers, dispatchHeaders(rawBody));
  }
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: rawBody,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function dispatchHeaders(rawBody: string): Record<string, string> {
  const timestamp = String(Date.now());
  const signature = createHmac('sha256', TEST_DISPATCH_SECRET).update(`${timestamp}.${rawBody}`).digest('hex');
  return {
    'X-Prismer-Dispatch-Timestamp': timestamp,
    'X-Prismer-Dispatch-Signature': `v1=${signature}`,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('POST /dispatch', () => {
  it('rejects unsigned dispatch requests', async () => {
    await startServer();

    const result = await postJson('/dispatch', baseRequest, { signed: false });

    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({
      ok: false,
      error: { code: 'dispatch_auth_failed' },
    });
  });

  it('returns 501 when no message dispatch handler is configured', async () => {
    await startServer();

    const result = await postJson('/dispatch', baseRequest);

    expect(result.status).toBe(501);
    expect(result.body).toMatchObject({
      ok: false,
      error: { code: 'message_dispatch_unavailable' },
    });
  });

  it('returns AgentDispatchResponse synchronously and posts reply asynchronously', async () => {
    const dispatchDone = deferred<{ ok: true; output: string }>();
    const postReply = vi.fn();
    const agent = {
      agentImUserId: 'agent_1',
      dispatch: vi.fn(() => dispatchDone.promise),
    };
    await startServer({
      messageDispatchDeps: {
        findAgent: () => agent,
        postReply,
        now: () => new Date('2026-05-18T00:00:00.000Z'),
      },
    });

    const result = await postJson('/dispatch', baseRequest);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true, acceptedAt: '2026-05-18T00:00:00.000Z' });
    expect(agent.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'external:msg_1',
        prompt: 'hello agent',
      }),
    );
    expect(postReply).not.toHaveBeenCalled();

    dispatchDone.resolve({ ok: true, output: 'hello external user' });
    await vi.waitFor(() => expect(postReply).toHaveBeenCalledTimes(1));
    expect(postReply).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToken: 'reply_1',
        conversationId: 'conv_1',
        replyToMessageId: 'msg_1',
        agentImUserId: 'agent_1',
        status: 'ok',
        replyText: 'hello external user',
      }),
    );
  });

  it('returns 400 for an invalid body', async () => {
    await startServer({
      messageDispatchDeps: {
        findAgent: () => null,
        postReply: vi.fn(),
      },
    });

    const result = await postJson('/dispatch', { ...baseRequest, replyToken: undefined });

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({
      ok: false,
      error: { code: 'invalid_body' },
    });
  });
});
