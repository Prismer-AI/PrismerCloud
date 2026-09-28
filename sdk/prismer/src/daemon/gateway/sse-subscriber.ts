// Phase 6 / M1 — daemon→cloud SSE subscriber (docs/desktop202/13-sync-protocol-spec.md §5).
//
// WHY THIS EXISTS (background gap closed in this wave):
//   Cloud does NOT broadcast `message.new` onto the daemon's existing cloud WS.
//   Real-time IM data rides the *user's* Redis-backed SSE channel
//   (`GET /api/im/sync/stream?token=<apiKey>&since=<cursor>`), not the daemon WS
//   (which carries dispatch/host/agent control frames). So the WS materializer
//   tap in runner.ts is a forward-compatible no-op for IM events today. This
//   module is the missing read connection: when the local gateway is enabled the
//   daemon opens its OWN SSE subscription to cloud using its api key, and feeds
//   every `sync` event into the Materializer (rm_* upsert + watermark + local
//   SSE fan-out). It is a SECOND, independent daemon→cloud connection that
//   COEXISTS with the daemon WS — different jobs:
//     - WS  = dispatch relay (cloud → "this daemon owns the reply")
//     - SSE = real-time data materialization (cloud → rm_* read model)
//
// CAPABILITY: constructed only when the gateway is enabled. CLI/K8s daemons
// never build it → zero extra connections, zero behavior change.
//
// CURSOR SEMANTICS (important — two distinct seq spaces):
//   - The SSE `since` cursor is the per-USER monotonic `seq` (IMSyncEvent.id),
//     which is what sync-stream.ts replays/caps on. We persist it under the
//     sentinel watermark domain `__sse__` so reconnect resumes from the last
//     applied per-user seq (§5 "cursor 映射 = 恒等" for the boundarySeq space is
//     handled separately by the Materializer per-conversation).
//   - First cold boot has no stored seq → we start at `since=0`. Cloud caps
//     replay at BACKFILL_CAP (500) and, if the account is staler than that,
//     emits `sync.backfill.truncated{ newestSeq }` and closes; we then reconnect
//     from `newestSeq`, draining ≤500/connect to head (no full-replay storm, §13).

import type { Materializer, RawWsEvent } from './materializer.js';
import { advanceWatermark, getWatermark } from './read-model.js';

/** Sentinel watermark domain under which the per-user SSE `seq` cursor lives.
 *  Distinct from the per-conversation boundarySeq watermarks (domain='chats'). */
const SSE_CURSOR_DOMAIN = 'chats';
const SSE_CURSOR_SCOPE = '__sse__';

/** Reconnect backoff: 1s → ×2 → cap 30s (jittered). */
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

export interface SseSubscriberDeps {
  /** Cloud base URL (no trailing slash needed; we normalize). */
  cloudBase: string;
  /** Daemon api key — accepted by sync-stream.ts as `token` (api_key_proxy). */
  apiKey: string;
  /** Sink for every recognized `sync` event. */
  materializer: Materializer;
  /** Watermark store handle (rm_watermarks lives in local.db). */
  db: import('../../sync/store.js').LocalDb;
  /** Pluggable fetch (tests inject a stub that returns an SSE ReadableStream). */
  fetchImpl?: typeof fetch;
  /** Pluggable logger (defaults to process.stdout/stderr). */
  log?: (line: string) => void;
  /** Override reconnect backoff bounds (tests shrink these for speed). */
  backoffMinMs?: number;
  backoffMaxMs?: number;
  /** Phase 8b / M3 — connection state callbacks feeding the OnlineStateTracker
   *  (online-state.ts). `onConnected` fires once per successful SSE connect;
   *  `onDisconnected` fires when a live connection ends or a connect attempt
   *  fails. Optional → CLI/K8s daemons with no online-state tracker pass
   *  nothing and behavior is unchanged. */
  onConnected?: () => void;
  onDisconnected?: () => void;
}

/**
 * Long-lived SSE subscriber. `start()` opens the stream and auto-reconnects with
 * exponential backoff until `stop()`. Idempotent start/stop.
 */
export class SseSubscriber {
  private readonly fetchImpl: typeof fetch;
  private readonly log: (line: string) => void;
  private readonly backoffMin: number;
  private readonly backoffMax: number;
  private running = false;
  private controller: AbortController | null = null;
  private backoff: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Per-user seq cursor; loaded from the watermark on first start. */
  private cursor = 0;
  /** Tracks whether we've signalled `onConnected` for the live socket, so a
   *  clean EOF / error only fires `onDisconnected` once (M3). */
  private connectedSignalled = false;

  constructor(private readonly deps: SseSubscriberDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
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
    // Resume from the last persisted per-user seq (0 on first boot, §5/§13).
    this.cursor = getWatermark(this.deps.db, SSE_CURSOR_DOMAIN, SSE_CURSOR_SCOPE)?.cursor ?? 0;
    this.log(`[daemon] gateway SSE subscriber start (since=${this.cursor})\n`);
    void this.loop();
  }

  stop(): void {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.controller?.abort();
    this.controller = null;
  }

  // ── connection loop ────────────────────────────────────────────────────────
  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.connectOnce();
        // Clean EOF (server closed without error) → reconnect after backoff.
      } catch (err) {
        if (!this.running) return;
        this.log(`[daemon] gateway SSE error: ${(err as Error).message}\n`);
      }
      // The connection (if any) has ended — signal disconnect exactly once per
      // live socket (or per failed connect attempt while still down, so the
      // online-state tracker keeps accruing offline evidence, M3).
      this.signalDisconnected();
      if (!this.running) return;
      await this.waitBackoff();
    }
  }

  /** Fire `onConnected` once per live socket (M3 online-state). */
  private signalConnected(): void {
    if (this.connectedSignalled) return;
    this.connectedSignalled = true;
    this.deps.onConnected?.();
  }

  /** Fire `onDisconnected` for a dropped/failed connection (M3 online-state).
   *  Always fires after a connect attempt ends so repeated failures keep the
   *  tracker accruing offline evidence (it dedupes a no-op transition itself). */
  private signalDisconnected(): void {
    this.connectedSignalled = false;
    this.deps.onDisconnected?.();
  }

  /** Open one SSE connection and pump frames until it ends or aborts. */
  private async connectOnce(): Promise<void> {
    const url = this.buildUrl();
    const controller = new AbortController();
    this.controller = controller;

    const res = await this.fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'text/event-stream', Authorization: `Bearer ${this.deps.apiKey}` },
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      throw new Error(`SSE connect failed status=${res.status}`);
    }
    // Connection established → reset backoff for the next disconnect, and
    // signal the online-state tracker (M3) that the cloud read channel is live.
    this.backoff = this.backoffMin;
    this.signalConnected();
    this.log(`[daemon] gateway SSE connected (since=${this.cursor})\n`);

    await this.pump(res.body);
  }

  /** Read + parse the SSE byte stream, dispatching each `sync` data frame. */
  private async pump(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // SSE frames are separated by a blank line.
        const frames = buf.split('\n\n');
        buf = frames.pop() ?? '';
        for (const frame of frames) this.handleFrame(frame);
      }
    } finally {
      reader.cancel().catch(() => undefined);
    }
  }

  /** Parse one SSE frame (`event: <name>\nid: <seq>\ndata: <json>`). */
  private handleFrame(frame: string): void {
    const eventLine = frame.match(/^event: (.+)$/m);
    const dataLine = frame.match(/^data: ([\s\S]+)$/m);
    if (!dataLine) return; // comment-only (`: heartbeat`) or blank — ignore.
    const eventName = eventLine?.[1]?.trim() ?? 'message';
    if (eventName === 'heartbeat' || eventName === 'caught_up') return;
    if (eventName !== 'sync') return; // only the `sync` channel carries data.

    let payload: RawWsEvent & { error?: unknown };
    try {
      payload = JSON.parse(dataLine[1]!) as RawWsEvent;
    } catch {
      return;
    }

    // Control envelopes ride the `sync` channel (sync-stream.ts §P2).
    const type = payload.type;
    if (type === 'sync.backfill.truncated') {
      // Account staler than BACKFILL_CAP — jump our cursor to the newest seq the
      // cloud replayed; the server then closes and we reconnect from there,
      // draining ≤500/connect to head (no full-replay storm, §13).
      const newest = (payload as { newestSeq?: number }).newestSeq;
      if (typeof newest === 'number' && newest > this.cursor) {
        this.advanceCursor(newest);
      }
      return;
    }
    if (type === 'sync.backfill.done') {
      const seq = typeof payload.seq === 'number' ? payload.seq : undefined;
      if (typeof seq === 'number') this.advanceCursor(seq);
      return;
    }

    // Real event → feed the materializer (rm_* + per-conversation watermark +
    // local SSE fan-out). `message.partial` carries no per-user seq; forward it
    // for materialization but never advance the SSE cursor on it.
    this.deps.materializer.ingest(payload);
    if (typeof payload.seq === 'number' && type !== 'message.partial') {
      this.advanceCursor(payload.seq);
    }
  }

  /** Persist the per-user SSE seq cursor so reconnect resumes from here. */
  private advanceCursor(seq: number): void {
    if (seq <= this.cursor) return;
    this.cursor = seq;
    advanceWatermark(this.deps.db, SSE_CURSOR_DOMAIN, SSE_CURSOR_SCOPE, seq);
  }

  private buildUrl(): string {
    const base = this.deps.cloudBase.replace(/\/$/, '');
    const params = new URLSearchParams({
      token: this.deps.apiKey,
      since: String(this.cursor),
    });
    return `${base}/api/im/sync/stream?${params.toString()}`;
  }

  private waitBackoff(): Promise<void> {
    // Anti-thundering-herd jitter, but never exceed the configured max reconnect
    // delay — so `backoffMax` is a true upper bound on the wait (prod: 30s ≫ 250ms
    // → unchanged 0-250ms jitter; small-backoffMax test configs stay deterministic
    // rather than being dominated by a fixed 250ms).
    const jitter = Math.floor(Math.random() * Math.min(250, this.backoffMax));
    const delay = Math.min(this.backoff, this.backoffMax) + jitter;
    this.backoff = Math.min(this.backoff * 2, this.backoffMax);
    this.log(`[daemon] gateway SSE reconnect in ${delay}ms\n`);
    return new Promise((resolve) => {
      this.reconnectTimer = setTimeout(resolve, delay);
    });
  }
}
