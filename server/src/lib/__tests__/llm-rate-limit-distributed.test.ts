/**
 * release202/12 (P4) — cluster-wide LLM rate limiting.
 *
 * `checkLlmRateLimitDistributed` replaces the per-pod in-memory limiter on the
 * LLM-spend routes with an atomic Redis INCR + EXPIRE fixed-window so the limit
 * is the TOTAL across N replicas (not 30/min × N) and survives pod restarts.
 *
 * These tests pin two contracts:
 *   1. Within one window, the first `limit` calls are allowed and call N+1 is
 *      blocked (allowed=false, remaining=0, RateLimitResult shape intact).
 *   2. Fail-open: if the Redis client throws, the call must NOT hard-block —
 *      it degrades to the in-memory `checkRateLimit(userId, 'llm')`.
 *
 * The shared ioredis client is stubbed via `getCacheRedis` (we mock the
 * llm-proxy-cache module) so no real socket is opened.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// FakeRedis models the slice of behaviour the limiter uses via a MULTI
// pipeline: `multi().incr(key).expire(key,ttl).exec()` → [[null,count],[null,1]].
// `throwOnIncr` flips exec() into the Redis-down path (fail-open).
class FakeRedis {
  counters = new Map<string, number>();
  throwOnIncr = false;
  expireCalls = 0;
  multi() {
    const ops: Array<['incr', string] | ['expire', string, number]> = [];
    // Arrow functions keep `this` bound to the FakeRedis instance (no this-alias).
    const builder = {
      incr: (key: string) => {
        ops.push(['incr', key]);
        return builder;
      },
      expire: (key: string, ttl: number) => {
        ops.push(['expire', key, ttl]);
        return builder;
      },
      exec: async (): Promise<Array<[Error | null, unknown]>> => {
        if (this.throwOnIncr) throw new Error('ECONNREFUSED');
        return ops.map((op) => {
          if (op[0] === 'incr') {
            const next = (this.counters.get(op[1]) ?? 0) + 1;
            this.counters.set(op[1], next);
            return [null, next] as [Error | null, unknown];
          }
          this.expireCalls += 1;
          return [null, 1] as [Error | null, unknown];
        });
      },
    };
    return builder;
  }
}

let fake: FakeRedis;

vi.mock('@/lib/llm-proxy-cache', () => ({
  getCacheRedis: () => fake,
}));

let checkLlmRateLimitDistributed: typeof import('../rate-limit').checkLlmRateLimitDistributed;

beforeEach(async () => {
  fake = new FakeRedis();
  // Fresh module each test so the in-memory fallback counters (used in the
  // fail-open assertion) and the mock are wired cleanly.
  vi.resetModules();
  ({ checkLlmRateLimitDistributed } = await import('../rate-limit'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('checkLlmRateLimitDistributed', () => {
  const LIMIT = 30; // ACTION_LIMITS.llm — keep in sync with rate-limit.ts

  it('allows the first `limit` requests then blocks the next within a window', async () => {
    const userId = 'user-window';
    const results = [];
    for (let i = 0; i < LIMIT; i++) {
      results.push(await checkLlmRateLimitDistributed(userId));
    }
    // All `limit` calls allowed.
    expect(results.every((r) => r.allowed)).toBe(true);
    // Shape + remaining bookkeeping on the first and last allowed call.
    expect(results[0]).toMatchObject({ allowed: true, limit: LIMIT, remaining: LIMIT - 1 });
    expect(results[LIMIT - 1]).toMatchObject({ allowed: true, limit: LIMIT, remaining: 0 });
    expect(typeof results[0].resetAt).toBe('number');

    // The (limit+1)-th call is blocked.
    const blocked = await checkLlmRateLimitDistributed(userId);
    expect(blocked).toMatchObject({ allowed: false, limit: LIMIT, remaining: 0 });
    expect(typeof blocked.resetAt).toBe('number');
  });

  it('issues EXPIRE alongside every INCR in the pipeline (no TTL-less orphan)', async () => {
    const userId = 'user-ttl';
    await checkLlmRateLimitDistributed(userId);
    await checkLlmRateLimitDistributed(userId);
    await checkLlmRateLimitDistributed(userId);
    // EXPIRE is re-issued each hit (atomic with INCR) so a failed standalone
    // EXPIRE can never leave a TTL-less key; harmless re-issue on a minute bucket.
    expect(fake.expireCalls).toBe(3);
  });

  it('fails open to the in-memory limiter when Redis throws', async () => {
    fake.throwOnIncr = true;
    const userId = 'user-failopen';
    // Redis is down on every call → must not hard-block. The in-memory
    // fallback still permits the first `limit` requests.
    const r = await checkLlmRateLimitDistributed(userId);
    expect(r.allowed).toBe(true);
    expect(r.limit).toBe(LIMIT);

    // Drain the in-memory window: we already consumed 1, so LIMIT-1 more are
    // allowed, then the next is blocked — proving fail-open still enforces a
    // (per-pod) limit rather than allowing unbounded traffic.
    for (let i = 0; i < LIMIT - 1; i++) {
      const ok = await checkLlmRateLimitDistributed(userId);
      expect(ok.allowed).toBe(true);
    }
    const blocked = await checkLlmRateLimitDistributed(userId);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
  });
});
