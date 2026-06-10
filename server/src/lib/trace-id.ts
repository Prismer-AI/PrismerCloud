/**
 * release201/30 §7 — server-side traceId helpers (cloud / IM Hono).
 *
 * Frontend sends `X-Prismer-Trace-Id` header (see
 * src/app/workspace/lib/trace-id.ts). Cloud middleware extracts and stamps
 * it onto the Hono / Next.js context so structured logs (pino) and downstream
 * fan-out (daemon task.dispatch.request) can echo the same id.
 *
 * Wire contract:
 *   - header name: `X-Prismer-Trace-Id` (case-insensitive)
 *   - accepted shape: `^[a-z0-9_]{6,40}$/i` — anything else is rejected and
 *     a fresh server id is minted instead (defensive: never trust client text
 *     into a pino field unmasked).
 *   - server-minted prefix: `trace_s_` so debug logs can tell at a glance
 *     whether the id originated at the browser or the cloud (browser ids use
 *     `trace_`).
 */
import type { Context } from 'hono';

export const TRACE_HEADER = 'X-Prismer-Trace-Id';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

const TRACE_SHAPE = /^[a-z0-9_]{6,40}$/i;

/** Generate a new server-side trace id. */
export function generateServerTraceId(prefix = 'trace_s'): string {
  let rand = '';
  for (let i = 0; i < 8; i++) {
    rand += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return `${prefix}_${rand}`;
}

/** Validate a candidate trace id matches the wire shape. */
export function isValidTraceId(value: string): boolean {
  return TRACE_SHAPE.test(value);
}

/**
 * Hono helper — read header or mint a new id.
 *
 * Defensive: when the header is present but malformed, we still mint a fresh
 * server id so a misbehaving client can't poison structured logs. We do NOT
 * throw — the trace id is observability scaffolding, never a hard auth.
 */
export function getOrGenerateTraceId(c: Context): string {
  const incoming = c.req.header(TRACE_HEADER);
  if (incoming && isValidTraceId(incoming)) return incoming;
  return generateServerTraceId();
}
