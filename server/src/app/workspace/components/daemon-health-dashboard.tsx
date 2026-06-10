'use client';

/**
 * Wave 3 C2 — Daemon Health dashboard tab.
 *
 * Sister surface to `DevicesPanel`. Where Devices answers "who owns what",
 * Health answers "is the daemon actually alive". Both consume the Wave 2-B2
 * server work — Health calls `GET /api/im/daemons/:daemonId/health` on a
 * 10s cadence per visible daemon. The endpoint reads Redis presence keys
 * AND aggregates dispatch / queue counts, so this view doesn't itself need
 * to know how the cloud derives `heartbeatFresh`.
 *
 * The list of daemons to poll comes from the same binding feed the Devices
 * panel uses (the binding row IS the authoritative "this daemon exists"
 * signal post-Wave 2-B2). A simple sparkline tracks the last N polled
 * `taskQueueSize` samples to surface queue saturation visually.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, Activity, AlertTriangle } from 'lucide-react';

import { getDaemonHealth, type DaemonHealthDTO } from '../lib/agent-bindings-api';
import { radius, surface } from '../lib/design';
import { formatRelative } from './devices-panel';

const POLL_INTERVAL_MS = 10_000;
const SPARK_HISTORY = 12;

interface DaemonHealthDashboardProps {
  isDark: boolean;
  /** From `listAgentBindings` — drives which daemon IDs are polled. */
  daemonIds: string[];
  /** Map of daemonId → label, sourced from the bindings list. */
  daemonLabels: Map<string, string>;
}

interface HealthSample {
  taskQueueSize: number;
  ts: number;
}

interface DaemonState {
  daemonId: string;
  label: string;
  health: DaemonHealthDTO | null;
  error: string | null;
  refreshing: boolean;
  history: HealthSample[];
}

export function DaemonHealthDashboard({ isDark, daemonIds, daemonLabels }: DaemonHealthDashboardProps) {
  const [now, setNow] = useState(() => Date.now());
  const [daemons, setDaemons] = useState<Map<string, DaemonState>>(() => new Map());
  // Throttle to prevent re-fetch storms when bindings list churns.
  const lastPolledRef = useRef<Map<string, number>>(new Map());

  // Heartbeat-relative-time clock — refresh every 5s.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(id);
  }, []);

  // Sync daemon list when bindings change — prune stale, seed new.
  useEffect(() => {
    setDaemons((prev) => {
      const next = new Map<string, DaemonState>();
      for (const daemonId of daemonIds) {
        const existing = prev.get(daemonId);
        next.set(daemonId, {
          daemonId,
          label: daemonLabels.get(daemonId) ?? existing?.label ?? daemonId,
          health: existing?.health ?? null,
          error: existing?.error ?? null,
          refreshing: existing?.refreshing ?? false,
          history: existing?.history ?? [],
        });
      }
      return next;
    });
  }, [daemonIds, daemonLabels]);

  // Poll each visible daemon on POLL_INTERVAL_MS. Effect re-mounts when
  // daemonIds changes — that's intentional so newly added daemons start
  // polling immediately.
  useEffect(() => {
    let cancelled = false;
    async function pollOne(daemonId: string) {
      const last = lastPolledRef.current.get(daemonId) ?? 0;
      if (Date.now() - last < POLL_INTERVAL_MS / 2) return; // throttle window
      lastPolledRef.current.set(daemonId, Date.now());
      setDaemons((prev) => {
        const next = new Map(prev);
        const state = next.get(daemonId);
        if (state) next.set(daemonId, { ...state, refreshing: true });
        return next;
      });
      const res = await getDaemonHealth(daemonId);
      if (cancelled) return;
      setDaemons((prev) => {
        const next = new Map(prev);
        const state = next.get(daemonId);
        if (!state) return prev;
        if (!res.ok) {
          next.set(daemonId, { ...state, refreshing: false, error: res.message });
          return next;
        }
        const history = [...state.history, { taskQueueSize: res.data.taskQueueSize, ts: Date.now() }].slice(-SPARK_HISTORY);
        next.set(daemonId, { ...state, refreshing: false, error: null, health: res.data, history });
        return next;
      });
    }

    // Initial fetch
    daemonIds.forEach((id) => void pollOne(id));
    const interval = window.setInterval(() => {
      daemonIds.forEach((id) => void pollOne(id));
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [daemonIds]);

  const orderedStates = useMemo(() => [...daemons.values()], [daemons]);

  function refreshOne(daemonId: string) {
    // Trigger fresh fetch by clearing the throttle for this daemon.
    lastPolledRef.current.set(daemonId, 0);
    void getDaemonHealth(daemonId).then((res) => {
      setDaemons((prev) => {
        const next = new Map(prev);
        const state = next.get(daemonId);
        if (!state) return prev;
        if (!res.ok) {
          next.set(daemonId, { ...state, refreshing: false, error: res.message });
          return next;
        }
        const history = [...state.history, { taskQueueSize: res.data.taskQueueSize, ts: Date.now() }].slice(-SPARK_HISTORY);
        next.set(daemonId, { ...state, refreshing: false, error: null, health: res.data, history });
        return next;
      });
    });
  }

  if (daemonIds.length === 0) {
    return (
      <div
        data-testid="daemon-health-empty"
        className={`flex flex-col items-center gap-2 border p-8 text-center ${radius.pane} ${
          surface.pane[isDark ? 'dark' : 'light']
        }`}
      >
        <Activity className={`h-6 w-6 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`} />
        <p className={`text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
          No daemons to monitor
        </p>
        <p className={`max-w-md text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
          Health metrics appear once an agent declares ownership on a daemon. Start a daemon from the Devices tab.
        </p>
      </div>
    );
  }

  return (
    <section data-testid="daemon-health-dashboard" className="flex flex-col gap-3">
      <header className={`text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
        Polling every {Math.round(POLL_INTERVAL_MS / 1000)}s · last refreshed {formatRelative(new Date(now).toISOString(), now)}
      </header>
      <ul className="flex flex-col gap-3">
        {orderedStates.map((state) => (
          <DaemonHealthCard
            key={state.daemonId}
            isDark={isDark}
            state={state}
            now={now}
            onRefresh={() => refreshOne(state.daemonId)}
          />
        ))}
      </ul>
    </section>
  );
}

function DaemonHealthCard({
  isDark,
  state,
  now,
  onRefresh,
}: {
  isDark: boolean;
  state: DaemonState;
  now: number;
  onRefresh: () => void;
}) {
  const { health, error } = state;
  const heartbeatFresh = health?.heartbeatFresh ?? false;
  const wsConnected = health?.wsConnected ?? false;
  const transport = deriveTransport(health);
  const heartbeatLabel = health?.lastHeartbeatAt ? formatRelative(health.lastHeartbeatAt, now) : 'never';
  const dispatchLabel = health?.lastSuccessfulDispatch
    ? formatRelative(health.lastSuccessfulDispatch, now)
    : 'no dispatches yet';

  const overallState: 'online' | 'degraded' | 'offline' = !health
    ? 'offline'
    : heartbeatFresh && wsConnected
      ? 'online'
      : heartbeatFresh
        ? 'degraded'
        : 'offline';

  return (
    <li
      data-testid={`daemon-health-card-${state.daemonId}`}
      data-overall={overallState}
      className={`flex flex-col gap-4 border p-4 ${radius.pane} ${surface.pane[isDark ? 'dark' : 'light']}`}
    >
      <header className="flex items-center gap-3">
        <div
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl ${
            overallState === 'online'
              ? isDark
                ? 'bg-emerald-400/15 text-emerald-200'
                : 'bg-emerald-100 text-emerald-700'
              : overallState === 'degraded'
                ? isDark
                  ? 'bg-amber-400/15 text-amber-200'
                  : 'bg-amber-100 text-amber-700'
                : isDark
                  ? 'bg-zinc-500/20 text-zinc-400'
                  : 'bg-zinc-200 text-zinc-600'
          }`}
        >
          <Activity className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className={`truncate text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
            {state.label}
          </p>
          <p className={`mt-0.5 truncate text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
            {health?.deviceType ?? '—'} · {health?.runtimeKind ?? '—'} · {state.daemonId}
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={state.refreshing}
          data-testid={`daemon-health-refresh-${state.daemonId}`}
          className={`inline-flex shrink-0 items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-medium transition-colors ${
            isDark
              ? 'border-white/[0.08] text-zinc-300 hover:bg-white/[0.05]'
              : 'border-zinc-200 text-zinc-600 hover:bg-zinc-100'
          }`}
        >
          <RefreshCw className={`h-3 w-3 ${state.refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </header>

      {error ? (
        <p
          data-testid={`daemon-health-error-${state.daemonId}`}
          className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-xs ${
            isDark ? 'border-red-400/30 bg-red-500/10 text-red-200' : 'border-red-300 bg-red-50 text-red-700'
          }`}
        >
          <AlertTriangle className="h-3.5 w-3.5" />
          {error}
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Metric
          isDark={isDark}
          label="Transport"
          value={transport.label}
          tone={transport.tone}
          testId={`daemon-health-transport-${state.daemonId}`}
        />
        <Metric
          isDark={isDark}
          label="Last heartbeat"
          value={heartbeatLabel}
          tone={heartbeatFresh ? 'emerald' : 'zinc'}
          testId={`daemon-health-heartbeat-${state.daemonId}`}
        />
        <Metric
          isDark={isDark}
          label="Last dispatch"
          value={dispatchLabel}
          tone="zinc"
          testId={`daemon-health-dispatch-${state.daemonId}`}
        />
        <Metric
          isDark={isDark}
          label="Queue"
          value={health ? `${health.taskQueueSize} task${health.taskQueueSize === 1 ? '' : 's'}` : '—'}
          tone={(health?.taskQueueSize ?? 0) > 5 ? 'amber' : 'zinc'}
          testId={`daemon-health-queue-${state.daemonId}`}
        />
      </div>

      <Sparkline isDark={isDark} history={state.history} testId={`daemon-health-sparkline-${state.daemonId}`} />

      {health && health.agents.length > 0 ? (
        <details className={`text-xs ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
          <summary className="cursor-pointer select-none font-semibold">
            {health.agents.length} hosted agent{health.agents.length === 1 ? '' : 's'}
          </summary>
          <ul
            className={`mt-2 flex flex-col gap-1 rounded-xl border p-3 ${
              isDark ? 'border-white/[0.06] bg-white/[0.02]' : 'border-zinc-200 bg-white/60'
            }`}
          >
            {health.agents.map((agent) => (
              <li
                key={agent.agentImUserId}
                data-testid={`daemon-health-agent-${state.daemonId}-${agent.agentImUserId}`}
                className="flex items-center justify-between gap-2"
              >
                <span className="truncate">{agent.name || agent.agentImUserId}</span>
                <span className={`shrink-0 text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                  {agent.lastDispatchAt ? formatRelative(agent.lastDispatchAt, now) : 'idle'}
                  {agent.contested ? ' · ⚠ contested' : ''}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </li>
  );
}

function Metric({
  isDark,
  label,
  value,
  tone,
  testId,
}: {
  isDark: boolean;
  label: string;
  value: string;
  tone: 'emerald' | 'amber' | 'zinc';
  testId?: string;
}) {
  const colour =
    tone === 'emerald'
      ? isDark
        ? 'text-emerald-200'
        : 'text-emerald-700'
      : tone === 'amber'
        ? isDark
          ? 'text-amber-200'
          : 'text-amber-700'
        : isDark
          ? 'text-zinc-200'
          : 'text-zinc-700';
  return (
    <div data-testid={testId} className="min-w-0">
      <p className={`text-[10px] uppercase tracking-wide ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>{label}</p>
      <p className={`mt-1 truncate text-sm font-semibold ${colour}`}>{value}</p>
    </div>
  );
}

function Sparkline({ isDark, history, testId }: { isDark: boolean; history: HealthSample[]; testId?: string }) {
  if (history.length < 2) {
    return (
      <p data-testid={testId} className={`text-[11px] ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
        Sparkline appears after the second poll…
      </p>
    );
  }
  const max = Math.max(1, ...history.map((s) => s.taskQueueSize));
  const width = 200;
  const height = 32;
  const stepX = width / Math.max(1, history.length - 1);
  const points = history
    .map((sample, idx) => {
      const x = idx * stepX;
      const y = height - (sample.taskQueueSize / max) * (height - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg
      data-testid={testId}
      data-history-length={history.length}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Task queue history"
    >
      <polyline
        points={points}
        fill="none"
        strokeWidth={1.5}
        stroke={isDark ? '#a5b4fc' : '#7c3aed'}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function deriveTransport(health: DaemonHealthDTO | null): { label: string; tone: 'emerald' | 'amber' | 'zinc' } {
  if (!health) return { label: 'unknown', tone: 'zinc' };
  if (health.wsConnected && health.heartbeatFresh) return { label: 'ws', tone: 'emerald' };
  if (health.heartbeatFresh) return { label: 'http (fallback)', tone: 'amber' };
  return { label: 'offline', tone: 'zinc' };
}
