/**
 * EaaS event stream — dual-transport subscriber for the tenant event feed.
 *
 *   - SSE: `GET {baseUrl}/api/v1/events`（Accept: text/event-stream）via fetch
 *     streaming + `Authorization: Bearer` header（token 绝不进 URL——服务端也不
 *     提供 `?token=` 通道）。手动解析骨架复用 `realtime.ts` subscribeTaskEvents
 *     的行累积形态：`id:`/`event:`/`data:` 行累积、空行 flush、`:` 心跳注释忽略。
 *   - WS: `{baseUrl→ws}/ws/eaas/v1`，首帧 `{type:'auth', token}` → 服务端
 *     `authorized` → 客户端 `{type:'subscribe', cursor?, environmentIds?,
 *     projectIds?}`；`{type:'event', event:{...envelope}}` 交付。
 *
 * 交付语义（两个 transport 一致）：
 *   - `eaas.resync`（cursor 过期，prune 后不可续传）→ 触发 `onResync` 并 resolve
 *     `handle.resynced`——调用方应重新拉授权快照（GET 列表）再重订。
 *   - eventId 去重：per-connection LRU 1024（重复投递只交付一次）。
 *   - 流终结（WS close/error、SSE done、`error` 帧订阅被拒）→ `onEnd` 回调，
 *     绝不对调用方静默死亡；恢复契约：携带最后 envelope.cursor 重新
 *     connectEaasEvents（服务端先 replay 后实时；cursor 被 prune → 服务端发
 *     `eaas.resync` 引导快照 resync）。调用方主动 disconnect/signal abort 不触发。
 *
 * 本 stream 不做自动重连/自动重试：断流后由调用方依 onEnd + 最后 cursor 重订
 * （与 client 侧「无自动重试、重试须传同一幂等键」的纪律一致）。
 *
 * Subpath export: `@prismer/sdk/environment-stream`.
 */

import { EaasClientError, isEaasErrorEnvelope } from './environment-contract';
import type { EaasEventEnvelope } from './environment-contract';

export interface EaasEventFilters {
  /** 只收这些环境的事件（服务端逗号分隔 `?environmentIds=`）。 */
  environmentIds?: string[];
  /** 只收这些项目的事件（服务端逗号分隔 `?projectIds=`）。 */
  projectIds?: string[];
}

export interface EaasResyncInfo {
  code?: string;
  /** 服务端流头 seq（扫描位置语义），调用方 resync 后可从此处重订。 */
  lastSeq?: string;
}

export interface EaasStreamEndInfo {
  /** 死亡的传输面。 */
  transport: 'sse' | 'ws';
  /**
   * WS close code（应用定义 4xxx：4401 token 失效/吊销、4403 限流或慢消费者、
   * 4404 FF off、4409 cursor 过期）；SSE 无 close code。
   */
  code?: number;
  /** 人读原因：WS close reason / `error` 帧消息 / SSE 流结束。 */
  reason?: string;
}

export interface EaasStreamOptions {
  /** Cloud base URL，如 `https://test.docbrew.cn`（尾斜杠容忍）。 */
  baseUrl: string;
  /** EaaS API key（`sk-eaas-…`）或可用 token。 */
  token: string;
  /** `'sse'`（默认）或 `'ws'`。 */
  transport?: 'sse' | 'ws';
  /** 续传位置（上次收到的 envelope.cursor / 服务端 lastSeq）；缺省从流头 0 起。 */
  cursor?: string;
  /** environmentIds / projectIds 过滤。 */
  filters?: EaasEventFilters;
  /** 每个去重后的事件 envelope 交付一次。 */
  onEvent: (event: EaasEventEnvelope) => void;
  /** `eaas.resync`（cursor 过期）回调——调用方重新拉快照后重订。 */
  onResync?: (info: EaasResyncInfo) => void;
  /**
   * 流终结回调（评审 fix round 1 I1）：WS close/error（4401 吊销、4404 FF off、
   * 4403 慢消费者、传输断开）、SSE 流 done、以及 WS `error` 帧（订阅被拒——
   * 从调用方视角此 handle 不会再交付事件，over-signal 是安全的：带 cursor 重订
   * 由服务端 replay 兜底）。
   *
   * 恢复契约：收到 onEnd 后调用方应携带最后收到的 envelope.cursor 重新调用
   * connectEaasEvents（服务端先 replay 后实时，cursor 之前不丢；cursor 已被
   * prune → 服务端先发 `eaas.resync` 引导快照 resync）。调用方主动 disconnect()
   * 或外部 signal abort 不触发 onEnd——那是调用方自己的决定。
   */
  onEnd?: (info: EaasStreamEndInfo) => void;
  /** Custom fetch（Node <18 无原生 fetch / 测试注入）。 */
  fetch?: typeof fetch;
  /** Custom WebSocket ctor（Node <21 / 测试注入）。 */
  WebSocket?: new (url: string) => WebSocket;
  /** 外部取消信号（disconnect 之外的关闭通道）。 */
  signal?: AbortSignal;
}

export interface EaasStreamHandle {
  /** 关闭连接（SSE abort fetch 流 / WS close）。幂等。 */
  disconnect(): void;
  /** 收到第一个 `eaas.resync` 时 resolve（cursor 过期 → 调用方须 resync 重订）。 */
  resynced: Promise<void>;
}

/** eventId 去重 LRU 容量（brief 焊死 1024）。 */
const SEEN_LRU_LIMIT = 1024;

/** Insertion-order LRU seen-set：命中即刷新位置，容量超限逐最旧。 */
class SeenEvents {
  private readonly map = new Map<string, true>();

  constructor(private readonly max: number) {}

  seen(id: string): boolean {
    if (this.map.has(id)) {
      this.map.delete(id);
      this.map.set(id, true);
      return true;
    }
    this.map.set(id, true);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    return false;
  }
}

export function connectEaasEvents(options: EaasStreamOptions): Promise<EaasStreamHandle> {
  return options.transport === 'ws' ? connectWs(options) : connectSse(options);
}

// ── SSE ─────────────────────────────────────────────────────────────────────

async function connectSse(options: EaasStreamOptions): Promise<EaasStreamHandle> {
  // 绑定 globalThis：同 index.ts——浏览器解绑 fetch 调用会 Illegal invocation。
  const fetchFn = options.fetch ?? fetch.bind(globalThis);
  const controller = new AbortController();
  let closed = false;
  const onAbort = () => {
    closed = true; // caller-initiated (disconnect or external signal) — no onEnd
    controller.abort();
  };
  options.signal?.addEventListener('abort', onAbort);

  const base = options.baseUrl.replace(/\/$/, '');
  const url = new URL(`${base}/api/v1/events`);
  if (options.cursor !== undefined && options.cursor !== '') url.searchParams.set('cursor', options.cursor);
  const envIds = options.filters?.environmentIds?.filter(Boolean) ?? [];
  const prjIds = options.filters?.projectIds?.filter(Boolean) ?? [];
  if (envIds.length > 0) url.searchParams.set('environmentIds', envIds.join(','));
  if (prjIds.length > 0) url.searchParams.set('projectIds', prjIds.join(','));

  const response = await fetchFn(url.toString(), {
    headers: {
      Accept: 'text/event-stream',
      Authorization: `Bearer ${options.token}`,
    },
    signal: controller.signal,
  });
  if (!response.ok || !response.body) {
    options.signal?.removeEventListener('abort', onAbort);
    // 与 face 其余部分一致（waitUntilReady 同款）：body 为合法 error envelope
    // → 以服务端 code/message 抛 EaasClientError；空 body / FF off 裸 404 /
    // 网关 HTML 错误页 → 客户端合成 `http_error`（保持状态码入消息）。
    let code: string = 'http_error';
    let message = `[EaasStream] SSE connect failed: ${response.status}`;
    try {
      const body: unknown = await response.json();
      if (isEaasErrorEnvelope(body)) {
        code = body.error.code;
        message = body.error.message;
      }
    } catch {
      /* bare 404 / HTML error page / no json body */
    }
    throw new EaasClientError(code, message);
  }

  let resyncResolve!: () => void;
  const resynced = new Promise<void>((resolve) => { resyncResolve = resolve; });
  const seen = new SeenEvents(SEEN_LRU_LIMIT);

  // Background read loop — manual SSE parse skeleton (mirrors realtime.ts
  // subscribeTaskEvents): accumulate lines, flush on blank line, ignore
  // `:` heartbeat comments.
  void (async () => {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let pending: { type?: string; data: string[] } = { data: [] };
    let endReason = 'stream ended';

    const flush = () => {
      if (closed) return;
      const type = pending.type;
      const dataStr = pending.data.join('\n');
      pending = { data: [] };
      if (!type && !dataStr) return;
      if (type === 'eaas.resync') {
        let info: EaasResyncInfo = {};
        try { info = JSON.parse(dataStr) as EaasResyncInfo; } catch { /* keep {} */ }
        try { options.onResync?.(info); } catch { /* user callback errors must not kill the stream */ }
        resyncResolve();
        return;
      }
      let envelope: EaasEventEnvelope;
      try { envelope = JSON.parse(dataStr) as EaasEventEnvelope; } catch { return; }
      if (!envelope || typeof envelope !== 'object' || typeof envelope.type !== 'string') return;
      if (envelope.eventId && seen.seen(envelope.eventId)) return;
      try { options.onEvent(envelope); } catch { /* user callback errors must not kill the stream */ }
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const rawLine of lines) {
          // Tolerate CRLF framing: strip the trailing \r before field matching.
          const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
          if (line.startsWith(':')) continue; // heartbeat comment
          if (line.startsWith('event:')) pending.type = line.slice(6).trim();
          else if (line.startsWith('data:')) pending.data.push(line.slice(5).trimStart());
          else if (line === '') flush();
          // `id:` / `retry:` lines carry no extra semantics here — the cursor
          // already travels inside each envelope.
        }
      }
    } catch (err) {
      endReason = err instanceof Error ? `stream error: ${err.message}` : 'stream error';
    } finally {
      try { reader.releaseLock(); } catch { /* already released */ }
      options.signal?.removeEventListener('abort', onAbort);
      if (!closed) {
        // Unexpected death (server closed the stream / transport error) — the
        // caller owns reconnection; surface it, never die silently.
        closed = true;
        try { options.onEnd?.({ transport: 'sse', reason: endReason }); } catch { /* ignore */ }
      }
    }
  })();

  return {
    disconnect() {
      if (closed) return;
      closed = true;
      options.signal?.removeEventListener('abort', onAbort);
      controller.abort();
    },
    resynced,
  };
}

// ── WS ──────────────────────────────────────────────────────────────────────

function connectWs(options: EaasStreamOptions): Promise<EaasStreamHandle> {
  const WS =
    options.WebSocket ??
    (typeof WebSocket !== 'undefined' ? (WebSocket as new (url: string) => WebSocket) : undefined);
  if (!WS) {
    return Promise.reject(
      new EaasClientError('ws_unavailable', '[EaasStream] no WebSocket constructor available — pass options.WebSocket'),
    );
  }

  const base = options.baseUrl.replace(/\/$/, '').replace(/^http/, 'ws');
  const ws = new WS(`${base}/ws/eaas/v1`);
  const seen = new SeenEvents(SEEN_LRU_LIMIT);
  let resyncResolve!: () => void;
  const resynced = new Promise<void>((resolve) => { resyncResolve = resolve; });
  let closed = false;
  let settled = false;

  const buildSubscribe = (): string => {
    const sub: Record<string, unknown> = { type: 'subscribe' };
    if (options.cursor !== undefined && options.cursor !== '') sub.cursor = options.cursor;
    const envIds = options.filters?.environmentIds?.filter(Boolean) ?? [];
    const prjIds = options.filters?.projectIds?.filter(Boolean) ?? [];
    if (envIds.length > 0) sub.environmentIds = envIds;
    if (prjIds.length > 0) sub.projectIds = prjIds;
    return JSON.stringify(sub);
  };

  return new Promise<EaasStreamHandle>((resolve, reject) => {
    const onOpen = (): void => {
      // First frame MUST be auth; anything else before auth → server close 4401.
      ws.send(JSON.stringify({ type: 'auth', token: options.token }));
    };

    const onStreamMessage = (ev: MessageEvent): void => {
      let msg: { type?: string; event?: EaasEventEnvelope; lastSeq?: string; message?: string };
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return; // 4400-equivalent: ignore malformed frames
      }
      if (msg.type === 'event' && msg.event && typeof msg.event === 'object') {
        const envelope = msg.event;
        if (envelope.eventId && seen.seen(envelope.eventId)) return;
        try { options.onEvent(envelope); } catch { /* user callback errors must not kill the stream */ }
      } else if (msg.type === 'eaas.resync') {
        try { options.onResync?.({ code: msg.type, lastSeq: msg.lastSeq }); } catch { /* ignore */ }
        resyncResolve();
      } else if (msg.type === 'error' && !closed) {
        // 订阅被拒等帧级错误：从调用方视角此 handle 不会再交付事件——按终结面
        // 透传并关 socket（over-signal 安全：调用方带 cursor 重订，服务端 replay
        // 兜底；留一个服务端认为存活、客户端永不交付的僵尸连接更糟）。
        closed = true;
        options.signal?.removeEventListener('abort', onAbort);
        try { ws.close(1000, 'error frame'); } catch { /* already closed */ }
        ws.removeEventListener('message', onStreamMessage);
        ws.removeEventListener('close', onStreamClose);
        ws.removeEventListener('error', onStreamError);
        try { options.onEnd?.({ transport: 'ws', reason: msg.message ?? 'error frame' }); } catch { /* ignore */ }
      }
    };

    // Stream-phase death handlers (installed after `authorized`) — without these
    // a 4401 revocation / 4404 FF off / 4403 slow-consumer close or transport
    // error would end the stream silently while the caller waits for events.
    const onStreamClose = (ev: CloseEvent): void => {
      if (closed) return;
      closed = true;
      options.signal?.removeEventListener('abort', onAbort);
      ws.removeEventListener('message', onStreamMessage);
      try { options.onEnd?.({ transport: 'ws', code: ev.code, reason: ev.reason }); } catch { /* ignore */ }
    };

    const onStreamError = (): void => {
      if (closed) return;
      closed = true;
      options.signal?.removeEventListener('abort', onAbort);
      ws.removeEventListener('message', onStreamMessage);
      try { options.onEnd?.({ transport: 'ws', reason: 'connection error' }); } catch { /* ignore */ }
    };

    const cleanupConnectListeners = (): void => {
      ws.removeEventListener('open', onOpen);
      ws.removeEventListener('message', onFirstMessage);
      ws.removeEventListener('error', onError);
      ws.removeEventListener('close', onClose);
      options.signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = (): void => {
      if (!settled) {
        settled = true;
        cleanupConnectListeners();
        reject(new EaasClientError('ws_connect_aborted', '[EaasStream] WS connect aborted'));
      }
      doClose();
    };

    const onError = (): void => {
      if (settled) return;
      settled = true;
      cleanupConnectListeners();
      reject(new EaasClientError('ws_connect_failed', '[EaasStream] WS connection failed'));
    };

    const onClose = (ev: CloseEvent): void => {
      if (settled) return;
      settled = true;
      cleanupConnectListeners();
      const reason = ev.reason ? `: ${ev.reason}` : '';
      const code = typeof ev.code === 'number' && ev.code > 0 ? ` (${ev.code})` : '';
      reject(
        new EaasClientError(
          'ws_authorization_failed',
          `[EaasStream] WS closed before authorized${code}${reason}`,
        ),
      );
    };

    const onFirstMessage = (ev: MessageEvent): void => {
      let msg: { type?: string };
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (msg.type !== 'authorized' || settled) return;
      settled = true;
      ws.send(buildSubscribe());
      // Swap connect-phase listeners for the persistent stream handler +
      // stream-phase death handlers (onEnd wiring).
      ws.removeEventListener('open', onOpen);
      ws.removeEventListener('message', onFirstMessage);
      ws.removeEventListener('error', onError);
      ws.removeEventListener('close', onClose);
      ws.addEventListener('message', onStreamMessage);
      ws.addEventListener('close', onStreamClose);
      ws.addEventListener('error', onStreamError);
      resolve({
        disconnect: doClose,
        resynced,
      });
    };

    const doClose = (): void => {
      if (closed) return;
      closed = true;
      options.signal?.removeEventListener('abort', onAbort);
      try { ws.close(1000, 'client disconnect'); } catch { /* already closed */ }
      ws.removeEventListener('message', onStreamMessage);
      ws.removeEventListener('close', onStreamClose);
      ws.removeEventListener('error', onStreamError);
    };

    options.signal?.addEventListener('abort', onAbort);
    ws.addEventListener('open', onOpen);
    ws.addEventListener('message', onFirstMessage);
    ws.addEventListener('error', onError);
    ws.addEventListener('close', onClose);
  });
}
