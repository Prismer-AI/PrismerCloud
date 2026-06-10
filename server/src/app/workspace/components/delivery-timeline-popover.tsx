/**
 * `DeliveryTimelinePopover` — pop-out detail panel for the delivery
 * timeline chip rendered on user-sent messages. Mirrors the shape of
 * `agent-status-popover.tsx` (portal'd, viewport-clamped, ESC closes)
 * but trades the hover trigger for click-toggle since the chip itself
 * is the affordance.
 *
 * Surface map:
 *   header      → state pill + elapsed
 *   linked      → linked task ids (clickable opens task drawer)
 *   activity    → most recent phase events for those tasks
 *   debug       → CLI trace command + retry/cancel actions
 *
 * P1 (CLAUDE.md §Debug Pipeline, 2026-05-24) — when an @-mention stalls
 * or fails, this popover is the primary place where a user can see *why*
 * without diving into the task drawer + run-events panel.
 */

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Activity, RotateCcw, Terminal } from 'lucide-react';

import type { AgentPhaseRow } from '../lib/agent-phase-store';
import type { MessageDeliveryState } from '../lib/message-delivery-state';
import { STATE_DECOR, formatStateHeadline, formatStateLabel } from './delivery-timeline-chip-decor';
import { useI18n } from '@/contexts/i18n-context';

type WorkspaceT = ReturnType<typeof useI18n>['t'];

const POPOVER_WIDTH = 320;

export interface DeliveryTimelinePopoverProps {
  open: boolean;
  anchorRect: DOMRect | null;
  state: MessageDeliveryState;
  isDark: boolean;
  /** Optional per-task phase rows so we can render recent activity tail. */
  taskPhases?: Map<string, AgentPhaseRow>;
  onClose: () => void;
  onOpenTask?: (taskId: string) => void;
  onRetry?: () => void;
}

interface Coords {
  top: number;
  left: number;
}

export function DeliveryTimelinePopover({
  open,
  anchorRect,
  state,
  isDark,
  taskPhases,
  onClose,
  onOpenTask,
  onRetry,
}: DeliveryTimelinePopoverProps) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Derive initial coords synchronously from anchorRect — no setState
  // needed, which keeps React's "no setState in effect" rule happy.
  const baseCoords = useMemo<Coords | null>(() => {
    if (!open || !anchorRect) return null;
    return computeCoords(anchorRect);
  }, [open, anchorRect]);
  // Reflow nudges (scroll / resize) bump this counter; we recompute from
  // anchorRect each time so we never store stale coords across opens.
  const [reflowTick, setReflowTick] = useState(0);
  const coords = useMemo<Coords | null>(() => {
    if (!open || !anchorRect) return null;
    // reflowTick is the trigger — value unused beyond the dep array.
    void reflowTick;
    return computeCoords(anchorRect);
  }, [open, anchorRect, reflowTick]);
  void baseCoords; // retained for future debugging — kept out of render output

  useEffect(() => {
    if (!open) return;
    const onScroll = () => setReflowTick((tick) => tick + 1);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const onClick = (event: MouseEvent) => {
      const node = panelRef.current;
      if (node && event.target instanceof Node && !node.contains(event.target)) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    // Defer click listener so the same click that opened the popover
    // doesn't immediately close it.
    const handle = setTimeout(() => document.addEventListener('mousedown', onClick), 0);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      clearTimeout(handle);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open, onClose]);

  if (typeof document === 'undefined') return null;
  if (!open || !coords) return null;

  const decor = STATE_DECOR[state.kind];
  const label = formatStateLabel(state, t);
  const headline = formatStateHeadline(state.kind, t);
  // Collect a few recent phase rows for the activity tail.
  const phaseRows: Array<{ taskId: string; row: AgentPhaseRow }> = [];
  if (taskPhases) {
    for (const taskId of state.linkedTaskIds) {
      const row = taskPhases.get(taskId);
      if (row) phaseRows.push({ taskId, row });
    }
    phaseRows.sort((a, b) => b.row.updatedAt - a.row.updatedAt);
  }

  const traceCmd = `npx tsx scripts/debug/task-trace.ts ${state.linkedTaskIds[0] ?? '<taskId>'}`;
  const canRetry = (state.kind === 'failed' || state.kind === 'timeout') && Boolean(onRetry);

  return createPortal(
    <AnimatePresence>
      <motion.div
        ref={panelRef}
        key="delivery-timeline-popover"
        initial={{ opacity: 0, y: -4, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -4, scale: 0.98 }}
        transition={{ duration: 0.14, ease: 'easeOut' }}
        style={{
          position: 'fixed',
          top: coords.top,
          left: coords.left,
          width: POPOVER_WIDTH,
          zIndex: 1000,
        }}
        data-testid="delivery-timeline-popover"
        data-state-kind={state.kind}
        className={`rounded-2xl border px-3.5 py-3 shadow-[0_20px_50px_-20px_rgba(0,0,0,0.55)] backdrop-blur-xl ${
          isDark ? 'border-white/[0.08] bg-zinc-950/92 text-zinc-200' : 'border-zinc-200/80 bg-white/95 text-zinc-800'
        }`}
      >
        {/* Header */}
        <div className="flex items-center gap-2">
          <span className={`inline-block h-2 w-2 rounded-full ${decor.dotClass}`} aria-hidden />
          <span className={`text-xs font-semibold uppercase tracking-wider ${decor.textClass}`}>{headline}</span>
          <span className={`ml-auto text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
            {formatElapsed(state.elapsedMs)}
          </span>
        </div>
        <p className={`mt-1 text-[12px] ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>{label}</p>

        {/* Linked tasks */}
        {state.linkedTaskIds.length > 0 ? (
          <Section title={t('workspace.delivery.linkedTasks', { count: state.linkedTaskIds.length })} isDark={isDark}>
            <ul className="space-y-0.5 text-[11px]">
              {state.linkedTaskIds.map((taskId) => (
                <li key={taskId} className="flex items-center gap-1.5">
                  <Activity className="h-2.5 w-2.5 shrink-0 opacity-60" />
                  <button
                    type="button"
                    onClick={() => onOpenTask?.(taskId)}
                    disabled={!onOpenTask}
                    className={`min-w-0 flex-1 truncate text-left font-mono text-[10px] underline-offset-2 hover:underline disabled:no-underline disabled:opacity-80 ${
                      isDark ? 'text-violet-200' : 'text-violet-700'
                    }`}
                    title={taskId}
                  >
                    {taskId.slice(-12)}
                  </button>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        {/* Recent activity */}
        {phaseRows.length > 0 ? (
          <Section title={t('workspace.delivery.recentActivity')} isDark={isDark}>
            <ul className={`space-y-0.5 text-[11px] ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
              {phaseRows.slice(0, 3).map(({ taskId, row }) => (
                <li key={`${taskId}-${row.updatedAt}`} className="flex items-center gap-1.5">
                  <span className={`${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>{formatAgo(row.updatedAt, t)}</span>
                  <span className="truncate">{row.lastStepLabel ?? row.phase ?? t('workspace.delivery.noPhase')}</span>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        {/* Error detail */}
        {(state.kind === 'failed' || state.kind === 'timeout') && (state.errorCode || state.errorMessage) ? (
          <Section title={t('workspace.delivery.error')} isDark={isDark}>
            {state.errorCode ? (
              <p className={`font-mono text-[10px] ${isDark ? 'text-rose-300' : 'text-rose-600'}`}>{state.errorCode}</p>
            ) : null}
            {state.errorMessage ? (
              <p className={`mt-0.5 text-[11px] ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>{state.errorMessage}</p>
            ) : null}
          </Section>
        ) : null}

        {/* CLI trace hint + retry */}
        <Section title={t('workspace.delivery.debug')} isDark={isDark}>
          <div
            className={`flex items-center gap-1.5 rounded-md border px-2 py-1 ${
              isDark ? 'border-white/[0.06] bg-zinc-900/60' : 'border-zinc-200 bg-zinc-50'
            }`}
          >
            <Terminal className="h-2.5 w-2.5 opacity-60" />
            <code className={`truncate font-mono text-[10px] ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
              {traceCmd}
            </code>
          </div>
          {canRetry ? (
            <button
              type="button"
              onClick={() => {
                onRetry?.();
                onClose();
              }}
              data-testid="delivery-timeline-retry"
              className={`mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors ${
                isDark
                  ? 'border-rose-300/30 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20'
                  : 'border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100'
              }`}
            >
              <RotateCcw className="h-3 w-3" />
              {t('workspace.delivery.retryDispatch')}
            </button>
          ) : null}
        </Section>
      </motion.div>
    </AnimatePresence>,
    document.body,
  );
}

function computeCoords(anchorRect: DOMRect): Coords {
  const margin = 8;
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const proposedTop = anchorRect.bottom + 8;
  const flipTop = proposedTop + 260 > vh ? anchorRect.top - 8 - 260 : proposedTop;
  const left = Math.max(margin, Math.min(anchorRect.right - POPOVER_WIDTH, vw - POPOVER_WIDTH - margin));
  return { top: Math.max(margin, flipTop), left };
}

function Section({ title, isDark, children }: { title: string; isDark: boolean; children: React.ReactNode }) {
  return (
    <div className={`mt-2.5 border-t pt-2 ${isDark ? 'border-white/[0.06]' : 'border-zinc-200/80'}`}>
      <p className={`mb-1 text-[9px] font-bold uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
        {title}
      </p>
      {children}
    </div>
  );
}

function formatAgo(ms: number, t: WorkspaceT): string {
  const diff = Math.max(0, Date.now() - ms);
  if (diff < 5_000) return t('workspace.delivery.justNow');
  if (diff < 60_000) return t('workspace.delivery.secondsAgo', { count: Math.round(diff / 1_000) });
  if (diff < 3_600_000) return t('workspace.delivery.minutesAgo', { count: Math.round(diff / 60_000) });
  return t('workspace.delivery.hoursAgo', { count: Math.round(diff / 3_600_000) });
}

function formatElapsed(ms: number | null | undefined): string {
  if (ms == null) return '';
  if (ms < 1_000) return '<1s';
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}
