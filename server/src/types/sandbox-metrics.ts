/**
 * Sandbox metrics contract shared by:
 *   - GET /api/sandboxes/_admin/sandbox-metrics (server emitter)
 *   - /admin/analytics Section 10 (Sandbox Fleet)
 *   - /admin/sandbox (legacy SRE console)
 *   - /admin/sandbox/[id] (detail page)
 *
 * Release 200 §08 §7.2. Kept in a dedicated module so client + server
 * agree on the wire shape without drift. Optional fields cover the
 * pre-v200 dual-write window (byRuntimeKind preserved alongside the
 * new byProviderKind).
 */

export type SandboxStatus =
  | 'pending'
  | 'bound'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'errored'
  | 'provisioning'
  | 'degraded';

export interface SLOEntry {
  target: number;
  current: number | null;
  ok: boolean;
}

export interface ProvisioningHistoryEntry {
  step: string;
  status: 'in_progress' | 'ok' | 'error';
  startedAt: number;
  durationMs?: number;
  error?: string;
}

export interface ContainerRecentRow {
  id: string;
  podName: string;
  workspaceId: string;
  status: string;
  runtimeKind: string;
  providerKind: string;
  image: string;
  createdAt: string;
  startedAt: string | null;
  stoppedAt: string | null;
  coldStartLatencyMs: number | null;
}

export interface ContainerInFlightRow {
  id: string;
  podName: string;
  workspaceId: string;
  runtimeKind: string;
  createdAt: string;
  ageMs: number;
  step: string | null;
  history: ProvisioningHistoryEntry[];
}

export interface FailureRow {
  id: string;
  containerId: string;
  podName: string;
  workspaceId: string;
  providerKind: string;
  exitCode: number | null;
  exitReason: string | null;
  durationMs: number | null;
  endedAt: string;
}

export interface SandboxMetrics {
  generatedAt: string;
  containers: {
    total: number;
    byStatus: Record<string, number>;
    /**
     * Legacy column (docker | k8s). Retained during the v200 dual-write
     * window so existing /admin/sandbox keeps rendering. v210 drops.
     */
    byRuntimeKind: Record<string, number>;
    /** Release 200 §08 §7.2 — provider-abstraction grouping. */
    byProviderKind: Record<string, number>;
  };
  runs: {
    last24h: number;
    activeNow: number;
    avgDurationSec: number | null;
    p50DurationSec: number | null;
    p99DurationSec: number | null;
    /**
     * Cold-start latency = pod scheduled → daemon ready. v200 fallback
     * algorithm uses `im_containers.startedAt - createdAt` because the
     * unified `im_sandbox_runs` ephemeral path is not yet writing rows
     * (08 §6.1). v210 switches to `im_sandbox_runs.createdAt → startedAt`.
     */
    coldStartP50Sec: number | null;
    coldStartP99Sec: number | null;
    /**
     * Fraction of 24h runs with exitCode != 0 OR exitReason='error'.
     * 0.0 when no completed runs.
     */
    errorRate24h: number;
  };
  daemon: {
    /**
     * Reconciler success rate over the last 1h. Computed as
     *   min(1.0, actualSamples / expectedSamples)
     * where expectedSamples = (running k8s containers) * 120
     * (≈2 samples/min × 60min). Returns 1.0 when no running containers.
     */
    healthPassRateLastHour: number;
    avgRttMs: number | null;
    /** Containers currently `status='degraded'`. */
    degradedNow: number;
  };
  slo: {
    coldStartP99: SLOEntry;
    daemonHealthPassRate: SLOEntry;
    /**
     * Reconciler lag = NOW - MIN(lastDaemonHealthAt) over running k8s
     * containers. null when no running k8s containers have ever been
     * probed.
     */
    reconcilerLag: SLOEntry;
  };
  recent: ContainerRecentRow[];
  inFlight: ContainerInFlightRow[];
  /** Release 200 §08 §7.2 — 24h non-zero-exit runs, 20 rows max. */
  recentFailures: FailureRow[];
}
