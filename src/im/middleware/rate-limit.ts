/**
 * Hono middleware for rate limiting IM operations.
 * Uses atomic check-and-consume — no race condition between check and consume.
 */
import type { Context, Next } from 'hono';
import type { RateLimiterService } from '../services/rate-limiter.service';

export function createRateLimitMiddleware(rateLimiter: RateLimiterService, action: string) {
  return async (c: Context, next: Next) => {
    // Skip rate limiting entirely (test/dev only — DO NOT set in prod)
    if (process.env.DISABLE_RATE_LIMIT === 'true') {
      return next();
    }

    const user = c.get('user');
    if (!user?.imUserId) {
      return next(); // No user context — skip (pre-auth routes)
    }

    // RATE_LIMIT_MIN_TIER: Nacos-configurable floor tier for all users.
    // Safer than DISABLE_RATE_LIMIT — keeps limits active but raises the floor.
    // Example: RATE_LIMIT_MIN_TIER=2 → all users get at least tier 2 (50 tool_call/min)
    const minTier = parseInt(process.env.RATE_LIMIT_MIN_TIER || '0', 10) || 0;
    const trustTier = Math.max(user.trustTier ?? 0, minTier);

    // Check suspension — don't leak exact expiry time
    if (user.suspendedUntil && new Date(user.suspendedUntil) > new Date()) {
      return c.json(
        {
          ok: false,
          error: { code: 'SUSPENDED', message: 'Account is temporarily suspended. Contact support.' },
        },
        403,
      );
    }

    // Atomic check + consume in one call — no race condition
    const result = await rateLimiter.checkAndConsume(user.imUserId, action, trustTier);

    // Set standard rate limit headers on every response
    c.header('X-RateLimit-Limit', String(result.limit));
    c.header('X-RateLimit-Remaining', String(result.remaining));
    c.header('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));

    if (!result.allowed) {
      const retryAfter = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
      c.header('Retry-After', String(retryAfter));

      // Record violation (deduped internally — same type within 60s skipped)
      rateLimiter
        .recordViolation(user.imUserId, 'rate_limit', { action, limit: result.limit, tier: trustTier }, 'throttle')
        .catch(() => {});

      return c.json(
        {
          ok: false,
          error: {
            code: 'RATE_LIMITED',
            message: `Rate limit exceeded. Limit: ${result.limit}/min. Retry in ${retryAfter}s.`,
          },
        },
        429,
      );
    }

    return next();
  };
}
