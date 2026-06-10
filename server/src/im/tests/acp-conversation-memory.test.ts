/**
 * release201/25 §7 / release201/26 Phase 1 — ConversationMemoryService.
 *
 * Cloud-side L3 envelope builder. Covers (per doc 25 §7 / doc 26 §5):
 *   • base shape (envelopeVersion / conversationId / conversationType /
 *     participants / budget)
 *   • §5.1 visibility filter (text/file/agent_reply visible;
 *     system/system_event/task.* stripped)
 *   • compressedSegments empty-set tolerated (L2 producer is Phase 2)
 *   • quote snapshots resolved via QuoteCache (decision C — ref = raw msgId)
 *   • asset partition heuristic (Phase 1: all inputs unless hints override)
 *   • buildEnvelopeIfEnabled honours FF_CONTEXT_ENVELOPE_ENABLED
 *
 * Run:
 *   npx vitest run src/im/tests/acp-conversation-memory.test.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Stub prisma BEFORE importing the SUT so the service picks up our mocks.
const prismaMock = vi.hoisted(() => ({
  iMConversation: { findUnique: vi.fn() },
  iMParticipant: { findMany: vi.fn() },
  iMMessage: { findMany: vi.fn(), update: vi.fn() },
  iMUser: { findMany: vi.fn() },
  iMConversationCompressedSegment: { findMany: vi.fn(), findFirst: vi.fn() },
  iMConversationQuoteCache: { findMany: vi.fn() },
  iMConversationIdentifierIndex: { findMany: vi.fn() },
  iMAsset: { findMany: vi.fn() },
}));
vi.mock('../db', () => ({ default: prismaMock }));

function resetMocks() {
  vi.clearAllMocks();
  prismaMock.iMConversation.findUnique.mockResolvedValue({ id: 'conv_1', type: 'group' });
  prismaMock.iMParticipant.findMany.mockResolvedValue([]);
  prismaMock.iMMessage.findMany.mockResolvedValue([]);
  prismaMock.iMMessage.update.mockResolvedValue({});
  prismaMock.iMUser.findMany.mockResolvedValue([]);
  prismaMock.iMConversationCompressedSegment.findMany.mockResolvedValue([]);
  prismaMock.iMConversationCompressedSegment.findFirst.mockResolvedValue(null);
  prismaMock.iMConversationQuoteCache.findMany.mockResolvedValue([]);
  prismaMock.iMConversationIdentifierIndex.findMany.mockResolvedValue([]);
  prismaMock.iMAsset.findMany.mockResolvedValue([]);
  delete process.env.FF_CONTEXT_ENVELOPE_ENABLED;
}

beforeEach(resetMocks);

const CONV = 'conv_1';
const trigger = (overrides: Record<string, unknown> = {}) => ({
  id: 'm_trigger',
  conversationId: CONV,
  senderId: 'u_alice',
  type: 'text',
  content: 'hello world',
  metadata: null,
  createdAt: new Date('2026-05-31T10:00:00Z'),
  ...overrides,
});

describe('ConversationMemoryService.buildEnvelope — base shape', () => {
  it('returns envelopeVersion=1 with the expected top-level keys', async () => {
    const { ConversationMemoryService } = await import('../services/conversation-memory.service');
    const svc = new ConversationMemoryService();
    const env = await svc.buildEnvelope(CONV, trigger());
    expect(env.envelopeVersion).toBe(1);
    expect(env.conversationId).toBe(CONV);
    expect(env.conversationType).toBe('group');
    expect(env.recent).toEqual([]);
    expect(env.compressedSegments).toEqual([]);
    expect(env.quotes).toEqual([]);
    expect(env.assets).toEqual({ inputs: [], archives: [] });
    expect(env.budget.totalTokens).toBe(8000);
    expect(env.budget.floors.recent).toBe(2000);
  });

  it('maps DM conversations to conversationType=direct', async () => {
    prismaMock.iMConversation.findUnique.mockResolvedValue({ id: CONV, type: 'direct' });
    const { ConversationMemoryService } = await import('../services/conversation-memory.service');
    const env = await new ConversationMemoryService().buildEnvelope(CONV, trigger());
    expect(env.conversationType).toBe('direct');
  });

  it('projects active participants (excluding leftAt) into ParticipantRef[]', async () => {
    prismaMock.iMParticipant.findMany.mockResolvedValue([
      {
        imUser: { id: 'u_a', username: 'alice', displayName: 'Alice', role: 'human', agentType: null },
      },
      {
        imUser: { id: 'u_b', username: 'bot', displayName: 'Bot', role: 'agent', agentType: 'hermes' },
      },
    ]);
    const { ConversationMemoryService } = await import('../services/conversation-memory.service');
    const env = await new ConversationMemoryService().buildEnvelope(CONV, trigger());
    expect(env.participants).toHaveLength(2);
    expect(env.participants[0]).toMatchObject({ username: 'alice', role: 'human' });
    expect(env.participants[1]).toMatchObject({ username: 'bot', agentType: 'hermes' });
  });
});

describe('ConversationMemoryService.buildEnvelope — §5.1 visibility filter', () => {
  it('keeps text / file / agent_reply rows and drops system_event / task.* rows', async () => {
    // Service queries orderBy createdAt:desc then reverse()s for oldest-first,
    // so mock returns rows newest-first to mimic the real query result.
    prismaMock.iMMessage.findMany.mockResolvedValue([
      // task.* kind (stripped)
      { id: 'm_4', senderId: 'u_sys', type: 'text', content: 'task done', metadata: JSON.stringify({ kind: 'task.completed' }), createdAt: new Date('2026-05-31T09:00:40Z'), attachments: [] },
      // agent_reply ride on text (visible)
      { id: 'm_3', senderId: 'u_bot', type: 'text', content: 'sure', metadata: JSON.stringify({ kind: 'agent_reply' }), createdAt: new Date('2026-05-31T09:00:30Z'), attachments: [] },
      // system_event (stripped)
      { id: 'm_2', senderId: 'u_sys', type: 'system_event', content: 'task started', metadata: null, createdAt: new Date('2026-05-31T09:00:10Z'), attachments: [] },
      // user text (visible)
      { id: 'm_1', senderId: 'u_a', type: 'text', content: 'hi', metadata: null, createdAt: new Date('2026-05-31T09:00:00Z'), attachments: [] },
    ]);
    prismaMock.iMUser.findMany.mockResolvedValue([
      { id: 'u_a', username: 'alice', role: 'human' },
      { id: 'u_bot', username: 'bot', role: 'agent' },
      { id: 'u_sys', username: 'system', role: 'system' },
    ]);
    const { ConversationMemoryService } = await import('../services/conversation-memory.service');
    const env = await new ConversationMemoryService().buildEnvelope(CONV, trigger());
    const ids = env.recent.map((r) => r.messageId);
    // m_2 (system_event) + m_4 (task.completed) dropped; m_1 + m_3 kept.
    expect(ids).toEqual(['m_1', 'm_3']);
    expect(env.recent[0]).toMatchObject({ sender: 'alice', role: 'human' });
    expect(env.recent[1]).toMatchObject({ sender: 'bot', role: 'agent' });
  });
});

describe('ConversationMemoryService.buildEnvelope — quotes (decision C)', () => {
  it('snapshots a quoted message from QuoteCache when the cache row exists', async () => {
    prismaMock.iMConversationQuoteCache.findMany.mockResolvedValue([
      {
        quotedMessageId: 'q_1',
        snapshotContent: 'the plan we agreed on',
        snapshotSender: 'alice',
        snapshotCreatedAt: new Date('2026-05-30T12:00:00Z'),
        sourceDeletedAt: null,
      },
    ]);
    const { ConversationMemoryService } = await import('../services/conversation-memory.service');
    const env = await new ConversationMemoryService().buildEnvelope(
      CONV,
      trigger({ quotedMessageId: 'q_1' }),
    );
    expect(env.quotes).toHaveLength(1);
    expect(env.quotes[0]).toMatchObject({
      quotedMessageId: 'q_1',
      snippet: 'the plan we agreed on',
      quotedSender: 'alice',
    });
  });

  it('returns empty quotes when the trigger has no quotedMessageId', async () => {
    const { ConversationMemoryService } = await import('../services/conversation-memory.service');
    const env = await new ConversationMemoryService().buildEnvelope(CONV, trigger());
    expect(env.quotes).toEqual([]);
  });
});

describe('ConversationMemoryService.buildEnvelope — assets', () => {
  it('Phase 1 partitions all attached assets into inputs[] by default', async () => {
    prismaMock.iMMessage.findMany.mockResolvedValue([
      {
        id: 'm_1',
        senderId: 'u_a',
        type: 'text',
        content: 'see the screenshot',
        metadata: null,
        createdAt: new Date('2026-05-31T09:00:00Z'),
        attachments: [
          { assetId: 'ast_img', contentHash: 'h1', mime: 'image/png', sizeBytes: 100, kind: 'image', workspaceId: 'ws_1', role: 'attachment' },
        ],
      },
    ]);
    prismaMock.iMUser.findMany.mockResolvedValue([{ id: 'u_a', username: 'alice', role: 'human' }]);
    const { ConversationMemoryService } = await import('../services/conversation-memory.service');
    const env = await new ConversationMemoryService().buildEnvelope(CONV, trigger());
    expect(env.assets.inputs).toHaveLength(1);
    expect(env.assets.inputs[0]!.assetId).toBe('ast_img');
    expect(env.assets.archives).toEqual([]);
  });

  it('respects an explicit hints.assetIntents[assetId]=archive override', async () => {
    prismaMock.iMMessage.findMany.mockResolvedValue([
      {
        id: 'm_1',
        senderId: 'u_a',
        type: 'text',
        content: 'old deck',
        metadata: null,
        createdAt: new Date('2026-05-31T09:00:00Z'),
        attachments: [
          { assetId: 'ast_doc', contentHash: 'h2', mime: 'application/pdf', sizeBytes: 5000, kind: 'file', workspaceId: 'ws_1', role: 'context' },
        ],
      },
    ]);
    prismaMock.iMUser.findMany.mockResolvedValue([{ id: 'u_a', username: 'alice', role: 'human' }]);
    const { ConversationMemoryService } = await import('../services/conversation-memory.service');
    const env = await new ConversationMemoryService().buildEnvelope(CONV, trigger(), {
      assetIntents: { ast_doc: 'archive' },
    });
    expect(env.assets.inputs).toEqual([]);
    expect(env.assets.archives).toHaveLength(1);
    expect(env.assets.archives[0]!.assetId).toBe('ast_doc');
  });
});

describe('ConversationMemoryService.buildEnvelopeIfEnabled — flag gating', () => {
  it('returns null when FF_CONTEXT_ENVELOPE_ENABLED is unset / not "true"', async () => {
    const { ConversationMemoryService } = await import('../services/conversation-memory.service');
    const env = await new ConversationMemoryService().buildEnvelopeIfEnabled(CONV, trigger());
    expect(env).toBeNull();
  });

  it('returns an envelope when FF_CONTEXT_ENVELOPE_ENABLED=true', async () => {
    process.env.FF_CONTEXT_ENVELOPE_ENABLED = 'true';
    const { ConversationMemoryService } = await import('../services/conversation-memory.service');
    const env = await new ConversationMemoryService().buildEnvelopeIfEnabled(CONV, trigger());
    expect(env).not.toBeNull();
    expect(env!.envelopeVersion).toBe(1);
  });
});
