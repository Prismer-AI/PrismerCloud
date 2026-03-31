/**
 * Prismer IM — Presence service
 *
 * Tracks online status using Redis for cross-instance consistency.
 * Falls back gracefully when Redis is unavailable (local dev mode).
 */

import type Redis from "ioredis";
import type { PresenceStatus, PresenceInfo } from "../types/index";

const PRESENCE_KEY_PREFIX = "im:presence:";
const PRESENCE_TTL = 300; // 5 minutes

export class PresenceService {
  // In-memory fallback when Redis unavailable
  private localCache = new Map<string, PresenceInfo>();

  constructor(private redis: Redis) {}

  private isRedisAvailable(): boolean {
    return this.redis.status === 'ready';
  }

  async setOnline(userId: string): Promise<void> {
    await this.setStatus(userId, "online");
  }

  async setOffline(userId: string): Promise<void> {
    const info: PresenceInfo = {
      userId,
      status: "offline",
      lastSeen: Date.now(),
    };

    if (!this.isRedisAvailable()) {
      this.localCache.set(userId, info);
      return;
    }

    try {
      const key = `${PRESENCE_KEY_PREFIX}${userId}`;
      await this.redis.set(key, JSON.stringify(info), "EX", PRESENCE_TTL);
      await this.redis.publish("im:presence", JSON.stringify(info));
    } catch (err) {
      this.localCache.set(userId, info);
    }
  }

  async setStatus(userId: string, status: PresenceStatus, device?: string): Promise<void> {
    const info: PresenceInfo = {
      userId,
      status,
      lastSeen: Date.now(),
      device,
    };

    if (!this.isRedisAvailable()) {
      this.localCache.set(userId, info);
      return;
    }

    try {
      const key = `${PRESENCE_KEY_PREFIX}${userId}`;
      if (status === "online" || status === "busy") {
        await this.redis.set(key, JSON.stringify(info));
      } else {
        await this.redis.set(key, JSON.stringify(info), "EX", PRESENCE_TTL);
      }
      await this.redis.publish("im:presence", JSON.stringify(info));
    } catch (err) {
      this.localCache.set(userId, info);
    }
  }

  async getStatus(userId: string): Promise<PresenceInfo | null> {
    if (!this.isRedisAvailable()) {
      return this.localCache.get(userId) ?? null;
    }

    try {
      const key = `${PRESENCE_KEY_PREFIX}${userId}`;
      const raw = await this.redis.get(key);
      if (!raw) return this.localCache.get(userId) ?? null;
      return JSON.parse(raw);
    } catch (err) {
      return this.localCache.get(userId) ?? null;
    }
  }

  async getMultipleStatus(userIds: string[]): Promise<Map<string, PresenceInfo>> {
    const result = new Map<string, PresenceInfo>();
    if (userIds.length === 0) return result;

    if (!this.isRedisAvailable()) {
      for (const id of userIds) {
        const info = this.localCache.get(id);
        if (info) result.set(id, info);
      }
      return result;
    }

    try {
      const pipeline = this.redis.pipeline();
      for (const id of userIds) {
        pipeline.get(`${PRESENCE_KEY_PREFIX}${id}`);
      }
      const values = await pipeline.exec();
      if (!values) return result;

      for (let i = 0; i < userIds.length; i++) {
        const [err, raw] = values[i] as [Error | null, string | null];
        if (!err && raw) {
          result.set(userIds[i], JSON.parse(raw));
        }
      }
    } catch (err) {
      // Fallback to local cache
      for (const id of userIds) {
        const info = this.localCache.get(id);
        if (info) result.set(id, info);
      }
    }
    return result;
  }

  async getOnlineUserIds(): Promise<string[]> {
    if (!this.isRedisAvailable()) {
      return Array.from(this.localCache.values())
        .filter(info => info.status === "online" || info.status === "busy")
        .map(info => info.userId);
    }

    try {
      const keys = await this.redis.keys(`${PRESENCE_KEY_PREFIX}*`);
      const online: string[] = [];

      if (keys.length === 0) return online;

      const pipeline = this.redis.pipeline();
      for (const key of keys) {
        pipeline.get(key);
      }
      const values = await pipeline.exec();
      if (!values) return online;

      for (let i = 0; i < keys.length; i++) {
        const [err, raw] = values[i] as [Error | null, string | null];
        if (!err && raw) {
          const info: PresenceInfo = JSON.parse(raw);
          if (info.status === "online" || info.status === "busy") {
            online.push(info.userId);
          }
        }
      }
      return online;
    } catch (err) {
      return Array.from(this.localCache.values())
        .filter(info => info.status === "online" || info.status === "busy")
        .map(info => info.userId);
    }
  }
}
