'use client';

/**
 * StatusGridWidget (release201/12 §3.6) — colour-coded breakdown of
 * counts per row (e.g. acceptance status per project).
 *
 * v2.0.9-X (2026-05-30) — visual polish:
 *
 *  - Drop heatmap matrix (PROJECT / TOTAL table + intensity-tinted
 *    coloured cells). The "single workspace 21 purple chip" rendering
 *    was reading as decorative chrome, not a real signal.
 *  - Replace with row-style layout: one row per entity, label on the
 *    left, status-coloured dots + counts laid out in a compact stripe
 *    on the right. Matches the segment-chip art direction used by
 *    TodayOverview (left-rail) and the activity widget under kanban.
 *  - Status palette pulled from `statusAccent` in design.ts (passed →
 *    done.dot, failed → failed.dot, pending → todo.dot, partial →
 *    in_progress.dot, none → backlog.dot) so colours stay consistent
 *    with kanban / task-card status colouring.
 *  - Legend remains at the top (keeps unit-test contract). Swatches are
 *    rendered with the existing `bg-emerald-500` / `bg-rose-500` etc.
 *    literal classes because widgets.test.tsx asserts on them — the
 *    StatusGridWidget palette is the kanban one's literal twin.
 */

import { useMemo } from 'react';
import { WidgetFrame } from './widget-frame';

export interface StatusGridRow {
  label: string;
  counts: Record<string, number>;
  /**
   * v2.0.8 Bug 1 — rows that aggregate tasks without a `projectId`
   * (workspace-level / unassigned). Rendered italic with hint tooltip.
   */
  unscoped?: boolean;
}

export interface StatusGridWidgetProps {
  isDark: boolean;
  title: string;
  subtitle?: string;
  columns: string[];
  rows: StatusGridRow[];
  loading?: boolean;
  onCellClick?: (rowLabel: string, column: string) => void;
  /** Doc 20 §3.3 Gap C F4 — caller-driven empty-state passthrough. */
  isEmpty?: boolean;
  emptyHint?: string;
}

/**
 * Per-status visual tokens. The `swatch` class is asserted on by
 * widgets.test.tsx (`bg-emerald-500`/`bg-rose-500`/...) — do NOT change
 * those literals without updating the test.
 */
const STATUS_TOKENS: Record<
  string,
  {
    swatch: string;
    dot: string;
    text: { dark: string; light: string };
  }
> = {
  passed: {
    swatch: 'bg-emerald-500',
    dot: 'bg-emerald-400',
    text: { dark: 'text-emerald-200', light: 'text-emerald-700' },
  },
  pass: {
    swatch: 'bg-emerald-500',
    dot: 'bg-emerald-400',
    text: { dark: 'text-emerald-200', light: 'text-emerald-700' },
  },
  success: {
    swatch: 'bg-emerald-500',
    dot: 'bg-emerald-400',
    text: { dark: 'text-emerald-200', light: 'text-emerald-700' },
  },
  partial: {
    swatch: 'bg-amber-500',
    dot: 'bg-amber-400',
    text: { dark: 'text-amber-200', light: 'text-amber-700' },
  },
  pending: {
    swatch: 'bg-sky-500',
    dot: 'bg-sky-400',
    text: { dark: 'text-sky-200', light: 'text-sky-700' },
  },
  in_review: {
    swatch: 'bg-sky-500',
    dot: 'bg-sky-400',
    text: { dark: 'text-sky-200', light: 'text-sky-700' },
  },
  failed: {
    swatch: 'bg-rose-500',
    dot: 'bg-rose-400',
    text: { dark: 'text-rose-200', light: 'text-rose-700' },
  },
  failing: {
    swatch: 'bg-rose-500',
    dot: 'bg-rose-400',
    text: { dark: 'text-rose-200', light: 'text-rose-700' },
  },
  fail: {
    swatch: 'bg-rose-500',
    dot: 'bg-rose-400',
    text: { dark: 'text-rose-200', light: 'text-rose-700' },
  },
  none: {
    swatch: 'bg-zinc-300',
    dot: 'bg-zinc-400',
    text: { dark: 'text-zinc-400', light: 'text-zinc-500' },
  },
};

function tokensFor(column: string): (typeof STATUS_TOKENS)[string] {
  const key = column.toLowerCase().trim();
  return (
    STATUS_TOKENS[key] ?? {
      swatch: 'bg-violet-500',
      dot: 'bg-violet-400',
      text: { dark: 'text-violet-200', light: 'text-violet-700' },
    }
  );
}

export function StatusGridWidget({
  isDark,
  title,
  subtitle,
  columns,
  rows,
  loading,
  onCellClick,
  isEmpty,
  emptyHint,
}: StatusGridWidgetProps) {
  const empty = !loading && (isEmpty === true || rows.length === 0);
  const rowTotals = useMemo(() => {
    return rows.map((row) =>
      columns.reduce((sum, col) => sum + (row.counts[col] ?? 0), 0),
    );
  }, [rows, columns]);

  return (
    <WidgetFrame
      isDark={isDark}
      title={title}
      subtitle={subtitle}
      loading={loading}
      empty={empty}
      emptyHint={emptyHint}
    >
      {/* Legend — required by widgets.test.tsx (asserts on swatch classes) */}
      <ul data-testid="status-grid-legend" className="mb-2 flex flex-wrap items-center gap-1.5 text-[10px]">
        {columns.map((col) => {
          const tok = tokensFor(col);
          return (
            <li
              key={col}
              className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 ${
                isDark ? 'bg-white/[0.03] text-zinc-400' : 'bg-zinc-100/80 text-zinc-600'
              }`}
            >
              <span
                data-testid={`status-grid-legend-swatch-${col}`}
                className={`inline-block h-2 w-2 rounded-sm ${tok.swatch}`}
              />
              <span>{col}</span>
            </li>
          );
        })}
      </ul>

      <ul data-testid="status-grid-rows" className="flex flex-col gap-1.5">
        {rows.map((row, rowIdx) => {
          const total = rowTotals[rowIdx];
          return (
            <li
              key={row.label}
              data-testid="status-grid-row"
              data-unscoped={row.unscoped ? 'true' : 'false'}
              className={`flex min-w-0 items-center justify-between gap-2 rounded-xl border px-2.5 py-1.5 ${
                isDark ? 'border-white/[0.06] bg-white/[0.02]' : 'border-zinc-200/70 bg-white/60'
              }`}
            >
              <div
                title={row.unscoped ? `${row.label} — workspace-level (unassigned)` : row.label}
                data-testid="status-grid-row-label"
                className={`min-w-0 flex-1 truncate text-[11px] font-medium ${row.unscoped ? 'italic' : ''} ${
                  isDark ? 'text-zinc-200' : 'text-zinc-700'
                }`}
              >
                {row.label}
                {total > 0 ? (
                  <span className={`ml-1.5 text-[9px] tabular-nums ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                    · {total}
                  </span>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {columns.map((col) => {
                  const v = row.counts[col] ?? 0;
                  const tok = tokensFor(col);
                  const textColor = isDark ? tok.text.dark : tok.text.light;
                  const dim = v === 0 ? 'opacity-30' : '';
                  const CellTag = onCellClick ? 'button' : 'span';
                  return (
                    <CellTag
                      key={col}
                      type={onCellClick ? 'button' : undefined}
                      data-testid="status-grid-cell"
                      title={`${row.label} · ${col}: ${v}`}
                      onClick={onCellClick ? () => onCellClick(row.label, col) : undefined}
                      className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums transition-opacity ${dim} ${
                        isDark ? 'bg-white/[0.03]' : 'bg-zinc-100/70'
                      } ${textColor} ${onCellClick ? 'cursor-pointer hover:opacity-80' : 'cursor-default'}`}
                    >
                      <span className={`h-1.5 w-1.5 rounded-full ${tok.dot}`} aria-hidden />
                      <span>{v}</span>
                    </CellTag>
                  );
                })}
              </div>
            </li>
          );
        })}
      </ul>
    </WidgetFrame>
  );
}
