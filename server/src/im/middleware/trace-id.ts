/**
 * release201/30 §7 — traceId middleware for IM (Hono) layer.
 *
 * Reads / mints `X-Prismer-Trace-Id` and:
 *   - stashes it on `c.set('traceId', ...)` for downstream code
 *   - echoes it back on the response so the browser dev tools can correlate
 *     the call site (frontend mint) with the actual id cloud/daemon used
 *     (cloud may re-mint when the client header is malformed; see
 *     `src/lib/trace-id.ts` for the wire shape).
 *
 * Runs BEFORE authMiddleware in createApiRouter so that 401 / 429 / rate-limit
 * responses also surface a trace id — debugging a "401 storm" without
 * traceId means manually replay-grepping the request id, which the v2
 * observability roadmap (`debug-pipeline.md`) wants to deprecate.
 */
import type { Context, Next } from 'hono';
import { getOrGenerateTraceId, TRACE_HEADER } from '../../lib/trace-id';

export function traceIdMiddleware() {
  return async (c: Context, next: Next) => {
    const traceId = getOrGenerateTraceId(c);
    c.set('traceId', traceId);
    c.header(TRACE_HEADER, traceId);
    await next();
  };
}
