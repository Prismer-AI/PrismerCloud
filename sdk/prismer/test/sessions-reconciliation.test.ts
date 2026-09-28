// S5 §3.4-1b (docs/organization/specs/05 Task 2) — post-turn continuity
// reconciliation between the hermes transcript and the cloud projection.
//
// The detector under test: after a REUSED turn, does the live transcript still
// hold the anchor (`metadata.taskId`) of our newest agent_reply? If not, the
// two stores have diverged silently — post ONE visibility event and drop the
// mapping so the next turn rotates and reseeds.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// HermesSessionMapper transitively imports better-sqlite3 via LocalDb.
vi.mock('../src/adapters/persistence/hermes/sessions-mapper.js', () => ({
  HermesSessionMapper: class {},
}));

import {
  maybeReconcileSessionContinuity,
  bumpReconcileCounter,
  __resetReconcileState,
} from '../src/adapters/persistence/hermes/sessions-dispatcher.js';
import { setHermesCloudIO } from '../src/adapters/persistence/hermes/cloud-io.js';

const TASK_ID = 'run_recon_anchor_1';
const CONV = 'cv_1';
const AGENT = 'u_agent';
const SESSION = 'hs_1';

const invalidateSpy = vi.fn();
const postSystemEvent = vi.fn(async (_c: string, _content: string, _meta: Record<string, unknown>) => {});

const deps = {
  baseUrl: 'http://127.0.0.1:9000',
  apiKey: 'k',
  sessionMapper: { invalidate: invalidateSpy },
} as unknown as Parameters<typeof maybeReconcileSessionContinuity>[0];

/** Requests seen by the fetch stub. */
let requests: string[] = [];
/** Transcript rows served for SESSION (gateway order). */
let transcriptRows: Array<Record<string, unknown>> = [];
/** Conversation rows served by the cloud IO seam. */
let recentMessages: Array<Record<string, unknown>> = [];

function agentReplyRow(taskId: string): Record<string, unknown> {
  return {
    id: 'm_reply',
    senderId: AGENT,
    type: 'text',
    content: '上一条回复',
    metadata: JSON.stringify({ kind: 'agent_reply', taskId }),
    createdAt: '2026-09-22T00:00:00.000Z',
  };
}

/** The anchor as it appears in the XML body we sent — same shape as production. */
function anchoredUserRow(taskId: string): Record<string, unknown> {
  return {
    role: 'user',
    content: `<conversation_context>…<run_id>${taskId}</run_id>…</conversation_context>`,
    timestamp: 1727000000,
  };
}

beforeEach(() => {
  requests = [];
  transcriptRows = [];
  recentMessages = [agentReplyRow(TASK_ID)];
  invalidateSpy.mockClear();
  postSystemEvent.mockClear();
  __resetReconcileState();
  setHermesCloudIO({
    readRecentMessages: async (_conversationId: string, _limit: number) =>
      recentMessages as never,
    postSystemEvent,
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.includes('/messages')) {
      return new Response(JSON.stringify({ object: 'list', data: transcriptRows }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200 });
  });
});

afterEach(() => {
  setHermesCloudIO(null);
  vi.restoreAllMocks();
});

describe('S5 §3.4-1b transcript reconciliation', () => {
  it('posts exactly one system_event and invalidates the mapping on transcript misalignment', async () => {
    transcriptRows = [{ role: 'user', content: '别的会话的行，不含本轮 anchor', timestamp: 1 }];

    await maybeReconcileSessionContinuity(deps, CONV, AGENT, SESSION, null);

    expect(postSystemEvent).toHaveBeenCalledTimes(1);
    expect(postSystemEvent.mock.calls[0]![0]).toBe(CONV);
    expect(postSystemEvent.mock.calls[0]![1]).toContain('错位');
    expect(postSystemEvent.mock.calls[0]![2]).toMatchObject({
      kind: 'context_continuity_reconciled',
      hermesSessionId: SESSION,
      missingTaskId: TASK_ID,
    });
    expect(invalidateSpy).toHaveBeenCalledWith(CONV, AGENT, SESSION);

    // Re-entering with the same session + same missing anchor is silent. Note
    // WHICH guard fires: the 30-minute MIN_INTERVAL window (set by the call
    // above) short-circuits before any read. The `sessionId:anchor` LRU is the
    // second, independent guard — it is what keeps it exactly-once once the
    // interval window has elapsed but the mismatch is still unfixed.
    await maybeReconcileSessionContinuity(deps, CONV, AGENT, SESSION, null);
    expect(postSystemEvent).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the transcript tail aligns with our last agent_reply', async () => {
    transcriptRows = [
      anchoredUserRow(TASK_ID),
      { role: 'assistant', content: '本轮的答案', timestamp: 1727000010 },
    ];

    await maybeReconcileSessionContinuity(deps, CONV, AGENT, SESSION, null);

    expect(postSystemEvent).not.toHaveBeenCalled();
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('treats an anchor with no assistant answer after it as a mismatch', async () => {
    transcriptRows = [
      anchoredUserRow(TASK_ID),
      { role: 'assistant', content: '   ', timestamp: 1727000010 },
    ];

    await maybeReconcileSessionContinuity(deps, CONV, AGENT, SESSION, null);

    expect(postSystemEvent).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
  });

  // ── I-3 (owner ruling) — the anchor must be OUR turn. A conversation can
  // carry agent_reply rows from several agents (multi-agent threads), and
  // anchoring on someone else's turn reports a mismatch that our transcript
  // never had a chance to hold: a spurious rotation + a misleading notice.

  it("ignores another agent's agent_reply when choosing our anchor (I-3)", async () => {
    // The newest agent_reply in the window belongs to a DIFFERENT agent.
    recentMessages = [{ ...agentReplyRow(TASK_ID), senderId: 'u_someone_else' }];
    transcriptRows = [{ role: 'user', content: '别的行，不含本轮 anchor', timestamp: 1 }];

    await maybeReconcileSessionContinuity(deps, CONV, AGENT, SESSION, null);

    expect(postSystemEvent).not.toHaveBeenCalled();
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("anchors on OUR reply when another agent's sits newer in the window (I-3)", async () => {
    recentMessages = [
      agentReplyRow(TASK_ID), // ours, older
      { ...agentReplyRow('run_other_agent_9'), senderId: 'u_someone_else' }, // theirs, newest
    ];
    transcriptRows = [
      anchoredUserRow(TASK_ID),
      { role: 'assistant', content: '本轮的答案', timestamp: 1727000010 },
    ];

    await maybeReconcileSessionContinuity(deps, CONV, AGENT, SESSION, null);

    // Aligned on OUR anchor → silent. (Anchoring on theirs would report a
    // mismatch, since our transcript never held their turn.)
    expect(postSystemEvent).not.toHaveBeenCalled();
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('skips reconcile before N=5 turns', async () => {
    transcriptRows = [{ role: 'user', content: '不含 anchor', timestamp: 1 }];

    bumpReconcileCounter(CONV, AGENT);
    bumpReconcileCounter(CONV, AGENT);
    bumpReconcileCounter(CONV, AGENT);
    await maybeReconcileSessionContinuity(deps, CONV, AGENT, SESSION, null);

    expect(requests).toHaveLength(0);
    expect(postSystemEvent).not.toHaveBeenCalled();
  });

  it('skips reconcile inside the 30min window even at the Nth turn', async () => {
    transcriptRows = [{ role: 'user', content: '不含 anchor', timestamp: 1 }];
    await maybeReconcileSessionContinuity(deps, CONV, AGENT, SESSION, null);
    expect(postSystemEvent).toHaveBeenCalledTimes(1);
    const readsAfterFirst = requests.length;

    // Advance the turn counter to the next multiple; the interval gate must
    // short-circuit BEFORE any read (counters alone would let it through).
    for (let i = 0; i < 5; i++) bumpReconcileCounter(CONV, AGENT);
    transcriptRows = [anchoredUserRow(TASK_ID), { role: 'assistant', content: '答案', timestamp: 2 }];
    await maybeReconcileSessionContinuity(deps, CONV, AGENT, SESSION, null);

    expect(requests).toHaveLength(readsAfterFirst);
    expect(postSystemEvent).toHaveBeenCalledTimes(1);
  });

  it('no-ops when the cloud IO seam is unwired (null)', async () => {
    setHermesCloudIO(null);
    transcriptRows = [{ role: 'user', content: '不含 anchor', timestamp: 1 }];

    await expect(
      maybeReconcileSessionContinuity(deps, CONV, AGENT, SESSION, null),
    ).resolves.toBeUndefined();
    expect(requests).toHaveLength(0);
    expect(postSystemEvent).not.toHaveBeenCalled();
  });

  it('does nothing when the window holds no agent_reply of ours', async () => {
    recentMessages = [
      { id: 'm1', senderId: 'human', type: 'text', content: 'hi', metadata: '{}', createdAt: '' },
    ];
    transcriptRows = [{ role: 'user', content: '不含 anchor', timestamp: 1 }];

    await maybeReconcileSessionContinuity(deps, CONV, AGENT, SESSION, null);

    expect(postSystemEvent).not.toHaveBeenCalled();
  });

  it('swallows a failing cloud post instead of throwing', async () => {
    transcriptRows = [{ role: 'user', content: '不含 anchor', timestamp: 1 }];
    postSystemEvent.mockRejectedValueOnce(new Error('cloud down'));

    await expect(
      maybeReconcileSessionContinuity(deps, CONV, AGENT, SESSION, null),
    ).resolves.toBeUndefined();
  });
});
