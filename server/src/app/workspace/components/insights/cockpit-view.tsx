'use client';

/**
 * CockpitView (release 2.1 「一人公司」 cockpit) — 一屏可看 + 可做。
 *
 * Layout (desktop, see brief):
 *   TOP STRIP   — 4 counter (今日完成 / 今日支出 / 在跑.卡住 / 待我处理)
 *   MID         — [2/3] 交付节奏 timeseries + 支出曲线 timeseries
 *                 [1/3] Agent 出活表
 *   BOTTOM      — [1/2] 卡住超 4 小时 任务列表
 *                 [1/2] 待审批 (复用 InsightsApprovalQueue)
 *
 * Mobile collapses each row to single column (2×2 counter grid on top).
 *
 * Data source: `fetchCockpit(workspaceId, range)` → live BFF only. Errors
 * surface to the UI; we never silently render fake data.
 *
 * History: replaces the previous Overview "widget grid + approval queue"
 * cockpit (which was rebuilt 2026-05-30 from the 6-zone canvas). The new
 * cockpit is purpose-built for the "one-person company" UX — counters
 * tell the operator what to look at, lists tell them what to act on.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Loader2, Sparkles } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  avatarGradient,
  avatarInitials,
  radius,
  s as surfaceClass,
  statusAccent,
} from '../../lib/design';
import { TimeseriesWidget } from './timeseries-widget';
import { CounterWidget } from './counter-widget';
import { InsightsApprovalQueue } from './approval-queue';
import {
  fetchCockpit,
  type CockpitAgentRow,
  type CockpitAgentStatusDot,
  type CockpitResponse,
  type CockpitStuckTaskRow,
  type InsightsRange,
} from '../../lib/insights-api';

export interface CockpitViewProps {
  isDark: boolean;
  workspaceId: string | null;
  range: InsightsRange;
  refreshNonce?: number;
  mobile?: boolean;
}

export function CockpitView({ isDark, workspaceId, range, refreshNonce, mobile }: CockpitViewProps) {
  const theme: 'dark' | 'light' = isDark ? 'dark' : 'light';
  const router = useRouter();
  const [data, setData] = useState<CockpitResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!workspaceId) return;
    setLoading(true);
    setError(null);
    fetchCockpit(workspaceId, range)
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
  }, [workspaceId, range, refreshNonce]);

  if (!workspaceId) {
    return <EmptyShell isDark={isDark} message="先选择一个 workspace" />;
  }
  if (loading && !data) {
    return (
      <div className="flex h-full items-center justify-center p-12">
        <Loader2 className={`h-6 w-6 animate-spin ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`} />
      </div>
    );
  }
  if (error && !data) {
    return <EmptyShell isDark={isDark} message={`无法加载 cockpit：${error}`} />;
  }
  if (!data) {
    return <EmptyShell isDark={isDark} message="还没有 cockpit 数据" />;
  }

  // ─── TOP STRIP — 4 counter ─────────────────────────────────────────
  const counters = (
    <div
      data-testid="cockpit-top-strip"
      className={`grid gap-3 ${mobile ? 'grid-cols-2' : 'grid-cols-4'}`}
    >
      <CounterWidget
        isDark={isDark}
        title="今日完成"
        subtitle="任务数 · 较昨日"
        value={data.today.tasksCompleted.value}
        delta={data.today.tasksCompleted.deltaVsYesterday}
        direction="higher-is-better"
      />
      <CounterWidget
        isDark={isDark}
        title="今日支出"
        subtitle="credits · 较昨日"
        value={data.today.costToday.value}
        delta={data.today.costToday.deltaVsYesterday}
        direction="lower-is-better"
        unit="credits"
      />
      <RunningStuckCounter
        isDark={isDark}
        running={data.today.running}
        stuck={data.today.stuck}
      />
      <PendingApprovalsCounter
        isDark={isDark}
        pendingApprovals={data.today.pendingApprovals}
        stuckOver4h={data.today.stuckOver4h}
      />
    </div>
  );

  // ─── MID — 2 col (timeseries left, agents right) ───────────────────
  const trends = (
    <div className="flex flex-col gap-3">
      <TimeseriesWidget
        isDark={isDark}
        title="交付节奏"
        subtitle={`完成数 · ${range}`}
        buckets={data.trends.deliveryDaily.map((p) => ({ ts: p.ts, value: p.value }))}
        range={range}
      />
      <TimeseriesWidget
        isDark={isDark}
        title="支出曲线"
        subtitle={`credits · ${range} · 本月累计 ${formatCredits(data.trends.monthSpendToDate)} / 上月 ${formatCredits(data.trends.monthSpendLast)}`}
        buckets={data.trends.spendDaily.map((p) => ({ ts: p.ts, value: p.value }))}
        range={range}
      />
    </div>
  );

  const agentTable = (
    <AgentProductivityTable
      isDark={isDark}
      agents={data.agents}
      onAgentClick={(agentId) => router.push(`/workspace?surface=insights&view=agent&agentId=${encodeURIComponent(agentId)}`)}
    />
  );

  const mid = mobile ? (
    <div className="flex flex-col gap-3">
      {trends}
      {agentTable}
    </div>
  ) : (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      {trends}
      {agentTable}
    </div>
  );

  // ─── BOTTOM — stuck-4h + approvals ─────────────────────────────────
  const stuckList = (
    <StuckTasksList
      isDark={isDark}
      tasks={data.stuckTasks}
      onRowClick={(taskId) => router.push(`/workspace?surface=tasks&taskId=${encodeURIComponent(taskId)}`)}
    />
  );
  const approvals = (
    <div className="min-h-[280px]">
      <InsightsApprovalQueue isDark={isDark} workspaceId={workspaceId} refreshNonce={refreshNonce} />
    </div>
  );
  const bottom = mobile ? (
    <div className="flex flex-col gap-3">
      {approvals}
      {stuckList}
    </div>
  ) : (
    <div className="grid gap-3 lg:grid-cols-2">
      {stuckList}
      {approvals}
    </div>
  );

  // Warming-up banner — workspace with absolutely zero activity.
  const isWarmingUp =
    data.today.tasksCompleted.value === 0 &&
    data.agents.length === 0 &&
    data.trends.deliveryDaily.every((p) => p.value === 0);

  return (
    <div
      data-testid="insights-overview-view"
      data-layout={mobile ? 'stack' : 'cockpit'}
      data-cockpit="one-person-company"
      className="flex flex-col gap-3"
    >
      {isWarmingUp ? <WarmingUpBanner isDark={isDark} /> : null}
      {counters}
      {mid}
      {bottom}
      <p
        data-testid="cockpit-as-of"
        className={`mt-1 text-[10px] tabular-nums ${theme === 'dark' ? 'text-zinc-600' : 'text-zinc-400'}`}
      >
        as of {new Date(data.asOf).toLocaleTimeString()}
      </p>
    </div>
  );
}

// ─── Counter subcomponents (multi-line, can't use plain CounterWidget) ──

function RunningStuckCounter({
  isDark,
  running,
  stuck,
}: {
  isDark: boolean;
  running: number;
  stuck: number;
}) {
  const theme: 'dark' | 'light' = isDark ? 'dark' : 'light';
  return (
    <div
      data-testid="cockpit-counter-running-stuck"
      className={`flex flex-col ${radius.card} border p-4 ${surfaceClass(theme, 'card')}`}
    >
      <h3
        className={`truncate text-xs font-bold uppercase tracking-wider ${
          isDark ? 'text-zinc-400' : 'text-zinc-600'
        }`}
      >
        在跑 / 卡住
      </h3>
      <p className={`mt-0.5 truncate text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
        实时
      </p>
      <div className="mt-3 flex items-baseline gap-3">
        <span className="flex items-baseline gap-1.5">
          <span className={`h-2 w-2 rounded-full ${statusAccent.in_progress.dot}`} aria-hidden />
          <span className={`text-3xl font-bold tabular-nums ${isDark ? 'text-zinc-100' : 'text-zinc-950'}`}>
            {running}
          </span>
          <span className={`text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>在跑</span>
        </span>
        <span className="flex items-baseline gap-1.5">
          <span className={`h-2 w-2 rounded-full ${statusAccent.failed.dot}`} aria-hidden />
          <span
            className={`text-3xl font-bold tabular-nums ${
              stuck > 0
                ? isDark
                  ? 'text-rose-300'
                  : 'text-rose-600'
                : isDark
                  ? 'text-zinc-100'
                  : 'text-zinc-950'
            }`}
          >
            {stuck}
          </span>
          <span className={`text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>卡住</span>
        </span>
      </div>
    </div>
  );
}

function PendingApprovalsCounter({
  isDark,
  pendingApprovals,
  stuckOver4h,
}: {
  isDark: boolean;
  pendingApprovals: number;
  stuckOver4h: number;
}) {
  const theme: 'dark' | 'light' = isDark ? 'dark' : 'light';
  const total = pendingApprovals + stuckOver4h;
  const tone =
    total === 0
      ? isDark
        ? 'text-zinc-100'
        : 'text-zinc-950'
      : isDark
        ? 'text-amber-300'
        : 'text-amber-600';
  return (
    <div
      data-testid="cockpit-counter-pending"
      className={`flex flex-col ${radius.card} border p-4 ${surfaceClass(theme, 'card')}`}
    >
      <h3
        className={`truncate text-xs font-bold uppercase tracking-wider ${
          isDark ? 'text-zinc-400' : 'text-zinc-600'
        }`}
      >
        待我处理
      </h3>
      <p className={`mt-0.5 truncate text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
        审批 + 卡住超 4h
      </p>
      <div className="mt-3 flex items-baseline gap-2">
        <span className={`text-3xl font-bold tabular-nums ${tone}`}>{total}</span>
        <span className={`text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
          {pendingApprovals} 审批 · {stuckOver4h} 卡住
        </span>
      </div>
    </div>
  );
}

// ─── AgentProductivityTable ────────────────────────────────────────

function AgentProductivityTable({
  isDark,
  agents,
  onAgentClick,
}: {
  isDark: boolean;
  agents: CockpitAgentRow[];
  onAgentClick: (agentId: string) => void;
}) {
  const theme: 'dark' | 'light' = isDark ? 'dark' : 'light';
  return (
    <section
      data-testid="cockpit-agent-productivity"
      className={`flex flex-col ${radius.card} border ${surfaceClass(theme, 'card')}`}
    >
      <header className={`flex items-center justify-between gap-2 border-b px-4 py-3 ${isDark ? 'border-white/[0.06]' : 'border-zinc-200/80'}`}>
        <div className="min-w-0">
          <h3 className={`text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>Agents</h3>
          <p className={`mt-0.5 text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
            出活 / 耗时 / 成本
          </p>
        </div>
        {agents.length > 0 ? (
          <Badge variant="secondary" className="tabular-nums">
            {agents.length}
          </Badge>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {agents.length === 0 ? (
          <EmptyRow isDark={isDark} message="还没有 agent 出活记录" />
        ) : (
          <ul className="divide-y divide-zinc-200/40 dark:divide-white/[0.04]">
            {agents.map((a) => (
              <AgentProductivityRow
                key={a.agentId}
                isDark={isDark}
                agent={a}
                onClick={() => onAgentClick(a.agentId)}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function AgentProductivityRow({
  isDark,
  agent,
  onClick,
}: {
  isDark: boolean;
  agent: CockpitAgentRow;
  onClick: () => void;
}) {
  const grad = avatarGradient(agent.avatarSeed);
  const dot = statusDotClass(agent.statusDot);
  return (
    <li data-testid="cockpit-agent-row" data-agent-id={agent.agentId}>
      <button
        type="button"
        onClick={onClick}
        className={`flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors ${
          isDark ? 'hover:bg-white/[0.03]' : 'hover:bg-zinc-50/80'
        }`}
      >
        {/* avatar */}
        <span
          aria-hidden
          className="relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white"
          style={{ background: `linear-gradient(135deg, ${grad.from}, ${grad.to})` }}
        >
          {avatarInitials(agent.displayName)}
          <span
            className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ${dot} ${
              isDark ? 'ring-zinc-900' : 'ring-white'
            }`}
            data-testid="cockpit-agent-status-dot"
            data-status={agent.statusDot}
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className={`block truncate text-sm font-medium ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
            {agent.displayName}
          </span>
          <span className={`mt-0.5 block truncate text-[10px] tabular-nums ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
            今 {agent.todayDone} · 周 {agent.weekDone} · {formatMs(agent.avgDurationMs)} · {formatCredits4(agent.avgCost)}
          </span>
        </span>
        <ArrowRight className={`h-3.5 w-3.5 shrink-0 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`} aria-hidden />
      </button>
    </li>
  );
}

// ─── StuckTasksList ────────────────────────────────────────────────

function StuckTasksList({
  isDark,
  tasks,
  onRowClick,
}: {
  isDark: boolean;
  tasks: CockpitStuckTaskRow[];
  onRowClick: (taskId: string) => void;
}) {
  const theme: 'dark' | 'light' = isDark ? 'dark' : 'light';
  return (
    <section
      data-testid="cockpit-stuck-tasks"
      className={`flex flex-col ${radius.card} border ${surfaceClass(theme, 'card')}`}
    >
      <header className={`flex items-center justify-between gap-2 border-b px-4 py-3 ${isDark ? 'border-white/[0.06]' : 'border-zinc-200/80'}`}>
        <div className="min-w-0">
          <h3 className={`text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>卡住超 4 小时</h3>
          <p className={`mt-0.5 text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>需要人接手或重派</p>
        </div>
        {tasks.length > 0 ? (
          <Badge
            variant="destructive"
            className="tabular-nums"
            data-testid="cockpit-stuck-count"
          >
            {tasks.length}
          </Badge>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tasks.length === 0 ? (
          <EmptyRow isDark={isDark} message="没有卡住的任务" />
        ) : (
          <ul className="divide-y divide-zinc-200/40 dark:divide-white/[0.04]">
            {tasks.map((t) => (
              <li key={t.id} data-testid="cockpit-stuck-row" data-task-id={t.id}>
                <div className="flex items-start gap-3 px-4 py-3">
                  <span
                    aria-hidden
                    className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${statusAccent.failed.dot}`}
                  />
                  <div className="min-w-0 flex-1">
                    <p className={`truncate text-sm font-medium ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
                      {t.title}
                    </p>
                    <p className={`mt-0.5 flex flex-wrap items-center gap-2 text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                      <span className="tabular-nums">{formatStuckSince(t.stuckSinceMs)}</span>
                      {t.assigneeName ? <span>· {t.assigneeName}</span> : <span>· 未分派</span>}
                      {t.currentPhase ? (
                        <Badge
                          variant="outline"
                          className={`px-1.5 py-0 text-[9px] uppercase tracking-wider ${
                            isDark ? 'border-white/[0.08] text-zinc-400' : 'border-zinc-200 text-zinc-600'
                          }`}
                        >
                          {t.currentPhase}
                        </Badge>
                      ) : null}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => onRowClick(t.id)}
                    data-testid="cockpit-stuck-open"
                    aria-label={`打开任务 ${t.title}`}
                  >
                    打开 <ArrowRight />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

// ─── Shared chrome ─────────────────────────────────────────────────

function WarmingUpBanner({ isDark }: { isDark: boolean }) {
  return (
    <div
      data-testid="cockpit-warming-up-banner"
      className={`flex items-start gap-2 ${radius.card} border px-4 py-3 text-xs ${
        isDark
          ? 'border-indigo-500/20 bg-indigo-500/[0.06] text-indigo-200'
          : 'border-indigo-200 bg-indigo-50 text-indigo-700'
      }`}
    >
      <Sparkles className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <p className="leading-relaxed">workspace 还很安静——派出第一个 agent，cockpit 就会亮起来。</p>
    </div>
  );
}

function EmptyShell({ isDark, message }: { isDark: boolean; message: string }) {
  return (
    <div
      className={`${radius.card} border border-dashed px-6 py-10 text-center text-sm ${
        isDark ? 'border-white/[0.08] text-zinc-500' : 'border-zinc-200 text-zinc-500'
      }`}
    >
      {message}
    </div>
  );
}

function EmptyRow({ isDark, message }: { isDark: boolean; message: string }) {
  return (
    <p className={`px-4 py-6 text-center text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
      {message}
    </p>
  );
}

// ─── Formatters ────────────────────────────────────────────────────

function formatMs(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function formatCredits(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return `${value.toFixed(2)} credits`;
}

function formatCredits4(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '— credits';
  return `${value.toFixed(4)} credits`;
}

function formatStuckSince(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 3_600_000) return `卡住 ${Math.round(ms / 60_000)} 分钟`;
  return `卡住 ${(ms / 3_600_000).toFixed(1)} 小时`;
}

function statusDotClass(status: CockpitAgentStatusDot): string {
  switch (status) {
    case 'running':
      return statusAccent.review.dot; // violet — spec: running=violet
    case 'stuck':
      return statusAccent.failed.dot; // rose
    case 'offline':
      return 'bg-zinc-500';
    case 'idle':
    default:
      return statusAccent.backlog.dot; // zinc-400
  }
}

