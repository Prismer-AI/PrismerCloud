// docs/release201/31 §5.5 — envelope flag-on/off parity, REAL DB, NO MOCKS.
//
// The headline Phase E "0 行为变更" regression: with producers NOT wired (§0.5 —
// segment/quote/trace tables empty), flag-off (legacy metadata.context path,
// buildEnvelopeIfEnabled → null) and flag-on (new envelope) must expose the
// SAME agent-visible message set. This test hits the live MySQL dev stack
// (prismer-dev-mysql :3307) and calls the REAL ConversationMemoryService — no
// prisma mock, no vi.mock. It seeds its own rows and tears them down.
//
// Run (real DB required):
//   DATABASE_URL=$(grep '^DATABASE_URL=' .env.local | cut -d= -f2-) \
//     npx vitest run src/im/tests/acp-envelope-flag-parity.test.ts
//
// Skips itself when DATABASE_URL is not MySQL, so the mocked acp-* suite (which
// runs without a DB) stays green.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import prisma from '../db';
import { ConversationMemoryService } from '../services/conversation-memory.service';

const REAL_DB = (process.env.DATABASE_URL ?? '').startsWith('mysql');
const suite = REAL_DB ? describe : describe.skip;

const svc = new ConversationMemoryService();
const TAG = `itfp${Date.now()}`;

// §5.1 visibility, recomputed INDEPENDENTLY of the service so the parity
// assertion is a real cross-check, not a tautology.
function visibleByDocRule(type: string, kind: string | null): boolean {
  if (kind === 'agent_reply') return true;
  if (kind && (kind.startsWith('task.') || kind === 'system_event' || kind === 'task_status_event' || kind === 'awaiting_human_approval')) {
    return false;
  }
  return ['text', 'markdown', 'code', 'image', 'file', 'artifact'].includes(type);
}

const state = {
  convId: '',
  aliceId: '',
  ceoId: '',
  visibleOrder: [] as string[], // oldest-first
  strippedIds: [] as string[],
};

suite('envelope flag-on/off parity (real MySQL, no mocks)', () => {
  beforeAll(async () => {
    const alice = await prisma.iMUser.create({
      data: { username: `${TAG}_alice`, displayName: 'Alice', role: 'human' },
    });
    const ceo = await prisma.iMUser.create({
      data: { username: `${TAG}_ceo`, displayName: 'CEO', role: 'agent', agentType: 'hermes' },
    });
    const conv = await prisma.iMConversation.create({
      data: { type: 'group', createdById: alice.id },
    });
    await prisma.iMParticipant.createMany({
      data: [
        { conversationId: conv.id, imUserId: alice.id, role: 'member' },
        { conversationId: conv.id, imUserId: ceo.id, role: 'member' },
      ],
    });

    const base = Date.now();
    const mk = async (senderId: string, content: string, type: string, kind: string | null, i: number) =>
      prisma.iMMessage.create({
        data: {
          conversationId: conv.id,
          senderId,
          content,
          type,
          metadata: kind ? JSON.stringify({ kind }) : '{}',
          createdAt: new Date(base + i * 1000),
        },
      });

    const m1 = await mk(alice.id, 'first visible line', 'text', null, 1); // visible
    const m2 = await mk(alice.id, 'second visible line', 'text', null, 2); // visible
    const m3 = await mk(ceo.id, 'infra noise', 'system_event', 'system_event', 3); // stripped
    const m4 = await mk(alice.id, 'task progressed', 'text', 'task.progress', 4); // stripped (metric-only)
    const m5 = await mk(ceo.id, 'agent reply body', 'text', 'agent_reply', 5); // visible

    state.convId = conv.id;
    state.aliceId = alice.id;
    state.ceoId = ceo.id;
    state.visibleOrder = [m1.id, m2.id, m5.id];
    state.strippedIds = [m3.id, m4.id];
  });

  afterEach(() => {
    delete process.env.FF_CONTEXT_ENVELOPE_ENABLED;
  });

  afterAll(async () => {
    if (!state.convId) return;
    await prisma.iMMessage.deleteMany({ where: { conversationId: state.convId } });
    await prisma.iMParticipant.deleteMany({ where: { conversationId: state.convId } });
    await prisma.iMConversation.delete({ where: { id: state.convId } }).catch(() => {});
    await prisma.iMUser.deleteMany({ where: { id: { in: [state.aliceId, state.ceoId].filter(Boolean) } } });
    delete process.env.FF_CONTEXT_ENVELOPE_ENABLED;
  });

  const trigger = () => ({
    id: 'trigger',
    senderId: state.aliceId,
    type: 'text',
    content: 'second visible line',
    metadata: '{}',
    quotedMessageId: null,
    createdAt: new Date(),
  });

  it('flag OFF → buildEnvelopeIfEnabled returns null (legacy path), against real DB', async () => {
    delete process.env.FF_CONTEXT_ENVELOPE_ENABLED;
    const env = await svc.buildEnvelopeIfEnabled(state.convId, trigger());
    expect(env).toBeNull();
  });

  it('flag ON → real envelope: only visible messages, oldest-first, real sender attribution', async () => {
    process.env.FF_CONTEXT_ENVELOPE_ENABLED = 'true';
    const env = await svc.buildEnvelopeIfEnabled(state.convId, trigger());
    expect(env).not.toBeNull();
    expect(env!.envelopeVersion).toBe(1);
    expect(env!.conversationId).toBe(state.convId);
    expect(env!.conversationType).toBe('group');

    const ids = env!.recent.map((r) => r.messageId);
    // exact visible set, in chronological order
    expect(ids).toEqual(state.visibleOrder);
    // stripped (system_event / task.*) never leak into recent
    for (const s of state.strippedIds) expect(ids).not.toContain(s);

    // real sender attribution resolved from IMUser rows
    const m1 = env!.recent.find((r) => r.messageId === state.visibleOrder[0])!;
    expect(m1.sender).toBe(`${TAG}_alice`);
    expect(m1.role).toBe('human');
    const m5 = env!.recent.find((r) => r.messageId === state.visibleOrder[2])!;
    expect(m5.sender).toBe(`${TAG}_ceo`);
    expect(m5.role).toBe('agent');
  });

  it('flag ON → empty-producer shape from REAL empty tables (§0.5: producers not wired)', async () => {
    process.env.FF_CONTEXT_ENVELOPE_ENABLED = 'true';
    const env = await svc.buildEnvelopeIfEnabled(state.convId, trigger());
    // These come from live queries against the (empty) segment/quote tables.
    expect(env!.compressedSegments).toEqual([]);
    expect(env!.quotes).toEqual([]);
    expect(env!.identifierIndex).toBeUndefined();
    expect(env!.recentTaskTrace).toBeUndefined();
    expect(env!.budget.totalTokens).toBe(8000);
    expect(new Set(Object.keys(env!.budget.floors))).toEqual(
      new Set(['recent', 'compressedSegments', 'quotes', 'identifierIndex', 'recentTaskTrace']),
    );
  });

  it('PARITY: flag-on recent == the conversation\'s real visible ledger (independent recompute)', async () => {
    process.env.FF_CONTEXT_ENVELOPE_ENABLED = 'true';
    const env = await svc.buildEnvelopeIfEnabled(state.convId, trigger());

    // Independently re-derive the agent-visible set straight from the DB rows,
    // using the §5.1 rule (NOT via the service) — this is the "no message
    // dropped/added vs legacy" invariant on the empty-producer state.
    const rows = await prisma.iMMessage.findMany({
      where: { conversationId: state.convId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, type: true, metadata: true },
    });
    const expectedVisible = rows
      .filter((r) => {
        let kind: string | null = null;
        try {
          kind = (JSON.parse(r.metadata || '{}') as { kind?: string }).kind ?? null;
        } catch {
          kind = null;
        }
        return visibleByDocRule(r.type, kind);
      })
      .map((r) => r.id);

    expect(env!.recent.map((r) => r.messageId)).toEqual(expectedVisible);
  });
});
