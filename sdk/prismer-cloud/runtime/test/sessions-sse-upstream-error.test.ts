// release202/12 — proof that an exhausted upstream LLM call (hermes serializes
// it into assistant.completed content) is detected and surfaced via
// `upstreamError`, so the dispatcher turns it into a FAILED result instead of a
// fake-successful task. Also guards against false-positives: a real reply that
// merely mentions the phrase mid-stream must NOT be flagged.
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

const task = { taskId: 't1' } as unknown as TaskInput;

describe('consumeSessionsSse upstream-error detection (release202/12)', () => {
  it('flags a provider-chain-unconfigured failure by message wording (hermes drops error.type)', async () => {
    // REAL hermes shape: `_summarize_provider_error` keeps only error.message +
    // `HTTP <status>:` prefix; the JSON `type` (provider_chain_unconfigured) is
    // DROPPED. So detection must key on the wording, not the machine token.
    const body = sseStream([
      frame('run.started', { run_id: 'run_x' }),
      frame('assistant.completed', {
        content:
          'API call failed after 3 retries: HTTP 503: Provider chain "deepseek" has no usable upstream source (deepseek: missing-key). Configure the source credentials.',
      }),
      frame('run.completed', { usage: {} }),
      frame('done', {}),
    ]);
    const result = await consumeSessionsSse(body, task);
    expect(result.upstreamError).toBeTruthy();
    expect(result.upstreamError?.status).toBe(503);
    expect(result.upstreamError?.message).toContain('has no usable upstream source');
  });

  it('flags the "Billing or credits exhausted" variant (HTTP 402 from the P1 gate)', async () => {
    // conversation_loop.py:3294 — FailoverReason.billing emits this prefix, NOT
    // "API call failed". Missing it reverts a 402 to a fake-successful task.
    const body = sseStream([
      frame('assistant.completed', { content: 'Billing or credits exhausted: HTTP 402: Insufficient credits' }),
      frame('done', {}),
    ]);
    const result = await consumeSessionsSse(body, task);
    expect(result.upstreamError).toBeTruthy();
    expect(result.upstreamError?.status).toBe(402);
  });

  it('flags the "Invalid API response after N retries" variant', async () => {
    const body = sseStream([
      frame('assistant.completed', { content: 'Invalid API response after 3 retries: HTTP 500: do request failed' }),
      frame('done', {}),
    ]);
    const result = await consumeSessionsSse(body, task);
    expect(result.upstreamError?.status).toBe(500);
  });

  it('does NOT flag a real reply that merely mentions the phrase (deltas present)', async () => {
    const body = sseStream([
      frame('assistant.delta', { delta: 'Here is my postmortem: ' }),
      frame('assistant.delta', { delta: 'the build said "API call failed after 3 retries: HTTP 500" — root cause was a stale key.' }),
      frame('assistant.completed', {
        content: 'Here is my postmortem: the build said "API call failed after 3 retries: HTTP 500" — root cause was a stale key.',
      }),
      frame('run.completed', { usage: { input_tokens: 10, output_tokens: 20 } }),
      frame('done', {}),
    ]);
    const result = await consumeSessionsSse(body, task);
    expect(result.upstreamError).toBeUndefined();
    expect(result.output).toContain('postmortem');
  });

  it('does NOT flag a normal successful completion', async () => {
    const body = sseStream([
      frame('assistant.delta', { delta: 'All done.' }),
      frame('assistant.completed', { content: 'All done.' }),
      frame('done', {}),
    ]);
    const result = await consumeSessionsSse(body, task);
    expect(result.upstreamError).toBeUndefined();
    expect(result.output).toBe('All done.');
  });
});
