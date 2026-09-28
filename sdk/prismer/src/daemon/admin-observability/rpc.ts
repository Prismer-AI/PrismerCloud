/**
 * Read-only Admin observability broker for in-runtime agents.
 *
 * This is deliberately not a generic HTTP proxy.  The daemon owns the cloud
 * credential and maps fixed local operations onto fixed Admin v1
 * endpoints.  Callers cannot supply a URL, method, path, or upstream header.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CloudClient, CloudResponse } from '../../auth.js';

const PREFIX = '/local/admin-observability/';
export const ADMIN_OBSERVABILITY_REQUEST_MAX_BYTES = 64 * 1024;
export const ADMIN_OBSERVABILITY_RESPONSE_MAX_BYTES = 6 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const PURPOSE_MAX_LENGTH = 256;
const TOKEN = /^[A-Za-z0-9._:-]{1,191}$/u;

type JsonObject = Record<string, unknown>;

export interface AttachAdminObservabilityRpcOptions {
  /** Dedicated daemon-held Admin client. Undefined fails closed. */
  cloud?: CloudClient;
  daemonId: () => string | null;
}

class BrokerInputError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function assertKeys(value: JsonObject, allowed: readonly string[]): void {
  const set = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !set.has(key));
  if (unknown) throw new BrokerInputError('invalid_request', `unknown field: ${unknown}`);
}

function purposeOf(body: JsonObject): string {
  const purpose = body.purpose;
  if (
    typeof purpose !== 'string' ||
    !purpose.trim() ||
    purpose.length > PURPOSE_MAX_LENGTH ||
    /[\0\r\n]/u.test(purpose)
  ) {
    throw new BrokerInputError('purpose_required', `purpose must be a single-line string <= ${PURPOSE_MAX_LENGTH}`);
  }
  return purpose.trim();
}

function optionalString(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > max || /[\0\r\n]/u.test(value)) {
    throw new BrokerInputError('invalid_request', `${name} is invalid`);
  }
  return value;
}

function copyObject(value: unknown, name: string, allowed: readonly string[]): JsonObject | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new BrokerInputError('invalid_request', `${name} must be an object`);
  assertKeys(value, allowed);
  return value;
}

function normalizeLogs(body: JsonObject): JsonObject {
  assertKeys(body, ['target', 'environment', 'timeRange', 'filters', 'include', 'page', 'order', 'purpose']);
  const purpose = purposeOf(body);
  const target = copyObject(body.target, 'target', ['kind', 'id']);
  const timeRange = copyObject(body.timeRange, 'timeRange', ['since', 'until']);
  const filters = copyObject(body.filters, 'filters', ['levels', 'contains', 'correlationId']);
  const include = copyObject(body.include, 'include', ['previous']);
  const page = copyObject(body.page, 'page', ['limit', 'cursor']);
  // Rebuild each nested object instead of spreading untrusted input.  The
  // canonical Admin endpoint remains the authoritative semantic validator.
  return {
    ...(target ? { target: { kind: target.kind, id: target.id } } : {}),
    ...(body.environment !== undefined ? { environment: body.environment } : {}),
    ...(timeRange ? { timeRange: { since: timeRange.since, until: timeRange.until } } : {}),
    ...(filters
      ? { filters: { levels: filters.levels, contains: filters.contains, correlationId: filters.correlationId } }
      : {}),
    ...(include ? { include: { previous: include.previous } } : {}),
    ...(page ? { page: { limit: page.limit, cursor: page.cursor } } : {}),
    ...(body.order !== undefined ? { order: body.order } : {}),
    purpose,
  };
}

function normalizeInventory(body: JsonObject): URLSearchParams {
  assertKeys(body, ['purpose', 'status', 'provider', 'workspaceId', 'runtimeId', 'podName', 'limit', 'cursor']);
  purposeOf(body);
  const params = new URLSearchParams();
  for (const name of ['status', 'provider', 'workspaceId', 'runtimeId', 'podName'] as const) {
    const value = optionalString(body[name], name, 191);
    if (value !== undefined) params.set(name, value);
  }
  const cursor = optionalString(body.cursor, 'cursor', 4096);
  if (cursor !== undefined) params.set('cursor', cursor);
  if (body.limit !== undefined) {
    const limit = Number(body.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BrokerInputError('invalid_request', 'limit must be between 1 and 100');
    }
    params.set('limit', String(limit));
  }
  return params;
}

function normalizeLogTargets(body: JsonObject): URLSearchParams {
  assertKeys(body, ['purpose', 'kind', 'runtimeId', 'workspaceId', 'taskId', 'daemonId', 'podName', 'limit', 'cursor']);
  purposeOf(body);
  const params = new URLSearchParams();
  const kind = optionalString(body.kind, 'kind', 16);
  if (kind && !['service', 'sandbox', 'daemon'].includes(kind)) {
    throw new BrokerInputError('invalid_request', 'kind must be service, sandbox, or daemon');
  }
  params.set('kind', kind ?? 'sandbox');
  for (const name of ['runtimeId', 'workspaceId', 'taskId', 'daemonId', 'podName'] as const) {
    const value = optionalString(body[name], name, 191);
    if (value !== undefined) params.set(name, value);
  }
  const cursor = optionalString(body.cursor, 'cursor', 4096);
  if (cursor !== undefined) params.set('cursor', cursor);
  if (body.limit !== undefined) {
    const limit = Number(body.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BrokerInputError('invalid_request', 'limit must be between 1 and 100');
    }
    params.set('limit', String(limit));
  }
  return params;
}

function localAgent(req: IncomingMessage): string | undefined {
  const value = req.headers['x-prismer-agent'];
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && TOKEN.test(candidate) ? candidate : undefined;
}

function isLoopback(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function provenanceHeaders(req: IncomingMessage, daemonId: string | null, purpose: string): Record<string, string> {
  const requestId = randomUUID();
  return {
    'X-Request-ID': requestId,
    'X-Prismer-Client': 'apc-admin-observability-broker',
    'X-Prismer-Provenance': 'daemon-loopback',
    'X-Prismer-Purpose': purpose,
    ...(daemonId && TOKEN.test(daemonId) ? { 'X-Prismer-Daemon-ID': daemonId } : {}),
    ...(localAgent(req) ? { 'X-Prismer-Agent': localAgent(req)! } : {}),
  };
}

function redactCredential(value: unknown, credential: string): unknown {
  if (!credential) return value;
  if (typeof value === 'string') return value.split(credential).join('[REDACTED]');
  if (Array.isArray(value)) return value.map((item) => redactCredential(item, credential));
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactCredential(item, credential)]));
  }
  return value;
}

function safeUpstreamStatus(status: number): number {
  if (status === 400 || status === 401 || status === 403 || status === 404 || status === 409 || status === 429) return status;
  return status >= 500 || status === 0 ? 502 : 400;
}

function upstreamFailure(res: ServerResponse, upstream: CloudResponse<unknown>): void {
  const status = safeUpstreamStatus(upstream.status);
  respond(res, status, {
    ok: false,
    error: {
      code: status === 401 || status === 403 ? 'admin_observability_forbidden' : 'admin_observability_unavailable',
      message:
        status === 401 || status === 403
          ? 'The daemon credential is not authorized for Admin observability'
          : 'Admin observability is temporarily unavailable',
      retryable: status === 429 || status >= 500,
    },
  });
}

export function attachAdminObservabilityRpc(
  opts: AttachAdminObservabilityRpcOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    const rawUrl = req.url ?? '/';
    const [pathOnly = ''] = rawUrl.split('?', 2);
    if (!pathOnly.startsWith(PREFIX)) return false;
    if (!isLoopback(req)) {
      respond(res, 403, { ok: false, error: { code: 'loopback_required', message: 'Loopback access required' } });
      return true;
    }
    if (rawUrl.includes('?')) {
      respond(res, 400, { ok: false, error: { code: 'query_not_allowed', message: 'URL query parameters are not allowed' } });
      return true;
    }
    if (req.method !== 'POST') {
      respond(res, 405, { ok: false, error: { code: 'method_not_allowed', message: 'POST required' } });
      return true;
    }

    const operation = pathOnly.slice(PREFIX.length);
    if (!['capabilities', 'logs-query', 'log-targets', 'runtimes'].includes(operation)) {
      respond(res, 404, { ok: false, error: { code: 'route_not_found', message: 'Unknown observability operation' } });
      return true;
    }

    try {
      const body = await readJson(req, ADMIN_OBSERVABILITY_REQUEST_MAX_BYTES);
      if (!opts.cloud) {
        respond(res, 503, {
          ok: false,
          error: {
            code: 'admin_observability_unconfigured',
            message: 'The daemon has no dedicated Admin observability credential',
          },
        });
        return true;
      }
      let upstream: CloudResponse<unknown>;
      if (operation === 'capabilities') {
        assertKeys(body, ['purpose']);
        const purpose = purposeOf(body);
        const headers = provenanceHeaders(req, opts.daemonId(), purpose);
        upstream = await opts.cloud.request('GET', '/api/admin/v1/capabilities', {
          headers,
          timeoutMs: REQUEST_TIMEOUT_MS,
          maxResponseBytes: ADMIN_OBSERVABILITY_RESPONSE_MAX_BYTES,
        });
      } else if (operation === 'logs-query') {
        const normalized = normalizeLogs(body);
        const headers = provenanceHeaders(req, opts.daemonId(), normalized.purpose as string);
        upstream = await opts.cloud.request('POST', '/api/admin/v1/logs:query', {
          body: normalized,
          headers,
          timeoutMs: REQUEST_TIMEOUT_MS,
          maxResponseBytes: ADMIN_OBSERVABILITY_RESPONSE_MAX_BYTES,
        });
      } else if (operation === 'runtimes') {
        const params = normalizeInventory(body);
        const headers = provenanceHeaders(req, opts.daemonId(), purposeOf(body));
        const suffix = params.size > 0 ? `?${params.toString()}` : '';
        upstream = await opts.cloud.request('GET', `/api/admin/v1/sandbox/runtimes${suffix}`, {
          headers,
          timeoutMs: REQUEST_TIMEOUT_MS,
          maxResponseBytes: ADMIN_OBSERVABILITY_RESPONSE_MAX_BYTES,
        });
      } else {
        const params = normalizeLogTargets(body);
        const headers = provenanceHeaders(req, opts.daemonId(), purposeOf(body));
        upstream = await opts.cloud.request('GET', `/api/admin/v1/log-targets?${params.toString()}`, {
          headers,
          timeoutMs: REQUEST_TIMEOUT_MS,
          maxResponseBytes: ADMIN_OBSERVABILITY_RESPONSE_MAX_BYTES,
        });
      }
      if (!upstream.ok) {
        upstreamFailure(res, upstream);
        return true;
      }
      respond(res, 200, redactCredential(upstream.data, opts.cloud.apiKey));
    } catch (error) {
      if (error instanceof BrokerInputError) {
        respond(res, 400, { ok: false, error: { code: error.code, message: error.message } });
      } else if (error instanceof RequestTooLargeError) {
        respond(res, 413, { ok: false, error: { code: 'request_too_large', message: 'Request body exceeds 64 KiB' } });
      } else {
        respond(res, 502, {
          ok: false,
          error: { code: 'admin_observability_unavailable', message: 'Admin observability is temporarily unavailable' },
        });
      }
    }
    return true;
  };
}

class RequestTooLargeError extends Error {}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<JsonObject> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw new RequestTooLargeError();
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (total > maxBytes) throw new RequestTooLargeError();
    chunks.push(buf);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new BrokerInputError('invalid_json', 'Request body must be valid JSON');
  }
  if (!isObject(parsed)) throw new BrokerInputError('invalid_request', 'Request body must be an object');
  return parsed;
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  let payload = JSON.stringify(body);
  if (Buffer.byteLength(payload, 'utf8') > ADMIN_OBSERVABILITY_RESPONSE_MAX_BYTES) {
    status = 502;
    payload = JSON.stringify({
      ok: false,
      error: { code: 'response_too_large', message: 'Admin observability response exceeded the broker budget' },
    });
  }
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'private, no-store',
  });
  res.end(payload);
}
