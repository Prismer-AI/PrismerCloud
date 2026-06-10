// docs/release201/31 §4.1 #1 — §5.1 visibility matrix, REAL DB, NO MOCKS.
//
// Exhaustive per-type/per-kind check that buildEnvelope's recent[] includes
// exactly the agent-visible messages and strips lifecycle/system/metric-only
// ones. Hits live MySQL (prismer-dev-mysql :3307); seeds one message per
// matrix row; self-skips without a MySQL DATABASE_URL.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import prisma from '../db';
import { ConversationMemoryService } from '../services/conversation-memory.service';

const REAL_DB = (process.env.DATABASE_URL ?? '').startsWith('mysql');
const suite = REAL_DB ? describe : describe.skip;

const svc = new ConversationMemoryService();
const TAG = `itvis${Date.now()}`;

// [type, metadata.kind | null, expectedVisible]
const MATRIX: Array<[string, string | null, boolean]> = [
  ['text', null, true],
  ['markdown', null, true],
  ['code', null, true],
  ['image', null, true],
  ['file', null, true],
  ['artifact', null, true],
  ['text', 'agent_reply', true],
  ['text', 'task.progress', false],
  ['text', 'task.completed', false],
  ['task_status_event', 'task_status_event', false],
  ['text', 'awaiting_human_approval', false],
  ['system_event', 'system_event', false],
  ['system', null, false],
  ['thinking', null, false],
  ['tool_call', null, false],
  ['tool_result', null, false],
];

const state = { convId: '', userId: '', idToRow: new Map<string, [string, string | null, boolean]>() };

suite('§5.1 visibility matrix (real MySQL, no mocks)', () => {
  beforeAll(async () => {
    const u = await prisma.iMUser.create({ data: { username: `${TAG}_u`, displayName: 'U', role: 'human' } });
    const conv = await prisma.iMConversation.create({ data: { type: 'group', createdById: u.id } });
    state.userId = u.id;
    state.convId = conv.id;
    const base = Date.now();
    for (let i = 0; i < MATRIX.length; i++) {
      const [type, kind] = MATRIX[i];
      const m = await prisma.iMMessage.create({
        data: {
          conversationId: conv.id,
          senderId: u.id,
          content: `row-${i}-${type}-${kind ?? 'none'}`,
          type,
          metadata: kind ? JSON.stringify({ kind }) : '{}',
          createdAt: new Date(base + i * 1000),
        },
      });
      state.idToRow.set(m.id, MATRIX[i]);
    }
  });

  afterAll(async () => {
    if (!state.convId) return;
    await prisma.iMMessage.deleteMany({ where: { conversationId: state.convId } });
    await prisma.iMConversation.delete({ where: { id: state.convId } }).catch(() => {});
    await prisma.iMUser.deleteMany({ where: { id: state.userId } });
  });

  it('recent[] includes exactly the visible rows, strips the rest', async () => {
    process.env.FF_CONTEXT_ENVELOPE_ENABLED = 'true';
    const env = await svc.buildEnvelopeIfEnabled(state.convId, {
      id: 'trigger',
      senderId: state.userId,
      type: 'text',
      content: 'trigger',
      metadata: '{}',
      quotedMessageId: null,
      createdAt: new Date(),
    });
    delete process.env.FF_CONTEXT_ENVELOPE_ENABLED;
    expect(env).not.toBeNull();

    const recentIds = new Set(env!.recent.map((r) => r.messageId));
    for (const [id, [type, kind, expectedVisible]] of state.idToRow.entries()) {
      expect(recentIds.has(id), `type=${type} kind=${kind} expectedVisible=${expectedVisible}`).toBe(expectedVisible);
    }
    // count sanity: exactly the visible rows
    const expectedCount = MATRIX.filter(([, , v]) => v).length;
    expect(env!.recent.length).toBe(expectedCount);
  });
});
