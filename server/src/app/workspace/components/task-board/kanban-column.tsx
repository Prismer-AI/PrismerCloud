'use client';

/**
 * Single kanban column — droppable region + per-column sort UI.
 *
 * Extracted from `task-board.tsx` to keep that orchestration file lean.
 * Column-local state (sort) stays here; cross-column state (tasks,
 * agents, dnd context) is supplied by the parent through props.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { motion } from 'framer-motion';
import { Plus, Inbox, ArrowDownAZ, Clock, Flame, ListOrdered } from 'lucide-react';

import { useI18n } from '@/contexts/i18n-context';
import { radius, springSnap, stagger, statusAccent } from '../../lib/design';
import type { KanbanColumnKey } from '../../lib/types';

import { sortTasks, useIsomorphicLayoutEffect } from './helpers';
import { columnTint, OUTCOME_COLUMNS, type ColumnSort, type KanbanColumnProps, type SortOption } from './types';

const SORT_OPTIONS: SortOption[] = [
  { value: 'kanban', labelKey: 'workspace.taskBoard.sort.order', icon: <ListOrdered className="w-3.5 h-3.5" /> },
  { value: 'priority', labelKey: 'workspace.taskBoard.sort.priority', icon: <Flame className="w-3.5 h-3.5" /> },
  { value: 'updated', labelKey: 'workspace.taskBoard.sort.recent', icon: <Clock className="w-3.5 h-3.5" /> },
  { value: 'title', labelKey: 'workspace.taskBoard.sort.title', icon: <ArrowDownAZ className="w-3.5 h-3.5" /> },
];

function ColumnFilter({
  isDark,
  sort,
  onSortChange,
}: {
  isDark: boolean;
  sort: ColumnSort;
  onSortChange: (sort: ColumnSort) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  // Why portal: the column header / column body each create their own
  // stacking context (relative + z-10). An absolute z-50 dropdown is bounded
  // by that context and gets painted under sibling columns' cards. Portaling
  // to document.body escapes the context entirely; we position via the
  // button's bounding rect.
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  // pos uses either right-edge or left-edge anchoring. We pick right by
  // default (matches the trigger button's right edge — the natural UX),
  // and flip to left-edge when the right-anchored menu would clip off
  // the viewport's left side.
  const [pos, setPos] = useState<
    { top: number; right: number; left?: undefined } | { top: number; left: number; right?: undefined } | null
  >(null);
  const current = SORT_OPTIONS.find((o) => o.value === sort) ?? SORT_OPTIONS[0];
  const currentLabel = t(current.labelKey);

  useIsomorphicLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const VIEWPORT_MARGIN = 8;
    const MENU_MIN_WIDTH = 148; // min-w-[140px] + 8px viewport margin
    const desiredRight = Math.max(VIEWPORT_MARGIN, window.innerWidth - rect.right);
    // If even at the clamped right value the menu's left edge would
    // collide with the viewport's left edge, flip anchoring to the
    // button's left edge instead.
    if (window.innerWidth - desiredRight < MENU_MIN_WIDTH) {
      setPos({ top: rect.bottom + 4, left: Math.max(VIEWPORT_MARGIN, rect.left) });
    } else {
      setPos({ top: rect.bottom + 4, right: desiredRight });
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onScroll = () => setOpen(false);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        title={t('workspace.taskBoard.sortBy', { label: currentLabel })}
        className={`shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-lg transition-colors ${
          isDark
            ? 'text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.06]'
            : 'text-zinc-500 hover:text-zinc-700 hover:bg-zinc-100'
        }`}
      >
        {current.icon}
      </button>
      {open && typeof window !== 'undefined' && pos
        ? createPortal(
            <>
              <div className="fixed inset-0 z-[1000]" onClick={() => setOpen(false)} aria-hidden />
              <div
                onPointerDown={(e) => e.stopPropagation()}
                style={{
                  position: 'fixed',
                  top: pos.top,
                  ...(pos.right !== undefined ? { right: pos.right } : { left: pos.left }),
                  zIndex: 1001,
                }}
                className={`min-w-[140px] overflow-hidden rounded-lg border shadow-xl ${
                  isDark ? 'bg-zinc-900 border-white/10' : 'bg-white border-zinc-200'
                }`}
              >
                {SORT_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSortChange(opt.value);
                      setOpen(false);
                    }}
                    className={`w-full flex items-center gap-2 px-3 py-2 text-[12px] text-left transition-colors ${
                      isDark ? 'text-zinc-200 hover:bg-white/[0.04]' : 'text-zinc-800 hover:bg-zinc-100'
                    } ${sort === opt.value ? 'font-semibold' : ''}`}
                  >
                    {opt.icon}
                    {t(opt.labelKey)}
                  </button>
                ))}
              </div>
            </>,
            document.body,
          )
        : null}
    </div>
  );
}

export function KanbanColumn({
  isDark,
  columnKey,
  label,
  hint,
  addTitle,
  emptyLabel,
  count,
  index,
  onAdd,
  tasks,
  renderTaskCard,
}: KanbanColumnProps): ReactNode {
  const accent = statusAccent[columnKey] ?? statusAccent.backlog;
  // Outcome columns (completed/failed/cancelled) refuse drops at the
  // dnd-kit level so the highlight ring never appears and the drag-end
  // guard never has to fire in the common case.
  const { setNodeRef, isOver } = useDroppable({
    id: columnKey,
    data: { type: 'column', columnKey },
    disabled: OUTCOME_COLUMNS.has(columnKey),
  });
  const tint = columnTint[columnKey as KanbanColumnKey];

  // Per-column sort. State is column-local — each column independently
  // chooses how to rank its cards. Default = manual kanban order, EXCEPT
  // `completed` which defaults to "newest finished first" (P6 DONE timeline
  // —情绪价值 + 工作汇报: most-recently-finished surfaces at the top).
  const [sort, setSort] = useState<ColumnSort>(columnKey === 'completed' ? 'completed_desc' : 'kanban');
  const sortedTasks = useMemo(() => sortTasks(tasks, sort), [tasks, sort]);
  const ids = useMemo(() => sortedTasks.map((t) => t.id), [sortedTasks]);
  const empty = tasks.length === 0;

  return (
    <motion.section
      data-testid={`task-column-${columnKey}`}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={stagger(index * 0.05)}
      className={[
        // Multica-style column: NO explicit height — `align-items: stretch`
        // (flex-row default in the wrapper) makes column = wrapper height,
        // bounded by the section flex chain. NO h-full, NO max-h, NO
        // min-h — all of those caused either layout thrash or activity
        // squeeze. `flex-1 min-w-[340px]` = grow to fill available width
        // but never narrower than 340px (= horizontal scroll past 5×340).
        'group relative flex flex-1 min-w-[340px] flex-col overflow-hidden border transition-all duration-200',
        radius.pane,
        isDark ? 'border-white/[0.06] bg-zinc-950/30' : 'border-zinc-200/70 bg-white/80',
        isOver
          ? isDark
            ? 'shadow-[0_0_0_1px_rgba(139,92,246,0.4),0_20px_60px_-15px_rgba(139,92,246,0.35)]'
            : 'shadow-[0_0_0_1px_rgba(139,92,246,0.5),0_20px_60px_-20px_rgba(139,92,246,0.3)]'
          : '',
      ].join(' ')}
    >
      <div
        aria-hidden
        className={`pointer-events-none absolute inset-0 ${tint.bg} opacity-100`}
        style={{
          backgroundImage: isDark
            ? `linear-gradient(180deg, ${tint.darkTop}, ${tint.darkBottom} 28%, transparent 72%)`
            : `linear-gradient(180deg, ${tint.lightTop}, ${tint.lightBottom} 28%, transparent 72%)`,
        }}
      />
      <div
        aria-hidden
        className={`pointer-events-none absolute inset-x-0 top-0 h-px ${isDark ? 'bg-white/10' : 'bg-white/60'}`}
      />
      <div
        aria-hidden
        className={`pointer-events-none absolute inset-x-0 bottom-0 h-px ${isDark ? 'bg-black/10' : 'bg-zinc-200/70'}`}
      />

      {/* Column header */}
      <header
        className={`relative z-10 shrink-0 flex min-h-[50px] items-center gap-1.5 border-b px-3 py-2.5 ${
          isDark ? 'border-white/[0.06]' : 'border-zinc-200/70'
        }`}
      >
        <span className={`w-2 h-2 rounded-full ${accent.dot}`} aria-hidden />
        <h3 className={`text-[11px] font-bold uppercase tracking-wider ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
          {label}
        </h3>
        <span
          className={`inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 text-[10px] font-semibold rounded-full border ${accent.bg} ${accent.text}`}
        >
          {count}
        </span>
        <span
          className={`flex-1 min-w-0 truncate text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
          title={hint}
        >
          {hint}
        </span>
        <ColumnFilter isDark={isDark} sort={sort} onSortChange={setSort} />
        {onAdd ? (
          <motion.button
            type="button"
            onClick={onAdd}
            whileTap={{ scale: 0.92 }}
            transition={springSnap}
            data-testid={`task-column-add-${columnKey}`}
            title={addTitle}
            className={`shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-lg border transition-colors ${
              isDark
                ? 'border-white/[0.06] text-zinc-400 hover:text-violet-200 hover:bg-violet-500/15 hover:border-violet-400/30'
                : 'border-zinc-200 text-zinc-500 hover:text-violet-700 hover:bg-violet-50 hover:border-violet-200'
            }`}
          >
            <Plus className="w-3.5 h-3.5" />
          </motion.button>
        ) : null}
      </header>

      {/* Column body — droppable + per-column vertical scroll. */}
      <div ref={setNodeRef} className="relative z-10 flex-1 min-h-0 space-y-2.5 overflow-y-auto p-2.5">
        {empty ? (
          <div
            className={`h-24 flex flex-col items-center justify-center text-center rounded-xl border border-dashed text-[11px] ${
              isDark ? 'border-white/[0.06] text-zinc-600 bg-white/[0.03]' : 'border-zinc-200 text-zinc-400 bg-white/55'
            }`}
          >
            <Inbox className="w-4 h-4 mb-1 opacity-50" aria-hidden />
            <span>{emptyLabel}</span>
          </div>
        ) : (
          // No framer-motion wrapper here — multica's pattern. The original
          // `<motion.div layout>` + `<AnimatePresence mode="popLayout">`
          // re-measures position on every reorder, and combined with
          // dnd-kit's `useSortable` transform inside each card it produces
          // a layout feedback loop that React eventually flags as
          // "Maximum update depth exceeded". Cards still animate position
          // smoothly via dnd-kit's CSS transform on `useSortable`.
          <SortableContext items={ids} strategy={verticalListSortingStrategy}>
            {sortedTasks.map((task) => (
              <div key={task.id}>{renderTaskCard(task)}</div>
            ))}
          </SortableContext>
        )}
      </div>
    </motion.section>
  );
}
