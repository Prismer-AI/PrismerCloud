/**
 * Auth Redis client — thin ioredis wrapper for src/lib/auth/*
 *
 * Uses REDIS_URL (or HOST/PORT/PASSWORD/DB env). Same conventions as the IM
 * server. Errors don't crash the app — rate-limit / verification-code paths
 * surface their own auth-level errors when redis ops fail.
 */

import Redis from 'ioredis';

function buildRedisUrl(): string {
  if (process.env.REDIS_URL) return process.env.REDIS_URL;
  const host = process.env.REDIS_HOST || 'localhost';
  const port = process.env.REDIS_PORT || '6379';
  const password = process.env.REDIS_PASSWORD || '';
  const db = process.env.REDIS_DB || '0';
  const auth = password ? `:${password}@` : '';
  return `redis://localhost:6379/${db}`;
}

const globalForAuthRedis = globalThis as unknown as { __authRedis?: Redis };

function getClient(): Redis {
  if (globalForAuthRedis.__authRedis) return globalForAuthRedis.__authRedis;

  // enableOfflineQueue: true (default) — queue ops until connection is up,
  // otherwise the first call after process boot races the TCP handshake and
  // rejects with "Stream isn't writeable".
  const client = new Redis(buildRedisUrl(), {
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => (times > 5 ? null : Math.min(times * 100, 2000)),
  });

  client.on('error', (err) => console.warn('[AuthRedis] Error (non-fatal):', err.message));

  globalForAuthRedis.__authRedis = client;
  return client;
}

export async function redisGet(key: string): Promise<string | null> {
  return getClient().get(key);
}

export async function redisSetex(key: string, seconds: number, value: string): Promise<void> {
  await getClient().setex(key, seconds, value);
}

export async function redisDel(key: string): Promise<void> {
  await getClient().del(key);
}

export async function redisExists(key: string): Promise<boolean> {
  const result = await getClient().exists(key);
  return result > 0;
}

/**
 * Atomic INCR + EXPIRE-on-first-hit. Use this for rate-limit/quota counters
 * to avoid the read-then-write race that lets concurrent callers bypass the
 * limit at boundaries.
 */
export async function redisIncrWithTtl(key: string, ttlSeconds: number): Promise<number> {
  const client = getClient();
  const n = await client.incr(key);
  if (n === 1) {
    // Only set TTL on the first increment in this window.
    await client.expire(key, ttlSeconds);
  }
  return n;
}

/**
 * Compatibility shim matching luminpulse's `redis` named-export interface
 * — keeps local-auth.ts import shape stable across the port.
 */
export const redis = {
  get: redisGet,
  setex: redisSetex,
  del: redisDel,
  exists: redisExists,
  incrWithTtl: redisIncrWithTtl,
} as const;

export default redis;
