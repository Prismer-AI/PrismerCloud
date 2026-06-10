// release202 — unit proof that the sessions SSE consumer surfaces a
// `clarify.request` event (Hermes native clarify) without tearing down the
// stream, so the run resumes in-place after the daemon forwards the answer.
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

describe('consumeSessionsSse clarify.request (release202)', () => {
  it('surfaces clarify {clarifyId,question,choices,runId}, keeps stream open, completes', async () => {
    const progress: Array<Record<string, unknown>> = [];
    const phases: string[] = [];
    const task = {
      taskId: 't1',
      onProgress: (p: { detail?: Record<string, unknown> }) => {
        if (p.detail) progress.push(p.detail);
      },
      heartbeat: { setPhase: (ph: string) => phases.push(ph), touchStep: () => {} },
    } as unknown as TaskInput;

    const body = sseStream([
      frame('run.started', { run_id: 'run_abc' }),
      frame('message.started', { message: { id: 'm1' } }),
      frame('tool.started', { tool_name: 'clarify', message_id: 'm1' }),
      frame('clarify.request', {
        run_id: 'run_abc',
        clarify_id: 'cl_123',
        question: 'Tea or coffee?',
        choices: ['Tea', 'Coffee'],
      }),
      frame('clarify.responded', { run_id: 'run_abc', clarify_id: 'cl_123' }),
      frame('assistant.completed', { content: 'FINAL CHOICE = Coffee' }),
      frame('run.completed', { usage: { input_tokens: 10, output_tokens: 5 } }),
      frame('done', {}),
    ]);

    const state = { approvalRequested: false, runId: null as string | null };
    const result = await consumeSessionsSse(body, task, state);

    // clarify surfaced with everything the resolve needs
    expect(result.clarify).toEqual({
      clarifyId: 'cl_123',
      question: 'Tea or coffee?',
      choices: ['Tea', 'Coffee'],
      runId: 'run_abc',
    });
    expect(state.clarifyRequested).toBe(true);
    expect(state.clarify?.clarifyId).toBe('cl_123');

    // surfaced via onProgress for the cloud to render an AskUserQuestion card
    const clarifyProgress = progress.find((d) => d.kind === 'clarify' && d.event === 'clarify.request');
    expect(clarifyProgress).toBeTruthy();
    expect(clarifyProgress?.question).toBe('Tea or coffee?');
    expect(clarifyProgress?.choices).toEqual(['Tea', 'Coffee']);

    // phase moved to waiting_user then back to running (NOT torn down)
    expect(phases).toContain('waiting_user');
    expect(phases).toContain('running');

    // stream fully consumed to completion — final assistant content captured
    expect(result.output).toBe('FINAL CHOICE = Coffee');
    expect(result.usage?.inputTokens).toBe(10);
  });
});
