'use client';

/**
 * Admin sandbox detail client — minimal v200 deep-dive surface.
 *
 * Two data sources, both polled every 5s:
 *   - /api/sandboxes/_admin/sandbox-metrics → container metadata (we pull
 *     the row from the `recent` list; falls through to a 'unknown' row if
 *     the container is older than 20 rows).
 *   - /api/sandboxes/[id]/resources?since=<24h> → time-series chart data.
 *
 * Chart: dual-axis line chart, daemonRttMs on the left, memUsedBytes on
 * the right. CPU is 0 in v200 (placeholder until daemon resource
 * sampling lands — see 08 §6.1). The "TODO" annotation surfaces this
 * explicitly so an SRE doesn't think the data is wrong.
 *
 * Recent runs: pulled from /api/sandboxes/_admin/sandbox-metrics
 * `recentFailures` filtered by containerId. The unified metrics route
 * returns 24h failures across the whole fleet so the filter is
 * client-side — acceptable for the small N. A dedicated per-container
 * runs endpoint is a v210 follow-up.
 */

import { useEffect, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { Box, Activity, AlertTriangle } from 'lucide-react';
import { getIMClientToken } from '@/lib/im-token';
import type { SandboxMetrics, ContainerRecentRow, FailureRow } from '@/types/sandbox-metrics';

const POLL_INTERVAL_MS = 5000;
const tooltipStyle = { backgroundColor: '#18181b', border: '1px solid #3f3f46', borderRadius: '8px', fontSize: 12 };

interface ResourceSample {
  sampledAt: string;
  cpuUsagePct: number;
  memUsedBytes: string;
  memLimitBytes: string;
  daemonRttMs: number;
}

interface ResourcesResponse {
  containerId: string;
  since: string;
  samples: ResourceSample[];
}

// ── Utilities ───────────────────────────────────────────────────────────

function relTime(iso: string): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ── Metadata card ───────────────────────────────────────────────────────

function MetaField({ label, value }: { label: string; value: string | number | null }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</div>
      <div className="text-sm font-mono mt-1 break-all">{value === null || value === '' ? '—' : value}</div>
    </div>
  );
}

function MetadataCard({
  container,
  daemonHealthMisses,
  lastDaemonHealthAt,
}: {
  container: ContainerRecentRow | null;
  daemonHealthMisses: number | null;
  lastDaemonHealthAt: string | null;
}) {
  if (!container) {
    return (
      <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
        <p className="text-sm text-zinc-500">
          Container metadata not in last 20 fleet rows. Older containers are intentionally cropped from the admin
          metrics feed — chart below still loads time-series via direct lookup.
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
      <div className="flex items-center gap-2 mb-4">
        <Box className="w-5 h-5 text-zinc-400" />
        <h2 className="text-base font-semibold">Container</h2>
        <span
          className={`ml-auto text-xs font-mono px-2 py-0.5 rounded ${
            container.status === 'running'
              ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
              : container.status === 'degraded'
                ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
                : container.status === 'errored'
                  ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                  : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400'
          }`}
        >
          {container.status}
        </span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <MetaField label="Pod name" value={container.podName} />
        <MetaField label="Workspace" value={container.workspaceId} />
        <MetaField label="Provider" value={container.providerKind} />
        <MetaField label="Image" value={container.image} />
        <MetaField label="Created" value={relTime(container.createdAt)} />
        <MetaField label="Started" value={container.startedAt === null ? null : relTime(container.startedAt)} />
        <MetaField label="Daemon health misses" value={daemonHealthMisses} />
        <MetaField
          label="Last daemon health"
          value={lastDaemonHealthAt === null ? null : relTime(lastDaemonHealthAt)}
        />
        <MetaField
          label="Cold-start"
          value={
            container.coldStartLatencyMs === null
              ? null
              : container.coldStartLatencyMs < 1000
                ? `${container.coldStartLatencyMs}ms`
                : `${(container.coldStartLatencyMs / 1000).toFixed(1)}s`
          }
        />
      </div>
    </div>
  );
}

// ── Resource samples chart ──────────────────────────────────────────────

function ResourceChart({ samples }: { samples: ResourceSample[] }) {
  if (samples.length === 0) {
    return (
      <p className="text-sm text-zinc-500 text-center py-12">
        No resource samples yet — reconciler writes every ~30s, please wait.
      </p>
    );
  }
  const data = samples.map((s) => ({
    time: new Date(s.sampledAt).toLocaleTimeString(),
    rtt: s.daemonRttMs,
    memMB: Math.round(Number(s.memUsedBytes) / (1024 * 1024)),
    cpuPct: s.cpuUsagePct,
  }));

  return (
    <div className="space-y-2">
      <div className="h-[280px]">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 5, right: 40, left: 5, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
            <XAxis dataKey="time" stroke="#9ca3af" tick={{ fontSize: 10 }} />
            <YAxis
              yAxisId="rtt"
              orientation="left"
              stroke="#34D399"
              tick={{ fontSize: 11 }}
              label={{ value: 'RTT (ms)', angle: -90, position: 'insideLeft', fill: '#34D399', fontSize: 11 }}
            />
            <YAxis
              yAxisId="mem"
              orientation="right"
              stroke="#60A5FA"
              tick={{ fontSize: 11 }}
              label={{ value: 'Memory (MB)', angle: 90, position: 'insideRight', fill: '#60A5FA', fontSize: 11 }}
            />
            <Tooltip contentStyle={tooltipStyle} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Line
              yAxisId="rtt"
              type="monotone"
              dataKey="rtt"
              stroke="#34D399"
              strokeWidth={2}
              dot={false}
              name="Daemon RTT (ms)"
            />
            <Line
              yAxisId="mem"
              type="monotone"
              dataKey="memMB"
              stroke="#60A5FA"
              strokeWidth={2}
              dot={false}
              name="Mem used (MB)"
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <p className="text-xs text-zinc-500 dark:text-zinc-400 italic">
        Note: CPU is a placeholder (0) until daemon resource sampling lands — see 08 §6.1.
      </p>
    </div>
  );
}

// ── Recent runs (failures) table ────────────────────────────────────────

function RecentRunsTable({ rows }: { rows: FailureRow[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-zinc-500 text-center py-8">No failed runs for this container in last 24h.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-xs text-zinc-500 dark:text-zinc-400">
          <tr className="border-b border-zinc-200 dark:border-zinc-800">
            <th className="text-left py-2 font-medium">Ended</th>
            <th className="text-left py-2 font-medium">Reason</th>
            <th className="text-right py-2 font-medium">Exit</th>
            <th className="text-right py-2 font-medium">Duration</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-zinc-100 dark:border-zinc-800 last:border-0">
              <td className="py-1.5 text-xs">{relTime(r.endedAt)}</td>
              <td className="py-1.5 text-xs text-red-600 dark:text-red-400">{r.exitReason ?? '—'}</td>
              <td className="py-1.5 text-right tabular-nums text-xs">{r.exitCode ?? '—'}</td>
              <td className="py-1.5 text-right tabular-nums text-xs">
                {r.durationMs === null ? '—' : `${(r.durationMs / 1000).toFixed(1)}s`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Page client root ────────────────────────────────────────────────────

export function AdminSandboxDetailClient({ containerId }: { containerId: string }) {
  const [metrics, setMetrics] = useState<SandboxMetrics | null>(null);
  const [resources, setResources] = useState<ResourcesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let aborted = false;
    async function tick() {
      try {
        const token = getIMClientToken();
        const init = {
          cache: 'no-store',
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        } satisfies RequestInit;
        const [mRes, rRes] = await Promise.all([
          fetch('/api/sandboxes/_admin/sandbox-metrics', init),
          fetch(`/api/sandboxes/${containerId}/resources`, init),
        ]);

        if (mRes.ok) {
          const m = (await mRes.json()) as SandboxMetrics;
          if (!aborted) setMetrics(m);
        }

        if (rRes.ok) {
          const r = (await rRes.json()) as ResourcesResponse;
          if (!aborted) setResources(r);
        } else if (rRes.status === 404) {
          if (!aborted) setError('Container not found');
        } else {
          if (!aborted) setError(`Resources HTTP ${rRes.status}`);
        }
      } catch (err) {
        if (!aborted) setError(err instanceof Error ? err.message : String(err));
      }
    }
    tick();
    const timer = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      aborted = true;
      clearInterval(timer);
    };
  }, [containerId]);

  const container = metrics?.recent.find((r) => r.id === containerId) ?? null;
  const runs = (metrics?.recentFailures ?? []).filter((r) => r.containerId === containerId);

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-md border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/40 px-4 py-2 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      <MetadataCard container={container} daemonHealthMisses={null} lastDaemonHealthAt={null} />

      <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
        <div className="flex items-center gap-2 mb-4">
          <Activity className="w-5 h-5 text-zinc-400" />
          <h2 className="text-base font-semibold">Resource samples (24h)</h2>
          {resources && <span className="ml-auto text-xs text-zinc-500">{resources.samples.length} points</span>}
        </div>
        {resources ? <ResourceChart samples={resources.samples} /> : <p className="text-sm text-zinc-500">Loading…</p>}
      </div>

      <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
        <div className="flex items-center gap-2 mb-4">
          <AlertTriangle className="w-5 h-5 text-zinc-400" />
          <h2 className="text-base font-semibold">Recent failures (24h)</h2>
        </div>
        <RecentRunsTable rows={runs} />
      </div>
    </div>
  );
}
