'use client';

/**
 * Agent view (release201/12 §6 + 2026-05-30 cockpit pass).
 *
 * Single-screen agent panorama:
 *   - Header     : avatar + name + role badge + status dot
 *   - Picker     : <AgentPickerStrip /> — workspace agents, chip row (≤6) or
 *                  dropdown (>6). Selection drives the rest of the view.
 *   - Top strip  : 4 counters (tasks done / avg latency / acceptance / skills used)
 *   - Mid        : Dispatch volume timeseries (2/3) + capability pill rows (1/3)
 *   - Bottom     : Recent tasks list (click → /workspace?surface=tasks&taskId=)
 *
 * The picker is internal to AgentView but lifts its selection back to the
 * parent (`onChangeAgent`) so URL sync (?agentId=) keeps working through
 * the same code path as the legacy deep-link entries.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown, Loader2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { CounterWidget } from './counter-widget';
import { TimeseriesWidget } from './timeseries-widget';
import { SparklineWidget } from './sparkline-widget';
import {
  avatarGradient,
  avatarInitials,
  radius,
  s as surfaceClass,
  statusAccent,
} from '../../lib/design';
import { fetchAgent, type AgentResponse, type InsightsRange } from '../../lib/insights-api';
import { imFetch } from '../../lib/im-api';
import { useI18n } from '@/contexts/i18n-context';

// ─── Agent picker types ────────────────────────────────────────────────

interface PickerAgent {
  agentId: string;
  displayName: string;
  agentType?: string;
  status?: string;
}

interface StudioInstalledRes {
  agents?: Array<{
    agentId: string;
    username?: string;
    displayName?: string;
    agentType?: string;
    status?: string;
  }>;
}

export interface AgentViewProps {
  isDark: boolean;
  agentId: string | null;
  workspaceId: string | null;
  range: InsightsRange;
  refreshNonce?: number;
  mobile?: boolean;
  /**
   * Lifted up to page.tsx so URL sync (?agentId=) goes through the same
   * `syncInsightsUrl` code path as deep-link entries.
   */
  onChangeAgent?: (id: string | null) => void;
}

export function AgentView({
  isDark,
  agentId,
  workspaceId,
  range,
  refreshNonce,
  mobile,
  onChangeAgent,
}: AgentViewProps) {
  const router = useRouter();
  const { t } = useI18n();
  const theme: 'dark' | 'light' = isDark ? 'dark' : 'light';

  // ─── Picker data (independent of selected agent) ─────────────────────
  const [agents, setAgents] = useState<PickerAgent[]>([]);
  const [pickerLoading, setPickerLoading] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (!workspaceId) return;
    setPickerLoading(true);
    imFetch<StudioInstalledRes>(`/studio/installed?workspaceId=${encodeURIComponent(workspaceId)}`)
      .then((res) => {
        if (cancelled) return;
        if (res.ok) {
          const list = (res.data?.agents ?? []).map((a) => ({
            agentId: a.agentId,
            displayName: a.displayName ?? a.username ?? a.agentId,
            agentType: a.agentType,
            status: a.status,
          }));
          setAgents(list);
          // Auto-select first agent when none chosen yet.
          if (!agentId && list.length > 0 && onChangeAgent) {
            onChangeAgent(list[0].agentId);
          }
        }
      })
      .finally(() => {
        if (!cancelled) setPickerLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // agentId intentionally excluded — we only want auto-pick on first load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, refreshNonce]);

  // ─── Detail data ─────────────────────────────────────────────────────
  const [data, setData] = useState<AgentResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!agentId || !workspaceId) {
      setData(null);
      return;
    }
    setLoading(true);
    setError(null);
    fetchAgent(agentId, workspaceId, range)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, workspaceId, range, refreshNonce]);

  // ─── Selected agent meta (from picker list) ──────────────────────────
  const selected = useMemo(
    () => agents.find((a) => a.agentId === agentId) ?? null,
    [agents, agentId],
  );

  // ─── Render ──────────────────────────────────────────────────────────
  if (!workspaceId) {
    return <EmptyShell isDark={isDark} message="先选择一个 workspace" />;
  }

  // The picker is *always* on top — even when there's no agent picked yet,
  // so the user immediately sees the path forward (no more dead "Choose an
  // agent" empty state).
  const picker = (
    <AgentPickerStrip
      isDark={isDark}
      agents={agents}
      loading={pickerLoading}
      activeAgentId={agentId}
      onChange={(id) => onChangeAgent?.(id)}
    />
  );

  if (!agentId) {
    return (
      <div data-testid="insights-agent-view" className="space-y-4">
        {picker}
        <EmptyShell
          isDark={isDark}
          message={agents.length === 0 ? t('workspace.insights.empty.noData') : t('workspace.insights.empty.pickAgent')}
        />
      </div>
    );
  }

  if (loading && !data) {
    return (
      <div data-testid="insights-agent-view" className="space-y-4">
        {picker}
        <div className="flex h-64 items-center justify-center">
          <Loader2 className={`h-6 w-6 animate-spin ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`} />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div data-testid="insights-agent-view" className="space-y-4">
        {picker}
        <EmptyShell isDark={isDark} message={`无法加载 agent 洞察：${error}`} />
      </div>
    );
  }

  if (!data) {
    return (
      <div data-testid="insights-agent-view" className="space-y-4">
        {picker}
        <EmptyShell isDark={isDark} message={t('workspace.insights.empty.noData')} />
      </div>
    );
  }

  const w = data.widgets;
  const counterCols = mobile ? 'grid-cols-2' : 'grid-cols-4';

  // Mid section: timeseries (2/3) + capability pills (1/3). Mobile stacks.
  const midGrid = mobile
    ? 'flex flex-col gap-3'
    : 'grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]';

  return (
    <div data-testid="insights-agent-view" className="space-y-4">
      {picker}

      <AgentHeaderCard
        isDark={isDark}
        agentId={data.agentId}
        displayName={selected?.displayName ?? data.agentId}
        agentType={selected?.agentType}
        status={selected?.status}
        asOf={data.asOf}
      />

      {/*
        Counter strip — Tasks done / Avg latency / Acceptance / Skills used.
        Mid two counters are wired to the 11-doc metric outbox (data.metrics)
        so we surface "metric not ingested" instead of a misleading 0.
      */}
      <div data-testid="agent-top-strip" className={`grid gap-3 ${counterCols}`}>
        <CounterWidget
          isDark={isDark}
          title={t('workspace.insights.widget.tasksDone')}
          value={w.tasksDone.value}
          delta={w.tasksDone.delta ?? null}
          direction="higher-is-better"
        />
        <CounterWidget
          isDark={isDark}
          title={t('workspace.insights.widget.dispatchLatencyP95')}
          value={data.metrics.dispatchLatencyP95Ms.available ? data.metrics.dispatchLatencyP95Ms.value : 0}
          format="ms"
          isEmpty={!data.metrics.dispatchLatencyP95Ms.available}
          emptyHint={
            data.metrics.dispatchLatencyP95Ms.available
              ? undefined
              : t('workspace.insights.empty.dispatchMetricNotIngested')
          }
          direction="lower-is-better"
        />
        <CounterWidget
          isDark={isDark}
          title={t('workspace.insights.widget.acceptanceRate')}
          value={data.metrics.acceptanceRate.available ? data.metrics.acceptanceRate.value : 0}
          format="ratio"
          isEmpty={!data.metrics.acceptanceRate.available}
          emptyHint={
            data.metrics.acceptanceRate.available
              ? undefined
              : data.metrics.acceptanceRate.reason === 'no_acceptance_recorded'
                ? t('workspace.insights.empty.noAcceptance')
                : t('workspace.insights.empty.metricNotIngested')
          }
          direction="higher-is-better"
        />
        <CounterWidget
          isDark={isDark}
          title={t('workspace.insights.widget.skillsUsed')}
          value={w.skillsUsed.value}
          direction="higher-is-better"
        />
      </div>

      {/* Mid — dispatch volume + capability usage */}
      <div className={midGrid}>
        {mobile ? (
          <SparklineWidget
            isDark={isDark}
            title={t('workspace.insights.widget.dispatchVolume')}
            subtitle={t('workspace.insights.widget.dispatchVolumeSub')}
            buckets={w.dispatchVolume.buckets}
          />
        ) : (
          <TimeseriesWidget
            isDark={isDark}
            title={t('workspace.insights.widget.dispatchVolume')}
            subtitle={t('workspace.insights.widget.dispatchVolumeSub')}
            buckets={w.dispatchVolume.buckets}
            range={range}
          />
        )}
        <CapabilityUsageCard
          isDark={isDark}
          items={w.skillInvocation.items}
          onItemClick={(slug) => router.push(`/evolution?tab=studio&skillId=${encodeURIComponent(slug)}`)}
        />
      </div>

      {/* Bottom — recent tasks (hidden on mobile per legacy contract) */}
      {mobile ? null : (
        <RecentTasksList
          isDark={isDark}
          columns={w.recentTasks.columns}
          rows={w.recentTasks.rows}
          onRowClick={(id) => router.push(`/workspace?surface=tasks&taskId=${encodeURIComponent(id)}`)}
        />
      )}

      <p
        data-testid="agent-as-of"
        className={`mt-2 text-[10px] tabular-nums ${theme === 'dark' ? 'text-zinc-600' : 'text-zinc-400'}`}
      >
        as of {new Date(data.asOf).toLocaleTimeString()}
      </p>
    </div>
  );
}

// ─── Agent header card ─────────────────────────────────────────────────

function AgentHeaderCard({
  isDark,
  agentId,
  displayName,
  agentType,
  status,
  asOf: _asOf,
}: {
  isDark: boolean;
  agentId: string;
  displayName: string;
  agentType?: string;
  status?: string;
  asOf: string;
}) {
  const theme: 'dark' | 'light' = isDark ? 'dark' : 'light';
  const grad = avatarGradient(agentId);
  const dot = liveStatusDotClass(status);

  return (
    <div
      data-testid="agent-header-card"
      className={`flex items-center gap-3 border p-3.5 ${radius.card} ${surfaceClass(theme, 'card')}`}
    >
      <span
        aria-hidden
        className="relative inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white"
        style={{ background: `linear-gradient(135deg, ${grad.from}, ${grad.to})` }}
      >
        {avatarInitials(displayName)}
        <span
          className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full ring-2 ${dot} ${
            isDark ? 'ring-zinc-900' : 'ring-white'
          }`}
          data-testid="agent-header-status-dot"
          data-status={status ?? 'unknown'}
        />
      </span>
      <div className="min-w-0 flex-1">
        <p className={`text-[10px] font-bold uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
          Agent
        </p>
        <h2
          data-testid="agent-header-name"
          className={`mt-0.5 truncate text-base font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-950'}`}
        >
          {displayName}
        </h2>
      </div>
      {agentType ? (
        <Badge variant="outline" className={`shrink-0 text-[10px] uppercase tracking-wider`}>
          {agentType}
        </Badge>
      ) : null}
    </div>
  );
}

// ─── Agent picker (chip row ≤ 6, dropdown > 6) ─────────────────────────

function AgentPickerStrip({
  isDark,
  agents,
  loading,
  activeAgentId,
  onChange,
}: {
  isDark: boolean;
  agents: PickerAgent[];
  loading: boolean;
  activeAgentId: string | null;
  onChange: (id: string) => void;
}) {
  const theme: 'dark' | 'light' = isDark ? 'dark' : 'light';

  if (loading && agents.length === 0) {
    return (
      <div
        data-testid="agent-picker-strip"
        data-mode="loading"
        className={`flex items-center gap-2 border p-3 ${radius.card} ${surfaceClass(theme, 'card')}`}
      >
        <Loader2 className={`h-3.5 w-3.5 animate-spin ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`} />
        <span className={`text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>载入 agent 列表…</span>
      </div>
    );
  }

  if (agents.length === 0) {
    return (
      <div
        data-testid="agent-picker-strip"
        data-mode="empty"
        className={`flex items-center justify-between gap-2 border p-3 ${radius.card} ${surfaceClass(theme, 'card')}`}
      >
        <p className={`text-[12px] ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>
          这个 workspace 里还没有 agent。
        </p>
      </div>
    );
  }

  if (agents.length > 6) {
    return (
      <AgentPickerDropdown
        isDark={isDark}
        agents={agents}
        activeAgentId={activeAgentId}
        onChange={onChange}
      />
    );
  }

  return (
    <div
      role="radiogroup"
      aria-label="选择 agent"
      data-testid="agent-picker-strip"
      data-mode="chips"
      className={`flex flex-wrap items-center gap-2 border p-2.5 ${radius.card} ${surfaceClass(theme, 'card')}`}
    >
      {agents.map((a) => (
        <AgentChip
          key={a.agentId}
          isDark={isDark}
          agent={a}
          active={a.agentId === activeAgentId}
          onClick={() => onChange(a.agentId)}
        />
      ))}
    </div>
  );
}

function AgentChip({
  isDark,
  agent,
  active,
  onClick,
}: {
  isDark: boolean;
  agent: PickerAgent;
  active: boolean;
  onClick: () => void;
}) {
  const grad = avatarGradient(agent.agentId);
  const dot = liveStatusDotClass(agent.status);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      data-testid="agent-picker-chip"
      data-agent-id={agent.agentId}
      data-active={active}
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
        active
          ? isDark
            ? 'border-violet-500/40 bg-violet-500/15 text-violet-100'
            : 'border-violet-300 bg-violet-50 text-violet-700'
          : isDark
            ? 'border-white/[0.08] bg-zinc-900/40 text-zinc-300 hover:bg-white/[0.04] hover:text-zinc-100'
            : 'border-zinc-200 bg-white/70 text-zinc-700 hover:bg-zinc-50 hover:text-zinc-900'
      }`}
    >
      <span
        aria-hidden
        className="relative inline-flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-semibold text-white"
        style={{ background: `linear-gradient(135deg, ${grad.from}, ${grad.to})` }}
      >
        {avatarInitials(agent.displayName)}
        <span
          className={`absolute -bottom-0.5 -right-0.5 h-1.5 w-1.5 rounded-full ring-2 ${dot} ${
            isDark ? 'ring-zinc-900' : 'ring-white'
          }`}
        />
      </span>
      <span className="max-w-[140px] truncate">{agent.displayName}</span>
    </button>
  );
}

function AgentPickerDropdown({
  isDark,
  agents,
  activeAgentId,
  onChange,
}: {
  isDark: boolean;
  agents: PickerAgent[];
  activeAgentId: string | null;
  onChange: (id: string) => void;
}) {
  const theme: 'dark' | 'light' = isDark ? 'dark' : 'light';
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const handler = (ev: MouseEvent) => {
      if (ref.current && !ref.current.contains(ev.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [open]);
  const active = agents.find((a) => a.agentId === activeAgentId) ?? null;

  return (
    <div
      ref={ref}
      data-testid="agent-picker-strip"
      data-mode="dropdown"
      className={`relative border p-2 ${radius.card} ${surfaceClass(theme, 'card')}`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-testid="agent-picker-dropdown-trigger"
        className={`inline-flex w-full items-center justify-between gap-2 rounded-xl border px-3 py-2 text-xs font-medium transition-colors ${
          isDark
            ? 'border-white/[0.08] bg-zinc-950/40 text-zinc-200 hover:bg-white/[0.04]'
            : 'border-zinc-200 bg-white/80 text-zinc-700 hover:bg-zinc-50'
        }`}
      >
        <span className="truncate">{active ? active.displayName : '选择 Agent'}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden />
      </button>
      {open ? (
        <ul
          role="listbox"
          className={`absolute left-2 right-2 top-full z-30 mt-1 max-h-72 overflow-y-auto rounded-xl border p-1 shadow-xl ${
            isDark ? 'border-white/[0.08] bg-zinc-900 text-zinc-100' : 'border-zinc-200 bg-white text-zinc-900'
          }`}
        >
          {agents.map((a) => {
            const isActive = a.agentId === activeAgentId;
            const grad = avatarGradient(a.agentId);
            const dot = liveStatusDotClass(a.status);
            return (
              <li key={a.agentId}>
                <button
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  data-testid="agent-picker-dropdown-option"
                  data-agent-id={a.agentId}
                  onClick={() => {
                    onChange(a.agentId);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
                    isActive
                      ? isDark
                        ? 'bg-violet-500/15 text-violet-100'
                        : 'bg-violet-50 text-violet-700'
                      : isDark
                        ? 'hover:bg-white/[0.04]'
                        : 'hover:bg-zinc-50'
                  }`}
                >
                  <span
                    aria-hidden
                    className="relative inline-flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-semibold text-white"
                    style={{ background: `linear-gradient(135deg, ${grad.from}, ${grad.to})` }}
                  >
                    {avatarInitials(a.displayName)}
                    <span
                      className={`absolute -bottom-0.5 -right-0.5 h-1.5 w-1.5 rounded-full ring-2 ${dot} ${
                        isDark ? 'ring-zinc-900' : 'ring-white'
                      }`}
                    />
                  </span>
                  <span className="truncate">{a.displayName}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

// ─── Capability usage — pill rows (top 5 with gradient width bars) ─────

function CapabilityUsageCard({
  isDark,
  items,
  onItemClick,
}: {
  isDark: boolean;
  items: Array<{ label: string; value: number }>;
  onItemClick?: (label: string) => void;
}) {
  const theme: 'dark' | 'light' = isDark ? 'dark' : 'light';
  const top = items.slice(0, 5);
  const max = top.reduce((acc, it) => Math.max(acc, it.value), 0);

  return (
    <section
      data-testid="agent-capability-usage"
      className={`flex flex-col border ${radius.card} ${surfaceClass(theme, 'card')}`}
    >
      <header className={`flex items-center justify-between gap-2 border-b px-4 py-3 ${isDark ? 'border-white/[0.06]' : 'border-zinc-200/80'}`}>
        <div className="min-w-0">
          <h3 className={`text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>常用能力</h3>
          <p className={`mt-0.5 text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>调用次数 top 5</p>
        </div>
        {top.length > 0 ? (
          <Badge variant="secondary" className="tabular-nums">
            {top.length}
          </Badge>
        ) : null}
      </header>
      <div className="flex-1 p-2">
        {top.length === 0 ? (
          <p className={`px-2 py-6 text-center text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
            还没有技能调用记录
          </p>
        ) : (
          <ul className="space-y-1.5">
            {top.map((it, idx) => {
              const grad = GRADIENT_BAR_TOKENS[idx % GRADIENT_BAR_TOKENS.length];
              const widthPct = max > 0 ? Math.max(6, Math.round((it.value / max) * 100)) : 0;
              return (
                <li key={`${it.label}-${idx}`}>
                  <button
                    type="button"
                    data-testid="agent-capability-pill"
                    data-capability={it.label}
                    onClick={() => onItemClick?.(it.label)}
                    className={`group relative flex w-full items-center gap-2 overflow-hidden rounded-xl border px-3 py-2 text-left transition-colors ${
                      isDark
                        ? 'border-white/[0.06] bg-zinc-950/30 hover:bg-white/[0.04]'
                        : 'border-zinc-200/70 bg-white/60 hover:bg-zinc-50'
                    }`}
                  >
                    <span
                      aria-hidden
                      className={`absolute inset-y-0 left-0 -z-0 bg-gradient-to-r ${grad}`}
                      style={{ width: `${widthPct}%` }}
                    />
                    <span className={`relative z-10 min-w-0 flex-1 truncate text-xs font-medium ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
                      {it.label}
                    </span>
                    <span
                      className={`relative z-10 shrink-0 text-[11px] tabular-nums ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}
                    >
                      {it.value}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

// Direct gradient classes — accentGradients tokens are alpha-blended for
// background plates, but capability bars want a denser left-to-right fill.
const GRADIENT_BAR_TOKENS = [
  'from-violet-500/35 via-fuchsia-500/20 to-transparent',
  'from-cyan-500/35 via-sky-500/20 to-transparent',
  'from-emerald-500/35 via-teal-500/20 to-transparent',
  'from-amber-400/35 via-orange-500/20 to-transparent',
  'from-rose-500/35 via-pink-500/20 to-transparent',
];

// ─── Recent tasks list (lightweight list, click → /workspace?…&taskId=) ─

function RecentTasksList({
  isDark,
  columns,
  rows,
  onRowClick,
}: {
  isDark: boolean;
  columns: string[];
  rows: Array<{ id: string; cells: Array<{ key: string; value: string | number | null }> }>;
  onRowClick: (taskId: string) => void;
}) {
  const theme: 'dark' | 'light' = isDark ? 'dark' : 'light';
  // Find canonical columns: title / status / duration / cost (case-insensitive).
  const colIdx = (...names: string[]): number => {
    for (const n of names) {
      const i = columns.findIndex((c) => c.toLowerCase().includes(n));
      if (i >= 0) return i;
    }
    return -1;
  };
  const titleIdx = colIdx('title', 'task', 'name');
  const statusIdx = colIdx('status', 'state');
  const durationIdx = colIdx('duration', 'latency', 'time');
  const costIdx = colIdx('cost', 'credit', 'price');

  const visible = rows.slice(0, 10);

  return (
    <section
      data-testid="agent-recent-tasks"
      className={`flex flex-col border ${radius.card} ${surfaceClass(theme, 'card')}`}
    >
      <header className={`flex items-center justify-between gap-2 border-b px-4 py-3 ${isDark ? 'border-white/[0.06]' : 'border-zinc-200/80'}`}>
        <div className="min-w-0">
          <h3 className={`text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>最近任务</h3>
          <p className={`mt-0.5 text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
            最近 {visible.length} 条
          </p>
        </div>
        {rows.length > 0 ? (
          <Badge variant="secondary" className="tabular-nums">
            {rows.length}
          </Badge>
        ) : null}
      </header>
      <div className="min-h-0 flex-1">
        {visible.length === 0 ? (
          <p className={`px-4 py-6 text-center text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
            最近没有任务
          </p>
        ) : (
          <ul className="divide-y divide-zinc-200/40 dark:divide-white/[0.04]">
            {visible.map((row) => {
              const title = String(safeCell(row, titleIdx) ?? row.id);
              const status = String(safeCell(row, statusIdx) ?? '').toLowerCase();
              const duration = safeCell(row, durationIdx);
              const cost = safeCell(row, costIdx);
              const accent = statusAccent[status] ?? statusAccent.backlog;
              return (
                <li key={row.id} data-testid="agent-recent-task-row" data-task-id={row.id}>
                  <button
                    type="button"
                    onClick={() => onRowClick(row.id)}
                    className={`flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                      isDark ? 'hover:bg-white/[0.03]' : 'hover:bg-zinc-50/80'
                    }`}
                  >
                    <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${accent.dot}`} />
                    <span className="min-w-0 flex-1">
                      <span className={`block truncate text-sm font-medium ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
                        {title}
                      </span>
                      <span className={`mt-0.5 flex flex-wrap items-center gap-2 text-[11px] tabular-nums ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                        {status ? (
                          <span className={`rounded-full px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${accent.bg} ${accent.text}`}>
                            {status}
                          </span>
                        ) : null}
                        {duration != null ? <span>{formatCell(duration)}</span> : null}
                        {cost != null ? <span>· {formatCell(cost)}</span> : null}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

function safeCell(
  row: { cells: Array<{ key: string; value: string | number | null }> },
  idx: number,
): string | number | null {
  if (idx < 0) return null;
  return row.cells[idx]?.value ?? null;
}

function formatCell(v: string | number): string {
  if (typeof v === 'number' && Number.isFinite(v)) {
    if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
    return String(v);
  }
  return String(v);
}

// ─── Shared chrome ─────────────────────────────────────────────────────

function EmptyShell({ isDark, message }: { isDark: boolean; message: string }) {
  return (
    <div
      className={`rounded-2xl border border-dashed px-6 py-10 text-center text-sm ${
        isDark ? 'border-white/[0.08] text-zinc-500' : 'border-zinc-200 text-zinc-500'
      }`}
    >
      {message}
    </div>
  );
}

function liveStatusDotClass(status: string | undefined): string {
  switch ((status ?? '').toLowerCase()) {
    case 'running':
    case 'active':
    case 'online':
      return statusAccent.review.dot; // violet
    case 'stuck':
    case 'failed':
    case 'error':
      return statusAccent.failed.dot; // rose
    case 'offline':
      return 'bg-zinc-500';
    case 'idle':
    default:
      return statusAccent.backlog.dot; // zinc-400
  }
}
