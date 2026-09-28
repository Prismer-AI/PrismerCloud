// release203/12 P3.1 — daemon→cloud unified realtime subscriber (WS).
//
// WHY THIS EXISTS:
//   release203/12 standardizes ALL realtime on ONE WebSocket per user:
//   `WS /ws/realtime?token=<apiKey>&since=<cursor>`, which multiplexes the two
//   legacy SSE streams as frames:
//     data    { ch:'sync'|'tasks', name:<event>, data:<payload> }
//     control { name:'caught_up'|'heartbeat'|'error', ... }
//   This is the daemon-side follower: it REPLACES `SseSubscriber` (the
//   `/api/im/sync/stream` EventSource-equivalent) so the daemon stops holding a
//   second long-lived SSE connection to cloud and consumes the SAME unified WS
//   the browser does. Auth is byte-identical (cloud resolves the WS upgrade via
//   the same `resolveStreamUserId(verifyToken(token))` the SSE endpoint uses),
//   and the cursor watermark is the SAME sentinel (`chats`/`__sse__`) so a daemon
//   upgrading from SSE→WS resumes from exactly where it left off.
//
//   It feeds the SAME Materializer (rm_* upsert + per-conversation watermark +
//   local SSE fan-out) as SseSubscriber — behaviour-preserving, transport-only.
//   The `ch:'tasks'` projection is intentionally IGNORED: the daemon only ever
//   consumed `/sync/stream` (task.* events already arrive on the per-user sync
//   fan-out), so consuming the typed tasks channel would double-materialize.
//
// CURSOR SEMANTICS: identical to sse-subscriber.ts — the per-USER monotonic
// `seq` (IMSyncEvent.id), persisted under the `chats`/`__sse__` watermark.
// First cold boot starts at since=0; on `sync.backfill.truncated{newestSeq}` we
// jump to newestSeq and reconnect, draining ≤500/connect to head (no storm).

import WebSocket from 'ws';
import type { Materializer, RawWsEvent } from './materializer.js';
import { advanceWatermark, getWatermark } from './read-model.js';

/** Same sentinel watermark as the SSE subscriber → seamless transport switch. */
const SSE_CURSOR_DOMAIN = 'chats';
const SSE_CURSOR_SCOPE = '__sse__';

/** Reconnect backoff: 1s → ×2 → cap 30s (jittered) — matches SseSubscriber. */
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

/** Minimal socket surface so tests can inject a fake (no real network). */
export interface RealtimeSocketLike {
  on(event: 'open', cb: () => void): void;
  on(event: 'message', cb: (data: unknown) => void): void;
  on(event: 'close', cb: (code: number) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  close(code?: number): void;
}

export interface WsRealtimeSubscriberDeps {
  /** Cloud base URL (http/https; we derive ws/wss + /ws/realtime). */
  cloudBase: string;
  /** Daemon api key — accepted by /ws/realtime as `token` (api_key_proxy). */
  apiKey: string;
  /** Sink for every recognized `sync` event (shared with SseSubscriber). */
  materializer: Materializer;
  /** Watermark store handle (rm_watermarks lives in local.db). */
  db: import('../../sync/store.js').LocalDb;
  /** Pluggable socket factory (tests inject a fake; default = `ws` WebSocket). */
  wsFactory?: (url: string) => RealtimeSocketLike;
  /** Pluggable logger (defaults to process.stdout). */
  log?: (line: string) => void;
  /** Override reconnect backoff bounds (tests shrink these for speed). */
  backoffMinMs?: number;
  backoffMaxMs?: number;
  /** M3 online-state hooks (same contract as SseSubscriber). */
  onConnected?: () => void;
  onDisconnected?: () => void;
}

/**
 * Long-lived unified-WS realtime subscriber. `start()` opens the socket and
 * auto-reconnects with exponential backoff until `stop()`. Idempotent.
 *
 * Drop-in for SseSubscriber: same public surface (start/stop/currentCursor),
 * same deps shape (minus fetchImpl → wsFactory), same materializer + watermark.
 */
export class WsRealtimeSubscriber {
  private readonly wsFactory: (url: string) => RealtimeSocketLike;
  private readonly log: (line: string) => void;
  private readonly backoffMin: number;
  private readonly backoffMax: number;
  private running = false;
  private socket: RealtimeSocketLike | null = null;
  private backoff: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private cursor = 0;
  private connectedSignalled = false;

  constructor(private readonly deps: WsRealtimeSubscriberDeps) {
    this.wsFactory = deps.wsFactory ?? ((url) => new WebSocket(url) as unknown as RealtimeSocketLike);
    this.log = deps.log ?? ((l) => process.stdout.write(l));
    this.backoffMin = deps.backoffMinMs ?? BACKOFF_MIN_MS;
    this.backoffMax = deps.backoffMaxMs ?? BACKOFF_MAX_MS;
    this.backoff = this.backoffMin;
  }

  /** Currently-applied per-user seq cursor (test/observability). */
  get currentCursor(): number {
    return this.cursor;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.cursor = getWatermark(this.deps.db, SSE_CURSOR_DOMAIN, SSE_CURSOR_SCOPE)?.cursor ?? 0;
    this.log(`[daemon] gateway WS realtime subscriber start (since=${this.cursor})\n`);
    void this.loop();
  }

  stop(): void {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.socket?.close(1000);
    } catch {
      /* already closed */
    }
    this.socket = null;
  }

  // ── connection loop ────────────────────────────────────────────────────────
  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.connectOnce();
      } catch (err) {
        if (!this.running) return;
        this.log(`[daemon] gateway WS realtime error: ${(err as Error).message}\n`);
      }
      this.signalDisconnected();
      if (!this.running) return;
      await this.waitBackoff();
    }
  }

  private signalConnected(): void {
    if (this.connectedSignalled) return;
    this.connectedSignalled = true;
    this.deps.onConnected?.();
  }

  private signalDisconnected(): void {
    this.connectedSignalled = false;
    this.deps.onDisconnected?.();
  }

  /** Open one WS and resolve when it closes (→ reconnect) or reject pre-open. */
  private connectOnce(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let ws: RealtimeSocketLike;
      try {
        ws = this.wsFactory(this.buildUrl());
      } catch (err) {
        reject(err as Error);
        return;
      }
      this.socket = ws;
      let opened = false;
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };

      ws.on('open', () => {
        opened = true;
        this.backoff = this.backoffMin; // reset on a healthy connect
        this.signalConnected();
        this.log(`[daemon] gateway WS realtime connected (since=${this.cursor})\n`);
      });
      ws.on('message', (data) => this.handleMessage(toText(data)));
      ws.on('error', (err) => {
        // Pre-open errors reject so the loop backs off; a `close` always follows.
        if (!opened) settle(() => reject(err));
      });
      ws.on('close', () => settle(resolve));
    });
  }

  /** Demux one WS frame and feed the materializer (sync channel only). */
  private handleMessage(raw: string): void {
    let frame: { ch?: string; name?: string; data?: unknown };
    try {
      frame = JSON.parse(raw) as typeof frame;
    } catch {
      return;
    }
    const name = frame.name;
    // Control frames carry no materializable data.
    if (name === 'heartbeat' || name === 'caught_up' || name === 'error') return;
    // Only the `sync` channel carries IM events the daemon materializes. The
    // `tasks` channel is the typed projection the daemon never consumed via SSE
    // (task.* already arrive on the per-user sync fan-out) → ignore to avoid
    // double-materialization.
    if (frame.ch !== 'sync' || name !== 'sync') return;

    const payload = (frame.data ?? {}) as RawWsEvent & { newestSeq?: number };

    // Backfill control envelopes ride the `sync` channel (parity with SSE).
    const type = payload.type;
    if (type === 'sync.backfill.truncated') {
      const newest = payload.newestSeq;
      if (typeof newest === 'number' && newest > this.cursor) this.advanceCursor(newest);
      return;
    }
    if (type === 'sync.backfill.done') {
      if (typeof payload.seq === 'number') this.advanceCursor(payload.seq);
      return;
    }

    // Real event → materialize (rm_* + per-conversation watermark + local relay).
    // `message.partial` carries no per-user seq; forward but don't advance.
    this.deps.materializer.ingest(payload);
    if (typeof payload.seq === 'number' && type !== 'message.partial') {
      this.advanceCursor(payload.seq);
    }
  }

  private advanceCursor(seq: number): void {
    if (seq <= this.cursor) return;
    this.cursor = seq;
    advanceWatermark(this.deps.db, SSE_CURSOR_DOMAIN, SSE_CURSOR_SCOPE, seq);
  }

  private buildUrl(): string {
    const u = new URL(this.deps.cloudBase);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.pathname = (u.pathname.replace(/\/$/, '') || '') + '/ws/realtime';
    u.searchParams.set('token', this.deps.apiKey);
    u.searchParams.set('since', String(this.cursor));
    return u.toString();
  }

  private waitBackoff(): Promise<void> {
    const jitter = Math.floor(Math.random() * 250);
    const delay = Math.min(this.backoff, this.backoffMax) + jitter;
    this.backoff = Math.min(this.backoff * 2, this.backoffMax);
    this.log(`[daemon] gateway WS realtime reconnect in ${delay}ms\n`);
    return new Promise((resolve) => {
      this.reconnectTimer = setTimeout(resolve, delay);
    });
  }
}

/** `ws` delivers RawData (Buffer | ArrayBuffer | Buffer[]); normalize to text. */
function toText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString('utf8');
  return (data as { toString(): string }).toString();
}
