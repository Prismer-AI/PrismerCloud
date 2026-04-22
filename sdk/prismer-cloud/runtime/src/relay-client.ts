/**
 * Prismer Runtime — WSS Relay Client (v1.9.0)
 *
 * WebSocket client for cloud relay communication. Connects to the main
 * cloud host (derived from `cloudApiBase`) under the `/ws/daemon/*` path
 * prefix — there is no separate relay subdomain.
 *
 * Responsibilities:
 *   - Register daemon binding with API key
 *   - Receive remote command pushes (control channel)
 *   - Route encrypted envelopes (data channel)
 *   - Heartbeat keepalive (30s interval)
 *   - Auto-reconnect with exponential backoff
 */

import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { DaemonOutbox, frameFromParts } from './daemon-outbox.js';

// v1.9.0 — §5.6.4 binary frame opcodes (must match cloud relay-handler.ts)
export const OPCODE = {
  JSON_CONTROL: 0x00,
  AGENT_OUTPUT: 0x01,
  TERMINAL_IO: 0x02,
  FILE_CHUNK: 0x03,
  AUDIT_TAP: 0x04,
  BACKFILL_REQUEST: 0x05, // incoming from cloud (cloud relays client's request)
  BACKFILL_CHUNK: 0x06, // outgoing to cloud
} as const;

const BACKFILL_TRACKED_OPCODES: ReadonlySet<number> = new Set([
  OPCODE.AGENT_OUTPUT,
  OPCODE.TERMINAL_IO,
  OPCODE.FILE_CHUNK,
]);

// ============================================================
// Types
// ============================================================

export interface RelayClientOptions {
  apiKey: string;
  daemonId: string;
  userId: string;
  /**
   * Base WSS URL for the relay (e.g. `wss://cloud.prismer.dev`). The client
   * appends `/ws/daemon/control` and `/ws/daemon/data` to this base. Callers
   * typically derive it from `cloudApiBase` via `deriveWsFromHttp()`.
   */
  relayUrl: string;
  heartbeatIntervalMs?: number; // default: 30000 (30s)
  reconnectDelayMs?: number;    // default: 1000
  maxReconnectDelayMs?: number;  // default: 30000 (30s)
  autoReconnect?: boolean;       // default: true
  /** v1.9.0 — bindingId enables daemon-side outbox + timeline backfill (§5.6.5). */
  bindingId?: string;
  /** Override outbox location (for tests); defaults to ~/.prismer/daemon/{bindingId}. */
  outboxDataDir?: string;
}

export interface RelayState {
  connected: boolean;
  channel: 'control' | 'data' | null;
  lastHeartbeat?: number;
  reconnectAttempts: number;
  lastError?: string;
}


export interface RemoteCommand {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

// ============================================================
// Constants
// ============================================================

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30000; // 30s
const DEFAULT_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000; // 30s
const HEARTBEAT_TIMEOUT_MS = 10000; // 10s to receive pong

// ============================================================
// RelayClient
// ============================================================

export class RelayClient extends EventEmitter {
  private apiKey: string;
  private daemonId: string;
  private userId: string;
  private relayUrl: string;
  private heartbeatIntervalMs: number;
  private reconnectDelayMs: number;
  private maxReconnectDelayMs: number;
  private autoReconnect: boolean;

  private controlWs: WebSocket | null = null;
  private dataWs: WebSocket | null = null;

  private heartbeatInterval?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;

  private state: RelayState = {
    connected: false,
    channel: null,
    reconnectAttempts: 0,
  };

  private isShuttingDown = false;
  private outbox?: DaemonOutbox;

  constructor(opts: RelayClientOptions) {
    super();

    this.apiKey = opts.apiKey;
    this.daemonId = opts.daemonId;
    this.userId = opts.userId;
    if (!opts.relayUrl) {
      throw new Error('RelayClient: relayUrl is required (derive from cloudApiBase via deriveWsFromHttp)');
    }
    this.relayUrl = opts.relayUrl;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.reconnectDelayMs = opts.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    this.maxReconnectDelayMs = opts.maxReconnectDelayMs ?? MAX_RECONNECT_DELAY_MS;
    this.autoReconnect = opts.autoReconnect ?? true;

    // v1.9.0 — enable disconnect compensation when bindingId provided
    if (opts.bindingId) {
      this.outbox = new DaemonOutbox({
        bindingId: opts.bindingId,
        dataDir: opts.outboxDataDir,
      });
    }
  }

  /**
   * Connect to relay server (both control and data channels)
   */
  async connect(): Promise<void> {
    if (this.isShuttingDown) {
      throw new Error('Cannot connect: client is shutting down');
    }

    if (this.controlWs?.readyState === 1) {
      console.warn('[RelayClient] Already connected to control channel');
      return;
    }

    console.log('[RelayClient] Connecting to relay:', this.relayUrl);

    try {
      // Connect control channel
      await this.connectControlChannel();

      // Connect data channel
      await this.connectDataChannel();

      // Start heartbeat
      this.startHeartbeat();

      this.state.connected = true;
      this.state.reconnectAttempts = 0;
      this.emit('connected');

      // v1.9.0 — drain queued frames accumulated while offline
      this.replayOutbox();
    } catch (err) {
      console.error('[RelayClient] Connection failed:', err);
      this.state.lastError = err instanceof Error ? err.message : String(err);

      if (this.autoReconnect && !this.isShuttingDown) {
        this.scheduleReconnect();
      }

      throw err;
    }
  }

  /**
   * Disconnect from relay server
   */
  async disconnect(): Promise<void> {
    console.log('[RelayClient] Disconnecting from relay');
    this.isShuttingDown = true;
    this.autoReconnect = false;

    // Clear timers
    this.clearHeartbeat();
    this.clearReconnectTimer();

    // Close connections
    await this.closeControlChannel();
    await this.closeDataChannel();

    this.state.connected = false;
    this.state.channel = null;

    // v1.9.0 — flush outbox SQLite cleanly on explicit shutdown
    this.outbox?.close();
    this.outbox = undefined;

    this.emit('disconnected');
  }

  /**
   * Send command to mobile client via relay (data channel).
   *
   * v1.9.0 — if bindingId was provided, every tracked data-plane frame
   * (AGENT_OUTPUT / TERMINAL_IO / FILE_CHUNK) is recorded in the local
   * timeline before send. If the data channel is down, the frame is queued
   * to the outbox and will be replayed on next successful connect.
   */
  /**
   * Send JSON control message to cloud via the control channel.
   * v1.9.x — used by daemon to ack remote commands (e.g. command.result).
   * Returns false silently if control channel is not connected.
   */
  sendControl(message: unknown): boolean {
    if (!this.controlWs || this.controlWs.readyState !== 1) {
      return false;
    }
    try {
      this.controlWs.send(JSON.stringify(message));
      return true;
    } catch (err) {
      console.error('[RelayClient] Failed to send control message:', err);
      return false;
    }
  }

  sendCommand(data: Buffer | string): boolean {
    const frame = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;

    // Record tracked binary frames in timeline BEFORE attempting send
    let seq: number | undefined;
    if (this.outbox && Buffer.isBuffer(frame) && frame.length >= 2) {
      const opcode = frame[0];
      if (BACKFILL_TRACKED_OPCODES.has(opcode)) {
        try {
          seq = this.outbox.appendSent(opcode, frame[1], frame.slice(2));
        } catch (err) {
          console.warn('[RelayClient] Timeline append failed (non-fatal):', err);
        }
      }
    }

    if (!this.dataWs || this.dataWs.readyState !== 1) {
      if (this.outbox && seq !== undefined) {
        this.outbox.queue(seq, frame as Buffer);
        console.log(`[RelayClient] Data channel offline — queued frame seq=${seq} to outbox`);
      } else {
        console.warn('[RelayClient] Cannot send command: data channel not connected');
      }
      return false;
    }

    try {
      this.dataWs.send(data);
      return true;
    } catch (err) {
      console.error('[RelayClient] Failed to send command:', err);
      if (this.outbox && seq !== undefined) {
        this.outbox.queue(seq, frame as Buffer);
      }
      return false;
    }
  }

  /**
   * Get current connection state
   */
  getState(): RelayState {
    return { ...this.state };
  }

  /**
   * Get connection status summary
   */
  getStatus(): {
    controlConnected: boolean;
    dataConnected: boolean;
    lastHeartbeat?: number;
    reconnectAttempts: number;
  } {
    return {
      controlConnected: this.controlWs?.readyState === 1,
      dataConnected: this.dataWs?.readyState === 1,
      lastHeartbeat: this.state.lastHeartbeat,
      reconnectAttempts: this.state.reconnectAttempts,
    };
  }

  // ============================================================
  // Private methods
  // ============================================================

  /**
   * Connect to control channel (/ws/daemon/control)
   */
  private async connectControlChannel(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = this.relayEndpoint('/ws/daemon/control');
      const ws = new WebSocket(url, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'X-Daemon-Id': this.daemonId,
          'X-User-Id': this.userId,
        },
      });

      ws.on('open', () => {
        console.log('[RelayClient] Control channel connected');
        this.controlWs = ws;
        this.state.channel = 'control';

        // Send registration message
        this.registerDaemon();

        resolve();
      });

      ws.on('message', (data: Buffer) => {
        this.handleControlMessage(data);
      });

      ws.on('error', (err: Error) => {
        console.error('[RelayClient] Control channel error:', err);
        reject(err);
      });

      ws.on('close', (code: number, reason: Buffer) => {
        console.log('[RelayClient] Control channel closed:', code, reason);
        this.controlWs = null;

        if (this.state.channel === 'control') {
          this.state.channel = null;
        }

        this.handleDisconnect('control');

        if (this.autoReconnect && !this.isShuttingDown) {
          this.scheduleReconnect();
        }
      });
    });
  }

  /**
   * Connect to data channel (/ws/daemon/data)
   */
  private async connectDataChannel(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = this.relayEndpoint('/ws/daemon/data');
      const ws = new WebSocket(url, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'X-Daemon-Id': this.daemonId,
          'X-User-Id': this.userId,
        },
      });

      ws.on('open', () => {
        console.log('[RelayClient] Data channel connected');
        this.dataWs = ws;
        resolve();
      });

      ws.on('message', (data: Buffer) => {
        this.handleDataMessage(data);
      });

      ws.on('error', (err: Error) => {
        console.error('[RelayClient] Data channel error:', err);
        reject(err);
      });

      ws.on('close', (code: number, reason: Buffer) => {
        console.log('[RelayClient] Data channel closed:', code, reason);
        this.dataWs = null;
        this.handleDisconnect('data');

        if (this.autoReconnect && !this.isShuttingDown) {
          this.scheduleReconnect();
        }
      });
    });
  }

  private relayEndpoint(path: string): string {
    const url = new URL(path, this.relayUrl.endsWith('/') ? this.relayUrl : `${this.relayUrl}/`);
    url.searchParams.set('token', this.apiKey);
    url.searchParams.set('daemonId', this.daemonId);
    return url.toString();
  }

  /**
   * Register daemon with relay server
   */
  private registerDaemon(): void {
    if (!this.controlWs || this.controlWs.readyState !== 1) {
      return;
    }

    const registerMessage = {
      type: 'register',
      daemonId: this.daemonId,
      userId: this.userId,
      timestamp: Date.now(),
    };

    this.controlWs.send(JSON.stringify(registerMessage));
  }

  /**
   * Handle incoming control channel messages
   */
  private handleControlMessage(data: Buffer): void {
    try {
      const message = JSON.parse(data.toString('utf-8'));

      switch (message.type) {
        case 'heartbeat':
          // Echo heartbeat back
          this.sendHeartbeatAck();
          break;

        case 'command':
          // Remote command from mobile
          this.handleRemoteCommand(message);
          break;

        case 'command.new': {
          // v1.9.x cloud → daemon push of a newly-created remote command
          // Cloud payload shape: { type: 'command.new', data: { commandId, commandType, envelope } }
          const d = (message as any).data || {};
          const command: RemoteCommand = {
            id: d.commandId,
            type: d.commandType,
            payload: d.envelope || {},
            createdAt: Date.now(),
          };
          this.emit('command', command);
          break;
        }

        case 'commands.pending': {
          // v1.9.x cloud → daemon backlog replay on (re)connect
          // Cloud payload shape: { type: 'commands.pending', data: [{ commandId, commandType, envelope }, ...] }
          const pending = ((message as any).data || []) as Array<{ commandId: string; commandType: string; envelope?: unknown }>;
          for (const c of pending) {
            const command: RemoteCommand = {
              id: c.commandId,
              type: c.commandType,
              payload: (c.envelope as Record<string, unknown>) || {},
              createdAt: Date.now(),
            };
            this.emit('command', command);
          }
          break;
        }

        case 'rpc.request':
          // Cloud-initiated RPC (e.g. FS relay from mobile → cloud → daemon).
          // Dispatched via the rpcHandlers map; reply with rpc.response. All
          // paths must reply — timeout on the cloud side is enforced, but we
          // still send an error on any dispatch failure so the caller's promise
          // resolves promptly rather than waiting for the timeout.
          void this.handleRpcRequest(message);
          break;

        case 'error':
          console.error('[RelayClient] Relay error:', message.error);
          this.emit('relayError', message.error);
          break;

        default:
          console.warn('[RelayClient] Unknown control message type:', message.type);
      }
    } catch (err) {
      console.error('[RelayClient] Failed to parse control message:', err);
    }
  }

  /** RPC method handlers registered by the daemon process. Keyed by method
   *  name (e.g. 'fs.read'). Result is serialized into the rpc.response
   *  envelope. Thrown errors → `error` field. */
  private rpcHandlers = new Map<string, (params: unknown) => Promise<unknown>>();

  /** Register an RPC handler. Daemon code calls this at startup for each
   *  method it wants to expose to cloud relay (mobile → cloud → daemon). */
  registerRpcHandler(method: string, handler: (params: unknown) => Promise<unknown>): void {
    this.rpcHandlers.set(method, handler);
  }

  private async handleRpcRequest(message: {
    rpcId?: string;
    method?: string;
    params?: unknown;
  }): Promise<void> {
    const rpcId = message.rpcId;
    const method = message.method;
    if (!rpcId || !method) return; // malformed; cloud will timeout

    const handler = this.rpcHandlers.get(method);
    if (!handler) {
      this.sendRpcResponse(rpcId, undefined, `unknown rpc method: ${method}`);
      return;
    }

    try {
      const result = await handler(message.params);
      this.sendRpcResponse(rpcId, result);
    } catch (err: any) {
      this.sendRpcResponse(rpcId, undefined, err?.message ?? String(err));
    }
  }

  private sendRpcResponse(rpcId: string, result: unknown, error?: string): void {
    if (!this.controlWs || this.controlWs.readyState !== 1) return;
    this.controlWs.send(JSON.stringify({
      type: 'rpc.response',
      rpcId,
      ...(error !== undefined ? { error } : { result }),
    }));
  }

  /**
   * Handle incoming data channel messages.
   *
   * v1.9.0 — intercept backfill-request (opcode 0x05) from the cloud
   * (cloud forwards it on behalf of a reconnecting mobile client) and
   * respond with backfill-chunk frames (opcode 0x06) for every timeline
   * entry with seq > payload.lastSeq.
   */
  private handleDataMessage(data: Buffer): void {
    if (this.outbox && data.length >= 2 && data[0] === OPCODE.BACKFILL_REQUEST) {
      try {
        const payload = JSON.parse(data.slice(2).toString('utf-8')) as { lastSeq?: number };
        const lastSeq = typeof payload.lastSeq === 'number' ? payload.lastSeq : 0;
        const entries = this.outbox.getTimelineSince(lastSeq);
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          const chunkJson = Buffer.from(
            JSON.stringify({
              seq: entry.seq,
              opcode: entry.opcode,
              slot: entry.slot,
              payload: entry.payload.toString('base64'),
              more: i < entries.length - 1,
            }),
            'utf-8',
          );
          const frame = frameFromParts(OPCODE.BACKFILL_CHUNK, 0, chunkJson);
          if (this.dataWs && this.dataWs.readyState === 1) {
            this.dataWs.send(frame);
          }
        }
        console.log(`[RelayClient] Served ${entries.length} backfill entries since seq=${lastSeq}`);
      } catch (err) {
        console.error('[RelayClient] Backfill handling failed:', err);
      }
      return;
    }
    this.emit('data', data);
  }

  /**
   * Drain outbox by replaying queued frames over the data channel.
   * Called after reconnect() succeeds. Stops on the first send failure
   * to preserve ordering.
   */
  private replayOutbox(): void {
    if (!this.outbox || !this.dataWs || this.dataWs.readyState !== 1) return;
    const pending = this.outbox.drain();
    if (pending.length === 0) return;
    console.log(`[RelayClient] Replaying ${pending.length} queued frames from outbox`);
    for (const entry of pending) {
      try {
        this.dataWs.send(entry.frame);
        this.outbox.ack(entry.id);
      } catch (err) {
        console.error('[RelayClient] Replay failed — stopping to preserve order:', err);
        this.outbox.bumpAttempts(entry.id);
        break;
      }
    }
  }

  /** Pending count for status reporting. */
  getOutboxPending(): number {
    return this.outbox?.pendingCount() ?? 0;
  }

  /**
   * Handle remote command from mobile
   */
  private handleRemoteCommand(message: any): void {
    const command: RemoteCommand = {
      id: message.id,
      type: message.command,
      payload: message.payload || {},
      createdAt: message.timestamp || Date.now(),
    };

    this.emit('command', command);
  }

  /**
   * Start heartbeat interval
   */
  private startHeartbeat(): void {
    this.clearHeartbeat();

    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat();
    }, this.heartbeatIntervalMs);

    // Send first heartbeat immediately
    this.sendHeartbeat();
  }

  /**
   * Clear heartbeat timers
   */
  private clearHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }

    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  /**
   * Send heartbeat to relay
   */
  private sendHeartbeat(): void {
    if (!this.controlWs || this.controlWs.readyState !== 1) {
      return;
    }

    const heartbeatMessage = {
      type: 'heartbeat',
      daemonId: this.daemonId,
      timestamp: Date.now(),
    };

    try {
      this.controlWs.send(JSON.stringify(heartbeatMessage));

      // Set timeout to detect if relay is responsive
      this.heartbeatTimer = setTimeout(() => {
        console.warn('[RelayClient] Heartbeat timeout - relay not responsive');
        this.handleDisconnect('heartbeat_timeout');
      }, HEARTBEAT_TIMEOUT_MS);
    } catch (err) {
      console.error('[RelayClient] Failed to send heartbeat:', err);
    }
  }

  /**
   * Acknowledge heartbeat from relay
   */
  private sendHeartbeatAck(): void {
    // Clear the timeout since we got a response
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }

    this.state.lastHeartbeat = Date.now();
  }

  /**
   * Handle disconnection from one or both channels
   */
  private handleDisconnect(channel: 'control' | 'data' | 'heartbeat_timeout'): void {
    const wasConnected = this.state.connected;

    if (channel === 'control' || channel === 'heartbeat_timeout') {
      this.controlWs = null;
    }
    if (channel === 'data') {
      this.dataWs = null;
    }

    const isFullyDisconnected = !this.controlWs && !this.dataWs;

    if (isFullyDisconnected && wasConnected) {
      this.state.connected = false;
      this.state.channel = null;

      console.log('[RelayClient] Fully disconnected');
      this.emit('disconnected');
    }
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  private scheduleReconnect(): void {
    this.clearReconnectTimer();

    const delay = Math.min(
      this.reconnectDelayMs * Math.pow(2, this.state.reconnectAttempts),
      this.maxReconnectDelayMs
    );

    console.log(
      `[RelayClient] Scheduling reconnect in ${delay}ms (attempt ${this.state.reconnectAttempts + 1})`
    );

    this.reconnectTimer = setTimeout(async () => {
      this.state.reconnectAttempts++;

      try {
        await this.connect();
      } catch (err) {
        console.error('[RelayClient] Reconnect failed:', err);
        // Will schedule another reconnect via error handler
      }
    }, delay);
  }

  /**
   * Clear reconnect timer
   */
  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  /**
   * Close control channel
   */
  private async closeControlChannel(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.controlWs) {
        resolve();
        return;
      }

      this.controlWs.once('close', () => resolve());
      this.controlWs.close();
    });
  }

  /**
   * Close data channel
   */
  private async closeDataChannel(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.dataWs) {
        resolve();
        return;
      }

      this.dataWs.once('close', () => resolve());
      this.dataWs.close();
    });
  }
}
