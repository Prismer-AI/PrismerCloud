import { describe, expect, it, vi } from 'vitest';
import { CloudClient } from '../src/auth.js';
import { sendDispatchReplyTwoPhase } from '../src/daemon/dispatch-reply-transport.js';
import type { PendingReplyCache } from '../src/daemon/pending-reply-cache.js';

describe('dispatch reply transport', () => {
  it('preserves inline PKF contentBlocks inside messageContent on prepare and in recovery cache', async () => {
    const bodies: unknown[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(init?.body ? JSON.parse(String(init.body)) : undefined);
      const isPrepare = bodies.length === 1;
      return new Response(
        JSON.stringify(
          isPrepare
            ? { ok: true, data: { replyId: 'reply-1', status: 'prepared', existed: false } }
            : { ok: true, data: { taskId: 'task-1', replyId: 'reply-1', alreadyCommitted: false } },
        ),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    const cache = {
      savePending: vi.fn(),
      markPrepared: vi.fn(),
      markAttempt: vi.fn(),
      clearPending: vi.fn(),
      listForRecovery: vi.fn(() => []),
      countByStatus: vi.fn(() => ({ pending: 0, prepared: 0 })),
      findByIdempotencyKey: vi.fn(() => null),
    } satisfies PendingReplyCache;
    const cloud = new CloudClient({ baseUrl: 'https://cloud.example', apiKey: 'test', fetchImpl });
    const contentBlocks = [{ kind: 'pkf' as const, source: '<valid-pkf />' }];

    await sendDispatchReplyTwoPhase({
      taskId: 'task-1',
      idempotencyKey: 'idem-1',
      cloud,
      cache,
      log: () => undefined,
      payload: {
        conversationId: 'conv-1',
        replyToken: 'token-1',
        replyToMessageId: 'message-1',
        agentImUserId: 'agent-1',
        status: 'ok',
        replyText: 'projection',
        messageContent: { contentBlocks },
        completedAt: '2026-08-17T00:00:00.000Z',
      },
    });

    expect(bodies[0]).toMatchObject({
      messageContent: { contentBlocks },
      idempotencyKey: 'idem-1',
    });
    expect(JSON.parse(cache.savePending.mock.calls[0][2])).toMatchObject({
      messageContent: { contentBlocks },
    });
  });
});
