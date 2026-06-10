// Regression proof for the reasoning trace that vanished from agent messages
// when hermes dispatch migrated from /v1/runs (legacy consumeSse) to the
// sessions stream (consumeSessionsSse) in commit 2cdd2cad (2026-05-29). The
// deleted `reasoning.available` handler was the only thing feeding the model's
// thinking trace into recordReasoningChunk. On the sessions endpoint hermes
// remaps reasoning into a `tool.progress` event with tool_name '_thinking' and
// the text in `delta`; the /v1/runs path emits a direct `reasoning.available`
// with the text in `text`. Both must reach recordReasoningChunk.
import { describe, it, expect } from 'vitest';
import { consumeSessionsSse } from '../src/adapters/hermes/sessions-sse.js';
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

function makeTask(reasoning: string[], progress: Array<Record<string, unknown>>): TaskInput {
  return {
    taskId: 't1',
    onProgress: (p: { detail?: Record<string, unknown> }) => {
      if (p.detail) progress.push(p.detail);
    },
    recorder: {
      recordReasoningChunk: (text: string) => reasoning.push(text),
    },
    heartbeat: { setPhase: () => {}, touchStep: () => {} },
  } as unknown as TaskInput;
}

describe('consumeSessionsSse reasoning trace (regression: deleted 2cdd2cad)', () => {
  it('records reasoning from the sessions `tool.progress`/_thinking remap (delta field)', async () => {
    const reasoning: string[] = [];
    const progress: Array<Record<string, unknown>> = [];
    const task = makeTask(reasoning, progress);

    const body = sseStream([
      frame('run.started', { run_id: 'run_abc' }),
      // sessions emitter remaps reasoning.available → tool.progress + _thinking
      frame('tool.progress', { message_id: 'm1', tool_name: '_thinking', delta: 'Let me think step by step.' }),
      // a real tool progress event keeps using preview — still recorded
      frame('tool.progress', { message_id: 'm1', tool_name: 'bash', preview: 'partial stdout' }),
      frame('assistant.completed', { content: 'DONE' }),
      frame('run.completed', { usage: { input_tokens: 1, output_tokens: 1 } }),
      frame('done', {}),
    ]);

    const result = await consumeSessionsSse(body, task);

    expect(reasoning).toContain('Let me think step by step.');
    expect(reasoning).toContain('partial stdout');
    // reasoning surfaced as a kind:'reasoning' hint for the in-chat timeline
    const reasoningHint = progress.find((d) => d.kind === 'reasoning');
    expect(reasoningHint).toBeTruthy();
    expect(reasoningHint?.text).toBe('Let me think step by step.');
    expect(result.output).toBe('DONE');
  });

  it('records reasoning from a direct `reasoning.available` event (legacy text field)', async () => {
    const reasoning: string[] = [];
    const progress: Array<Record<string, unknown>> = [];
    const task = makeTask(reasoning, progress);

    const body = sseStream([
      frame('run.started', { run_id: 'run_xyz' }),
      frame('reasoning.available', { run_id: 'run_xyz', text: 'I should call the search tool.' }),
      frame('assistant.completed', { content: 'OK' }),
      frame('run.completed', { usage: {} }),
      frame('done', {}),
    ]);

    await consumeSessionsSse(body, task);

    expect(reasoning).toContain('I should call the search tool.');
    const reasoningHint = progress.find((d) => d.kind === 'reasoning' && d.event === 'reasoning.available');
    expect(reasoningHint?.text).toBe('I should call the search tool.');
  });

  it('does not record empty reasoning (guards empty delta / text)', async () => {
    const reasoning: string[] = [];
    const progress: Array<Record<string, unknown>> = [];
    const task = makeTask(reasoning, progress);

    const body = sseStream([
      frame('tool.progress', { message_id: 'm1', tool_name: '_thinking', delta: '' }),
      frame('reasoning.available', { text: '' }),
      frame('done', {}),
    ]);

    await consumeSessionsSse(body, task);

    expect(reasoning).toHaveLength(0);
    expect(progress.find((d) => d.kind === 'reasoning')).toBeUndefined();
  });
});
