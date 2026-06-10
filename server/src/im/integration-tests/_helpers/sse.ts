/**
 * Tiny SSE subscriber used by Phase 2F realtime tests.
 *
 * We don't depend on the browser EventSource — we just stream the response
 * body and split on the `\n\n` event terminator. Good enough for assertion
 * tests; not a production client.
 *
 * Usage:
 *   const ctrl = new AbortController();
 *   const events: { event?: string; data: unknown }[] = [];
 *   const done = subscribeSSE('/sync/stream', actor, {
 *     signal: ctrl.signal,
 *     onEvent: (e) => events.push(e),
 *   });
 *   // ...trigger something on the server...
 *   await sleep(500);
 *   ctrl.abort();
 *   await done;
 */

import type { TestActor } from './bootstrap';
import { TEST_API_PREFIX, TEST_TARGET } from './env';

export interface SSEEvent {
  event?: string;
  data: unknown;
  id?: string;
}

export interface SSEOptions {
  signal: AbortSignal;
  onEvent: (event: SSEEvent) => void;
  query?: Record<string, string>;
  /** Override default target (e.g. for cross-env tests). */
  target?: string;
  /**
   * Some Prismer SSE endpoints (e.g. `/api/im/sync/stream`, `/api/im/tasks/events`)
   * require the JWT on a `?token=` query param rather than an
   * `Authorization` header. When set to true (default for endpoints we know
   * about), `subscribeSSE` will append `token=<actor.token>` to the URL
   * INSTEAD of sending the bearer header.
   *
   * Auto-detected from `path` when not explicitly set: any path that contains
   * `/sync/stream` or `/tasks/events` uses query-token mode.
   */
  tokenInQuery?: boolean;
  /**
   * Optional handler that fires before the SSE stream starts consuming chunks
   * — useful for `sse-baseline` tests that just want the HTTP status code on
   * a non-2xx response. The body is NOT consumed when this returns false.
   */
  onResponse?: (res: Response) => boolean | void;
}

function buildUrl(path: string, query: SSEOptions['query'], target?: string): string {
  const base = (target ?? TEST_TARGET).replace(/\/+$/, '');
  const rel = path.startsWith('/api/') ? path : `${TEST_API_PREFIX}${path.startsWith('/') ? path : `/${path}`}`;
  const url = new URL(`${base}${rel}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      url.searchParams.set(k, v);
    }
  }
  return url.toString();
}

function parseEventBlock(block: string): SSEEvent | null {
  const lines = block.split('\n');
  let eventName: string | undefined;
  const dataLines: string[] = [];
  let id: string | undefined;
  for (const line of lines) {
    if (line.startsWith(':') || line.length === 0) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon);
    const value = line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
    else if (field === 'id') id = value;
  }
  if (dataLines.length === 0) return null;
  const raw = dataLines.join('\n');
  let parsed: unknown = raw;
  try {
    parsed = JSON.parse(raw);
  } catch {
    /* keep raw string */
  }
  return { event: eventName, data: parsed, id };
}

export async function subscribeSSE(path: string, actor: TestActor, opts: SSEOptions): Promise<void> {
  const tokenInQuery = opts.tokenInQuery ?? (path.includes('/sync/stream') || path.includes('/tasks/events'));
  const query = { ...(opts.query ?? {}) };
  if (tokenInQuery) query.token = actor.token;
  const url = buildUrl(path, query, opts.target);
  const headers: Record<string, string> = {
    Accept: 'text/event-stream',
  };
  if (!tokenInQuery) headers.Authorization = `Bearer ${actor.token}`;

  const res = await fetch(url, {
    method: 'GET',
    headers,
    signal: opts.signal,
  });
  if (opts.onResponse) {
    const proceed = opts.onResponse(res);
    if (proceed === false) return;
  }
  if (!res.ok || !res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = parseEventBlock(block);
        if (ev) opts.onEvent(ev);
      }
    }
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') return;
    throw err;
  }
}
