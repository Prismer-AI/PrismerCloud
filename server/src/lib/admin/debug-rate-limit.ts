/**
 * Phase E3 of the v2.1 debug pipeline (docs/release201/06-debug-pipeline-design.md §5.4).
 *
 * Simple in-memory token bucket per admin email — 30 requests / minute / email
 * across ALL `/api/sandboxes/_admin/*` debug routes. Deliberately NOT shared
 * with `src/lib/rate-limit.ts` (which is per-action-per-user with bespoke
 * limits like billing/topup=5); the debug pipeline is one logical surface that
 * a single operator hits in bursts, so one counter per email is the right
 * granularity. Falls back to the source IP / "anonymous" sentinel when no
 * email is available (dev mode short-circuit + future API-key paths).
 *
 * In-memory only — no Redis dep, no cross-pod aggregation. v1 cloud is single
 * pod per env so this is fine; multi-pod prod would need Redis but that's an
 * infra decision outside this design (per the §9 risk note R1).
 *
 * Usage from a route handler:
 *
 *   const rl = checkRateLimit(session?.user?.email);
 *   if (!rl.allowed) return rateLimitResponse(rl);
 *   const res = NextResponse.json({ ... });
 *   return withRateLimitHeaders(res, rl);
 */

import { NextResponse } from 'next/server';

const WINDOW_MS = 60_000; // 1 minute
const LIMIT_PER_WINDOW = 30; // 30 req / min / email — design §5.4

interface BucketEntry {
  count: number;
  windowStart: number; // epoch-ms of the current window's start
}

// Per-email (or anonymous-sentinel) buckets. Pure in-memory — no Redis.
const BUCKETS = new Map<string, BucketEntry>();

// Reap entries whose window expired > 2× WINDOW_MS ago so the map doesn't
// grow unbounded across long-running pods. unref() so the timer never blocks
// process exit (tsx --test, Next.js dev restart, etc.).
const CLEANUP_TIMER = setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS * 2;
  for (const [key, entry] of BUCKETS) {
    if (entry.windowStart < cutoff) BUCKETS.delete(key);
  }
}, 120_000);
if (typeof CLEANUP_TIMER.unref === 'function') CLEANUP_TIMER.unref();

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number; // epoch-ms when this window ends
  retryAfterMs?: number; // populated when !allowed
}

/**
 * Pure helper — exported so unit tests can pin the clock.
 */
function currentWindowStart(now: number): number {
  return Math.floor(now / WINDOW_MS) * WINDOW_MS;
}

/**
 * Check + consume one request for `key` (admin email; fallback sentinel).
 *
 * Fixed-window counter, NOT a true token bucket — but the API name keeps the
 * door open for a leaky-bucket upgrade later without touching call sites.
 *
 * - `allowed=false` means the caller MUST respond 429; counter is NOT
 *   incremented on a denied request, so a quiet client can recover without
 *   counting failed attempts against the next window.
 */
export function checkRateLimit(emailOrNull: string | null | undefined): RateLimitResult {
  const key = (emailOrNull ?? 'anonymous').toLowerCase();
  const now = Date.now();
  const windowStart = currentWindowStart(now);
  const resetAt = windowStart + WINDOW_MS;

  let bucket = BUCKETS.get(key);
  if (!bucket || bucket.windowStart !== windowStart) {
    bucket = { count: 0, windowStart };
    BUCKETS.set(key, bucket);
  }

  if (bucket.count >= LIMIT_PER_WINDOW) {
    return {
      allowed: false,
      limit: LIMIT_PER_WINDOW,
      remaining: 0,
      resetAt,
      retryAfterMs: Math.max(0, resetAt - now),
    };
  }

  bucket.count += 1;
  return {
    allowed: true,
    limit: LIMIT_PER_WINDOW,
    remaining: Math.max(0, LIMIT_PER_WINDOW - bucket.count),
    resetAt,
  };
}

/**
 * Standard `X-RateLimit-*` headers. Applied to BOTH 2xx and 429 responses.
 *
 * `X-RateLimit-Reset` follows GitHub's convention — epoch seconds (NOT ms).
 */
export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(Math.ceil(result.resetAt / 1000)),
  };
}

/**
 * Mutate-and-return the response with rate-limit headers attached.
 * Convenience for the success path inside a route handler.
 */
export function withRateLimitHeaders<T extends Response>(response: T, result: RateLimitResult): T {
  const headers = rateLimitHeaders(result);
  for (const [k, v] of Object.entries(headers)) {
    response.headers.set(k, v);
  }
  return response;
}

/**
 * Standard 429 response. Body uses the exact shape documented in Phase E3:
 *
 *   { error: "rate_limited", message: "30/min per admin", retryAfterMs: 12345 }
 *
 * Plus `Retry-After` header in SECONDS (HTTP-standard, integer).
 */
export function rateLimitResponse(result: RateLimitResult): NextResponse {
  const retryAfterMs = result.retryAfterMs ?? Math.max(0, result.resetAt - Date.now());
  const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return NextResponse.json(
    {
      error: 'rate_limited',
      message: `${LIMIT_PER_WINDOW}/min per admin`,
      retryAfterMs,
    },
    {
      status: 429,
      headers: {
        ...rateLimitHeaders(result),
        'Retry-After': String(retryAfterSec),
      },
    },
  );
}

/**
 * Test-only — clear all buckets so a test run starts from zero. Not exported
 * via the public design surface, but `__resetForTests` keeps it discoverable.
 */
export function __resetForTests(): void {
  BUCKETS.clear();
}
