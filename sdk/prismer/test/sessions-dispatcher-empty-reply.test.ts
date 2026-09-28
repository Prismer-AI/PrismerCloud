// memory203/18 W5 (final-round5 P0) — silent-empty-completion guard.
//
// Live failure shape: stall-abort of attempt1 → hermes keeps generating
// server-side (executor thread is uncancellable) → retry re-enters the SAME
// session → retried stream completes with EMPTY content → adapter used to
// return ok=true output:'' → cloud marked the run completed and the DM
// message-post gate (`output || attachments`) silently skipped the post.
// Contract under test: a sessions dispatch may NEVER resolve ok=true with an
// empty output (approval/clarify suspensions excluded) — it must either
// recover the reply from the session transcript tail or fail loudly with
// `empty_reply` (terminal in the dispatch retry loop).

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// HermesSessionMapper transitively imports better-sqlite3 via LocalDb — stub
// the module so the dispatcher loads without the native dep.
vi.mock('../src/adapters/persistence/hermes/sessions-mapper.js', () => ({
  HermesSessionMapper: class {},
}));

// Controllable SSE consumer stub: each test sets `sseBehavior`.
let sseBehavior: (state?: { runId: string | null }) => Promise<Record<string, unknown>>;
vi.mock('../src/adapters/persistence/hermes/sessions-sse.js', () => ({
  consumeSessionsSse: vi.fn(async (_body: unknown, _task: unknown, state?: { runId: string | null }) =>
    sseBehavior(state),
  ),
}));

vi.mock('../src/daemon/memory/run-session-map.js', () => ({
  getRunSessionRegistry: () => null,
}));

import { dispatchViaSessions, recoverReplyFromSessionTail } from '../src/adapters/persistence/hermes/sessions-dispatcher.js';
import { isEmptyReplyFailure } from '../src/daemon/dispatch.js';
import { __resetSessionHealth } from '../src/adapters/persistence/hermes/session-health.js';
import type { TaskInput, TaskResult } from '../src/adapters/contract.js';

const TASK_ID = 'run_t5ls4nzr1hdxmjr7trldf';

function makeTask(): TaskInput {
  return {
    taskId: TASK_ID,
    prompt: 'ignored',
    currentPrompt: 'what did doc-12 say about providers?',
    conversationType: 'direct',
    conversationId: 'cv_1',
    profileAgentUsername: 'engineer',
    profileAgentImUserId: 'u_engineer',
    metadata: { conversationId: 'cv_1', agentImUserId: 'u_engineer', workspaceId: 'ws_1' },
  } as unknown as TaskInput;
}

const baseDeps = {
  baseUrl: 'http://127.0.0.1:9000',
  apiKey: 'test-key',
  profileName: 'engineer',
  serviceId: 'svc_test',
  model: 'hermes-test',
  capabilities: {},
  instructions: 'You are a test agent.',
  idempotencyKey: 'idem-1',
  sessionMapper: {
    get: () => ({
      conversationId: 'cv_1',
      agentImUserId: 'u_engineer',
      hermesSessionId: 'hs_1',
      hermesSessionKey: null,
    }),
    createForConversation: async () => {
      throw new Error('unexpected session create');
    },
  },
} as unknown as Parameters<typeof dispatchViaSessions>[1];

/** Requests seen by the fetch stub, in order. */
let requests: Array<{ url: string; method: string }> = [];
/** Session-transcript rows served by GET /api/sessions/{id}/messages. */
let transcriptRows: Array<Record<string, unknown>> = [];

beforeEach(() => {
  requests = [];
  transcriptRows = [];
  // session-health state is module-level and persisted to disk (63084115);
  // a prior case's empty_reply / interrupt would trip S10 rotation (threshold
  // is 1) and force the "fresh session" branch, breaking the no-create cases
  // below. Reset per-case so the rotation decision is case-scoped.
  __resetSessionHealth();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    requests.push({ url, method });
    if (url.includes('/chat/stream')) {
      return new Response(new ReadableStream(), { status: 200 });
    }
    if (url.includes('/messages')) {
      return new Response(JSON.stringify({ object: 'list', data: transcriptRows }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/stop')) {
      // Current hermes: sessions runs are not registered → 404.
      return new Response(JSON.stringify({ error: { message: 'Run not found' } }), { status: 404 });
    }
    return new Response('{}', { status: 200 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sessions dispatch silent-empty-completion guard (memory203/18 W5)', () => {
  it('maps an SSE upstream error to upstream_llm_error before the empty-reply guard', async () => {
    const message = 'No LLM provider configured. Run `hermes model` to configure one.';
    sseBehavior = async () => ({
      output: '',
      runId: 'run_config_missing',
      approvalRequested: false,
      upstreamError: { message },
    });

    const outcome = await dispatchViaSessions(makeTask(), baseDeps);

    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.error).toEqual({ code: 'upstream_llm_error', message });
    expect(outcome.result.error?.code).not.toBe('empty_reply');
    expect(requests.some((r) => r.url.includes('/messages'))).toBe(false);
  });

  it('recovers the reply from the session transcript tail when the stream completed empty', async () => {
    sseBehavior = async () => ({ output: '', runId: 'run_h1', approvalRequested: false });
    // Transcript shape after the race: previous turn, then THIS turn's user
    // row (carries the dispatch id inside <execution_context>), an assistant
    // tool step, and the late-flushed real answer.
    transcriptRows = [
      { role: 'user', content: 'older turn question' },
      { role: 'assistant', content: 'older turn answer — must NOT be surfaced' },
      { role: 'user', content: `<conversation_context>…<run_id>${TASK_ID}</run_id>…` },
      { role: 'assistant', content: '' },
      { role: 'assistant', content: 'the real doc-12 answer, late-flushed by the killed attempt' },
    ];
    const outcome = await dispatchViaSessions(makeTask(), baseDeps);
    expect(outcome.result.ok).toBe(true);
    expect(outcome.result.output).toBe(
      'the real doc-12 answer, late-flushed by the killed attempt',
    );
    const hermesMeta = (outcome.result.metadata as { hermes: Record<string, unknown> }).hermes;
    expect(hermesMeta.replyRecovered).toBe('session_transcript_tail');
  });

  it('fails LOUDLY with empty_reply when nothing is recoverable — never a silent ok-empty success', async () => {
    sseBehavior = async () => ({ output: '  \n ', runId: 'run_h2', approvalRequested: false });
    // Transcript holds only the PREVIOUS turn — no user row for this dispatch
    // id, so the previous answer must NOT be duplicated into this turn.
    transcriptRows = [
      { role: 'user', content: 'older turn question' },
      { role: 'assistant', content: 'older turn answer — must NOT be surfaced' },
    ];
    const outcome = await dispatchViaSessions(makeTask(), baseDeps);
    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.error?.code).toBe('empty_reply');
    expect(outcome.result.output).toBe('');
    // …and the retry loop treats it as terminal (no silent 3× re-burn of a
    // 120k-token prompt into the same polluted session).
    expect(isEmptyReplyFailure(outcome.result as TaskResult)).toBe(true);
  }, 15_000);

  it('does not trip the guard on approval suspension (legitimate empty output)', async () => {
    sseBehavior = async () => ({ output: '', runId: 'run_h3', approvalRequested: true });
    const outcome = await dispatchViaSessions(makeTask(), baseDeps);
    expect(outcome.result.ok).toBe(true);
    expect(
      (outcome.result.metadata as Record<string, unknown>).approvalRequested,
    ).toBe(true);
    // No transcript probe fired.
    expect(requests.some((r) => r.url.includes('/messages'))).toBe(false);
  });

  it('does not trip the guard on a pending clarify (run blocked on the human)', async () => {
    sseBehavior = async (state) => {
      if (state) (state as { clarifyRequested?: boolean }).clarifyRequested = true;
      return { output: '', runId: 'run_h4', approvalRequested: false };
    };
    const outcome = await dispatchViaSessions(makeTask(), baseDeps);
    expect(outcome.result.ok).toBe(true);
    expect(requests.some((r) => r.url.includes('/messages'))).toBe(false);
  });

  it('leaves a non-empty completion untouched (no transcript probe, ok passthrough)', async () => {
    sseBehavior = async () => ({ output: 'a real answer', runId: 'run_h5', approvalRequested: false });
    const outcome = await dispatchViaSessions(makeTask(), baseDeps);
    expect(outcome.result.ok).toBe(true);
    expect(outcome.result.output).toBe('a real answer');
    expect(requests.some((r) => r.url.includes('/messages'))).toBe(false);
  });

  it('fires a best-effort /v1/runs/{id}/stop when the stream is stall-aborted (tolerates the current 404)', async () => {
    sseBehavior = async (state) => {
      if (state) state.runId = 'run_h6';
      throw new Error(
        'upstream stall: no first event for 270s (sessions SSE in-flight watchdog, pre-first-token phase, PRISMER_UPSTREAM_FIRST_EVENT_MS=270000)',
      );
    };
    const outcome = await dispatchViaSessions(makeTask(), baseDeps);
    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.error?.message).toMatch(/upstream stall: no first event/);
    // Fire-and-forget — give the microtask a beat to reach the fetch stub.
    await new Promise((r) => setTimeout(r, 20));
    const stopReq = requests.find((r) => r.url.includes('/v1/runs/run_h6/stop'));
    expect(stopReq).toBeDefined();
    expect(stopReq?.method).toBe('POST');
  });
});

describe('recoverReplyFromSessionTail unit behaviour', () => {
  const deps = { baseUrl: 'http://127.0.0.1:9000', apiKey: 'k' };

  it('anchors on the FIRST user row carrying the dispatch id (catches answers flushed between duplicate user rows)', async () => {
    transcriptRows = [
      { role: 'user', content: `turn A <run_id>${TASK_ID}</run_id>` }, // attempt1 flush
      { role: 'assistant', content: 'answer from the killed attempt' },
      { role: 'user', content: `turn A retry <run_id>${TASK_ID}</run_id>` }, // attempt2 flush
      { role: 'assistant', content: '' },
    ];
    // Note: last non-empty assistant AFTER the first anchored row wins.
    const recovered = await recoverReplyFromSessionTail(deps, 'hs_1', null, TASK_ID);
    expect(recovered).toBe('answer from the killed attempt');
  });

  it('returns null without an anchor match (never resurfaces an older turn)', async () => {
    transcriptRows = [
      { role: 'user', content: 'unrelated' },
      { role: 'assistant', content: 'unrelated answer' },
    ];
    const recovered = await recoverReplyFromSessionTail(deps, 'hs_1', null, TASK_ID);
    expect(recovered).toBeNull();
  }, 15_000);

  it('returns null for an empty anchor (defensive)', async () => {
    const recovered = await recoverReplyFromSessionTail(deps, 'hs_1', null, '');
    expect(recovered).toBeNull();
    expect(requests.length).toBe(0);
  });
});

// S1 (docs/organization/specs/01 audit 2c / Task 5) — v2026.9.14 changed
// `GET /api/sessions/{id}/messages` to return the LATEST 500 rows by default
// (older pins returned everything; `hermes_state_messages.py:774-781`). The
// tail-recovery anchor is this turn's user row, which by construction sits near
// the tail — so a 500-row window is expected to be sufficient. What matters is
// that when the anchor DOES fall outside the window, recovery degrades to a
// LOUD failure instead of a fake success (the anchorIdx<0 → continue path).
// These two cases are the negative control and its contrast for that boundary.
describe('recoverReplyFromSessionTail under the v2026.9.14 latest-500 window (S1)', () => {
  const deps = { baseUrl: 'http://127.0.0.1:9000', apiKey: 'k' };

  /** 500 older rows — the whole served window, with this turn's anchor outside it. */
  function windowWithoutAnchor(): Array<Record<string, unknown>> {
    return Array.from({ length: 500 }, (_, i) => ({
      role: i % 2 === 1 ? 'assistant' : 'user',
      content: `older-history row ${i} — no dispatch id here`,
    }));
  }

  it('NEGATIVE CONTROL: anchor outside the 500-row window → null, never a resurfaced older answer', async () => {
    transcriptRows = windowWithoutAnchor();
    const recovered = await recoverReplyFromSessionTail(deps, 'hs_1', null, TASK_ID);
    expect(recovered).toBeNull();
  }, 15_000);

  it('NEGATIVE CONTROL: that truncation reaches the dispatcher as a LOUD empty_reply, not a fake ok', async () => {
    sseBehavior = async () => ({ output: '', runId: 'run_win', approvalRequested: false });
    transcriptRows = windowWithoutAnchor();

    const outcome = await dispatchViaSessions(makeTask(), baseDeps);

    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.output).toBe('');
    expect(outcome.result.error?.code).toBe('empty_reply');
    // The distinction that makes it a control: the "recovered" marker MUST NOT
    // be present — a silent transcript-tail "success" here would post an older
    // turn's answer as this turn's reply.
    const hermesMeta = (outcome.result.metadata as { hermes: Record<string, unknown> }).hermes;
    expect(hermesMeta.status).toBe('failed');
    expect(hermesMeta.error).toBe('empty_reply');
    expect(hermesMeta.replyRecovered).toBeUndefined();
    expect(isEmptyReplyFailure(outcome.result as TaskResult)).toBe(true);
  }, 20_000);

  it('contrast: the same window WITH the anchor + a later assistant row recovers normally', async () => {
    sseBehavior = async () => ({ output: '', runId: 'run_win2', approvalRequested: false });
    const rows = windowWithoutAnchor();
    rows.push(
      { role: 'user', content: `this turn <run_id>${TASK_ID}</run_id>` },
      { role: 'assistant', content: '' },
      { role: 'assistant', content: 'the answer that displaced the window edge' },
    );
    transcriptRows = rows;

    const outcome = await dispatchViaSessions(makeTask(), baseDeps);

    expect(outcome.result.ok).toBe(true);
    expect(outcome.result.output).toBe('the answer that displaced the window edge');
    const hermesMeta = (outcome.result.metadata as { hermes: Record<string, unknown> }).hermes;
    expect(hermesMeta.replyRecovered).toBe('session_transcript_tail');
  }, 15_000);
});

// S5 §3.4-2 (docs/organization/specs/05 Task 3) — recovery anchor validation.
//
// `recoverReplyFromSessionTail` exists to salvage THIS turn's answer when the
// stream completed empty. But a transcript row proves nothing about WHICH turn
// produced it: the previous attempt's generation flushes on its own schedule,
// so an answer born in the PREVIOUS turn can land after this turn's anchor row
// and masquerade as the reply. Three mechanical rules reject it:
//   1. the recovered assistant row's nearest preceding user row carries THIS
//      turn's anchor (the anchorIdx scan already guarantees this);
//   2. no OTHER per-turn anchor sits between the two (cross-turn interleave);
//   3. the recovered row's timestamp is not EARLIER than the anchor row's
//      (the discriminating rule — a late flush of an earlier turn is older by
//      construction, however late it landed).
// Timestamps absent ⇒ rules 1/2 only + an observable `recovery_anchor_ts_missing`
// note on stderr (degrade visibly, never reject on missing evidence).
describe('recovery anchor validation (S5 §3.4-2)', () => {
  const deps = { baseUrl: 'http://127.0.0.1:9000', apiKey: 'k' };

  /** Capture the adapter's stderr diagnostics for this case. */
  function captureStderr(): string[] {
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
    return lines;
  }

  it("rejects a late-flushed answer whose timestamp predates this turn's anchor user row", async () => {
    const stderr = captureStderr();
    transcriptRows = [
      { role: 'user', content: `…anchor ${TASK_ID}…`, timestamp: 1727000100 }, // 本轮
      { role: 'assistant', content: '上一问的答案（晚落盘）', timestamp: 1727000060 },
    ];
    const recovered = await recoverReplyFromSessionTail(deps, 'hs_1', null, TASK_ID);
    expect(recovered).toBeNull();
    // Loud, greppable: the operator must be able to see WHY the salvage was
    // refused when the run goes on to fail with empty_reply.
    expect(stderr.some((l) => l.includes('recovery rejected'))).toBe(true);
  });

  it('still adopts a genuinely-late flush of THIS turn (timestamp after anchor row)', async () => {
    transcriptRows = [
      { role: 'user', content: `…anchor ${TASK_ID}…`, timestamp: 1727000100 },
      { role: 'assistant', content: '本轮真答案', timestamp: 1727000110 },
    ];
    const recovered = await recoverReplyFromSessionTail(deps, 'hs_1', null, TASK_ID);
    expect(recovered).toBe('本轮真答案');
  });

  it('rejects when a foreign anchored user row sits between anchor and recovered row', async () => {
    const stderr = captureStderr();
    transcriptRows = [
      { role: 'user', content: `…anchor ${TASK_ID}…`, timestamp: 1727000100 },
      { role: 'user', content: '…anchor run_other…', timestamp: 1727000105 },
      { role: 'assistant', content: '别轮的答案', timestamp: 1727000106 },
    ];
    expect(await recoverReplyFromSessionTail(deps, 'hs_1', null, TASK_ID)).toBeNull();
    expect(stderr.some((l) => l.includes('recovery rejected'))).toBe(true);
  });

  it('degrades to anchor/foreign rules when timestamps are absent, and says so on stderr', async () => {
    const stderr = captureStderr();
    // No timestamps (older hermes pins / alternate stores) — cannot apply
    // rule 3, so the salvage proceeds but the degradation is observable.
    transcriptRows = [
      { role: 'user', content: `…anchor ${TASK_ID}…` },
      { role: 'assistant', content: '无时间戳的答案' },
    ];
    const recovered = await recoverReplyFromSessionTail(deps, 'hs_1', null, TASK_ID);
    expect(recovered).toBe('无时间戳的答案');
    expect(stderr.some((l) => l.includes('recovery_anchor_ts_missing'))).toBe(true);
  });
});
