/**
 * Cleanup-3 — Anthropic LLM-call-level idempotency cache.
 *
 * Mirrors `llm-proxy-idempotency.test.ts` for the Anthropic proxy. The
 * cache helpers (`readCache`, `writeCache`, `usageForCache`) now live in the
 * shared `llm-proxy-cache.ts` module — covered by the OpenAI-side test
 * already. Here we pin the Anthropic-specific contract:
 *   - serveCacheHit replays SSE chunks byte-for-byte in order
 *   - cache-hit billing carries `cached=true` and `task_type=llm_proxy_anthropic`
 *   - non-streaming hit returns the raw body verbatim
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub ioredis so the lazy getCacheRedis() never opens a real TCP socket.
class FakeRedis {
  store = new Map<string, string>();
  async get(key: string) {
    return this.store.get(key) ?? null;
  }
  async setex(key: string, _ttl: number, value: string) {
    this.store.set(key, value);
    return 'OK';
  }
  on() {}
}

let fake: FakeRedis;

vi.mock('ioredis', () => {
  return {
    default: vi.fn(() => {
      fake = new FakeRedis();
      return fake;
    }),
  };
});

// Stub usage-recorder so we can observe `cached=true` + task_type propagation
// without hitting the DB.
const recordedCalls: Array<{ task_id: string; task_type: string; value: string }> = [];
vi.mock('@/lib/usage-recorder', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    recordUsageBackground: vi.fn(
      (record: { task_id: string; task_type: string; input: { value: string } }) => {
        recordedCalls.push({
          task_id: record.task_id,
          task_type: record.task_type,
          value: record.input.value,
        });
      },
    ),
  };
});

beforeEach(() => {
  recordedCalls.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('llm-proxy-anthropic idempotency cache', () => {
  it('serveCacheHit replays Anthropic SSE chunks in order with cache-hit header', async () => {
    const { __test } = await import('@/lib/llm-proxy-anthropic');
    const fakeGuard = {
      auth: { userId: 'u1', authHeader: 'Bearer t', source: 'jwt', userEmail: null },
    } as unknown as Parameters<typeof __test.serveCacheHit>[1];

    // Anthropic SSE shape — message_start carries input_tokens + model,
    // content_block_delta carries text, message_delta carries output_tokens,
    // message_stop is terminal.
    const chunks = [
      'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-opus-4-7","usage":{"input_tokens":10}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];

    const res = __test.serveCacheHit(
      {
        status: 200,
        isStreaming: true,
        contentType: 'text/event-stream; charset=utf-8',
        chunks,
        usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
        model: 'claude-opus-4-7',
        cachedAt: '2026-05-25T00:00:00.000Z',
        upstream: 'claude-opus-4-7',
      },
      fakeGuard,
      '/v1/messages',
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('x-prismer-cache')).toBe('hit');
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');

    // Byte-for-byte replay — preserves event lines + double-newline framing.
    const text = await new Response(res.body).text();
    expect(text).toBe(chunks.join(''));

    // Billing pass-through: `cached=true` marker + correct task_type so
    // finance can subtract idempotency-cache hits from real Anthropic spend.
    expect(recordedCalls.length).toBe(1);
    expect(recordedCalls[0].task_type).toBe('llm_proxy_anthropic');
    expect(recordedCalls[0].value).toContain('cached=true');
    expect(recordedCalls[0].value).toContain('/v1/messages');
    expect(recordedCalls[0].task_id).toMatch(/^llm-cached_/);
  });

  it('serveCacheHit replays a non-streaming Anthropic body verbatim', async () => {
    const { __test } = await import('@/lib/llm-proxy-anthropic');
    const fakeGuard = {
      auth: { userId: 'u2', authHeader: 'Bearer t', source: 'jwt', userEmail: null },
    } as unknown as Parameters<typeof __test.serveCacheHit>[1];

    const body = JSON.stringify({
      id: 'msg_01',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-7',
      content: [{ type: 'text', text: 'hello' }],
      usage: { input_tokens: 7, output_tokens: 3 },
    });

    const res = __test.serveCacheHit(
      {
        status: 200,
        isStreaming: false,
        contentType: 'application/json',
        body,
        usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 },
        model: 'claude-opus-4-7',
        cachedAt: '2026-05-25T00:00:00.000Z',
        upstream: 'claude-opus-4-7',
      },
      fakeGuard,
      '/v1/messages',
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('x-prismer-cache')).toBe('hit');
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.text()).toBe(body);

    expect(recordedCalls.length).toBe(1);
    expect(recordedCalls[0].task_type).toBe('llm_proxy_anthropic');
    expect(recordedCalls[0].value).toContain('cached=true');
  });

  it('shared cache module round-trips an Anthropic streaming entry', async () => {
    // Confirms the Anthropic proxy can persist + replay via the shared
    // `llm-proxy-cache.ts` helpers — same Redis namespace as the OpenAI side.
    const { readCache, writeCache } = await import('@/lib/llm-proxy-cache');
    const key = 'llm:anthropic-stream-1';
    const chunks = [
      'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-opus-4-7","usage":{"input_tokens":2}}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":5}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];

    expect(await readCache(key)).toBeNull();

    await writeCache(key, {
      status: 200,
      isStreaming: true,
      contentType: 'text/event-stream; charset=utf-8',
      chunks,
      usage: { promptTokens: 2, completionTokens: 5, totalTokens: 7 },
      model: 'claude-opus-4-7',
      cachedAt: '2026-05-25T00:00:00.000Z',
      upstream: 'claude-opus-4-7',
    });

    const got = await readCache(key);
    expect(got).not.toBeNull();
    expect(got!.chunks).toEqual(chunks);
    expect(got!.usage?.totalTokens).toBe(7);
    expect(got!.model).toBe('claude-opus-4-7');
  });

  it('recordUsage stamps cached=true into input.value when cached flag is set', async () => {
    const { __test } = await import('@/lib/llm-proxy-anthropic');
    const fakeGuard = {
      auth: { userId: 'u3', authHeader: 'Bearer t', source: 'jwt', userEmail: null },
    } as unknown as Parameters<typeof __test.recordUsage>[0];

    __test.recordUsage(
      fakeGuard,
      'claude-opus-4-7',
      { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      '/v1/messages',
      true,
    );
    __test.recordUsage(
      fakeGuard,
      'claude-opus-4-7',
      { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      '/v1/messages',
      false,
    );

    expect(recordedCalls.length).toBe(2);
    expect(recordedCalls[0].value).toContain('cached=true');
    expect(recordedCalls[0].task_id).toMatch(/^llm-cached_/);
    expect(recordedCalls[1].value).not.toContain('cached=true');
    expect(recordedCalls[1].task_id).toMatch(/^llm_/);
  });
});
