/**
 * Prismer IM — Event Subscriptions API
 *
 * POST   /subscriptions          Create subscription
 * GET    /subscriptions          List own subscriptions (?active=true|false)
 * GET    /subscriptions/:id      Get detail (owner only)
 * PATCH  /subscriptions/:id      Update (owner only)
 * DELETE /subscriptions/:id      Delete (owner only)
 */

import { Hono } from 'hono';
import { authMiddleware } from '../auth/middleware';
import { EventBusService } from '../services/event-bus.service';
import type { ApiResponse } from '../types';

export function createSubscriptionsRouter(eventBusService: EventBusService) {
  const router = new Hono();

  router.use('*', authMiddleware);

  /**
   * POST /subscriptions — Create a new event subscription
   */
  router.post('/', async (c) => {
    const user = c.get('user');
    const body = await c.req.json();

    // Validate events
    if (!Array.isArray(body.events) || body.events.length === 0) {
      return c.json<ApiResponse>({ ok: false, error: 'events must be a non-empty array' }, 400);
    }

    // Validate delivery
    const delivery = body.delivery ?? 'message';
    if (!['message', 'webhook', 'sync'].includes(delivery)) {
      return c.json<ApiResponse>({ ok: false, error: "delivery must be 'message', 'webhook', or 'sync'" }, 400);
    }

    // Webhook requires webhookUrl
    if (delivery === 'webhook' && !body.webhookUrl) {
      return c.json<ApiResponse>({ ok: false, error: 'webhookUrl is required for webhook delivery' }, 400);
    }

    // Validate expiresAt if provided
    if (body.expiresAt && isNaN(new Date(body.expiresAt).getTime())) {
      return c.json<ApiResponse>({ ok: false, error: 'expiresAt must be a valid ISO 8601 date' }, 400);
    }

    try {
      const sub = await eventBusService.create(user.imUserId, {
        events: body.events,
        filter: body.filter,
        delivery,
        webhookUrl: body.webhookUrl,
        webhookSecret: body.webhookSecret,
        minIntervalMs: body.minIntervalMs ?? body.min_interval_ms,
        timeoutMs: body.timeoutMs ?? body.timeout_ms,
        expiresAt: body.expiresAt ?? body.expires_at,
        metadata: body.metadata,
      });

      return c.json<ApiResponse>({ ok: true, data: sub }, 201);
    } catch (err) {
      console.error('[SubscriptionAPI] Create error:', err);
      return c.json<ApiResponse>({ ok: false, error: (err as Error).message }, 500);
    }
  });

  /**
   * GET /subscriptions — List own subscriptions
   */
  router.get('/', async (c) => {
    const user = c.get('user');
    const activeParam = c.req.query('active');
    const activeOnly = activeParam === 'true' ? true : activeParam === 'false' ? false : undefined;

    const subs = await eventBusService.findBySubscriber(user.imUserId, activeOnly);
    return c.json<ApiResponse>({
      ok: true,
      data: subs,
      meta: { total: subs.length },
    });
  });

  /**
   * GET /subscriptions/:id — Get subscription detail (owner only)
   */
  router.get('/:id', async (c) => {
    const user = c.get('user');
    const sub = await eventBusService.findById(c.req.param('id')!);

    if (!sub) {
      return c.json<ApiResponse>({ ok: false, error: 'Subscription not found' }, 404);
    }
    if (sub.subscriberId !== user.imUserId) {
      return c.json<ApiResponse>({ ok: false, error: 'Access denied' }, 403);
    }

    return c.json<ApiResponse>({ ok: true, data: sub });
  });

  /**
   * PATCH /subscriptions/:id — Update subscription (owner only)
   */
  router.patch('/:id', async (c) => {
    const user = c.get('user');
    const sub = await eventBusService.findById(c.req.param('id')!);

    if (!sub) {
      return c.json<ApiResponse>({ ok: false, error: 'Subscription not found' }, 404);
    }
    if (sub.subscriberId !== user.imUserId) {
      return c.json<ApiResponse>({ ok: false, error: 'Access denied' }, 403);
    }

    const body = await c.req.json();
    try {
      const updated = await eventBusService.update(sub.id, {
        events: body.events,
        filter: body.filter,
        delivery: body.delivery,
        webhookUrl: body.webhookUrl,
        webhookSecret: body.webhookSecret,
        minIntervalMs: body.minIntervalMs ?? body.min_interval_ms,
        timeoutMs: body.timeoutMs ?? body.timeout_ms,
        active: body.active,
        expiresAt: body.expiresAt ?? body.expires_at,
        metadata: body.metadata,
      });
      return c.json<ApiResponse>({ ok: true, data: updated });
    } catch (err) {
      console.error('[SubscriptionAPI] Update error:', err);
      return c.json<ApiResponse>({ ok: false, error: (err as Error).message }, 500);
    }
  });

  /**
   * DELETE /subscriptions/:id — Delete subscription (owner only)
   */
  router.delete('/:id', async (c) => {
    const user = c.get('user');
    const sub = await eventBusService.findById(c.req.param('id')!);

    if (!sub) {
      return c.json<ApiResponse>({ ok: false, error: 'Subscription not found' }, 404);
    }
    if (sub.subscriberId !== user.imUserId) {
      return c.json<ApiResponse>({ ok: false, error: 'Access denied' }, 403);
    }

    await eventBusService.delete(sub.id);
    return c.json<ApiResponse>({ ok: true });
  });

  return router;
}
