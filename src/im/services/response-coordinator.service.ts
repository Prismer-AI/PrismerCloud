/**
 * Prismer IM — Response Coordinator Service
 *
 * Prevents multiple agents from responding to the same message simultaneously.
 * Uses distributed locking (Redis) with fallback to in-memory for development.
 */

import type Redis from 'ioredis';

export interface ResponseLock {
  messageId: string;
  agentId: string;
  acquiredAt: number;
  expiresAt: number;
}

export interface LockResult {
  acquired: boolean;
  holder?: string;
  reason?: string;
}

export class ResponseCoordinatorService {
  /** Redis key prefix for message locks */
  private readonly LOCK_PREFIX = 'im:msg:lock:';

  /** Default lock TTL in milliseconds (30 seconds) */
  private readonly DEFAULT_LOCK_TTL_MS = 30000;

  /** In-memory fallback when Redis is unavailable */
  private localLocks = new Map<string, ResponseLock>();

  constructor(private redis: Redis) {}

  /**
   * Check if Redis is available.
   */
  private isRedisAvailable(): boolean {
    return this.redis.status === 'ready';
  }

  /**
   * Try to acquire a response lock for a message.
   * Only one agent can hold the lock at a time.
   *
   * @param messageId - The message ID to lock
   * @param agentId - The agent trying to acquire the lock
   * @param ttlMs - Lock TTL in milliseconds (default: 30s)
   * @returns Lock result indicating success or failure
   */
  async tryAcquireLock(
    messageId: string,
    agentId: string,
    ttlMs = this.DEFAULT_LOCK_TTL_MS
  ): Promise<LockResult> {
    const lockKey = `${this.LOCK_PREFIX}${messageId}`;
    const now = Date.now();

    if (this.isRedisAvailable()) {
      try {
        // Use Redis SET with NX and PX for atomic lock acquisition
        const result = await this.redis.set(
          lockKey,
          JSON.stringify({ agentId, acquiredAt: now }),
          'PX',
          ttlMs,
          'NX'
        );

        if (result === 'OK') {
          return { acquired: true };
        }

        // Lock already held by someone
        const existing = await this.redis.get(lockKey);
        if (existing) {
          const lockData = JSON.parse(existing);
          return {
            acquired: false,
            holder: lockData.agentId,
            reason: `Lock held by ${lockData.agentId}`,
          };
        }

        return { acquired: false, reason: 'Lock acquisition failed' };
      } catch (err) {
        console.warn('[ResponseCoordinator] Redis error, falling back to local:', (err as Error).message);
        // Fall through to local lock
      }
    }

    // In-memory fallback
    const existingLock = this.localLocks.get(messageId);

    // Check if existing lock is expired
    if (existingLock && existingLock.expiresAt > now) {
      return {
        acquired: false,
        holder: existingLock.agentId,
        reason: `Lock held by ${existingLock.agentId}`,
      };
    }

    // Acquire local lock
    this.localLocks.set(messageId, {
      messageId,
      agentId,
      acquiredAt: now,
      expiresAt: now + ttlMs,
    });

    return { acquired: true };
  }

  /**
   * Release a response lock.
   * Only the agent holding the lock can release it.
   *
   * @param messageId - The message ID to unlock
   * @param agentId - The agent releasing the lock
   * @returns Whether the lock was released
   */
  async releaseLock(messageId: string, agentId: string): Promise<boolean> {
    const lockKey = `${this.LOCK_PREFIX}${messageId}`;

    if (this.isRedisAvailable()) {
      try {
        // Use Lua script for atomic check-and-delete
        const script = `
          local current = redis.call('GET', KEYS[1])
          if current then
            local data = cjson.decode(current)
            if data.agentId == ARGV[1] then
              redis.call('DEL', KEYS[1])
              return 1
            end
          end
          return 0
        `;

        const result = await this.redis.eval(script, 1, lockKey, agentId);
        return result === 1;
      } catch (err) {
        console.warn('[ResponseCoordinator] Redis error on release:', (err as Error).message);
        // Fall through to local
      }
    }

    // In-memory fallback
    const existingLock = this.localLocks.get(messageId);
    if (existingLock && existingLock.agentId === agentId) {
      this.localLocks.delete(messageId);
      return true;
    }

    return false;
  }

  /**
   * Check if a message is currently being handled.
   *
   * @param messageId - The message ID to check
   * @returns Lock info if locked, null otherwise
   */
  async getLockStatus(messageId: string): Promise<ResponseLock | null> {
    const lockKey = `${this.LOCK_PREFIX}${messageId}`;
    const now = Date.now();

    if (this.isRedisAvailable()) {
      try {
        const data = await this.redis.get(lockKey);
        if (data) {
          const lockData = JSON.parse(data);
          const ttl = await this.redis.pttl(lockKey);
          return {
            messageId,
            agentId: lockData.agentId,
            acquiredAt: lockData.acquiredAt,
            expiresAt: now + ttl,
          };
        }
        return null;
      } catch (err) {
        console.warn('[ResponseCoordinator] Redis error on status check:', (err as Error).message);
        // Fall through to local
      }
    }

    // In-memory fallback
    const lock = this.localLocks.get(messageId);
    if (lock && lock.expiresAt > now) {
      return lock;
    }

    // Clean up expired lock
    if (lock) {
      this.localLocks.delete(messageId);
    }

    return null;
  }

  /**
   * Check if a message is locked.
   */
  async isLocked(messageId: string): Promise<boolean> {
    const status = await this.getLockStatus(messageId);
    return status !== null;
  }

  /**
   * Extend the lock TTL (for long-running operations).
   *
   * @param messageId - The message ID
   * @param agentId - The agent holding the lock
   * @param ttlMs - New TTL in milliseconds
   */
  async extendLock(
    messageId: string,
    agentId: string,
    ttlMs = this.DEFAULT_LOCK_TTL_MS
  ): Promise<boolean> {
    const lockKey = `${this.LOCK_PREFIX}${messageId}`;
    const now = Date.now();

    if (this.isRedisAvailable()) {
      try {
        // Use Lua script for atomic check-and-extend
        const script = `
          local current = redis.call('GET', KEYS[1])
          if current then
            local data = cjson.decode(current)
            if data.agentId == ARGV[1] then
              redis.call('PEXPIRE', KEYS[1], ARGV[2])
              return 1
            end
          end
          return 0
        `;

        const result = await this.redis.eval(script, 1, lockKey, agentId, ttlMs.toString());
        return result === 1;
      } catch (err) {
        console.warn('[ResponseCoordinator] Redis error on extend:', (err as Error).message);
        // Fall through to local
      }
    }

    // In-memory fallback
    const lock = this.localLocks.get(messageId);
    if (lock && lock.agentId === agentId && lock.expiresAt > now) {
      lock.expiresAt = now + ttlMs;
      return true;
    }

    return false;
  }

  /**
   * Force release a lock (admin operation).
   * Use with caution - only for stuck locks.
   */
  async forceRelease(messageId: string): Promise<boolean> {
    const lockKey = `${this.LOCK_PREFIX}${messageId}`;

    if (this.isRedisAvailable()) {
      try {
        await this.redis.del(lockKey);
        return true;
      } catch (err) {
        console.warn('[ResponseCoordinator] Redis error on force release:', (err as Error).message);
      }
    }

    this.localLocks.delete(messageId);
    return true;
  }

  /**
   * Get all active locks (for monitoring).
   */
  async getActiveLocks(): Promise<ResponseLock[]> {
    const now = Date.now();

    if (this.isRedisAvailable()) {
      try {
        const keys = await this.redis.keys(`${this.LOCK_PREFIX}*`);
        const locks: ResponseLock[] = [];

        for (const key of keys) {
          const data = await this.redis.get(key);
          const ttl = await this.redis.pttl(key);

          if (data && ttl > 0) {
            const lockData = JSON.parse(data);
            const messageId = key.replace(this.LOCK_PREFIX, '');
            locks.push({
              messageId,
              agentId: lockData.agentId,
              acquiredAt: lockData.acquiredAt,
              expiresAt: now + ttl,
            });
          }
        }

        return locks;
      } catch (err) {
        console.warn('[ResponseCoordinator] Redis error on list:', (err as Error).message);
        // Fall through to local
      }
    }

    // In-memory fallback - clean up expired and return active
    const activeLocks: ResponseLock[] = [];
    for (const [messageId, lock] of this.localLocks) {
      if (lock.expiresAt > now) {
        activeLocks.push(lock);
      } else {
        this.localLocks.delete(messageId);
      }
    }

    return activeLocks;
  }

  /**
   * Clean up expired local locks (call periodically).
   */
  cleanupExpiredLocks(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [messageId, lock] of this.localLocks) {
      if (lock.expiresAt <= now) {
        this.localLocks.delete(messageId);
        cleaned++;
      }
    }

    return cleaned;
  }
}
