'use client';

/**
 * CounterWidget (release201/12 §3.1) — single number + delta vs previous range.
 *
 * S38 (v2.0.9) — visual polish:
 *  - `direction` prop: `'higher-is-better' | 'lower-is-better' | 'neutral'`
 *    drives delta colour (emerald for "good", rose for "bad", zinc for
 *    neutral). Legacy `deltaIsBetter` still accepted for backwards compat.
 *  - Large-value compact formatting (1.2k / 1.5M) via `format='compact'` or
 *    automatic when value ≥ 1000 (configurable).
 *  - Hover tooltip exposes the full unformatted number + delta % + window.
 *  - Loading skeleton sized to match the rendered value width so layout
 *    doesn't jump on first paint.
 */

import { ArrowDown, ArrowUp } from 'lucide-react';
import { WidgetFrame } from './widget-frame';

export type CounterDirection = 'higher-is-better' | 'lower-is-better' | 'neutral';

export interface CounterWidgetProps {
  isDark: boolean;
  title: string;
  subtitle?: string;
  value: number;
  delta?: number | null;
  /**
   * Semantic direction of the metric — drives delta colour.
   *   - `'higher-is-better'`: positive delta is green, negative is red
   *   - `'lower-is-better'`: positive delta is red, negative is green
   *   - `'neutral'`: never colour-code (e.g. headcount, raw counts)
   *
   * Default falls back to legacy `deltaIsBetter`, then `'higher-is-better'`.
   */
  direction?: CounterDirection;
  /** @deprecated use `direction` instead. */
  deltaIsBetter?: 'higher' | 'lower';
  unit?: string;
  format?: 'integer' | 'ratio' | 'ms' | 'days' | 'compact';
  /** When true, integers ≥1000 are auto-rendered as `1.2k` / `1.5M`. */
  autoCompact?: boolean;
  /** Optional human-readable window label appended to the tooltip. */
  windowLabel?: string;
  loading?: boolean;
  onDrillDown?: () => void;
  /**
   * Doc 20 §3.3 Gap C F4 — caller-driven empty state passthrough. Lets the
   * caller distinguish "metric not ingested" (`isEmpty=true`) from "true 0".
   * When set, overrides the built-in `value == null || NaN` empty derivation.
   */
  isEmpty?: boolean;
  emptyHint?: string;
}

function resolveDirection(props: Pick<CounterWidgetProps, 'direction' | 'deltaIsBetter'>): CounterDirection {
  if (props.direction) return props.direction;
  if (props.deltaIsBetter === 'lower') return 'lower-is-better';
  if (props.deltaIsBetter === 'higher') return 'higher-is-better';
  return 'higher-is-better';
}

export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1).replace(/\.0$/, '')}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(Math.round(value));
}

function formatValue(value: number, format: CounterWidgetProps['format'], autoCompact: boolean): string {
  if (format === 'ratio') {
    if (!Number.isFinite(value)) return '—';
    return `${Math.round(value * 100)}%`;
  }
  if (format === 'ms') {
    if (!Number.isFinite(value) || value === 0) return '—';
    if (value < 1_000) return `${Math.round(value)}ms`;
    if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
    if (value < 3_600_000) return `${(value / 60_000).toFixed(1)}m`;
    return `${(value / 3_600_000).toFixed(1)}h`;
  }
  if (format === 'days') {
    return `${Math.round(value)}d`;
  }
  if (format === 'compact') {
    return formatCompact(value);
  }
  if (autoCompact && Number.isFinite(value) && Math.abs(value) >= 1_000) {
    return formatCompact(value);
  }
  return value.toLocaleString();
}

function formatDeltaPercent(value: number, delta: number, format: CounterWidgetProps['format']): string | null {
  if (!Number.isFinite(value) || value === 0) return null;
  if (format === 'ratio') {
    // ratio is already a percentage-style metric — delta is absolute points
    return `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)}pp`;
  }
  const base = value - delta;
  if (!Number.isFinite(base) || base === 0) return null;
  const pct = (delta / Math.abs(base)) * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

export function CounterWidget({
  isDark,
  title,
  subtitle,
  value,
  delta,
  direction,
  deltaIsBetter,
  unit,
  format = 'integer',
  autoCompact = true,
  windowLabel,
  loading,
  onDrillDown,
  isEmpty,
  emptyHint,
}: CounterWidgetProps) {
  const empty = !loading && (isEmpty === true || value == null || Number.isNaN(value));
  const formatted = formatValue(value, format, autoCompact);
  const resolvedDirection = resolveDirection({ direction, deltaIsBetter });

  const deltaColor = (() => {
    if (delta == null || delta === 0) return isDark ? 'text-zinc-500' : 'text-zinc-500';
    if (resolvedDirection === 'neutral') return isDark ? 'text-zinc-400' : 'text-zinc-500';
    const isUp = delta > 0;
    const better = resolvedDirection === 'higher-is-better' ? isUp : !isUp;
    if (better) return isDark ? 'text-emerald-400' : 'text-emerald-600';
    return isDark ? 'text-rose-400' : 'text-rose-600';
  })();

  // Tooltip: full unformatted number + delta % + window. Native `title` so we
  // don't pull in another popover dep. WidgetFrame body inherits via the
  // wrapper div below.
  const tooltipLines: string[] = [];
  if (Number.isFinite(value)) {
    tooltipLines.push(`Current: ${value.toLocaleString()}${unit ? ` ${unit}` : ''}`);
  }
  if (delta != null) {
    const pct = formatDeltaPercent(value, delta, format);
    tooltipLines.push(`Delta vs prev: ${delta >= 0 ? '+' : ''}${delta.toLocaleString()}${pct ? ` (${pct})` : ''}`);
  }
  if (windowLabel) tooltipLines.push(windowLabel);
  const tooltip = tooltipLines.length ? tooltipLines.join('\n') : undefined;

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
      <div className="flex min-w-0 items-baseline gap-2" title={tooltip} data-testid="counter-widget-body">
        <span
          data-testid="counter-widget-value"
          data-direction={resolvedDirection}
          className={`truncate text-3xl font-bold tabular-nums ${isDark ? 'text-zinc-100' : 'text-zinc-950'}`}
        >
          {formatted}
        </span>
        {unit ? <span className={`text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>{unit}</span> : null}
      </div>
      {delta != null ? (
        <div
          data-testid="counter-widget-delta"
          data-delta-direction={resolvedDirection}
          className={`mt-2 flex items-center gap-1 text-xs ${deltaColor}`}
        >
          {delta > 0 ? <ArrowUp className="h-3.5 w-3.5" /> : delta < 0 ? <ArrowDown className="h-3.5 w-3.5" /> : null}
          <span>
            {delta > 0 ? '+' : ''}
            {format === 'ratio' ? `${Math.round(delta * 100)}%` : delta.toLocaleString()} vs prev
          </span>
        </div>
      ) : null}
    </WidgetFrame>
  );
}
