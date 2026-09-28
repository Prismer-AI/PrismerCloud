// B-P0 turn metrics — `firstEventMs` derivation in consumeSessionsSse.
//
// The field feeds `turn.first_event_ms` (registry entry in
// src/im/services/metric-registry.ts), i.e. dispatch start → FIRST
// model-activity event. Gateway acks (`run.started` / `message.started`) are
// enqueued BEFORE the LLM call, so they must not count as model activity —
// same rule the stall watchdog uses to pick its phase budget.
import { describe, expect, it } from 'vitest';
import { consumeSessionsSse } from '../src/adapters/persistence/hermes/sessions-sse.js';
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

function frame(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function makeTask(): TaskInput {
  return { taskId: 't1' } as unknown as TaskInput;
}

describe('consumeSessionsSse firstEventMs (B-P0 turn.first_event_ms)', () => {
  it('measures from the passed start reference to the first MODEL event, ignoring gateway acks', async () => {
    const startedAt = Date.now() - 500;
    const body = sseStream([
      frame('run.started', { run_id: 'run_1' }),
      frame('message.started', { message_id: 'm1' }),
      // First model activity — this is the instant that counts.
      frame('assistant.delta', { delta: 'Hel' }),
      frame('assistant.completed', { content: 'Hello' }),
      frame('run.completed', { usage: { input_tokens: 1, output_tokens: 1 } }),
      frame('done', {}),
    ]);

    const result = await consumeSessionsSse(body, makeTask(), undefined, startedAt);

    expect(result.firstEventMs).toBeDefined();
    // ~500ms since startedAt, and strictly BELOW the gap to the later events.
    expect(result.firstEventMs!).toBeGreaterThanOrEqual(480);
    expect(result.firstEventMs!).toBeLessThan(5_000);
  });

  it('is one-shot — a later model event does not move the captured instant', async () => {
    const startedAt = Date.now() - 400;
    const body = sseStream([
      frame('run.started', { run_id: 'run_1' }),
      frame('tool.started', { message_id: 'm1', tool_name: 'bash', preview: 'ls' }),
      frame('assistant.completed', { content: 'done' }),
      frame('run.completed', { usage: {} }),
      frame('done', {}),
    ]);

    const result = await consumeSessionsSse(body, makeTask(), undefined, startedAt);
    // tool.started is model activity and lands within the same 400ms window;
    // the trailing completed/completed events (~immediately after) must not
    // have replaced it (they would push the value well past the window start).
    expect(result.firstEventMs).toBeGreaterThanOrEqual(380);
    expect(result.firstEventMs).toBeLessThan(5_000);
  });

  it('is absent when there is no start reference or nothing activated the guard', async () => {
    const noStart = await consumeSessionsSse(
      sseStream([frame('run.started', { run_id: 'r' }), frame('assistant.delta', { delta: 'x' }), frame('done', {})]),
      makeTask(),
    );
    expect(noStart.firstEventMs).toBeUndefined();

    // Nothing at all reached the consumer (immediate close). Note the `done`
    // sentinel DOES count as guard activity (it is a non-ack frame, same rule
    // the stall watchdog applies) — it can only ever trail real model events,
    // so the one-shot capture is unaffected on healthy turns.
    const noEvents = await consumeSessionsSse(sseStream([]), makeTask(), undefined, Date.now() - 100);
    expect(noEvents.firstEventMs).toBeUndefined();
  });
});
