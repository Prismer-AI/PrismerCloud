// Cloud HTTP client. Wraps fetch with bearer auth + uniform error mapping.
// Used by:
//   - sync-worker as the FlushFn (POST/PATCH/DELETE /api/im/<resource>)
//   - asset-cache for blob downloads (/api/im/assets/by-hash)
//   - dispatch.ts for asset uploads (POST /api/im/assets) + workspace_files
//   - pair flow (POST /pair/offer, GET /pair/poll)
// See docs/refactor/13-error-handling.md §2.1 for retry contract.

export interface CloudClientOptions {
  baseUrl: string;
  apiKey: string;
  /** Per-request timeout (ms). Defaults to 30s. */
  defaultTimeoutMs?: number;
  /** Pluggable fetch (tests inject a stub). */
  fetchImpl?: typeof fetch;
}

export interface CloudResponse<T> {
  ok: boolean;
  status: number;
  data?: T;
  error?: { code: string; message: string };
}

export class CloudClient {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: CloudClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Configured cloud base URL (no trailing slash). */
  get baseUrl(): string {
    return this.opts.baseUrl;
  }

  /** Bearer API key used to authorize requests. Treat as a secret. */
  get apiKey(): string {
    return this.opts.apiKey;
  }

  /** Low-level request. Caller decides on retry; sync-worker handles backoff. */
  async request<T = unknown>(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    init?: { body?: unknown; headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number; auth?: boolean },
  ): Promise<CloudResponse<T>> {
    const url = this.urlFor(path);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(init?.headers ?? {}),
    };
    if (init?.auth !== false) {
      headers.Authorization = `Bearer ${this.opts.apiKey}`;
    }
    const controller = new AbortController();
    const timeoutMs = init?.timeoutMs ?? this.opts.defaultTimeoutMs ?? 30_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (init?.signal) {
      if (init.signal.aborted) controller.abort();
      else init.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers,
        body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if ((err as { name?: string })?.name === 'AbortError') {
        return { ok: false, status: 0, error: { code: 'cloud_unreachable', message: 'Request aborted/timeout' } };
      }
      return {
        ok: false,
        status: 0,
        error: { code: 'cloud_unreachable', message: (err as Error).message },
      };
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text || undefined;
    }

    if (!res.ok) {
      const codeFromBody = (body as { error?: { code?: string } } | undefined)?.error?.code;
      const messageFromBody = (body as { error?: { message?: string } } | undefined)?.error?.message
        ?? (typeof body === 'string' ? body : undefined);
      return {
        ok: false,
        status: res.status,
        error: {
          code: codeFromBody ?? mapStatusToCode(res.status),
          message: messageFromBody ?? `HTTP ${res.status}`,
        },
      };
    }

    return { ok: true, status: res.status, data: (body as T) ?? (undefined as T) };
  }

  /** Convenience: GET expecting `{ ok, data }` envelope. Returns `data` or throws. */
  async get<T>(path: string, opts?: { signal?: AbortSignal }): Promise<T> {
    const res = await this.request<{ ok: boolean; data?: T; error?: unknown }>('GET', path, opts);
    if (!res.ok) throw new CloudError(res.status, res.error?.code ?? 'unknown', res.error?.message ?? 'request failed');
    if (res.data && typeof res.data === 'object' && 'ok' in res.data) {
      const env = res.data as { ok: boolean; data?: T; error?: { code: string; message: string } };
      if (!env.ok) throw new CloudError(res.status, env.error?.code ?? 'unknown', env.error?.message ?? 'envelope error');
      return env.data as T;
    }
    return res.data as T;
  }

  urlFor(path: string): string {
    const trimmedBase = this.opts.baseUrl.replace(/\/$/, '');
    const trimmedPath = path.startsWith('/') ? path : `/${path}`;
    return `${trimmedBase}${trimmedPath}`;
  }

  /** Raw byte download (for asset cache). Returns response so caller can stream body. */
  async fetchRaw(
    path: string,
    init?: { headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Response> {
    const url = this.urlFor(path);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.opts.apiKey}`,
      ...(init?.headers ?? {}),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init?.timeoutMs ?? 60_000);
    if (init?.signal) {
      if (init.signal.aborted) controller.abort();
      else init.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    try {
      return await this.fetchImpl(url, { method: 'GET', headers, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}

export class CloudError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CloudError';
  }
}

function mapStatusToCode(status: number): string {
  if (status === 401 || status === 403) return 'auth_invalid';
  if (status === 404) return 'not_found';
  if (status === 409) return 'version_conflict';
  if (status === 429) return 'quota_exceeded';
  if (status >= 500) return 'internal_error';
  if (status >= 400) return 'validation_failed';
  return 'unknown';
}
