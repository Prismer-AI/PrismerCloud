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
