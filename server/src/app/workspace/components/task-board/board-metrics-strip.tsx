'use client';

/**
 * BoardMetricsStrip — peer sibling of the kanban section. Shows recent
 * activity + 3 small charts (efficiency trend, velocity, agent status).
 *
 * Memoized so the strip doesn't re-render on every drag-over `setColumns`
 * in the parent TaskBoard — recharts' ResponsiveContainer is sensitive to
 * high-frequency re-renders of its containing tree (ResizeObserver
 * feedback). Extracted from `task-board.tsx`.
 */

import { memo, useMemo } from 'react';
import { Bar, BarChart, Cell, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { useI18n } from '@/contexts/i18n-context';
import type { TaskDTO, AgentDTO } from '../../lib/types';

import { buildTaskTrendData, buildAgentStatusData, formatActivityTime } from './helpers';
import type { TaskTrendPoint, AgentStatusPoint } from './types';

export const BoardMetricsStrip = memo(function BoardMetricsStrip({
  isDark,
  tasks,
  agents,
}: {
  isDark: boolean;
  tasks: TaskDTO[];
  agents: AgentDTO[];
}) {
  const { t } = useI18n();
  const completed = useMemo(() => tasks.filter((task) => task.status === 'completed').length, [tasks]);
  const running = useMemo(
    () => tasks.filter((task) => task.status === 'running' || task.status === 'review').length,
    [tasks],
  );
  const efficiency = tasks.length > 0 ? Math.round((completed / tasks.length) * 100) : 0;
  const activeAgents = useMemo(
    () =>
      agents.filter(
        (agent) => agent.presence?.status === 'online' || agent.status === 'online' || agent.status === 'busy',
      ).length,
    [agents],
  );
  const velocity = Math.max(0, completed + Math.ceil(running / 2));
  const recent = useMemo(
    () =>
      tasks
        .slice()
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .slice(0, 3),
    [tasks],
  );
  const trendData = useMemo(() => buildTaskTrendData(tasks), [tasks]);
  const agentStatusData = useMemo(
    () =>
      buildAgentStatusData(agents, {
        online: t('workspace.taskBoard.agentOnline'),
        busy: t('workspace.taskBoard.agentBusy'),
        offline: t('workspace.taskBoard.agentOffline'),
      }),
    [agents, t],
  );

  return (
    <div
      // Single-row 4-col grid from md+ so the strip stays ~130px tall
      // instead of the 2×2 stacked ~230px it had on md→xl screens. Keeps
      // the kanban column area dominant in the viewport.
      className={`mx-5 mb-4 grid shrink-0 gap-3 overflow-hidden rounded-2xl border px-4 py-3 md:grid-cols-[minmax(260px,1.35fr)_minmax(180px,1fr)_minmax(180px,1fr)_minmax(180px,1fr)] ${
        isDark ? 'border-white/[0.06] bg-white/[0.025]' : 'border-zinc-200/80 bg-white/75'
      }`}
    >
      <div className="min-w-0 overflow-hidden">
        <p className={`text-[10px] font-semibold ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
          {t('workspace.taskBoard.activity')}
        </p>
        <div className="mt-2 grid max-h-[88px] gap-1.5 overflow-hidden">
          {recent.length > 0 ? (
            recent.map((task) => (
              <div
                key={task.id}
                className="grid min-w-0 grid-cols-[54px_14px_minmax(0,1fr)] items-center gap-2 text-[11px]"
              >
                <span className={`tabular-nums ${isDark ? 'text-zinc-600' : 'text-zinc-500'}`}>
                  {formatActivityTime(task.updatedAt)}
                </span>
                <span
                  className={`h-3.5 w-3.5 rounded-full ${task.status === 'completed' ? 'bg-emerald-300' : task.status === 'running' || task.status === 'review' ? 'bg-amber-300' : 'bg-zinc-300'}`}
                />
                <span className={`truncate ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>{task.title}</span>
              </div>
            ))
          ) : (
            <div className={`flex h-12 items-center text-[11px] ${isDark ? 'text-zinc-600' : 'text-zinc-500'}`}>
              {t('workspace.taskBoard.noActivityYet')}
            </div>
          )}
        </div>
      </div>
      <MetricTrend
        isDark={isDark}
        label={t('workspace.taskBoard.teamEfficiency')}
        value={`${efficiency}%`}
        detail={`${completed}/${tasks.length} ${t('workspace.taskBoard.metricCompleted')}`}
        tone="emerald"
        data={trendData}
        dataKey="efficiency"
        unit="%"
      />
      <MetricTrend
        isDark={isDark}
        label={t('workspace.taskBoard.tasksVelocity')}
        value={`${velocity}`}
        detail={`${trendData.at(-1)?.updated ?? 0} ${t('workspace.taskBoard.updatedToday')}`}
        tone="violet"
        data={trendData}
        dataKey="updated"
      />
      <AgentStatusChart
        isDark={isDark}
        label={t('workspace.taskBoard.activeAgents')}
        activeAgents={activeAgents}
        totalAgents={agents.length}
        data={agentStatusData}
      />
    </div>
  );
});

function MetricTrend({
  isDark,
  label,
  value,
  detail,
  tone,
  data,
  dataKey,
  unit,
}: {
  isDark: boolean;
  label: string;
  value: string;
  detail: string;
  tone: 'emerald' | 'violet';
  data: TaskTrendPoint[];
  dataKey: 'efficiency' | 'updated';
  unit?: string;
}) {
  const stroke = tone === 'emerald' ? '#6ee7a8' : tone === 'violet' ? '#a78bfa' : '#38bdf8';
  const text = tone === 'emerald' ? 'text-emerald-500' : tone === 'violet' ? 'text-violet-500' : 'text-sky-500';
  return (
    <div className="grid min-w-0 grid-cols-[minmax(84px,0.55fr)_minmax(96px,1fr)] items-center gap-3 overflow-hidden">
      <div className="min-w-0">
        <p className={`truncate text-[10px] font-medium ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>{label}</p>
        <p className={`mt-1 text-lg font-bold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>{value}</p>
        <p className={`truncate text-[10px] font-semibold ${text}`}>{detail}</p>
      </div>
      <div className="h-14 min-w-0 overflow-hidden">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 6, right: 4, bottom: 0, left: 4 }}>
            <XAxis dataKey="label" hide />
            <YAxis hide domain={[0, dataKey === 'efficiency' ? 100 : 'dataMax + 1']} />
            <Tooltip
              cursor={false}
              contentStyle={{
                borderRadius: 10,
                border: isDark ? '1px solid rgba(255,255,255,0.08)' : '1px solid rgb(228,228,231)',
                background: isDark ? 'rgba(24,24,27,0.96)' : 'rgba(255,255,255,0.96)',
                color: isDark ? '#e4e4e7' : '#18181b',
                fontSize: 11,
              }}
              formatter={(raw) => [`${raw}${unit ?? ''}`, label]}
              labelFormatter={(labelValue) => String(labelValue)}
            />
            <Line type="monotone" dataKey={dataKey} stroke={stroke} strokeWidth={3} dot={false} activeDot={{ r: 3 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function AgentStatusChart({
  isDark,
  label,
  activeAgents,
  totalAgents,
  data,
}: {
  isDark: boolean;
  label: string;
  activeAgents: number;
  totalAgents: number;
  data: AgentStatusPoint[];
}) {
  const { t } = useI18n();
  return (
    <div className="grid min-w-0 grid-cols-[minmax(84px,0.55fr)_minmax(96px,1fr)] items-center gap-3 overflow-hidden">
      <div className="min-w-0">
        <p className={`truncate text-[10px] font-medium ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>{label}</p>
        <p className={`mt-1 text-lg font-bold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
          {activeAgents}/{totalAgents}
        </p>
        <p className="truncate text-[10px] font-semibold text-sky-500">{t('workspace.taskBoard.currentStatus')}</p>
      </div>
      <div className="h-14 min-w-0 overflow-hidden">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 2, bottom: 0, left: 2 }}>
            <XAxis dataKey="label" hide />
            <YAxis hide allowDecimals={false} domain={[0, 'dataMax + 1']} />
            <Tooltip
              cursor={false}
              contentStyle={{
                borderRadius: 10,
                border: isDark ? '1px solid rgba(255,255,255,0.08)' : '1px solid rgb(228,228,231)',
                background: isDark ? 'rgba(24,24,27,0.96)' : 'rgba(255,255,255,0.96)',
                color: isDark ? '#e4e4e7' : '#18181b',
                fontSize: 11,
              }}
            />
            <Bar dataKey="count" radius={[6, 6, 0, 0]} maxBarSize={18}>
              {data.map((entry) => (
                <Cell key={entry.label} fill={entry.color} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
