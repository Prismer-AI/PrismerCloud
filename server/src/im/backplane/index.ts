/**
 * Prismer IM — Backplane factory + re-exports
 *
 * Spec: docs/release200/14-messaging-state-machine-reliability.md §4.5
 *
 * Usage:
 *   const backplane = createBackplane({ redis });
 *
 * Selector logic:
 *   env BACKPLANE=memory → InMemoryBackplane
 *   env BACKPLANE=redis  → RedisBackplane (requires `redis` arg)
 *   default              → redis if NODE_ENV=production else memory
 *
 * The factory is intentionally NOT a singleton — server.ts owns the
 * lifecycle and passes the instance to consumers (RoomManager, etc.).
 */

import type Redis from 'ioredis';
import { InMemoryBackplane } from './memory-backplane';
import { RedisBackplane } from './redis-backplane';
import type { Backplane } from './backplane';

export type { Backplane, BackplaneEnqueueOpts, BackplaneStreamMessage } from './backplane';
export { getPodId, userPodsKey, podStreamKey } from './backplane';
export { RedisBackplane } from './redis-backplane';
export { InMemoryBackplane } from './memory-backplane';

export interface CreateBackplaneOpts {
  /** Required for Redis mode; ignored in memory mode. */
  redis?: Redis;
  /** Override env-based selection. */
  mode?: 'redis' | 'memory';
}

export function createBackplane(opts: CreateBackplaneOpts = {}): Backplane {
  const mode = opts.mode ?? resolveMode();
  if (mode === 'memory') {
    console.log('[Backplane] mode=memory (single-process)');
    return new InMemoryBackplane();
  }
  if (!opts.redis) {
    console.warn('[Backplane] BACKPLANE=redis but no redis client given — falling back to memory');
    return new InMemoryBackplane();
  }
  console.log('[Backplane] mode=redis (multi-instance)');
  return new RedisBackplane(opts.redis);
}

function resolveMode(): 'redis' | 'memory' {
  const env = (process.env.BACKPLANE || '').toLowerCase();
  if (env === 'redis' || env === 'memory') return env;
  return process.env.NODE_ENV === 'production' ? 'redis' : 'memory';
}
