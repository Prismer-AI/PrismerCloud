'use client';

/**
 * WidgetFrame — uniform widget chrome (release201/12 §8.2).
 *
 * Provides padding / header / loading skeleton / empty-state shell so each
 * concrete widget renders within the same visual box, independent of chart
 * library used inside.
 */

import type { ReactNode } from 'react';

export interface WidgetFrameProps {
  isDark: boolean;
  title: string;
  subtitle?: string;
  loading?: boolean;
  empty?: boolean;
  emptyHint?: string;
  /**
   * Drill-down handler — fired when the user clicks the widget body. When
   * unset the widget body is not interactive.
   */
  onDrillDown?: () => void;
  /** Optional trailing slot in the header (range chip, badge, etc). */
  trailing?: ReactNode;
  children?: ReactNode;
  className?: string;
}

export function WidgetFrame({
  isDark,
  title,
  subtitle,
  loading,
  empty,
  emptyHint,
  onDrillDown,
  trailing,
  children,
  className = '',
}: WidgetFrameProps) {
  const interactive = !!onDrillDown && !loading;
  const Tag = interactive ? 'button' : 'div';

  return (
    <Tag
      type={interactive ? 'button' : undefined}
      onClick={interactive ? onDrillDown : undefined}
      data-testid="insights-widget"
      data-empty={empty ? 'true' : undefined}
      data-loading={loading ? 'true' : undefined}
      className={`flex min-w-0 flex-col rounded-2xl border p-4 text-left transition-colors ${
        isDark
          ? 'border-white/[0.06] bg-zinc-950/40 hover:bg-zinc-900/40'
          : 'border-zinc-200/80 bg-white/80 hover:bg-white'
      } ${interactive ? 'cursor-pointer hover:shadow-sm' : ''} ${className}`}
    >
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3
            className={`truncate text-xs font-bold uppercase tracking-wider ${
              isDark ? 'text-zinc-400' : 'text-zinc-600'
            }`}
          >
            {title}
          </h3>
          {subtitle ? (
            <p className={`mt-0.5 truncate text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>{subtitle}</p>
          ) : null}
        </div>
        {trailing ? <div className="shrink-0">{trailing}</div> : null}
      </div>
      <div className="min-w-0 flex-1">
        {loading ? (
          <div
            className={`h-20 animate-pulse rounded-xl ${isDark ? 'bg-white/[0.04]' : 'bg-zinc-100'}`}
            aria-busy="true"
          />
        ) : empty ? (
          <p
            className={`rounded-xl border border-dashed px-3 py-2 text-xs ${
              isDark ? 'border-white/[0.06] text-zinc-500' : 'border-zinc-200 text-zinc-500'
            }`}
          >
            {emptyHint ?? 'No data yet.'}
          </p>
        ) : (
          children
        )}
      </div>
    </Tag>
  );
}
