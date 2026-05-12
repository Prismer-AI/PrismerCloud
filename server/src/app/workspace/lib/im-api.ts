/**
 * Workspace fetch helper — shared by /workspace page and its components.
 *
 * Wraps `fetch('/api/im/...')` with the same Bearer-token resolution rule used
 * across the app (platform JWT > active API key) and a typed envelope response
 * that surfaces structured server errors instead of swallowing them silently.
 */

import { getIMClientToken } from '@/lib/im-token';

export type AuthMissingResult = { ok: false; status: 401; error: 'AUTH_MISSING'; message: string };
export type AuthSuccessResult<T> = { ok: true; data: T };
export type AuthErrorResult = { ok: false; status: number; error: string; message: string; raw?: unknown };
export type FetchResult<T> = AuthSuccessResult<T> | AuthMissingResult | AuthErrorResult;

/** Resolve the bearer token: platform JWT first, then active API key. */
export function getWorkspaceToken(): string | null {
  return getIMClientToken();
}

export async function workspaceFetch<T = unknown>(
  path: string,
  init?: RequestInit & { signal?: AbortSignal },
): Promise<FetchResult<T>> {
  const token = getWorkspaceToken();
  if (!token) {
    return { ok: false, status: 401, error: 'AUTH_MISSING', message: 'No auth token' };
  }
  const url = path.startsWith('/api/') ? path : `/api/workspace${path.startsWith('/') ? path : `/${path}`}`;
  let res: Response;
  try {
    const isFormData = typeof FormData !== 'undefined' && init?.body instanceof FormData;
    res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init?.body && !isFormData ? { 'Content-Type': 'application/json' } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: 'NETWORK_ERROR',
      message: err instanceof Error ? err.message : 'Network request failed',
    };
  }

  let body: {
    ok?: boolean;
    data?: unknown;
    error?: string | { code?: string; message?: string };
    message?: string;
  } | null = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!res.ok || (body && body.ok === false)) {
    const errField = body?.error;
    const code = typeof errField === 'string' ? errField : (errField?.code ?? `HTTP_${res.status}`);
    const message =
      typeof errField === 'string'
        ? errField
        : (errField?.message ?? body?.message ?? `Request failed (HTTP ${res.status})`);
    return { ok: false, status: res.status, error: code, message, raw: body };
  }

  return { ok: true, data: (body?.data ?? undefined) as T };
}

/**
 * Issue a `/api/im/...` request and unwrap the standard `{ ok, data, error }`
 * envelope used throughout the IM router. Caller passes the path WITHOUT the
 * `/api/im` prefix — e.g. `imFetch('/workspaces')` not `imFetch('/api/im/workspaces')`.
 */
export async function imFetch<T = unknown>(
  path: string,
  init?: RequestInit & { signal?: AbortSignal },
): Promise<FetchResult<T>> {
  const token = getWorkspaceToken();
  if (!token) {
    return { ok: false, status: 401, error: 'AUTH_MISSING', message: 'No auth token' };
  }
  const url = path.startsWith('/api/') ? path : `/api/im${path.startsWith('/') ? path : `/${path}`}`;
  let res: Response;
  try {
    const isFormData = typeof FormData !== 'undefined' && init?.body instanceof FormData;
    res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init?.body && !isFormData ? { 'Content-Type': 'application/json' } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: 'NETWORK_ERROR',
      message: err instanceof Error ? err.message : 'Network request failed',
    };
  }

  let body: {
    ok?: boolean;
    data?: unknown;
    error?: string | { code?: string; message?: string };
    message?: string;
  } | null = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!res.ok || (body && body.ok === false)) {
    const errField = body?.error;
    const code = typeof errField === 'string' ? errField : (errField?.code ?? `HTTP_${res.status}`);
    const message =
      typeof errField === 'string'
        ? errField
        : (errField?.message ?? body?.message ?? `Request failed (HTTP ${res.status})`);
    return { ok: false, status: res.status, error: code, message, raw: body };
  }

  return { ok: true, data: (body?.data ?? undefined) as T };
}
