/**
 * Lightweight in-memory rate limiter for Next.js API routes.
 *
 * Uses fixed-window counters keyed by userId + action.
 * Designed to complement the IM layer's Redis-backed RateLimiterService.
 *
 * Usage in route handlers (after apiGuard):
 *   const rl = checkRateLimit(guard.auth.userId, 'search');
 *   if (!rl.allowed) return rateLimitResponse(rl);
 */
import { NextResponse } from 'next/server';
import { getCacheRedis } from '@/lib/llm-proxy-cache';
import { createModuleLogger } from '@/lib/logger';

const log = createModuleLogger('RateLimit');

const WINDOW_MS = 60_000; // 1 minute

// Limits per action (requests per minute)
const ACTION_LIMITS: Record<string, number> = {
  search: 30,
  content: 30,
  compress: 20,
  'compress/stream': 20,
  parse: 10,
  'billing/topup': 5,
  'billing/methods': 10,
  llm: 30,
  default: 60,
};

interface WindowEntry {
  count: number;
  windowStart: number;
}

const counters = new Map<string, WindowEntry>();

// Cleanup stale entries every 2 minutes
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of counters) {
    if (entry.windowStart + WINDOW_MS * 2 < now) counters.delete(key);
  }
}, 120_000);
if (cleanupTimer.unref) cleanupTimer.unref();

function currentWindow(): number {
  return Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
}

/**
 * Check and consume one request unit. Returns whether the request is allowed.
 */
export function checkRateLimit(userId: string, action: string): RateLimitResult {
  const limit = ACTION_LIMITS[action] ?? ACTION_LIMITS.default;
  const ws = currentWindow();
  const key = `${userId}:${action}:${ws}`;

  let entry = counters.get(key);
  if (!entry || entry.windowStart !== ws) {
    entry = { count: 0, windowStart: ws };
    counters.set(key, entry);
  }

  // Check before consume — don't inflate counter on already-denied requests
  if (entry.count >= limit) {
    return { allowed: false, remaining: 0, limit, resetAt: ws + WINDOW_MS };
  }
  entry.count++;
  const remaining = Math.max(0, limit - entry.count);
  return { allowed: true, remaining, limit, resetAt: ws + WINDOW_MS };
}

// Distributed (cluster-wide) LLM rate-limit window: minute-aligned bucket so
// every replica increments the same Redis key. Window length kept identical to
// the in-memory limiter (60s) so the 'llm' limit (ACTION_LIMITS.llm) is the
// TOTAL across the cluster, not per-pod.
const LLM_RL_KEY_PREFIX = 'llm-rl:';
const LLM_RL_WINDOW_SECONDS = WINDOW_MS / 1000; // 60

/**
 * Cluster-wide LLM rate limiter backed by the shared ioredis client.
 *
 * Atomic fixed-window via INCR + EXPIRE-on-first-hit. The key is namespaced by
 * userId and the minute bucket so all N replicas converge on a single counter
 * (fixes P4 — in-memory Map gives an effective limit of 30/min × N and resets
 * on pod restart).
 *
 * Fail-open: any Redis error degrades gracefully to the in-process
 * `checkRateLimit(userId, 'llm')`. A Redis blip must never hard-block LLM
 * traffic (rate-limit fail-open is safe — billing is the hard gate, not this).
 *
 * Returns the same {@link RateLimitResult} shape as `checkRateLimit`, so
 * `rateLimitResponse` / `withRateLimitHeaders` work unchanged.
 */
export async function checkLlmRateLimitDistributed(userId: string): Promise<RateLimitResult> {
  const limit = ACTION_LIMITS.llm ?? ACTION_LIMITS.default;
  const ws = currentWindow();
  const bucket = ws / WINDOW_MS; // minute bucket index
  const resetAt = ws + WINDOW_MS;
  const key = `${LLM_RL_KEY_PREFIX}${userId}:${bucket}`;

  try {
    const redis = getCacheRedis();
    // INCR + EXPIRE in ONE pipeline so the TTL is always issued alongside the
    // INCR. A standalone EXPIRE that failed after a successful INCR would leave
    // a TTL-less orphan key (the minute bucket rolls each window, so it'd never
    // be reused, just leak). Re-issuing EXPIRE every hit is harmless (the key
    // self-expires ~window after the last hit; counting is unaffected because
    // the bucket index changes each minute). No `NX` flag → Redis < 7 safe.
    const res = await redis
      .multi()
      .incr(key)
      .expire(key, LLM_RL_WINDOW_SECONDS + 1)
      .exec();
    const incrReply = res?.[0]; // [err, value]
    if (!incrReply || incrReply[0]) {
      throw incrReply?.[0] ?? new Error('rate-limit pipeline returned no INCR reply');
    }
    const count = Number(incrReply[1]);
    if (count > limit) {
      return { allowed: false, remaining: 0, limit, resetAt };
    }
    return { allowed: true, remaining: Math.max(0, limit - count), limit, resetAt };
  } catch (err) {
    log.warn(
      { userId, error: String(err) },
      'distributed LLM rate-limit unavailable — failing open to in-memory limiter',
    );
    return checkRateLimit(userId, 'llm');
  }
}

/**
 * Return standard rate-limit headers for any response (2xx or 429).
 */
export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(Math.ceil(result.resetAt / 1000)),
  };
}

/**
 * Attach rate-limit headers to an existing NextResponse (for 2xx responses).
 */
export function withRateLimitHeaders(response: NextResponse, result: RateLimitResult): NextResponse {
  const headers = rateLimitHeaders(result);
  for (const [key, value] of Object.entries(headers)) {
    response.headers.set(key, value);
  }
  return response;
}

/**
 * Build a 429 response with standard rate-limit headers.
 */
export function rateLimitResponse(result: RateLimitResult): NextResponse {
  const retryAfter = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
  return NextResponse.json(
    {
      success: false,
      error: {
        code: 'RATE_LIMITED',
        message: `Rate limit exceeded. Limit: ${result.limit}/min. Retry in ${retryAfter}s.`,
      },
    },
    {
      status: 429,
      headers: {
        ...rateLimitHeaders(result),
        'Retry-After': String(retryAfter),
      },
    },
  );
}
