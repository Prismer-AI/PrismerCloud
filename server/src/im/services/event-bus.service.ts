/**
 * Prismer IM — Event Bus Service
 *
 * Event subscription matching and delivery.
 * Agents subscribe to platform events and receive notifications via message, webhook, or sync.
 */

import { createHmac } from 'crypto';
import type Redis from 'ioredis';
import prisma from '../db';
import type { RoomManager } from '../ws/rooms';
import type { SyncService } from './sync.service';
import type { PlatformEvent, CreateSubscriptionInput, SubscriptionFilter } from '../types';
import { createModuleLogger } from '../../lib/logger';

const log = createModuleLogger('EventBus');
const MAX_FAILURE_COUNT = 10;
const COOLDOWN_PREFIX = 'sub:cooldown:';
/** Max entries in the in-memory fallback map before eviction */
const MAX_COOLDOWN_ENTRIES = 10_000;

// SSRF protection: block private/loopback/link-local IPs and non-HTTPS in production
const BLOCKED_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);
const PRIVATE_IP_RE = /^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|169\.254\.|fc00:|fe80:|fd[0-9a-f]{2}:)/i;

function validateWebhookUrl(url: string): { valid: boolean; error?: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }

  // Must be HTTP(S)
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { valid: false, error: 'URL must use http or https protocol' };
  }

  // Block private hosts
  if (BLOCKED_HOSTS.has(parsed.hostname)) {
    return { valid: false, error: 'Webhook URL cannot point to localhost or loopback' };
  }

  // Block private IP ranges
  if (PRIVATE_IP_RE.test(parsed.hostname)) {
    return { valid: false, error: 'Webhook URL cannot point to private network addresses' };
  }

  // In production, require HTTPS
  if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
    return { valid: false, error: 'Webhook URL must use HTTPS in production' };
  }

  return { valid: true };
}

export interface EventBusServiceDeps {
  rooms: RoomManager;
  syncService?: SyncService;
  redis?: Redis;
}

export class EventBusService {
  private deps: EventBusServiceDeps;
  private _redis: Redis | null;
  /**
   * In-memory cooldown fallback — used when Redis is unavailable.
   * Entries are evicted when the map exceeds MAX_COOLDOWN_ENTRIES.
   */
  private cooldownMap = new Map<string, number>();

  constructor(deps: EventBusServiceDeps) {
    this.deps = deps;
    this._redis = deps.redis ?? null;
    if (this._redis) {
      log.info('Using Redis-backed cooldown (cross-pod consistent)');
    } else {
      log.info('Using in-memory cooldown (single-pod only)');
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Event Publishing
  // ═══════════════════════════════════════════════════════════

  /**
   * Publish an event to all matching subscriptions.
   * Queries active subscriptions, matches event type + filter, delivers.
   */
  async publish(event: PlatformEvent): Promise<void> {
    try {
      // Pre-filter by event type prefix in DB to avoid full table scan.
      // Match subscriptions whose events JSON contains the event type or its prefix.
      // e.g., event "task.created" → search for subs containing "task." or "task.created" or "*"
      const eventPrefix = event.type.split('.')[0]; // "task.created" → "task"
      // Pre-filter by event type in DB to avoid loading all subscriptions.
      // Uses text search on the JSON events field — superset of matches.
      // Precise glob matching happens in matchEventType() below.
      const subscriptions = await prisma.iMSubscription.findMany({
        where: {
          active: true,
          AND: [
            { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
            {
              OR: [
                { events: { contains: `"${event.type}"` } },
                { events: { contains: `"${eventPrefix}.*"` } },
                { events: { contains: '"*"' } },
              ],
            },
          ],
        },
      });

      let matched = 0;
      for (const sub of subscriptions) {
        const events = this.parseJson<string[]>(sub.events, []);
        if (!this.matchEventType(event.type, events)) continue;

        const filter = this.parseJson<SubscriptionFilter>(sub.filter, {});
        if (!this.matchFilter(event.data, filter)) continue;

        // Cooldown check (Redis-backed for cross-pod consistency, in-memory fallback)
        if (sub.minIntervalMs > 0) {
          const cooldownKey = `${sub.id}:${event.type}`;
          const inCooldown = await this._checkCooldown(cooldownKey, sub.minIntervalMs);
          if (inCooldown) {
            continue;
          }
        }

        // Deliver (fire-and-forget per subscription)
        this.deliver(sub, event).catch((err) =>
          log.warn(`Delivery failed for sub ${sub.id}: ${(err as Error).message}`),
        );
        matched++;
      }

      if (matched > 0) {
        log.info(`Published ${event.type} → ${matched} subscription(s)`);
      }
    } catch (err) {
      log.error(`Publish error: ${(err as Error).message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Delivery
  // ═══════════════════════════════════════════════════════════

  private async deliver(
    sub: {
      id: string;
      subscriberId: string;
      delivery: string;
      webhookUrl: string | null;
      webhookSecret: string | null;
      timeoutMs: number;
      minIntervalMs: number;
    },
    event: PlatformEvent,
  ): Promise<void> {
    const payload = {
      source: 'prismer_im',
      event: event.type,
      timestamp: event.timestamp,
      data: event.data,
    };

    try {
      switch (sub.delivery) {
        case 'message':
          this.deliverMessage(sub.subscriberId, payload);
          break;

        case 'webhook':
          await this.deliverWebhook(sub, payload);
          break;

        case 'sync':
          await this.deliverSync(sub.subscriberId, payload);
          break;

        default:
          log.warn(`Unknown delivery type: ${sub.delivery}`);
          return;
      }

      // Success — update cooldown and reset failure count
      const cooldownKey = `${sub.id}:${event.type}`;
      await this._setCooldown(cooldownKey, sub.minIntervalMs);

      await prisma.iMSubscription.update({
        where: { id: sub.id },
        data: {
          lastTriggeredAt: new Date(),
          failureCount: 0,
        },
      });
    } catch (err) {
      log.error(`Delivery error for sub ${sub.id}: ${(err as Error).message}`);

      if (sub.delivery === 'webhook') {
        await this.incrementFailure(sub.id);
      }
    }
  }

  private deliverMessage(
    subscriberId: string,
    payload: { source: string; event: string; timestamp: number; data: Record<string, unknown> },
  ): void {
    this.deps.rooms.sendToUser(subscriberId, {
      type: 'event.subscription',
      payload,
      timestamp: Date.now(),
    });
  }

  private async deliverWebhook(
    sub: { id: string; webhookUrl: string | null; webhookSecret: string | null; timeoutMs: number },
    payload: { source: string; event: string; timestamp: number; data: Record<string, unknown> },
  ): Promise<void> {
    if (!sub.webhookUrl) {
      throw new Error('webhookUrl not configured');
    }

    // SSRF protection
    const urlCheck = validateWebhookUrl(sub.webhookUrl);
    if (!urlCheck.valid) {
      throw new Error(`Blocked webhook: ${urlCheck.error}`);
    }

    const body = JSON.stringify(payload);
    const signature = sub.webhookSecret ? createHmac('sha256', sub.webhookSecret).update(body).digest('hex') : '';

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Prismer-Event': payload.event,
      'User-Agent': 'Prismer-EventBus/1.7.3',
    };
    if (signature) {
      headers['X-Prismer-Signature'] = `sha256=${signature}`;
    }

    const response = await fetch(sub.webhookUrl, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(sub.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Webhook POST ${sub.webhookUrl} → ${response.status}`);
    }

    log.info(`Webhook POST ${sub.webhookUrl} → ${response.status}`);
  }

  private async deliverSync(
    subscriberId: string,
    payload: { source: string; event: string; timestamp: number; data: Record<string, unknown> },
  ): Promise<void> {
    if (!this.deps.syncService) {
      log.warn('Sync delivery requested but syncService not available');
      return;
    }

    await this.deps.syncService.writeEvent('event.subscription', payload, null, subscriberId);
  }

  private async incrementFailure(subId: string): Promise<void> {
    try {
      const updated = await prisma.iMSubscription.update({
        where: { id: subId },
        data: { failureCount: { increment: 1 } },
      });

      if (updated.failureCount >= MAX_FAILURE_COUNT) {
        await prisma.iMSubscription.update({
          where: { id: subId },
          data: { active: false },
        });
        log.warn(`Sub ${subId} auto-disabled after ${MAX_FAILURE_COUNT} consecutive failures`);
      }
    } catch (err) {
      log.error(`Failed to increment failure count for sub ${subId}: ${(err as Error).message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Matching
  // ═══════════════════════════════════════════════════════════

  /**
   * Match event type against subscription patterns.
   * Supports glob: `task.*` matches `task.created`, `task.failed`, etc.
   * Also supports `*` to match everything.
   */
  private matchEventType(eventType: string, patterns: string[]): boolean {
    for (const pattern of patterns) {
      if (pattern === '*') return true;
      if (pattern === eventType) return true;

      // Glob: `task.*` → matches any `task.X`
      if (pattern.endsWith('.*')) {
        const prefix = pattern.slice(0, -2);
        if (eventType.startsWith(prefix + '.')) return true;
      }
    }
    return false;
  }

  /**
   * Match event data against subscription filter.
   * AND logic: all filter keys must match.
   */
  private matchFilter(data: Record<string, unknown>, filter: SubscriptionFilter): boolean {
    for (const [key, value] of Object.entries(filter)) {
      if (value === undefined || value === null) continue;
      if (data[key] !== value) return false;
    }
    return true;
  }

  // ═══════════════════════════════════════════════════════════
  // Cleanup
  // ═══════════════════════════════════════════════════════════

  /**
   * Delete subscriptions where expiresAt < now.
   */
  async cleanupExpired(): Promise<number> {
    const result = await prisma.iMSubscription.deleteMany({
      where: {
        expiresAt: { lt: new Date() },
      },
    });
    if (result.count > 0) {
      log.info(`Cleaned up ${result.count} expired subscription(s)`);
    }
    return result.count;
  }

  // ═══════════════════════════════════════════════════════════
  // CRUD
  // ═══════════════════════════════════════════════════════════

  async create(subscriberId: string, input: CreateSubscriptionInput) {
    // Validate webhook URL on creation
    if (input.delivery === 'webhook') {
      if (!input.webhookUrl) throw new Error('webhookUrl is required for webhook delivery');
      const urlCheck = validateWebhookUrl(input.webhookUrl);
      if (!urlCheck.valid) throw new Error(`Invalid webhook URL: ${urlCheck.error}`);
    }

    return prisma.iMSubscription.create({
      data: {
        subscriberId,
        events: JSON.stringify(input.events),
        filter: JSON.stringify(input.filter ?? {}),
        delivery: input.delivery ?? 'message',
        webhookUrl: input.webhookUrl,
        webhookSecret: input.webhookSecret,
        minIntervalMs: input.minIntervalMs ?? 0,
        timeoutMs: input.timeoutMs ?? 30000,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        metadata: JSON.stringify(input.metadata ?? {}),
      },
    });
  }

  async findById(id: string) {
    return prisma.iMSubscription.findUnique({ where: { id } });
  }

  async findBySubscriber(subscriberId: string, activeOnly?: boolean) {
    const where: Record<string, unknown> = { subscriberId };
    if (activeOnly !== undefined) {
      where.active = activeOnly;
    }
    return prisma.iMSubscription.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
  }

  async update(
    id: string,
    data: Partial<{
      events: string[];
      filter: SubscriptionFilter;
      delivery: string;
      webhookUrl: string;
      webhookSecret: string;
      minIntervalMs: number;
      timeoutMs: number;
      active: boolean;
      expiresAt: string | null;
      metadata: Record<string, unknown>;
    }>,
  ) {
    const updateData: Record<string, unknown> = {};

    if (data.events !== undefined) updateData.events = JSON.stringify(data.events);
    if (data.filter !== undefined) updateData.filter = JSON.stringify(data.filter);
    if (data.delivery !== undefined) updateData.delivery = data.delivery;
    if (data.webhookUrl !== undefined) updateData.webhookUrl = data.webhookUrl;
    if (data.webhookSecret !== undefined) updateData.webhookSecret = data.webhookSecret;
    if (data.minIntervalMs !== undefined) updateData.minIntervalMs = data.minIntervalMs;
    if (data.timeoutMs !== undefined) updateData.timeoutMs = data.timeoutMs;
    if (data.active !== undefined) updateData.active = data.active;
    if (data.expiresAt !== undefined) updateData.expiresAt = data.expiresAt ? new Date(data.expiresAt) : null;
    if (data.metadata !== undefined) updateData.metadata = JSON.stringify(data.metadata);

    return prisma.iMSubscription.update({ where: { id }, data: updateData });
  }

  async delete(id: string) {
    return prisma.iMSubscription.delete({ where: { id } });
  }

  // ═══════════════════════════════════════════════════════════
  // Cooldown (Redis-backed with in-memory fallback)
  // ═══════════════════════════════════════════════════════════

  /**
   * Check whether a cooldown key is still active.
   * Redis: key existence check — cross-pod consistent.
   * Fallback: in-memory Map comparison.
   */
  private async _checkCooldown(key: string, intervalMs: number): Promise<boolean> {
    if (this._redis) {
      try {
        const val = await this._redis.get(`${COOLDOWN_PREFIX}${key}`);
        if (val) {
          const lastTrigger = parseInt(val, 10);
          return Date.now() - lastTrigger < intervalMs;
        }
        return false;
      } catch {
        // Redis down — fall through to in-memory
      }
    }
    const lastTrigger = this.cooldownMap.get(key);
    return !!lastTrigger && Date.now() - lastTrigger < intervalMs;
  }

  /**
   * Set cooldown after successful delivery.
   * Redis: SET with TTL equal to intervalMs (auto-expires, no memory leak).
   * Fallback: in-memory Map with LRU eviction at MAX_COOLDOWN_ENTRIES.
   */
  private async _setCooldown(key: string, intervalMs: number): Promise<void> {
    const now = Date.now();

    if (this._redis) {
      try {
        const ttlSec = Math.max(1, Math.ceil(intervalMs / 1000));
        await this._redis.set(`${COOLDOWN_PREFIX}${key}`, String(now), 'EX', ttlSec);
        return;
      } catch {
        // Redis down — fall through to in-memory
      }
    }

    // In-memory fallback with eviction to prevent memory leak
    if (this.cooldownMap.size >= MAX_COOLDOWN_ENTRIES) {
      // Evict oldest entries (first 20% by insertion order)
      const evictCount = Math.ceil(MAX_COOLDOWN_ENTRIES * 0.2);
      const keysToEvict = Array.from(this.cooldownMap.keys()).slice(0, evictCount);
      for (let i = 0; i < keysToEvict.length; i++) {
        this.cooldownMap.delete(keysToEvict[i]);
      }
      log.warn(`Cooldown map evicted ${keysToEvict.length} entries (reached ${MAX_COOLDOWN_ENTRIES} limit)`);
    }
    this.cooldownMap.set(key, now);
  }

  // ═══════════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════════

  private parseJson<T>(str: string | null | undefined, fallback: T): T {
    if (!str) return fallback;
    try {
      return JSON.parse(str);
    } catch {
      return fallback;
    }
  }
}
