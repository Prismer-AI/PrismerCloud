/**
 * IM Metrics Middleware — records request latency + status for ALL IM endpoints.
 *
 * Mounted globally in routes.ts. Uses routePath for low-cardinality keys
 * (avoids per-ID explosion like /conversations/abc123).
 */

import type { Context, Next } from 'hono';
import { metrics } from '@/lib/metrics';

/**
 * Normalize path to route pattern — collapse UUID/ID segments.
 * /conversations/abc-123-def → /conversations/:id
 * /direct/user-456/messages → /direct/:id/messages
 */
function normalizeRoutePath(path: string): string {
  return path
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
    .replace(/\/[a-z0-9_-]{20,}/gi, '/:id');
}

export function metricsMiddleware() {
  return async (c: Context, next: Next) => {
    const start = Date.now();
    await next();
    const routePath = normalizeRoutePath(c.req.path);
    metrics.recordRequest(`IM:${routePath}`, Date.now() - start, c.res.status);
  };
}
