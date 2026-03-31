/**
 * Prismer Cloud Real-Time Client — WebSocket & SSE transports.
 *
 * @example
 * ```typescript
 * const ws = client.im.connectWS({ token: jwtToken });
 * await ws.connect();
 *
 * ws.on('message.new', (msg) => console.log(msg.content));
 * ws.joinConversation('conv-123');
 * ws.sendMessage('conv-123', 'Hello!');
 *
 * // SSE (server-push only, auto-joins all conversations)
 * const sse = client.im.connectSSE({ token: jwtToken });
 * await sse.connect();
 * sse.on('message.new', (msg) => console.log(msg.content));
 * ```
 */

// ============================================================================
// Event Payload Types
// ============================================================================

export interface AuthenticatedPayload {
  userId: string;
  username: string;
}

export interface MessageNewPayload {
  id: string;
  conversationId: string;
  content: string;
  type: string;
  senderId: string;
  routing?: { mode: string; targets: Array<{ userId: string; username?: string }> };
  metadata?: Record<string, any>;
  createdAt: string;
}

export interface MessageEditPayload {
  id: string;
  conversationId: string;
  content: string;
  type: string;
  editedAt: string;
  editedBy: string;
  metadata?: Record<string, any>;
}

export interface MessageDeletedPayload {
  id: string;
  conversationId: string;
}

export interface TypingIndicatorPayload {
  conversationId: string;
  userId: string;
  isTyping: boolean;
}

export interface PresenceChangedPayload {
  userId: string;
  status: string;
}

export interface PongPayload {
  requestId: string;
}

export interface ErrorPayload {
  message: string;
}

export interface DisconnectedPayload {
  code: number;
  reason: string;
}

export interface ReconnectingPayload {
  attempt: number;
  delayMs: number;
}

// ============================================================================
// Event Map (for typed on/off/once)
// ============================================================================

export interface RealtimeEventMap {
  'authenticated': AuthenticatedPayload;
  'message.new': MessageNewPayload;
  'message.edit': MessageEditPayload;
  'message.deleted': MessageDeletedPayload;
  'typing.indicator': TypingIndicatorPayload;
  'presence.changed': PresenceChangedPayload;
  'pong': PongPayload;
  'error': ErrorPayload;
  'connected': undefined;
  'disconnected': DisconnectedPayload;
  'reconnecting': ReconnectingPayload;
}

export type RealtimeEventType = keyof RealtimeEventMap;

// ============================================================================
// Command Types (WS only)
// ============================================================================

export interface RealtimeCommand {
  type: string;
  payload: unknown;
  requestId?: string;
}

// ============================================================================
// Configuration
// ============================================================================

export interface RealtimeConfig {
  /** JWT token for authentication */
  token: string;
  /** Auto-reconnect on disconnect (default: true) */
  autoReconnect?: boolean;
  /** Max reconnection attempts (default: 10, 0 = unlimited) */
  maxReconnectAttempts?: number;
  /** Base delay for exponential backoff in ms (default: 1000) */
  reconnectBaseDelay?: number;
  /** Max delay cap in ms (default: 30000) */
  reconnectMaxDelay?: number;
  /** Heartbeat interval in ms (default: 25000) */
  heartbeatInterval?: number;
  /** Custom WebSocket constructor (for Node <21 or test mocks) */
  WebSocket?: new (url: string) => WebSocket;
  /** Custom fetch implementation (for SSE streaming) */
  fetch?: typeof fetch;
}

export type RealtimeState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

// ============================================================================
// Typed Event Emitter
// ============================================================================

type Listener<T> = (payload: T) => void;

class TypedEmitter {
  private listeners: Map<string, Set<Listener<any>>> = new Map();

  on<E extends RealtimeEventType>(event: E, cb: Listener<RealtimeEventMap[E]>): this {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(cb);
    return this;
  }

  off<E extends RealtimeEventType>(event: E, cb: Listener<RealtimeEventMap[E]>): this {
    this.listeners.get(event)?.delete(cb);
    return this;
  }

  once<E extends RealtimeEventType>(event: E, cb: Listener<RealtimeEventMap[E]>): this {
    const wrapper: Listener<RealtimeEventMap[E]> = (payload) => {
      this.off(event, wrapper);
      cb(payload);
    };
    return this.on(event, wrapper);
  }

  protected emit<E extends RealtimeEventType>(event: E, payload: RealtimeEventMap[E]): void {
    const set = this.listeners.get(event);
    if (set) {
      for (const cb of set) {
        try { cb(payload); } catch (_) { /* user callback errors should not crash the client */ }
      }
    }
  }

  protected removeAllListeners(): void {
    this.listeners.clear();
  }
}

// ============================================================================
// Reconnector
// ============================================================================

class Reconnector {
  private attempt = 0;
  private connectedAt = 0;
  private readonly baseDelay: number;
  private readonly maxDelay: number;
  private readonly maxAttempts: number;

  constructor(config: RealtimeConfig) {
    this.baseDelay = config.reconnectBaseDelay ?? 1000;
    this.maxDelay = config.reconnectMaxDelay ?? 30000;
    this.maxAttempts = config.maxReconnectAttempts ?? 10;
  }

  get shouldReconnect(): boolean {
    return this.maxAttempts === 0 || this.attempt < this.maxAttempts;
  }

  get currentAttempt(): number {
    return this.attempt;
  }

  markConnected(): void {
    this.connectedAt = Date.now();
  }

  nextDelay(): number {
    // Reset attempt counter if connection was stable for >60s
    if (this.connectedAt > 0 && Date.now() - this.connectedAt > 60000) {
      this.attempt = 0;
    }
    const jitter = Math.random() * this.baseDelay * 0.5;
    const delay = Math.min(this.baseDelay * Math.pow(2, this.attempt) + jitter, this.maxDelay);
    this.attempt++;
    return delay;
  }

  reset(): void {
    this.attempt = 0;
    this.connectedAt = 0;
  }
}

// ============================================================================
// RealtimeWSClient
// ============================================================================

export class RealtimeWSClient extends TypedEmitter {
  private ws: WebSocket | null = null;
  private reconnector: Reconnector;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPings: Map<string, { resolve: (p: PongPayload) => void; timer: ReturnType<typeof setTimeout> }> = new Map();
  private _state: RealtimeState = 'disconnected';
  private intentionalClose = false;
  private readonly wsUrl: string;
  private readonly config: Required<Pick<RealtimeConfig, 'token' | 'autoReconnect' | 'heartbeatInterval'>> & RealtimeConfig;
  private readonly WS: new (url: string) => WebSocket;
  private pingCounter = 0;

  get state(): RealtimeState { return this._state; }

  constructor(baseUrl: string, config: RealtimeConfig) {
    super();
    const base = baseUrl.replace(/^http/, 'ws');
    this.wsUrl = `${base}/ws?token=${config.token}`;
    this.config = {
      autoReconnect: true,
      heartbeatInterval: 25000,
      ...config,
    };
    this.reconnector = new Reconnector(config);
    this.WS = config.WebSocket || WebSocket;
  }

  async connect(): Promise<void> {
    if (this._state === 'connected' || this._state === 'connecting') return;

    this._state = 'connecting';
    this.intentionalClose = false;

    return new Promise<void>((resolve, reject) => {
      try {
        this.ws = new this.WS(this.wsUrl);
      } catch (err) {
        this._state = 'disconnected';
        reject(err);
        return;
      }

      const onOpen = () => {
        cleanup();
      };

      const onFirstMessage = (ev: MessageEvent) => {
        try {
          const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
          if (msg.type === 'authenticated') {
            this._state = 'connected';
            this.reconnector.markConnected();
            this.startHeartbeat();
            this.emit('authenticated', msg.payload);
            this.emit('connected', undefined);
            // Switch to normal message handler
            this.ws!.removeEventListener('message', onFirstMessage);
            this.ws!.addEventListener('message', this.handleMessage);
            resolve();
          }
        } catch (_) { /* ignore parse errors during auth */ }
      };

      const onError = (ev: Event) => {
        cleanup();
        if (this._state === 'connecting') {
          this._state = 'disconnected';
          reject(new Error('WebSocket connection failed'));
        }
      };

      const onClose = (ev: CloseEvent) => {
        cleanup();
        if (this._state === 'connecting') {
          this._state = 'disconnected';
          reject(new Error(`WebSocket closed during connect: ${ev.code} ${ev.reason}`));
        }
      };

      const cleanup = () => {
        this.ws?.removeEventListener('error', onError);
        this.ws?.removeEventListener('close', onClose);
      };

      this.ws.addEventListener('open', onOpen);
      this.ws.addEventListener('message', onFirstMessage);
      this.ws.addEventListener('error', onError);
      this.ws.addEventListener('close', onClose);

      // After initial setup, install persistent close handler
      this.ws.addEventListener('close', this.handleClose);
    });
  }

  disconnect(code = 1000, reason = 'client disconnect'): void {
    this.intentionalClose = true;
    this.stopHeartbeat();
    this.clearReconnectTimer();
    this.clearPendingPings();
    if (this.ws) {
      this.ws.removeEventListener('message', this.handleMessage);
      this.ws.removeEventListener('close', this.handleClose);
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close(code, reason);
      }
      this.ws = null;
    }
    this._state = 'disconnected';
    this.emit('disconnected', { code, reason });
  }

  // --- Commands ---

  joinConversation(conversationId: string): void {
    this.sendRaw({ type: 'conversation.join', payload: { conversationId } });
  }

  sendMessage(conversationId: string, content: string, options?: string | { type?: string; metadata?: Record<string, any>; parentId?: string }): void {
    const opts = typeof options === 'string' ? { type: options } : options;
    this.sendRaw({
      type: 'message.send',
      payload: { conversationId, content, type: opts?.type ?? 'text', ...(opts?.metadata ? { metadata: opts.metadata } : {}), ...(opts?.parentId ? { parentId: opts.parentId } : {}) },
      requestId: `msg-${++this.pingCounter}`,
    });
  }

  startTyping(conversationId: string): void {
    this.sendRaw({ type: 'typing.start', payload: { conversationId } });
  }

  stopTyping(conversationId: string): void {
    this.sendRaw({ type: 'typing.stop', payload: { conversationId } });
  }

  updatePresence(status: string): void {
    this.sendRaw({ type: 'presence.update', payload: { status } });
  }

  send(command: RealtimeCommand): void {
    this.sendRaw(command);
  }

  ping(): Promise<PongPayload> {
    const requestId = `ping-${++this.pingCounter}`;
    return new Promise<PongPayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingPings.delete(requestId);
        reject(new Error('Ping timeout'));
      }, 10000);
      this.pendingPings.set(requestId, { resolve, timer });
      this.sendRaw({ type: 'ping', payload: { requestId } });
    });
  }

  // --- Internal ---

  private sendRaw(data: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private handleMessage = (ev: MessageEvent): void => {
    try {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      const { type, payload } = msg;

      // Handle pong with pending ping resolution
      if (type === 'pong' && payload?.requestId) {
        const pending = this.pendingPings.get(payload.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          pending.resolve(payload);
          this.pendingPings.delete(payload.requestId);
        }
      }

      this.emit(type, payload);
    } catch (_) { /* ignore malformed messages */ }
  };

  private handleClose = (ev: CloseEvent): void => {
    this.stopHeartbeat();
    this.clearPendingPings();
    this.ws = null;

    if (this.intentionalClose) return;

    this._state = 'disconnected';
    this.emit('disconnected', { code: ev.code, reason: ev.reason });

    if (this.config.autoReconnect && this.reconnector.shouldReconnect) {
      this.scheduleReconnect();
    }
  };

  private scheduleReconnect(): void {
    const delay = this.reconnector.nextDelay();
    this._state = 'reconnecting';
    this.emit('reconnecting', { attempt: this.reconnector.currentAttempt, delayMs: delay });

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
      } catch (_) {
        // connect() failed, handleClose will fire again and retry
        if (this.config.autoReconnect && this.reconnector.shouldReconnect) {
          this.scheduleReconnect();
        } else {
          this._state = 'disconnected';
        }
      }
    }, delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this._state !== 'connected') return;
      const requestId = `hb-${++this.pingCounter}`;
      this.sendRaw({ type: 'ping', payload: { requestId } });

      // If no pong within 10s, force close to trigger reconnect
      this.pongTimer = setTimeout(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.close(4000, 'heartbeat timeout');
        }
      }, 10000);

      // Clear pong timer when we receive any pong
      const onPong = (payload: PongPayload) => {
        if (this.pongTimer) {
          clearTimeout(this.pongTimer);
          this.pongTimer = null;
        }
        this.off('pong', onPong);
      };
      this.on('pong', onPong);
    }, this.config.heartbeatInterval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearPendingPings(): void {
    for (const [, { timer }] of this.pendingPings) {
      clearTimeout(timer);
    }
    this.pendingPings.clear();
  }
}

// ============================================================================
// RealtimeSSEClient
// ============================================================================

export class RealtimeSSEClient extends TypedEmitter {
  private abortController: AbortController | null = null;
  private reconnector: Reconnector;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatWatchdog: ReturnType<typeof setInterval> | null = null;
  private lastDataTime = 0;
  private _state: RealtimeState = 'disconnected';
  private intentionalClose = false;
  private readonly sseUrl: string;
  private readonly config: Required<Pick<RealtimeConfig, 'token' | 'autoReconnect'>> & RealtimeConfig;
  private readonly fetchFn: typeof fetch;

  get state(): RealtimeState { return this._state; }

  constructor(baseUrl: string, config: RealtimeConfig) {
    super();
    this.sseUrl = `${baseUrl}/sse?token=${config.token}`;
    this.config = {
      autoReconnect: true,
      ...config,
    };
    this.reconnector = new Reconnector(config);
    this.fetchFn = config.fetch || fetch;
  }

  async connect(): Promise<void> {
    if (this._state === 'connected' || this._state === 'connecting') return;

    this._state = 'connecting';
    this.intentionalClose = false;
    this.abortController = new AbortController();

    const response = await this.fetchFn(this.sseUrl, {
      headers: { 'Accept': 'text/event-stream' },
      signal: this.abortController.signal,
    });

    if (!response.ok) {
      this._state = 'disconnected';
      throw new Error(`SSE connection failed: ${response.status}`);
    }

    if (!response.body) {
      this._state = 'disconnected';
      throw new Error('SSE response has no body');
    }

    this._state = 'connected';
    this.reconnector.markConnected();
    this.lastDataTime = Date.now();
    this.startHeartbeatWatchdog();
    this.emit('connected', undefined);

    // Read the stream in the background
    this.readStream(response.body);
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.stopHeartbeatWatchdog();
    this.clearReconnectTimer();
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this._state = 'disconnected';
    this.emit('disconnected', { code: 1000, reason: 'client disconnect' });
  }

  // --- Internal ---

  private async readStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          this.lastDataTime = Date.now();

          if (line.startsWith(':')) {
            // Heartbeat comment — just update lastDataTime
            continue;
          }

          if (line.startsWith('data: ')) {
            const jsonStr = line.slice(6);
            try {
              const msg = JSON.parse(jsonStr);
              this.emit(msg.type, msg.payload);
            } catch (_) { /* ignore malformed JSON */ }
          }
        }
      }
    } catch (err) {
      if (this.intentionalClose) return;
    } finally {
      reader.releaseLock();
    }

    // Stream ended
    if (this.intentionalClose) return;

    this._state = 'disconnected';
    this.stopHeartbeatWatchdog();
    this.emit('disconnected', { code: 0, reason: 'stream ended' });

    if (this.config.autoReconnect && this.reconnector.shouldReconnect) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    const delay = this.reconnector.nextDelay();
    this._state = 'reconnecting';
    this.emit('reconnecting', { attempt: this.reconnector.currentAttempt, delayMs: delay });

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
      } catch (_) {
        if (this.config.autoReconnect && this.reconnector.shouldReconnect) {
          this.scheduleReconnect();
        } else {
          this._state = 'disconnected';
        }
      }
    }, delay);
  }

  private startHeartbeatWatchdog(): void {
    this.stopHeartbeatWatchdog();
    this.heartbeatWatchdog = setInterval(() => {
      // If no data received for 45s, consider stream stale
      if (Date.now() - this.lastDataTime > 45000) {
        this.stopHeartbeatWatchdog();
        if (this.abortController) {
          this.abortController.abort();
          this.abortController = null;
        }
        // readStream's catch/finally will trigger reconnect
      }
    }, 15000);
  }

  private stopHeartbeatWatchdog(): void {
    if (this.heartbeatWatchdog) {
      clearInterval(this.heartbeatWatchdog);
      this.heartbeatWatchdog = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
