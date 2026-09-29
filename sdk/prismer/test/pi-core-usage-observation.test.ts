import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels, createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { expect, it } from 'vitest';
import { PiAgentCoreClient } from '../src/adapters/runtime-engine/pi-core/agent.js';

it('counts each completed model call once across streaming updates and retains cache writes', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-usage-'));
  writeFileSync(join(cwd, 'probe.txt'), 'measured');
  const models = createModels();
  const faux = fauxProvider({ provider: 'faux', api: 'faux', models: [{ id: 'test', name: 'test' }], tokensPerSecond: 0 });
  models.setProvider(faux.provider);
  const first = fauxAssistantMessage(fauxToolCall('read', { path: 'probe.txt' }), { stopReason: 'toolUse' });
  first.usage = { input: 10, output: 3, cacheRead: 20, cacheWrite: 5, totalTokens: 38,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } };
  const second = fauxAssistantMessage('a sufficiently long response with several streamed deltas');
  second.usage = { input: 7, output: 11, cacheRead: 30, cacheWrite: 2, totalTokens: 50,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.02 } };
  faux.setResponses([first, second]);
  // Faux deliberately estimates usage itself. Substitute deterministic measured
  // usage at the provider stream boundary, retaining real agent/tool execution.
  const streamSimple = models.streamSimple.bind(models);
  let calls = 0;
  models.streamSimple = (...args) => {
    const upstream = streamSimple(...args);
    const stream = createAssistantMessageEventStream();
    const usage = calls++ === 0 ? first.usage : second.usage;
    void (async () => {
      for await (const event of upstream) {
        if (event.type === 'done') event.message.usage = usage;
        stream.push(event);
      }
    })();
    return stream;
  };
  const session = await new PiAgentCoreClient({ models }).createSession({ provider: 'pi-core', cwd, model: 'faux/test' });
  const observations: unknown[] = [];
  session.subscribe(event => {
    if (event.type === 'model_call_observed') observations.push(event.call);
  });
  session.subscribe(event => {
    if (event.type === 'model_call_observed' || event.type === 'model_request_started') throw new Error('observer down');
  });
  try {
    const result = await session.run('Read probe.txt then reply.');
    expect(result.usage).toMatchObject({ inputTokens: 17, outputTokens: 14, cachedInputTokens: 50,
      cacheWriteTokens: 7, totalCostUsd: 0.03 });
    // Context occupancy is the last call's size, never cumulative spend.
    expect(result.usage?.contextWindowUsedTokens).toBe(50);
    expect(observations).toHaveLength(2);
    expect(observations[0]).toMatchObject({ sequence: 1, status: 'completed', source: 'pi-engine',
      usage: { inputTokens: 10, cachedInputTokens: 20, cacheWriteTokens: 5, outputTokens: 3 }, firstTextMs: null });
    expect(observations[1]).toMatchObject({ sequence: 2, status: 'completed',
      usage: { inputTokens: 7, cachedInputTokens: 30, cacheWriteTokens: 2, outputTokens: 11 },
      durationMs: expect.any(Number), firstTextMs: expect.any(Number) });
    faux.setResponses([second]);
    const next = await session.run('Reply again');
    expect(next.usage).toMatchObject({ inputTokens: 7, outputTokens: 11, cachedInputTokens: 30, cacheWriteTokens: 2 });
    second.usage.input = NaN;
    faux.setResponses([second]);
    const invalid = await session.run('Report malformed upstream usage');
    expect(invalid.usage?.inputTokens).toBeUndefined();
    faux.setResponses([() => { throw new Error('upstream unavailable'); }]);
    await expect(session.run('failed request')).rejects.toThrow('upstream unavailable');
    expect(observations.at(-1)).toMatchObject({ status: 'failed', usage: null });
    calls = 0;
    first.usage = undefined as never;
    second.usage.input = 7;
    faux.setResponses([first, second]);
    const incomplete = await session.run('One call has no usage');
    expect(incomplete.usage?.inputTokens).toBeUndefined();
    expect(incomplete.usage?.contextWindowUsedTokens).toBe(50);
  } finally {
    await session.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});
