/**
 * Lightweight In-Memory Metrics Store
 *
 * Tracks request latency, external API performance, and error rates
 * with a 5-minute sliding window. Exposed via /api/admin/analytics.
 *
 * Layer 2 observability — no external dependencies (Prometheus/Datadog).
 */

// ============================================================================
// Types
// ============================================================================

interface LatencySample {
  timestamp: number;
  duration: number;
  status: number;
}

interface EndpointMetrics {
  samples: LatencySample[];
}

interface ExternalApiSample {
  timestamp: number;
  duration: number;
  success: boolean;
}

interface ExternalApiMetrics {
  samples: ExternalApiSample[];
}

export interface MetricsSnapshot {
  endpoints: Array<{
    endpoint: string;
    count: number;
    errorCount: number;
    errorRate: number;
    p50: number;
    p95: number;
    p99: number;
  }>;
  externalApis: Array<{
    service: string;
    requestCount: number;
    avgLatency: number;
    p95Latency: number;
    errorRate: number;
  }>;
  connections: {
    ws: number;
    sse: number;
  };
}

// ============================================================================
// Metrics Store (Singleton)
// ============================================================================

const WINDOW_MS = 5 * 60 * 1000; // 5-minute sliding window

class MetricsStore {
  private endpoints = new Map<string, EndpointMetrics>();
  private externalApis = new Map<string, ExternalApiMetrics>();
  private wsConnections = 0;
  private sseConnections = 0;

  // ─── Record Methods ──────────────────────────────────────────

  recordRequest(endpoint: string, duration: number, status: number) {
    if (!this.endpoints.has(endpoint)) {
      this.endpoints.set(endpoint, { samples: [] });
    }
    const metrics = this.endpoints.get(endpoint)!;
    metrics.samples.push({ timestamp: Date.now(), duration, status });
    this.prune(metrics.samples);
  }

  recordExternalApi(service: string, duration: number, success: boolean) {
    if (!this.externalApis.has(service)) {
      this.externalApis.set(service, { samples: [] });
    }
    const metrics = this.externalApis.get(service)!;
    metrics.samples.push({ timestamp: Date.now(), duration, success });
    this.prune(metrics.samples);
  }

  setConnections(ws: number, sse: number) {
    this.wsConnections = ws;
    this.sseConnections = sse;
  }

  // ─── Query Methods ───────────────────────────────────────────

  getSnapshot(): MetricsSnapshot {
    const now = Date.now();
    const cutoff = now - WINDOW_MS;

    const endpoints: MetricsSnapshot['endpoints'] = [];
    for (const [endpoint, metrics] of this.endpoints) {
      const recent = metrics.samples.filter(s => s.timestamp >= cutoff);
      if (recent.length === 0) continue;

      const durations = recent.map(s => s.duration).sort((a, b) => a - b);
      const errorCount = recent.filter(s => s.status >= 400).length;

      endpoints.push({
        endpoint,
        count: recent.length,
        errorCount,
        errorRate: recent.length > 0 ? errorCount / recent.length : 0,
        p50: percentile(durations, 0.5),
        p95: percentile(durations, 0.95),
        p99: percentile(durations, 0.99),
      });
    }

    const externalApis: MetricsSnapshot['externalApis'] = [];
    for (const [service, metrics] of this.externalApis) {
      const recent = metrics.samples.filter(s => s.timestamp >= cutoff);
      if (recent.length === 0) continue;

      const durations = recent.map(s => s.duration).sort((a, b) => a - b);
      const errorCount = recent.filter(s => !s.success).length;
      const avgLatency = durations.reduce((a, b) => a + b, 0) / durations.length;

      externalApis.push({
        service,
        requestCount: recent.length,
        avgLatency: Math.round(avgLatency),
        p95Latency: percentile(durations, 0.95),
        errorRate: recent.length > 0 ? errorCount / recent.length : 0,
      });
    }

    return {
      endpoints: endpoints.sort((a, b) => b.count - a.count),
      externalApis: externalApis.sort((a, b) => b.requestCount - a.requestCount),
      connections: { ws: this.wsConnections, sse: this.sseConnections },
    };
  }

  // ─── Internal ────────────────────────────────────────────────

  private prune(samples: Array<{ timestamp: number }>) {
    const cutoff = Date.now() - WINDOW_MS;
    // Find first non-expired sample and splice expired ones in O(1) amortized
    const idx = samples.findIndex(s => s.timestamp >= cutoff);
    if (idx > 0) {
      samples.splice(0, idx);
    } else if (idx === -1 && samples.length > 0) {
      samples.length = 0;
    }
    // Cap at 10K samples per bucket
    if (samples.length > 10000) {
      samples.splice(0, samples.length - 10000);
    }
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(p * sorted.length) - 1;
  return Math.round(sorted[Math.max(0, idx)]);
}

// ============================================================================
// Singleton Export
// ============================================================================

// Use globalThis to survive HMR in Next.js dev
const globalKey = '__prismerMetrics';

function getMetrics(): MetricsStore {
  if (!(globalThis as any)[globalKey]) {
    (globalThis as any)[globalKey] = new MetricsStore();
  }
  return (globalThis as any)[globalKey];
}

export const metrics = getMetrics();

