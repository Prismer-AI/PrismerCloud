/**
 * Process-local ring buffer of pino log records.
 *
 * Stores parsed JSON log entries (post-redaction) so the admin
 * `/api/sandboxes/_admin/system-logs` endpoint can serve recent log lines
 * without round-tripping through stdout / Datadog. Pure in-memory; no
 * external deps. Dropped on process restart.
 *
 * Capacity policy (whichever fires first):
 *   - 5000 entries hard cap (oldest dropped on overflow)
 *   - 30 min sliding window (entries older than `windowMs` filtered out at
 *     query time; they remain in the array until evicted by cap-overflow)
 *
 * Design notes:
 *   - Append O(1) via simple array push + slice when overflow
 *   - `droppedSinceStart` counts entries evicted by cap (NOT window-expired
 *     ones, since those weren't truly lost — they were too old anyway)
 *   - `queryLogs` returns newest-first; callers paginate via `since`+`limit`
 *
 * v1 boundary: single Node process; multi-worker aggregation deferred (06 OQ-1).
 */

const CAPACITY = 5000;
const WINDOW_MS = 30 * 60 * 1000;

/**
 * Internal sentinel key under which we cache the lowercase concatenation of
 * every string-valued field of the entry (msg + extras as `key:value` pairs).
 * Lets `queryLogs({ contains })` substring-match against the *whole* record
 * (module, route, error, podName, …) rather than only `msg`. Cached at write
 * time so each appendLog pays the JSON walk cost once instead of every query.
 *
 * Underscored name so it falls under the `[extra: string]: unknown` index
 * signature without polluting any public field. Stripped on its way out only
 * if we ever choose to (current behavior: leak it in response so curl
 * `| jq .entries[0].__search` works as a debug aid; it's already redacted).
 */
const SEARCH_KEY = '__search';

export interface LogEntry {
  /** ISO timestamp (preferred) or pino numeric epoch ms. */
  ts: string;
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  msg: string;
  correlationId?: string;
  workspaceId?: string;
  taskId?: string;
  podName?: string;
  route?: string;
  [extra: string]: unknown;
}

export interface BufferStats {
  capacity: number;
  used: number;
  droppedSinceStart: number;
  windowMs: number;
  /** ISO timestamp of the oldest entry currently in the buffer; null if empty. */
  oldestAt: string | null;
  /** ISO timestamp of the newest entry currently in the buffer; null if empty. */
  newestAt: string | null;
}

export interface QueryOptions {
  /** ISO string or relative spec ("10m", "1h"). Default: window start. */
  since?: string;
  /** CSV-allowed list of levels to keep. */
  level?: Array<LogEntry['level']>;
  /**
   * Case-insensitive substring match against the entry's full searchable
   * surface — `msg` plus every string-valued extra rendered as `key:value`
   * (e.g. `module:LLMProxy`, `route:/api/im/...`). Cached at write time;
   * see SEARCH_KEY above.
   */
  contains?: string;
  /** Prefix match against `route` field. */
  route?: string;
  /** Exact match against `correlationId` field. */
  correlationId?: string;
  /** Max entries to return (clamped to 1000). */
  limit?: number;
}

const buffer: LogEntry[] = [];
let droppedSinceStart = 0;

const PINO_LEVELS: Record<number, LogEntry['level']> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

/**
 * Append a single log entry. Called by `logger.ts` `hooks.streamWrite` AFTER
 * `redactObject` has run. Caller is responsible for redaction.
 *
 * `entry.level` accepts either pino numeric level (10..60) or string label.
 * Timestamps may be either ISO string (preferred) or epoch ms — both are
 * normalized to ISO at append time so query-side compare is uniform.
 */
export function appendLog(entry: {
  level?: number | string;
  time?: number | string;
  ts?: string;
  msg?: string;
  [k: string]: unknown;
}): void {
  // Normalize level
  let level: LogEntry['level'];
  if (typeof entry.level === 'number') {
    level = PINO_LEVELS[entry.level] ?? 'info';
  } else if (typeof entry.level === 'string') {
    const lc = entry.level.toLowerCase() as LogEntry['level'];
    level = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].includes(lc) ? lc : 'info';
  } else {
    level = 'info';
  }

  // Normalize timestamp
  let ts: string;
  const tsRaw = entry.ts ?? entry.time;
  if (typeof tsRaw === 'number') ts = new Date(tsRaw).toISOString();
  else if (typeof tsRaw === 'string') {
    // pino sometimes serializes time as numeric string
    const asNum = Number(tsRaw);
    ts = Number.isFinite(asNum) && asNum > 0 ? new Date(asNum).toISOString() : tsRaw;
  } else ts = new Date().toISOString();

  const msg = typeof entry.msg === 'string' ? entry.msg : '';

  const normalized: LogEntry = {
    ...entry,
    ts,
    level,
    msg,
  };
  // Strip duplicate keys so they don't bloat
  delete (normalized as { time?: unknown }).time;

  // Pre-compute the searchable surface so `queryLogs({ contains })` is a
  // single substring check per entry (cheap) instead of a re-walk of the
  // object (expensive). Includes msg + every other string-valued field
  // rendered as `key:value` so substrings like `module:LLMProxy` or
  // `route:/api/im/workspaces` hit. Skips non-string values (objects /
  // numbers / booleans) — false negatives on those are acceptable for v1
  // (recursive walk would burn CPU on every log line for diminishing
  // returns).
  normalized[SEARCH_KEY] = buildSearchString(normalized);

  buffer.push(normalized);
  if (buffer.length > CAPACITY) {
    const overflow = buffer.length - CAPACITY;
    buffer.splice(0, overflow);
    droppedSinceStart += overflow;
  }
}

/**
 * Build the lowercase searchable surface of a log entry.
 *
 * Includes:
 *   - `msg` verbatim (lowercased)
 *   - Each non-internal string-valued top-level field as `key:value`,
 *     lowercased, space-separated.
 *
 * Skips:
 *   - Internal `__search` sentinel itself
 *   - Already-normalized fields `ts` / `level` (separately filterable)
 *   - Non-string values (numbers, booleans, nested objects/arrays) —
 *     covering those would require a recursive walk on every log line; v1
 *     accepts the false negatives in exchange for predictable cost.
 *
 * Pure / deterministic / O(n) over field count.
 */
function buildSearchString(entry: Record<string, unknown>): string {
  const parts: string[] = [];
  const msg = entry.msg;
  if (typeof msg === 'string' && msg.length > 0) parts.push(msg);

  for (const [k, v] of Object.entries(entry)) {
    if (k === 'msg' || k === SEARCH_KEY || k === 'ts' || k === 'level') continue;
    if (typeof v === 'string' && v.length > 0) {
      parts.push(`${k}:${v}`);
    }
  }
  return parts.join(' ').toLowerCase();
}

/**
 * Resolve a relative time spec like "10m", "1h", "30s" to an ISO timestamp.
 * Pass-through if already an ISO string. Returns `null` on parse failure.
 */
function resolveSince(since: string | undefined): Date | null {
  if (!since) return null;
  // Relative: <N><unit>
  const m = /^(\d+)\s*([smhd])$/i.exec(since.trim());
  if (m) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    const mult = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
    return new Date(Date.now() - n * mult);
  }
  // Absolute ISO
  const d = new Date(since);
  if (!isNaN(d.getTime())) return d;
  return null;
}

/**
 * Returns matching entries newest-first. Applies the 30-min window cap
 * regardless of `since` (i.e. `since` can only narrow further, not widen).
 */
export function queryLogs(opts: QueryOptions = {}): LogEntry[] {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  const windowStart = new Date(Date.now() - WINDOW_MS);
  const sinceDate = resolveSince(opts.since);
  const effectiveStart = sinceDate && sinceDate > windowStart ? sinceDate : windowStart;
  const startMs = effectiveStart.getTime();

  const levelSet = opts.level && opts.level.length > 0 ? new Set(opts.level) : null;
  const containsLc = opts.contains ? opts.contains.toLowerCase() : null;
  const routePrefix = opts.route ?? null;
  const correlationId = opts.correlationId ?? null;

  const out: LogEntry[] = [];
  // Walk newest-first so we can early-exit on `limit`.
  for (let i = buffer.length - 1; i >= 0; i--) {
    const e = buffer[i];
    const entryMs = new Date(e.ts).getTime();
    if (!Number.isFinite(entryMs) || entryMs < startMs) {
      // Buffer is roughly chronological so older entries are behind us;
      // but pino may emit slightly-out-of-order under load. Keep scanning
      // — the cap of 5000 entries bounds total cost.
      continue;
    }
    if (levelSet && !levelSet.has(e.level)) continue;
    if (containsLc) {
      // Prefer the write-time cached `__search` blob. If for any reason it's
      // missing (older entry, mutation by a caller, …) fall back to a fresh
      // build so existing buffer contents survive a code reload.
      const haystack = typeof e[SEARCH_KEY] === 'string'
        ? (e[SEARCH_KEY] as string)
        : buildSearchString(e);
      if (!haystack.includes(containsLc)) continue;
    }
    if (routePrefix) {
      const r = typeof e.route === 'string' ? e.route : '';
      if (!r.startsWith(routePrefix)) continue;
    }
    if (correlationId && e.correlationId !== correlationId) continue;
    out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}

export function getBufferStats(): BufferStats {
  // Buffer is mostly chronological (pino emits in order); however under load
  // a few out-of-order entries are possible. Walk both ends to be safe — the
  // cost is O(N) once per /system-logs call which is negligible vs. the JSON
  // serialization of the response itself.
  let oldestAt: string | null = null;
  let newestAt: string | null = null;
  if (buffer.length > 0) {
    let minMs = Number.POSITIVE_INFINITY;
    let maxMs = Number.NEGATIVE_INFINITY;
    for (const e of buffer) {
      const t = new Date(e.ts).getTime();
      if (!Number.isFinite(t)) continue;
      if (t < minMs) minMs = t;
      if (t > maxMs) maxMs = t;
    }
    if (Number.isFinite(minMs)) oldestAt = new Date(minMs).toISOString();
    if (Number.isFinite(maxMs)) newestAt = new Date(maxMs).toISOString();
  }
  return {
    capacity: CAPACITY,
    used: buffer.length,
    droppedSinceStart,
    windowMs: WINDOW_MS,
    oldestAt,
    newestAt,
  };
}

/**
 * Test-only — reset buffer state.
 * @internal
 */
export function _resetBuffer(): void {
  buffer.length = 0;
  droppedSinceStart = 0;
}
