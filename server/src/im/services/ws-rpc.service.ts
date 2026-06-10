/**
 * Prismer IM — WS Reverse-RPC service (v2.0 §4.8.1, Wave 4-E4)
 *
 * Provides a request-reply correlation layer on top of the existing
 * `RoomManager.sendToUser` / shadow-client mechanism. Cloud-side callers
 * (notably `agent-dispatcher.dispatchExternalMention`) need "fire and wait"
 * semantics over the daemon reverse channel — the channel is already used
 * fire-and-forget for task dispatch, but webhook dispatch must surface the
 * daemon's reply to the upstream caller (external IM bridge) within the
 * `replyDeadlineMs` window.
 *
 * Wire shape:
 *   ── server → daemon ──
 *     { type: 'webhook.dispatch.request', payload: { ...AgentDispatchRequest, _rpcId: '<uuid>' } }
 *   ── daemon → server ──
 *     { type: 'webhook.dispatch.reply',   payload: { _rpcId, ok, acceptedAt?, error? } }
 *
 * Design notes (referenced from openclaw/src/gateway/node-registry.ts:23-150):
 *   - requestId (`_rpcId`) is generated server-side and embedded into the
 *     payload so the daemon does not need to thread it via a transport
 *     header; daemon just echoes it back.
 *   - Pending RPC map is keyed by `_rpcId`; entries are cleared on reply,
 *     timeout, or settle. AbortSignal supported for cancellation.
 *   - Optional `idempotencyKey` collapses concurrent invokes onto a single
 *     in-flight RPC — used by webhook retries that share `messageId`.
 *   - This service is **single-Pod**: the reply must come back to the Pod
 *     that issued the request. That's already true for the daemon shadow
 *     client (it's a single physical socket pinned to one Pod), so we do
 *     not need to involve Redis pub/sub here.
 */

import crypto from 'node:crypto';
import type { RoomManager } from '../ws/rooms';

export type WsRpcReplyStatus = 'ok' | 'agent_offline' | 'timeout' | 'agent_error';

export interface WsRpcReply<T = unknown> {
  /** Echoed back from the request. */
  _rpcId: string;
  ok: boolean;
  data?: T;
  acceptedAt?: string;
  error?: { code: string; message: string };
}

export interface WsRpcInvokeOptions {
  /** Wall-clock timeout. Defaults to 30_000ms (matches webhook replyDeadlineMs). */
  timeoutMs?: number;
  /**
   * Caller-supplied idempotency key. If a pending RPC exists for the same key,
   * the new caller awaits the same in-flight reply. Webhook uses `messageId`
   * so a retry from the upstream IM bridge does not send two requests.
   */
  idempotencyKey?: string;
  /** External abort signal — settles the RPC with `aborted` when fired. */
  signal?: AbortSignal;
}

export type WsRpcInvokeError =
  | { kind: 'daemon_offline' }
  | { kind: 'timeout' }
  | { kind: 'aborted' }
  | { kind: 'daemon_error'; code: string; message: string };

export type WsRpcInvokeResult<T> =
  | { ok: true; reply: WsRpcReply<T> }
  | { ok: false; error: WsRpcInvokeError };

interface PendingEntry {
  resolve: (reply: WsRpcReply<unknown>) => void;
  reject: (error: WsRpcInvokeError) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Allows multiple awaiters to share the same in-flight RPC via idempotencyKey. */
  awaiters: Array<{
    resolve: (reply: WsRpcReply<unknown>) => void;
    reject: (error: WsRpcInvokeError) => void;
  }>;
}

/**
 * The set of message types the daemon may emit back as RPC replies. WS handler
 * routes them into `WsRpcService.handleReply` instead of executing normal
 * IM event logic.
 */
export const WS_RPC_REPLY_TYPES = new Set<string>([
  'webhook.dispatch.reply',
  // release201/24 §3 — daemon ack for a cloud-pushed eval run.
  'skill.eval.reply',
]);

export class WsRpcService {
  /** rpcId → pending entry */
  private readonly pending = new Map<string, PendingEntry>();
  /** idempotencyKey → rpcId (for awaiter coalescing) */
  private readonly inflightByKey = new Map<string, string>();

  constructor(private readonly rooms: Pick<RoomManager, 'sendToUser' | 'getClientConnections'>) {}

  /**
   * Invoke `type` on the daemon reachable under `routeKey` (typically
   * `daemon:<daemonId>`) and resolve with the matching reply.
   *
   * Returns a tagged-union so callers can distinguish offline / timeout /
   * daemon_error without `instanceof Error` plumbing.
   */
  async invoke<T = unknown>(
    routeKey: string,
    type: string,
    payload: Record<string, unknown>,
    opts: WsRpcInvokeOptions = {},
  ): Promise<WsRpcInvokeResult<T>> {
    const connections = this.rooms.getClientConnections(routeKey);
    if (!connections || connections.size === 0) {
      return { ok: false, error: { kind: 'daemon_offline' } };
    }

    // Coalesce on idempotency key — if another invoke for the same key is
    // in flight, await its outcome instead of issuing a second request.
    if (opts.idempotencyKey) {
      const existing = this.inflightByKey.get(opts.idempotencyKey);
      if (existing) {
        const pending = this.pending.get(existing);
        if (pending) {
          return await new Promise((resolve) => {
            pending.awaiters.push({
              resolve: (reply) => resolve({ ok: true, reply: reply as WsRpcReply<T> }),
              reject: (error) => resolve({ ok: false, error }),
            });
          });
        }
      }
    }

    const rpcId = crypto.randomUUID();
    const timeoutMs = Math.max(1_000, opts.timeoutMs ?? 30_000);

    const promise = new Promise<WsRpcInvokeResult<T>>((resolve) => {
      const entry: PendingEntry = {
        resolve: (reply) => resolve({ ok: true, reply: reply as WsRpcReply<T> }),
        reject: (error) => resolve({ ok: false, error }),
        timer: setTimeout(() => this.settle(rpcId, { reject: { kind: 'timeout' } }), timeoutMs),
        awaiters: [],
      };
      this.pending.set(rpcId, entry);
      if (opts.idempotencyKey) this.inflightByKey.set(opts.idempotencyKey, rpcId);
    });

    // External cancellation hook — fires `aborted` and clears the entry.
    if (opts.signal) {
      if (opts.signal.aborted) {
        this.settle(rpcId, { reject: { kind: 'aborted' } });
      } else {
        const onAbort = () => this.settle(rpcId, { reject: { kind: 'aborted' } });
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    // Embed the rpcId into the payload so the daemon echoes it on reply.
    const event = {
      type,
      payload: { ...payload, _rpcId: rpcId },
    } as unknown as Parameters<RoomManager['sendToUser']>[1];

    this.rooms.sendToUser(routeKey, event);

    return promise;
  }

  /**
   * Called by the WS handler when a reply-type frame arrives.
   * Looks up the pending entry by `_rpcId` and resolves it.
   */
  handleReply(payload: unknown): { handled: boolean } {
    if (!payload || typeof payload !== 'object') return { handled: false };
    const obj = payload as Record<string, unknown>;
    const rpcId = typeof obj._rpcId === 'string' ? obj._rpcId : undefined;
    if (!rpcId) return { handled: false };

    const ok = obj.ok === true;
    const reply: WsRpcReply<unknown> = {
      _rpcId: rpcId,
      ok,
      data: 'data' in obj ? obj.data : undefined,
      acceptedAt: typeof obj.acceptedAt === 'string' ? obj.acceptedAt : undefined,
      error:
        obj.error && typeof obj.error === 'object' && !Array.isArray(obj.error)
          ? {
              code: String((obj.error as Record<string, unknown>).code ?? 'daemon_error'),
              message: String((obj.error as Record<string, unknown>).message ?? 'daemon returned non-ok'),
            }
          : undefined,
    };

    if (ok) {
      this.settle(rpcId, { resolve: reply });
    } else {
      this.settle(rpcId, {
        reject: {
          kind: 'daemon_error',
          code: reply.error?.code ?? 'daemon_error',
          message: reply.error?.message ?? 'daemon returned non-ok',
        },
      });
    }
    return { handled: true };
  }

  /** Pending count — surfaced for diagnostics. */
  get pendingSize(): number {
    return this.pending.size;
  }

  private settle(
    rpcId: string,
    outcome: { resolve?: WsRpcReply<unknown>; reject?: WsRpcInvokeError },
  ): void {
    const entry = this.pending.get(rpcId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(rpcId);
    // Clean up idempotency mapping if any.
    for (const [k, v] of this.inflightByKey) {
      if (v === rpcId) {
        this.inflightByKey.delete(k);
        break;
      }
    }

    if (outcome.resolve) {
      entry.resolve(outcome.resolve);
      for (const a of entry.awaiters) a.resolve(outcome.resolve);
    } else if (outcome.reject) {
      entry.reject(outcome.reject);
      for (const a of entry.awaiters) a.reject(outcome.reject);
    }
  }
}

/**
 * Detect whether a URL points at an RFC1918 / link-local / loopback host that
 * cloud (running in the public network) cannot dial directly. Used to skip
 * HTTP fallback when only WS reverse channel is viable.
 *
 * Exported for unit tests + reuse by the diagnose endpoint.
 */
export function isPrivateIpToCloud(url: string | null | undefined): boolean {
  if (!url) return true;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    // Malformed URL — conservatively treat as unreachable.
    return true;
  }
  if (!host) return true;
  const h = host.toLowerCase();
  if (h === 'localhost') return true;
  // IPv6 loopback
  if (h === '::1') return true;
  // IPv4 — split into octets
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  // Hostnames — *.local and similar are private; otherwise treat as public.
  if (h.endsWith('.local')) return true;
  if (h.endsWith('.localhost')) return true;
  return false;
}

/**
 * HEAD probe `${gatewayUrl}/healthz` with a short timeout. Returns
 * `{ reachable, latencyMs }`. Network errors / non-2xx → `reachable=false`.
 * Mirrors the daemon-side `probeCdnReachable` pattern.
 */
export async function probeHttpReachable(
  gatewayUrl: string,
  timeoutMs = 1_500,
  fetchImpl: typeof fetch = fetch,
): Promise<{ reachable: boolean; latencyMs: number | null; error?: string }> {
  const started = Date.now();
  try {
    const u = new URL(gatewayUrl);
    const probeUrl = new URL('/healthz', u).toString();
    const res = await fetchImpl(probeUrl, {
      method: 'HEAD',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Date.now() - started;
    if (res.ok) return { reachable: true, latencyMs };
    // 4xx/5xx — server is up but not happy. We still treat as unreachable
    // for dispatch purposes (no point HTTP-POSTing if /healthz is broken).
    return { reachable: false, latencyMs, error: `status_${res.status}` };
  } catch (err) {
    return {
      reachable: false,
      latencyMs: null,
      error: (err as Error).message?.slice(0, 200) ?? 'unknown',
    };
  }
}
