/**
 * Prismer Remote Control Client — Cloud SDK bindings for Track 3 (v1.9.0)
 *
 * Scope:
 *   - Desktop binding management (list / revoke / republish candidates)
 *   - Pairing workflows
 *       • Daemon-side:  pair.qrInit + pair.apiKeyBind
 *       • Mobile-side:  pair.qrConfirm
 *   - Remote command dispatch (sendCommand / getCommand / approve / reject)
 *   - Push token registration + lifecycle (register / list / delete)
 *   - FS relay — mobile → daemon sandboxed filesystem ops (v1.9.0)
 *
 * Note on signatures: the `approve` / `reject` / `sendCommand` methods take
 * a `bindingId` + opaque `envelope`, NOT a `commandId`. The server creates
 * the command and returns its id. This matches the `/api/im/remote/*`
 * HTTP contract exactly.
 */

// ============================================================================
// Shared transport types
// ============================================================================

export interface PrismerResponse<T> {
  ok: boolean;
  data: T | null;
  error: { code: string; message: string } | null;
}

/** Normalize an unknown error payload from the server into the SDK's
 *  strict `{code, message}` shape. Exported so `PermissionsClient` can
 *  reuse it without duplicating the coercion logic. */
export function normalizeErrorField(err: unknown): { code: string; message: string } {
  if (typeof err === 'string') return { code: 'ERROR', message: err };
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; message?: unknown };
    return {
      code: typeof e.code === 'string' ? e.code : 'UNKNOWN',
      message: typeof e.message === 'string' ? e.message : 'unknown error',
    };
  }
  return { code: 'UNKNOWN', message: 'unknown error' };
}

// ============================================================================
// Binding types
// ============================================================================

/**
 * Daemon connection candidate advertised in the pairing offer or via
 * PATCH /remote/bindings/:id/candidates. Client selects lowest-latency path;
 * E2EE is always applied on top regardless of transport.
 */
export type OfferCandidate =
  | { type: 'directTcp'; host: string; port: number }
  | { type: 'relay'; endpoint: string };

export interface DesktopBinding {
  id: string;
  daemonId: string;
  deviceName?: string | null;
  bindingMethod: 'apikey' | 'qr';
  status: 'active' | 'revoked';
  daemonPubKey: string;
  daemonSignPub: string;
  relayRegion?: string | null;
  /** Serialized BigInt — use as opaque string, don't parse as number. */
  lastSeq: string;
  isOnline: boolean;
  candidates: OfferCandidate[] | null;
  createdAt: string;
}

// ============================================================================
// Pairing — daemon-side types
// ============================================================================

export interface QrInitRequest {
  daemonId: string;
  daemonPubKey: string; // X25519 base64
  daemonSignPub: string; // Ed25519 base64
  /** base64-encoded Offer v2 JSON; see docs/version190/07-remote-control.md §5.6.2 */
  offerBlob: string;
  deviceName?: string;
}

export interface QrInitResponse {
  offerId: string;
  /** RFC 3339 / ISO 8601 */
  expiresAt: string;
}

export interface ApiKeyBindRequest {
  daemonId: string;
  daemonPubKey: string;
  daemonSignPub: string;
  deviceName?: string;
  relayRegion?: string;
  candidates?: OfferCandidate[];
}

export interface ApiKeyBindResponse {
  bindingId: string;
}

// ============================================================================
// Pairing — mobile-side types
// ============================================================================

export interface QrConfirmRequest {
  /** `offerId` is encoded inside the QR payload; parse it out before calling. */
  offerId: string;
  /** Mobile's ephemeral X25519 public key (base64) for E2EE key exchange. */
  clientPubKey: string;
  consumerDevice?: string;
}

export interface QrConfirmResponse {
  bindingId: string;
  daemonId: string;
}

// ============================================================================
// Remote commands
// ============================================================================

export type RemoteCommandStatus =
  | 'pending'
  | 'delivered'
  | 'completed'
  | 'failed'
  | 'expired';

export interface RemoteCommand {
  id: string;
  bindingId: string;
  senderId: string;
  type: string;
  /** Decoded envelope — object when structured, string when legacy base64. */
  envelope: unknown;
  status: RemoteCommandStatus;
  result?: unknown;
  createdAt: string;
  deliveredAt?: string | null;
  completedAt?: string | null;
}

export interface SendCommandRequest {
  bindingId: string;
  /** e.g. `"tool_approve"`, `"tool_reject"`, `"agent_stop"`. */
  type: string;
  /** Forwarded verbatim to the daemon. Object is JSON-encoded; string is passed through. */
  envelope: Record<string, unknown> | string;
  ttlMs?: number;
}

export interface QuickDecisionRequest {
  bindingId: string;
  envelope: Record<string, unknown> | string;
  /** Optional task bridge — if set, the server also transitions the task state. */
  taskId?: string;
}

// ============================================================================
// Push tokens
// ============================================================================

export interface RegisterPushTokenRequest {
  platform: 'apns' | 'fcm';
  token: string;
  deviceId?: string;
}

export interface PushToken {
  id: string;
  platform: 'apns' | 'fcm';
  token: string;
  deviceId: string | null;
  createdAt: string;
}

// ============================================================================
// FS relay — mobile → daemon sandboxed FS ops (v1.9.0)
// ============================================================================

export type FsOp = 'read' | 'write' | 'delete' | 'edit' | 'list' | 'search';

export interface FsReadRequest { path: string; encoding?: 'utf-8' | 'base64' }
export interface FsReadResponse { content: string; encoding: 'utf-8' | 'base64' }
export interface FsWriteRequest { path: string; content: string; encoding?: 'utf-8' | 'base64' }
export interface FsWriteResponse { bytesWritten: number }
export interface FsDeleteRequest { path: string }
export interface FsDeleteResponse { deleted: boolean }
export interface FsEditRequest { path: string; oldString: string; newString: string; replaceAll?: boolean }
export interface FsEditResponse { replaced: number; path: string }
export interface FsListRequest { path: string; recursive?: boolean }
export interface FsListEntry { name: string; type: 'file' | 'dir' | 'symlink'; size?: number }
export interface FsListResponse { entries: FsListEntry[] }
export interface FsSearchRequest { path: string; pattern: string; glob?: string }
export interface FsSearchMatch { path: string; line: number; preview: string }
export interface FsSearchResponse { matches: FsSearchMatch[] }

// ============================================================================
// Pairing sub-client (groups daemon-side + mobile-side calls)
// ============================================================================

export class PairingApi {
  constructor(private readonly client: RemoteClient) {}

  /**
   * Daemon-side: create a QR pairing offer. `offerBlob` is the base64-encoded
   * Offer v2 JSON — the daemon generates it locally and the cloud only stores
   * it opaquely (5-minute TTL, single-use).
   */
  qrInit(req: QrInitRequest): Promise<PrismerResponse<QrInitResponse>> {
    return this.client._post<QrInitResponse>('/api/im/remote/pair/qr-init', req);
  }

  /**
   * Mobile-side: confirm a scanned QR pairing. Atomically consumes the offer
   * and pushes `pairing.confirmed` to the daemon's WS control channel.
   */
  qrConfirm(req: QrConfirmRequest): Promise<PrismerResponse<QrConfirmResponse>> {
    return this.client._post<QrConfirmResponse>('/api/im/remote/pair/qr-confirm', req);
  }

  /**
   * Daemon-side: bind directly via API key, no QR required. The auth header
   * identifies the owning user; the body carries daemon credentials + optional
   * LAN/relay candidates.
   */
  apiKeyBind(req: ApiKeyBindRequest): Promise<PrismerResponse<ApiKeyBindResponse>> {
    return this.client._post<ApiKeyBindResponse>('/api/im/remote/pair/apikey-bind', req);
  }
}

// ============================================================================
// FS sub-client (mobile-side)
// ============================================================================

export class FsApi {
  constructor(private readonly client: RemoteClient, private readonly bindingId: string) {}

  private _path(op: FsOp): string {
    return `/api/im/remote/bindings/${encodeURIComponent(this.bindingId)}/fs/${op}`;
  }

  read(req: FsReadRequest): Promise<PrismerResponse<FsReadResponse>> {
    return this.client._post<FsReadResponse>(this._path('read'), req);
  }
  write(req: FsWriteRequest): Promise<PrismerResponse<FsWriteResponse>> {
    return this.client._post<FsWriteResponse>(this._path('write'), req);
  }
  delete(req: FsDeleteRequest): Promise<PrismerResponse<FsDeleteResponse>> {
    return this.client._post<FsDeleteResponse>(this._path('delete'), req);
  }
  edit(req: FsEditRequest): Promise<PrismerResponse<FsEditResponse>> {
    return this.client._post<FsEditResponse>(this._path('edit'), req);
  }
  list(req: FsListRequest): Promise<PrismerResponse<FsListResponse>> {
    return this.client._post<FsListResponse>(this._path('list'), req);
  }
  search(req: FsSearchRequest): Promise<PrismerResponse<FsSearchResponse>> {
    return this.client._post<FsSearchResponse>(this._path('search'), req);
  }
}

// ============================================================================
// RemoteClient
// ============================================================================

export class RemoteClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeout: number;
  private readonly fetchFn: typeof fetch;
  readonly pair: PairingApi;

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
    this.pair = new PairingApi(this);
  }

  // ─── Bindings ───────────────────────────────────────────────────

  listBindings(): Promise<PrismerResponse<DesktopBinding[]>> {
    return this._get<DesktopBinding[]>('/api/im/remote/bindings');
  }

  deleteBinding(bindingId: string): Promise<PrismerResponse<void>> {
    return this._delete<void>(`/api/im/remote/bindings/${encodeURIComponent(bindingId)}`);
  }

  /**
   * v1.9.0 — Daemon republishes its LAN/relay candidates (e.g. LAN IP
   * changed, relay region failover). Ownership is verified against the auth.
   */
  patchBindingCandidates(
    bindingId: string,
    candidates: OfferCandidate[],
  ): Promise<PrismerResponse<void>> {
    return this._patch<void>(`/api/im/remote/bindings/${encodeURIComponent(bindingId)}/candidates`, {
      candidates,
    });
  }

  /** Mobile-side FS relay client bound to a specific binding. */
  fs(bindingId: string): FsApi {
    return new FsApi(this, bindingId);
  }

  // ─── Commands ───────────────────────────────────────────────────

  sendCommand(req: SendCommandRequest): Promise<PrismerResponse<{ commandId: string; status: RemoteCommandStatus }>> {
    return this._post('/api/im/remote/command', req);
  }

  getCommand(commandId: string): Promise<PrismerResponse<RemoteCommand>> {
    return this._get<RemoteCommand>(`/api/im/remote/commands/${encodeURIComponent(commandId)}`);
  }

  /**
   * Quick-approve a pending tool call. Creates a `tool_approve` command and
   * forwards it via WS (if daemon online). Optionally bridges to task state
   * when `taskId` is provided.
   */
  approve(req: QuickDecisionRequest): Promise<PrismerResponse<{ commandId: string }>> {
    return this._post<{ commandId: string }>('/api/im/remote/approve', req);
  }

  reject(req: QuickDecisionRequest): Promise<PrismerResponse<{ commandId: string }>> {
    return this._post<{ commandId: string }>('/api/im/remote/reject', req);
  }

  // ─── Push tokens ────────────────────────────────────────────────

  registerPushToken(req: RegisterPushTokenRequest): Promise<PrismerResponse<{ success: boolean }>> {
    return this._post<{ success: boolean }>('/api/im/remote/push/register', req);
  }

  listPushTokens(): Promise<PrismerResponse<{ tokens: PushToken[] }>> {
    return this._get<{ tokens: PushToken[] }>('/api/im/remote/push/tokens');
  }

  /** Revoke a push token by its ID (not by raw token string). */
  deletePushToken(tokenId: string): Promise<PrismerResponse<{ success: boolean }>> {
    return this._delete<{ success: boolean }>(`/api/im/remote/push/tokens/${encodeURIComponent(tokenId)}`);
  }

  // ─── Internal HTTP helpers ──────────────────────────────────────

  _get<T>(path: string): Promise<PrismerResponse<T>> {
    return this._request<T>('GET', path);
  }
  _post<T>(path: string, body?: unknown): Promise<PrismerResponse<T>> {
    return this._request<T>('POST', path, body);
  }
  _patch<T>(path: string, body?: unknown): Promise<PrismerResponse<T>> {
    return this._request<T>('PATCH', path, body);
  }
  _delete<T>(path: string): Promise<PrismerResponse<T>> {
    return this._request<T>('DELETE', path);
  }

  private async _request<T>(method: string, path: string, body?: unknown): Promise<PrismerResponse<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers: this._getHeaders(),
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
            message: parsed?.error?.message ?? parsed?.error ?? response.statusText ?? 'HTTP error',
          },
        };
      }
      // Server-side envelope: { ok, data, error? } — unwrap `data` so SDK
      // callers get a consistent {ok,data,error} shape.
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
