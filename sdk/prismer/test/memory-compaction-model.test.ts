import { describe, expect, it } from 'vitest';

import { CloudClient } from '../src/auth.js';
import { compactSlice, type CompactionInput } from '../src/daemon/memory/compaction.js';

function input(model: string): CompactionInput {
  return {
    slice: [{ messageId: 'message_1', line: '@user: durable project decision' }],
    conversationType: 'direct',
    model,
    traceId: 'trace_1',
    runId: 'run_1',
  };
}

describe('Memory compaction execution-model authority', () => {
  it('uses the stamped execution model and refuses to invent one when absent', async () => {
    const models: string[] = [];
    const cloud = new CloudClient({
      baseUrl: 'http://cloud.test',
      apiKey: 'test-key',
      fetchImpl: async (_request, init) => {
        models.push((JSON.parse(String(init?.body)) as { model: string }).model);
        return new Response(
          JSON.stringify({
            content: [{ type: 'text', text: '{"summary":"bounded projection","salientFacts":{}}' }],
            stop_reason: 'end_turn',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    const positive = await compactSlice(input('served-model'), { cloud });
    expect(positive.error).toBeNull();
    expect(models).toEqual(['served-model']);

    const negative = await compactSlice(input(''), { cloud });
    expect(negative).toMatchObject({
      summary: '',
      salientFacts: {},
      error: 'non_extractable:no_execution_model',
    });
    expect(models).toEqual(['served-model']);
  });
});
