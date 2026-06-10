/**
 * release201/26 Phase 1 — cloud integration tests (tasks #1–#3).
 *
 * Covers:
 *  • Task #1 — writeQuoteSnapshots: writes QuoteCache + Backref for quoted
 *    messages (column + metadata.quotes[]), idempotent upsert, source-missing
 *    skip, failure never throws.
 *  • Task #2 — dispatchToAgent stamps metadata.contextEnvelope when the flag is
 *    on; flag-off keeps the legacy last-20 metadata.context path with NO
 *    contextEnvelope key (zero regression).
 *  • Task #3 — backfillMessageTokenCounts updates NULL rows in batches.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  iMUser: { findMany: vi.fn() },
  iMAgentProfile: { findFirst: vi.fn() },
  iMParticipant: { findMany: vi.fn() },
  iMMessage: { findMany: vi.fn(), update: vi.fn() },
  iMConversation: { findUnique: vi.fn() },
  iMConversationCompressedSegment: { findMany: vi.fn(), findFirst: vi.fn() },
  iMConversationQuoteCache: { findMany: vi.fn(), upsert: vi.fn() },
  iMConversationQuoteBackref: { upsert: vi.fn() },
  iMConversationIdentifierIndex: { findMany: vi.fn() },
}));

vi.mock('../db', () => ({ default: prisma }));

function resetMocks() {
  vi.clearAllMocks();
  prisma.iMUser.findMany.mockResolvedValue([]);
  prisma.iMAgentProfile.findFirst.mockResolvedValue(null);
  prisma.iMParticipant.findMany.mockResolvedValue([]);
  prisma.iMMessage.findMany.mockResolvedValue([]);
  prisma.iMMessage.update.mockResolvedValue({});
  prisma.iMConversation.findUnique.mockResolvedValue({ id: 'conv_1', type: 'group' });
  prisma.iMConversationCompressedSegment.findMany.mockResolvedValue([]);
  prisma.iMConversationCompressedSegment.findFirst.mockResolvedValue(null);
  prisma.iMConversationIdentifierIndex.findMany.mockResolvedValue([]);
  prisma.iMConversationQuoteCache.findMany.mockResolvedValue([]);
  prisma.iMConversationQuoteCache.upsert.mockResolvedValue({});
  prisma.iMConversationQuoteBackref.upsert.mockResolvedValue({});
  delete process.env.FF_CONTEXT_ENVELOPE_ENABLED;
}

beforeEach(resetMocks);

// ─── Task #1 — quote snapshot write ───────────────────────────────────────────
describe('writeQuoteSnapshots (release201/26 task #1)', () => {
  async function callWrite(msg: Record<string, unknown>) {
    const { MessageService } = await import('../services/message.service');
    const service = new MessageService({ publish: vi.fn() } as never);
    await (
      service as unknown as { writeQuoteSnapshots: (m: unknown) => Promise<void> }
    ).writeQuoteSnapshots(msg);
  }

  it('snapshots a quoted message referenced via the quotedMessageId column', async () => {
    prisma.iMMessage.findMany.mockResolvedValue([
      { id: 'q_1', content: 'earlier point', senderId: 'human_1', createdAt: new Date('2026-05-20T08:00:00Z') },
    ]);
    prisma.iMUser.findMany.mockResolvedValue([{ id: 'human_1', username: 'alice', displayName: 'Alice' }]);

    await callWrite({ id: 'msg_2', conversationId: 'conv_1', quotedMessageId: 'q_1', metadata: '{}' });

    expect(prisma.iMConversationQuoteCache.upsert).toHaveBeenCalledTimes(1);
    const cacheArg = prisma.iMConversationQuoteCache.upsert.mock.calls[0][0];
    expect(cacheArg.where.quotingMessageId_quotedMessageId).toEqual({
      quotingMessageId: 'msg_2',
      quotedMessageId: 'q_1',
    });
    expect(cacheArg.create).toMatchObject({
      quotingMessageId: 'msg_2',
      quotedMessageId: 'q_1',
      snapshotContent: 'earlier point',
      snapshotSender: 'Alice', // display name preferred
      conversationId: 'conv_1',
    });
    expect(cacheArg.update).toEqual({}); // immutable snapshot
    expect(prisma.iMConversationQuoteBackref.upsert).toHaveBeenCalledTimes(1);
  });

  it('reads quote refs from metadata.quotes[] (both msg:<id> and {ref})', async () => {
    prisma.iMMessage.findMany.mockResolvedValue([
      { id: 'q_a', content: 'A', senderId: 'human_1', createdAt: new Date('2026-05-20T08:00:00Z') },
      { id: 'q_b', content: 'B', senderId: 'human_1', createdAt: new Date('2026-05-21T08:00:00Z') },
    ]);
    prisma.iMUser.findMany.mockResolvedValue([{ id: 'human_1', username: 'alice', displayName: null }]);

    await callWrite({
      id: 'msg_3',
      conversationId: 'conv_1',
      quotedMessageId: null,
      metadata: JSON.stringify({ quotes: [{ ref: 'msg:q_a' }, { quotedMessageId: 'q_b' }] }),
    });

    const quotedIds = prisma.iMConversationQuoteCache.upsert.mock.calls.map(
      (c) => c[0].create.quotedMessageId,
    );
    expect(quotedIds.sort()).toEqual(['q_a', 'q_b']);
    // displayName null → falls back to username.
    expect(prisma.iMConversationQuoteCache.upsert.mock.calls[0][0].create.snapshotSender).toBe('alice');
  });

  it('truncates snapshotContent to the 2000-char cap', async () => {
    prisma.iMMessage.findMany.mockResolvedValue([
      { id: 'q_big', content: 'x'.repeat(5000), senderId: 'human_1', createdAt: new Date() },
    ]);
    prisma.iMUser.findMany.mockResolvedValue([{ id: 'human_1', username: 'alice', displayName: 'Alice' }]);
    await callWrite({ id: 'msg_4', conversationId: 'conv_1', quotedMessageId: 'q_big', metadata: '{}' });
    expect(prisma.iMConversationQuoteCache.upsert.mock.calls[0][0].create.snapshotContent).toHaveLength(2000);
  });

  it('skips silently when the quoted source no longer exists (no writes)', async () => {
    prisma.iMMessage.findMany.mockResolvedValue([]); // source gone
    await callWrite({ id: 'msg_5', conversationId: 'conv_1', quotedMessageId: 'gone', metadata: '{}' });
    expect(prisma.iMConversationQuoteCache.upsert).not.toHaveBeenCalled();
    expect(prisma.iMConversationQuoteBackref.upsert).not.toHaveBeenCalled();
  });

  it('does nothing when there are no quote refs', async () => {
    await callWrite({ id: 'msg_6', conversationId: 'conv_1', quotedMessageId: null, metadata: '{}' });
    expect(prisma.iMMessage.findMany).not.toHaveBeenCalled();
    expect(prisma.iMConversationQuoteCache.upsert).not.toHaveBeenCalled();
  });

  it('treats a P2002 duplicate as success (idempotent retry)', async () => {
    prisma.iMMessage.findMany.mockResolvedValue([
      { id: 'q_dup', content: 'dup', senderId: 'human_1', createdAt: new Date() },
    ]);
    prisma.iMUser.findMany.mockResolvedValue([{ id: 'human_1', username: 'alice', displayName: 'Alice' }]);
    prisma.iMConversationQuoteCache.upsert.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'P2002' }));
    // Must not throw.
    await expect(
      callWrite({ id: 'msg_7', conversationId: 'conv_1', quotedMessageId: 'q_dup', metadata: '{}' }),
    ).resolves.toBeUndefined();
  });

  it('never throws when the DB read fails (non-blocking)', async () => {
    prisma.iMMessage.findMany.mockRejectedValue(new Error('db down'));
    await expect(
      callWrite({ id: 'msg_8', conversationId: 'conv_1', quotedMessageId: 'q_x', metadata: '{}' }),
    ).resolves.toBeUndefined();
  });
});

// ─── Task #2 — dispatcher contextEnvelope flag branch ─────────────────────────
describe('dispatchToAgent contextEnvelope (release201/26 task #2)', () => {
  function recentRow() {
    return {
      id: 'msg_trigger',
      conversationId: 'conv_1',
      senderId: 'human_1',
      type: 'text',
      content: 'do the thing',
      metadata: '{}',
      attachments: null,
      createdAt: new Date('2026-05-29T10:00:00Z'),
    };
  }

  async function dispatch() {
    const { MessageService } = await import('../services/message.service');
    const service = new MessageService({ publish: vi.fn() } as never);
    const createTaskRun = vi.fn().mockResolvedValue({ id: 'run_1' });
    const dispatchTaskRun = vi.fn().mockResolvedValue(undefined);
    service.setTaskService({ createTaskRun, dispatchTaskRun } as never);
    (service as unknown as { messageModel: { list: typeof vi.fn } }).messageModel = {
      list: vi.fn().mockResolvedValue([recentRow()]),
    };
    prisma.iMUser.findMany.mockResolvedValue([{ id: 'human_1', username: 'alice', role: 'human', displayName: 'Alice' }]);
    prisma.iMAgentProfile.findFirst.mockResolvedValue({ id: 'profile_1', workspaceId: 'ws_1' });
    prisma.iMParticipant.findMany.mockResolvedValue([
      { imUserId: 'human_1', imUser: { username: 'alice', displayName: 'Alice', role: 'human', agentType: null } },
      { imUserId: 'agent_1', imUser: { username: 'eng', displayName: 'Eng', role: 'agent', agentType: 'spec' } },
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
      { userId: 'agent_1', username: 'eng', role: 'agent' },
      recentRow(),
      1,
      'group',
    );
    return { createTaskRun };
  }

  it('flag-off: keeps legacy metadata.context, NO contextEnvelope key', async () => {
    delete process.env.FF_CONTEXT_ENVELOPE_ENABLED;
    const { createTaskRun } = await dispatch();
    const meta = createTaskRun.mock.calls[0][2].metadata;
    expect(Array.isArray(meta.context)).toBe(true);
    expect(meta.context.length).toBeGreaterThan(0);
    expect('contextEnvelope' in meta).toBe(false);
  });

  it('flag-on: stamps metadata.contextEnvelope (envelopeVersion 1) AND keeps legacy context', async () => {
    process.env.FF_CONTEXT_ENVELOPE_ENABLED = 'true';
    const { createTaskRun } = await dispatch();
    const meta = createTaskRun.mock.calls[0][2].metadata;
    expect(meta.contextEnvelope).toBeDefined();
    expect(meta.contextEnvelope.envelopeVersion).toBe(1);
    expect(meta.contextEnvelope.conversationId).toBe('conv_1');
    // Legacy context is still carried as the adapter fallback (doc §8).
    expect(Array.isArray(meta.context)).toBe(true);
    delete process.env.FF_CONTEXT_ENVELOPE_ENABLED;
  });
});

// ─── Task #3 — token backfill worker ──────────────────────────────────────────
describe('backfillMessageTokenCounts (release201/26 task #3)', () => {
  it('updates each NULL-token row with the cl100k estimate', async () => {
    prisma.iMMessage.findMany.mockResolvedValue([
      { id: 'm1', content: 'a'.repeat(40) }, // ~10 tokens
      { id: 'm2', content: '' }, // 0 tokens
    ]);
    const { backfillMessageTokenCounts } = await import('../services/conversation-memory.service');
    const updated = await backfillMessageTokenCounts(10);
    expect(updated).toBe(2);
    expect(prisma.iMMessage.update).toHaveBeenCalledWith({ where: { id: 'm1' }, data: { tokenCountCl100k: 10 } });
    expect(prisma.iMMessage.update).toHaveBeenCalledWith({ where: { id: 'm2' }, data: { tokenCountCl100k: 0 } });
  });

  it('returns 0 when nothing is pending', async () => {
    prisma.iMMessage.findMany.mockResolvedValue([]);
    const { backfillMessageTokenCounts } = await import('../services/conversation-memory.service');
    expect(await backfillMessageTokenCounts(10)).toBe(0);
  });

  it('never throws when the scan query fails', async () => {
    prisma.iMMessage.findMany.mockRejectedValue(new Error('db down'));
    const { backfillMessageTokenCounts } = await import('../services/conversation-memory.service');
    await expect(backfillMessageTokenCounts(10)).resolves.toBe(0);
  });

  it('skips a row whose update fails without aborting the batch', async () => {
    prisma.iMMessage.findMany.mockResolvedValue([
      { id: 'm1', content: 'abcd' },
      { id: 'm2', content: 'efgh' },
    ]);
    prisma.iMMessage.update.mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'P2025' }));
    const { backfillMessageTokenCounts } = await import('../services/conversation-memory.service');
    const updated = await backfillMessageTokenCounts(10);
    expect(updated).toBe(1); // m1 failed, m2 succeeded
  });
});
