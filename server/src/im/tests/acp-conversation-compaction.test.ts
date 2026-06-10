/**
 * release201/26 Phase 2 — ConversationCompactionService unit tests.
 *
 * Covers:
 *  • trigger threshold evaluation (hard / char-budget / idle / below-threshold)
 *  • produceRangeSegment writes segment + reverse-index rows in one tx
 *  • concurrent P2002 on (conversationId, segmentKind, segmentSeq) → no-op
 *  • LLM failure → extractive fallback, producerModel='extractive-fallback',
 *    never throws
 *  • regenerateSegment marks the old segment supersededBy = new id
 *  • metric-only accounting: task.* / approval rows bump salientFacts counts,
 *    are NOT fed to the LLM body
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prisma: {
    iMMessage: { findMany: vi.fn(), findFirst: vi.fn() },
    iMConversation: { findMany: vi.fn() },
    iMConversationRawToSegmentIndex: { findMany: vi.fn(), createMany: vi.fn() },
    iMConversationCompressedSegment: {
      findFirst: vi.fn(),
      aggregate: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    $transaction: vi.fn(),
  },
  callLLM: vi.fn(),
}));

vi.mock('../db', () => ({ default: mocks.prisma }));
vi.mock('../services/evolution-distill', () => ({ callLLM: mocks.callLLM }));

import {
  ConversationCompactionService,
  COMPACTION_TRIGGERS,
} from '../services/conversation-compaction.service';

const CONV = 'conv-1';
const svc = new ConversationCompactionService();

let segmentCreateArgs: any = null;
let indexCreateArgs: any = null;

function rawMsg(over: Partial<any> = {}): any {
  return {
    id: `m-${Math.random().toString(36).slice(2, 8)}`,
    senderId: 'u-human',
    type: 'text',
    content: 'hello world. this is a message.',
    metadata: '{}',
    createdAt: new Date('2026-05-29T10:00:00Z'),
    ...over,
  };
}

function wireTransaction() {
  // $transaction(cb) runs cb against a tx that captures create / createMany.
  mocks.prisma.$transaction.mockImplementation(async (cb: any) => {
    const tx = {
      iMConversationCompressedSegment: {
        create: vi.fn(async (args: any) => {
          segmentCreateArgs = args;
          return { id: 'seg-new', ...args.data };
        }),
      },
      iMConversationRawToSegmentIndex: {
        createMany: vi.fn(async (args: any) => {
          indexCreateArgs = args;
          return { count: args.data.length };
        }),
      },
    };
    return cb(tx);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  segmentCreateArgs = null;
  indexCreateArgs = null;
  // sane defaults
  mocks.prisma.iMConversationRawToSegmentIndex.findMany.mockResolvedValue([]);
  mocks.prisma.iMConversationCompressedSegment.aggregate.mockResolvedValue({ _max: { segmentSeq: null } });
  mocks.prisma.iMMessage.findFirst.mockResolvedValue({ createdAt: new Date('2026-05-29T10:00:00Z') });
  mocks.callLLM.mockResolvedValue(
    JSON.stringify({
      summary: 'They discussed the layout work.',
      salientFacts: { decisions: ['ship friday'], entitiesMentioned: ['LayoutV2'] },
    }),
  );
  wireTransaction();
});

describe('trigger evaluation (via maybeCompact)', () => {
  it('does not fire below all thresholds', async () => {
    // 5 fresh messages, recent activity → no trigger.
    const now = Date.now();
    mocks.prisma.iMMessage.findMany.mockResolvedValue(
      Array.from({ length: 5 }, () => rawMsg({ createdAt: new Date(now) })),
    );
    mocks.prisma.iMMessage.findFirst.mockResolvedValue({ createdAt: new Date(now) });
    const res = await svc.maybeCompact(CONV);
    expect(res.produced).toBe(0);
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('fires hard trigger: >60 uncompacted older than 12h', async () => {
    const old = new Date(Date.now() - COMPACTION_TRIGGERS.hard.oldestUncompactedAgeMs - 60_000);
    mocks.prisma.iMMessage.findMany.mockResolvedValue(
      Array.from({ length: 61 }, () => rawMsg({ createdAt: old })),
    );
    mocks.prisma.iMMessage.findFirst.mockResolvedValue({ createdAt: old });
    const res = await svc.maybeCompact(CONV);
    expect(res.produced).toBe(1);
  });

  it('fires char-budget trigger: >48KB uncompacted chars', async () => {
    const big = 'x'.repeat(5000);
    mocks.prisma.iMMessage.findMany.mockResolvedValue(
      Array.from({ length: 10 }, () => rawMsg({ content: big })),
    );
    const res = await svc.maybeCompact(CONV);
    expect(res.produced).toBe(1);
  });

  it('fires idle trigger: silent >=4h and >=30 pending', async () => {
    const old = new Date(Date.now() - COMPACTION_TRIGGERS.idle.silentForMs - 60_000);
    mocks.prisma.iMMessage.findMany.mockResolvedValue(
      Array.from({ length: 30 }, () => rawMsg({ createdAt: old, content: 'short' })),
    );
    mocks.prisma.iMMessage.findFirst.mockResolvedValue({ createdAt: old });
    const res = await svc.maybeCompact(CONV);
    expect(res.produced).toBe(1);
  });
});

describe('produceRangeSegment', () => {
  it('writes segment + reverse-index rows in one tx with seq = max+1', async () => {
    mocks.prisma.iMConversationCompressedSegment.aggregate.mockResolvedValue({ _max: { segmentSeq: 4 } });
    const rows = Array.from({ length: 10 }, (_, i) =>
      rawMsg({ id: `m-${i}`, createdAt: new Date(`2026-05-29T10:0${i}:00Z`) }),
    );
    mocks.prisma.iMMessage.findMany.mockResolvedValue(rows);

    const seg = await svc.produceRangeSegment(CONV);
    expect(seg).not.toBeNull();
    expect(segmentCreateArgs.data.segmentSeq).toBe(5);
    expect(segmentCreateArgs.data.segmentKind).toBe('range');
    expect(segmentCreateArgs.data.coversFromMessageId).toBe('m-0');
    expect(segmentCreateArgs.data.coversToMessageId).toBe('m-9');
    expect(segmentCreateArgs.data.producerModel).not.toBe('extractive-fallback');
    expect(segmentCreateArgs.data.summary).toContain('layout');
    // reverse index: one row per covered raw id
    expect(indexCreateArgs.data).toHaveLength(10);
    expect(indexCreateArgs.data[0]).toMatchObject({ segmentId: 'seg-new', segmentKind: 'range' });
    const covered = JSON.parse(segmentCreateArgs.data.coveredRawMessageIdsJson);
    expect(covered).toHaveLength(10);
  });

  it('returns null when there is nothing uncompacted', async () => {
    mocks.prisma.iMMessage.findMany.mockResolvedValue([]);
    const seg = await svc.produceRangeSegment(CONV);
    expect(seg).toBeNull();
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('concurrent P2002 on unique seq → no-op (returns null, no throw)', async () => {
    mocks.prisma.iMMessage.findMany.mockResolvedValue(
      Array.from({ length: 10 }, () => rawMsg()),
    );
    mocks.prisma.$transaction.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));
    const seg = await svc.produceRangeSegment(CONV);
    expect(seg).toBeNull();
  });

  it('LLM failure → extractive fallback, producerModel=extractive-fallback, no throw', async () => {
    mocks.callLLM.mockResolvedValue(null); // LLM unavailable
    mocks.prisma.iMMessage.findMany.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => rawMsg({ id: `m-${i}`, content: `Decision ${i} was made. extra.` })),
    );
    const seg = await svc.produceRangeSegment(CONV);
    expect(seg).not.toBeNull();
    expect(segmentCreateArgs.data.producerModel).toBe('extractive-fallback');
    expect(segmentCreateArgs.data.summary).toContain('extractive fallback');
  });

  it('LLM throwing is caught → extractive fallback, no throw', async () => {
    mocks.callLLM.mockRejectedValue(new Error('timeout'));
    mocks.prisma.iMMessage.findMany.mockResolvedValue(
      Array.from({ length: 10 }, () => rawMsg()),
    );
    const seg = await svc.produceRangeSegment(CONV);
    expect(seg).not.toBeNull();
    expect(segmentCreateArgs.data.producerModel).toBe('extractive-fallback');
  });

  it('metric-only rows (task.* / approval) bump salientFacts counts, not LLM body', async () => {
    const rows = [
      ...Array.from({ length: 8 }, (_, i) => rawMsg({ id: `t-${i}`, content: 'real content here.' })),
      rawMsg({ id: 'task-1', type: 'system_event', metadata: JSON.stringify({ kind: 'task.completed' }) }),
      rawMsg({ id: 'task-2', type: 'system_event', metadata: JSON.stringify({ kind: 'task.failed' }) }),
      rawMsg({ id: 'appr-1', type: 'system', metadata: JSON.stringify({ kind: 'awaiting_human_approval' }) }),
    ];
    mocks.prisma.iMMessage.findMany.mockResolvedValue(rows);
    const seg = await svc.produceRangeSegment(CONV);
    expect(seg).not.toBeNull();
    const sf = JSON.parse(segmentCreateArgs.data.salientFactsJson);
    expect(sf.taskEventCount).toBe(2);
    expect(sf.approvalCount).toBe(1);
    // The LLM prompt body must NOT include the metric-only rows.
    const prompt = mocks.callLLM.mock.calls[0][0] as string;
    expect(prompt).not.toContain('[task-1]');
    expect(prompt).not.toContain('[appr-1]');
    expect(prompt).toContain('[t-0]');
    // All 11 rows are still covered (range is contiguous).
    expect(JSON.parse(segmentCreateArgs.data.coveredRawMessageIdsJson)).toHaveLength(11);
  });
});

describe('regenerateSegment', () => {
  it('re-runs producer over old range and marks old supersededBy = new id', async () => {
    mocks.prisma.iMConversationCompressedSegment.findFirst.mockResolvedValue({
      id: 'seg-old',
      conversationId: CONV,
      segmentKind: 'range',
      segmentSeq: 3,
      coversFromMessageId: 'm-0',
      coversToMessageId: 'm-9',
    });
    // bounds lookup + range load
    mocks.prisma.iMMessage.findMany
      .mockResolvedValueOnce([
        { id: 'm-0', createdAt: new Date('2026-05-29T10:00:00Z') },
        { id: 'm-9', createdAt: new Date('2026-05-29T10:09:00Z') },
      ])
      .mockResolvedValueOnce(
        Array.from({ length: 10 }, (_, i) => rawMsg({ id: `m-${i}` })),
      );
    mocks.prisma.iMConversationCompressedSegment.aggregate.mockResolvedValue({ _max: { segmentSeq: 5 } });

    const fresh = await svc.regenerateSegment(CONV, 3);
    expect(fresh).not.toBeNull();
    expect(segmentCreateArgs.data.segmentSeq).toBe(6);
    expect(mocks.prisma.iMConversationCompressedSegment.update).toHaveBeenCalledWith({
      where: { id: 'seg-old' },
      data: { supersededBy: 'seg-new' },
    });
  });

  it('returns null when the target segment seq does not exist', async () => {
    mocks.prisma.iMConversationCompressedSegment.findFirst.mockResolvedValue(null);
    const fresh = await svc.regenerateSegment(CONV, 99);
    expect(fresh).toBeNull();
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('maybeCompact never throws', () => {
  it('swallows a DB read failure', async () => {
    mocks.prisma.iMMessage.findMany.mockRejectedValue(new Error('db down'));
    await expect(svc.maybeCompact(CONV)).resolves.toEqual({ produced: 0 });
  });
});
