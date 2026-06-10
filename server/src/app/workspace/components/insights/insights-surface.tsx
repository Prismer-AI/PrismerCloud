'use client';

/**
 * InsightsSurface — top-level shell for /workspace/insights
 * (release201/12 §8.1).
 *
 * Owns:
 *  - view tabs (Overview / Project / Agent)
 *  - range picker (24h / 7d / 30d / 90d / Custom)
 *  - Refresh button (cache-bypass via `refreshNonce`)
 *  - "Last updated X min ago" relative timestamp
 *  - keyboard shortcuts (1/2/3/4 ranges, R refresh, ? help)
 *  - inner view rendering
 *
 * Drill-down navigation lives inside each view (router.push from widget
 * onClick handlers).
 *
 * S38 (v2.0.9) — range picker UX:
 *  - Dropdown → segmented button group with 4 presets + Custom (1-click
 *    switching, no second tap to dismiss).
 *  - Custom range opens a small popover with start / end `<input type='date'>`
 *    fields.
 *  - URL ?range= already syncs via parent; when range='custom', parent also
 *    syncs ?from= + ?to=.
 *  - Keyboard shortcuts: 1/2/3/4 cycle presets, R refresh, ? shows the help
 *    modal. Shortcuts are disabled while focused on inputs / textareas.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard, RefreshCw, X } from 'lucide-react';

import { useI18n } from '@/contexts/i18n-context';
import type { TranslationKey } from '@/lib/i18n';
import { SurfaceHeader } from '../surface-header';
import { OverviewView } from './overview-view';
import { ProjectView } from './project-view';
import { AgentView } from './agent-view';
import type { InsightsRange } from '../../lib/insights-api';

type Translator = (key: TranslationKey, values?: Record<string, string | number>) => string;

export type InsightsView = 'overview' | 'project' | 'agent';

export interface InsightsCustomRange {
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
}

export interface InsightsSurfaceProps {
  isDark: boolean;
  workspaceId: string | null;
  view: InsightsView;
  range: InsightsRange;
  projectId: string | null;
  agentId: string | null;
  refreshNonce: number;
  onChangeView: (view: InsightsView) => void;
  onChangeRange: (range: InsightsRange) => void;
  onRefresh: () => void;
  /**
   * v2.1 (2026-05-30) — Project view's built-in picker lifts the chosen
   * project id up here so `page.tsx`'s `syncInsightsUrl` keeps the URL +
   * deep-link state in sync. Optional so legacy mounts (mobile shell, older
   * routes) that don't wire it still type-check.
   */
  onChangeProject?: (projectId: string | null) => void;
  /**
   * v2.1 (2026-05-30) — Agent view's built-in picker lifts the chosen
   * agent id up here so `page.tsx`'s `syncInsightsUrl` keeps the URL +
   * deep-link state in sync. Optional so legacy mounts that don't wire
   * it still type-check.
   */
  onChangeAgent?: (agentId: string | null) => void;
  /** Optional custom range. When set, picker shows "Custom" as active. */
  customRange?: InsightsCustomRange | null;
  /** Called when user picks / clears a custom range. */
  onChangeCustomRange?: (next: InsightsCustomRange | null) => void;
  /** Wallclock of the last successful data fetch — drives "Last updated X min ago". */
  lastUpdated?: Date | null;
  mobile?: boolean;
}

const RANGES: InsightsRange[] = ['24h', '7d', '30d', '90d'];

/** Number-key shortcut → preset mapping. */
const SHORTCUT_TO_RANGE: Record<string, InsightsRange> = {
  '1': '24h',
  '2': '7d',
  '3': '30d',
  '4': '90d',
};

function formatRelativeTime(date: Date | null | undefined, t: Translator): string | null {
  if (!date) return null;
  const diffMs = Date.now() - date.getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 5) return t('workspace.insights.lastUpdated.justNow');
  if (sec < 60) return t('workspace.insights.lastUpdated.secAgo', { count: sec });
  const min = Math.floor(sec / 60);
  if (min < 60) return t('workspace.insights.lastUpdated.minAgo', { count: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t('workspace.insights.lastUpdated.hourAgo', { count: hr });
  const day = Math.floor(hr / 24);
  return t('workspace.insights.lastUpdated.dayAgo', { count: day });
}

function todayISO(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function daysAgoISO(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function InsightsSurface({
  isDark,
  workspaceId,
  view,
  range,
  projectId,
  agentId,
  refreshNonce,
  onChangeView,
  onChangeRange,
  onRefresh,
  onChangeProject,
  onChangeAgent,
  customRange,
  onChangeCustomRange,
  lastUpdated,
  mobile,
}: InsightsSurfaceProps) {
  const { t } = useI18n();
  const [showShortcutHelp, setShowShortcutHelp] = useState(false);
  const [showCustomPopover, setShowCustomPopover] = useState(false);
  const isCustom = !!customRange;

  // Tick once a minute so "Last updated X min ago" stays fresh.
  const [, setNowTick] = useState(0);
  useEffect(() => {
    if (!lastUpdated) return undefined;
    const id = window.setInterval(() => setNowTick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, [lastUpdated]);

  // Keyboard shortcuts.
  useEffect(() => {
    const isEditableTarget = (el: EventTarget | null) => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (el.isContentEditable) return true;
      return false;
    };
    const handler = (ev: KeyboardEvent) => {
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (isEditableTarget(ev.target)) return;
      // ? shortcut
      if (ev.key === '?' || (ev.key === '/' && ev.shiftKey)) {
        ev.preventDefault();
        setShowShortcutHelp((v) => !v);
        return;
      }
      if (ev.key === 'Escape' && showShortcutHelp) {
        ev.preventDefault();
        setShowShortcutHelp(false);
        return;
      }
      if (ev.key === 'r' || ev.key === 'R') {
        ev.preventDefault();
        onRefresh();
        return;
      }
      const r = SHORTCUT_TO_RANGE[ev.key];
      if (r) {
        ev.preventDefault();
        if (isCustom) onChangeCustomRange?.(null);
        onChangeRange(r);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onChangeRange, onRefresh, onChangeCustomRange, isCustom, showShortcutHelp]);

  const handlePresetClick = useCallback(
    (next: InsightsRange) => {
      if (isCustom) onChangeCustomRange?.(null);
      onChangeRange(next);
    },
    [isCustom, onChangeCustomRange, onChangeRange],
  );

  const relative = formatRelativeTime(lastUpdated, t);

  return (
    <section
      data-testid="insights-surface"
      className={`flex min-h-0 flex-1 flex-col overflow-hidden border rounded-2xl ${
        isDark ? 'border-white/[0.06] bg-zinc-950/30' : 'border-zinc-200/80 bg-white/78'
      }`}
    >
      <SurfaceHeader
        isDark={isDark}
        title={t('workspace.insights.title')}
        subtitle={
          view === 'overview'
            ? t('workspace.insights.subtitle.overview')
            : view === 'project'
              ? t('workspace.insights.subtitle.project')
              : t('workspace.insights.subtitle.agent')
        }
        actions={
          <div className="flex items-center gap-2">
            <ViewTabs isDark={isDark} value={view} onChange={onChangeView} t={t} />
            <RangePicker
              isDark={isDark}
              value={range}
              isCustom={isCustom}
              customRange={customRange ?? null}
              onChange={handlePresetClick}
              onOpenCustom={() => setShowCustomPopover(true)}
              onClearCustom={() => {
                onChangeCustomRange?.(null);
              }}
              t={t}
            />
            {relative ? (
              <span
                data-testid="insights-last-updated"
                title={lastUpdated?.toLocaleString()}
                className={`hidden text-[10px] tabular-nums md:inline ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
              >
                {t('workspace.insights.updatedRelative', { relative })}
              </span>
            ) : null}
            <button
              type="button"
              onClick={onRefresh}
              data-testid="insights-refresh"
              title={t('workspace.insights.refreshHint')}
              aria-label={t('workspace.insights.refresh')}
              className={`inline-flex h-8 w-8 items-center justify-center rounded-xl transition-colors ${
                isDark
                  ? 'text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-100'
                  : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900'
              }`}
            >
              <RefreshCw className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setShowShortcutHelp(true)}
              data-testid="insights-shortcut-help"
              title={t('workspace.insights.shortcutsHint')}
              aria-label={t('workspace.insights.shortcuts')}
              className={`inline-flex h-8 w-8 items-center justify-center rounded-xl transition-colors ${
                isDark
                  ? 'text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-100'
                  : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900'
              }`}
            >
              <Keyboard className="h-4 w-4" />
            </button>
          </div>
        }
      />
      <div className={`min-h-0 flex-1 overflow-y-auto p-4 ${mobile ? 'pb-24' : ''}`}>
        {view === 'overview' ? (
          <OverviewView
            isDark={isDark}
            workspaceId={workspaceId}
            range={range}
            refreshNonce={refreshNonce}
            mobile={mobile}
          />
        ) : view === 'project' ? (
          <ProjectView
            isDark={isDark}
            workspaceId={workspaceId}
            projectId={projectId}
            range={range}
            refreshNonce={refreshNonce}
            mobile={mobile}
            onChangeProject={onChangeProject ?? (() => {})}
          />
        ) : (
          <AgentView
            isDark={isDark}
            agentId={agentId}
            workspaceId={workspaceId}
            range={range}
            refreshNonce={refreshNonce}
            mobile={mobile}
            onChangeAgent={onChangeAgent}
          />
        )}
      </div>

      {showCustomPopover ? (
        <CustomRangeModal
          isDark={isDark}
          initial={customRange ?? { from: daysAgoISO(7), to: todayISO() }}
          onCancel={() => setShowCustomPopover(false)}
          onApply={(next) => {
            onChangeCustomRange?.(next);
            setShowCustomPopover(false);
          }}
          t={t}
        />
      ) : null}

      {showShortcutHelp ? <ShortcutHelpModal isDark={isDark} onClose={() => setShowShortcutHelp(false)} t={t} /> : null}
    </section>
  );
}

function ViewTabs({
  isDark,
  value,
  onChange,
  t,
}: {
  isDark: boolean;
  value: InsightsView;
  onChange: (next: InsightsView) => void;
  t: Translator;
}) {
  const tabs: Array<{ key: InsightsView; label: string }> = [
    { key: 'overview', label: t('workspace.insights.view.overview') },
    { key: 'project', label: t('workspace.insights.view.project') },
    { key: 'agent', label: t('workspace.insights.view.agent') },
  ];
  return (
    <div
      role="tablist"
      data-testid="insights-view-tabs"
      className={`inline-flex rounded-xl border p-0.5 ${
        isDark ? 'border-white/[0.08] bg-zinc-900/40' : 'border-zinc-200 bg-zinc-50/80'
      }`}
    >
      {tabs.map((tab) => {
        const active = tab.key === value;
        return (
          <button
            key={tab.key}
            role="tab"
            aria-selected={active}
            type="button"
            data-testid={`insights-view-tab-${tab.key}`}
            onClick={() => onChange(tab.key)}
            className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
              active
                ? isDark
                  ? 'bg-white/[0.08] text-zinc-100'
                  : 'bg-white text-zinc-900 shadow-sm'
                : isDark
                  ? 'text-zinc-400 hover:text-zinc-200'
                  : 'text-zinc-500 hover:text-zinc-800'
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

function RangePicker({
  isDark,
  value,
  isCustom,
  customRange,
  onChange,
  onOpenCustom,
  onClearCustom,
  t,
}: {
  isDark: boolean;
  value: InsightsRange;
  isCustom: boolean;
  customRange: InsightsCustomRange | null;
  onChange: (next: InsightsRange) => void;
  onOpenCustom: () => void;
  onClearCustom: () => void;
  t: Translator;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={t('workspace.insights.range.aria')}
      data-testid="insights-range-picker"
      className={`inline-flex items-center rounded-xl border p-0.5 ${
        isDark ? 'border-white/[0.08] bg-zinc-900/40' : 'border-zinc-200 bg-zinc-50/80'
      }`}
    >
      {RANGES.map((r) => {
        const active = !isCustom && r === value;
        return (
          <button
            key={r}
            type="button"
            role="radio"
            aria-checked={active}
            data-testid={`insights-range-preset-${r}`}
            onClick={() => onChange(r)}
            className={`rounded-lg px-2.5 py-1 text-xs font-medium tabular-nums transition-colors ${
              active
                ? isDark
                  ? 'bg-white/[0.08] text-zinc-100'
                  : 'bg-white text-zinc-900 shadow-sm'
                : isDark
                  ? 'text-zinc-400 hover:text-zinc-200'
                  : 'text-zinc-500 hover:text-zinc-800'
            }`}
          >
            {r}
          </button>
        );
      })}
      <button
        type="button"
        role="radio"
        aria-checked={isCustom}
        data-testid="insights-range-preset-custom"
        onClick={onOpenCustom}
        className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
          isCustom
            ? isDark
              ? 'bg-white/[0.08] text-zinc-100'
              : 'bg-white text-zinc-900 shadow-sm'
            : isDark
              ? 'text-zinc-400 hover:text-zinc-200'
              : 'text-zinc-500 hover:text-zinc-800'
        }`}
        title={
          isCustom && customRange
            ? t('workspace.insights.range.customTitle', { from: customRange.from, to: customRange.to })
            : t('workspace.insights.range.customHint')
        }
      >
        {isCustom && customRange ? `${customRange.from} → ${customRange.to}` : t('workspace.insights.range.custom')}
      </button>
      {isCustom ? (
        <button
          type="button"
          onClick={onClearCustom}
          aria-label={t('workspace.insights.range.clearAria')}
          data-testid="insights-range-clear-custom"
          className={`ml-0.5 inline-flex h-6 w-6 items-center justify-center rounded-md transition-colors ${
            isDark
              ? 'text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-200'
              : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700'
          }`}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}

function CustomRangeModal({
  isDark,
  initial,
  onCancel,
  onApply,
  t,
}: {
  isDark: boolean;
  initial: InsightsCustomRange;
  onCancel: () => void;
  onApply: (next: InsightsCustomRange) => void;
  t: Translator;
}) {
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const fromRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    fromRef.current?.focus();
  }, []);

  const invalid = !from || !to || from > to;

  return (
    <div
      data-testid="insights-custom-range-modal"
      role="dialog"
      aria-modal="true"
      aria-label={t('workspace.insights.range.customDialogAria')}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        onClick={(ev) => ev.stopPropagation()}
        className={`w-[320px] rounded-2xl border p-4 shadow-xl ${
          isDark ? 'border-white/[0.08] bg-zinc-900 text-zinc-100' : 'border-zinc-200 bg-white text-zinc-900'
        }`}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">{t('workspace.insights.range.customDialogAria')}</h3>
          <button
            type="button"
            onClick={onCancel}
            aria-label={t('common.close')}
            className={`inline-flex h-6 w-6 items-center justify-center rounded-md transition-colors ${
              isDark ? 'text-zinc-500 hover:bg-white/[0.05]' : 'text-zinc-400 hover:bg-zinc-100'
            }`}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <label className="block text-[11px] font-medium uppercase tracking-wider">
          {t('workspace.insights.range.from')}
          <input
            ref={fromRef}
            type="date"
            data-testid="insights-custom-range-from"
            value={from}
            onChange={(ev) => setFrom(ev.target.value)}
            className={`mt-1 block w-full rounded-lg border px-2 py-1.5 text-sm ${
              isDark ? 'border-white/[0.08] bg-zinc-950 text-zinc-100' : 'border-zinc-200 bg-white text-zinc-900'
            }`}
          />
        </label>
        <label className="mt-3 block text-[11px] font-medium uppercase tracking-wider">
          {t('workspace.insights.range.to')}
          <input
            type="date"
            data-testid="insights-custom-range-to"
            value={to}
            onChange={(ev) => setTo(ev.target.value)}
            className={`mt-1 block w-full rounded-lg border px-2 py-1.5 text-sm ${
              isDark ? 'border-white/[0.08] bg-zinc-950 text-zinc-100' : 'border-zinc-200 bg-white text-zinc-900'
            }`}
          />
        </label>
        {invalid ? (
          <p className={`mt-2 text-[11px] ${isDark ? 'text-rose-400' : 'text-rose-600'}`}>
            {t('workspace.insights.range.invalid')}
          </p>
        ) : null}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              isDark ? 'text-zinc-400 hover:bg-white/[0.05]' : 'text-zinc-600 hover:bg-zinc-100'
            }`}
          >
            {t('workspace.insights.range.cancel')}
          </button>
          <button
            type="button"
            disabled={invalid}
            data-testid="insights-custom-range-apply"
            onClick={() => onApply({ from, to })}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              invalid
                ? isDark
                  ? 'cursor-not-allowed bg-zinc-800 text-zinc-600'
                  : 'cursor-not-allowed bg-zinc-100 text-zinc-400'
                : isDark
                  ? 'bg-violet-500 text-white hover:bg-violet-400'
                  : 'bg-violet-600 text-white hover:bg-violet-500'
            }`}
          >
            {t('workspace.insights.range.apply')}
          </button>
        </div>
      </div>
    </div>
  );
}

function ShortcutHelpModal({ isDark, onClose, t }: { isDark: boolean; onClose: () => void; t: Translator }) {
  return (
    <div
      data-testid="insights-shortcut-help-modal"
      role="dialog"
      aria-modal="true"
      aria-label={t('workspace.insights.shortcuts')}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={(ev) => ev.stopPropagation()}
        className={`w-[320px] rounded-2xl border p-4 shadow-xl ${
          isDark ? 'border-white/[0.08] bg-zinc-900 text-zinc-100' : 'border-zinc-200 bg-white text-zinc-900'
        }`}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">{t('workspace.insights.shortcuts')}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className={`inline-flex h-6 w-6 items-center justify-center rounded-md transition-colors ${
              isDark ? 'text-zinc-500 hover:bg-white/[0.05]' : 'text-zinc-400 hover:bg-zinc-100'
            }`}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <ul className="space-y-1.5 text-xs">
          {[
            { key: '1', desc: t('workspace.insights.shortcutHelp.last24h') },
            { key: '2', desc: t('workspace.insights.shortcutHelp.last7d') },
            { key: '3', desc: t('workspace.insights.shortcutHelp.last30d') },
            { key: '4', desc: t('workspace.insights.shortcutHelp.last90d') },
            { key: 'R', desc: t('workspace.insights.shortcutHelp.refresh') },
            { key: '?', desc: t('workspace.insights.shortcutHelp.toggle') },
          ].map((row) => (
            <li key={row.key} className="flex items-center justify-between">
              <span className={isDark ? 'text-zinc-300' : 'text-zinc-700'}>{row.desc}</span>
              <kbd
                className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${
                  isDark ? 'border-white/[0.08] bg-zinc-950 text-zinc-300' : 'border-zinc-200 bg-zinc-50 text-zinc-700'
                }`}
              >
                {row.key}
              </kbd>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
