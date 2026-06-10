'use client';

/**
 * SparklineWidget (release201/12 §3.2) — inline mini chart + current value.
 * Built with recharts <AreaChart> sized to the widget body.
 *
 * S38 (v2.0.9) — visual polish:
 *  - Area gradient fill underneath the line so the visual weight matches
 *    the timeseries widget.
 *  - Hover tooltip surfaces `ts` (localised) + `value`.
 *  - max + min markers (max=rose, min=sky) rendered as coloured dots on
 *    the line so eye scanning the row of cards highlights the extremes.
 */

import { useId, useMemo } from 'react';
import { Area, AreaChart, ResponsiveContainer, Tooltip } from 'recharts';
import { WidgetFrame } from './widget-frame';

export interface SparklineWidgetProps {
  isDark: boolean;
  title: string;
  subtitle?: string;
  buckets: Array<{ ts: string; value: number | null }>;
  summaryLabel?: string;
  loading?: boolean;
  onDrillDown?: () => void;
  /** Caller-supplied empty-state text. Falls back to WidgetFrame's default. */
  emptyHint?: string;
}

interface PointData {
  ts: string;
  v: number;
  isMax?: boolean;
  isMin?: boolean;
}

export function SparklineWidget({
  isDark,
  title,
  subtitle,
  buckets,
  summaryLabel,
  loading,
  onDrillDown,
  emptyHint,
}: SparklineWidgetProps) {
  const data = useMemo<PointData[]>(() => buckets.map((b) => ({ ts: b.ts, v: b.value ?? 0 })), [buckets]);
  const empty = !loading && data.every((d) => d.v === 0);
  const stroke = isDark ? '#a78bfa' : '#6d28d9';
  // React 18+ stable id keeps the gradient stable across renders and unique
  // across multiple sparklines on the same page (Math.random would also work
  // but trips the purity lint).
  const rawId = useId();
  const gradientId = `sparkline-grad-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;

  // Compute max/min indices once so the dot renderer is cheap.
  const { maxIdx, minIdx } = useMemo(() => {
    if (data.length === 0) return { maxIdx: -1, minIdx: -1 };
    let maxI = 0;
    let minI = 0;
    for (let i = 1; i < data.length; i++) {
      if (data[i].v > data[maxI].v) maxI = i;
      if (data[i].v < data[minI].v) minI = i;
    }
    return { maxIdx: maxI, minIdx: minI };
  }, [data]);

  // Recharts dot renderer — type-erased via a small wrapper because recharts'
  // exported `DotProps` doesn't include the `index` field that the dot
  // callback actually receives at runtime (it's there but typed under the
  // private `DotItemDotProps` shape).
  const renderDot = (props: { cx?: number; cy?: number; index?: number; key?: string | number }) => {
    const { cx, cy, index, key } = props;
    if (cx == null || cy == null || index == null) return <g key={key} />;
    if (index === maxIdx && maxIdx !== minIdx) {
      return (
        <circle
          key={key ?? `max-${index}`}
          data-testid="sparkline-marker-max"
          cx={cx}
          cy={cy}
          r={3}
          fill="#f43f5e"
          stroke="none"
        />
      );
    }
    if (index === minIdx && maxIdx !== minIdx) {
      return (
        <circle
          key={key ?? `min-${index}`}
          data-testid="sparkline-marker-min"
          cx={cx}
          cy={cy}
          r={3}
          fill="#0ea5e9"
          stroke="none"
        />
      );
    }
    return <g key={key ?? `dot-${index}`} />;
  };

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
      {summaryLabel ? (
        <p
          data-testid="sparkline-widget-summary"
          className={`mb-1 text-sm font-semibold tabular-nums ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}
        >
          {summaryLabel}
        </p>
      ) : null}
      <div className="h-12 w-full" data-testid="sparkline-widget-chart">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={stroke} stopOpacity={0.32} />
                <stop offset="100%" stopColor={stroke} stopOpacity={0} />
              </linearGradient>
            </defs>
            <Tooltip
              cursor={false}
              contentStyle={{
                background: isDark ? 'rgba(24,24,27,0.92)' : 'rgba(255,255,255,0.96)',
                border: 'none',
                fontSize: 11,
                padding: '4px 8px',
                borderRadius: 6,
                boxShadow: '0 4px 14px rgba(0,0,0,0.12)',
              }}
              labelFormatter={(_label, payload) => {
                const ts = payload?.[0]?.payload?.ts as string | undefined;
                if (!ts) return '';
                try {
                  return new Date(ts).toLocaleString();
                } catch {
                  return ts;
                }
              }}
              formatter={(v) => [String(v), 'value']}
            />
            <Area
              dataKey="v"
              type="monotone"
              stroke={stroke}
              strokeWidth={2}
              fill={`url(#${gradientId})`}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              dot={renderDot as any}
              activeDot={{ r: 3, fill: stroke }}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </WidgetFrame>
  );
}
