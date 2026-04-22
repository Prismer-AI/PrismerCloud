/**
 * normalize.ts — Upstream payload normalization helpers.
 *
 * Adapters receive raw values from hook environments (strings, undefined,
 * numbers, Date objects). These helpers coerce them into the canonical
 * types expected by PARA event schemas before constructors are called.
 */

/** Validates a string is a valid UUIDv4. */
function isUuidV4(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

/**
 * Generate a simple UUIDv4-like string without crypto.
 * Good enough for adapter-generated IDs (not cryptographically secure).
 */
function generateId(): string {
  const hex = () => Math.floor(Math.random() * 16).toString(16);
  const s4 = () => Array.from({ length: 4 }, hex).join('');
  const s8 = () => Array.from({ length: 8 }, hex).join('');
  const v = () => (Math.floor(Math.random() * 4) + 8).toString(16);
  return `${s8()}-${s4()}-4${s4().slice(1)}-${v()}${s4().slice(1)}-${s8()}${s4()}`;
}

/**
 * Ensures a consistent call ID string.
 * Passes through non-empty strings; generates a new UUIDv4 if absent or empty.
 */
export function normalizeCallId(raw: unknown): string {
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return raw.trim();
  }
  return generateId();
}

/**
 * Normalizes a timestamp to milliseconds since epoch.
 * Accepts: number (ms), Date, or ISO 8601 string.
 * Falls back to Date.now() for unrecognized inputs.
 */
export function normalizeTimestamp(raw: unknown): number {
  if (typeof raw === 'number' && isFinite(raw)) {
    return raw;
  }
  if (raw instanceof Date) {
    const ms = raw.getTime();
    return isFinite(ms) ? ms : Date.now();
  }
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    if (!isNaN(parsed)) return parsed;
  }
  return Date.now();
}

/**
 * Normalizes a session ID string.
 * Passes through non-empty strings; returns fallback or generates a new ID.
 */
export function normalizeSessionId(raw: unknown, fallback?: string): string {
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return raw.trim();
  }
  if (fallback !== undefined && fallback.trim().length > 0) {
    return fallback.trim();
  }
  return generateId();
}

/**
 * Heuristic risk classification for a tool call.
 *
 * Default heuristic — adapters MAY override by passing their own function to
 * makeToolPre() instead of relying on this export.
 *
 * Rules:
 *   - Bash with destructive/network patterns (rm, curl, sudo, wget, chmod, chown) → high
 *   - Edit / Write → mid
 *   - Read / Glob / Grep / LS → low
 *   - Everything else → mid
 */
export function normalizeRiskTag(toolName: string, args: unknown): 'low' | 'mid' | 'high' {
  const name = toolName.toLowerCase();

  // Read-only tools
  if (['read', 'glob', 'grep', 'ls'].includes(name)) return 'low';

  // Write tools (non-destructive)
  if (['edit', 'write', 'notebookedit'].includes(name)) return 'mid';

  // Bash: inspect args for high-risk patterns
  if (name === 'bash') {
    const argsStr = typeof args === 'string' ? args : JSON.stringify(args ?? '');
    if (/\brm\b|\bcurl\b|\bsudo\b|\bwget\b|\bchmod\b|\bchown\b/.test(argsStr)) return 'high';
    return 'mid';
  }

  // Unknown tools default to mid
  return 'mid';
}

/** Checks whether a UUID v4 string is valid (exported for tests). */
export { isUuidV4 };
