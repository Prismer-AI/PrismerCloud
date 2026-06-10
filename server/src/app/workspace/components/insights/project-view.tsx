'use client';

/**
 * ProjectView (release201/12 §5 → v2.1 cockpit refresh).
 *
 * 2026-05-30 redesign — single-screen project cockpit with a built-in project
 * picker. Replaces the previous "no project selected → dead-end empty state"
 * UX. The picker auto-populates from `/api/im/projects?workspaceId=` and lifts
 * the chosen id up to `InsightsSurface → page.syncInsightsUrl` so deep links
 * (?surface=insights&view=project&projectId=…) keep working.
 *
 * Layout (desktop, mirrors cockpit-view.tsx visual grammar):
 *   HEADER     — project name · status badge · members · "Open project →"
 *   TOP STRIP  — 4 counter (open tasks / 验收通过 / 累计成本 / 待审批)
 *   MID        — [2fr] Burndown timeseries + [1fr] Contributors mini-list
 *   BOTTOM     — [1fr] Recent failed tasks + [1fr] Pending approvals
 *
 * Mobile collapses each row to a single column (2×2 counter grid on top).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  radius,
  s as surfaceClass,
  statusAccent,
} from '../../lib/design';
import { CounterWidget } from './counter-widget';
import { TimeseriesWidget } from './timeseries-widget';
import { SparklineWidget } from './sparkline-widget';
import {
  fetchProject,
  type InsightsRange,
  type ProjectResponse,
} from '../../lib/insights-api';
import {
  listProjects,
  type ProjectWithCountsDTO,
} from '../../lib/projects-api';
import { useI18n } from '@/contexts/i18n-context';

export interface ProjectViewProps {
  isDark: boolean;
  workspaceId: string | null;
  projectId: string | null;
  range: InsightsRange;
  refreshNonce?: number;
  mobile?: boolean;
  onChangeProject: (projectId: string | null) => void;
}

const CHIP_THRESHOLD = 6;

export function ProjectView({
  isDark,
  workspaceId,
  projectId,
  range,
  refreshNonce,
  mobile,
  onChangeProject,
}: ProjectViewProps) {
  const theme: 'dark' | 'light' = isDark ? 'dark' : 'light';
  const router = useRouter();
  const { t } = useI18n();

  // ── Picker state — list of active projects in this workspace. Keyed by
  // workspaceId so a workspace switch to null instantly hides stale chips
  // without needing a setState-in-effect reset.
  const [projectsByWs, setProjects] = useState<{ workspaceId: string; items: ProjectWithCountsDTO[] }>({
    workspaceId: '',
    items: [],
  });
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const projects = projectsByWs.workspaceId === workspaceId ? projectsByWs.items : [];

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    setProjectsLoading(true);
    setProjectsError(null);
    listProjects({ workspaceId, limit: 50 })
      .then((res) => {
        if (cancelled) return;
        if (!res.ok) {
          setProjectsError(res.message ?? 'failed');
          return;
        }
        // Filter to active client-side (endpoint accepts ?status=active but
        // we want to surface archived count in a future iteration; for now
        // pickers show active only per brief).
        const active = res.data.items.filter((p) => p.status === 'active');
        setProjects({ workspaceId, items: active });
        // Auto-select the first project when none chosen yet — mirrors the
        // agent-view picker (agent-view.tsx:103) so the 「项目」 tab never
        // dead-ends on 「请选择项目」 when the workspace has projects
        // (single-project workspaces in particular). The picker still lets
        // the user switch.
        if (!projectId && active.length > 0) {
          onChangeProject(active[0].id);
        }
      })
      .catch((err) => {
        if (!cancelled) setProjectsError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setProjectsLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // projectId / onChangeProject intentionally excluded — auto-pick should
    // only fire on first load (workspace switch / refresh), not every time
    // the user manually clears the selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, refreshNonce]);

  // ── Project detail (8 widgets) for the active picker value. ─────────
  // `data` derives from the previous projectId; when projectId becomes null
  // we want stale content to disappear from the view. Computed inline so we
  // don't need a setState-in-effect reset that the lint rule frowns on.
  const [dataByProject, setData] = useState<{ projectId: string; data: ProjectResponse | null }>({ projectId: '', data: null });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const data = dataByProject.projectId === projectId ? dataByProject.data : null;

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchProject(projectId, range)
      .then((res) => {
        if (!cancelled) setData({ projectId, data: res });
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
  }, [projectId, range, refreshNonce]);

  const picker = (
    <ProjectPickerStrip
      theme={theme}
      isDark={isDark}
      projects={projects}
      activeProjectId={projectId}
      loading={projectsLoading}
      error={projectsError}
      onChange={onChangeProject}
    />
  );

  // ── Empty / loading / error shells ──────────────────────────────────
  if (!workspaceId) {
    return <div className="space-y-4">{picker}<Empty isDark={isDark} message={t('workspace.insights.empty.pickWorkspace')} /></div>;
  }
  if (!projectId) {
    return (
      <div className="space-y-4" data-testid="insights-project-view" data-empty="no-project">
        {picker}
        <Empty
          isDark={isDark}
          message={
            projects.length === 0 && !projectsLoading
              ? t('workspace.insights.empty.projectNoTasks')
              : t('workspace.insights.empty.pickProject')
          }
        />
      </div>
    );
  }
  if (loading && !data) {
    return (
      <div className="space-y-4" data-testid="insights-project-view">
        {picker}
        <div className="flex h-40 items-center justify-center">
          <Loader2 className={`h-6 w-6 animate-spin ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`} />
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="space-y-4" data-testid="insights-project-view">
        {picker}
        <Empty isDark={isDark} message={`Couldn't load project insights: ${error}`} />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="space-y-4" data-testid="insights-project-view">
        {picker}
        <Empty isDark={isDark} message={t('workspace.insights.empty.noMetricData')} />
      </div>
    );
  }

  const w = data.widgets;
  const pendingApprovals = w.pendingApprovals.rows.length;
  const contributorsRows = w.contributors.rows;
  const failedRows = w.recentFailedTasks.rows;
  const approvalRows = w.pendingApprovals.rows;

  // ── HEADER ──────────────────────────────────────────────────────────
  const header = (
    <header
      data-testid="insights-project-header"
      className={`flex flex-col gap-2 ${radius.card} border p-4 ${surfaceClass(theme, 'card')}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className={`text-[10px] font-bold uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
            项目
          </p>
          <div className="mt-1 flex items-center gap-2">
            <h2 className={`truncate text-base font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-950'}`}>
              {data.projectName}
            </h2>
            {data.status === 'archived' ? (
              <Badge variant="secondary" className="tabular-nums">
                Archived
              </Badge>
            ) : (
              <Badge variant="outline" className="tabular-nums">
                Active
              </Badge>
            )}
          </div>
          <p className={`mt-1 text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>{data.memberCount} 成员</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          data-testid="insights-project-open"
          onClick={() => router.push(`/workspace?surface=tasks&projectId=${encodeURIComponent(projectId)}`)}
        >
          打开项目
          <ArrowRight className="ml-1 h-3.5 w-3.5" />
        </Button>
      </div>
    </header>
  );

  // ── TOP STRIP — 4 counter ───────────────────────────────────────────
  // 累计成本 reads widgets.cost (BFF SUM(IMTask.cost) over completedAt-in-window
  // tasks), populated by the task-completion cost roll-up in task.service.ts.
  const counters = (
    <div
      data-testid="insights-project-counters"
      className={`grid gap-3 ${mobile ? 'grid-cols-2' : 'grid-cols-4'}`}
    >
      <CounterWidget
        isDark={isDark}
        title="进行中任务"
        value={w.openTasks.value}
        deltaIsBetter="lower"
      />
      <CounterWidget
        isDark={isDark}
        title="验收通过"
        value={w.acceptance.value}
        unit={w.acceptance.unit}
        deltaIsBetter="higher"
      />
      <CounterWidget
        isDark={isDark}
        title="累计成本"
        subtitle="credits · 区间内完成任务"
        value={w.cost.value}
        unit="credits"
        isEmpty={w.cost.value <= 0}
        emptyHint="尚未产生成本"
        deltaIsBetter="lower"
      />
      <CounterWidget
        isDark={isDark}
        title="待审批"
        subtitle="行级可下钻"
        value={pendingApprovals}
        deltaIsBetter="lower"
      />
    </div>
  );

  // ── MID — burndown + contributors ───────────────────────────────────
  const burndown = mobile ? (
    <SparklineWidget
      isDark={isDark}
      title={t('workspace.insights.widget.burndown')}
      subtitle="燃尽 · 项目剩余任务"
      buckets={w.burndown.buckets}
    />
  ) : (
    <TimeseriesWidget
      isDark={isDark}
      title={t('workspace.insights.widget.burndown')}
      subtitle="燃尽 · 项目剩余任务"
      variant="area"
      buckets={w.burndown.buckets}
    />
  );

  const contributorsCard = (
    <section
      data-testid="insights-project-contributors"
      className={`flex flex-col ${radius.card} border ${surfaceClass(theme, 'card')}`}
    >
      <header
        className={`flex items-center justify-between gap-2 border-b px-4 py-3 ${
          isDark ? 'border-white/[0.06]' : 'border-zinc-200/80'
        }`}
      >
        <div className="min-w-0">
          <h3 className={`text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>贡献者</h3>
          <p className={`mt-0.5 text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
            {t('workspace.insights.widget.contributorsSub')}
          </p>
        </div>
        {contributorsRows.length > 0 ? (
          <Badge variant="secondary" className="tabular-nums">
            {contributorsRows.length}
          </Badge>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {contributorsRows.length === 0 ? (
          <EmptyRow isDark={isDark} message="此区间暂无贡献者" />
        ) : (
          <ul className="divide-y divide-zinc-200/40 dark:divide-white/[0.04]">
            {contributorsRows.map((row) => {
              const cells = Object.fromEntries(row.cells.map((c) => [c.key, c.value])) as Record<string, string | number | null>;
              const name = String(cells.name ?? cells.displayName ?? row.id);
              const done = cells.tasksDone ?? cells.done ?? cells.value ?? 0;
              return (
                <li key={row.id} data-testid="insights-project-contributor-row">
                  <button
                    type="button"
                    onClick={() => router.push(`/workspace?surface=insights&view=agent&agentId=${encodeURIComponent(row.id)}`)}
                    className={`flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                      isDark ? 'hover:bg-white/[0.03]' : 'hover:bg-zinc-50/80'
                    }`}
                  >
                    <span
                      aria-hidden
                      className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${
                        isDark ? 'bg-white/[0.06] text-zinc-200' : 'bg-zinc-100 text-zinc-700'
                      }`}
                    >
                      {name.slice(0, 2).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={`block truncate text-sm font-medium ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
                        {name}
                      </span>
                      <span className={`mt-0.5 block truncate text-[10px] tabular-nums ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                        完成 {String(done)}
                      </span>
                    </span>
                    <ChevronRight className={`h-3.5 w-3.5 shrink-0 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`} aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );

  const mid = mobile ? (
    <div className="flex flex-col gap-3">
      {burndown}
      {contributorsCard}
    </div>
  ) : (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      {burndown}
      {contributorsCard}
    </div>
  );

  // ── BOTTOM — failed tasks + pending approvals ───────────────────────
  const failedCard = (
    <FailedTasksCard
      theme={theme}
      isDark={isDark}
      rows={failedRows}
      onRowClick={(taskId) => router.push(`/workspace?surface=tasks&taskId=${encodeURIComponent(taskId)}`)}
    />
  );
  const approvalsCard = (
    <PendingApprovalsCard
      theme={theme}
      isDark={isDark}
      rows={approvalRows}
      onRowClick={(taskId) => router.push(`/workspace?surface=tasks&taskId=${encodeURIComponent(taskId)}`)}
    />
  );
  const bottom = mobile ? (
    <div className="flex flex-col gap-3">
      {approvalsCard}
      {failedCard}
    </div>
  ) : (
    <div className="grid gap-3 lg:grid-cols-2">
      {failedCard}
      {approvalsCard}
    </div>
  );

  return (
    <div
      data-testid="insights-project-view"
      data-layout={mobile ? 'stack' : 'cockpit'}
      data-cockpit="project"
      className="flex flex-col gap-3"
    >
      {picker}
      {header}
      {counters}
      {mid}
      {bottom}
      <p
        data-testid="insights-project-as-of"
        className={`mt-1 text-[10px] tabular-nums ${theme === 'dark' ? 'text-zinc-600' : 'text-zinc-400'}`}
      >
        as of {new Date(data.asOf).toLocaleTimeString()}
      </p>
    </div>
  );
}

// ─── ProjectPickerStrip ──────────────────────────────────────────────

function ProjectPickerStrip({
  theme,
  isDark,
  projects,
  activeProjectId,
  loading,
  error,
  onChange,
}: {
  theme: 'dark' | 'light';
  isDark: boolean;
  projects: ProjectWithCountsDTO[];
  activeProjectId: string | null;
  loading: boolean;
  error: string | null;
  onChange: (projectId: string | null) => void;
}) {
  const total = projects.length;
  const useDropdown = total > CHIP_THRESHOLD;

  if (error) {
    return (
      <div
        data-testid="insights-project-picker"
        data-state="error"
        className={`flex items-center gap-2 ${radius.card} border px-3 py-2 text-xs ${surfaceClass(theme, 'card')} ${
          isDark ? 'text-rose-300' : 'text-rose-600'
        }`}
      >
        无法加载项目列表: {error}
      </div>
    );
  }
  if (loading && projects.length === 0) {
    return (
      <div
        data-testid="insights-project-picker"
        data-state="loading"
        className={`flex items-center gap-2 ${radius.card} border px-3 py-2 ${surfaceClass(theme, 'card')}`}
      >
        <Loader2 className={`h-3.5 w-3.5 animate-spin ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`} />
        <span className={`text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>加载项目…</span>
      </div>
    );
  }
  if (total === 0) {
    return (
      <div
        data-testid="insights-project-picker"
        data-state="empty"
        className={`${radius.card} border border-dashed px-4 py-3 text-xs ${
          isDark ? 'border-white/[0.08] bg-zinc-950/40 text-zinc-400' : 'border-zinc-200 bg-white/80 text-zinc-600'
        }`}
      >
        工作区还没有 project — 去 chats / tasks 创建一个。
      </div>
    );
  }

  return (
    <div
      data-testid="insights-project-picker"
      data-state="ready"
      data-mode={useDropdown ? 'dropdown' : 'chips'}
      className={`flex items-center gap-2 ${radius.card} border p-2 ${surfaceClass(theme, 'card')}`}
    >
      <span className={`shrink-0 px-1 text-[10px] font-bold uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
        项目
      </span>
      {useDropdown ? (
        <ProjectDropdown
          isDark={isDark}
          projects={projects}
          activeProjectId={activeProjectId}
          onChange={onChange}
        />
      ) : (
        <ProjectChips
          isDark={isDark}
          projects={projects}
          activeProjectId={activeProjectId}
          onChange={onChange}
        />
      )}
    </div>
  );
}

function ProjectChips({
  isDark,
  projects,
  activeProjectId,
  onChange,
}: {
  isDark: boolean;
  projects: ProjectWithCountsDTO[];
  activeProjectId: string | null;
  onChange: (projectId: string | null) => void;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
      {projects.map((p) => {
        const active = p.id === activeProjectId;
        const dotClass = p.status === 'active' ? statusAccent.in_progress.dot : statusAccent.cancelled.dot;
        return (
          <button
            key={p.id}
            type="button"
            data-testid={`insights-project-chip-${p.slug}`}
            data-active={active ? 'true' : 'false'}
            onClick={() => onChange(p.id)}
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
              active
                ? isDark
                  ? 'border-violet-500/40 bg-violet-500/10 text-violet-200'
                  : 'border-violet-300 bg-violet-50 text-violet-700'
                : isDark
                  ? 'border-white/[0.08] bg-zinc-900/40 text-zinc-300 hover:bg-white/[0.05] hover:text-zinc-100'
                  : 'border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 hover:text-zinc-900'
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} aria-hidden />
            <span className="max-w-[180px] truncate">{p.name}</span>
          </button>
        );
      })}
    </div>
  );
}

function ProjectDropdown({
  isDark,
  projects,
  activeProjectId,
  onChange,
}: {
  isDark: boolean;
  projects: ProjectWithCountsDTO[];
  activeProjectId: string | null;
  onChange: (projectId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const active = useMemo(() => projects.find((p) => p.id === activeProjectId) ?? null, [projects, activeProjectId]);

  // Click-outside close.
  useEffect(() => {
    if (!open) return;
    const handler = (ev: MouseEvent) => {
      if (!containerRef.current?.contains(ev.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [open]);

  const onSelect = useCallback(
    (id: string) => {
      onChange(id);
      setOpen(false);
    },
    [onChange],
  );

  return (
    <div ref={containerRef} className="relative min-w-0 flex-1">
      <button
        type="button"
        data-testid="insights-project-dropdown-trigger"
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
          isDark
            ? 'border-white/[0.08] bg-zinc-900/40 text-zinc-200 hover:bg-white/[0.05]'
            : 'border-zinc-200 bg-white text-zinc-800 hover:bg-zinc-50'
        }`}
      >
        <span className="truncate">{active ? active.name : '选择项目'}</span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`} aria-hidden />
      </button>
      {open ? (
        <div
          data-testid="insights-project-dropdown-menu"
          className={`absolute left-0 right-0 top-[calc(100%+4px)] z-20 max-h-72 overflow-y-auto rounded-xl border p-1 shadow-xl ${
            isDark ? 'border-white/[0.08] bg-zinc-900 text-zinc-100' : 'border-zinc-200 bg-white text-zinc-900'
          }`}
        >
          {projects.map((p) => {
            const isActive = p.id === activeProjectId;
            return (
              <button
                key={p.id}
                type="button"
                data-testid={`insights-project-dropdown-option-${p.slug}`}
                onClick={() => onSelect(p.id)}
                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors ${
                  isActive
                    ? isDark
                      ? 'bg-violet-500/10 text-violet-200'
                      : 'bg-violet-50 text-violet-700'
                    : isDark
                      ? 'text-zinc-200 hover:bg-white/[0.05]'
                      : 'text-zinc-800 hover:bg-zinc-50'
                }`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${statusAccent.in_progress.dot}`} aria-hidden />
                <span className="truncate">{p.name}</span>
                <span className={`ml-auto shrink-0 tabular-nums text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                  {p.memberCount}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// ─── Failed tasks card ──────────────────────────────────────────────

function FailedTasksCard({
  theme,
  isDark,
  rows,
  onRowClick,
}: {
  theme: 'dark' | 'light';
  isDark: boolean;
  rows: Array<{ id: string; cells: Array<{ key: string; value: string | number | null }> }>;
  onRowClick: (taskId: string) => void;
}) {
  return (
    <section
      data-testid="insights-project-failed"
      className={`flex flex-col ${radius.card} border ${surfaceClass(theme, 'card')}`}
    >
      <header
        className={`flex items-center justify-between gap-2 border-b px-4 py-3 ${
          isDark ? 'border-white/[0.06]' : 'border-zinc-200/80'
        }`}
      >
        <div className="min-w-0">
          <h3 className={`text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>最近失败</h3>
          <p className={`mt-0.5 text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
            行级可下钻
          </p>
        </div>
        {rows.length > 0 ? (
          <Badge variant="secondary" className="tabular-nums">
            {rows.length}
          </Badge>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <EmptyRow isDark={isDark} message="此区间暂无失败任务" />
        ) : (
          <ul className="divide-y divide-zinc-200/40 dark:divide-white/[0.04]">
            {rows.map((row) => {
              const cells = Object.fromEntries(row.cells.map((c) => [c.key, c.value])) as Record<string, string | number | null>;
              const title = String(cells.title ?? cells.name ?? row.id);
              const status = String(cells.status ?? '');
              const agent = String(cells.agent ?? cells.assignee ?? '');
              const accent = statusAccent[status] ?? statusAccent.failed;
              return (
                <li key={row.id} data-testid="insights-project-failed-row">
                  <button
                    type="button"
                    onClick={() => onRowClick(row.id)}
                    className={`flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                      isDark ? 'hover:bg-white/[0.03]' : 'hover:bg-zinc-50/80'
                    }`}
                  >
                    <span className={`h-2 w-2 shrink-0 rounded-full ${accent.dot}`} aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className={`block truncate text-sm font-medium ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
                        {title}
                      </span>
                      <span className={`mt-0.5 block truncate text-[10px] tabular-nums ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                        {status ? `${status} · ` : ''}{agent || '—'}
                      </span>
                    </span>
                    <ChevronRight className={`h-3.5 w-3.5 shrink-0 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`} aria-hidden />
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

// ─── Pending approvals card (project-scoped — InsightsApprovalQueue is
// workspace-scoped so we render the project's own rows inline). ──────

function PendingApprovalsCard({
  theme,
  isDark,
  rows,
  onRowClick,
}: {
  theme: 'dark' | 'light';
  isDark: boolean;
  rows: Array<{ id: string; cells: Array<{ key: string; value: string | number | null }> }>;
  onRowClick: (taskId: string) => void;
}) {
  return (
    <section
      data-testid="insights-project-pending"
      className={`flex flex-col ${radius.card} border ${surfaceClass(theme, 'card')}`}
    >
      <header
        className={`flex items-center justify-between gap-2 border-b px-4 py-3 ${
          isDark ? 'border-white/[0.06]' : 'border-zinc-200/80'
        }`}
      >
        <div className="min-w-0">
          <h3 className={`text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>待审批</h3>
          <p className={`mt-0.5 text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
            行级可下钻
          </p>
        </div>
        {rows.length > 0 ? (
          <Badge variant="secondary" className="tabular-nums">
            {rows.length}
          </Badge>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <EmptyRow isDark={isDark} message="暂无待审批项" />
        ) : (
          <ul className="divide-y divide-zinc-200/40 dark:divide-white/[0.04]">
            {rows.map((row) => {
              const cells = Object.fromEntries(row.cells.map((c) => [c.key, c.value])) as Record<string, string | number | null>;
              const title = String(cells.title ?? cells.name ?? row.id);
              const agent = String(cells.agent ?? cells.assignee ?? '');
              return (
                <li key={row.id} data-testid="insights-project-pending-row">
                  <button
                    type="button"
                    onClick={() => onRowClick(row.id)}
                    className={`flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                      isDark ? 'hover:bg-white/[0.03]' : 'hover:bg-zinc-50/80'
                    }`}
                  >
                    <span className={`h-2 w-2 shrink-0 rounded-full ${statusAccent.review.dot}`} aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className={`block truncate text-sm font-medium ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
                        {title}
                      </span>
                      <span className={`mt-0.5 block truncate text-[10px] tabular-nums ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                        {agent || '—'}
                      </span>
                    </span>
                    <ChevronRight className={`h-3.5 w-3.5 shrink-0 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`} aria-hidden />
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

// ─── Shared empties ──────────────────────────────────────────────────

function Empty({ isDark, message }: { isDark: boolean; message: string }) {
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

function EmptyRow({ isDark, message }: { isDark: boolean; message: string }) {
  return (
    <div className={`px-4 py-6 text-center text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>{message}</div>
  );
}
