/**
 * Rate Limiter — Redis-backed atomic counter per (userId, action, window).
 * Falls back to in-memory if Redis unavailable.
 *
 * Redis key: `rl:{userId}:{action}:{windowStart}`
 * Redis ops: INCR + EXPIRE (atomic, cross-pod consistent)
 */
import type Redis from 'ioredis';
import prisma from '../db';

// Rate limits per trust tier (requests per minute)
const TIER_LIMITS: Record<number, Record<string, number>> = {
  0: { 'message.send': 10, tool_call: 2, 'conversation.create': 2, 'agent.register': 1, 'file.upload': 2 },
  1: { 'message.send': 60, tool_call: 10, 'conversation.create': 10, 'agent.register': 5, 'file.upload': 10 },
  2: { 'message.send': 300, tool_call: 50, 'conversation.create': 30, 'agent.register': 10, 'file.upload': 30 },
  3: { 'message.send': 1000, tool_call: 200, 'conversation.create': 100, 'agent.register': 20, 'file.upload': 100 },
};

const WINDOW_MS = 60_000;
const WINDOW_SEC = 60;
const RL_PREFIX = 'rl:';

// In-memory fallback (only used when Redis is down)
const memCounters = new Map<string, { count: number; windowStart: number }>();

// Violation dedup (in-memory is fine — per-pod dedup is acceptable)
const recentViolations = new Map<string, number>();

function getLimit(tier: number, action: string): number {
  return (TIER_LIMITS[tier] ?? TIER_LIMITS[0])[action] ?? 60;
}

function currentWindow(): number {
  return Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;
}

export class RateLimiterService {
  private _redis: Redis | null;
  private _cleanupTimer: ReturnType<typeof setInterval>;

  constructor(redis?: Redis) {
    this._redis = redis ?? null;
    this._cleanupTimer = setInterval(() => this._cleanup().catch(() => {}), 120_000);
    if (this._cleanupTimer.unref) this._cleanupTimer.unref();

    if (this._redis) {
      console.log('[RateLimit] Using Redis-backed rate limiting (cross-pod consistent)');
    } else {
      console.log('[RateLimit] Using in-memory rate limiting (single-pod only)');
    }
  }

  destroy(): void {
    clearInterval(this._cleanupTimer);
  }

  /**
   * Atomically check AND consume one unit.
   * Redis: INCR is atomic — no race condition even across pods.
   * Fallback: in-memory counter (per-pod, not precise in multi-pod).
   */
  async checkAndConsume(
    userId: string,
    action: string,
    trustTier: number = 0,
  ): Promise<{
    allowed: boolean;
    remaining: number;
    limit: number;
    resetAt: number;
  }> {
    if (trustTier >= 4) {
      return { allowed: true, remaining: Infinity, limit: Infinity, resetAt: 0 };
    }

    const limit = getLimit(trustTier, action);
    const ws = currentWindow();
    const resetAt = ws + WINDOW_MS;

    let count: number;

    if (this._redis) {
      count = await this._redisIncr(userId, action, ws);
    } else {
      count = this._memIncr(userId, action, ws);
    }

    const allowed = count <= limit;
    const remaining = Math.max(0, limit - count);
    return { allowed, remaining, limit, resetAt };
  }

  /**
   * Check without consuming (read-only).
   */
  async peek(
    userId: string,
    action: string,
    trustTier: number = 0,
  ): Promise<{ remaining: number; limit: number; resetAt: number }> {
    if (trustTier >= 4) return { remaining: Infinity, limit: Infinity, resetAt: 0 };
    const limit = getLimit(trustTier, action);
    const ws = currentWindow();
    let count = 0;

    if (this._redis) {
      try {
        const val = await this._redis.get(`${RL_PREFIX}${userId}:${action}:${ws}`);
        count = val ? parseInt(val, 10) : 0;
      } catch {
        // fallback
        const entry = memCounters.get(`${userId}:${action}:${ws}`);
        count = entry && entry.windowStart === ws ? entry.count : 0;
      }
    } else {
      const entry = memCounters.get(`${userId}:${action}:${ws}`);
      count = entry && entry.windowStart === ws ? entry.count : 0;
    }

    return { remaining: Math.max(0, limit - count), limit, resetAt: ws + WINDOW_MS };
  }

  /**
   * Record a violation with dedup (same type within 60s → skip).
   */
  async recordViolation(userId: string, type: string, evidence: any, action: string = 'warn'): Promise<void> {
    const dedupKey = `${userId}:${type}`;
    const lastTime = recentViolations.get(dedupKey);
    if (lastTime && Date.now() - lastTime < 60_000) return;
    recentViolations.set(dedupKey, Date.now());

    try {
      await prisma.iMViolation.create({
        data: { imUserId: userId, type, evidence: JSON.stringify(evidence), action },
      });

      const user = await prisma.iMUser.update({
        where: { id: userId },
        data: { violationCount: { increment: 1 }, lastViolationAt: new Date() },
      });

      // Auto-demote: 3+ violations in 7 days
      if (user.violationCount >= 3 && user.trustTier > 0) {
        const recent = await prisma.iMViolation.count({
          where: { imUserId: userId, createdAt: { gte: new Date(Date.now() - 7 * 86_400_000) } },
        });
        if (recent >= 3) {
          await prisma.iMUser.update({
            where: { id: userId },
            data: { trustTier: Math.max(0, user.trustTier - 1) },
          });
          await prisma.iMViolation.create({
            data: {
              imUserId: userId,
              type: 'tier_demotion',
              evidence: JSON.stringify({ from: user.trustTier, to: user.trustTier - 1, reason: '3+ violations in 7d' }),
              action: 'demote',
            },
          });
          console.log(`[RateLimit] Demoted ${userId}: tier ${user.trustTier} → ${user.trustTier - 1}`);
        }
      }
    } catch (err) {
      console.error('[RateLimit] Violation record failed:', err);
    }
  }

  // ─── Redis atomic increment ─────────────────────────
  private async _redisIncr(userId: string, action: string, ws: number): Promise<number> {
    const key = `${RL_PREFIX}${userId}:${action}:${ws}`;
    try {
      // INCR is atomic — multiple pods calling INCR on same key get consistent count
      const count = await this._redis!.incr(key);
      // Set TTL on first increment (key didn't exist before)
      if (count === 1) {
        await this._redis!.expire(key, WINDOW_SEC + 5); // +5s buffer
      }
      return count;
    } catch {
      // Redis down — fall back to in-memory
      return this._memIncr(userId, action, ws);
    }
  }

  // ─── In-memory fallback ─────────────────────────────
  private _memIncr(userId: string, action: string, ws: number): number {
    const key = `${userId}:${action}:${ws}`;
    let entry = memCounters.get(key);
    if (!entry || entry.windowStart !== ws) {
      entry = { count: 0, windowStart: ws };
      memCounters.set(key, entry);
    }
    entry.count++;
    return entry.count;
  }

  // ─── Cleanup ────────────────────────────────────────
  private async _cleanup(): Promise<void> {
    const now = Date.now();
    // In-memory cleanup
    for (const [key, entry] of memCounters) {
      if (entry.windowStart + WINDOW_MS < now) memCounters.delete(key);
    }
    for (const [key, ts] of recentViolations) {
      if (now - ts > 120_000) recentViolations.delete(key);
    }
    // Redis keys auto-expire via TTL — no cleanup needed
    // DB cleanup (remove old rate limit records)
    try {
      await prisma.iMRateLimit.deleteMany({ where: { windowStart: { lt: new Date(now - 5 * WINDOW_MS) } } });
    } catch {
      /* best effort */
    }
  }
}
