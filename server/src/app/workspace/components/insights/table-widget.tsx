'use client';

/**
 * TableWidget (release201/12 §3.5) — rows of (id, cells). Each row is
 * clickable for drill-down (task drawer / agent profile / etc).
 *
 * S38 (v2.0.9) — visual polish:
 *  - Click-to-sort by any column (asc → desc → unsorted). Numeric values
 *    sort numerically; string values use locale-aware compare.
 *  - Sticky header so long row lists keep the header visible while
 *    scrolling inside the widget body.
 *  - Numeric cells right-aligned, text cells left-aligned (auto-detected
 *    from the first non-null value of the column).
 *  - Long text gets a `title` tooltip so users can hover to reveal the
 *    full value before drilling down.
 *  - Empty state ("No data") with a Database icon via WidgetFrame.
 */

import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { WidgetFrame } from './widget-frame';

export interface TableRowDTO {
  id: string;
  cells: Array<{ key: string; value: string | number | null }>;
}

export interface TableWidgetProps {
  isDark: boolean;
  title: string;
  subtitle?: string;
  columns: string[];
  rows: TableRowDTO[];
  loading?: boolean;
  onRowClick?: (rowId: string) => void;
  /** Cap the visible rows + add inner scroll. Default 10. */
  maxVisibleRows?: number;
}

type SortDir = 'asc' | 'desc' | null;

interface SortState {
  columnIndex: number;
  dir: SortDir;
}

function compareCellValues(a: string | number | null, b: string | number | null): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  const aNum = typeof a === 'number' ? a : Number(a);
  const bNum = typeof b === 'number' ? b : Number(b);
  if (Number.isFinite(aNum) && Number.isFinite(bNum)) return aNum - bNum;
  return String(a).localeCompare(String(b));
}

function isNumericColumn(rows: TableRowDTO[], columnIndex: number): boolean {
  for (const row of rows) {
    const cell = row.cells[columnIndex];
    if (!cell) continue;
    const v = cell.value;
    if (v == null) continue;
    if (typeof v === 'number') return true;
    return false;
  }
  return false;
}

export function TableWidget({
  isDark,
  title,
  subtitle,
  columns,
  rows,
  loading,
  onRowClick,
  maxVisibleRows = 10,
}: TableWidgetProps) {
  const empty = !loading && rows.length === 0;
  const [sort, setSort] = useState<SortState>({ columnIndex: -1, dir: null });

  const numericColumns = useMemo(() => columns.map((_, idx) => isNumericColumn(rows, idx)), [columns, rows]);

  const sortedRows = useMemo(() => {
    if (sort.dir == null || sort.columnIndex < 0) return rows;
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = a.cells[sort.columnIndex]?.value ?? null;
      const bv = b.cells[sort.columnIndex]?.value ?? null;
      const cmp = compareCellValues(av, bv);
      return sort.dir === 'asc' ? cmp : -cmp;
    });
    return copy;
  }, [rows, sort]);

  const onHeaderClick = (idx: number) => {
    setSort((prev) => {
      if (prev.columnIndex !== idx) return { columnIndex: idx, dir: 'asc' };
      if (prev.dir === 'asc') return { columnIndex: idx, dir: 'desc' };
      if (prev.dir === 'desc') return { columnIndex: -1, dir: null };
      return { columnIndex: idx, dir: 'asc' };
    });
  };

  // Outer scroll on row overflow.
  const maxHeight = maxVisibleRows * 28 + 32; // ~28px per row + header

  return (
    <WidgetFrame isDark={isDark} title={title} subtitle={subtitle} loading={loading} empty={empty} emptyHint="No data">
      <div className="overflow-auto" style={{ maxHeight }} data-testid="table-widget-scroll">
        <table className="min-w-full text-left text-xs">
          <thead
            className={`sticky top-0 z-10 ${isDark ? 'bg-zinc-950/95 text-zinc-500' : 'bg-white/95 text-zinc-500'}`}
          >
            <tr>
              {columns.map((col, idx) => {
                const isActive = sort.columnIndex === idx && sort.dir != null;
                const dir: SortDir = isActive ? sort.dir : null;
                const numeric = numericColumns[idx];
                return (
                  <th
                    key={col}
                    scope="col"
                    data-testid={`table-widget-header-${col}`}
                    aria-sort={isActive ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                    className={`border-b border-transparent px-2 py-1 font-medium uppercase tracking-wider ${
                      numeric ? 'text-right' : 'text-left'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => onHeaderClick(idx)}
                      className={`inline-flex items-center gap-1 ${
                        numeric ? 'flex-row-reverse' : ''
                      } ${isDark ? 'hover:text-zinc-300' : 'hover:text-zinc-800'}`}
                    >
                      <span>{col}</span>
                      {dir === 'asc' ? (
                        <ArrowUp className="h-3 w-3" />
                      ) : dir === 'desc' ? (
                        <ArrowDown className="h-3 w-3" />
                      ) : (
                        <ArrowUpDown className="h-3 w-3 opacity-40" />
                      )}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row) => (
              <tr
                key={row.id}
                data-testid="table-widget-row"
                onClick={() => onRowClick?.(row.id)}
                className={`group ${onRowClick ? 'cursor-pointer' : ''} ${
                  isDark ? 'hover:bg-white/[0.04]' : 'hover:bg-zinc-50'
                }`}
              >
                {row.cells.map((cell, idx) => {
                  const numeric = numericColumns[idx];
                  const display = cell.value == null ? '—' : String(cell.value);
                  return (
                    <td
                      key={cell.key}
                      title={display.length > 18 ? display : undefined}
                      className={`max-w-[160px] truncate px-2 py-1 ${
                        numeric ? 'text-right tabular-nums' : 'text-left'
                      } ${isDark ? 'text-zinc-200' : 'text-zinc-700'}`}
                    >
                      {display}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </WidgetFrame>
  );
}
