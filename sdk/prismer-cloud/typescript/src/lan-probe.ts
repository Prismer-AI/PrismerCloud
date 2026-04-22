/**
 * Prismer SDK — LAN Probe Service (v1.9.0)
 *
 * Client-side connection probing for remote control.
 * Discovers and selects best connection path to daemon.
 *
 * Features:
 *   - Concurrent connection probing (LAN + Relay)
 *   - Connection quality scoring (latency, jitter, packet loss)
 *   - Automatic path selection
 *   - Connection health monitoring
 *   - Seamless switching between paths
 */

import * as net from 'node:net';
import * as https from 'node:https';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';

// ============================================================
// Types
// ============================================================

export type ConnectionType = 'lan' | 'relay';

export interface ConnectionCandidate {
  type: ConnectionType;
  endpoint: string;
  priority: number;  // Lower = higher priority
}

export interface ProbeResult {
  candidate: ConnectionCandidate;
  latencyMs: number;
  jitterMs: number;
  success: boolean;
  error?: string;
  timestamp: number;
  qualityScore: number;  // 0-100 (higher is better)
}

export interface ConnectionSelection {
  type: ConnectionType;
  endpoint: string;
  latencyMs: number;
  qualityScore: number;
  selectedAt: number;
}

export interface LanProbeOptions {
  daemonId: string;
  lanIP?: string;
  lanPort?: number;
  /**
   * Base WSS URL for the relay (e.g. `wss://cloud.prismer.dev`). Callers
   * typically derive it from their cloud HTTP base URL — there is no separate
   * relay subdomain.
   */
  relayUrl: string;
  maxLatencyMs?: number;
  probeTimeoutMs?: number;
  maxConcurrentProbes?: number;
  pingCount?: number;
}

// ============================================================
// Constants
// ============================================================

const DEFAULT_MAX_LATENCY_MS = 500;
const DEFAULT_PROBE_TIMEOUT_MS = 3000;
const DEFAULT_MAX_CONCURRENT_PROBES = 3;
const DEFAULT_PING_COUNT = 5;

// ============================================================
// LanProbeService
// ============================================================

export class LanProbeService {
  private daemonId: string;
  private lanIP?: string;
  private lanPort: number;
  private relayUrl: string;
  private maxLatencyMs: number;
  private probeTimeoutMs: number;
  private maxConcurrentProbes: number;
  private pingCount: number;

  constructor(opts: LanProbeOptions) {
    if (!opts.relayUrl) {
      throw new Error('LanProbeService: relayUrl is required (derive from cloud HTTP base)');
    }
    this.daemonId = opts.daemonId;
    this.lanIP = opts.lanIP;
    this.lanPort = opts.lanPort ?? 3210;
    this.relayUrl = opts.relayUrl;
    this.maxLatencyMs = opts.maxLatencyMs ?? DEFAULT_MAX_LATENCY_MS;
    this.probeTimeoutMs = opts.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.maxConcurrentProbes = opts.maxConcurrentProbes ?? DEFAULT_MAX_CONCURRENT_PROBES;
    this.pingCount = opts.pingCount ?? DEFAULT_PING_COUNT;
  }

  /**
   * Get all connection candidates to probe
   */
  getCandidates(): ConnectionCandidate[] {
    const candidates: ConnectionCandidate[] = [];

    // LAN candidate (if IP is known)
    if (this.lanIP) {
      candidates.push({
        type: 'lan',
        endpoint: `${this.lanIP}:${this.lanPort}`,
        priority: 1,  // Highest priority
      });
    }

    // Relay candidate
    candidates.push({
      type: 'relay',
      endpoint: this.relayUrl,
      priority: 2,  // Lower priority
    });

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
        return b.success ? 1 : -1;  // Success first
      }
      if (b.qualityScore !== a.qualityScore) {
        return b.qualityScore - a.qualityScore;  // Higher quality first
      }
      if (a.latencyMs !== b.latencyMs) {
        return a.latencyMs - b.latencyMs;  // Lower latency first
      }
      return a.candidate.priority - b.candidate.priority;  // Higher priority first
    });

    return results;
  }

  /**
   * Select best connection from probe results
   */
  selectBest(results: ProbeResult[], opts?: { maxLatencyMs?: number; minQualityScore?: number }): ConnectionSelection | null {
    const threshold = opts?.maxLatencyMs ?? this.maxLatencyMs;
    const minQuality = opts?.minQualityScore ?? 50;  // Minimum quality score (0-100)

    for (const result of results) {
      if (result.success &&
          result.latencyMs <= threshold &&
          result.qualityScore >= minQuality) {
        return {
          type: result.candidate.type,
          endpoint: result.candidate.endpoint,
          latencyMs: result.latencyMs,
          qualityScore: result.qualityScore,
          selectedAt: result.timestamp,
        };
      }
    }

    return null;
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
   * Probe LAN connection (TCP socket test with HTTP probe)
   */
  private async probeLAN(candidate: ConnectionCandidate): Promise<ProbeResult> {
    const [host, portStr] = candidate.endpoint.split(':');
    const port = parseInt(portStr, 10);

    // First, verify TCP connectivity
    try {
      await this.tcpPing(host, port);
    } catch (err) {
      return {
        candidate,
        latencyMs: this.probeTimeoutMs,
        jitterMs: 0,
        success: false,
        error: `TCP connect failed: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: Date.now(),
        qualityScore: 0,
      };
    }

    // Then, probe HTTP endpoint for quality metrics
    const latencies: number[] = [];
    let successCount = 0;

    for (let i = 0; i < this.pingCount; i++) {
      try {
        const latency = await this.httpPing(`http://${host}:${port}/v1/lan-probe`);
        latencies.push(latency);
        successCount++;

        // Small delay between pings
        if (i < this.pingCount - 1) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      } catch (err) {
        console.warn(`[LanProbeService] LAN HTTP ping ${i + 1}/${this.pingCount} failed:`, err);
      }
    }

    if (latencies.length === 0) {
      return {
        candidate,
        latencyMs: this.probeTimeoutMs,
        jitterMs: 0,
        success: false,
        error: 'All HTTP pings failed',
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
   * Probe Relay connection (WSS handshake test)
   */
  private async probeRelay(candidate: ConnectionCandidate): Promise<ProbeResult> {
    const url = candidate.endpoint;

    // Perform multiple WebSocket handshakes to measure quality
    const latencies: number[] = [];
    let successCount = 0;

    for (let i = 0; i < this.pingCount; i++) {
      try {
        const latency = await this.wsPing(url);
        latencies.push(latency);
        successCount++;

        // Small delay between pings
        if (i < this.pingCount - 1) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      } catch (err) {
        console.warn(`[LanProbeService] Relay ping ${i + 1}/${this.pingCount} failed:`, err);
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
   * Perform a single TCP ping to verify connectivity
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
   * Perform a single HTTP GET request to measure latency
   */
  private async httpPing(url: string): Promise<number> {
    const startTime = performance.now();

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
   * Perform a single WebSocket handshake to measure latency
   */
  private async wsPing(url: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const startTime = performance.now();

      const ws = new WebSocket(url, {
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
   * Get current connection status summary
   */
  async getStatus(): Promise<{
    current: ConnectionSelection | null;
    lastProbe: ProbeResult[];
    timestamp: number;
  }> {
    const results = await this.probeAll();
    const selected = this.selectBest(results);

    return {
      current: selected,
      lastProbe: results,
      timestamp: Date.now(),
    };
  }
}

// ============================================================
// Convenience functions
// ============================================================

/**
 * Probe all connections and auto-select best path
 */
export async function probeAndSelectLan(
  opts: LanProbeOptions
): Promise<ConnectionSelection | null> {
  const probeService = new LanProbeService(opts);
  const results = await probeService.probeAll();
  const selected = probeService.selectBest(results);

  return selected;
}

/**
 * Get current connection status
 */
export async function getLanStatus(
  opts: LanProbeOptions
): Promise<{
  current: ConnectionSelection | null;
  lastProbe: ProbeResult[];
  timestamp: number;
}> {
  const probeService = new LanProbeService(opts);
  return await probeService.getStatus();
}
