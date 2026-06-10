// docs/release201/31 §4.1 #2 — budget floors + override + recent protection,
// REAL DB, NO MOCKS. Hits live MySQL; self-skips without MySQL DATABASE_URL.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import prisma from '../db';
import { ConversationMemoryService } from '../services/conversation-memory.service';

const REAL_DB = (process.env.DATABASE_URL ?? '').startsWith('mysql');
const suite = REAL_DB ? describe : describe.skip;

const svc = new ConversationMemoryService();
const TAG = `itbud${Date.now()}`;
const FLOOR_KEYS = new Set(['recent', 'compressedSegments', 'quotes', 'identifierIndex', 'recentTaskTrace']);

const state = { convId: '', userId: '', visibleCount: 0 };

suite('envelope budget (real MySQL, no mocks)', () => {
  beforeAll(async () => {
    const u = await prisma.iMUser.create({ data: { username: `${TAG}_u`, displayName: 'U', role: 'human' } });
    const conv = await prisma.iMConversation.create({ data: { type: 'group', createdById: u.id } });
    state.userId = u.id;
    state.convId = conv.id;
    const base = Date.now();
    // 12 fat visible messages (~1KB each ≈ 250 cl100k tokens each → ~3000 total,
    // well over the recent floor 2000) to exercise budgeting on a real read.
    const big = 'x'.repeat(1000);
    for (let i = 0; i < 12; i++) {
      await prisma.iMMessage.create({
        data: {
          conversationId: conv.id,
          senderId: u.id,
          content: `${big}-${i}`,
          type: 'text',
          metadata: '{}',
          createdAt: new Date(base + i * 1000),
        },
      });
    }
    state.visibleCount = 12;
  });

  afterAll(async () => {
    if (!state.convId) return;
    await prisma.iMMessage.deleteMany({ where: { conversationId: state.convId } });
    await prisma.iMConversation.delete({ where: { id: state.convId } }).catch(() => {});
    await prisma.iMUser.deleteMany({ where: { id: state.userId } });
    delete process.env.FF_CONTEXT_ENVELOPE_ENABLED;
  });

  const trigger = () => ({
    id: 'trigger',
    senderId: state.userId,
    type: 'text',
    content: 'trigger',
    metadata: '{}',
    quotedMessageId: null,
    createdAt: new Date(),
  });

  it('default budget is 8000 cl100k with all five floors', async () => {
    process.env.FF_CONTEXT_ENVELOPE_ENABLED = 'true';
    const env = await svc.buildEnvelopeIfEnabled(state.convId, trigger());
    expect(env!.budget.totalTokens).toBe(8000);
    expect(new Set(Object.keys(env!.budget.floors))).toEqual(FLOOR_KEYS);
    // floors must fit within total.
    const floorSum = Object.values(env!.budget.floors).reduce((a, b) => a + b, 0);
    expect(floorSum).toBeLessThanOrEqual(env!.budget.totalTokens);
  });

  it('hints.totalTokens overrides the default', async () => {
    process.env.FF_CONTEXT_ENVELOPE_ENABLED = 'true';
    const env = await svc.buildEnvelopeIfEnabled(state.convId, trigger(), { totalTokens: 4096 });
    expect(env!.budget.totalTokens).toBe(4096);
  });

  it('recent is never dropped — all visible messages survive budgeting (§10)', async () => {
    process.env.FF_CONTEXT_ENVELOPE_ENABLED = 'true';
    // Even with a tiny budget, recent (the trigger context) must not be starved.
    const env = await svc.buildEnvelopeIfEnabled(state.convId, trigger(), { totalTokens: 500 });
    expect(env!.recent.length).toBe(state.visibleCount);
    // empty-producer: nothing else competes for budget anyway (§0.5).
    expect(env!.compressedSegments).toEqual([]);
    expect(env!.quotes).toEqual([]);
  });
});
