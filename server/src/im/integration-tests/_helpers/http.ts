/**
 * HTTP helper for integration tests.
 *
 * Real HTTP against TEST_TARGET (default http://127.0.0.1:3000). No mocking.
 * Path resolution:
 *   - paths starting with `/api/`  → used verbatim
 *   - paths starting with `/`      → prefixed with `/api/im`
 *   - anything else                → prefixed with `/api/im/`
 *
 * Always returns the parsed body (best-effort JSON; falls back to text) so
 * callers can `expect(r.status).toBe(...)` even on non-OK responses.
 */

import type { TestActor } from './bootstrap';
import { TEST_API_PREFIX, TEST_TARGET } from './env';

export interface ApiResponse<T = unknown> {
  status: number;
  ok: boolean;
  data: T;
  text: string;
  raw: Response;
}

export class IntegrationError extends Error {
  public readonly status: number;
  public readonly responseBody: unknown;
  public readonly method: string;
  public readonly url: string;

  constructor(opts: { method: string; url: string; status: number; expected: number; body: unknown }) {
    super(
      `[integration] ${opts.method} ${opts.url} → expected status ${opts.expected}, got ${opts.status}. body=${JSON.stringify(
        opts.body,
      )}`,
    );
    this.status = opts.status;
    this.responseBody = opts.body;
    this.method = opts.method;
    this.url = opts.url;
  }
}

export interface ApiOptions {
  /** Test actor — when present, sets `Authorization: Bearer <token>`. */
  actor?: TestActor | null;
  /** Raw bearer token, used when no full TestActor is available. */
  token?: string | null;
  /** JSON body — auto-stringified, sets Content-Type. */
  body?: unknown;
  /** Query string params; undefined values are dropped. */
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Override TEST_TARGET. */
  target?: string;
  /** Extra headers. */
  headers?: Record<string, string>;
  /** If set, throw IntegrationError when status !== expectStatus. */
  expectStatus?: number;
  /** Override default abort timeout (ms). */
  timeoutMs?: number;
}

function resolveUrl(path: string, query: ApiOptions['query'], target?: string): string {
  const base = (target ?? TEST_TARGET).replace(/\/+$/, '');
  let rel: string;
  if (path.startsWith('/api/')) {
    rel = path;
  } else if (path.startsWith('/')) {
    rel = `${TEST_API_PREFIX}${path}`;
  } else {
    rel = `${TEST_API_PREFIX}/${path}`;
  }
  const url = new URL(`${base}${rel}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

/**
 * Single HTTP call. Use `expectStatus` for happy-path assertions; omit it when
 * the test wants to assert on a non-2xx response directly.
 */
export async function api<T = unknown>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  opts: ApiOptions = {},
): Promise<ApiResponse<T>> {
  const url = resolveUrl(path, opts.query, opts.target);
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(opts.headers ?? {}),
  };
  const token = opts.actor?.token ?? opts.token ?? null;
  if (token && !headers['authorization'] && !headers['Authorization']) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  let body: BodyInit | undefined;
  if (opts.body !== undefined && opts.body !== null) {
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
    body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);

  let raw: Response;
  try {
    raw = await fetch(url, { method, headers, body, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }

  const text = await raw.text();
  let data: unknown = undefined;
  if (text.length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (opts.expectStatus !== undefined && raw.status !== opts.expectStatus) {
    throw new IntegrationError({
      method,
      url,
      status: raw.status,
      expected: opts.expectStatus,
      body: data,
    });
  }

  return {
    status: raw.status,
    ok: raw.ok,
    data: data as T,
    text,
    raw,
  };
}
