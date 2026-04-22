/**
 * Prismer Permissions Client — Cloud SDK bindings (v1.9.0)
 *
 * Risk-based approval gate for high-risk daemon/agent operations.
 *
 * Typical flow:
 *   1. Daemon calls `request({capability, operation, context?})`.
 *      • Response 200 with `{approved:true}` → proceed immediately (low risk).
 *      • Response 202 with `{requestId, expiresAt}` → wait for user decision.
 *   2. Mobile Lumin app polls `list({status:"pending"})` or reacts to push,
 *      then calls `approve(id)` or `reject(id)` with optional `reason`.
 *   3. Daemon polls `get(id)` (or subscribes to the approval WS channel) to
 *      discover the decision before the TTL expires (default 5 min).
 */

import { normalizeErrorField, type PrismerResponse } from './remote';

// ============================================================================
// Types
// ============================================================================

export type RiskLevel = {
  /** `"read"`, `"write"`, `"network"`, `"shell"`, etc. */
  category: string;
  /** Numeric scale, higher = more dangerous. Service-defined; 0-10 today. */
  score: number;
  /** Human-readable reason. */
  label: string;
  /** Heuristic flags the risk classifier raised. */
  flags?: string[];
};

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface ApprovalRequest {
  id: string;
  requesterId: string;
  userId: string;
  capability: string;
  operation: string;
  riskLevel: RiskLevel;
  context?: Record<string, unknown> | null;
  status: ApprovalStatus;
  reason?: string | null;
  expiresAt: string; // ISO 8601
  createdAt: string;
  decidedAt?: string | null;
}

export interface PermissionRequestInput {
  capability: string;
  operation: string;
  context?: Record<string, unknown>;
  ttlMs?: number;
  /** Optional idempotency key — forwarded as `Idempotency-Key` header. */
  idempotencyKey?: string;
}

export type PermissionRequestResult =
  /** Low-risk operation — auto-approved synchronously. */
  | { approved: true; riskLevel: RiskLevel; message?: string }
  /** High-risk operation — pending mobile decision; poll or subscribe. */
  | {
      approved: false;
      requestId: string;
      expiresAt: string;
      riskLevel: RiskLevel;
      message?: string;
    };

// ============================================================================
// Client
// ============================================================================

export class PermissionsClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeout: number;
  private readonly fetchFn: typeof fetch;

  constructor({
    baseUrl = 'https://prismer.cloud',
    apiKey = '',
    timeout = 30000,
    fetchFn = fetch,
  }: {
    baseUrl?: string;
    apiKey?: string;
    timeout?: number;
    fetchFn?: typeof fetch;
  } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.timeout = timeout;
    this.fetchFn = fetchFn;
  }

  /**
   * Request approval. The server may return synchronously when the
   * capability+context is classified as low risk.
   */
  async request(input: PermissionRequestInput): Promise<PrismerResponse<PermissionRequestResult>> {
    const { idempotencyKey, ...body } = input;
    return this._request<PermissionRequestResult>(
      'POST',
      '/api/im/permissions/request',
      body,
      idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
    );
  }

  /**
   * List pending approval requests for the current user. Only
   * `status=pending` is supported today; other values return an empty array
   * with an info message.
   */
  list(opts: { status?: ApprovalStatus; limit?: number } = {}): Promise<PrismerResponse<ApprovalRequest[]>> {
    const q = new URLSearchParams();
    if (opts.status) q.set('status', opts.status);
    if (opts.limit != null) q.set('limit', String(opts.limit));
    const suffix = q.toString() ? `?${q.toString()}` : '';
    return this._request<ApprovalRequest[]>('GET', `/api/im/permissions${suffix}`);
  }

  get(requestId: string): Promise<PrismerResponse<ApprovalRequest>> {
    return this._request<ApprovalRequest>('GET', `/api/im/permissions/${encodeURIComponent(requestId)}`);
  }

  approve(requestId: string, reason?: string): Promise<PrismerResponse<ApprovalRequest>> {
    return this._request<ApprovalRequest>('POST', `/api/im/permissions/${encodeURIComponent(requestId)}/approve`, {
      reason,
    });
  }

  reject(requestId: string, reason?: string): Promise<PrismerResponse<ApprovalRequest>> {
    return this._request<ApprovalRequest>('POST', `/api/im/permissions/${encodeURIComponent(requestId)}/reject`, {
      reason,
    });
  }

  // ─── Internal ───────────────────────────────────────────────────

  private async _request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<PrismerResponse<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers: { ...this._getHeaders(), ...(extraHeaders ?? {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const parsed = await response.json().catch(() => null);
      if (!response.ok) {
        return {
          ok: false,
          data: null,
          error: {
            code: parsed?.error?.code ?? String(response.status),
            message: parsed?.error?.message ?? response.statusText ?? 'HTTP error',
          },
        };
      }
      if (parsed && typeof parsed === 'object' && 'ok' in parsed) {
        const env = parsed as { ok: boolean; data?: T; error?: unknown };
        if (env.ok === false) {
          return { ok: false, data: null, error: normalizeErrorField(env.error) };
        }
        return { ok: true, data: (env.data ?? null) as T | null, error: null };
      }
      return { ok: true, data: (parsed as T) ?? null, error: null };
    } catch (err) {
      clearTimeout(timer);
      return {
        ok: false,
        data: null,
        error: {
          code: 'NETWORK_ERROR',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  private _getHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;
    return headers;
  }
}
