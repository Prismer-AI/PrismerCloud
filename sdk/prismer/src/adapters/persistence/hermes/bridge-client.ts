// spec 11 / Task 4 — daemon-side transport for the `prismer` Hermes gateway
// platform plugin (`~/.hermes/profiles/<p>/plugins/prismer/adapter.py`).
//
// The plugin registers a Hermes *platform*: the gateway LISTENS on
// 127.0.0.1:<PRISMER_PLATFORM_PORT> and the daemon connects as the client.
// Transport is newline-delimited UTF-8 JSON; one IM conversation == one chat
// (chat_id == conversation_id), user_id == sender_id.
//
//   inbound  (daemon -> gateway):
//     {"t":"in","conversation_id","sender_id","sender_name","text",
//      "message_id","metadata"}
//   outbound (gateway -> daemon):
//     {"t":"out","chat_id","content","reply_to","metadata","message_id","error"}
//
// Gateway-side behaviours this client transports verbatim — deliberately NOT
// papered over here (they are gateway defects / contract facts, recorded so the
// next reader does not re-derive them):
//
//   * `reply_to` can be mis-anchored when several turns are in flight (burst
//     send). We never rewrite or guess it — the anchor is the gateway's to set.
//   * The gateway's `send()` returns `SendResult(success=false,
//     error="no daemon bridge connected")` when no client is attached. That
//     result goes back to the *agent*, NOT onto the wire — a detached daemon
//     observes nothing at all (the turn simply goes silent). Connection state
//     must therefore come from `isConnected`, never be inferred from frames.
//   * The pairing gate ("hermes pairing approve prismer <CODE>") arrives as an
//     ordinary outbound `content` on the first turn. Normal passthrough.
//   * The plugin drops inbound frames whose `t` != "in" or whose `text` is
//     blank WITHOUT an error frame (adapter.py `_on_inbound`). A malformed send
//     is invisible on the wire, so `sendInbound` refuses locally instead of
//     writing something the gateway will silently discard.

import { randomUUID } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import { createLogger } from '../../../lib/logger.js';

const log = createLogger('hermes-bridge');

/** Loopback only — the plugin binds 127.0.0.1, never a routable interface. */
export const BRIDGE_DEFAULT_HOST = '127.0.0.1';
/** Plugin default when `PRISMER_PLATFORM_PORT` is unset (adapter.py `_port()`). */
export const BRIDGE_DEFAULT_PORT = 8788;
export const BRIDGE_DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
export const BRIDGE_DEFAULT_RECONNECT_DELAY_MS = 1_000;
/**
 * Ceiling on the pending-line buffer. The plugin truncates content at 32 000
 * chars (≈32× headroom here), so a longer line means the peer is not speaking
 * this protocol — drop the buffer instead of growing it without bound.
 */
export const BRIDGE_MAX_LINE_CHARS = 1_048_576;

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

export interface BridgeInboundFrame {
  t: 'in';
  conversation_id: string;
  sender_id: string;
  sender_name: string;
  text: string;
  message_id: string;
  metadata: Record<string, unknown>;
}

export interface BridgeOutboundFrame {
  t: 'out';
  chat_id: string;
  content: string;
  reply_to: string | null;
  metadata: Record<string, unknown>;
  message_id: string;
  /** Non-null when the gateway reports a delivery failure for this reply. */
  error: string | null;
}

export interface BridgeInboundInput {
  conversationId: string;
  senderId: string;
  senderName: string;
  text: string;
  /** Defaults to a fresh uuid; the caller keeps it to anchor `reply_to`. */
  messageId?: string;
  metadata?: Record<string, unknown>;
}

export type BridgeFrameParse =
  | { ok: true; frame: BridgeOutboundFrame }
  | { ok: false; error: string };

/**
 * Build the frame the plugin expects on the wire. Shape mirrors
 * `adapter.py::_on_inbound` field-for-field — snake_case keys, `t` first.
 */
export function buildInboundFrame(input: BridgeInboundInput): BridgeInboundFrame {
  return {
    t: 'in',
    conversation_id: input.conversationId,
    sender_id: input.senderId,
    sender_name: input.senderName,
    text: input.text,
    message_id: input.messageId ?? randomUUID().replace(/-/g, ''),
    metadata: input.metadata ?? {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse one outbound line into a usable frame.
 *
 * Strict on the two fields a reply cannot be routed without (`chat_id`,
 * `content`); everything else normalises to its documented default. Gateway
 * field drift must degrade to a still-usable frame rather than a dropped reply
 * — `reply_to`/`metadata`/`message_id`/`error` are omitted defaults, not
 * errors.
 */
export function parseOutboundFrame(raw: string): BridgeFrameParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `not JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!isRecord(parsed)) return { ok: false, error: 'not a JSON object' };
  if (parsed.t !== 'out') return { ok: false, error: `unexpected t=${JSON.stringify(parsed.t)}` };
  if (typeof parsed.chat_id !== 'string') return { ok: false, error: 'chat_id is not a string' };
  if (typeof parsed.content !== 'string') return { ok: false, error: 'content is not a string' };

  const replyTo = parsed.reply_to;
  if (replyTo !== null && replyTo !== undefined && typeof replyTo !== 'string') {
    return { ok: false, error: 'reply_to is neither string nor null' };
  }
  const error = parsed.error;
  if (error !== null && error !== undefined && typeof error !== 'string') {
    return { ok: false, error: 'error is neither string nor null' };
  }

  return {
    ok: true,
    frame: {
      t: 'out',
      chat_id: parsed.chat_id,
      content: parsed.content,
      reply_to: typeof replyTo === 'string' ? replyTo : null,
      metadata: isRecord(parsed.metadata) ? parsed.metadata : {},
      message_id: typeof parsed.message_id === 'string' ? parsed.message_id : '',
      error: typeof error === 'string' ? error : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Health probe
// ---------------------------------------------------------------------------

export interface BridgeProbeResult {
  reachable: boolean;
  host: string;
  port: number;
  latencyMs: number | null;
  /** Node errno (`ECONNREFUSED`, …) when the dial failed at the OS level. */
  code: string | null;
  error: string | null;
}

export interface BridgeProbeOptions {
  port: number;
  host?: string;
  timeoutMs?: number;
}

/**
 * Liveness probe: open a TCP connection and close it. The bridge protocol has
 * no ping/pong frame, so reachability IS the health signal.
 *
 * NEVER rejects and never hangs — a missing bridge resolves
 * `{ reachable: false, code: 'ECONNREFUSED' | 'ETIMEDOUT', error }` so callers
 * get an explicit answer instead of an unhandled rejection.
 */
export function probeBridge(options: BridgeProbeOptions): Promise<BridgeProbeResult> {
  const host = options.host ?? BRIDGE_DEFAULT_HOST;
  const port = options.port;
  const timeoutMs = options.timeoutMs ?? BRIDGE_DEFAULT_CONNECT_TIMEOUT_MS;
  const startedAt = Date.now();

  return new Promise<BridgeProbeResult>((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: BridgeProbeResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };

    timer = setTimeout(() => {
      finish({
        reachable: false,
        host,
        port,
        latencyMs: null,
        code: 'ETIMEDOUT',
        error: `bridge probe timed out after ${timeoutMs}ms (${host}:${port})`,
      });
    }, timeoutMs);

    socket.once('connect', () => {
      finish({
        reachable: true,
        host,
        port,
        latencyMs: Date.now() - startedAt,
        code: null,
        error: null,
      });
    });
    socket.once('error', (err: NodeJS.ErrnoException) => {
      finish({
        reachable: false,
        host,
        port,
        latencyMs: null,
        code: err.code ?? null,
        error: `bridge unreachable at ${host}:${port}: ${err.message}`,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export type BridgeConnectionState = 'idle' | 'connecting' | 'connected' | 'closed';

export type BridgeSendResult = { ok: true; messageId: string } | { ok: false; error: string };

export interface BridgeClientOptions {
  port: number;
  host?: string;
  connectTimeoutMs?: number;
  /** Delay between reconnect attempts after an unexpected drop. */
  reconnectDelayMs?: number;
  /** Reconnect after a drop. Default true; `close()` always stops the loop. */
  autoReconnect?: boolean;
  /** Called for every parsed outbound frame. */
  onOutbound: (frame: BridgeOutboundFrame) => void;
  /** Called for every unparseable / wrong-shaped line. Never throws. */
  onMalformed?: (raw: string, reason: string) => void;
  onStateChange?: (state: BridgeConnectionState) => void;
}

interface ConnectWaiter {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Long-lived client for the bridge socket: dials, frames lines, reconnects on
 * drop and surfaces the outbound stream to `onOutbound`.
 *
 * Nothing here throws asynchronously — a dead bridge shows up as a state
 * change, a `log.warn`, a failed `sendInbound` result, or a rejected
 * `waitForConnected`. There is no path that silently swallows a failure.
 */
export class BridgeClient {
  readonly host: string;
  readonly port: number;

  private readonly connectTimeoutMs: number;
  private readonly reconnectDelayMs: number;
  private readonly autoReconnect: boolean;
  private readonly options: BridgeClientOptions;

  private socket: Socket | null = null;
  private started = false;
  private state: BridgeConnectionState = 'idle';
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private lineBuffer = '';
  private lastError: string | null = null;
  private attempts = 0;
  private readonly waiters = new Set<ConnectWaiter>();

  constructor(options: BridgeClientOptions) {
    this.options = options;
    this.host = options.host ?? BRIDGE_DEFAULT_HOST;
    this.port = options.port;
    this.connectTimeoutMs = options.connectTimeoutMs ?? BRIDGE_DEFAULT_CONNECT_TIMEOUT_MS;
    this.reconnectDelayMs = options.reconnectDelayMs ?? BRIDGE_DEFAULT_RECONNECT_DELAY_MS;
    this.autoReconnect = options.autoReconnect ?? true;
  }

  get connectionState(): BridgeConnectionState {
    return this.state;
  }

  get isConnected(): boolean {
    return this.state === 'connected' && this.socket !== null && !this.socket.destroyed;
  }

  /** Dial attempts so far (initial + reconnects). Diagnostics/tests only. */
  get connectAttempts(): number {
    return this.attempts;
  }

  /** Last dial/socket error, human-readable. Null before any failure. */
  get lastConnectError(): string | null {
    return this.lastError;
  }

  /** Begin dialing. Idempotent while started. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.attempts = 0;
    this.dial();
  }

  /**
   * Resolve once the socket is up, reject with an explicit error on timeout.
   * Rejects immediately if the client was closed while waiting.
   */
  waitForConnected(timeoutMs = this.connectTimeoutMs): Promise<void> {
    if (this.isConnected) return Promise.resolve();
    if (this.state === 'closed') {
      return Promise.reject(new Error('bridge client is closed'));
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: ConnectWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(
            new Error(
              `bridge unreachable at ${this.host}:${this.port} after ${timeoutMs}ms` +
                (this.lastError ? ` (last error: ${this.lastError})` : ''),
            ),
          );
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  /**
   * Write one inbound frame. Never throws: a detached socket, a blank `text`
   * (the gateway drops those silently) and a build failure all come back as
   * `{ ok: false, error }`.
   */
  sendInbound(input: BridgeInboundInput): BridgeSendResult {
    if (!input.text.trim()) {
      return { ok: false, error: 'empty text — the gateway discards blank frames silently' };
    }
    const socket = this.socket;
    if (!socket || !this.isConnected) {
      return { ok: false, error: `bridge not connected (state=${this.state}${this.lastError ? `, last error: ${this.lastError}` : ''})` };
    }
    const frame = buildInboundFrame(input);
    try {
      socket.write(`${JSON.stringify(frame)}\n`, 'utf8');
    } catch (err) {
      return { ok: false, error: `bridge write failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    return { ok: true, messageId: frame.message_id };
  }

  /**
   * Stop for good: drop the socket, cancel the reconnect loop, reject anything
   * still waiting on `waitForConnected`. Safe to call repeatedly.
   */
  async close(): Promise<void> {
    this.started = false;
    this.clearReconnectTimer();
    this.clearConnectTimer();
    this.lineBuffer = '';
    const socket = this.socket;
    this.socket = null;
    for (const waiter of [...this.waiters]) {
      this.waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.reject(new Error('bridge client closed'));
    }
    this.setState('closed');
    if (!socket || socket.destroyed) return;
    await new Promise<void>((resolve) => {
      socket.once('close', () => resolve());
      socket.destroy();
    });
  }

  // -- internals ------------------------------------------------------------

  private setState(next: BridgeConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    try {
      this.options.onStateChange?.(next);
    } catch (err) {
      log.warn('onStateChange callback threw', err);
    }
  }

  private dial(): void {
    this.attempts += 1;
    this.setState('connecting');
    const socket = createConnection({ host: this.host, port: this.port });
    this.socket = socket;
    this.lineBuffer = '';
    // StringDecoder under the hood: a multi-byte UTF-8 char split across two
    // TCP reads is reassembled, not mojibake'd.
    socket.setEncoding('utf8');

    this.connectTimer = setTimeout(() => {
      socket.destroy(new Error(`connect timeout after ${this.connectTimeoutMs}ms`));
    }, this.connectTimeoutMs);

    socket.on('connect', () => {
      this.clearConnectTimer();
      this.lastError = null;
      this.setState('connected');
      log.info(`connected to ${this.host}:${this.port}`);
      for (const waiter of [...this.waiters]) {
        this.waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
    });

    socket.on('data', (chunk: string) => this.onData(chunk));

    socket.on('error', (err: NodeJS.ErrnoException) => {
      this.lastError = err.code ? `${err.code}: ${err.message}` : err.message;
      // Not fatal on its own — 'close' always follows and owns the retry.
      log.warn(`socket error (${this.host}:${this.port})`, this.lastError);
    });

    socket.on('close', () => {
      this.clearConnectTimer();
      if (this.socket !== socket) return; // superseded by a newer dial
      this.socket = null;
      this.lineBuffer = '';
      if (!this.started) {
        this.setState('closed');
        return;
      }
      if (!this.autoReconnect) {
        log.warn('bridge disconnected — auto-reconnect disabled');
        this.setState('closed');
        return;
      }
      this.setState('connecting');
      log.warn(`bridge disconnected — retrying in ${this.reconnectDelayMs}ms`);
      this.clearReconnectTimer();
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (this.started) this.dial();
      }, this.reconnectDelayMs);
    });
  }

  private onData(chunk: string): void {
    this.lineBuffer += chunk;
    if (this.lineBuffer.length > BRIDGE_MAX_LINE_CHARS) {
      const size = this.lineBuffer.length;
      this.lineBuffer = '';
      this.reportMalformed('', `pending line exceeded ${BRIDGE_MAX_LINE_CHARS} chars (${size})`);
      return;
    }
    let newline = this.lineBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.lineBuffer.slice(0, newline);
      this.lineBuffer = this.lineBuffer.slice(newline + 1);
      this.onLine(line);
      newline = this.lineBuffer.indexOf('\n');
    }
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    const parsed = parseOutboundFrame(trimmed);
    if (!parsed.ok) {
      this.reportMalformed(trimmed, parsed.error);
      return;
    }
    if (parsed.frame.error) {
      // Gateway-reported delivery failure — deliver it AND make noise, so a
      // failed reply is never mistaken for a silent turn.
      log.warn(`outbound frame carries error from gateway`, parsed.frame.error);
    }
    try {
      this.options.onOutbound(parsed.frame);
    } catch (err) {
      log.error('onOutbound callback threw', err);
    }
  }

  private reportMalformed(raw: string, reason: string): void {
    log.warn(`dropping malformed outbound line (${reason})`, raw.slice(0, 200));
    try {
      this.options.onMalformed?.(raw, reason);
    } catch (err) {
      log.error('onMalformed callback threw', err);
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }
}
