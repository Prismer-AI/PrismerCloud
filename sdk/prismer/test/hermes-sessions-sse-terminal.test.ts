// S7 (spec 07 Task 1, Step 5) — terminal SSE event attribution for the
// v2026.9.14 runs contract.
//
// Upstream (gateway `api_server_runs.py`) closes a run with one of:
//   run.completed                     — settled normally
//   run.failed / run.interrupted / run.cancelled — settled UNSUCCESSFULLY
// plus the v2026.9.21 narration family (`message.interim`, `assistant.commentary`).
//
// Before this change the three failure terminals fell through to `default`,
// which only logs: the stream then ended and the caller returned whatever
// deltas had accumulated — a partially-streamed run was reported as a
// SUCCESSFUL task ("假成功"). This file pins the fix:
//
//   * the consumer surfaces `terminalEvent` (never silently swallows it), and
//   * `dispatchViaRuns` maps it to ok:false with a typed error code, so the
//     cloud settles the run as failed/interrupted instead of "completed".
//   * `message.interim` is deliberately IGNORED in this spec (M1/S6 owns the
//     narration channel) — it must not leak into the task output.

import { describe, expect, it, vi, afterEach } from 'vitest';
import type { TaskInput } from '../src/adapters/contract.js';
import {
  consumeSessionsSse,
  type SessionsSseState,
} from '../src/adapters/persistence/hermes/sessions-sse.js';
import {
  dispatchViaRuns,
  type RunsDispatchDeps,
} from '../src/adapters/persistence/hermes/runs-dispatcher.js';

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sseOf(...frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const text = frames.join('');
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function makeTask(): TaskInput {
  return { taskId: 'run_terminal_1', prompt: 'do the work', currentPrompt: 'do the work' };
}

function makeState(): SessionsSseState {
  return { approvalRequested: false, runId: null };
}

describe('consumeSessionsSse — terminal events (v2026.9.14)', () => {
  it.each([
    ['run.failed', 'upstream blew up'],
    ['run.interrupted', 'The gateway restarted before this run settled.'],
    ['run.cancelled', ''],
  ])('terminal %s yields failed result with attribution, not silent deltas', async (event, msg) => {
    const res = await consumeSessionsSse(
      sseOf(
        frame('run.started', { run_id: 'run_x' }),
        frame('assistant.delta', { delta: 'partial' }),
        frame(event, { message: msg }),
      ),
      makeTask(),
      makeState(),
    );

    expect(res.terminalEvent?.event).toBe(event);
    if (msg) expect(res.terminalEvent?.message).toBe(msg);
  });

  it('captures the run id from the terminal payload when run.started was missed', async () => {
    const res = await consumeSessionsSse(
      sseOf(frame('run.interrupted', { run_id: 'run_orphan', message: 'gateway restarted' })),
      makeTask(),
      makeState(),
    );
    expect(res.terminalEvent?.event).toBe('run.interrupted');
    expect(res.terminalEvent?.runId).toBe('run_orphan');
  });

  it('records the terminal event on the recorder + progress channel (observable)', async () => {
    const recordError = vi.fn();
    const onProgress = vi.fn();
    const task = {
      ...makeTask(),
      recorder: { recordError },
      onProgress,
    } as unknown as TaskInput;

    await consumeSessionsSse(
      sseOf(frame('run.started', { run_id: 'run_x' }), frame('run.cancelled', { message: 'user stopped it' })),
      task,
      makeState(),
    );

    expect(recordError).toHaveBeenCalledWith('user stopped it', expect.anything());
    expect(
      onProgress.mock.calls.some(
        (c) => (c[0] as { detail?: { event?: string } })?.detail?.event === 'run.cancelled',
      ),
    ).toBe(true);
  });

  it('a normal run.completed stream leaves terminalEvent unset (negative control)', async () => {
    const res = await consumeSessionsSse(
      sseOf(frame('run.started', { run_id: 'run_x' }), frame('run.completed', {})),
      makeTask(),
      makeState(),
    );
    expect(res.terminalEvent).toBeUndefined();
  });

  it('message.interim is ignored silently in this spec (M1 scope)', async () => {
    const res = await consumeSessionsSse(
      sseOf(
        frame('message.interim', { text: 'midway narration' }),
        frame('run.completed', { usage: { input_tokens: 1 } }),
      ),
      makeTask(),
      makeState(),
    );
    expect(res.output).not.toContain('midway narration');
    expect(res.terminalEvent).toBeUndefined();
    expect(res.commentarySegments).toEqual([]);
  });
});

// ── integration: the runs transport must not report a terminal failure as ok ──

const TERMINAL_DEPS: RunsDispatchDeps = {
  baseUrl: 'http://hermes.local',
  apiKey: 'sk-test',
  model: 'claude-test',
  supportsVision: false,
  profileName: 'p',
  instructions: 'CAPS',
  idempotencyKey: 'llm:deadbeefdeadbeefdeadbeefdeadbeef',
  idempotencyNonce: '3f1a2b4c-5d6e-7f80-9a1b-2c3d4e5f6071',
};

function stubTerminalFetch(sseText: string): typeof fetch {
  return vi.fn(async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';
    if (url.endsWith('/v1/runs') && method === 'POST') {
      return { ok: true, status: 202, json: async () => ({ run_id: 'run_terminal_1' }) } as Response;
    }
    if (url.includes('/v1/runs/') && url.endsWith('/events')) {
      const encoder = new TextEncoder();
      return {
        ok: true,
        status: 200,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(sseText));
            controller.close();
          },
        }),
      } as unknown as Response;
    }
    return { ok: false, status: 404, text: async () => `unexpected ${url}` } as Response;
  }) as unknown as typeof fetch;
}

describe('dispatchViaRuns — terminal events settle as ok:false (S7 Task 1)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['run.interrupted', 'run_interrupted'],
    ['run.failed', 'upstream_llm_error'],
    ['run.cancelled', 'run_cancelled'],
  ])('%s → ok:false with code %s (no fake success)', async (event, code) => {
    vi.stubGlobal(
      'fetch',
      stubTerminalFetch(
        frame('run.started', { run_id: 'run_terminal_1' }) +
          frame('assistant.delta', { delta: 'partial' }) +
          frame(event, { message: 'settled badly' }),
      ),
    );
    const out = await dispatchViaRuns(makeTask(), TERMINAL_DEPS);

    expect(out.result.ok).toBe(false);
    expect(out.result.error?.code).toBe(code);
    const hermes = out.result.metadata?.hermes as Record<string, unknown>;
    expect((hermes.terminalEvent as { event: string }).event).toBe(event);
    // Negative control for the OLD behaviour: the accumulated partial delta
    // must never be handed back as a successful output.
    expect(out.result.output ?? '').not.toBe('partial');
  });
});
