'use client';

/**
 * TimeseriesWidget (release201/12 §3.3) — area-fill chart.
 *
 * v2.0.9-X (2026-05-30) — visual polish to match TodayOverview /
 * activity widget art direction:
 *
 *  - Always render as gradient area fill (no separate line variant).
 *  - Strip recharts default chrome: no CartesianGrid dashed lines, no
 *    intermediate y-axis ticks (we expose `max` as a single corner
 *    annotation), no auto-rotated tick labels.
 *  - Gradient pulled from `accentGradients` — first series defaults to
 *    the violet→cyan→emerald family used by TodayOverview's progress
 *    bar so the visual identity carries.
 *  - Multi-series legend (when ≥2 series) kept; legend toggles series
 *    visibility, but legend styling now uses the same pill chip style
 *    as TodayOverview segment chips.
 *  - X-axis ticks show only first / mid / last sample to avoid the
 *    "Mon-Sun every day" wall of text on small cards.
 */

import { useId, useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
  Brush,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { WidgetFrame } from './widget-frame';
import type { InsightsRange } from '../../lib/insights-api';

export interface TimeseriesSeries {
  key: string;
  label: string;
  color?: string;
  buckets: Array<{ ts: string; value: number | null }>;
}

export interface TimeseriesWidgetProps {
  isDark: boolean;
  title: string;
  subtitle?: string;
  /** Single-series convenience. Ignored when `series` is provided. */
  buckets?: Array<{ ts: string; value: number | null }>;
  series?: TimeseriesSeries[];
  /**
   * @deprecated — `variant` is ignored; chart is always an area with
   * gradient fill. Kept for API compatibility with v2.0.9 callers.
   */
  variant?: 'line' | 'area';
  /** Drives smart x-axis tick formatting. */
  range?: InsightsRange | 'custom';
  enableBrush?: boolean;
  loading?: boolean;
  onDrillDown?: () => void;
  /** Doc 20 §3.3 Gap C F4 — caller-driven empty state. */
  isEmpty?: boolean;
  emptyHint?: string;
}

const DEFAULT_SERIES_COLORS = ['#a78bfa', '#22d3ee', '#f59e0b', '#34d399', '#f472b6', '#fb7185'];

/**
 * Pick how many ticks to render + how to format each one based on the
 * range. Doc 12 §A.3: "24h → hourly tick / 7d → daily / 30d → weekly".
 * (We additionally rely on minTickGap + interval to cap density.)
 */
function tickFormatterFor(range: TimeseriesWidgetProps['range']): (iso: string) => string {
  return (iso: string) => {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      if (range === '24h') {
        return `${String(d.getHours()).padStart(2, '0')}:00`;
      }
      return `${d.getMonth() + 1}/${d.getDate()}`;
    } catch {
      return iso;
    }
  };
}

interface MergedRow {
  ts: string;
  [seriesKey: string]: string | number;
}

/**
 * Merge multiple series (keyed by `ts`) into a single recharts-friendly row
 * shape: `[{ ts, seriesA: 12, seriesB: 8 }, ...]`. Missing values become 0.
 */
function mergeSeries(series: TimeseriesSeries[]): MergedRow[] {
  const tsSet = new Set<string>();
  for (const s of series) {
    for (const b of s.buckets) tsSet.add(b.ts);
  }
  const sortedTs = Array.from(tsSet).sort();
  return sortedTs.map((ts) => {
    const row: MergedRow = { ts };
    for (const s of series) {
      const bucket = s.buckets.find((b) => b.ts === ts);
      row[s.key] = bucket?.value ?? 0;
    }
    return row;
  });
}

export function TimeseriesWidget({
  isDark,
  title,
  subtitle,
  buckets,
  series,
  range,
  enableBrush,
  loading,
  onDrillDown,
  isEmpty,
  emptyHint,
}: TimeseriesWidgetProps) {
  // Build a normalised series array.
  const resolvedSeries = useMemo<TimeseriesSeries[]>(() => {
    if (series && series.length > 0) {
      return series.map((s, i) => ({
        ...s,
        color: s.color ?? DEFAULT_SERIES_COLORS[i % DEFAULT_SERIES_COLORS.length],
      }));
    }
    return [
      {
        key: 'value',
        label: 'value',
        color: isDark ? '#a78bfa' : '#6d28d9',
        buckets: buckets ?? [],
      },
    ];
  }, [series, buckets, isDark]);

  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const merged = useMemo(() => mergeSeries(resolvedSeries), [resolvedSeries]);

  const empty =
    !loading &&
    (isEmpty === true ||
      merged.every((row) =>
        resolvedSeries.every((s) => {
          const v = row[s.key];
          return typeof v === 'number' && v === 0;
        }),
      ));

  // Count non-zero points across all visible series. A timeseries with only
  // 1 non-zero point renders as a giant empty canvas with one floating dot
  // and a tooltip that looks like a UI bug. Degenerate to a stat card.
  const nonZeroCount = useMemo(() => {
    let n = 0;
    for (const row of merged) {
      for (const s of resolvedSeries) {
        const v = row[s.key];
        if (typeof v === 'number' && v !== 0) n += 1;
      }
    }
    return n;
  }, [merged, resolvedSeries]);

  const singlePointRow = useMemo(() => {
    if (nonZeroCount !== 1) return null;
    // Only collapse to a stat card when the series itself is genuinely sparse
    // (≤2 buckets) — that's the case that draws a "floating dot on empty
    // canvas". A bucketed window (24 hourly / N daily points) with a single
    // spike renders as a perfectly readable flat-line-with-a-spike area
    // chart, which is exactly the 「图」 the user expects, so keep the chart.
    if (merged.length > 2) return null;
    for (const row of merged) {
      for (const s of resolvedSeries) {
        const v = row[s.key];
        if (typeof v === 'number' && v !== 0) {
          return { ts: row.ts, value: v, seriesLabel: s.label };
        }
      }
    }
    return null;
  }, [merged, resolvedSeries, nonZeroCount]);

  const tickColor = isDark ? '#71717a' : '#a1a1aa';
  const tickFmt = tickFormatterFor(range);

  // Compute max across visible series for the corner annotation.
  const visibleSeries = resolvedSeries.filter((s) => !hidden[s.key]);
  const maxValue = useMemo(() => {
    let m = 0;
    for (const row of merged) {
      for (const s of visibleSeries) {
        const v = row[s.key];
        if (typeof v === 'number' && v > m) m = v;
      }
    }
    return m;
  }, [merged, visibleSeries]);

  // Unique stable gradient id per widget instance.
  const rawId = useId();
  const safeId = rawId.replace(/[^a-zA-Z0-9_-]/g, '');

  const isMulti = resolvedSeries.length > 1;

  const legend = isMulti ? (
    <Legend
      verticalAlign="bottom"
      height={20}
      content={() => (
        <ul data-testid="timeseries-legend" className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px]">
          {resolvedSeries.map((s) => {
            const muted = !!hidden[s.key];
            return (
              <li key={s.key}>
                <button
                  type="button"
                  data-testid={`timeseries-legend-item-${s.key}`}
                  aria-pressed={!muted}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    setHidden((prev) => ({ ...prev, [s.key]: !prev[s.key] }));
                  }}
                  className={`inline-flex items-center gap-1 rounded-xl border px-1.5 py-0.5 transition-opacity ${
                    muted ? 'opacity-40' : 'opacity-100'
                  } ${
                    isDark ? 'border-white/[0.06] text-zinc-300' : 'border-zinc-200/70 text-zinc-700'
                  }`}
                >
                  <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: s.color }} />
                  <span>{s.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    />
  ) : null;

  const tooltipStyle = {
    background: isDark ? 'rgba(24,24,27,0.96)' : 'rgba(255,255,255,0.98)',
    border: 'none',
    fontSize: 11,
    borderRadius: 6,
    boxShadow: '0 4px 14px rgba(0,0,0,0.12)',
  };

  // Show only first / mid / last x-ticks — recharts honours an explicit
  // `ticks` array. Avoids the "Mon-Sun" wall.
  const explicitTicks = useMemo(() => {
    if (merged.length === 0) return undefined;
    if (merged.length <= 2) return merged.map((m) => m.ts);
    return [merged[0].ts, merged[Math.floor(merged.length / 2)].ts, merged[merged.length - 1].ts];
  }, [merged]);

  return (
    <WidgetFrame
      isDark={isDark}
      title={title}
      subtitle={subtitle}
      loading={loading}
      empty={empty}
      emptyHint={emptyHint}
      onDrillDown={onDrillDown}
    >
      {/* Degenerate mode: a single non-zero point reads as a UI bug when
          rendered as an area chart (huge empty canvas, one floating dot,
          tooltip drifting over nothing). Collapse to a stat row instead. */}
      {singlePointRow && !empty ? (
        <div
          data-testid="timeseries-widget-single"
          className={`flex items-baseline justify-between gap-3 rounded-xl border px-3 py-2 ${
            isDark ? 'border-white/[0.05] bg-white/[0.02]' : 'border-zinc-200/80 bg-white'
          }`}
        >
          <span className={`text-xl font-bold tabular-nums ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
            {singlePointRow.value}
          </span>
          <span className={`text-[11px] tabular-nums ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
            {singlePointRow.seriesLabel ? `${singlePointRow.seriesLabel} · ` : ''}
            {tickFmt(singlePointRow.ts)}
          </span>
        </div>
      ) : (
      <div className={`relative w-full ${isMulti ? 'h-52' : 'h-44'}`} data-testid="timeseries-widget-chart">
        {/* Corner annotation — single-line "max N" so the user gets axis
            scale without 4 default ticks polluting the card. */}
        {maxValue > 0 ? (
          <p
            data-testid="timeseries-max-annotation"
            className={`pointer-events-none absolute right-1 top-0 z-10 text-[9px] tabular-nums ${
              isDark ? 'text-zinc-500' : 'text-zinc-400'
            }`}
          >
            max {maxValue}
          </p>
        ) : null}
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={merged} margin={{ top: 12, right: 8, bottom: 4, left: 0 }}>
            <defs>
              {visibleSeries.map((s, i) => (
                <linearGradient key={s.key} id={`ts-grad-${safeId}-${i}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={s.color} stopOpacity={0.42} />
                  <stop offset="100%" stopColor={s.color} stopOpacity={0} />
                </linearGradient>
              ))}
            </defs>
            <XAxis
              dataKey="ts"
              tick={{ fill: tickColor, fontSize: 10 }}
              tickFormatter={tickFmt}
              ticks={explicitTicks}
              axisLine={false}
              tickLine={false}
              interval="preserveStartEnd"
            />
            {/* YAxis hidden — `max` annotation supplies the scale. */}
            <YAxis hide domain={[0, 'auto']} allowDataOverflow={false} />
            <Tooltip cursor={{ stroke: tickColor, strokeDasharray: '2 4', strokeOpacity: 0.4 }} contentStyle={tooltipStyle} labelFormatter={tickFmt} />
            {legend}
            {visibleSeries.map((s, i) => (
              <Area
                key={s.key}
                dataKey={s.key}
                name={s.label}
                type="monotone"
                stroke={s.color}
                strokeWidth={2}
                fill={`url(#ts-grad-${safeId}-${i})`}
                fillOpacity={1}
                isAnimationActive={false}
                dot={merged.length <= 8 ? { r: 2, fill: s.color, stroke: 'none' } : false}
                activeDot={{ r: 3, fill: s.color }}
              />
            ))}
            {enableBrush ? (
              <Brush
                dataKey="ts"
                height={18}
                stroke={isDark ? '#52525b' : '#a1a1aa'}
                tickFormatter={tickFmt}
                travellerWidth={6}
              />
            ) : null}
          </AreaChart>
        </ResponsiveContainer>
      </div>
      )}
    </WidgetFrame>
  );
}
