'use client';

/**
 * Admin sandbox client — polls /api/sandboxes/_admin/sandbox-metrics every 5s.
 *
 * Replaces the deleted warm-pool polling client. Warm pool was removed in
 * W1-W8 (commits `43956559..c10ea7cb`); cold-start is now the only
 * scheduling path so this dashboard tracks cold-start latency + container
 * status distribution + run-log activity instead.
 *
 * Visual style matches /admin/analytics (zinc palette, raw Tailwind on
 * bordered panels — Card/Table Shadcn components are not installed in
 * this codebase as of v1.9.x).
 */

import { useEffect, useState } from 'react';
import { getIMClientToken } from '@/lib/im-token';

interface ProvisioningHistoryEntry {
  step: string;
  status: 'in_progress' | 'ok' | 'error';
  startedAt: number;
  durationMs?: number;
  error?: string;
}

interface SandboxMetrics {
  containers: {
    total: number;
    byStatus: Record<string, number>;
    byRuntimeKind: Record<string, number>;
  };
  runs: {
    last24h: number;
    activeNow: number;
    avgDurationSec: number | null;
    p50DurationSec: number | null;
    p99DurationSec: number | null;
  };
  recent: Array<{
    id: string;
    podName: string;
    workspaceId: string;
    status: string;
    runtimeKind: string;
    image: string;
    createdAt: string;
    startedAt: string | null;
    stoppedAt: string | null;
    coldStartLatencyMs: number | null;
  }>;
  /** Migration 322 — in-flight provisioning rows. */
  inFlight?: Array<{
    id: string;
    podName: string;
    workspaceId: string;
    runtimeKind: string;
    createdAt: string;
    ageMs: number;
    step: string | null;
    history: ProvisioningHistoryEntry[];
  }>;
  generatedAt: string;
}

const REL = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

function relTime(iso: string, nowMs: number): string {
  const t = new Date(iso).getTime();
  const diffSec = Math.round((t - nowMs) / 1000);
  const abs = Math.abs(diffSec);
  if (abs < 60) return REL.format(diffSec, 'second');
  if (abs < 3600) return REL.format(Math.round(diffSec / 60), 'minute');
  if (abs < 86400) return REL.format(Math.round(diffSec / 3600), 'hour');
  return REL.format(Math.round(diffSec / 86400), 'day');
}

function formatLatencyMs(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
      <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</div>
      <div className="mt-2 text-3xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{hint}</div>}
    </div>
  );
}

function shortId(id: string, len = 8): string {
  return id.length > len ? id.slice(0, len) : id;
}

export function AdminSandboxClient() {
  const [metrics, setMetrics] = useState<SandboxMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastTickMs, setLastTickMs] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState<number>(Date.now());

  useEffect(() => {
    let aborted = false;
    async function tick() {
      try {
        const token = getIMClientToken();
        const res = await fetch('/api/sandboxes/_admin/sandbox-metrics', {
          cache: 'no-store',
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as SandboxMetrics;
        if (!aborted) {
          setMetrics(data);
          setError(null);
          setLastTickMs(Date.now());
        }
      } catch (err) {
        if (!aborted) setError(err instanceof Error ? err.message : String(err));
      }
    }
    tick();
    // 2s cadence — provisioning takes 2-3s end-to-end so 5s would miss most
    // in-flight transitions. The endpoint is cheap (5 queries, bounded N).
    const dataTimer = setInterval(tick, 2000);
    const clockTimer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => {
      aborted = true;
      clearInterval(dataTimer);
      clearInterval(clockTimer);
    };
  }, []);

  const refreshedAgo = lastTickMs !== null ? `${Math.max(0, Math.round((nowMs - lastTickMs) / 1000))}s ago` : '—';

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-md border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/40 px-4 py-2 text-sm text-red-700 dark:text-red-300">
          Fetch failed: {error}
        </div>
      )}

      {/* Top stat tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatTile label="Containers" value={metrics ? metrics.containers.total.toString() : '—'} hint="All time" />
        <StatTile
          label="Active Runs"
          value={metrics ? metrics.runs.activeNow.toString() : '—'}
          hint="endedAt IS NULL"
        />
        <StatTile
          label="Runs (24h)"
          value={metrics ? metrics.runs.last24h.toString() : '—'}
          hint="last 24h startedAt"
        />
        <StatTile
          label="Avg Cold-Start"
          value={metrics && metrics.runs.avgDurationSec !== null ? `${metrics.runs.avgDurationSec.toFixed(1)} s` : '—'}
          hint="completed runs, 24h"
        />
      </div>

      {/* Status + Runtime distribution */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
          <h3 className="text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-3">Container Status</h3>
          {metrics ? (
            Object.keys(metrics.containers.byStatus).length === 0 ? (
              <p className="text-sm text-zinc-500">No containers</p>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {Object.entries(metrics.containers.byStatus)
                    .sort((a, b) => b[1] - a[1])
                    .map(([status, count]) => (
                      <tr key={status} className="border-b border-zinc-100 dark:border-zinc-800 last:border-b-0">
                        <td className="py-1.5 font-mono text-xs text-zinc-600 dark:text-zinc-400">{status}</td>
                        <td className="py-1.5 text-right font-semibold tabular-nums">{count}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )
          ) : (
            <p className="text-sm text-zinc-500">Loading…</p>
          )}
        </div>

        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
          <h3 className="text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-3">
            Runtime Kind + Latency Percentiles
          </h3>
          {metrics ? (
            <div className="space-y-3">
              <table className="w-full text-sm">
                <tbody>
                  {Object.entries(metrics.containers.byRuntimeKind)
                    .sort((a, b) => b[1] - a[1])
                    .map(([kind, count]) => (
                      <tr key={kind} className="border-b border-zinc-100 dark:border-zinc-800 last:border-b-0">
                        <td className="py-1.5 font-mono text-xs text-zinc-600 dark:text-zinc-400">{kind}</td>
                        <td className="py-1.5 text-right font-semibold tabular-nums">{count}</td>
                      </tr>
                    ))}
                  <tr className="border-b border-zinc-100 dark:border-zinc-800">
                    <td className="py-1.5 font-mono text-xs text-zinc-600 dark:text-zinc-400">p50 duration</td>
                    <td className="py-1.5 text-right font-semibold tabular-nums">
                      {metrics.runs.p50DurationSec !== null ? `${metrics.runs.p50DurationSec.toFixed(1)} s` : '—'}
                    </td>
                  </tr>
                  <tr>
                    <td className="py-1.5 font-mono text-xs text-zinc-600 dark:text-zinc-400">p99 duration</td>
                    <td className="py-1.5 text-right font-semibold tabular-nums">
                      {metrics.runs.p99DurationSec !== null ? `${metrics.runs.p99DurationSec.toFixed(1)} s` : '—'}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-zinc-500">Loading…</p>
          )}
        </div>
      </div>

      {/* Provisioning Now — migration 322 in-flight rows */}
      <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
        <div className="px-5 py-3 border-b border-zinc-200 dark:border-zinc-800 flex items-center gap-2">
          <h3 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
            Provisioning Now {metrics?.inFlight ? `(${metrics.inFlight.length})` : ''}
          </h3>
          {metrics?.inFlight && metrics.inFlight.length > 0 && (
            <span className="inline-flex h-2 w-2 rounded-full bg-cyan-500 animate-pulse" aria-hidden />
          )}
        </div>
        <div className="overflow-x-auto">
          {metrics ? (
            metrics.inFlight && metrics.inFlight.length > 0 ? (
              <table className="w-full text-sm">
                <thead className="bg-zinc-50 dark:bg-zinc-900/50 text-xs text-zinc-500 dark:text-zinc-400">
                  <tr>
                    <th className="text-left px-4 py-2 font-medium">Pod</th>
                    <th className="text-left px-4 py-2 font-medium">Kind</th>
                    <th className="text-left px-4 py-2 font-medium">Step</th>
                    <th className="text-left px-4 py-2 font-medium">History</th>
                    <th className="text-right px-4 py-2 font-medium">Age</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.inFlight.map((c) => (
                    <tr key={c.id} className="border-t border-zinc-100 dark:border-zinc-800">
                      <td className="px-4 py-2 font-mono text-xs">{shortId(c.podName, 14)}</td>
                      <td className="px-4 py-2 font-mono text-xs">{c.runtimeKind}</td>
                      <td className="px-4 py-2">
                        <span className="inline-flex items-center gap-1.5 text-cyan-700 dark:text-cyan-300">
                          <span className="inline-block size-2 rounded-full bg-cyan-500 animate-pulse" />
                          <span className="font-mono text-xs">{c.step ?? '—'}</span>
                        </span>
                      </td>
                      <td className="px-4 py-2 font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
                        {c.history.length === 0
                          ? '—'
                          : c.history
                              .map((h) =>
                                h.status === 'ok'
                                  ? `${h.step}:${h.durationMs ?? '?'}ms`
                                  : h.status === 'error'
                                    ? `${h.step}:err`
                                    : `${h.step}…`,
                              )
                              .join(' → ')}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {c.ageMs < 1000 ? `${c.ageMs}ms` : `${(c.ageMs / 1000).toFixed(1)}s`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="px-4 py-6 text-center text-sm text-zinc-500">No containers currently provisioning.</p>
            )
          ) : (
            <p className="px-4 py-6 text-center text-sm text-zinc-500">Loading…</p>
          )}
        </div>
      </div>

      {/* Recent containers */}
      <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
        <div className="px-5 py-3 border-b border-zinc-200 dark:border-zinc-800">
          <h3 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
            Recent Containers (last {metrics?.recent.length ?? 0})
          </h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-900/50 text-xs text-zinc-500 dark:text-zinc-400">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Created</th>
                <th className="text-left px-4 py-2 font-medium">Status</th>
                <th className="text-left px-4 py-2 font-medium">Runtime</th>
                <th className="text-left px-4 py-2 font-medium">Image</th>
                <th className="text-left px-4 py-2 font-medium">Workspace</th>
                <th className="text-right px-4 py-2 font-medium">Cold-Start</th>
                <th className="text-right px-4 py-2 font-medium">Details</th>
              </tr>
            </thead>
            <tbody>
              {metrics?.recent.map((c) => (
                <tr
                  key={c.id}
                  className="border-t border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900/50"
                >
                  <td className="px-4 py-2 text-zinc-600 dark:text-zinc-400 tabular-nums">
                    {relTime(c.createdAt, nowMs)}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">{c.status}</td>
                  <td className="px-4 py-2 font-mono text-xs">{c.runtimeKind}</td>
                  <td className="px-4 py-2 font-mono text-xs">{c.image}</td>
                  <td className="px-4 py-2 font-mono text-xs text-zinc-600 dark:text-zinc-400" title={c.workspaceId}>
                    {shortId(c.workspaceId)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{formatLatencyMs(c.coldStartLatencyMs)}</td>
                  <td className="px-4 py-2 text-right">
                    <a
                      href={`/admin/sandbox/${c.id}`}
                      className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                    >
                      open →
                    </a>
                  </td>
                </tr>
              ))}
              {metrics && metrics.recent.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-sm text-zinc-500">
                    No containers yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="text-xs text-zinc-500 dark:text-zinc-400 text-right tabular-nums">
        Last refreshed {refreshedAgo}
      </div>
    </div>
  );
}
