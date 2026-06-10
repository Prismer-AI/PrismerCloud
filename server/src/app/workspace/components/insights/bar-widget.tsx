'use client';

/**
 * BarWidget (release201/12 §3.4) — horizontal ranking.
 *
 * v2.0.9-X (2026-05-30) visual polish — aligns with `TodayOverview`
 * (left-rail) + activity widgets art direction:
 *
 *  - No recharts default chrome (no dashed grid, no y-axis ticks, no
 *    auto-tick formatter, no SVG ResponsiveContainer plumbing).
 *  - Pure div + gradient-fill horizontal bars, each row a `rounded-xl`
 *    pill carrying: dot · label · width-encoded fill · trailing count.
 *  - When `items.length <= 1`, render a single-line compact text instead
 *    of a chart (avoids "one giant green bar across the entire card" for
 *    workspaces with only "general" capability used).
 *  - Rank-aware accent: 0 → emerald, 1 → cyan, 2 → violet, 3+ → ghost.
 *    Palette pulled from `accentGradients` in design.ts so the visual
 *    family matches TodayOverview's `from-violet-500 via-cyan-400
 *    to-emerald-400`.
 */

import { useMemo } from 'react';
import { accentGradients } from '../../lib/design';
import { WidgetFrame } from './widget-frame';

export interface BarWidgetProps {
  isDark: boolean;
  title: string;
  subtitle?: string;
  items: Array<{ label: string; value: number }>;
  loading?: boolean;
  onBarClick?: (label: string) => void;
}

type RankAccent = 'emerald' | 'cyan' | 'violet' | 'ghost';

const RANK_TO_ACCENT: RankAccent[] = ['emerald', 'cyan', 'violet', 'ghost'];

function accentClassesFor(rank: number, isDark: boolean): {
  dot: string;
  gradient: string;
  text: string;
} {
  const accent = RANK_TO_ACCENT[Math.min(rank, RANK_TO_ACCENT.length - 1)];
  // gradient string from design.ts (returns e.g. 'from-emerald-400/30 via-teal-400/20 to-cyan-500/30')
  const gradient = `bg-gradient-to-r ${accentGradients[accent]}`;
  if (accent === 'emerald') {
    return { dot: 'bg-emerald-400', text: isDark ? 'text-emerald-200' : 'text-emerald-700', gradient };
  }
  if (accent === 'cyan') {
    return { dot: 'bg-cyan-400', text: isDark ? 'text-cyan-200' : 'text-cyan-700', gradient };
  }
  if (accent === 'violet') {
    return { dot: 'bg-violet-400', text: isDark ? 'text-violet-200' : 'text-violet-700', gradient };
  }
  return { dot: 'bg-zinc-400', text: isDark ? 'text-zinc-300' : 'text-zinc-600', gradient };
}

export function BarWidget({ isDark, title, subtitle, items, loading, onBarClick }: BarWidgetProps) {
  const data = useMemo(() => items.map((it) => ({ label: it.label || '(none)', value: it.value })), [items]);
  const empty = !loading && data.length === 0;
  const max = useMemo(() => data.reduce((m, d) => (d.value > m ? d.value : m), 0), [data]);

  // ── Single-capability collapse — doc 28 §X1 + brief 2026-05-30 ──
  // When only one item is present, a "single giant bar" reads as garish.
  // Substitute a compact text representation that fits the card height.
  if (!loading && data.length === 1) {
    const only = data[0];
    return (
      <WidgetFrame isDark={isDark} title={title} subtitle={subtitle} loading={loading} empty={false}>
        <div
          data-testid="bar-widget-single"
          className={`flex items-center justify-between gap-2 rounded-xl border px-3 py-2 ${
            isDark ? 'border-white/[0.06] bg-white/[0.025]' : 'border-zinc-200/70 bg-white/60'
          }`}
        >
          <div className="flex min-w-0 items-center gap-2">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" aria-hidden />
            <span className={`truncate text-xs font-medium ${isDark ? 'text-zinc-200' : 'text-zinc-700'}`}>
              {only.label}
            </span>
          </div>
          <span className={`shrink-0 text-xs font-semibold tabular-nums ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
            {only.value}
          </span>
        </div>
      </WidgetFrame>
    );
  }

  return (
    <WidgetFrame isDark={isDark} title={title} subtitle={subtitle} loading={loading} empty={empty}>
      <ul
        data-testid="bar-widget-list"
        className="flex flex-col gap-1.5"
      >
        {data.map((d, idx) => {
          const accent = accentClassesFor(idx, isDark);
          const widthPct = max > 0 ? Math.max(4, Math.round((d.value / max) * 100)) : 0;
          const isEmpty = !Number.isFinite(d.value) || d.value === 0;
          const RowTag = onBarClick ? 'button' : 'div';
          return (
            <li key={`${d.label}-${idx}`}>
              <RowTag
                type={onBarClick ? 'button' : undefined}
                onClick={onBarClick ? () => onBarClick(d.label) : undefined}
                data-testid="bar-widget-cell"
                data-rank={idx}
                data-empty={isEmpty ? 'true' : undefined}
                className={`relative w-full overflow-hidden rounded-xl border px-2.5 py-1.5 text-left transition-colors ${
                  isDark ? 'border-white/[0.06] bg-white/[0.02]' : 'border-zinc-200/70 bg-white/60'
                } ${onBarClick ? 'cursor-pointer hover:bg-white/[0.04]' : ''}`}
              >
                {/* Gradient width-encoded bar fill behind the label */}
                <span
                  aria-hidden
                  className={`absolute inset-y-0 left-0 ${isEmpty ? '' : accent.gradient}`}
                  style={{ width: `${widthPct}%` }}
                />
                <span className="relative flex min-w-0 items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${accent.dot}`} aria-hidden />
                    <span
                      className={`truncate text-[11px] font-medium ${
                        isDark ? 'text-zinc-200' : 'text-zinc-700'
                      }`}
                    >
                      {d.label}
                    </span>
                  </span>
                  <span
                    className={`shrink-0 text-[11px] font-semibold tabular-nums ${accent.text}`}
                  >
                    {d.value}
                  </span>
                </span>
              </RowTag>
            </li>
          );
        })}
      </ul>
    </WidgetFrame>
  );
}
