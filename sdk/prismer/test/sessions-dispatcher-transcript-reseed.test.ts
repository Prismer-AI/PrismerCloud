// S5 §3.4-1a (docs/organization/specs/05 Task 1) — rotation reseed.
//
// Failure shape (A1/A2): a rotation (404 session_not_found, S10 empty-reply
// streak, interrupt) mints a FRESH hermes session whose transcript is empty.
// The FULL seed that follows carries only the cloud envelope (recent 60 IM
// rows + compressed segments). When the envelope itself is thin/degraded the
// previous exchange is simply absent — the agent answers the second message
// of a DM with no idea what the first one was.
//
// Contract under test: on rotation, read the OLD session's transcript tail
// from the gateway and fold it into the new session's FULL seed.
//
// fixture shape copied from sessions-dispatcher-empty-reply.test.ts.

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

import {
  dispatchViaSessions,
  maybeReconcileSessionContinuity,
  bumpReconcileCounter,
  __resetReconcileState,
} from '../src/adapters/persistence/hermes/sessions-dispatcher.js';
import { setHermesCloudIO } from '../src/adapters/persistence/hermes/cloud-io.js';
import { __resetSessionHealth } from '../src/adapters/persistence/hermes/session-health.js';
import type { TaskInput } from '../src/adapters/contract.js';

const TASK_ID = 'run_t5ls4nzr1hdxmjr7trldf';

function makeTask(): TaskInput {
  return {
    taskId: TASK_ID,
    prompt: 'ignored',
    currentPrompt: '第二轮问题',
    conversationType: 'direct',
    conversationId: 'cv_1',
    profileAgentUsername: 'engineer',
    profileAgentImUserId: 'u_engineer',
    metadata: { conversationId: 'cv_1', agentImUserId: 'u_engineer', workspaceId: 'ws_1' },
  } as unknown as TaskInput;
}

/**
 * Dep bag whose mapper resolves to `mappedSessionId`; rotation mints `hs_new`.
 *
 * `live` is MUTABLE and `invalidate` really deletes the row, matching
 * `HermesSessionMapper.invalidate` (sessions-mapper.ts:114 — a DELETE, not a
 * flag). A no-op stub silently hid a production wire: `get()` kept returning the
 * dead session on the 404 retry, so the `!rotationSource && sessionKey` branch
 * re-derived `hs_dead` from the mapper and the `previousSession` argument passed
 * into the retry (sessions-dispatcher.ts:1361-1364, the 404 handoff) could be
 * deleted with every test still green.
 */
function depsWithMapperReturning(mappedSessionId: string | null) {
  let live = mappedSessionId;
  return {
    baseUrl: 'http://127.0.0.1:9000',
    apiKey: 'test-key',
    profileName: 'engineer',
    serviceId: 'svc_test',
    model: 'hermes-test',
    capabilities: {},
    instructions: 'You are a test agent.',
    idempotencyKey: 'idem-1',
    sessionMapper: {
      get: () =>
        live
          ? {
              conversationId: 'cv_1',
              agentImUserId: 'u_engineer',
              hermesSessionId: live,
              hermesSessionKey: null,
            }
          : null,
      createForConversation: async () => ({
        conversationId: 'cv_1',
        agentImUserId: 'u_engineer',
        hermesSessionId: 'hs_new',
        hermesSessionKey: null,
      }),
      // Real DELETE semantics (see the doc comment above) — not a no-op.
      invalidate: vi.fn(() => {
        live = null;
      }),
    },
  } as unknown as Parameters<typeof dispatchViaSessions>[1];
}

/** Requests seen by the fetch stub, in order. */
let requests: Array<{ url: string; method: string }> = [];
/** chat/stream POST bodies, in hop order. */
let chatBodies: Array<Record<string, unknown>> = [];
/**
 * Gateway transcript rows per session id. Served OLDEST-FIRST: `order=latest`
 * pages back from the newest but returns the page in chronological order
 * (v2026.9.14, hermes_state_messages.py:779 + :817-818). Fixtures below
 * follow that order — a newest-first fixture silently encodes the inverted
 * assumption that N-1 fixed.
 */
let transcriptBySession: Record<string, Array<Record<string, unknown>>> = {};
/** Sessions that answer 404 session_not_found on chat/stream. */
let deadSessions: Set<string> = new Set();

/** The SECOND hop's body — the request that reached a live session. */
function lastChatBody(): Record<string, unknown> {
  const b = chatBodies[chatBodies.length - 1];
  if (!b) throw new Error('no chat/stream POST recorded');
  return b;
}
function chatBodyMessage(): string {
  const m = lastChatBody().message;
  return typeof m === 'string' ? m : JSON.stringify(m);
}

function sessionIdFrom(url: string): string {
  const tail = url.split('/api/sessions/')[1] ?? '';
  return decodeURIComponent(tail.split('/')[0] ?? '');
}

/**
 * Let a fire-and-forget chain run to completion before asserting on it.
 * `vi.waitFor` is used where a call MUST happen; `settle` is the converse —
 * it bounds the work for NEGATIVE assertions (`not.toHaveBeenCalled`), which
 * would otherwise pass vacuously if sampled too early. 50ms is far more than
 * the stubbed chain needs (all IO here is in-process).
 */
function settle(ms = 50): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

beforeEach(() => {
  requests = [];
  chatBodies = [];
  transcriptBySession = {};
  deadSessions = new Set();
  sseBehavior = async () => ({ output: 'ok 回复', runId: 'run_new', approvalRequested: false });
  __resetSessionHealth();
  __resetReconcileState();
  setHermesCloudIO(null);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    requests.push({ url, method });
    if (url.includes('/chat/stream')) {
      if (init?.body) {
        try {
          chatBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        } catch {
          chatBodies.push({});
        }
      }
      if (deadSessions.has(sessionIdFrom(url))) {
        return new Response(JSON.stringify({ error: { code: 'session_not_found' } }), { status: 404 });
      }
      return new Response(new ReadableStream(), { status: 200 });
    }
    if (url.includes('/messages')) {
      return new Response(JSON.stringify({ object: 'list', data: transcriptBySession[sessionIdFrom(url)] ?? [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/stop')) return new Response('{}', { status: 404 });
    return new Response('{}', { status: 200 });
  });
});

afterEach(() => {
  setHermesCloudIO(null);
  vi.restoreAllMocks();
});

describe('rotation reseed reads previous session transcript tail (S5 §3.4-1)', () => {
  it('seeds transcript tail rows into the new-session body after a 404 rotation', async () => {
    // First hop 404s (old session dead server-side) → invalidate → re-enter
    // with forceFreshSession → new session seeded with the full envelope.
    // The OLD session's transcript holds the previous exchange, which the
    // envelope alone cannot be trusted to carry.
    deadSessions = new Set(['hs_dead']);
    transcriptBySession = {
      hs_dead: [
        // Oldest-first — the order the pinned gateway serves (see the
        // transcriptBySession doc above).
        {
          role: 'user',
          content: `<conversation_context>…anchor ${TASK_ID}…上一问：预算怎么批？</conversation_context>`,
          timestamp: 1727000000,
        },
        { role: 'assistant', content: '上一答：预算走 OKR 发布档审批。', timestamp: 1727000060 },
      ],
    };

    const outcome = await dispatchViaSessions(makeTask(), depsWithMapperReturning('hs_dead'));

    expect(outcome.result.ok).toBe(true);
    const msg = chatBodyMessage();
    expect(msg).toContain('上一答：预算走 OKR 发布档审批。');
    expect(msg).toContain('transcript_continuity');
    // The reseed probe went to the DEAD session, not the fresh one.
    expect(requests.some((r) => r.url.includes('/api/sessions/hs_dead/messages'))).toBe(true);
  });

  it('does NOT seed when there is no previous session (first turn)', async () => {
    // No mapper row → first turn on a brand-new conversation; there is no
    // transcript to read and the probe must not even be attempted.
    transcriptBySession = {
      hs_new: [{ role: 'assistant', content: '不应出现的行', timestamp: 1727000060 }],
    };

    const outcome = await dispatchViaSessions(makeTask(), depsWithMapperReturning(null));

    expect(outcome.result.ok).toBe(true);
    expect(chatBodyMessage()).not.toContain('transcript_continuity');
    expect(requests.some((r) => r.url.includes('/messages'))).toBe(false);
  });

  it('dedupes rows already present in envelope recent', async () => {
    deadSessions = new Set(['hs_dead']);
    transcriptBySession = {
      hs_dead: [
        { role: 'user', content: '已在信封里的提问', timestamp: 1727000000 },
        { role: 'assistant', content: '已在信封里的回复', timestamp: 1727000060 },
      ],
    };
    const task = makeTask();
    (task as unknown as { contextEnvelope: unknown }).contextEnvelope = {
      conversationType: 'direct',
      conversationId: 'cv_1',
      participants: [],
      recent: [
        { sender: 'winshare', role: 'human', content: '已在信封里的提问', createdAt: '2026-09-22T00:00:00.000Z' },
        { sender: 'engineer', role: 'agent', content: '已在信封里的回复', createdAt: '2026-09-22T00:00:01.000Z' },
      ],
      compressedSegments: [],
      quotes: [],
    };

    const outcome = await dispatchViaSessions(task, depsWithMapperReturning('hs_dead'));

    expect(outcome.result.ok).toBe(true);
    const msg = chatBodyMessage();
    // The envelope already carries both rows — the reseed must not re-inject
    // (that would bill the same tokens twice).
    expect(msg).not.toContain('transcript_continuity');
    expect(msg.match(/已在信封里的回复/g)?.length).toBe(1);
  });

  it('seeds the transcript tail on the ENVELOPE path too (the production path)', async () => {
    // REGRESSION GUARD (coverage gap found by mutation testing): every other
    // positive case in this file drives `makeTask()`, which carries no
    // `contextEnvelope` — so they exercise the legacy `composeConversationContextXml`
    // branch while `FF_CONTEXT_ENVELOPE_ENABLED` is ON in every real deployment.
    // Deleting the `transcriptTail` pass-through at sessions-dispatcher.ts:1270
    // left the whole suite green, i.e. the shipped path was unverified. This
    // case pins it: same rotation, same transcript, envelope-typed task.
    deadSessions = new Set(['hs_dead']);
    transcriptBySession = {
      hs_dead: [
        { role: 'user', content: '上一问：预算怎么批？', timestamp: 1727000000 },
        { role: 'assistant', content: '上一答：预算走 OKR 发布档审批。', timestamp: 1727000060 },
      ],
    };
    const task = makeTask();
    (task as unknown as { contextEnvelope: unknown }).contextEnvelope = {
      conversationType: 'direct',
      conversationId: 'cv_1',
      participants: [],
      recent: [
        {
          sender: 'winshare',
          role: 'human',
          content: '信封里的另一行历史',
          createdAt: '2026-09-22T00:00:00.000Z',
        },
      ],
      compressedSegments: [],
      quotes: [],
    };

    const outcome = await dispatchViaSessions(task, depsWithMapperReturning('hs_dead'));

    expect(outcome.result.ok).toBe(true);
    const msg = chatBodyMessage();
    // Envelope path really ran (its own recent row is present)…
    expect(msg).toContain('信封里的另一行历史');
    // …and the reseeded tail rides along with it.
    expect(msg).toContain('上一答：预算走 OKR 发布档审批。');
    expect(msg).toContain('transcript_continuity');
  });

  it('enforces row/total char caps, dropping the oldest rows first', async () => {
    deadSessions = new Set(['hs_dead']);
    // 8 rows x ~1000 chars = ~8000 chars, over RESEED_TOTAL_CHAR_CAP (6000).
    // Oldest-first, the order the pinned gateway actually serves: `order=latest`
    // pages back from the newest but RETURNS chronological order
    // (v2026.9.14, hermes_state_messages.py:779 + :817-818).
    transcriptBySession = {
      hs_dead: Array.from({ length: 8 }, (_, i) => {
        const age = i; // i=0 → oldest tag r0, i=7 → newest
        return {
          role: age % 2 === 0 ? 'user' : 'assistant',
          content: `TAILROW_${age}_${'x'.repeat(990)}`,
          timestamp: 1727000000 + age * 60,
        };
      }),
    };

    const outcome = await dispatchViaSessions(makeTask(), depsWithMapperReturning('hs_dead'));

    expect(outcome.result.ok).toBe(true);
    const msg = chatBodyMessage();
    const injected = msg.match(/TAILROW_(\d)_/g) ?? [];
    const totalInjected = injected.reduce((n, tag) => n + tag.length + 990 + 40, 0);
    // Newest survives, oldest is dropped once the cap is hit.
    expect(msg).toContain('TAILROW_7_');
    expect(msg).not.toContain('TAILROW_0_');
    expect(totalInjected).toBeLessThanOrEqual(6000 + 8 * 60);
  });

  // N-1 NEGATIVE CONTROL — the cap fix must drop ONLY what exceeds the cap.
  // A pass-through that mis-handles order in the other direction (or a fix that
  // drops too eagerly) would still satisfy the caps case above but fail here.
  it('NEGATIVE CONTROL: within the caps nothing is dropped and order survives', async () => {
    deadSessions = new Set(['hs_dead']);
    // 3 short rows, far under both caps.
    transcriptBySession = {
      hs_dead: [
        { role: 'user', content: 'TAILSHORT_0_提问', timestamp: 1727000000 },
        { role: 'assistant', content: 'TAILSHORT_1_回答', timestamp: 1727000060 },
        { role: 'user', content: 'TAILSHORT_2_追问', timestamp: 1727000120 },
      ],
    };

    await dispatchViaSessions(makeTask(), depsWithMapperReturning('hs_dead'));

    const msg = chatBodyMessage();
    for (const tag of ['TAILSHORT_0_', 'TAILSHORT_1_', 'TAILSHORT_2_']) {
      expect(msg).toContain(tag);
    }
    // Chronological, as served: the oldest row renders before the newest.
    expect(msg.indexOf('TAILSHORT_0_')).toBeLessThan(msg.indexOf('TAILSHORT_2_'));
  });

  it('NEGATIVE CONTROL: a failing transcript read does not block the dispatch', async () => {
    deadSessions = new Set(['hs_dead']);
    // Make the reseed probe fail: 500 on this session's /messages.
    const inner = vi.mocked(globalThis.fetch).getMockImplementation();
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/api/sessions/hs_dead/messages')) {
        return new Response('boom', { status: 500 });
      }
      return inner ? inner(input, init) : new Response('{}', { status: 200 });
    });

    const outcome = await dispatchViaSessions(makeTask(), depsWithMapperReturning('hs_dead'));

    expect(outcome.result.ok).toBe(true);
    expect(chatBodyMessage()).not.toContain('transcript_continuity');
  });

  // ── M-1 (review) — the three tuning constants had no assertion, and the caps
  // case could not discriminate `RESEED_TAIL_ROWS` at all because the fetch stub
  // answered whatever was asked for. Each case below is tied to one constant and
  // was confirmed to go red under a single-constant mutation.

  it('pins RESEED_TAIL_ROWS / order on the read-back request', async () => {
    deadSessions = new Set(['hs_dead']);
    transcriptBySession = {
      hs_dead: [{ role: 'assistant', content: '唯一一行', timestamp: 1727000060 }],
    };

    await dispatchViaSessions(makeTask(), depsWithMapperReturning('hs_dead'));

    const read = requests.find((r) => r.url.includes('/api/sessions/hs_dead/messages'));
    expect(read?.url).toContain('limit=8');
    expect(read?.url).toContain('order=latest');
    // The probe must target the DEAD session — reading the fresh one is a no-op.
    expect(read?.url).toContain('hs_dead');
  });

  it('truncates a row past RESEED_ROW_CHAR_CAP and marks the cut', async () => {
    deadSessions = new Set(['hs_dead']);
    // 1800 chars: past the 1500 row cap, well under the 6000 total cap, so the
    // ONLY thing that can clip it is the per-row cap.
    transcriptBySession = {
      hs_dead: [{ role: 'assistant', content: 'L'.repeat(1_800), timestamp: 1727000060 }],
    };

    await dispatchViaSessions(makeTask(), depsWithMapperReturning('hs_dead'));

    const msg = chatBodyMessage();
    expect(msg).toContain('…[truncated]');
    expect(msg).toContain('L'.repeat(1_500)); // the kept prefix is exactly the cap
    expect(msg).not.toContain('L'.repeat(1_501)); // nothing past the cap survives
  });

  it('dedupes a row only when the first RESEED_DEDUP_PREFIX_CHARS chars match an envelope row', async () => {
    deadSessions = new Set(['hs_dead']);
    const shared = 'A'.repeat(120);
    // Two transcript rows with two matching envelope rows: the first agrees for
    // ≥120 chars (duplicate → must not be re-billed), the second diverges at
    // char 60 (distinct → must ride the seed).
    transcriptBySession = {
      hs_dead: [
        { role: 'user', content: `${'B'.repeat(60)}ROW_DIVERGES_Y`, timestamp: 1727000000 },
        { role: 'assistant', content: `${shared}ROW_SUFFIX_ONLY`, timestamp: 1727000060 },
      ],
    };
    const task = makeTask();
    (task as unknown as { contextEnvelope: unknown }).contextEnvelope = {
      conversationType: 'direct',
      conversationId: 'cv_1',
      participants: [],
      recent: [
        {
          sender: 'winshare',
          role: 'human',
          content: `${shared}ENVELOPE_SUFFIX_ONLY`,
          createdAt: '2026-09-22T00:00:00.000Z',
        },
        {
          sender: 'winshare',
          role: 'human',
          content: `${'B'.repeat(60)}ENVELOPE_DIVERGES_X`,
          createdAt: '2026-09-22T00:00:01.000Z',
        },
      ],
      compressedSegments: [],
      quotes: [],
    };

    await dispatchViaSessions(task, depsWithMapperReturning('hs_dead'));

    const msg = chatBodyMessage();
    expect(msg).not.toContain('ROW_SUFFIX_ONLY');
    expect(msg).toContain('ROW_DIVERGES_Y');
  });

  // I-1 NEGATIVE CONTROL — the dedup predicate is literal equality of the two
  // 120-char slices, not a bidirectional prefix match. Under the old predicate
  // a SHORT envelope row swallowed any transcript row that merely STARTED with
  // it (and vice versa), silently dropping a real exchange from the seed.
  it('NEGATIVE CONTROL: a short envelope row no longer swallows a longer transcript row (I-1)', async () => {
    deadSessions = new Set(['hs_dead']);
    transcriptBySession = {
      hs_dead: [
        {
          role: 'assistant',
          content: '好，预算走 OKR 发布档审批，我下周一给你结论。',
          timestamp: 1727000060,
        },
      ],
    };
    const task = makeTask();
    (task as unknown as { contextEnvelope: unknown }).contextEnvelope = {
      conversationType: 'direct',
      conversationId: 'cv_1',
      participants: [],
      recent: [
        {
          sender: 'winshare',
          role: 'human',
          content: '好', // a strict prefix of the transcript row, but a different message
          createdAt: '2026-09-22T00:00:00.000Z',
        },
      ],
      compressedSegments: [],
      quotes: [],
    };

    await dispatchViaSessions(task, depsWithMapperReturning('hs_dead'));

    const msg = chatBodyMessage();
    // Not a duplicate → the row must ride the seed (picked = 1).
    expect(msg).toContain('我下周一给你结论');
    expect(msg).toContain('transcript_continuity');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// I-2 (review) — the post-turn reconcile TRIGGER had no dispatcher-level
// coverage. `maybeReconcileSessionContinuity` was unit-tested directly, but
// nothing asserted that a settled turn actually reaches it — mutating the
// `!sessionIsNew` gate at sessions-dispatcher.ts:1418 kept every test in this
// file green. The stub's now-real `invalidate` (see depsWithMapperReturning) is
// what makes the REUSED case below genuinely reused rather than accidentally
// rotated.
//
// Row order note: the reconcile read passes `order=latest`, and at the pinned
// gateway (v2026.9.14, hermes_state_messages.py:779 + :817-818) that pages back
// from the newest but RETURNS CHRONOLOGICAL ORDER. The fixture below is
// therefore oldest-first — the order the alignment scan actually walks.
describe('reconcile trigger wiring (S5 §3.4-1b, dispatcher level)', () => {
  it('runs reconciliation after a REUSED turn settles', async () => {
    const readRecentMessages = vi.fn(async () => [
      {
        id: 'm_reply',
        senderId: 'u_engineer',
        type: 'text',
        content: '本轮的回复',
        metadata: JSON.stringify({ kind: 'agent_reply', taskId: TASK_ID }),
        createdAt: '2026-09-22T00:00:00.000Z',
      },
    ]);
    const postSystemEvent = vi.fn(async () => {});
    setHermesCloudIO({ readRecentMessages, postSystemEvent });
    // Aligned transcript (chronological): the anchor row exists and an answer
    // follows it, so a fired trigger must read the cloud rows and stay silent.
    transcriptBySession = {
      hs_live: [
        { role: 'user', content: `anchor ${TASK_ID}`, timestamp: 1727000000 },
        { role: 'assistant', content: '本轮的回复', timestamp: 1727000100 },
      ],
    };
    // Four prior reused turns; this dispatch is the 5th (N=5 gate).
    for (let i = 0; i < 4; i++) bumpReconcileCounter('cv_1', 'u_engineer');

    const outcome = await dispatchViaSessions(makeTask(), depsWithMapperReturning('hs_live'));

    expect(outcome.result.ok).toBe(true);
    // Fire-and-forget: the dispatch has already returned.
    await vi.waitFor(() => expect(readRecentMessages).toHaveBeenCalledTimes(1));
    // I-2.2 HARDENING: settle past the point where a mismatch WOULD speak.
    // `waitFor(read called)` resolves the instant the read lands, but the
    // compare + post happen after it — asserting silence right there could pass
    // vacuously. The twin case below proves the assert discriminates.
    await settle();
    // Aligned → read, then correctly silent.
    expect(postSystemEvent).not.toHaveBeenCalled();
  });

  // I-2.2 HARDENING (review) — silence is only evidence if the same wiring can
  // speak. Identical trigger, identical counter setup, misaligned transcript:
  // this MUST post. Without it, a reconcile that never got as far as
  // `postSystemEvent` would satisfy the silence assertion above.
  it('the same wiring DOES post on a misaligned transcript (proves the silence assertion discriminates)', async () => {
    const readRecentMessages = vi.fn(async () => [
      {
        id: 'm_reply',
        senderId: 'u_engineer',
        type: 'text',
        content: '本轮的回复',
        metadata: JSON.stringify({ kind: 'agent_reply', taskId: TASK_ID }),
        createdAt: '2026-09-22T00:00:00.000Z',
      },
    ]);
    const postSystemEvent = vi.fn(async () => {});
    setHermesCloudIO({ readRecentMessages, postSystemEvent });
    // Transcript does NOT hold our anchor → genuine misalignment.
    transcriptBySession = {
      hs_live: [{ role: 'user', content: '别的会话的行，不含本轮 anchor', timestamp: 1 }],
    };
    for (let i = 0; i < 4; i++) bumpReconcileCounter('cv_1', 'u_engineer');

    const outcome = await dispatchViaSessions(makeTask(), depsWithMapperReturning('hs_live'));

    expect(outcome.result.ok).toBe(true);
    await vi.waitFor(() => expect(postSystemEvent).toHaveBeenCalledTimes(1));
    expect(postSystemEvent.mock.calls[0]![2]).toMatchObject({
      kind: 'context_continuity_reconciled',
    });
  });

  it('does NOT reconcile on a FRESH turn (the reseed path owns that case)', async () => {
    const readRecentMessages = vi.fn(async () => []);
    setHermesCloudIO({ readRecentMessages, postSystemEvent: vi.fn(async () => {}) });
    for (let i = 0; i < 4; i++) bumpReconcileCounter('cv_1', 'u_engineer');

    // No mapping → first turn → sessionIsNew === true.
    const outcome = await dispatchViaSessions(makeTask(), depsWithMapperReturning(null));

    expect(outcome.result.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(readRecentMessages).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FIX ROUND 1 (review Important-1) — the reconcile→reseed chain was broken.
//
// `sessionMapper.invalidate()` DELETEs the mapping row (sessions-mapper.ts:114).
// So the turn AFTER a reconcile sees `rotationSource === null` — `rotate` is
// false and the mapper has nothing — which is byte-identical to a first turn:
// fresh session, EMPTY seed, no visibility event. The case above ("does NOT
// seed when there is no previous session") pins exactly that state, and specs/05
// :208 promised it would reseed from the abandoned transcript instead.
//
// The reconcile now parks the abandoned session as the next turn's reseed
// source; the following dispatch consumes it, so readback AND visibility are
// both restored.
describe('reconcile → reseed handoff (fix round 1)', () => {
  const postSystemEvent = vi.fn(
    async (_c: string, _content: string, _meta: Record<string, unknown>) => {},
  );

  it('resees the reconciled-away transcript on the NEXT turn, even though invalidate deleted the row', async () => {
    setHermesCloudIO({
      readRecentMessages: async () => [
        {
          id: 'm_reply',
          senderId: 'u_engineer',
          type: 'text',
          content: '上一条回复',
          metadata: JSON.stringify({ kind: 'agent_reply', taskId: TASK_ID }),
          createdAt: '2026-09-22T00:00:00.000Z',
        },
      ],
      postSystemEvent,
    });

    // Turn N: reused session, transcript has drifted away from our anchor →
    // reconcile invalidates the mapping and parks the abandoned session.
    const reconcileDeps = depsWithMapperReturning('hs_1');
    transcriptBySession = { hs_1: [{ role: 'user', content: '别的会话的行', timestamp: 1 }] };
    await maybeReconcileSessionContinuity(reconcileDeps, 'cv_1', 'u_engineer', 'hs_1', null);
    expect(reconcileDeps.sessionMapper.invalidate).toHaveBeenCalledWith('cv_1', 'u_engineer', 'hs_1');

    // Turn N+1: the mapping row is GONE. The abandoned session still holds the
    // previous exchange — which is the whole point of the reconcile.
    transcriptBySession = {
      hs_1: [
        { role: 'user', content: '上一问：预算怎么批？', timestamp: 1727000000 },
        { role: 'assistant', content: '上一答：预算走 OKR 发布档审批。', timestamp: 1727000060 },
      ],
    };
    postSystemEvent.mockClear();

    const outcome = await dispatchViaSessions(makeTask(), depsWithMapperReturning(null));

    expect(outcome.result.ok).toBe(true);
    const msg = chatBodyMessage();
    // 1) the previous exchange is seeded into the new session
    expect(msg).toContain('上一答：预算走 OKR 发布档审批。');
    expect(msg).toContain('transcript_continuity');
    // 2) …and the rotation is still visible to the human
    expect(postSystemEvent).toHaveBeenCalledTimes(1);
    expect(postSystemEvent.mock.calls[0]![2]).toMatchObject({
      kind: 'context_rebuilt',
      reason: 'reconcile_mismatch',
      previousSessionId: 'hs_1',
      reseededRows: 2,
    });
  });

  // This case exists to kill ONE specific mutation: consuming the parked source
  // whenever the dispatch runs out of live mappings, instead of only when it is
  // actually about to use it.
  //
  // The mutation is invisible on the turn that triggers it — a REUSED turn never
  // reads `rotationSource` (both of its uses sit inside `sessionIsNew` guards),
  // so an unconditional consume destroys the parked entry silently, and this
  // turn still looks correct. The damage only surfaces on the NEXT turn that
  // has no live mapping and therefore needs the parked source. Hence the third
  // turn below: it is the assertion that actually discriminates.
  it('consumes the parked source ONLY when it is about to be used (silent destruction is caught on the next turn)', async () => {
    setHermesCloudIO({
      readRecentMessages: async () => [
        {
          id: 'm_reply',
          senderId: 'u_engineer',
          type: 'text',
          content: 're',
          metadata: JSON.stringify({ kind: 'agent_reply', taskId: TASK_ID }),
          createdAt: '2026-09-22T00:00:00.000Z',
        },
      ],
      postSystemEvent,
    });
    const reconcileDeps = depsWithMapperReturning('hs_1');
    transcriptBySession = { hs_1: [{ role: 'user', content: '别的会话的行', timestamp: 1 }] };
    await maybeReconcileSessionContinuity(reconcileDeps, 'cv_1', 'u_engineer', 'hs_1', null);
    postSystemEvent.mockClear();

    // Turn A — a live mapping exists (the parked hs_1 is stale) → reuse it, do
    // NOT reseed, and stay silent.
    transcriptBySession = {
      hs_live: [{ role: 'assistant', content: '不应被播种的行', timestamp: 1727000060 }],
    };
    const turnA = await dispatchViaSessions(makeTask(), depsWithMapperReturning('hs_live'));

    expect(turnA.result.ok).toBe(true);
    expect(chatBodyMessage()).not.toContain('transcript_continuity');
    expect(postSystemEvent).not.toHaveBeenCalled();

    // Turn B — no live mapping again, so THIS is the turn that owes the parked
    // hs_1 a reseed. If turn A had eaten it (the mutation above), there is
    // nothing left here: no transcript tail, no visibility row.
    transcriptBySession = {
      hs_1: [
        { role: 'user', content: '上一问：预算怎么批？', timestamp: 1727000000 },
        { role: 'assistant', content: '上一答：预算走 OKR 发布档审批。', timestamp: 1727000060 },
      ],
    };
    const turnB = await dispatchViaSessions(makeTask(), depsWithMapperReturning(null));

    expect(turnB.result.ok).toBe(true);
    expect(chatBodyMessage()).toContain('上一答：预算走 OKR 发布档审批。');
    expect(chatBodyMessage()).toContain('transcript_continuity');
    expect(postSystemEvent).toHaveBeenCalledTimes(1);
    expect(postSystemEvent.mock.calls[0]![2]).toMatchObject({
      kind: 'context_rebuilt',
      reason: 'reconcile_mismatch',
      previousSessionId: 'hs_1',
      reseededRows: 2,
    });
  });
});
