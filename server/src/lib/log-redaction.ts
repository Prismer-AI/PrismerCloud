/**
 * Secret scrubber for log entries served via `/api/sandboxes/_admin/system-logs`.
 *
 * Hooked on the ring-buffer write path in `src/lib/logger.ts` so the buffer
 * never holds plaintext credentials. Stdout / Datadog transports are
 * deliberately untouched in Phase A (pino's own `redact` config is a Phase E
 * concern — see docs/release201/06-debug-pipeline-design.md §5.2).
 *
 * Patterns covered:
 *   - Prismer API keys (`sk-prismer-live-...` / `sk-prismer-test-...`)
 *   - JWTs (three-segment base64url with leading `eyJ` header)
 *   - `password=` / `secret=` / `token=` style key-value pairs in arbitrary strings
 *   - `Authorization: Bearer <token>` HTTP header form
 *
 * The patterns are intentionally conservative — false-positives are cheap
 * (one log entry shows `***`), false-negatives are expensive (key leaked).
 * Coverage breadth matters more than precision here.
 */

const REDACT: Array<[RegExp, string]> = [
  [/sk-prismer-(?:live|test)-[a-f0-9]{32,}/g, 'sk-prismer-***REDACTED***'],
  [/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<jwt-redacted>'],
  [/(password|secret|token)(["']?\s*[:=]\s*["']?)[^\s"']+/gi, '$1$2***'],
  [/(Authorization:\s*Bearer\s+)\S+/gi, '$1***'],
];

/**
 * Apply all redaction patterns to a single string. Returns a new string;
 * input is unchanged. Safe to call repeatedly (idempotent — the replacement
 * tokens like `***REDACTED***` don't match any subsequent pattern).
 */
export function redactString(s: string): string {
  let out = s;
  for (const [re, repl] of REDACT) {
    out = out.replace(re, repl);
  }
  return out;
}

/**
 * Deep-walk an unknown value, applying `redactString` to every string node
 * (object values, array elements, root strings). Objects + arrays are
 * rebuilt; primitives passed through. Circular references guarded via a
 * WeakSet — circular nodes are returned as `<circular>`.
 *
 * Performance: O(n) where n = total nodes. The buffer write path runs this
 * per log line so the implementation stays allocation-light.
 */
export function redactObject(obj: unknown): unknown {
  const seen = new WeakSet<object>();

  const walk = (v: unknown): unknown => {
    if (v === null || v === undefined) return v;
    const t = typeof v;
    if (t === 'string') return redactString(v as string);
    if (t === 'number' || t === 'boolean' || t === 'bigint') return v;
    if (t !== 'object') return v;

    const o = v as object;
    if (seen.has(o)) return '<circular>';
    seen.add(o);

    if (Array.isArray(o)) {
      const arr: unknown[] = new Array(o.length);
      for (let i = 0; i < o.length; i++) arr[i] = walk(o[i]);
      return arr;
    }

    const out: Record<string, unknown> = {};
    for (const key of Object.keys(o as Record<string, unknown>)) {
      out[key] = walk((o as Record<string, unknown>)[key]);
    }
    return out;
  };

  return walk(obj);
}
