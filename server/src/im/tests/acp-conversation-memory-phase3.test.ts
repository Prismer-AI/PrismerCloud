/**
 * release201/26 Phase 3 — backend unit tests.
 *
 * Covers:
 *  • IdentifierIndex extraction + upsert (create path + alias accumulation)
 *  • TaskTrace distil from IMTaskRunStep + writes L2 (NOT an IMMessage)
 *  • buildEnvelope fills identifierIndex + recentTaskTrace
 *  • resolve endpoint returns multiple candidates on ambiguity (不猜)
 *  • quote endpoint: snapshot hit, live fallback, deleted-source
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── shared prisma mock ───────────────────────────────────────────────────────
const prisma = vi.hoisted(() => ({
  iMConversation: { findUnique: vi.fn() },
  iMParticipant: { findMany: vi.fn(), findUnique: vi.fn() },
  iMMessage: { findMany: vi.fn(), findFirst: vi.fn() },
  iMUser: { findMany: vi.fn(), findUnique: vi.fn() },
  iMConversationCompressedSegment: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), aggregate: vi.fn() },
  iMConversationQuoteCache: { findMany: vi.fn(), findFirst: vi.fn() },
  iMConversationIdentifierIndex: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  $queryRaw: vi.fn(),
}));
vi.mock('../db', () => ({ default: prisma }));

const authState = vi.hoisted(() => ({ canObserve: true, imUserId: 'u-1' }));
vi.mock('../auth/middleware', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    c.set('user', { imUserId: authState.imUserId, role: 'human' });
    return next();
  }),
}));
vi.mock('../api/conversation-visibility', () => ({
  resolveConversationViewerAccess: vi.fn(async () => ({ canObserve: authState.canObserve, role: 'member' })),
  buildConversationViewerAccess: vi.fn(),
  hasWorkspaceConversationAccess: vi.fn(),
}));
vi.mock('../services/conversation-compaction.service', () => ({
  conversationCompactionService: { regenerateSegment: vi.fn() },
}));

import {
  extractIdentifiers,
  ConversationIdentifierService,
} from '../services/conversation-identifier.service';
import {
  distilTaskTrace,
  ConversationTaskTraceService,
} from '../services/conversation-task-trace.service';
import { ConversationMemoryService } from '../services/conversation-memory.service';

function resetAll() {
  for (const model of Object.values(prisma)) {
    if (typeof model === 'function') {
      (model as any).mockReset?.();
      continue;
    }
    for (const fn of Object.values(model as Record<string, any>)) fn.mockReset?.();
  }
  authState.canObserve = true;
  authState.imUserId = 'u-1';
}

// ════════════════════════════════════════════════════════════════════════════
describe('Phase 3 — IdentifierIndex extraction', () => {
  beforeEach(resetAll);

  it('extracts task / asset / url and resolved @mention', () => {
    const handles = new Map([['eng', { id: 'u-agent', role: 'agent', displayName: 'Engineer' }]]);
    const out = extractIdentifiers(
      'look at task:cmpabc123def and asset:clx99887766 plus https://x.io/a, ping @eng',
      null,
      handles,
    );
    const byKind = (k: string) => out.filter((o) => o.kind === k);
    expect(byKind('task')[0].canonicalId).toBe('cmpabc123def');
    expect(byKind('asset')[0].canonicalId).toBe('clx99887766');
    expect(byKind('url')[0].canonicalId).toBe('https://x.io/a');
    const agent = byKind('agent')[0];
    expect(agent.canonicalId).toBe('u-agent'); // resolved to imUserId, not handle
    expect(agent.alias).toBe('@eng');
  });

  it('unresolved @mention keeps the handle as canonicalId', () => {
    const out = extractIdentifiers('hey @ghost are you there', null, new Map());
    const agent = out.find((o) => o.kind === 'agent');
    expect(agent?.canonicalId).toBe('@ghost');
  });

  it('upsert: creates on first sight, accumulates alias + bumps lastReferenced on repeat', async () => {
    const svc = new ConversationIdentifierService();
    // first sight → create
    prisma.iMParticipant.findMany.mockResolvedValue([]);
    prisma.iMConversationIdentifierIndex.findUnique.mockResolvedValue(null);
    await svc.populateFromMessage({ id: 'm1', conversationId: 'c1', content: 'see task:cmpabc123def' });
    expect(prisma.iMConversationIdentifierIndex.create).toHaveBeenCalledTimes(1);
    const created = prisma.iMConversationIdentifierIndex.create.mock.calls[0][0].data;
    expect(created.canonicalId).toBe('cmpabc123def');
    expect(created.firstSeenMessageId).toBe('m1');

    // second sight (existing row) → update, accumulate new alias
    prisma.iMConversationIdentifierIndex.findUnique.mockResolvedValue({
      id: 'idx1',
      aliasesJson: '["task:cmpabc123def"]',
      displayLabel: 'task:cmpabc123def',
    });
    await svc.populateFromMessage({ id: 'm2', conversationId: 'c1', content: 'task:cmpabc123def again' });
    const upd = prisma.iMConversationIdentifierIndex.update.mock.calls[0][0].data;
    expect(upd.lastReferencedMessageId).toBe('m2');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('Phase 3 — TaskTrace distil + L2 write', () => {
  beforeEach(resetAll);

  it('distils tools / outputs / decisions from steps + finalOutput', () => {
    const steps = [
      { kind: 'tool_call', payloadJson: { toolName: 'bash', inputSummary: 'ls' } },
      { kind: 'tool_result', payloadJson: { outputSummary: 'file.txt' } },
      { kind: 'tool_call', payloadJson: { toolName: 'bash' } }, // dup → coalesced
      { kind: 'reasoning_chunk', payloadJson: { text: 'decided to edit' } },
    ];
    const t = distilTaskTrace(steps, 'all done');
    expect(t.toolsUsed).toEqual(['bash']);
    expect(t.outputs).toContain('file.txt');
    expect(t.outputs).toContain('all done');
    expect(t.decisions).toEqual(['decided to edit']);
  });

  it('writes a task_trace L2 segment and never an IMMessage', async () => {
    const svc = new ConversationTaskTraceService();
    prisma.$queryRaw.mockResolvedValue([
      { kind: 'tool_call', payloadJson: JSON.stringify({ toolName: 'edit' }) },
    ]);
    prisma.iMConversationCompressedSegment.aggregate.mockResolvedValue({ _max: { segmentSeq: 2 } });
    prisma.iMConversationCompressedSegment.create.mockResolvedValue({ id: 'seg-trace' });

    const id = await svc.writeTaskTrace({
      taskRunId: 'run-1',
      taskId: 'task-1',
      conversationId: 'c1',
      triggerMessageId: 'm-trigger',
      finalOutput: 'done',
    });

    expect(id).toBe('seg-trace');
    const data = prisma.iMConversationCompressedSegment.create.mock.calls[0][0].data;
    expect(data.segmentKind).toBe('task_trace');
    expect(data.segmentSeq).toBe(3); // max+1
    expect(JSON.parse(data.coveredRawMessageIdsJson)).toEqual(['m-trigger']);
    const facts = JSON.parse(data.salientFactsJson);
    expect(facts.taskId).toBe('task-1');
    expect(facts.toolsUsed).toEqual(['edit']);
    // No IMMessage write path exists on this service — the mock has no
    // iMMessage.create call.
    expect(prisma.iMMessage.findMany).not.toHaveBeenCalled();
  });

  it('skips (returns null) when no conversationId', async () => {
    const svc = new ConversationTaskTraceService();
    const id = await svc.writeTaskTrace({
      taskRunId: 'run-1',
      taskId: 'task-1',
      conversationId: null,
      triggerMessageId: null,
    });
    expect(id).toBeNull();
    expect(prisma.iMConversationCompressedSegment.create).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('Phase 3 — buildEnvelope fills identifierIndex + recentTaskTrace', () => {
  beforeEach(() => {
    resetAll();
    prisma.iMConversation.findUnique.mockResolvedValue({ id: 'c1', type: 'group' });
    prisma.iMParticipant.findMany.mockResolvedValue([]);
    prisma.iMMessage.findMany.mockResolvedValue([]);
    prisma.iMUser.findMany.mockResolvedValue([]);
    prisma.iMConversationCompressedSegment.findMany.mockResolvedValue([]);
    prisma.iMConversationQuoteCache.findMany.mockResolvedValue([]);
  });

  it('attaches identifierIndex (top-K) and recentTaskTrace', async () => {
    prisma.iMConversationIdentifierIndex.findMany.mockResolvedValue([
      { identifierKind: 'task', canonicalId: 'cmpabc', displayLabel: 'task:cmpabc', updatedAt: new Date('2026-05-29T00:00:00Z') },
    ]);
    prisma.iMConversationCompressedSegment.findFirst.mockResolvedValue({
      salientFactsJson: JSON.stringify({ taskId: 'task-1', toolsUsed: ['bash'], outputs: ['ok'], decisions: [] }),
    });

    const svc = new ConversationMemoryService();
    const env = await svc.buildEnvelope('c1', {
      id: 'm1',
      conversationId: 'c1',
      senderId: 'u-1',
      type: 'text',
      content: 'hi',
      createdAt: new Date(),
    });

    expect(env.identifierIndex).toBeDefined();
    expect(env.identifierIndex![0]).toMatchObject({ kind: 'task', canonicalId: 'cmpabc' });
    expect(env.recentTaskTrace).toEqual({
      taskId: 'task-1',
      toolsUsed: ['bash'],
      outputs: ['ok'],
      decisions: [],
    });
  });

  it('omits both fields when empty (flag-off shape preserved)', async () => {
    prisma.iMConversationIdentifierIndex.findMany.mockResolvedValue([]);
    prisma.iMConversationCompressedSegment.findFirst.mockResolvedValue(null);

    const svc = new ConversationMemoryService();
    const env = await svc.buildEnvelope('c1', {
      id: 'm1',
      conversationId: 'c1',
      senderId: 'u-1',
      type: 'text',
      content: 'hi',
      createdAt: new Date(),
    });
    expect('identifierIndex' in env).toBe(false);
    expect('recentTaskTrace' in env).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('Phase 3 — resolve + quote endpoints', () => {
  beforeEach(resetAll);

  function makeRouter() {
    return import('../api/conversations').then(({ createConversationsRouter }) =>
      createConversationsRouter({} as any),
    );
  }

  it('resolve: 403 for non-participant', async () => {
    authState.canObserve = false;
    const router = await makeRouter();
    const res = await router.request('/c1/identifiers/resolve?q=foo');
    expect(res.status).toBe(403);
  });

  it('resolve: ambiguous query returns multiple candidates, no single canonicalId', async () => {
    prisma.iMConversationIdentifierIndex.findMany.mockResolvedValue([
      { identifierKind: 'task', canonicalId: 'cmp1', aliasesJson: '["the layout"]', displayLabel: 'layout one' },
      { identifierKind: 'task', canonicalId: 'cmp2', aliasesJson: '["the layout"]', displayLabel: 'layout two' },
    ]);
    const router = await makeRouter();
    const res = await router.request('/c1/identifiers/resolve?q=the%20layout');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.canonicalId).toBeNull(); // ambiguous → don't guess
    expect(body.data.candidates).toHaveLength(2);
  });

  it('resolve: unambiguous single top match returns canonicalId', async () => {
    prisma.iMConversationIdentifierIndex.findMany.mockResolvedValue([
      { identifierKind: 'task', canonicalId: 'cmp1', aliasesJson: '["the layout"]', displayLabel: 'layout one' },
      { identifierKind: 'asset', canonicalId: 'clx9', aliasesJson: '["the file"]', displayLabel: 'file' },
    ]);
    const router = await makeRouter();
    const res = await router.request('/c1/identifiers/resolve?q=the%20layout');
    const body = await res.json();
    expect(body.data.canonicalId).toBe('cmp1');
    expect(body.data.candidates.length).toBeGreaterThanOrEqual(1);
  });

  it('quote: snapshot hit returns content + sender', async () => {
    prisma.iMConversationQuoteCache.findFirst.mockResolvedValue({
      snapshotContent: 'quoted text',
      snapshotSender: 'alice',
      snapshotCreatedAt: new Date('2026-05-01T00:00:00Z'),
      sourceDeletedAt: null,
    });
    const router = await makeRouter();
    const res = await router.request('/c1/quote/m9');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.content).toBe('quoted text');
    expect(body.data.sender).toBe('alice');
    expect(body.data.sourceDeletedAt).toBeUndefined();
  });

  it('quote: deleted source surfaces sourceDeletedAt', async () => {
    prisma.iMConversationQuoteCache.findFirst.mockResolvedValue({
      snapshotContent: 'gone',
      snapshotSender: 'bob',
      snapshotCreatedAt: new Date('2026-05-01T00:00:00Z'),
      sourceDeletedAt: new Date('2026-05-10T00:00:00Z'),
    });
    const router = await makeRouter();
    const res = await router.request('/c1/quote/m9');
    const body = await res.json();
    expect(body.data.sourceDeletedAt).toBe('2026-05-10T00:00:00.000Z');
  });

  it('quote: live fallback when no snapshot', async () => {
    prisma.iMConversationQuoteCache.findFirst.mockResolvedValue(null);
    prisma.iMMessage.findFirst.mockResolvedValue({
      id: 'm9',
      content: 'live read',
      senderId: 'u-x',
      createdAt: new Date('2026-05-02T00:00:00Z'),
    });
    prisma.iMUser.findUnique.mockResolvedValue({ username: 'carol' });
    const router = await makeRouter();
    const res = await router.request('/c1/quote/m9');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.content).toBe('live read');
    expect(body.data.sender).toBe('carol');
  });

  it('quote: 404 when neither snapshot nor raw message exists', async () => {
    prisma.iMConversationQuoteCache.findFirst.mockResolvedValue(null);
    prisma.iMMessage.findFirst.mockResolvedValue(null);
    const router = await makeRouter();
    const res = await router.request('/c1/quote/m-missing');
    expect(res.status).toBe(404);
  });

  // summary is the agent-facing (membership-gated) read of compressed-segment
  // summaries — distinct from the admin-only /memory endpoint. AuthZ must be
  // membership (canObserve), NOT admin, so a non-admin agent can call it.
  it('summary: 403 for non-participant', async () => {
    authState.canObserve = false;
    const router = await makeRouter();
    const res = await router.request('/c1/summary');
    expect(res.status).toBe(403);
  });

  it('summary: membership (non-admin) returns current-range segment summaries', async () => {
    // user.role is 'human' (non-admin) per the auth mock — must still succeed.
    prisma.iMConversationCompressedSegment.findMany.mockResolvedValue([
      {
        segmentSeq: 0,
        segmentKind: 'range',
        summary: 'discussed the layout',
        coversFromMessageId: 'm1',
        coversToMessageId: 'm9',
        coversFromCreatedAt: new Date('2026-05-01T00:00:00Z'),
        coversToCreatedAt: new Date('2026-05-02T00:00:00Z'),
        coveredRawMessageIdsJson: '["m1","m2","m9"]',
        tokenCountCl100k: 42,
      },
    ]);
    const router = await makeRouter();
    const res = await router.request('/c1/summary');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.segments).toHaveLength(1);
    expect(body.data.segments[0]).toMatchObject({
      segmentSeq: 0,
      summary: 'discussed the layout',
      messageCount: 3,
      tokenCount: 42,
    });
    // membership-gated read must only query current (supersededBy:null) segments
    const whereArg = prisma.iMConversationCompressedSegment.findMany.mock.calls[0][0].where;
    expect(whereArg.supersededBy).toBeNull();
    expect(whereArg.conversationId).toBe('c1');
    // must NOT leak producer internals / identifier index (admin-only on /memory)
    expect('producerModel' in body.data.segments[0]).toBe(false);
    expect('identifiers' in body.data).toBe(false);
  });
});
