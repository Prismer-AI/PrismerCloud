// memory203/18 W4 + W5 — in-flight upstream-stall watchdog (sessions-sse.ts
// createStallGuard). Proof that:
//   1. a SILENTLY stalled stream (connection open, zero SSE events) is aborted
//      at the pre-first-token budget (PRISMER_UPSTREAM_FIRST_EVENT_MS) with a
//      stall-classed retryable error, BEFORE the 300s daemon reaper would kill
//      the run;
//   2. W5 two-phase: `run.started` / `message.started` are gateway acks
//      enqueued BEFORE the LLM call (api_server.py `_run_and_signal`) and do
//      NOT end the generous first-event phase — a legitimate long-context
//      first token that outlasts the inter-event threshold survives; once a
//      MODEL event arrives, mid-stream silence is judged by the tighter
//      PRISMER_UPSTREAM_STALL_MS;
//   3. an ACTIVE stream whose events keep flowing (each gap < threshold, total
//      duration > threshold) never triggers the watchdog;
//   4. the env overrides are respected (and invalid values fall back);
//   5. classification mapping: BOTH phase wordings are limiter-class
//      (dispatch.ts isLimiterClassError → exhaustion lands
//      dispatch_precondition_unavailable requeue, not a permanent failure) and
//      retryReasonToken renders `reason=stall` in the retry progress frame.
import { describe, it, expect, afterEach } from 'vitest';
import {
  consumeSessionsSse,
  resolveUpstreamStallMs,
  resolveUpstreamFirstEventMs,
} from '../src/adapters/persistence/hermes/sessions-sse.js';
import { isLimiterClassError, retryReasonToken } from '../src/daemon/dispatch.js';
import type { TaskInput } from '../src/adapters/contract.js';

const task = { taskId: 't-stall' } as unknown as TaskInput;

function frame(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A stream that emits `frames` on `intervalMs` gaps, then closes; when
 *  `stallAfter` is set it stops emitting after that many frames and NEVER
 *  closes — the silent-upstream-hang shape (socket alive, zero events). */
function timedStream(
  frames: string[],
  intervalMs: number,
  opts: { stallAfter?: number } = {},
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  let timer: NodeJS.Timeout | undefined;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const tick = (): void => {
        if (opts.stallAfter !== undefined && i >= opts.stallAfter) return; // hang silently
        if (i >= frames.length) {
          controller.close();
          return;
        }
        controller.enqueue(enc.encode(frames[i]!));
        i += 1;
        timer = setTimeout(tick, intervalMs);
        timer.unref?.();
      };
      timer = setTimeout(tick, intervalMs);
      timer.unref?.();
    },
    cancel() {
      if (timer) clearTimeout(timer);
    },
  });
}

/** Enqueue each [atMs, frame] on an absolute schedule, never closing unless told. */
function scheduledStream(
  entries: Array<[number, string]>,
  opts: { closeAtMs?: number } = {},
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const [at, f] of entries) {
        const t = setTimeout(() => controller.enqueue(enc.encode(f)), at);
        t.unref?.();
      }
      if (opts.closeAtMs !== undefined) {
        const t = setTimeout(() => controller.close(), opts.closeAtMs);
        t.unref?.();
      }
    },
  });
}

afterEach(() => {
  delete process.env.PRISMER_UPSTREAM_STALL_MS;
  delete process.env.PRISMER_UPSTREAM_FIRST_EVENT_MS;
});

describe('sessions SSE upstream-stall watchdog (memory203/18 W4 + W5)', () => {
  it('aborts a silently stalled stream at the first-event budget with the pre-first-token wording', async () => {
    process.env.PRISMER_UPSTREAM_FIRST_EVENT_MS = '150';
    process.env.PRISMER_UPSTREAM_STALL_MS = '10000';
    // run.started arrives (gateway ack — does NOT end phase 1), then the
    // upstream hangs forever (stream never closes).
    const body = timedStream(
      [frame('run.started', { run_id: 'run_stall' })],
      20,
      { stallAfter: 1 },
    );
    const startedAt = Date.now();
    await expect(consumeSessionsSse(body, task)).rejects.toThrow(
      /upstream stall: no first event for \d+s/,
    );
    const elapsed = Date.now() - startedAt;
    // Fired at ~threshold (20ms first frame + 150ms inactivity), nowhere near
    // a reaper-scale wait. Generous upper bound for CI jitter.
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(2_000);
  });

  it('aborts when NO event at all arrives (stall before the first frame)', async () => {
    process.env.PRISMER_UPSTREAM_FIRST_EVENT_MS = '120';
    const body = timedStream([], 10, { stallAfter: 0 });
    await expect(consumeSessionsSse(body, task)).rejects.toThrow(
      /upstream stall: no first event/,
    );
  });

  it('W5: lifecycle acks do not end the first-event phase — a slow first token outliving the inter-event threshold survives', async () => {
    process.env.PRISMER_UPSTREAM_FIRST_EVENT_MS = '800';
    process.env.PRISMER_UPSTREAM_STALL_MS = '120';
    // run.started + message.started arrive immediately (as hermes really
    // does), then SILENCE for ~400ms (> 120ms inter-event threshold, < 800ms
    // first-event budget) until the first delta — the healthy long-context
    // first-token shape that the single-threshold W4 guard used to kill.
    const body = scheduledStream(
      [
        [5, frame('run.started', { run_id: 'run_slow_first_token' })],
        [15, frame('message.started', { message: { id: 'm1' } })],
        [420, frame('assistant.delta', { delta: 'slow ' })],
        [440, frame('assistant.completed', { content: 'slow first token ok' })],
        [460, frame('done', {})],
      ],
      { closeAtMs: 480 },
    );
    const result = await consumeSessionsSse(body, task);
    expect(result.output).toBe('slow first token ok');
    expect(result.runId).toBe('run_slow_first_token');
  });

  it('W5: after the first MODEL event, mid-stream silence is judged by the inter-event threshold', async () => {
    process.env.PRISMER_UPSTREAM_FIRST_EVENT_MS = '10000';
    process.env.PRISMER_UPSTREAM_STALL_MS = '150';
    // First delta arrives fast (ends phase 1), then the upstream hangs.
    const body = scheduledStream([
      [5, frame('run.started', { run_id: 'run_mid_stall' })],
      [25, frame('assistant.delta', { delta: 'tok ' })],
      // ...and then NOTHING, forever.
    ]);
    const startedAt = Date.now();
    await expect(consumeSessionsSse(body, task)).rejects.toThrow(
      /upstream stall: no events for \d+s/,
    );
    const elapsed = Date.now() - startedAt;
    // Fired on the 150ms inter-event budget, not the 10s first-event budget.
    expect(elapsed).toBeLessThan(2_000);
  });

  it('never triggers while events keep flowing, even when the turn outlasts the threshold', async () => {
    process.env.PRISMER_UPSTREAM_STALL_MS = '200';
    // 8 deltas at 60ms gaps = ~480ms total (> 200ms threshold) but every
    // inter-event gap is < threshold — an active stream must complete.
    const deltas = Array.from({ length: 8 }, (_, i) =>
      frame('assistant.delta', { delta: `tok${i} ` }),
    );
    const body = timedStream(
      [
        frame('run.started', { run_id: 'run_ok' }),
        ...deltas,
        frame('assistant.completed', { content: 'tok0 tok1 tok2 tok3 tok4 tok5 tok6 tok7 ' }),
        frame('done', {}),
      ],
      60,
    );
    const result = await consumeSessionsSse(body, task);
    expect(result.output).toContain('tok7');
    expect(result.runId).toBe('run_ok');
  });

  it('disarms while awaiting a clarify answer (human wait ≠ upstream stall), re-arms after', async () => {
    process.env.PRISMER_UPSTREAM_STALL_MS = '150';
    const enc = new TextEncoder();
    // clarify.request arrives, then the stream is SILENT for 3× the threshold
    // (human thinking) — must NOT stall; clarify.responded + completion then
    // land and the turn finishes normally.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const at = (ms: number, fn: () => void): void => {
          const t = setTimeout(fn, ms);
          t.unref?.();
        };
        controller.enqueue(enc.encode(frame('run.started', { run_id: 'run_clarify' })));
        at(20, () =>
          controller.enqueue(
            enc.encode(frame('clarify.request', { clarify_id: 'c1', question: 'blue or green?' })),
          ),
        );
        at(500, () => {
          controller.enqueue(enc.encode(frame('clarify.responded', { clarify_id: 'c1' })));
          controller.enqueue(enc.encode(frame('assistant.completed', { content: 'green it is' })));
          controller.enqueue(enc.encode(frame('done', {})));
          controller.close();
        });
      },
    });
    const result = await consumeSessionsSse(body, task);
    expect(result.output).toBe('green it is');
    expect(result.clarify?.clarifyId).toBe('c1');
  });

  it('re-arms after clarify.responded — a stall AFTER the human answered still aborts (inter-event phase)', async () => {
    process.env.PRISMER_UPSTREAM_STALL_MS = '150';
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(frame('clarify.request', { clarify_id: 'c2', question: 'q' })));
        const t = setTimeout(() => {
          // Human answered → run resumes → upstream hangs silently again.
          controller.enqueue(enc.encode(frame('clarify.responded', { clarify_id: 'c2' })));
          // ... and then NOTHING, forever.
        }, 400);
        t.unref?.();
      },
    });
    await expect(consumeSessionsSse(body, task)).rejects.toThrow(
      /upstream stall: no events for/,
    );
  });

  it('resolveUpstreamStallMs: default 120000, env override respected, junk falls back', () => {
    delete process.env.PRISMER_UPSTREAM_STALL_MS;
    expect(resolveUpstreamStallMs()).toBe(120_000);
    process.env.PRISMER_UPSTREAM_STALL_MS = '45000';
    expect(resolveUpstreamStallMs()).toBe(45_000);
    process.env.PRISMER_UPSTREAM_STALL_MS = '0';
    expect(resolveUpstreamStallMs()).toBe(120_000);
    process.env.PRISMER_UPSTREAM_STALL_MS = 'soon';
    expect(resolveUpstreamStallMs()).toBe(120_000);
  });

  it('resolveUpstreamFirstEventMs: default 270000 (< 300s reaper), env override respected, junk falls back', () => {
    delete process.env.PRISMER_UPSTREAM_FIRST_EVENT_MS;
    expect(resolveUpstreamFirstEventMs()).toBe(270_000);
    process.env.PRISMER_UPSTREAM_FIRST_EVENT_MS = '180000';
    expect(resolveUpstreamFirstEventMs()).toBe(180_000);
    process.env.PRISMER_UPSTREAM_FIRST_EVENT_MS = '-1';
    expect(resolveUpstreamFirstEventMs()).toBe(270_000);
    process.env.PRISMER_UPSTREAM_FIRST_EVENT_MS = 'later';
    expect(resolveUpstreamFirstEventMs()).toBe(270_000);
  });

  it('classifies BOTH phase wordings as limiter-class (requeue lane) with the stall retry token', () => {
    const interEvent =
      'upstream stall: no events for 120s (sessions SSE in-flight watchdog, PRISMER_UPSTREAM_STALL_MS=120000)';
    const firstEvent =
      'upstream stall: no first event for 270s (sessions SSE in-flight watchdog, pre-first-token phase, PRISMER_UPSTREAM_FIRST_EVENT_MS=270000)';
    // → dispatch.ts retry loop uses jittered limiter backoff, and on
    //   exhaustion emits dispatch_precondition_unavailable (cloud requeue)
    //   instead of the terminal daemon_local_retry_exhausted.
    expect(isLimiterClassError(interEvent)).toBe(true);
    expect(isLimiterClassError(firstEvent)).toBe(true);
    expect(retryReasonToken(interEvent)).toBe('stall');
    expect(retryReasonToken(firstEvent)).toBe('stall');
    // Guard the guard: a generic timeout wording must NOT ride the requeue lane.
    expect(isLimiterClassError('HTTP 504: upstream timeout')).toBe(false);
  });
});
