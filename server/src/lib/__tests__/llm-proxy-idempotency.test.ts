/**
 * Cleanup-2 — LLM-call-level idempotency cache.
 *
 * The proxy reads `X-Prismer-Idempotency-Key`, looks up Redis (`llm-cache:<key>`),
 * and either replays the cached SSE chunks / JSON body or forwards to upstream
 * and persists the response on `done`. These tests pin the contract of the
 * cache helpers and the cache-hit response shape (status 200, replayed
 * chunks in order, `x-prismer-cache: hit` header for diagnostics).
 *
 * We don't stand up a real Redis — the helpers are stubbed via vi.mock on
 * `ioredis`. The upstream-forwarding path is covered indirectly by checking
 * that serveCacheHit re-records usage with `cached=true` so finance can
 * filter cache hits out of the OpenAI spend tally.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub ioredis so the lazy getCacheRedis() never opens a real TCP socket.
// The in-memory map mimics SETEX/GET parity for the slice of behaviour we
// test (no TTL eviction, no clustering — the proxy's contract is just
// "write-then-read returns the same JSON").
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

// Stub usage-recorder so we can observe `cached=true` propagation without
// hitting the DB. recordUsageBackground is the only function the proxy calls
// on the cache-hit path.
const recordedCalls: Array<{ task_id: string; value: string }> = [];
vi.mock('@/lib/usage-recorder', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    recordUsageBackground: vi.fn((record: { task_id: string; input: { value: string } }) => {
      recordedCalls.push({ task_id: record.task_id, value: record.input.value });
    }),
  };
});

beforeEach(() => {
  recordedCalls.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('llm-proxy idempotency cache', () => {
  it('round-trips a non-streaming entry through readCache/writeCache', async () => {
    const { __test } = await import('@/lib/llm-proxy');
    const key = 'llm:abc123';

    expect(await __test.readCache(key)).toBeNull();

    await __test.writeCache(key, {
      status: 200,
      isStreaming: false,
      contentType: 'application/json',
      body: '{"choices":[{"message":{"content":"hi"}}]}',
      usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
      model: 'gpt-4',
      cachedAt: '2026-05-25T00:00:00.000Z',
      upstream: 'gpt-4',
    });

    const got = await __test.readCache(key);
    expect(got).not.toBeNull();
    expect(got!.body).toContain('hi');
    expect(got!.usage?.totalTokens).toBe(7);
  });

  it('round-trips a streaming entry preserving chunk order', async () => {
    const { __test } = await import('@/lib/llm-proxy');
    const key = 'llm:stream1';
    const chunks = [
      'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    await __test.writeCache(key, {
      status: 200,
      isStreaming: true,
      contentType: 'text/event-stream; charset=utf-8',
      chunks,
      usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
      model: 'kimi',
      cachedAt: '2026-05-25T00:00:00.000Z',
      upstream: 'kimi',
    });
    const got = await __test.readCache(key);
    expect(got!.chunks).toEqual(chunks);
  });

  it('serveCacheHit replays SSE chunks in order with cache-hit header', async () => {
    const { __test } = await import('@/lib/llm-proxy');
    const fakeGuard = {
      auth: { userId: 'u1', authHeader: 'Bearer t', source: 'jwt', userEmail: null },
    } as unknown as Parameters<typeof __test.serveCacheHit>[1];

    const res = __test.serveCacheHit(
      {
        status: 200,
        isStreaming: true,
        contentType: 'text/event-stream; charset=utf-8',
        chunks: [
          'data: {"delta":"a"}\n\n',
          'data: {"delta":"b"}\n\n',
          'data: [DONE]\n\n',
        ],
        usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
        model: 'gpt-4',
        cachedAt: '2026-05-25T00:00:00.000Z',
        upstream: 'gpt-4',
      },
      fakeGuard,
      '/v1/chat/completions',
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('x-prismer-cache')).toBe('hit');
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');

    const text = await new Response(res.body).text();
    expect(text).toBe(
      'data: {"delta":"a"}\n\ndata: {"delta":"b"}\n\ndata: [DONE]\n\n',
    );

    // Billing pass-through: usage record gets a `cached=true` marker so
    // finance can subtract these from the real OpenAI spend tally.
    expect(recordedCalls.length).toBe(1);
    expect(recordedCalls[0].value).toContain('cached=true');
    expect(recordedCalls[0].task_id).toMatch(/^llm-cached_/);
  });

  it('usageForCache normalises snake_case + camelCase upstream shapes', async () => {
    const { __test } = await import('@/lib/llm-proxy');
    expect(
      __test.usageForCache({
        prompt_tokens: 1,
        completion_tokens: 2,
        total_tokens: 3,
      } as unknown as Parameters<typeof __test.usageForCache>[0]),
    ).toEqual({ promptTokens: 1, completionTokens: 2, totalTokens: 3 });
    expect(
      __test.usageForCache({
        promptTokens: 10,
        completionTokens: 20,
      } as unknown as Parameters<typeof __test.usageForCache>[0]),
    ).toEqual({ promptTokens: 10, completionTokens: 20, totalTokens: undefined });
    expect(__test.usageForCache(undefined)).toBeUndefined();
  });
});
