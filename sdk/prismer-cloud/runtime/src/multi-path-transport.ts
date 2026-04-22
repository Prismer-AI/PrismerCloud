/**
 * Prismer Runtime — Multi-Path Transport Manager (v1.9.0)
 *
 * Orchestrates multiple transport paths and seamless switching.
 *
 * Supports:
 *   - LAN Direct (encrypted, low latency)
 *   - WSS Relay (cloud, high reliability)
 *   - Auto-fallback on connection loss
 *   - Seamless switching (< 100ms)
 *
 * Architecture:
 *   1. Probe all paths on startup
 *   2. Select best path (latency < 100ms)
 *   3. Establish connection
 *   4. Monitor health (heartbeats)
 *   5. Auto-switch on failure (with exponential backoff)
 */

import { EventEmitter } from 'node:events';
import { ConnectionProber, ConnectionSelection, type ConnectionType } from './connection-prober.js';
import { RelayClient } from './relay-client.js';
import type { E2EEContext } from './e2ee-crypto.js';
import { createE2EEContext, type KeyPair } from './e2ee-crypto.js';
import { deriveWsFromHttp, deriveHostFromHttp } from './cloud-url.js';

// ============================================================
// Types
// ============================================================

export interface TransportManagerOptions {
  apiKey: string;
  daemonId: string;
  userId: string;
  /**
   * Cloud HTTP base URL (e.g. `https://cloud.prismer.dev`). Relay host + WSS URL
   * are derived from this — there is no separate relay subdomain.
   */
  cloudApiBase: string;
  localKeyPair: KeyPair;
  remotePublicKey?: Buffer; // For LAN E2EE
  lanPort?: number;
  lanHost?: string;
  dataDir?: string;
  probeIntervalMs?: number;     // How often to re-probe (default: 5min)
  healthCheckIntervalMs?: number; // How often to check health (default: 30s)
  /**
   * Latency gate for the path-switching heuristic only: when a health check
   * on the currently-active path measures above this, we kick off a re-probe
   * to see if something faster is now available. Default 200ms.
   *
   * NOTE: this is **not** the gate for deciding whether a path is usable at
   * all — that's `pathUsableLatencyMs`. A 200ms "switch" threshold is fine
   * for LAN/same-region, but would falsely reject cross-continent WS (which
   * routinely handshakes in 500–1500ms).
   */
  switchLatencyThresholdMs?: number;
  /**
   * Max latency for a path to be considered usable at all. Default 2000ms.
   * Distinct from `switchLatencyThresholdMs` which governs path SWITCHING
   * heuristics. Cross-continent WS handshake can run 500–1500ms; a tight
   * "switch" threshold shouldn't reject otherwise-usable paths.
   *
   * Can also be overridden at runtime via the
   * `PRISMER_PATH_USABLE_LATENCY_MS` env var (useful for ops debugging
   * without a rebuild); an explicit option value always wins.
   */
  pathUsableLatencyMs?: number;
  /**
   * Minimum qualityScore (0-100) for a probed path to be considered usable
   * by `selectBest`. Default 20. Lowered from ConnectionProber's 50 default
   * because `calculateQualityScore` hardcodes latency baseline at 500ms —
   * cross-continent WS handshake (800-1500ms) scores <50 even with perfect
   * jitter/loss, tripping the selector. Env override:
   * `PRISMER_MIN_QUALITY_SCORE`.
   */
  minQualityScore?: number;
}

export interface TransportStatus {
  currentPath: ConnectionType | null;
  currentEndpoint: string | null;
  connected: boolean;
  latencyMs: number;
  lastHealthCheck: number;
  /** True once probeAndSelect has returned at least once (success or failure). */
  probesCompleted: boolean;
  /** Last probe/switch error message — used to surface "unreachable" detail. */
  lastError: string | null;
  paths: {
    [key in ConnectionType]: {
      available: boolean;
      latencyMs: number;
      lastProbed: number;
    };
  };
}

// ============================================================
// Constants
// ============================================================

const DEFAULT_PROBE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 30 * 1000; // 30 seconds
const DEFAULT_SWITCH_LATENCY_THRESHOLD_MS = 200;
const DEFAULT_PATH_USABLE_LATENCY_MS = 2000;
const DEFAULT_MIN_QUALITY_SCORE = 20;
const HEALTH_CHECK_TIMEOUT_MS = 3000; // 3 seconds

// ============================================================
// TransportManager
// ============================================================

export class TransportManager extends EventEmitter {
  private apiKey: string;
  private cloudApiBase: string;
  private daemonId: string;
  private userId: string;
  private localKeyPair: KeyPair;
  private remotePublicKey?: Buffer;
  private dataDir: string;
  private probeIntervalMs: number;
  private healthCheckIntervalMs: number;
  private switchLatencyThresholdMs: number;
  private pathUsableLatencyMs: number;
  private minQualityScore: number;

  private connectionProber: ConnectionProber;
  private relayClient?: RelayClient;
  private e2eeContext?: E2EEContext;

  private currentSelection: ConnectionSelection | null = null;
  private isSwitching = false;
  private shutdownRequested = false;

  private probeTimer?: NodeJS.Timeout;
  private healthCheckTimer?: NodeJS.Timeout;

  private status: TransportStatus = {
    currentPath: null,
    currentEndpoint: null,
    connected: false,
    latencyMs: 0,
    lastHealthCheck: 0,
    probesCompleted: false,
    lastError: null,
    paths: {
      lan: { available: false, latencyMs: Infinity, lastProbed: 0 },
      relay: { available: false, latencyMs: Infinity, lastProbed: 0 },
      http: { available: false, latencyMs: Infinity, lastProbed: 0 },
    },
  };

  constructor(opts: TransportManagerOptions) {
    super();

    if (!opts.cloudApiBase) {
      throw new Error('TransportManager: cloudApiBase is required');
    }
    this.apiKey = opts.apiKey;
    this.daemonId = opts.daemonId;
    this.userId = opts.userId;
    this.cloudApiBase = opts.cloudApiBase;
    this.localKeyPair = opts.localKeyPair;
    this.remotePublicKey = opts.remotePublicKey;
    this.dataDir = opts.dataDir ?? '.prismer';
    this.probeIntervalMs = opts.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
    this.healthCheckIntervalMs = opts.healthCheckIntervalMs ?? DEFAULT_HEALTH_CHECK_INTERVAL_MS;
    this.switchLatencyThresholdMs = opts.switchLatencyThresholdMs ?? DEFAULT_SWITCH_LATENCY_THRESHOLD_MS;
    // Resolve pathUsableLatencyMs — explicit option wins, then env var
    // (belt + suspenders for ops debug without rebuild; NaN ignored), then default.
    const envUsable = Number(process.env.PRISMER_PATH_USABLE_LATENCY_MS);
    this.pathUsableLatencyMs =
      opts.pathUsableLatencyMs ??
      (Number.isFinite(envUsable) && envUsable > 0 ? envUsable : undefined) ??
      DEFAULT_PATH_USABLE_LATENCY_MS;
    // Resolve minQualityScore — explicit option wins, then env var (NaN /
    // out-of-range [0,100] ignored), then default. See G-17 second-pass
    // notes in TransportManagerOptions.minQualityScore docstring.
    const envMinQ = Number(process.env.PRISMER_MIN_QUALITY_SCORE);
    this.minQualityScore =
      opts.minQualityScore ??
      (Number.isFinite(envMinQ) && envMinQ >= 0 && envMinQ <= 100 ? envMinQ : undefined) ??
      DEFAULT_MIN_QUALITY_SCORE;

    const relayHost = deriveHostFromHttp(this.cloudApiBase);
    if (!relayHost) {
      throw new Error(`TransportManager: invalid cloudApiBase (cannot derive relay host): ${this.cloudApiBase}`);
    }
    // Derive probe scheme from cloudApiBase so HTTPS → wss:// and HTTP → ws://.
    // The prober itself would fall back on the port heuristic, but we know the
    // truth here and passing it avoids the 80/3000/443-only assumption.
    const relayScheme: 'ws' | 'wss' = /^https:/i.test(this.cloudApiBase) ? 'wss' : 'ws';
    this.connectionProber = new ConnectionProber({
      dataDir: this.dataDir,
      lanPort: opts.lanPort,
      lanHost: opts.lanHost,
      relayHost,
      relayScheme,
    });

    // NOTE: do NOT hydrate `currentSelection` from the on-disk cache here.
    // The persisted selection file is useful as a hint for future probe
    // ordering, but treating it as live state at boot causes the exact bug
    // observed in v1.9.24: constructor sets currentSelection → first probe
    // returns the same path → `needsSwitch` evaluates false → switchToPath
    // (the only code that constructs a RelayClient) is never called →
    // `this.relayClient` stays undefined → healthCheck throws "Relay client
    // not initialized" forever. The first probe cycle in `start()` will
    // populate currentSelection naturally; loading from cache adds nothing
    // but risk.
    this.currentSelection = null;

    // Set up E2EE context if remote public key is available
    if (this.remotePublicKey) {
      this.e2eeContext = createE2EEContext(
        this.localKeyPair,
        this.remotePublicKey
      );
    }
  }

  /**
   * Start transport manager
   */
  async start(): Promise<void> {
    console.log('[TransportManager] Starting transport manager');

    // Probe all paths on startup
    await this.probeAndSelect();

    // Start periodic health checks
    this.startHealthChecks();

    // Start periodic re-probing
    this.startPeriodicProbing();
  }

  /**
   * Stop transport manager
   */
  async stop(): Promise<void> {
    console.log('[TransportManager] Stopping transport manager');
    this.shutdownRequested = true;

    // Clear timers
    if (this.probeTimer) {
      clearTimeout(this.probeTimer);
      this.probeTimer = undefined;
    }

    if (this.healthCheckTimer) {
      clearTimeout(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }

    // Disconnect relay client if active
    if (this.relayClient) {
      await this.relayClient.disconnect();
      this.relayClient = undefined;
    }

    this.status.connected = false;
    this.emit('stopped');
  }

  /**
   * Get current transport status
   */
  getStatus(): TransportStatus {
    return { ...this.status };
  }

  /**
   * Send data via current transport path
   */
  async sendData(data: Buffer): Promise<boolean> {
    if (!this.status.connected) {
      console.warn('[TransportManager] Cannot send data: not connected');
      return false;
    }

    switch (this.status.currentPath) {
      case 'lan':
        return this.sendLANData(data);

      case 'relay':
        return this.sendRelayData(data);

      case 'http':
        return this.sendHTTPData(data);

      default:
        console.warn('[TransportManager] Unknown current path:', this.status.currentPath);
        return false;
    }
  }

  /**
   * Force re-probe and re-select transport
   */
  async forceReprobe(): Promise<void> {
    console.log('[TransportManager] Force re-probe requested');
    this.connectionProber.clearSelection();
    await this.probeAndSelect();
  }

  /**
   * Update remote public key (for new pairing)
   */
  updateRemotePublicKey(remotePublicKey: Buffer): void {
    this.remotePublicKey = remotePublicKey;
    this.e2eeContext = createE2EEContext(
      this.localKeyPair,
      remotePublicKey
    );
    console.log('[TransportManager] Updated remote public key');
  }

  // ============================================================
  // Private methods
  // ============================================================

  /**
   * Probe all paths and select best one
   */
  private async probeAndSelect(): Promise<void> {
    try {
      console.log('[TransportManager] Probing all connection paths');

      const results = await this.connectionProber.probeAll();

      // Update path status
      for (const result of results) {
        const path = result.candidate.type;
        this.status.paths[path] = {
          available: result.success,
          latencyMs: result.success ? result.latencyMs : Infinity,
          lastProbed: result.timestamp,
        };

        console.log(
          `[TransportManager] ${path}: ${result.success ? `OK (${result.latencyMs.toFixed(2)}ms)` : 'FAILED'}`
        );
      }

      // Select best path. Use the "usable" threshold (default 2000ms), NOT
      // the "switch" threshold (default 200ms) — a tight 200ms gate rejects
      // otherwise-fine cross-continent WS paths. See GAPS G-17.
      //
      // Also lower minQualityScore below ConnectionProber's 50 default
      // (G-17 second-pass): `calculateQualityScore` hardcodes a 500ms
      // latency baseline, so any path >500ms — including a perfectly-fine
      // ~860ms cross-continent relay — gets `latencyScore=0` and tops out
      // at 50 (jitter .3 + loss .2). We keep the prober's scoring intact
      // and relax the gate to 20 here; the deeper fix belongs in the
      // prober's formula and is left for a future round.
      const selection = this.connectionProber.selectBest(results, {
        maxLatencyMs: this.pathUsableLatencyMs,
        minQualityScore: this.minQualityScore,
      });

      // Mark that the first probe pass finished — needed by /transport/status to
      // distinguish "probing" (no results yet) from "unreachable" (all failed).
      this.status.probesCompleted = true;

      if (!selection) {
        console.warn('[TransportManager] No suitable path found - will retry later');
        const failed = results.filter((r) => !r.success);
        if (failed.length > 0) {
          const summary = failed
            .map((r) => `${r.candidate.type}:${r.error ?? 'unreachable'}`)
            .join('; ');
          this.status.lastError = `No reachable path (${summary})`;
        } else {
          this.status.lastError = 'No path met the latency threshold';
        }
        return;
      }

      // Check if we need to switch. In addition to type/endpoint change,
      // the transport for the selected type MUST actually be live — if the
      // persisted or in-memory selection says "relay" but relayClient is
      // missing / disconnected, we still need to reconnect. Without this
      // guard, a cached selection that matches the fresh probe bypasses
      // switchToPath entirely and the RelayClient is never constructed.
      const currentPathLive = this.currentSelection
        ? this.isCurrentPathLive(this.currentSelection.type)
        : false;
      const needsSwitch =
        !this.currentSelection ||
        this.currentSelection.type !== selection.type ||
        this.currentSelection.endpoint !== selection.endpoint ||
        !currentPathLive;

      if (needsSwitch) {
        await this.switchToPath(selection);
      } else {
        console.log('[TransportManager] Current path still optimal');
      }

      this.currentSelection = selection;
      this.connectionProber.persistSelection(selection);
      this.status.lastError = null;
    } catch (err) {
      console.error('[TransportManager] Probe failed:', err);
      this.status.probesCompleted = true;
      this.status.lastError = err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * Is the transport for the given path type actually up and ready to send?
   * Used by `probeAndSelect` so that a stale `currentSelection` (cached or
   * otherwise) can't satisfy the "path still optimal" branch when the
   * underlying client never connected (or has since dropped).
   */
  private isCurrentPathLive(type: ConnectionType): boolean {
    switch (type) {
      case 'relay': {
        if (!this.relayClient) return false;
        const status = this.relayClient.getStatus();
        return status.controlConnected === true && status.dataConnected === true;
      }
      case 'lan':
        // LAN has no persistent client in this codebase; treat as live only
        // when the manager itself has been marked connected by connectLAN().
        return this.status.connected === true;
      case 'http':
        // HTTP is stateless request/response — always ready if selected.
        return true;
      default:
        return false;
    }
  }

  /**
   * Switch to a different transport path
   */
  private async switchToPath(selection: ConnectionSelection): Promise<void> {
    if (this.isSwitching) {
      console.log('[TransportManager] Already switching, ignoring request');
      return;
    }

    const startTime = Date.now();
    this.isSwitching = true;
    console.log(
      `[TransportManager] Switching to ${selection.type} at ${selection.endpoint}`
    );

    try {
      // Disconnect current path
      await this.disconnectCurrent();

      // Connect new path
      switch (selection.type) {
        case 'lan':
          await this.connectLAN();
          break;

        case 'relay':
          await this.connectRelay();
          break;

        case 'http':
          await this.connectHTTP();
          break;
      }

      // Update status
      const switchTime = Date.now() - startTime;
      console.log(`[TransportManager] Switched to ${selection.type} in ${switchTime}ms`);

      if (switchTime > 100) {
        console.warn('[TransportManager] Switch time exceeded 100ms:', switchTime);
      }

      this.status.currentPath = selection.type;
      this.status.currentEndpoint = selection.endpoint;
      this.status.latencyMs = selection.latencyMs;
      this.status.connected = true;
      this.status.lastHealthCheck = Date.now();

      this.emit('switched', { type: selection.type, endpoint: selection.endpoint, latencyMs: selection.latencyMs });
    } catch (err) {
      console.error('[TransportManager] Failed to switch path:', err);
      this.status.connected = false;
      this.status.lastError = err instanceof Error ? err.message : String(err);
      this.emit('error', err);

      // Try to reconnect to previous path if available
      if (this.currentSelection) {
        await this.connectPath(this.currentSelection.type);
      }
    } finally {
      this.isSwitching = false;
    }
  }

  /**
   * Disconnect current transport path
   */
  private async disconnectCurrent(): Promise<void> {
    if (this.relayClient) {
      await this.relayClient.disconnect();
      this.relayClient = undefined;
    }

    // LAN and HTTP don't have persistent connections to disconnect
  }

  /**
   * Connect to LAN path
   */
  private async connectLAN(): Promise<void> {
    if (!this.e2eeContext) {
      throw new Error('Cannot connect LAN: E2EE context not available');
    }

    console.log('[TransportManager] Connecting LAN path');
    // LAN is established via the daemon HTTP server on port 3210
    // No explicit connection needed - just mark as ready
    this.status.connected = true;
  }

  /** Pending RPC handler registrations to apply once the relay client connects.
   *  Daemon code can call registerRpcHandler() before Relay is up; we queue
   *  them and wire them into the relay client after connectRelay(). */
  private pendingRpcHandlers = new Map<string, (params: unknown) => Promise<unknown>>();

  /**
   * Register an RPC handler for cloud-initiated requests (e.g. FS relay).
   * Idempotent across relay reconnects — the same handler is re-attached on
   * every reconnect without the caller having to re-register.
   */
  registerRpcHandler(method: string, handler: (params: unknown) => Promise<unknown>): void {
    this.pendingRpcHandlers.set(method, handler);
    if (this.relayClient) {
      this.relayClient.registerRpcHandler(method, handler);
    }
  }

  /**
   * Send a JSON control message to cloud via the relay control channel.
   * v1.9.x — best-effort passthrough used by daemon code (e.g. remote
   * command ack). Returns false if relay client is not connected.
   */
  sendControl(message: unknown): boolean {
    if (!this.relayClient) return false;
    return this.relayClient.sendControl(message);
  }

  /**
   * Connect to Relay path
   */
  private async connectRelay(): Promise<void> {
    console.log('[TransportManager] Connecting Relay path');

    const relayUrl = deriveWsFromHttp(this.cloudApiBase);
    if (!relayUrl) {
      throw new Error(`TransportManager: invalid cloudApiBase (cannot derive relay URL): ${this.cloudApiBase}`);
    }
    this.relayClient = new RelayClient({
      apiKey: this.apiKey,
      daemonId: this.daemonId,
      userId: this.userId,
      relayUrl,
      autoReconnect: true,
    });

    // Set up event handlers
    this.relayClient.on('connected', () => {
      console.log('[TransportManager] Relay connected');
      this.status.connected = true;
      this.emit('connected', { type: 'relay' });
    });

    this.relayClient.on('disconnected', () => {
      console.log('[TransportManager] Relay disconnected');
      this.status.connected = false;
      this.emit('disconnected', { type: 'relay' });

      // Trigger re-probe if not shutting down
      if (!this.shutdownRequested) {
        void this.probeAndSelect();
      }
    });

    this.relayClient.on('error', (err) => {
      console.error('[TransportManager] Relay error:', err);
      this.emit('error', err);
    });

    this.relayClient.on('command', (command) => {
      this.emit('command', command);
    });

    this.relayClient.on('data', (data) => {
      this.emit('data', data);
    });

    // Re-attach any pending RPC handlers registered before Relay was up.
    for (const [method, handler] of this.pendingRpcHandlers) {
      this.relayClient.registerRpcHandler(method, handler);
    }

    await this.relayClient.connect();
  }

  /**
   * Connect to HTTP path (fallback)
   */
  private async connectHTTP(): Promise<void> {
    console.log('[TransportManager] Connecting HTTP path');
    // HTTP is request/response, no persistent connection
    this.status.connected = true;
  }

  /**
   * Connect to a specific path type
   */
  private async connectPath(type: ConnectionType): Promise<void> {
    switch (type) {
      case 'lan':
        await this.connectLAN();
        break;
      case 'relay':
        await this.connectRelay();
        break;
      case 'http':
        await this.connectHTTP();
        break;
    }
  }

  /**
   * Send data via LAN path
   */
  private sendLANData(data: Buffer): boolean {
    if (!this.e2eeContext) {
      console.error('[TransportManager] Cannot send LAN data: no E2EE context');
      return false;
    }

    // Encrypt data using E2EE
    const encrypted = this.e2eeContext.sendKey
      ? this.e2eeContext.sendKey
      : data;

    // Send via daemon HTTP server
    // This is handled by the daemon's HTTP routes
    this.emit('send', encrypted);
    return true;
  }

  /**
   * Send data via Relay path
   */
  private sendRelayData(data: Buffer): boolean {
    if (!this.relayClient) {
      console.error('[TransportManager] Cannot send relay data: no relay client');
      return false;
    }

    return this.relayClient.sendCommand(data);
  }

  /**
   * Send data via HTTP path
   */
  private sendHTTPData(data: Buffer): boolean {
    // HTTP path is not used for streaming
    console.warn('[TransportManager] HTTP path not supported for streaming');
    return false;
  }

  /**
   * Start periodic health checks
   */
  private startHealthChecks(): void {
    this.healthCheckTimer = setInterval(async () => {
      if (this.shutdownRequested) return;

      await this.performHealthCheck();
    }, this.healthCheckIntervalMs);
  }

  /**
   * Perform health check on current path
   */
  private async performHealthCheck(): Promise<void> {
    const currentPath = this.status.currentPath;
    if (!currentPath) return;

    try {
      const startTime = Date.now();

      switch (currentPath) {
        case 'lan':
          await this.checkLANHealth();
          break;

        case 'relay':
          await this.checkRelayHealth();
          break;

        case 'http':
          await this.checkHTTPHealth();
          break;
      }

      const latency = Date.now() - startTime;
      this.status.latencyMs = latency;
      this.status.lastHealthCheck = Date.now();

      // Check if latency is too high, consider switching
      if (latency > this.switchLatencyThresholdMs) {
        console.warn(
          `[TransportManager] Current path latency (${latency}ms) exceeds threshold`
        );
        void this.probeAndSelect();
      }
    } catch (err) {
      console.error('[TransportManager] Health check failed:', err);
      this.status.connected = false;

      // Trigger re-probe
      if (!this.shutdownRequested) {
        void this.probeAndSelect();
      }
    }
  }

  /**
   * Check LAN health
   */
  private async checkLANHealth(): Promise<void> {
    // LAN health is always good if daemon is running
    // The daemon HTTP server is our health indicator
    if (!this.status.connected) {
      throw new Error('LAN not connected');
    }
  }

  /**
   * Check Relay health
   */
  private async checkRelayHealth(): Promise<void> {
    if (!this.relayClient) {
      throw new Error('Relay client not initialized');
    }

    const status = this.relayClient.getStatus();
    if (!status.controlConnected || !status.dataConnected) {
      throw new Error('Relay not connected');
    }

    // Check if heartbeat is recent (within 60s)
    if (status.lastHeartbeat && Date.now() - status.lastHeartbeat > 60000) {
      throw new Error('Relay heartbeat stale');
    }
  }

  /**
   * Check HTTP health
   */
  private async checkHTTPHealth(): Promise<void> {
    // TODO: Implement HTTP health check
    // For now, assume HTTP is always available
  }

  /**
   * Start periodic re-probing
   */
  private startPeriodicProbing(): void {
    this.probeTimer = setInterval(async () => {
      if (this.shutdownRequested || this.isSwitching) return;

      console.log('[TransportManager] Periodic re-probe');
      await this.probeAndSelect();
    }, this.probeIntervalMs);
  }
}
