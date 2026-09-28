// spec 11 T1-3 (2026-09-22, owner re-ruling) — empty_reply rotation threshold
// is 2, and the first (sub-threshold) empty reply is VISIBLE.
//
// 2.2.9 rotated on the first EMPTY. That assumed one empty reply is already
// strong evidence of a polluted transcript; in production the first EMPTY is
// often a transient upstream blip, and rotating on it throws away a healthy
// transcript the next turn would have reused. The new contract:
//
//   • 1st consecutive EMPTY → NO rotation, and one `empty_reply_observed`
//     system_event so the failed turn reaches the timeline explained;
//   • 2nd consecutive EMPTY → the NEXT turn mints a fresh session.
//
// Rotation is decided at the START of a turn from the accumulated streak, so
// "the second EMPTY rotates" is observed as: turns 1-2 reuse the mapped
// session, turn 3 mints a fresh one.
//
// Negative control / discrimination (this is the part that keeps the test from
// being an open-book exam):
//   a. one EMPTY → the next turn must NOT rotate. An implementation that still
//      rotates on the first EMPTY (i.e. the fix was cosmetic: the event was
//      added but the threshold stayed 1) fails here.
//   b. the sub-threshold turns must REUSE the very same session id, not mint a
//      fresh one "one beat later" — the assertion is on the session the turn
//      actually talked to, not on a counter.
//   c. threshold strength is pinned separately in session-health-persistence
//      (env override 1 → rotate on the first EMPTY; 3 → two EMPTYs are still
//      below the bar), which is what distinguishes a real numeric threshold
//      from a hardcoded one-turn delay.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/adapters/persistence/hermes/sessions-mapper.js', () => ({
  HermesSessionMapper: class {},
}));

let sseBehavior: (state?: { runId: string | null }) => Promise<Record<string, unknown>>;
vi.mock('../src/adapters/persistence/hermes/sessions-sse.js', () => ({
  consumeSessionsSse: vi.fn(async (_body: unknown, _task: unknown, state?: { runId: string | null }) =>
    sseBehavior(state),
  ),
}));

vi.mock('../src/daemon/memory/run-session-map.js', () => ({
  getRunSessionRegistry: () => null,
}));

import { dispatchViaSessions } from '../src/adapters/persistence/hermes/sessions-dispatcher.js';
import { setHermesCloudIO } from '../src/adapters/persistence/hermes/cloud-io.js';
import {
  __resetSessionHealth,
  emptyRotateThreshold,
  shouldRotate,
  sessionKeyOf,
} from '../src/adapters/persistence/hermes/session-health.js';
import type { TaskInput } from '../src/adapters/contract.js';

const SESSION_KEY = sessionKeyOf('cv_1', 'u_engineer');

function makeTask(): TaskInput {
  return {
    taskId: 'run_t1_3',
    prompt: 'ignored',
    currentPrompt: 'hello',
    conversationType: 'direct',
    conversationId: 'cv_1',
    profileAgentUsername: 'engineer',
    profileAgentImUserId: 'u_engineer',
    metadata: { conversationId: 'cv_1', agentImUserId: 'u_engineer', workspaceId: 'ws_1' },
  } as unknown as TaskInput;
}

const EXISTING = {
  conversationId: 'cv_1',
  agentImUserId: 'u_engineer',
  hermesSessionId: 'hs_existing',
  hermesSessionKey: null,
};
const FRESH = {
  conversationId: 'cv_1',
  agentImUserId: 'u_engineer',
  hermesSessionId: 'hs_fresh',
  hermesSessionKey: null,
};

let getSpy: ReturnType<typeof vi.fn>;
let createSpy: ReturnType<typeof vi.fn>;
/** Session ids the dispatcher actually talked to, in turn order. */
let touchedSessions: string[];

const postSystemEvent = vi.fn(async (_c: string, _content: string, _meta: Record<string, unknown>) => {});

function makeDeps() {
  getSpy = vi.fn(() => EXISTING);
  createSpy = vi.fn(async () => FRESH);
  return {
    baseUrl: 'http://127.0.0.1:9000',
    apiKey: 'test-key',
    profileName: 'engineer',
    serviceId: 'svc_test',
    model: 'hermes-test',
    capabilities: {},
    instructions: 'You are a test agent.',
    idempotencyKey: 'idem-1',
    sessionMapper: { get: getSpy, createForConversation: createSpy, invalidate: vi.fn() },
  } as unknown as Parameters<typeof dispatchViaSessions>[1];
}

/** The SSE stream completed cleanly with ZERO assistant content. */
function emptyReply() {
  sseBehavior = async () => ({ output: '', runId: 'run_empty', approvalRequested: false });
}

beforeEach(() => {
  touchedSessions = [];
  postSystemEvent.mockClear();
  __resetSessionHealth();
  emptyReply();
  setHermesCloudIO({ readRecentMessages: async () => [], postSystemEvent });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes('/chat/stream')) {
      const sid = decodeURIComponent((url.split('/api/sessions/')[1] ?? '').split('/')[0] ?? '');
      touchedSessions.push(sid);
      return new Response(new ReadableStream(), { status: 200 });
    }
    if (url.includes('/messages')) {
      // Nothing recoverable from the transcript tail → genuine empty_reply.
      return new Response(JSON.stringify({ object: 'list', data: [] }), {
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
  __resetSessionHealth();
});

describe('spec 11 T1-3 — empty_reply rotation threshold', () => {
  it('oracle: first EMPTY does not rotate and is made visible; second EMPTY arms the rotation', async () => {
    const deps = makeDeps();

    // Turn 1 — streak 1: still under the bar. No rotation, one visible row.
    const t1 = await dispatchViaSessions(makeTask(), deps);
    expect(t1.result.ok).toBe(false);
    expect(t1.result.error?.code).toBe('empty_reply');
    expect(createSpy).not.toHaveBeenCalled();
    expect(touchedSessions).toEqual(['hs_existing']);
    expect(postSystemEvent).toHaveBeenCalledTimes(1);
    expect(postSystemEvent.mock.calls[0]![0]).toBe('cv_1');
    expect(postSystemEvent.mock.calls[0]![1]).toBe(
      '本轮回复为空（连续第 1 次）：已记录，连续空回复达到阈值时将自动重建上下文窗口后重试。',
    );
    expect(postSystemEvent.mock.calls[0]![2]).toMatchObject({
      kind: 'empty_reply_observed',
      // Same enum the rotation row will carry (RotationReason) — the two rows
      // are one story, not two unrelated notices.
      reason: 'empty_reply_streak',
      emptyReplyStreak: 1,
      rotateThreshold: 2,
      hermesSessionId: 'hs_existing',
    });

    // Turn 2 — streak was 1 at turn start, so this turn REUSES the same
    // session (not a "fresh one one beat later"), and this EMPTY reaches the
    // threshold: it must NOT post a second sub-threshold row.
    const t2 = await dispatchViaSessions(makeTask(), deps);
    expect(t2.result.error?.code).toBe('empty_reply');
    expect(createSpy).not.toHaveBeenCalled();
    expect(touchedSessions).toEqual(['hs_existing', 'hs_existing']);
    expect(postSystemEvent).toHaveBeenCalledTimes(1);

    // Turn 3 — streak 2 ≥ threshold → mint a FRESH session.
    sseBehavior = async () => ({ output: 'the answer', runId: 'run_ok', approvalRequested: false });
    const t3 = await dispatchViaSessions(makeTask(), deps);
    expect(t3.result.ok).toBe(true);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(touchedSessions).toEqual(['hs_existing', 'hs_existing', 'hs_fresh']);
    // The rotation itself posts its own context_rebuilt row (S5 §3.4-4) plus
    // the one observation row from turn 1 — nothing else.
    expect(postSystemEvent).toHaveBeenCalledTimes(2);
    expect(postSystemEvent.mock.calls[1]![2]).toMatchObject({
      kind: 'context_rebuilt',
      reason: 'empty_reply_streak',
    });
  }, 20_000);

  it('negative control: a single EMPTY leaves the rotation semantics at "do not rotate"', async () => {
    const deps = makeDeps();

    const t1 = await dispatchViaSessions(makeTask(), deps);
    expect(t1.result.error?.code).toBe('empty_reply');

    // The discriminating assertion: the next turn must not rotate. A build
    // that only added the visibility row while keeping threshold=1 fails here.
    sseBehavior = async () => ({ output: 'the answer', runId: 'run_ok', approvalRequested: false });
    const t2 = await dispatchViaSessions(makeTask(), deps);
    expect(t2.result.ok).toBe(true);
    expect(createSpy).not.toHaveBeenCalled();
    expect(touchedSessions).toEqual(['hs_existing', 'hs_existing']);
    expect(getSpy).toHaveBeenCalledWith('cv_1', 'u_engineer');

    // ...and the streak really is below the bar rather than the rotation being
    // skipped for some other reason.
    expect(emptyRotateThreshold()).toBe(2);
    expect(shouldRotate(SESSION_KEY)).toBe(false);
  }, 20_000);

  it('boundary: a healthy turn resets the streak, so the next EMPTY is sub-threshold again', async () => {
    const deps = makeDeps();

    await dispatchViaSessions(makeTask(), deps); // streak 1
    sseBehavior = async () => ({ output: 'a real answer', runId: 'run_ok', approvalRequested: false });
    await dispatchViaSessions(makeTask(), deps); // recordSuccess → streak cleared
    expect(shouldRotate(SESSION_KEY)).toBe(false);

    emptyReply();
    const t3 = await dispatchViaSessions(makeTask(), deps); // streak 1 again
    expect(t3.result.error?.code).toBe('empty_reply');
    expect(postSystemEvent).toHaveBeenCalledTimes(2); // two separate streaks
    expect(postSystemEvent.mock.calls[1]![2]).toMatchObject({
      kind: 'empty_reply_observed',
      emptyReplyStreak: 1,
    });

    sseBehavior = async () => ({ output: 'the answer', runId: 'run_ok', approvalRequested: false });
    await dispatchViaSessions(makeTask(), deps);
    expect(createSpy).not.toHaveBeenCalled(); // one EMPTY per streak never rotates
  }, 20_000);

  it('negative control: the visibility post is skipped when the cloud IO seam is unwired', async () => {
    setHermesCloudIO(null);
    const deps = makeDeps();

    const t1 = await dispatchViaSessions(makeTask(), deps);

    expect(t1.result.error?.code).toBe('empty_reply');
    expect(postSystemEvent).not.toHaveBeenCalled();
    expect(shouldRotate(SESSION_KEY)).toBe(false);
    expect(touchedSessions).toEqual(['hs_existing']);
  }, 20_000);
});
