// Cloud WebSocket client. Replaces 1.9.0's RelayClient + multi-path-transport.
// See docs/refactor/04-daemon-runtime.md §ws-client.ts and 13-error-handling §2.2.

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

export interface WsClientOptions {
  /** Cloud WS URL, e.g. `wss://cloud.prismer.dev/ws` or `ws://127.0.0.1:3000/ws`. */
  url: string;
  /** API key passed as `?token=<apiKey>` (matches 1.7.x token query auth). */
  apiKey: string;
  /** Initial reconnect delay (ms). Defaults to 1000. */
  reconnectInitialMs?: number;
  /** Reconnect cap (ms). Defaults to 60_000. */
  reconnectMaxMs?: number;
  /** Max consecutive reconnect attempts before entering degraded mode. Defaults to 30. */
  maxReconnectAttempts?: number;
  /** How long to stay in degraded mode before retrying (ms). Defaults to 5 minutes. */
  degradedCooldownMs?: number;
}

/** Subset of close codes we special-case. */
export const WS_CLOSE = {
  /** RFC 6455 normal closure — no reconnect. */
  NORMAL: 1000,
  /** Custom auth failure — no auto-reconnect; surface to user. */
  AUTH: 4001,
} as const;

/**
 * Events emitted:
 *  - `open`             ws successfully opened
 *  - `message` (msg)    incoming JSON-parsed message
 *  - `close` (code, reason)  connection closed (auto-reconnect happens after this)
 *  - `error` (err)      transport error or invalid JSON received
 *  - `drop` (msg)       send() called when not OPEN; caller may enqueue
 *  - `auth-failed`      close code 4001 — user must rerun setup; no auto-reconnect
 *  - `degraded`         max reconnect attempts hit; pausing for cooldown
 *  - `reconnect-scheduled` (ms) reconnect timer set
 */
export class WsClient extends EventEmitter {
  private ws?: WebSocket;
  private reconnectMs: number;
  private reconnectAttempts = 0;
  private closed = false;
  private reconnectTimer?: NodeJS.Timeout;

  constructor(private opts: WsClientOptions) {
    super();
    this.reconnectMs = opts.reconnectInitialMs ?? 1000;
  }

  start(): void {
    this.closed = false;
    this.connect();
  }

  /** Send a JSON-serializable message. Caller is responsible for envelope construction. */
  send(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      this.emit('drop', msg);
    }
  }

  /** Close intentionally — no reconnect. */
  close(code = WS_CLOSE.NORMAL): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.ws?.close(code);
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private connect(): void {
    if (this.closed) return;
    const url = `${this.opts.url}?token=${encodeURIComponent(this.opts.apiKey)}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      this.reconnectMs = this.opts.reconnectInitialMs ?? 1000;
      this.reconnectAttempts = 0;
      this.emit('open');
    });

    ws.on('message', (raw) => {
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch (err) {
        this.emit('error', new Error(`Invalid JSON from ws: ${(err as Error).message}`));
        return;
      }
      this.emit('message', msg);
    });

    ws.on('close', (code, reason) => {
      this.emit('close', code, reason.toString());
      if (this.closed) return;
      if (code === WS_CLOSE.NORMAL) {
        this.closed = true;
        return;
      }
      if (code === WS_CLOSE.AUTH) {
        this.closed = true;
        this.emit('auth-failed');
        return;
      }
      this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      this.emit('error', err);
      // close event will follow and trigger reconnect
    });
  }

  private scheduleReconnect(): void {
    const maxAttempts = this.opts.maxReconnectAttempts ?? 30;
    if (this.reconnectAttempts >= maxAttempts) {
      this.emit('degraded');
      const cooldown = this.opts.degradedCooldownMs ?? 5 * 60_000;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectAttempts = 0;
        this.reconnectMs = this.opts.reconnectInitialMs ?? 1000;
        this.connect();
      }, cooldown);
      return;
    }
    const delay = this.reconnectMs;
    this.emit('reconnect-scheduled', delay);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
    this.reconnectAttempts += 1;
    this.reconnectMs = Math.min(this.reconnectMs * 2, this.opts.reconnectMaxMs ?? 60_000);
  }
}
