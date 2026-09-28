// S1 (docs/organization/specs/01 Task 3) — sessions-SSE robustness against the
// v2026.9.14 upstream event surface. PURE TEST: `sessions-sse.ts` is NOT touched,
// and `git diff --stat` must show this file as the only addition. The audit
// (specs/01 §1) claims the existing parser is already compatible; these cases
// are the negative-control proof of that claim, not a rewrite of it.
//
//   A. `: keepalive` comment frames (new-pin gateway keepalive, 30s interval,
//      api_server.py CHAT_COMPLETIONS_SSE_KEEPALIVE_SECONDS) must not disturb
//      the assembled content or usage.
//   B. NEGATIVE CONTROL — comment frames must NOT feed the stall watchdog
//      (specs/01 audit 1a). A connection kept alive by pings while the upstream
//      hangs is exactly the stall the W4/W5 guard exists to break; if keepalive
//      ever counted as model activity the guard would go blind.
//   C. Unknown/forward events are ignored, and their payloads (which carry
//      misleading `content` fields) are never merged into the output. The
//      historical forward-compat arm proved `assistant.commentary` was not in
//      v2026.9.14; after v2026.9.21 it is a known relay event, but it still
//      must never silently become final output.
//   D. Terminal flags (`partial`/`interrupted`) and the per-turn transcript
//      array added to `run.completed` are inert for us — we read `content` and
//      `usage` only (audit 1d/1e).
//   E. An `error` event with no preceding `run.started` still lands its run_id
//      in the out-param, so cancellation/diagnostics keep targeting it (audit
//      1b: the error case must never be treated as "unknown").

import { afterEach, describe, expect, it } from 'vitest';
import { consumeSessionsSse } from '../src/adapters/persistence/hermes/sessions-sse.js';
import type { SessionsSseState } from '../src/adapters/persistence/hermes/sessions-sse.js';
import type { TaskInput } from '../src/adapters/contract.js';

function sseStream(frames: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
}

/** Frames delivered, then the stream is left OPEN forever — the "socket alive,
 *  upstream silent" shape the stall watchdog must abort. */
function hangingStream(frames: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f));
    },
  });
}

function frame(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Real gateway keepalive: a bare SSE comment frame with NO `event:` line and
 *  NO `data:` line (api_server.py writes `b": keepalive\n\n"`). */
const KEEPALIVE = ': keepalive\n\n';

const task = { taskId: 't-upgrade-compat' } as unknown as TaskInput;

const ENV_KEY = 'PRISMER_UPSTREAM_FIRST_EVENT_MS';
const savedFirstEventMs = process.env[ENV_KEY];

afterEach(() => {
  if (savedFirstEventMs === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedFirstEventMs;
});

describe('S1 sessions-SSE v2026.9.14 upgrade compatibility (specs/01 Task 3)', () => {
  it('A: keepalive comment frames do not disturb content, usage or the run id', async () => {
    const body = sseStream([
      frame('run.started', { run_id: 'api_native_914' }),
      KEEPALIVE,
      frame('assistant.delta', { delta: '你好' }),
      KEEPALIVE,
      frame('assistant.completed', {
        content: '你好',
        completed: true,
        partial: false,
        interrupted: false,
        runtime: { model: 'deepseek-v3', provider: 'deepseek' },
      }),
      frame('run.completed', {
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: '你好' },
        ],
      }),
      frame('done', {}),
    ]);

    const result = await consumeSessionsSse(body, task);

    expect(result.output).toBe('你好');
    expect(result.runId).toBe('api_native_914');
    expect(result.usage?.outputTokens).toBe(5);
    expect(result.usage?.inputTokens).toBe(10);
  });

  it('B (negative control): keepalive frames do NOT feed the stall watchdog', async () => {
    // Budget far below any real deployment value: if a comment frame counted as
    // activity it would keep re-arming and the promise below would never reject.
    process.env[ENV_KEY] = '50';

    const body = hangingStream([
      KEEPALIVE,
      KEEPALIVE,
      KEEPALIVE,
      frame('run.started', { run_id: 'run_hang' }),
      KEEPALIVE,
      // …and then the upstream never speaks again.
    ]);

    await expect(consumeSessionsSse(body, task)).rejects.toThrow(
      /upstream stall:.*pre-first-token.*PRISMER_UPSTREAM_FIRST_EVENT_MS=50/s,
    );
    // `run.started` is a gateway ack (enqueued BEFORE the LLM call), so it does
    // not end the first-event phase either — the abort above is the pre-first-
    // token wording, which is the proof.
  });

  it('C: unknown/forward events and commentary relay content never reach the final output', async () => {
    const body = sseStream([
      frame('run.started', { run_id: 'run_forward' }),
      // `assistant.commentary` is a known relay event in v2026.9.21. Payload
      // deliberately carries `content` under the pre-M1 field name so a naive
      // merge into the output path would show.
      frame('assistant.commentary', { message_id: 'm_c', content: 'DECOY-commentary' }),
      frame('message.interim', { message_id: 'm_i', content: 'DECOY-interim' }),
      frame('future.unknown', { x: 1, content: 'DECOY-unknown' }),
      frame('assistant.delta', { delta: '正文' }),
      frame('assistant.completed', { content: '正文' }),
      frame('done', {}),
    ]);

    const result = await consumeSessionsSse(body, task);

    expect(result.output).toBe('正文');
    expect(result.output).not.toContain('DECOY');
    expect(result.runId).toBe('run_forward');
  });

  it('C2 (embedded counter-example): the decoys also stay out of the delta fallback', async () => {
    // Case C above ends with `assistant.completed`, whose `content` becomes
    // `finalContent` and therefore MASKS anything that leaked into `deltas` —
    // so on its own it cannot falsify an "unknown payload merged into the
    // output" regression. This arm drops the terminal content so `output` is
    // the assembled `deltas`, which is the live path whenever a stream ends
    // without a final assistant frame (`output = finalContent || deltas`).
    const decoys = [
      frame('assistant.commentary', { message_id: 'm_c', content: 'DECOY-commentary' }),
      frame('message.interim', { message_id: 'm_i', content: 'DECOY-interim' }),
      frame('future.unknown', { x: 1, content: 'DECOY-unknown' }),
    ];
    const body = sseStream([
      frame('run.started', { run_id: 'run_forward' }),
      ...decoys,
      frame('assistant.delta', { delta: '正文' }),
      frame('done', {}),
    ]);

    const result = await consumeSessionsSse(body, task);

    expect(result.output).toBe('正文');
    expect(result.output).not.toContain('DECOY');
  });

  it('D: terminal flags and the run.completed transcript array are inert', async () => {
    const transcript = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 1 ? 'assistant' : 'user',
      content: `TRANSCRIPT_ROW_${i}`,
    }));
    const body = sseStream([
      frame('run.started', { run_id: 'run_partial' }),
      frame('assistant.completed', {
        content: '终态正文',
        completed: false,
        partial: true,
        interrupted: true,
        runtime: { model: 'deepseek-v3', provider: 'deepseek' },
      }),
      frame('run.completed', {
        usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
        messages: transcript,
      }),
      frame('done', {}),
    ]);

    const result = await consumeSessionsSse(body, task);

    expect(result.output).toBe('终态正文');
    expect(result.output).not.toContain('TRANSCRIPT_ROW');
    expect(result.usage?.outputTokens).toBe(2);
    // cache_* keys are absent on the sessions path in BOTH pins (audit 1f) —
    // assert the absence, not a 0, so a future upstream key shows up as a diff.
    expect(result.usage?.cacheReadTokens).toBeUndefined();
    expect(result.usage?.cacheWriteTokens).toBeUndefined();
  });

  it('E: an error event with no run.started still preserves its run_id', async () => {
    const state: SessionsSseState = { approvalRequested: false, runId: null };
    const seen: string[] = [];
    state.onRunStarted = (id) => seen.push(id);

    const body = sseStream([
      frame('error', { run_id: 'run_err', message: 'provider chain exhausted' }),
      frame('done', {}),
    ]);

    const result = await consumeSessionsSse(body, task, state);

    expect(state.runId).toBe('run_err');
    expect(result.runId).toBe('run_err');
    expect(seen).toEqual(['run_err']);
    // The error arm must stay distinct from the `default` (unknown) arm: an
    // unknown event here would leave the run_id unattributed.
    expect(result.upstreamError?.message).toContain('provider chain exhausted');
  });
});
