/**
 * Prismer Runtime — Connection Probe Service (v1.9.0)
 *
 * Multi-path transport: discovers and selects best connection path
 * between daemon and cloud/moblie client.
 *
 * Supported paths:
 *   1. LAN Direct TCP (:3210) - E2EE encrypted
 *   2. Cloud WSS Relay — same host as the HTTP API (no separate subdomain)
 *   3. Cloud HTTP API (fallback)
 *
 * Probes all candidates in parallel, selects lowest latency path,
 * and persists selection for fast reconnection.
 *
 * Connection quality scoring (v1.9.0):
 *   - Latency (RTT): lower is better
 *   - Jitter: consistency matters (measured via multiple pings)
 *   - Packet loss: measured via failed probes
 *   - Stability: based on historical success rate
 */

import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import WebSocket from 'ws';
import { performance } from 'node:perf_hooks';

// ============================================================
// Types
// ============================================================

export type ConnectionType = 'lan' | 'relay' | 'http';

export interface ConnectionCandidate {
  type: ConnectionType;
  endpoint: string;
  priority: number;  // Lower = higher priority
}

export interface ProbeResult {
  candidate: ConnectionCandidate;
  latencyMs: number;
  jitterMs: number;        // Measured via multiple pings
  success: boolean;
  error?: string;
  timestamp: number;
  qualityScore: number;     // 0-100 (higher is better)
}

export interface ConnectionSelection {
  type: ConnectionType;
  endpoint: string;
  latencyMs: number;
  selectedAt: number;
}

export interface ConnectionProberOptions {
  dataDir?: string;
  maxLatencyMs?: number;  // Max acceptable latency (default: 500ms)
  probeTimeoutMs?: number; // Per-probe timeout (default: 3000ms)
  maxConcurrentProbes?: number; // Max concurrent probes (default: 3)
  lanPort?: number;       // LAN bind port (default: 3210)
  lanHost?: string;       // Explicit LAN-reachable host/IP. If omitted, first non-internal IPv4 is used.
  /**
   * Relay server host. REQUIRED — derive from the cloud HTTP base URL
   * (e.g. `cloud.prismer.dev` when `cloudApiBase=https://cloud.prismer.dev`)
   * via `deriveHostFromHttp()` in `cloud-url.ts`.
   */
  relayHost: string;
  relayPort?: number;     // Relay server port (default: 443)
  /**
   * WebSocket scheme for the relay probe. When omitted, derived from the
   * relay port (443 → `wss`, anything else → `ws`). Callers that know the
   * cloud base URL should pass this explicitly from `cloudApiBase` instead
   * of relying on the port heuristic.
   */
  relayScheme?: 'ws' | 'wss';
  pingCount?: number;     // Number of pings per probe for jitter measurement (default: 5)
}

// ============================================================
// Constants
// ============================================================

const DEFAULT_MAX_LATENCY_MS = 500;
const DEFAULT_PROBE_TIMEOUT_MS = 3000;
const DEFAULT_MAX_CONCURRENT_PROBES = 3;
const DEFAULT_LAN_PORT = 3210;
const DEFAULT_RELAY_PORT = 443;
const DEFAULT_PING_COUNT = 5;
const SELECTION_FILE = 'connection-selection.json';

// ============================================================
// ConnectionProber
// ============================================================

export class ConnectionProber {
  private dataDir: string;
  private selectionPath: string;
  private maxLatencyMs: number;
  private probeTimeoutMs: number;
  private maxConcurrentProbes: number;
  private lanPort: number;
  private lanHost?: string;
  private relayHost: string;
  private relayPort: number;
  private relayScheme: 'ws' | 'wss';
  private pingCount: number;

  constructor(opts: ConnectionProberOptions) {
    if (!opts.relayHost) {
      throw new Error('ConnectionProber: relayHost is required (derive from cloudApiBase via deriveHostFromHttp)');
    }
    this.dataDir = opts.dataDir ?? path.join(os.homedir(), '.prismer');
    this.selectionPath = path.join(this.dataDir, SELECTION_FILE);
    this.maxLatencyMs = opts.maxLatencyMs ?? DEFAULT_MAX_LATENCY_MS;
    this.probeTimeoutMs = opts.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.maxConcurrentProbes = opts.maxConcurrentProbes ?? DEFAULT_MAX_CONCURRENT_PROBES;
    this.lanPort = opts.lanPort ?? DEFAULT_LAN_PORT;
    this.lanHost = Object.prototype.hasOwnProperty.call(opts, 'lanHost')
      ? normalizeLanHost(opts.lanHost)
      : findLanIPv4();
    // Normalize relay host: when the caller passes `host:port` (e.g. from
    // `deriveHostFromHttp("http://localhost:3000")`), the embedded port wins
    // over the default `relayPort`. Without this, `getCandidates()` emits
    // endpoints like `localhost:3000:443` which fail to parse in `wsPing`
    // and `tcpPing`. Only a bare IPv4/hostname with a single trailing port
    // is split; IPv6 literals (with multiple colons) are left untouched.
    const { host: normalizedRelayHost, port: embeddedRelayPort } =
      splitHostPort(opts.relayHost);
    this.relayHost = normalizedRelayHost;
    this.relayPort = embeddedRelayPort ?? opts.relayPort ?? DEFAULT_RELAY_PORT;
    this.relayScheme = opts.relayScheme ?? (this.relayPort === 443 ? 'wss' : 'ws');
    this.pingCount = opts.pingCount ?? DEFAULT_PING_COUNT;

    // Ensure data dir exists
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  /**
   * Get all connection candidates to probe
   */
  getCandidates(): ConnectionCandidate[] {
    const candidates: ConnectionCandidate[] = [];
    if (this.lanHost) {
      candidates.push({
        type: 'lan',
        endpoint: `${this.lanHost}:${this.lanPort}`,
        priority: 1, // Highest priority
      });
    }
    candidates.push(
      {
        type: 'relay',
        endpoint: `${this.relayHost}:${this.relayPort}`,
        priority: 2,
      },
      // HTTP fallback is not probed (always available)
      // {
      //   type: 'http',
      //   endpoint: 'api.prismer.cloud',
      //   priority: 3,
      // },
    );
    return candidates;
  }

  /**
   * Probe all connection candidates with concurrency limit
   */
  async probeAll(candidates?: ConnectionCandidate[]): Promise<ProbeResult[]> {
    const targets = candidates ?? this.getCandidates();

    // Probe with concurrency limit
    const results: ProbeResult[] = [];
    for (let i = 0; i < targets.length; i += this.maxConcurrentProbes) {
      const batch = targets.slice(i, i + this.maxConcurrentProbes);
      const batchResults = await Promise.all(
        batch.map((candidate) => this.probeCandidate(candidate))
      );
      results.push(...batchResults);
    }

    // Sort by quality score (highest first), then latency, then priority
    results.sort((a, b) => {
      if (a.success !== b.success) {
        return b.success ? 1 : -1; // Success first
      }
      if (b.qualityScore !== a.qualityScore) {
        return b.qualityScore - a.qualityScore; // Higher quality first
      }
      if (a.latencyMs !== b.latencyMs) {
        return a.latencyMs - b.latencyMs; // Lower latency first
      }
      return a.candidate.priority - b.candidate.priority; // Higher priority first
    });

    return results;
  }

  /**
   * Select the best connection from probe results based on quality score
   */
  selectBest(results: ProbeResult[], opts?: { maxLatencyMs?: number; minQualityScore?: number }): ConnectionSelection | null {
    const threshold = opts?.maxLatencyMs ?? this.maxLatencyMs;
    const minQuality = opts?.minQualityScore ?? 50; // Minimum quality score (0-100)

    for (const result of results) {
      if (result.success &&
          result.latencyMs <= threshold &&
          result.qualityScore >= minQuality) {
        return {
          type: result.candidate.type,
          endpoint: result.candidate.endpoint,
          latencyMs: result.latencyMs,
          selectedAt: result.timestamp,
        };
      }
    }

    return null;
  }

  /**
   * Persist connection selection to disk
   */
  persistSelection(selection: ConnectionSelection): void {
    try {
      const tmpPath = this.selectionPath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(selection, null, 2), {
        encoding: 'utf-8',
        mode: 0o600,
      });
      fs.renameSync(tmpPath, this.selectionPath);
    } catch (err) {
      // Best-effort — don't crash if persistence fails
      console.error('[ConnectionProber] Failed to persist selection:', err);
    }
  }

  /**
   * Load persisted connection selection
   */
  loadSelection(): ConnectionSelection | null {
    try {
      if (!fs.existsSync(this.selectionPath)) {
        return null;
      }

      const data = fs.readFileSync(this.selectionPath, 'utf-8');
      const parsed = JSON.parse(data) as ConnectionSelection;

      // Validate required fields
      if (!parsed.type || !parsed.endpoint || typeof parsed.latencyMs !== 'number') {
        return null;
      }

      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * Clear persisted selection (force re-probe on next start)
   */
  clearSelection(): void {
    try {
      fs.unlinkSync(this.selectionPath);
    } catch {
      // Ignore if file doesn't exist
    }
  }

  /**
   * Probe a single connection candidate with quality scoring
   */
  private async probeCandidate(candidate: ConnectionCandidate): Promise<ProbeResult> {
    try {
      if (candidate.type === 'lan') {
        return await this.probeLAN(candidate);
      } else if (candidate.type === 'relay') {
        return await this.probeRelay(candidate);
      } else if (candidate.type === 'http') {
        return await this.probeHTTP(candidate);
      } else {
        throw new Error(`Unknown connection type: ${candidate.type}`);
      }
    } catch (err) {
      return {
        candidate,
        latencyMs: this.probeTimeoutMs,
        jitterMs: 0,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        timestamp: Date.now(),
        qualityScore: 0,
      };
    }
  }

  /**
   * Probe LAN connection (TCP socket test with multiple pings for jitter)
   */
  private async probeLAN(candidate: ConnectionCandidate): Promise<ProbeResult> {
    const [host, portStr] = candidate.endpoint.split(':');
    const port = parseInt(portStr, 10);

    // Perform multiple pings to measure jitter
    const latencies: number[] = [];
    let successCount = 0;

    for (let i = 0; i < this.pingCount; i++) {
      try {
        const latency = await this.tcpPing(host, port);
        latencies.push(latency);
        successCount++;

        // Small delay between pings to avoid flooding
        if (i < this.pingCount - 1) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      } catch (err) {
        // Continue trying even if some pings fail
        console.warn(`[ConnectionProber] LAN ping ${i + 1}/${this.pingCount} failed:`, err);
      }
    }

    if (latencies.length === 0) {
      return {
        candidate,
        latencyMs: this.probeTimeoutMs,
        jitterMs: 0,
        success: false,
        error: 'All pings failed',
        timestamp: Date.now(),
        qualityScore: 0,
      };
    }

    // Calculate statistics
    const avgLatency = latencies.reduce((sum, lat) => sum + lat, 0) / latencies.length;
    const minLatency = Math.min(...latencies);
    const maxLatency = Math.max(...latencies);
    const jitter = maxLatency - minLatency;
    const packetLoss = ((this.pingCount - successCount) / this.pingCount) * 100;

    // Calculate quality score (0-100)
    const qualityScore = this.calculateQualityScore({
      avgLatency,
      jitter,
      packetLoss,
    });

    return {
      candidate,
      latencyMs: avgLatency,
      jitterMs: jitter,
      success: true,
      timestamp: Date.now(),
      qualityScore,
    };
  }

  /**
   * Perform a single TCP ping to measure latency
   */
  private async tcpPing(host: string, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const startTime = performance.now();
      const socket = new net.Socket();
      let connected = false;

      socket.setTimeout(this.probeTimeoutMs, () => {
        if (!connected) {
          socket.destroy();
          reject(new Error('Connection timeout'));
        }
      });

      socket.on('connect', () => {
        connected = true;
        const latency = performance.now() - startTime;
        socket.destroy();
        resolve(latency);
      });

      socket.on('error', (err) => {
        socket.destroy();
        reject(err);
      });

      socket.connect(port, host);
    });
  }

  /**
   * Calculate connection quality score based on latency, jitter, and packet loss
   */
  private calculateQualityScore(metrics: {
    avgLatency: number;
    jitter: number;
    packetLoss: number;
  }): number {
    const { avgLatency, jitter, packetLoss } = metrics;

    // Normalize metrics to 0-1 range
    // Latency: < 10ms = 1, > 500ms = 0
    const latencyScore = Math.max(0, 1 - (avgLatency / 500));

    // Jitter: < 10ms = 1, > 100ms = 0
    const jitterScore = Math.max(0, 1 - (jitter / 100));

    // Packet loss: 0% = 1, > 20% = 0
    const lossScore = Math.max(0, 1 - (packetLoss / 20));

    // Weighted average (latency is most important)
    const qualityScore = (latencyScore * 0.5) + (jitterScore * 0.3) + (lossScore * 0.2);

    return Math.round(qualityScore * 100);
  }

  /**
   * Probe Relay connection (WSS handshake test with quality scoring)
   */
  private async probeRelay(candidate: ConnectionCandidate): Promise<ProbeResult> {
    const [host, portStr] = candidate.endpoint.split(':');
    const port = parseInt(portStr, 10);

    // Perform multiple WebSocket handshakes to measure quality
    const latencies: number[] = [];
    let successCount = 0;

    for (let i = 0; i < this.pingCount; i++) {
      try {
        const latency = await this.wsPing(host, port);
        latencies.push(latency);
        successCount++;

        // Small delay between pings
        if (i < this.pingCount - 1) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      } catch (err) {
        console.warn(`[ConnectionProber] Relay ping ${i + 1}/${this.pingCount} failed:`, err);
      }
    }

    if (latencies.length === 0) {
      return {
        candidate,
        latencyMs: this.probeTimeoutMs,
        jitterMs: 0,
        success: false,
        error: 'All WebSocket handshakes failed',
        timestamp: Date.now(),
        qualityScore: 0,
      };
    }

    // Calculate statistics
    const avgLatency = latencies.reduce((sum, lat) => sum + lat, 0) / latencies.length;
    const minLatency = Math.min(...latencies);
    const maxLatency = Math.max(...latencies);
    const jitter = maxLatency - minLatency;
    const packetLoss = ((this.pingCount - successCount) / this.pingCount) * 100;

    // Calculate quality score
    const qualityScore = this.calculateQualityScore({
      avgLatency,
      jitter,
      packetLoss,
    });

    return {
      candidate,
      latencyMs: avgLatency,
      jitterMs: jitter,
      success: true,
      timestamp: Date.now(),
      qualityScore,
    };
  }

  /**
   * Perform a single WebSocket handshake to measure latency
   */
  private async wsPing(host: string, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const startTime = performance.now();
      // v1.9.0: canonical probe path is /ws/probe (no-auth handshake) on the
      // same host as the cloud HTTP API. Scheme is derived from the cloud
      // base URL by the caller (TransportManager) — don't hardcode ws:// here.
      const wsUrl = `${this.relayScheme}://${host}:${port}/ws/probe`;

      const ws = new WebSocket(wsUrl, {
        handshakeTimeout: this.probeTimeoutMs,
      });

      ws.on('open', () => {
        const latency = performance.now() - startTime;
        ws.close();
        resolve(latency);
      });

      ws.on('error', (err) => {
        ws.close();
        reject(err);
      });

      // Fallback timeout
      setTimeout(() => {
        if (ws.readyState === WebSocket.CONNECTING) {
          ws.close();
          reject(new Error('WebSocket handshake timeout'));
        }
      }, this.probeTimeoutMs);
    });
  }

  /**
   * Probe HTTP connection (simple GET request with quality scoring)
   */
  private async probeHTTP(candidate: ConnectionCandidate): Promise<ProbeResult> {
    // Perform multiple HTTP requests to measure quality
    const latencies: number[] = [];
    let successCount = 0;

    for (let i = 0; i < this.pingCount; i++) {
      try {
        const latency = await this.httpPing(candidate.endpoint);
        latencies.push(latency);
        successCount++;

        // Small delay between pings
        if (i < this.pingCount - 1) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } catch (err) {
        console.warn(`[ConnectionProber] HTTP ping ${i + 1}/${this.pingCount} failed:`, err);
      }
    }

    if (latencies.length === 0) {
      return {
        candidate,
        latencyMs: this.probeTimeoutMs,
        jitterMs: 0,
        success: false,
        error: 'All HTTP requests failed',
        timestamp: Date.now(),
        qualityScore: 0,
      };
    }

    // Calculate statistics
    const avgLatency = latencies.reduce((sum, lat) => sum + lat, 0) / latencies.length;
    const minLatency = Math.min(...latencies);
    const maxLatency = Math.max(...latencies);
    const jitter = maxLatency - minLatency;
    const packetLoss = ((this.pingCount - successCount) / this.pingCount) * 100;

    // Calculate quality score
    const qualityScore = this.calculateQualityScore({
      avgLatency,
      jitter,
      packetLoss,
    });

    return {
      candidate,
      latencyMs: avgLatency,
      jitterMs: jitter,
      success: true,
      timestamp: Date.now(),
      qualityScore,
    };
  }

  /**
   * Perform a single HTTP GET request to measure latency
   */
  private async httpPing(endpoint: string): Promise<number> {
    const startTime = performance.now();
    const url = `https://${endpoint}/health`;

    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(this.probeTimeoutMs),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      return performance.now() - startTime;
    } catch (err) {
      throw new Error(`HTTP ping failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Measure exact round-trip latency to an endpoint
   * Sends a ping and measures time to response
   */
  async measureLatency(endpoint: string, type: ConnectionType): Promise<{ latency: number; quality: number }> {
    try {
      const candidate: ConnectionCandidate = { type, endpoint, priority: 99 };
      const result = await this.probeCandidate(candidate);

      return {
        latency: result.latencyMs,
        quality: result.qualityScore,
      };
    } catch {
      return { latency: Infinity, quality: 0 };
    }
  }

  /**
   * Get current connection status summary
   */
  async getStatus(): Promise<{
    current: ConnectionSelection | null;
    lastProbe: ProbeResult[];
    timestamp: number;
  }> {
    const selection = this.loadSelection();
    const lastProbe = await this.probeAll();

    return {
      current: selection,
      lastProbe,
      timestamp: Date.now(),
    };
  }
}

function findLanIPv4(): string | undefined {
  const nets = os.networkInterfaces();
  for (const entries of Object.values(nets)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && normalizeLanHost(entry.address)) {
        return entry.address;
      }
    }
  }
  return undefined;
}

/**
 * Split a `host` or `host:port` string into its components.
 *
 * - Plain hostnames / IPv4 (`"relay.test"`, `"192.168.1.10"`) → `{ host, port: undefined }`
 * - `"relay.test:8080"` / `"localhost:3000"` → `{ host: "relay.test", port: 8080 }`
 * - IPv6 literals with embedded colons but no bracket syntax (`"::1"`, `"fe80::1"`)
 *   are returned as-is with `port: undefined` — we only split when exactly
 *   one colon is present and the suffix parses as a port.
 *
 * This exists so `ConnectionProber` can accept hosts produced by
 * `deriveHostFromHttp()` which preserves the port from the cloud base URL.
 */
function splitHostPort(raw: string): { host: string; port?: number } {
  // IPv6 with exactly one colon can't happen; multi-colon hosts are IPv6.
  const colonCount = (raw.match(/:/g) ?? []).length;
  if (colonCount !== 1) {
    return { host: raw };
  }
  const idx = raw.lastIndexOf(':');
  const hostPart = raw.slice(0, idx);
  const portPart = raw.slice(idx + 1);
  if (!hostPart || !portPart) {
    return { host: raw };
  }
  const port = Number(portPart);
  if (!Number.isFinite(port) || !Number.isInteger(port) || port <= 0 || port > 65535) {
    return { host: raw };
  }
  return { host: hostPart, port };
}

function normalizeLanHost(host: string | undefined): string | undefined {
  if (!host) return undefined;
  if (host === 'localhost' || host === '0.0.0.0' || host === '::' || host === '::1') {
    return undefined;
  }
  if (host.startsWith('127.') || host.startsWith('169.254.')) {
    return undefined;
  }
  return host;
}

// ============================================================
// Convenience functions
// ============================================================

/**
 * Probe all connections and auto-select best path
 */
export async function probeAndSelect(
  opts: ConnectionProberOptions
): Promise<ConnectionSelection | null> {
  const prober = new ConnectionProber(opts);
  const results = await prober.probeAll();
  const selected = prober.selectBest(results);

  if (selected) {
    prober.persistSelection(selected);
  }

  return selected;
}

/**
 * Get current connection selection
 */
export function getCurrentSelection(
  opts: ConnectionProberOptions
): ConnectionSelection | null {
  const prober = new ConnectionProber(opts);
  return prober.loadSelection();
}
