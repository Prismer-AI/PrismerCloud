import { afterEach, describe, expect, it, vi } from 'vitest';

import { HermesSessionMapper } from '../src/adapters/persistence/hermes/sessions-mapper.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HermesSessionMapper model selection', () => {
  it('locks a new Hermes session to the configured model without reasserting provider identity', async () => {
    const writes: unknown[][] = [];
    const db = {
      prepare: vi.fn(() => ({
        run: (...args: unknown[]) => writes.push(args),
      })),
    };
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ object: 'session', session: { id: 'session-from-hermes' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const mapper = new HermesSessionMapper(db as never);
    const legacyRuntimeSelection = {
      model: 'deepseek-v4-flash',
      provider: 'prismer',
    };
    await mapper.createForConversation(
      'http://127.0.0.1:8642',
      'gateway-key',
      'conversation-1',
      'agent-1',
      'deputy-alice',
      'workspace-1',
      legacyRuntimeSelection,
    );

    const [, init] = fetchMock.mock.calls[0]!;
    const requestBody = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
    expect(requestBody).toEqual({
      model: 'deepseek-v4-flash',
      require_model_lock: true,
    });
    expect(requestBody.model).not.toBe('deputy-alice');

    // The profile still belongs in Prismer's durable mapping metadata; only the
    // Hermes LLM-model override is forbidden.
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('deputy-alice');
  });
});
