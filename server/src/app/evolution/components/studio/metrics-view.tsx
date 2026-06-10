'use client';

/**
 * Studio · Metrics view — release201/11 §4-§5, release201/13 §3.7 (S22).
 *
 * Aggregates from /api/im/metrics/aggregate:
 *
 *   1. counter — Tasks done       (namespace=task name=completed, agg=count, range=7d)
 *   2. counter — Avg latency      (namespace=agent name=dispatch, agg=p95, range=24h)
 *   3. counter — Acceptance %     (namespace=task.acceptance name=status_changed, agg=count
 *                                  with groupBy=status; we compute passed / total)
 *   4. counter — Skills used      (namespace=skill name=invoked, agg=count groupBy=skillId,
 *                                  shown as distinct skillId count)
 *   5. timeseries — Tasks completed per day (agg=count, bucket=1d, range=7d)
 *   6. timeseries — Dispatch p95 latency    (S23-dependent — banner when 0 data)
 *   7. bar       — skill.invoked top 5 by skillId
 *
 * Empty-state banner is shown above the grid whenever none of the metric
 * queries return any data (no banner when at least one returns rows — keeps
 * partially-wired environments from spamming the banner during S23 rollout).
 */

import { useEffect, useState } from 'react';
import { BarChart3, Loader2, TrendingUp } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { useI18n } from '@/contexts/i18n-context';
import { glass } from '../helpers';
import { type AggregateResult, fetchMetricAggregate, singleAggregateValue } from './types';
import { grammarAccentClasses, spatialGrammar } from '@/app/workspace/lib/design';
import { SpringCounter } from './spring-counter';
import { TracePath } from './trace-path';

interface MetricsViewProps {
  isDark: boolean;
  workspaceId: string | null;
  agentId?: string | null;
}

export function MetricsView({ isDark, workspaceId, agentId }: MetricsViewProps) {
  const { t } = useI18n();
  void agentId;
  const [loading, setLoading] = useState(true);
  const [tasksDone, setTasksDone] = useState<AggregateResult | null>(null);
  const [latencyP95, setLatencyP95] = useState<AggregateResult | null>(null);
  const [acceptance, setAcceptance] = useState<AggregateResult | null>(null);
  const [skillsUsed, setSkillsUsed] = useState<AggregateResult | null>(null);
  const [taskTimeseries, setTaskTimeseries] = useState<AggregateResult | null>(null);
  const [dispatchTimeseries, setDispatchTimeseries] = useState<AggregateResult | null>(null);
  const [skillBars, setSkillBars] = useState<AggregateResult | null>(null);

  useEffect(() => {
    if (!workspaceId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void Promise.all([
      fetchMetricAggregate({
        namespace: 'task',
        name: 'completed',
        agg: 'count',
        range: '7d',
        workspaceId,
      }),
      fetchMetricAggregate({
        namespace: 'agent',
        name: 'dispatch',
        agg: 'p95',
        range: '24h',
        workspaceId,
      }),
      fetchMetricAggregate({
        namespace: 'task.acceptance',
        name: 'status_changed',
        agg: 'count',
        range: '7d',
        groupBy: ['status'],
        workspaceId,
      }),
      fetchMetricAggregate({
        namespace: 'skill',
        name: 'invoked',
        agg: 'count',
        range: '7d',
        groupBy: ['skillId'],
        workspaceId,
      }),
      fetchMetricAggregate({
        namespace: 'task',
        name: 'completed',
        agg: 'count',
        range: '7d',
        bucket: '1d',
        workspaceId,
      }),
      fetchMetricAggregate({
        namespace: 'agent',
        name: 'dispatch',
        agg: 'p95',
        range: '7d',
        bucket: '1d',
        workspaceId,
      }),
      fetchMetricAggregate({
        namespace: 'skill',
        name: 'invoked',
        agg: 'count',
        range: '7d',
        groupBy: ['skillId'],
        workspaceId,
      }),
    ]).then(([td, lt, acc, su, tts, dts, sb]) => {
      if (cancelled) return;
      setTasksDone(td);
      setLatencyP95(lt);
      setAcceptance(acc);
      setSkillsUsed(su);
      setTaskTimeseries(tts);
      setDispatchTimeseries(dts);
      setSkillBars(sb);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // ── Control-tower grammar (doc 13 §3.7 — widget grid) ──
  const grammar = spatialGrammar.controlTower;
  const accent = grammarAccentClasses[grammar.accentColor];

  if (!workspaceId) {
    return (
      <div
        data-spatial-grammar="controlTower"
        data-grammar-accent={grammar.accentColor}
        className={`rounded-2xl px-6 py-12 text-center ${glass(isDark, 'base')}`}
      >
        <BarChart3 className={`mx-auto mb-3 h-8 w-8 ${accent.text}`} />
        <p className={`text-sm font-medium ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
          {t('evolution.studio.metrics.pickWorkspaceTitle')}
        </p>
        <p className={`mt-1 text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
          {t('evolution.studio.metrics.pickWorkspaceBody')}
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div
        data-spatial-grammar="controlTower"
        data-grammar-accent={grammar.accentColor}
        className={`flex items-center justify-center rounded-2xl px-6 py-12 ${glass(isDark, 'base')}`}
      >
        <Loader2 className={`mr-2 h-4 w-4 animate-spin ${accent.text}`} />
        <span className={`text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>
          {t('evolution.studio.metrics.loading')}
        </span>
      </div>
    );
  }

  const tasksDoneVal = singleAggregateValue(tasksDone);
  const latencyVal = singleAggregateValue(latencyP95);
  const skillsUsedCount = countDistinctGroups(skillsUsed, 'skillId');
  const acceptanceRate = computeAcceptanceRate(acceptance);

  const hasAnyData =
    tasksDoneVal > 0 ||
    latencyVal > 0 ||
    skillsUsedCount > 0 ||
    acceptanceRate.total > 0 ||
    (taskTimeseries?.buckets ?? []).some((b) => b.groups.some((g) => (g.value ?? 0) > 0)) ||
    (skillBars?.buckets ?? []).some((b) => b.groups.some((g) => (g.value ?? 0) > 0));

  const dispatchHasData = (dispatchTimeseries?.buckets ?? []).some((b) => b.groups.some((g) => (g.value ?? 0) > 0));

  return (
    <div data-spatial-grammar="controlTower" data-grammar-accent={grammar.accentColor} className="space-y-4">
      <div className={`flex items-center justify-between gap-3 rounded-2xl border px-4 py-3 backdrop-blur-md ${accent.bg}`}>
        <div>
          <p className={`text-[10px] font-semibold uppercase tracking-wider ${accent.text}`}>
            {t('evolution.studio.metrics.controlTowerLabel')}
          </p>
          <p className={`mt-0.5 text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
            {t('evolution.studio.metrics.controlTowerHint')}
          </p>
        </div>
        <BarChart3 className={`h-4 w-4 ${accent.text}`} aria-hidden />
      </div>

      {!hasAnyData && <EmptyBanner isDark={isDark} message={t('evolution.studio.metrics.emptyBanner')} />}

      {/* 4 counters */}
      <div className={grammar.layout}>
        <CounterCard isDark={isDark} label={t('evolution.studio.metrics.tasksDone')} numericValue={tasksDoneVal} />
        <CounterCard
          isDark={isDark}
          label={t('evolution.studio.metrics.dispatchP95')}
          numericValue={latencyVal > 0 ? Math.round(latencyVal) : null}
          suffix=" ms"
        />
        <CounterCard
          isDark={isDark}
          label={t('evolution.studio.metrics.acceptance')}
          numericValue={
            acceptanceRate.total > 0 ? Math.round((acceptanceRate.passed / acceptanceRate.total) * 100) : null
          }
          suffix="%"
        />
        <CounterCard isDark={isDark} label={t('evolution.studio.metrics.skillsUsed')} numericValue={skillsUsedCount} />
      </div>

      {/* 2 timeseries */}
      <div className="grid gap-3 lg:grid-cols-2">
        <TimeseriesCard isDark={isDark} title={t('evolution.studio.metrics.tasksPerDay')} data={taskTimeseries} />
        <TimeseriesCard
          isDark={isDark}
          title={t('evolution.studio.metrics.dispatchPerDay')}
          data={dispatchTimeseries}
          banner={!dispatchHasData ? t('evolution.studio.metrics.dispatchBanner') : undefined}
        />
      </div>

      {/* 1 bar — top skills */}
      <BarCard isDark={isDark} title={t('evolution.studio.metrics.topSkills')} data={skillBars} />
    </div>
  );
}

// ─── widgets ────────────────────────────────────────────────────────

function CounterCard({
  isDark,
  label,
  numericValue,
  suffix,
}: {
  isDark: boolean;
  label: string;
  /** Null → render em-dash (no data). Otherwise spring-counter from 0 → value. */
  numericValue: number | null;
  suffix?: string;
}) {
  return (
    <div data-testid="metrics-counter" className={`rounded-2xl p-4 ${glass(isDark, 'base')}`}>
      <p className={`text-[10px] uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>{label}</p>
      <p className={`mt-1 text-2xl font-bold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
        {numericValue == null ? (
          <span data-testid="metrics-counter-empty">—</span>
        ) : (
          <SpringCounter value={numericValue} suffix={suffix} />
        )}
      </p>
    </div>
  );
}

function TimeseriesCard({
  isDark,
  title,
  data,
  banner,
}: {
  isDark: boolean;
  title: string;
  data: AggregateResult | null;
  banner?: string;
}) {
  const { t } = useI18n();
  const points = (data?.buckets ?? []).map((b) => {
    const total = b.groups.reduce((sum, g) => sum + (g.value ?? 0), 0);
    return { ts: b.ts ?? '', value: total };
  });
  const max = points.reduce((m, p) => Math.max(m, p.value), 0);
  return (
    <div data-testid="metrics-timeseries" className={`rounded-2xl p-4 ${glass(isDark, 'base')}`}>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <p className={`text-xs font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>{title}</p>
        <TrendingUp className={`h-3.5 w-3.5 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`} />
      </div>
      {banner && (
        <Badge variant="outline" className="mb-2 text-[10px]">
          {banner}
        </Badge>
      )}
      {points.length === 0 || max === 0 ? (
        <div
          data-testid="metrics-timeseries-empty"
          className={`flex h-20 flex-col items-center justify-center gap-1 rounded-xl border border-dashed text-center ${
            isDark ? 'border-white/[0.08] text-zinc-500' : 'border-zinc-300/70 text-zinc-400'
          }`}
        >
          <TrendingUp className="h-4 w-4 opacity-40" aria-hidden />
          <span className="text-[11px]">{t('evolution.common.noDataInRange')}</span>
        </div>
      ) : (
        <div className="relative h-20">
          <div className="absolute inset-0 flex items-end gap-1">
            {points.map((p, i) => {
              const h = max > 0 ? Math.max(2, Math.round((p.value / max) * 80)) : 2;
              return (
                <div
                  key={`${p.ts}-${i}`}
                  title={`${p.ts}: ${p.value}`}
                  className={`flex-1 rounded-sm ${isDark ? 'bg-violet-400/30' : 'bg-violet-500/30'}`}
                  style={{ height: `${h}px` }}
                />
              );
            })}
          </div>
          {/* V3 trace-draw sparkline overlay — outlines the series on top of the bars. */}
          <svg
            viewBox="0 0 100 80"
            preserveAspectRatio="none"
            className="pointer-events-none absolute inset-0 h-full w-full"
            aria-hidden
          >
            <TracePath
              d={buildSparklinePath(
                points.map((p) => p.value),
                max,
              )}
              stroke={isDark ? 'rgb(167 139 250)' : 'rgb(139 92 246)'}
              strokeWidth={1.5}
            />
          </svg>
        </div>
      )}
    </div>
  );
}

/** Build a polyline path "M x0,y0 L x1,y1 ..." normalised to a 100×80 viewBox. */
function buildSparklinePath(values: number[], max: number): string {
  if (values.length === 0 || max <= 0) return 'M0,80 L100,80';
  if (values.length === 1) {
    const y = 80 - Math.max(2, Math.round((values[0] / max) * 80));
    return `M0,${y} L100,${y}`;
  }
  const step = 100 / (values.length - 1);
  return values
    .map((v, i) => {
      const x = (i * step).toFixed(2);
      const y = (80 - Math.max(2, Math.round((v / max) * 80))).toFixed(2);
      return `${i === 0 ? 'M' : 'L'}${x},${y}`;
    })
    .join(' ');
}

function BarCard({ isDark, title, data }: { isDark: boolean; title: string; data: AggregateResult | null }) {
  const { t } = useI18n();
  const rows: Array<{ key: string; value: number }> = [];
  for (const bucket of data?.buckets ?? []) {
    for (const g of bucket.groups) {
      const key = g.groupKey?.skillId ?? '?';
      if (key == null) continue;
      const existing = rows.find((r) => r.key === key);
      if (existing) existing.value += g.value ?? 0;
      else rows.push({ key, value: g.value ?? 0 });
    }
  }
  rows.sort((a, b) => b.value - a.value);
  const top = rows.slice(0, 5);
  const max = top.reduce((m, r) => Math.max(m, r.value), 0);
  return (
    <div data-testid="metrics-bar" className={`rounded-2xl p-4 ${glass(isDark, 'base')}`}>
      <p className={`mb-2 text-xs font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>{title}</p>
      {top.length === 0 ? (
        <p className={`text-[11px] italic ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
          {t('evolution.studio.metrics.noSkillInvocations')}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {top.map((r) => (
            <li key={r.key} className="flex items-center gap-2 text-xs">
              <span
                className={`w-32 shrink-0 truncate font-mono text-[11px] ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}
              >
                {r.key}
              </span>
              <div className={`h-2 flex-1 overflow-hidden rounded-full ${isDark ? 'bg-white/[0.06]' : 'bg-zinc-100'}`}>
                <div
                  className={`h-full ${isDark ? 'bg-cyan-400/80' : 'bg-cyan-500/80'}`}
                  style={{ width: `${max > 0 ? Math.round((r.value / max) * 100) : 0}%` }}
                />
              </div>
              <span
                className={`w-10 shrink-0 text-right font-mono text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
              >
                {r.value}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EmptyBanner({ isDark, message }: { isDark: boolean; message: string }) {
  return (
    <div
      data-testid="metrics-empty-banner"
      className={`rounded-2xl px-4 py-3 text-xs ${
        isDark
          ? 'border border-amber-500/20 bg-amber-500/[0.06] text-amber-200'
          : 'border border-amber-200 bg-amber-50 text-amber-700'
      }`}
    >
      {message}
    </div>
  );
}

// ─── helpers ────────────────────────────────────────────────────────

function countDistinctGroups(result: AggregateResult | null, key: string): number {
  if (!result) return 0;
  const seen = new Set<string>();
  for (const b of result.buckets) {
    for (const g of b.groups) {
      const v = g.groupKey?.[key];
      if (v) seen.add(v);
    }
  }
  return seen.size;
}

function computeAcceptanceRate(result: AggregateResult | null): { passed: number; total: number } {
  if (!result) return { passed: 0, total: 0 };
  let passed = 0;
  let total = 0;
  for (const b of result.buckets) {
    for (const g of b.groups) {
      const v = g.value ?? 0;
      total += v;
      if (g.groupKey?.status === 'passed') passed += v;
    }
  }
  return { passed, total };
}
