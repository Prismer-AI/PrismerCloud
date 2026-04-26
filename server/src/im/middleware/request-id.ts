/**
 * RequestId middleware for IM (Hono) layer.
 *
 * Generates a short request ID for every incoming request.
 * Sets it on the Hono context and as a response header.
 * Downstream code can read it via `c.get('requestId')`.
 */
import type { Context, Next } from 'hono';
import crypto from 'crypto';

export function requestIdMiddleware() {
  return async (c: Context, next: Next) => {
    const requestId = c.req.header('x-request-id') || crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    c.set('requestId', requestId);
    c.header('X-Request-Id', requestId);
    await next();
  };
}
