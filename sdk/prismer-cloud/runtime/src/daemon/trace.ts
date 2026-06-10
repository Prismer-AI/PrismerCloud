/**
 * release201/30 §7 Phase 3 — daemon-side trace id helpers.
 *
 * Cloud emits `traceId` on `task.dispatch.request` (see
 * src/im/types/im-events.ts + src/im/ws/v19x-helpers.ts). Daemon uses it as
 * a prefix on stderr lines (`[trace=<id>]`) for the duration of the
 * dispatch so an operator can grep one id across cloud pino + daemon stderr
 * to reconstruct the full life-cycle of a user-facing action (compose-send,
 * file-upload, drag-drop-attach).
 *
 * When the payload's `traceId` is absent (legacy SDK / migration window),
 * we mint a `daemon-fallback-*` id so the prefix is always present. Operators
 * can spot the fallback at a glance and chase upstream propagation gaps.
 */

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

const TRACE_SHAPE = /^[a-z0-9_-]{6,48}$/i;

/** Generate a daemon-side fallback trace id when cloud didn't supply one. */
export function generateDaemonFallbackTraceId(): string {
  let rand = '';
  for (let i = 0; i < 8; i++) {
    rand += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return `daemon-fallback-${rand}`;
}

/**
 * Pick a usable trace id from the payload. Returns either the cloud-supplied
 * id (when shape-valid) or a freshly-minted daemon fallback. NEVER throws.
 *
 * Defensive shape check: cloud trims malformed client headers in
 * `src/lib/trace-id.ts`, but a buggy SDK build could still ship something
 * weird — fall back rather than poison the prefix.
 */
export function resolveDispatchTraceId(payloadTraceId: string | undefined | null): string {
  if (typeof payloadTraceId === 'string' && TRACE_SHAPE.test(payloadTraceId)) {
    return payloadTraceId;
  }
  return generateDaemonFallbackTraceId();
}

/**
 * Build a stderr-writer closure bound to a trace id. Every line gets
 * `[trace=<id>] ` prepended (with a trailing newline guaranteed).
 *
 * Usage in dispatch.ts:
 *   const traceId = resolveDispatchTraceId(payload.traceId);
 *   const traceWrite = makeTraceStderr(traceId);
 *   traceWrite('[daemon] some message ...');
 *
 * Existing `process.stderr.write` call sites can migrate gradually — both
 * styles coexist (a non-prefixed line is still grep-able by taskId).
 */
export function makeTraceStderr(traceId: string): (line: string) => void {
  const prefix = `[trace=${traceId}] `;
  return (line: string) => {
    const normalized = line.endsWith('\n') ? line : `${line}\n`;
    process.stderr.write(prefix + normalized);
  };
}
