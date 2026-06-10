'use client';

/**
 * Sandbox Fleet — Section 10 of /admin/analytics.
 *
 * Release 200 §08 §7.1. Adds operational visibility for the v200 sandbox
 * runtime (k8s + future e2b/daytona providers) inside the existing
 * platform analytics page; we do NOT introduce a tab structure (master
 * plan §200 explicitly preserves the scroll-Section 1-8 layout). The
 * fleet shipped at /admin/sandbox stays as the legacy SRE console and
 * is now also linked from the recent-containers table for deep-dive.
 *
 * Data: /api/sandboxes/_admin/sandbox-metrics, polled every 5s. Failures
 * render an inline message instead of throwing — the parent analytics
 * page is untouched on fetch error.
 *
 * SLO colour scheme:
 *   - green = current within target
 *   - yellow = ≤25% above target (warning band)
 *   - red = >25% above target (breach)
 * For pass-rate-style SLOs (higher is better) the inversion is handled
 * inside SLOCard via the `higherIsBetter` flag.
 */

import { useEffect, useState } from 'react';
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { Box, Activity, Clock, Heart, AlertTriangle, CheckCircle, ExternalLink } from 'lucide-react';
import { getIMClientToken } from '@/lib/im-token';
import type { SandboxMetrics, SLOEntry } from '@/types/sandbox-metrics';

const POLL_INTERVAL_MS = 5000;
const tooltipStyle = { backgroundColor: '#18181b', border: '1px solid #3f3f46', borderRadius: '8px', fontSize: 12 };

// ── Hook ────────────────────────────────────────────────────────────────

export function useSandboxMetrics() {
  const [data, setData] = useState<SandboxMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastTickMs, setLastTickMs] = useState<number | null>(null);

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
        const json = (await res.json()) as SandboxMetrics;
        if (!aborted) {
          setData(json);
          setError(null);
          setLastTickMs(Date.now());
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
  }, []);

  return { data, error, lastTickMs };
}

// ── Sub-components ──────────────────────────────────────────────────────

function KPICard({
  label,
  value,
  icon: Icon,
  variant = 'default',
}: {
  label: string;
  value: string;
  icon?: React.ComponentType<{ className?: string }>;
  variant?: 'default' | 'warning' | 'danger';
}) {
  const tone =
    variant === 'danger'
      ? 'text-red-600 dark:text-red-400'
      : variant === 'warning'
        ? 'text-yellow-600 dark:text-yellow-400'
        : 'text-zinc-900 dark:text-zinc-100';

  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm text-zinc-500 dark:text-zinc-400">{label}</span>
        {Icon && <Icon className="w-4 h-4 text-zinc-400" />}
      </div>
      <div className={`text-2xl font-semibold tabular-nums ${tone}`}>{value}</div>
    </div>
  );
}

/**
 * SLO card with traffic-light colouring. The `higherIsBetter` flag flips
 * the comparison so we can re-use one component for both p99-style ("≤
 * target good") and pass-rate-style ("≥ target good") SLOs.
 */
function SLOCard({
  label,
  slo,
  unit,
  higherIsBetter = false,
  formatter,
}: {
  label: string;
  slo: SLOEntry | undefined;
  unit: string;
  higherIsBetter?: boolean;
  formatter?: (n: number) => string;
}) {
  if (!slo) {
    return <KPICard label={label} value="—" />;
  }

  const fmt = formatter ?? ((n: number) => `${n.toFixed(2)}${unit}`);
  const currentText = slo.current === null ? 'N/A' : fmt(slo.current);
  const targetText = fmt(slo.target);

  // Determine variant. If ok=true → green. Else compute distance from
  // target to decide warning vs danger.
  let variant: 'green' | 'yellow' | 'red' = 'green';
  if (!slo.ok && slo.current !== null) {
    const ratio = higherIsBetter
      ? // pass-rate style: how far BELOW target are we?
        (slo.target - slo.current) / slo.target
      : // p99 style: how far ABOVE target are we?
        (slo.current - slo.target) / slo.target;
    variant = ratio > 0.25 ? 'red' : 'yellow';
  }

  const colourClasses = {
    green: 'text-green-600 dark:text-green-400',
    yellow: 'text-yellow-600 dark:text-yellow-400',
    red: 'text-red-600 dark:text-red-400',
  } as const;
  const borderClasses = {
    green: 'border-zinc-200 dark:border-zinc-800',
    yellow: 'border-yellow-300 dark:border-yellow-800',
    red: 'border-red-300 dark:border-red-800',
  } as const;
  const Icon = variant === 'green' ? CheckCircle : AlertTriangle;

  return (
    <div className={`rounded-xl border bg-white dark:bg-zinc-900 p-5 ${borderClasses[variant]}`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm text-zinc-500 dark:text-zinc-400">{label}</span>
        <Icon className={`w-4 h-4 ${colourClasses[variant]}`} />
      </div>
      <div className={`text-2xl font-semibold tabular-nums ${colourClasses[variant]}`}>{currentText}</div>
      <div className="text-xs text-zinc-400 dark:text-zinc-500 mt-1">target {targetText}</div>
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
      <h3 className="text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-4">{title}</h3>
      {children}
    </div>
  );
}

function formatPct(n: number): string {
  return (n * 100).toFixed(1) + '%';
}

function formatBytes(b: number): string {
  if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(2) + ' GB';
  if (b >= 1024 ** 2) return (b / 1024 ** 2).toFixed(1) + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(0) + ' KB';
  return b + ' B';
}

function shortId(id: string, len = 8): string {
  return id.length > len ? id.slice(0, len) : id;
}

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ── Charts ──────────────────────────────────────────────────────────────

/**
 * Provider distribution — stacked bar of containers per providerKind,
 * coloured by status.
 *
 * recharts BarChart with stackId means each provider gets one bar with
 * multiple status segments. We pivot the data into one row per provider.
 */
function ProviderDistributionChart({
  byProviderKind,
  byStatus,
  recent,
}: {
  byProviderKind: Record<string, number>;
  byStatus: Record<string, number>;
  recent: SandboxMetrics['recent'];
}) {
  // We can't derive the provider×status matrix from the two top-level
  // groupBys (they don't share dimensions). Instead we approximate using
  // the `recent` rows — sufficient as a fleet-trend signal for the
  // small N current admin views. Provider totals come from the
  // authoritative byProviderKind groupBy.
  const providers = Object.keys(byProviderKind);
  const statuses = Object.keys(byStatus);

  const data = providers.map((p) => {
    const row: Record<string, string | number> = { providerKind: p, total: byProviderKind[p] };
    for (const s of statuses) {
      row[s] = recent.filter((r) => r.providerKind === p && r.status === s).length;
    }
    return row;
  });

  if (data.length === 0) {
    return <p className="text-sm text-zinc-500 text-center py-12">No containers</p>;
  }

  const colours = ['#34D399', '#FBBF24', '#F87171', '#60A5FA', '#A78BFA', '#94A3B8'];

  return (
    <div className="h-[200px]">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
          <XAxis dataKey="providerKind" stroke="#9ca3af" tick={{ fontSize: 11 }} />
          <YAxis stroke="#9ca3af" tick={{ fontSize: 11 }} allowDecimals={false} />
          <Tooltip contentStyle={tooltipStyle} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {statuses.map((s, idx) => (
            <Bar key={s} dataKey={s} stackId="a" fill={colours[idx % colours.length]} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * Daemon health summary — current pass-rate + avg RTT as a simple
 * two-stat panel (no time series available at this layer yet).
 */
function DaemonHealthPanel({ daemon }: { daemon: SandboxMetrics['daemon'] }) {
  return (
    <div className="h-[200px] flex flex-col justify-center gap-6 px-4">
      <div>
        <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Health pass-rate (1h)</div>
        <div className="text-3xl font-semibold tabular-nums mt-1">{formatPct(daemon.healthPassRateLastHour)}</div>
      </div>
      <div>
        <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Avg daemon RTT (1h)</div>
        <div className="text-3xl font-semibold tabular-nums mt-1">
          {daemon.avgRttMs === null ? '—' : `${daemon.avgRttMs} ms`}
        </div>
      </div>
    </div>
  );
}

// ── Tables ──────────────────────────────────────────────────────────────

function InFlightTable({ rows }: { rows: SandboxMetrics['inFlight'] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-zinc-500 text-center py-8">No containers currently provisioning</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-xs text-zinc-500 dark:text-zinc-400">
          <tr className="border-b border-zinc-200 dark:border-zinc-800">
            <th className="text-left py-2 font-medium">Pod</th>
            <th className="text-left py-2 font-medium">Step</th>
            <th className="text-right py-2 font-medium">Age</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-zinc-100 dark:border-zinc-800 last:border-0">
              <td className="py-1.5 font-mono text-xs">{shortId(r.podName, 14)}</td>
              <td className="py-1.5 font-mono text-xs text-cyan-600 dark:text-cyan-400">{r.step ?? '—'}</td>
              <td className="py-1.5 text-right tabular-nums">
                {r.ageMs < 1000 ? `${r.ageMs}ms` : `${(r.ageMs / 1000).toFixed(1)}s`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RecentFailuresTable({ rows }: { rows: SandboxMetrics['recentFailures'] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-zinc-500 text-center py-8">No failed runs in last 24h</p>;
  }
  return (
    <div className="overflow-x-auto max-h-[220px] overflow-y-auto">
      <table className="w-full text-sm">
        <thead className="text-xs text-zinc-500 dark:text-zinc-400 sticky top-0 bg-white dark:bg-zinc-900">
          <tr className="border-b border-zinc-200 dark:border-zinc-800">
            <th className="text-left py-2 font-medium">Pod</th>
            <th className="text-left py-2 font-medium">Reason</th>
            <th className="text-right py-2 font-medium">Exit</th>
            <th className="text-right py-2 font-medium">Ended</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-zinc-100 dark:border-zinc-800 last:border-0">
              <td className="py-1.5 font-mono text-xs">{shortId(r.podName, 14)}</td>
              <td className="py-1.5 text-xs text-red-600 dark:text-red-400">{r.exitReason ?? '—'}</td>
              <td className="py-1.5 text-right tabular-nums text-xs">{r.exitCode ?? '—'}</td>
              <td className="py-1.5 text-right text-xs text-zinc-500">{relTime(r.endedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Section root ────────────────────────────────────────────────────────

export function SandboxFleetSection() {
  const { data, error } = useSandboxMetrics();

  if (error && !data) {
    // RBAC path: /api/sandboxes/_admin/sandbox-metrics gates on
    // `isSandboxAdmin(session.user.email)` from src/lib/admin-rbac.ts. The
    // allowlist source is the `ADMIN_EMAILS` env var (Nacos in test/prod)
    // OR the hardcoded fallback set in admin-rbac.ts. Non-admin users see
    // HTTP 403 here. Surface that explicitly instead of the generic
    // "unavailable" so the user knows it's a permission issue + ops knows
    // where to add an email.
    const isForbidden = /\b403\b/.test(error);
    return (
      <div className="rounded-lg bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 p-4 text-yellow-700 dark:text-yellow-300 text-sm space-y-1">
        {isForbidden ? (
          <>
            <p className="font-semibold">Admin access required to view Sandbox Fleet.</p>
            <p className="text-xs opacity-80">
              Ops: add this account&apos;s email to the <code>ADMIN_EMAILS</code> setting in the test/prod
              Nacos namespace (PrismerCloud dataId), then redeploy / wait for the next config refresh.
              The allowlist lives in <code>src/lib/admin-rbac.ts</code> as a hardcoded fallback when
              the env var is unset.
            </p>
          </>
        ) : (
          <>Sandbox metrics unavailable: {error}</>
        )}
      </div>
    );
  }

  if (!data) {
    return <p className="text-sm text-zinc-500">Loading sandbox metrics…</p>;
  }

  const running = data.containers.byStatus.running ?? 0;
  const total = data.containers.total;
  const degraded = data.daemon.degradedNow;

  return (
    <div className="space-y-4">
      {/* Top KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KPICard label="Containers (running / total)" value={`${running} / ${total}`} icon={Box} />
        <KPICard label="Active runs" value={data.runs.activeNow.toLocaleString()} icon={Activity} />
        <KPICard
          label="Cold-start p99 (24h)"
          value={data.runs.coldStartP99Sec === null ? '—' : `${data.runs.coldStartP99Sec.toFixed(1)}s`}
          icon={Clock}
        />
        <KPICard label="Daemon health (1h)" value={formatPct(data.daemon.healthPassRateLastHour)} icon={Heart} />
      </div>

      {/* Provider distribution + Daemon health */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title="Provider Distribution (containers × status)">
          <ProviderDistributionChart
            byProviderKind={data.containers.byProviderKind}
            byStatus={data.containers.byStatus}
            recent={data.recent}
          />
        </ChartCard>
        <ChartCard title="Daemon Health (last 1h)">
          <DaemonHealthPanel daemon={data.daemon} />
        </ChartCard>
      </div>

      {/* SLO cards (colour-coded) */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <SLOCard label="Cold-start p99 SLO" slo={data.slo.coldStartP99} unit="s" />
        <SLOCard
          label="Daemon health SLO"
          slo={data.slo.daemonHealthPassRate}
          unit=""
          higherIsBetter
          formatter={(n) => (n * 100).toFixed(2) + '%'}
        />
        <SLOCard label="Reconciler lag SLO" slo={data.slo.reconcilerLag} unit="s" />
        <KPICard
          label="Degraded now"
          value={degraded.toString()}
          variant={degraded === 0 ? 'default' : degraded < 3 ? 'warning' : 'danger'}
          icon={AlertTriangle}
        />
      </div>

      {/* Provisioning + failures tables */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title={`Provisioning now (${data.inFlight.length})`}>
          <InFlightTable rows={data.inFlight} />
        </ChartCard>
        <ChartCard title={`Recent failures (${data.recentFailures.length}, 24h)`}>
          <RecentFailuresTable rows={data.recentFailures} />
        </ChartCard>
      </div>

      {/* Recent containers with deep-dive link */}
      <ChartCard title="Recent containers">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-zinc-500 dark:text-zinc-400">
              <tr className="border-b border-zinc-200 dark:border-zinc-800">
                <th className="text-left py-2 font-medium">Created</th>
                <th className="text-left py-2 font-medium">Pod</th>
                <th className="text-left py-2 font-medium">Provider</th>
                <th className="text-left py-2 font-medium">Status</th>
                <th className="text-right py-2 font-medium">Cold-start</th>
                <th className="text-right py-2 font-medium">Details</th>
              </tr>
            </thead>
            <tbody>
              {data.recent.map((c) => (
                <tr key={c.id} className="border-b border-zinc-100 dark:border-zinc-800 last:border-0">
                  <td className="py-1.5 text-xs text-zinc-500">{relTime(c.createdAt)}</td>
                  <td className="py-1.5 font-mono text-xs">{shortId(c.podName, 18)}</td>
                  <td className="py-1.5 font-mono text-xs">{c.providerKind}</td>
                  <td className="py-1.5 font-mono text-xs">{c.status}</td>
                  <td className="py-1.5 text-right tabular-nums text-xs">
                    {c.coldStartLatencyMs === null
                      ? '—'
                      : c.coldStartLatencyMs < 1000
                        ? `${c.coldStartLatencyMs}ms`
                        : `${(c.coldStartLatencyMs / 1000).toFixed(1)}s`}
                  </td>
                  <td className="py-1.5 text-right">
                    <a
                      href={`/admin/sandbox/${c.id}`}
                      className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline"
                    >
                      open <ExternalLink className="w-3 h-3" />
                    </a>
                  </td>
                </tr>
              ))}
              {data.recent.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-sm text-zinc-500">
                    No containers yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </ChartCard>

      <div className="text-xs text-zinc-400 text-right">
        Sandbox metrics refreshed {relTime(data.generatedAt)} · {new Date(data.generatedAt).toLocaleTimeString()}
      </div>
    </div>
  );
}

// Re-export LineChart for the detail page (single import surface).
export { LineChart, Line, formatBytes };
