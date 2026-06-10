/**
 * v2.0 AgentDispatcher unit tests.
 *
 * Usage: npx tsx src/im/tests/agent-dispatcher.test.ts
 */

import type { PrismaClient } from '@prisma/client';
import * as crypto from 'node:crypto';
import { Hono } from 'hono';
import { createDispatchRouter } from '../api/dispatch';
import {
  AgentDispatcher,
  createAgentDispatchReplyToken,
  parseAgentMentions,
  persistAgentDispatchReply,
  validateAgentDispatchReplyPayload,
  type DispatchReplyPersistDeps,
} from '../services/agent-dispatcher';

process.env.DISPATCH_DAEMON_SECRET ??= 'test-dispatch-secret';

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ok ${name}`);
  } catch (err) {
    failed++;
    failures.push(`${name}: ${(err as Error).message}`);
    console.log(`  fail ${name}: ${(err as Error).message}`);
  }
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function assertEq<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function dispatchReplyIdemForTest(raw: string): string {
  return `dispatch_reply_${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 48)}`;
}

function makeReplyDeps() {
  const sends: unknown[] = [];
  const pushed: Array<{ userId: string; event: unknown }> = [];
  const deps: DispatchReplyPersistDeps = {
    messageService: {
      send: async (input: any) => {
        sends.push(input);
        return {
          message: {
            id: `im-msg-${sends.length}`,
            conversationId: input.conversationId,
            senderId: input.senderId,
            type: input.type ?? 'text',
            content: input.content,
            metadata: JSON.stringify(input.metadata ?? {}),
            attachments: input.attachments ?? null,
            parentId: null,
            createdAt: new Date('2026-05-18T00:00:01.000Z'),
          },
        } as any;
      },
    },
    getParticipantIds: async (conversationId) => {
      assertEq(conversationId, 'conv-1', 'participant conversation');
      return ['human-1', 'agent-1'];
    },
    rooms: {
      sendToUser: (userId: string, event: unknown) => {
        pushed.push({ userId, event });
      },
    },
  };
  return { deps, sends, pushed };
}

function replyToken(replyToMessageId: string, agentImUserId = 'agent-1'): string {
  return createAgentDispatchReplyToken({
    channelAccountId: 'ch-1',
    conversationId: 'conv-1',
    messageId: replyToMessageId,
    agentImUserId,
    ttlMs: 60_000,
    nowMs: Date.now(),
  });
}

async function main() {
  console.log('\nagent dispatcher tests');

  await test('parseAgentMentions is conservative and dedupes', () => {
    assertEq(parseAgentMentions('hello @agent_1 and @Agent-2, repeat @agent_1'), ['agent_1', 'Agent-2'], 'mentions');
    assertEq(parseAgentMentions('email a@b.com should not match'), [], 'email is not a mention');
  });

  await test('dispatchExternalMention builds daemon /dispatch payload from external routing', async () => {
    let routingWhere: unknown;
    let participantWhere: unknown;
    let daemonUrl = '';
    let daemonPayload: unknown;
    let daemonHeaders: Record<string, string> = {};

    const prisma = {
      iMExternalRouting: {
        findFirst: async (args: unknown) => {
          routingWhere = args;
          return {
            id: 'route-1',
            conversationId: 'im-conv-1',
            externalIdentityId: 'ext-ident-1',
          };
        },
      },
      iMParticipant: {
        findFirst: async (args: unknown) => {
          participantWhere = args;
          return { imUser: { id: 'agent-im-1', username: 'alice' } };
        },
      },
      iMContainer: {
        findFirst: async () => ({
          daemonId: 'daemon-1',
          // v2.0 §4.8.1 (Wave 4-E4) — agent-dispatcher now skips HTTP
          // fallback for private hosts (`daemon.local`/RFC1918) and goes
          // WS-first. This test still exercises the HTTP fallback path,
          // so the fixture must be a publicly-dialable URL.
          gatewayUrl: 'https://daemon.example.com',
        }),
      },
    } as unknown as PrismaClient;

    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      daemonUrl = String(url);
      daemonPayload = JSON.parse(String(init?.body));
      daemonHeaders = init?.headers as Record<string, string>;
      return {
        ok: true,
        json: async () => ({ ok: true, acceptedAt: '2026-05-18T00:00:00.000Z' }),
      } as Response;
    }) as typeof fetch;

    const dispatcher = new AgentDispatcher(prisma, { fetch: fetchImpl, defaultReplyDeadlineMs: 12_000 });
    const result = await dispatcher.dispatchExternalMention({
      channelAccountId: 'ch-1',
      externalUserId: 'wx-user-1',
      messageId: 'external-msg-1',
      messageText: '@alice please summarize',
      attachments: [{ type: 'text', text: 'context' }],
    });

    assert(result.dispatched, 'dispatch should be accepted');
    assertEq(daemonUrl, 'https://daemon.example.com/dispatch', 'daemon URL');
    assertEq(
      routingWhere,
      {
        where: {
          externalIdentity: {
            channelAccountId: 'ch-1',
            externalUserId: 'wx-user-1',
          },
        },
        include: { externalIdentity: true },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      },
      'routing lookup',
    );
    assertEq(
      participantWhere,
      {
        where: {
          conversationId: 'im-conv-1',
          leftAt: null,
          imUser: {
            role: 'agent',
            OR: [{ username: 'alice' }, { displayName: 'alice' }],
          },
        },
        select: { imUser: { select: { id: true, username: true } } },
      },
      'participant-scoped agent lookup',
    );
    assert(typeof daemonHeaders['X-Prismer-Dispatch-Timestamp'] === 'string', 'daemon dispatch timestamp header');
    assert(typeof daemonHeaders['X-Prismer-Dispatch-Signature'] === 'string', 'daemon dispatch signature header');
    assertEq(
      daemonPayload,
      {
        channelAccountId: 'ch-1',
        externalUserId: 'wx-user-1',
        conversationId: 'im-conv-1',
        mentionedAgentImUserId: 'agent-im-1',
        messageText: '@alice please summarize',
        messageId: 'external-msg-1',
        attachments: [{ type: 'text', text: 'context' }],
        replyToken: (daemonPayload as any).replyToken,
        replyDeadlineMs: 12_000,
      },
      'daemon payload',
    );
    validateAgentDispatchReplyPayload({
      replyToken: (daemonPayload as any).replyToken,
      conversationId: 'im-conv-1',
      replyToMessageId: 'external-msg-1',
      agentImUserId: 'agent-im-1',
      status: 'ok',
      replyText: 'ok',
      completedAt: new Date().toISOString(),
    });
  });

  await test('dispatchExternalMention refuses mentions outside the routed conversation', async () => {
    let fetched = false;
    const prisma = {
      iMExternalRouting: {
        findFirst: async () => ({
          id: 'route-1',
          conversationId: 'im-conv-1',
          externalIdentityId: 'ext-ident-1',
        }),
      },
      iMParticipant: {
        findFirst: async () => null,
      },
    } as unknown as PrismaClient;

    const dispatcher = new AgentDispatcher(prisma, {
      fetch: (async () => {
        fetched = true;
        throw new Error('fetch should not be called');
      }) as typeof fetch,
    });

    const result = await dispatcher.dispatchExternalMention({
      channelAccountId: 'ch-1',
      externalUserId: 'wx-user-1',
      messageId: 'external-msg-1',
      messageText: '@alice please summarize',
    });

    assertEq(
      result,
      { dispatched: false, reason: 'agent_not_found', mentions: ['alice'] },
      'outside conversation result',
    );
    assert(!fetched, 'daemon fetch should not be called');
  });

  await test('dispatchExternalMention skips without mention', async () => {
    const dispatcher = new AgentDispatcher({} as PrismaClient, {
      fetch: (async () => {
        throw new Error('fetch should not be called');
      }) as typeof fetch,
    });

    const result = await dispatcher.dispatchExternalMention({
      channelAccountId: 'ch-1',
      externalUserId: 'u-1',
      messageId: 'm-1',
      messageText: 'plain hello',
    });

    assertEq(result, { dispatched: false, reason: 'no_mention', mentions: [] }, 'skip result');
  });

  await test('validateAgentDispatchReplyPayload rejects malformed replies', () => {
    try {
      validateAgentDispatchReplyPayload({
        replyToken: replyToken('origin-1'),
        conversationId: 'conv-1',
        replyToMessageId: 'origin-1',
        agentImUserId: 'agent-1',
        status: 'ok',
        completedAt: '2026-05-18T00:00:00.000Z',
      });
      throw new Error('expected validation to fail');
    } catch (err) {
      assert((err as Error).message.includes('replyText or attachments'), 'ok reply requires observable content');
    }

    try {
      validateAgentDispatchReplyPayload({
        replyToken: replyToken('origin-1'),
        conversationId: 'conv-1',
        replyToMessageId: 'origin-1',
        agentImUserId: 'agent-1',
        status: 'agent_error',
        completedAt: '2026-05-18T00:00:00.000Z',
      });
      throw new Error('expected validation to fail');
    } catch (err) {
      assert((err as Error).message.includes('error.code'), 'fallback reply requires structured error');
    }
  });

  await test('persistAgentDispatchReply writes ok agent reply and broadcasts message.new', async () => {
    const { deps, sends, pushed } = makeReplyDeps();
    const token = replyToken('origin-1');
    const result = await persistAgentDispatchReply(
      validateAgentDispatchReplyPayload({
        replyToken: token,
        conversationId: 'conv-1',
        replyToMessageId: 'origin-1',
        agentImUserId: 'agent-1',
        status: 'ok',
        replyText: 'done',
        attachments: [{ kind: 'file', assetId: 'asset-1' }],
        completedAt: '2026-05-18T00:00:00.000Z',
      }),
      deps,
    );

    assertEq(result.message.id, 'im-msg-1', 'message id');
    assertEq(
      sends[0],
      {
        conversationId: 'conv-1',
        senderId: 'agent-1',
        type: 'text',
        content: 'done',
        metadata: {
          _idempotencyKey: dispatchReplyIdemForTest('dispatch_reply:conv-1:origin-1:agent-1'),
          dispatchReplyKey: 'dispatch_reply:conv-1:origin-1:agent-1',
          kind: 'agent_reply',
          source: 'dispatch_reply',
          triggerMessageId: 'origin-1',
          replyToMessageId: 'origin-1',
          agentImUserId: 'agent-1',
          dispatchStatus: 'ok',
          completedAt: '2026-05-18T00:00:00.000Z',
          attachments: [{ kind: 'file', assetId: 'asset-1', role: 'output' }],
        },
        attachments: [{ kind: 'file', assetId: 'asset-1', role: 'output' }],
      },
      'message send input',
    );
    assertEq(
      pushed.map((p) => p.userId),
      ['human-1', 'agent-1'],
      'broadcast recipients',
    );
    assertEq((pushed[0]?.event as any).type, 'message.new', 'broadcast type');
    assert(
      !('replyToken' in ((pushed[0]?.event as any).payload.metadata ?? {})),
      'broadcast metadata must not leak replyToken',
    );
  });

  await test('persistAgentDispatchReply writes non-ok fallback as system_event', async () => {
    const { deps, sends } = makeReplyDeps();
    await persistAgentDispatchReply(
      validateAgentDispatchReplyPayload({
        replyToken: replyToken('origin-2'),
        conversationId: 'conv-1',
        replyToMessageId: 'origin-2',
        agentImUserId: 'agent-1',
        status: 'timeout',
        completedAt: '2026-05-18T00:00:00.000Z',
        error: { code: 'timeout', message: 'agent timed out' },
      }),
      deps,
    );

    assertEq((sends[0] as any).type, 'system_event', 'fallback message type');
    assertEq((sends[0] as any).content, 'Agent dispatch timeout: agent timed out', 'fallback content');
    assertEq((sends[0] as any).metadata.errorCode, 'timeout', 'fallback error code');
  });

  await test('createDispatchRouter validates and persists daemon reply', async () => {
    const { deps, sends } = makeReplyDeps();
    const app = new Hono().route('/dispatch', createDispatchRouter(deps));

    const invalid = await app.request('/dispatch/reply', {
      method: 'POST',
      body: JSON.stringify({ replyToken: 'reply-1' }),
      headers: { 'Content-Type': 'application/json' },
    });
    assertEq(invalid.status, 400, 'invalid status');

    const res = await app.request('/dispatch/reply', {
      method: 'POST',
      body: JSON.stringify({
        replyToken: replyToken('origin-3'),
        conversationId: 'conv-1',
        replyToMessageId: 'origin-3',
        agentImUserId: 'agent-1',
        status: 'ok',
        replyText: 'route ok',
        completedAt: '2026-05-18T00:00:00.000Z',
      }),
      headers: { 'Content-Type': 'application/json' },
    });
    const json = await res.json();
    assertEq(res.status, 200, 'route status');
    assertEq(json.ok, true, 'route response ok');
    assertEq(json.data.messageId, 'im-msg-1', 'route response message id');
    assertEq(json.data.conversationId, 'conv-1', 'route response conversation');
    assertEq(json.data.status, 'ok', 'route response status');
    assertEq(json.data._deprecated, true, 'route response deprecation marker');
    assertEq((sends[0] as any).content, 'route ok', 'route persisted content');
  });

  if (failed > 0) {
    console.error(`\n${failed} failed`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log(`\n${passed} passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
