'use client';

/**
 * /workspace TaskBoard — Wave-7 ζ horizontal kanban with drag-and-drop.
 *
 * Replaces the 118-line vertical-stacked aside with a 5-column horizontal
 * board powered by @dnd-kit/core + @dnd-kit/sortable. Pattern-matches the
 * Multica reference (`board-view.tsx`) but skinned with our glass tokens
 * from `lib/design.ts`.
 *
 * Drop semantics:
 *   - Dragging a card into another column fires PATCH /api/im/tasks/:id
 *     with the column → wire-status mapping below (see `columnToStatus`).
 *   - Optimistic update: the local column state moves the card on
 *     drag-over so the user sees the move immediately. On API failure we
 *     rebuild from props and surface a toast.
 *   - Within-column reorder is a no-op for v1 — task ordering is by
 *     updatedAt server-side; we don't yet write a position column.
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  pointerWithin,
  closestCenter,
  useDroppable,
  type CollisionDetection,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { motion } from 'framer-motion';
import { Loader2, Plus, AlertTriangle, Inbox, ArrowDownAZ, Clock, Flame, Trash2 } from 'lucide-react';
import { Bar, BarChart, Cell, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/contexts/i18n-context';
import { TaskCard } from './task-card';
import { SurfaceHeader } from './surface-header';
import {
  KANBAN_COLUMNS,
  bucketTask,
  type TaskDTO,
  type KanbanColumnKey,
  type AgentDTO,
  type AssetDTO,
} from '../lib/types';
import { classifyAgent, type AgentKind, AGENT_KIND_PRESETS } from '../lib/agent-kind';
import { updateTask } from '../lib/mutations';
import {
  surface,
  radius,
  springSnap,
  stagger,
  statusAccent,
  readTaskPriority,
  avatarGradient,
  avatarInitials,
} from '../lib/design';

// ─── Public props ─────────────────────────────────────────────────

export interface TaskBoardProps {
  isDark: boolean;
  tasks: TaskDTO[];
  loading: boolean;
  error: string | null;
  agents?: AgentDTO[];
  /** Workspace assets — board indexes by sourceTaskId so each card knows its artifact count. */
  assets?: AssetDTO[];
  onTaskChanged?: () => void;
  notify?: (message: string, type: 'success' | 'error' | 'info') => void;
  onNewTask?: (column?: KanbanColumnKey) => void;
  onOpenTask?: (task: TaskDTO) => void;
  onUploadTaskAttachment?: (taskId: string) => void;
  /** W2-T2: route an artifact click into the workspace inspector dialog. */
  onOpenAsset?: (assetId: string) => void;
  /** W2-T5: switch the workspace IM channel to this task's linked conversation. */
  onOpenConversation?: (conversationId: string) => void;
}

// ─── Column ↔ wire-status mapping ────────────────────────────────

/**
 * When the user drops a card into a column, we set this status on the
 * server. `backlog` and `todo` both map to `pending` because assignee
 * differentiates the two buckets; dropping an unassigned task into Todo
 * is blocked in `handleDragEnd` so the card never snaps back mysteriously
 * after refresh.
 */
const columnToStatus: Record<KanbanColumnKey, TaskDTO['status']> = {
  backlog: 'pending',
  todo: 'pending',
  in_progress: 'running',
  review: 'review',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
};

const COLUMN_IDS: ReadonlySet<string> = new Set(KANBAN_COLUMNS.map((c) => c.key));
const EXECUTION_STATUS_WARNING_KEY = 'workspace:tasks:skip-execution-status-warning';
const EXECUTION_STATUSES: ReadonlySet<string> = new Set(['assigned', 'running', 'review', 'completed']);

// Outcome columns are read-only terminal states: dropping INTO them or
// dragging cards OUT of `cancelled` is forbidden by the kanban contract.
// Wired into `useDroppable({ disabled })` per column AND into the
// `handleDragEnd` guard so neither dnd-kit nor the PATCH path can fire.
const OUTCOME_COLUMNS: ReadonlySet<KanbanColumnKey> = new Set(['completed', 'failed', 'cancelled']);

// SSR-safe `useLayoutEffect`: Next.js warns when useLayoutEffect runs on
// the server (no DOM, no layout). Fall back to useEffect during SSR; on
// the client we still get the synchronous-before-paint behavior the
// portal-positioning math needs.
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

// Stable empty array — passing `agents ?? []` inline allocates a fresh array on
// every render, which defeats `BoardMetricsStrip`'s React.memo and feeds new
// references into recharts on each parent re-render. During drag, that lands
// inside ResponsiveContainer's ResizeObserver loop and trips React's max-depth
// guard. Use this shared sentinel instead.
const EMPTY_AGENTS: AgentDTO[] = [];

// ─── Per-column sort ───────────────────────────────────────────────

type ColumnSort = 'priority' | 'updated' | 'title';

const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

function sortTasks(tasks: TaskDTO[], sort: ColumnSort): TaskDTO[] {
  const arr = [...tasks];
  switch (sort) {
    case 'priority':
      arr.sort((a, b) => {
        const pa = PRIORITY_ORDER[readTaskPriority(a)] ?? 99;
        const pb = PRIORITY_ORDER[readTaskPriority(b)] ?? 99;
        if (pa !== pb) return pa - pb;
        return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
      });
      break;
    case 'updated':
      arr.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      break;
    case 'title':
      arr.sort((a, b) => (a.title ?? '').localeCompare(b.title ?? ''));
      break;
  }
  return arr;
}

interface SortOption {
  value: ColumnSort;
  label: string;
  icon: ReactNode;
}

const SORT_OPTIONS: SortOption[] = [
  { value: 'priority', label: 'Priority', icon: <Flame className="w-3.5 h-3.5" /> },
  { value: 'updated', label: 'Recent', icon: <Clock className="w-3.5 h-3.5" /> },
  { value: 'title', label: 'Title', icon: <ArrowDownAZ className="w-3.5 h-3.5" /> },
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
        title={`Sort by ${current.label}`}
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
                    {opt.label}
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

// ─── Collision tuned for kanban (cards over columns) ────────────────

const kanbanCollision: CollisionDetection = (args) => {
  const pointer = pointerWithin(args);
  if (pointer.length > 0) {
    const cards = pointer.filter((c) => !COLUMN_IDS.has(String(c.id)));
    if (cards.length > 0) return cards;
  }
  return closestCenter(args);
};

// ─── Helpers ─────────────────────────────────────────────────────

function bucketAll(tasks: TaskDTO[]): Record<KanbanColumnKey, TaskDTO[]> {
  const cols: Record<KanbanColumnKey, TaskDTO[]> = {
    backlog: [],
    todo: [],
    in_progress: [],
    review: [],
    completed: [],
    failed: [],
    cancelled: [],
  };
  for (const task of tasks) {
    const col = bucketTask(task);
    if (col) cols[col].push(task);
  }
  return cols;
}

function findColumn(cols: Record<KanbanColumnKey, TaskDTO[]>, id: string): KanbanColumnKey | null {
  if (COLUMN_IDS.has(id)) return id as KanbanColumnKey;
  for (const key of Object.keys(cols) as KanbanColumnKey[]) {
    if (cols[key].some((t) => t.id === id)) return key;
  }
  return null;
}

function findDropColumn(cols: Record<KanbanColumnKey, TaskDTO[]>, overId: string): KanbanColumnKey | null {
  if (COLUMN_IDS.has(overId)) return overId as KanbanColumnKey;
  return findColumn(cols, overId);
}

function replaceTaskInColumns(
  cols: Record<KanbanColumnKey, TaskDTO[]>,
  task: TaskDTO,
  targetCol: KanbanColumnKey | null,
): Record<KanbanColumnKey, TaskDTO[]> {
  const next: Record<KanbanColumnKey, TaskDTO[]> = {
    backlog: cols.backlog.filter((t: TaskDTO) => t.id !== task.id),
    todo: cols.todo.filter((t: TaskDTO) => t.id !== task.id),
    in_progress: cols.in_progress.filter((t: TaskDTO) => t.id !== task.id),
    review: cols.review.filter((t: TaskDTO) => t.id !== task.id),
    completed: cols.completed.filter((t: TaskDTO) => t.id !== task.id),
    failed: cols.failed.filter((t: TaskDTO) => t.id !== task.id),
    cancelled: cols.cancelled.filter((t: TaskDTO) => t.id !== task.id),
  };
  if (!targetCol) return next;
  next[targetCol] = [...next[targetCol], task];
  return next;
}

function shouldConfirmExecutionMove(task: TaskDTO, fromCol: KanbanColumnKey | null, toCol: KanbanColumnKey): boolean {
  if (fromCol === toCol) return false;
  const targetStatus = columnToStatus[toCol];
  if (targetStatus === task.status && toCol !== 'backlog') return false;
  return EXECUTION_STATUSES.has(task.status) || EXECUTION_STATUSES.has(targetStatus);
}

function resolveKanbanMovePlan(
  task: TaskDTO,
  _fromCol: KanbanColumnKey | null,
  toCol: KanbanColumnKey,
): KanbanMovePlan {
  if (toCol === 'backlog') {
    return {
      targetStatus: 'pending' as const,
      assigneeId: null,
    };
  }
  if (toCol === 'todo') {
    if (!task.assigneeId) {
      return { blocked: 'workspace.taskBoard.assignBeforeTodo' };
    }
    return {
      targetStatus: 'pending' as const,
      assigneeId: task.assigneeId,
    };
  }
  if (toCol === 'in_progress') {
    if (!task.assigneeId) {
      return { blocked: 'workspace.taskBoard.assignBeforeInProgress' };
    }
    return {
      targetStatus: 'running' as const,
      assigneeId: task.assigneeId,
    };
  }
  if (toCol === 'review') {
    return {
      targetStatus: 'review' as const,
      assigneeId: task.assigneeId ?? undefined,
    };
  }
  return {
    targetStatus: 'completed' as const,
    assigneeId: task.assigneeId ?? undefined,
  };
}

type KanbanMovePlan =
  | { blocked: 'workspace.taskBoard.assignBeforeTodo' | 'workspace.taskBoard.assignBeforeInProgress' }
  | {
      targetStatus: TaskDTO['status'];
      assigneeId?: string | null;
    };

function readSkipExecutionWarning(): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(EXECUTION_STATUS_WARNING_KEY) === 'true';
}

function writeSkipExecutionWarning(skip: boolean): void {
  if (typeof window === 'undefined') return;
  if (skip) window.localStorage.setItem(EXECUTION_STATUS_WARNING_KEY, 'true');
  else window.localStorage.removeItem(EXECUTION_STATUS_WARNING_KEY);
}

// ─── Per-column droppable wrapper ────────────────────────────────

interface KanbanColumnProps {
  isDark: boolean;
  columnKey: KanbanColumnKey;
  label: string;
  hint: string;
  addTitle: string;
  emptyLabel: string;
  count: number;
  index: number;
  onAdd?: () => void;
  /** Bucketed tasks for this column (in storage order; sort is applied inside). */
  tasks: TaskDTO[];
  /** Renders a single task card — kept as a callback so the column doesn't
   *  need to know about agents/assets/etc. (those live in TaskBoard scope). */
  renderTaskCard: (task: TaskDTO) => ReactNode;
}

interface PendingExecutionMove {
  task: TaskDTO;
  fromCol: KanbanColumnKey | null;
  toCol: KanbanColumnKey;
  targetStatus: TaskDTO['status'];
  assigneeId?: string | null;
}

// User dragged an unassigned task into a column that requires an assignee
// (`todo` or `in_progress`). Instead of toasting an error and snapping
// back, we open an inline assignee picker — pick + move in one motion.
interface PendingAssignmentMove {
  task: TaskDTO;
  fromCol: KanbanColumnKey | null;
  toCol: KanbanColumnKey;
  targetStatus: TaskDTO['status'];
}

interface TaskOverride {
  task: TaskDTO;
  expiresAt: number;
}

function KanbanColumn({
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
}: KanbanColumnProps) {
  const accent = statusAccent[columnKey] ?? statusAccent.backlog;
  // Outcome columns (completed/failed/cancelled) refuse drops at the
  // dnd-kit level so the highlight ring never appears and the drag-end
  // guard never has to fire in the common case.
  const { setNodeRef, isOver } = useDroppable({
    id: columnKey,
    data: { type: 'column', columnKey },
    disabled: OUTCOME_COLUMNS.has(columnKey),
  });
  const tint = columnTint[columnKey];

  // Per-column sort. State is column-local — each column independently
  // chooses how to rank its cards. Default = priority (urgent → low) with
  // updatedAt as tiebreak.
  const [sort, setSort] = useState<ColumnSort>('priority');
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
        // squeeze. `flex-1 min-w-[280px]` = grow to fill available width
        // but never narrower than 280px (= horizontal scroll past 5×280).
        'group relative flex flex-1 min-w-[280px] flex-col overflow-hidden border transition-all duration-200',
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

const columnTint: Record<
  KanbanColumnKey,
  { bg: string; darkTop: string; darkBottom: string; lightTop: string; lightBottom: string }
> = {
  backlog: {
    bg: 'bg-zinc-500/[0.03]',
    darkTop: 'rgba(255,255,255,0.03)',
    darkBottom: 'rgba(255,255,255,0.01)',
    lightTop: 'rgba(255,255,255,0.8)',
    lightBottom: 'rgba(244,244,245,0.35)',
  },
  todo: {
    bg: 'bg-sky-500/[0.04]',
    darkTop: 'rgba(14,165,233,0.08)',
    darkBottom: 'rgba(14,165,233,0.015)',
    lightTop: 'rgba(14,165,233,0.08)',
    lightBottom: 'rgba(255,255,255,0.5)',
  },
  in_progress: {
    bg: 'bg-amber-500/[0.04]',
    darkTop: 'rgba(245,158,11,0.08)',
    darkBottom: 'rgba(245,158,11,0.015)',
    lightTop: 'rgba(245,158,11,0.08)',
    lightBottom: 'rgba(255,255,255,0.5)',
  },
  review: {
    bg: 'bg-violet-500/[0.04]',
    darkTop: 'rgba(139,92,246,0.08)',
    darkBottom: 'rgba(139,92,246,0.015)',
    lightTop: 'rgba(139,92,246,0.08)',
    lightBottom: 'rgba(255,255,255,0.5)',
  },
  completed: {
    bg: 'bg-emerald-500/[0.04]',
    darkTop: 'rgba(16,185,129,0.08)',
    darkBottom: 'rgba(16,185,129,0.015)',
    lightTop: 'rgba(16,185,129,0.08)',
    lightBottom: 'rgba(255,255,255,0.5)',
  },
  failed: {
    bg: 'bg-rose-500/[0.04]',
    darkTop: 'rgba(244,63,94,0.08)',
    darkBottom: 'rgba(244,63,94,0.015)',
    lightTop: 'rgba(244,63,94,0.08)',
    lightBottom: 'rgba(255,255,255,0.5)',
  },
  cancelled: {
    bg: 'bg-zinc-500/[0.05]',
    darkTop: 'rgba(113,113,122,0.10)',
    darkBottom: 'rgba(113,113,122,0.02)',
    lightTop: 'rgba(228,228,231,0.6)',
    lightBottom: 'rgba(244,244,245,0.3)',
  },
};

// ─── Main board ──────────────────────────────────────────────────

export function TaskBoard({
  isDark,
  tasks,
  loading,
  error,
  agents,
  assets,
  onTaskChanged,
  notify,
  onNewTask,
  onOpenTask,
  onUploadTaskAttachment,
  onOpenAsset,
  onOpenConversation,
}: TaskBoardProps) {
  const { t } = useI18n();
  const theme: 'dark' | 'light' = isDark ? 'dark' : 'light';
  // Why: i18n keys for these columns live on the cloud side. Hardcoding
  // Chinese here as the canonical product naming (构思 / 待执行 / 进行中 /
  // 待确认 / 已完成 / 已失败 / 回收站) keeps the labels stable and matches
  // the Pause-back state where pending+assigned → 待执行. The recycle bin
  // (cancelled) is visible only when `showRecycleBin` is on.
  const [showRecycleBin, setShowRecycleBin] = useState(false);
  const kanbanColumns = useMemo(() => {
    const base: Array<{ key: KanbanColumnKey; label: string; hint: string }> = [
      { key: 'backlog', label: '构思', hint: '未指派' },
      { key: 'todo', label: '待执行', hint: '已指派 / 暂停回收' },
      { key: 'in_progress', label: '进行中', hint: '运行中' },
      { key: 'review', label: '待确认', hint: '等待审核' },
      { key: 'completed', label: '已完成', hint: '通过' },
      { key: 'failed', label: '已失败', hint: '执行失败' },
    ];
    if (showRecycleBin) {
      base.push({ key: 'cancelled', label: '回收站', hint: '已取消' });
    }
    return base;
  }, [showRecycleBin]);
  const getColumnLabel = useCallback(
    (column: KanbanColumnKey) => kanbanColumns.find((item) => item.key === column)?.label ?? column,
    [kanbanColumns],
  );

  // Map imUserId → AgentKind so each card can show CLI vs long-running.
  const agentKindByImUserId = useMemo<Record<string, AgentKind>>(() => {
    const out: Record<string, AgentKind> = {};
    for (const a of agents ?? []) {
      out[a.userId] = classifyAgent({ adapterName: a.agentType ?? null });
    }
    return out;
  }, [agents]);

  // W2-T2: index workspace assets by sourceTaskId so each card's render can
  // pick its slice in O(1) instead of scanning the full asset list every
  // mount.
  const assetsByTaskId = useMemo<Map<string, AssetDTO[]>>(() => {
    const out = new Map<string, AssetDTO[]>();
    for (const asset of assets ?? []) {
      if (!asset.sourceTaskId) continue;
      const arr = out.get(asset.sourceTaskId);
      if (arr) arr.push(asset);
      else out.set(asset.sourceTaskId, [asset]);
    }
    return out;
  }, [assets]);

  // Local optimistic columns. Reset from props between drags (TQ-like).
  const [columns, setColumns] = useState<Record<KanbanColumnKey, TaskDTO[]>>(() => bucketAll(tasks));
  const isDraggingRef = useRef(false);
  const columnsRef = useRef(columns);
  const committedTaskOverridesRef = useRef<Map<string, TaskOverride>>(new Map());

  useEffect(() => {
    columnsRef.current = columns;
  }, [columns]);

  useEffect(() => {
    if (!isDraggingRef.current) {
      const now = Date.now();
      const overrides = committedTaskOverridesRef.current;
      const merged = tasks.map((task) => {
        const override = overrides.get(task.id);
        if (!override) return task;
        if (override.expiresAt <= now) {
          overrides.delete(task.id);
          return task;
        }
        if (
          task.status === override.task.status &&
          task.assigneeId === override.task.assigneeId &&
          Date.parse(task.updatedAt) >= Date.parse(override.task.updatedAt)
        ) {
          overrides.delete(task.id);
          return task;
        }
        return override.task;
      });
      for (const [id, override] of overrides) {
        if (override.expiresAt <= now) {
          overrides.delete(id);
          continue;
        }
        if (!merged.some((task) => task.id === id)) {
          merged.push(override.task);
        }
      }
      setColumns(bucketAll(merged));
    }
  }, [tasks]);

  const taskMap = useMemo(() => {
    const m = new Map<string, TaskDTO>();
    for (const t of tasks) m.set(t.id, t);
    return m;
  }, [tasks]);

  // Active drag state for the overlay
  const [activeTask, setActiveTask] = useState<TaskDTO | null>(null);
  const [pendingExecutionMove, setPendingExecutionMove] = useState<PendingExecutionMove | null>(null);
  const [skipFutureExecutionWarnings, setSkipFutureExecutionWarnings] = useState(false);
  const [pendingAssignmentMove, setPendingAssignmentMove] = useState<PendingAssignmentMove | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      isDraggingRef.current = true;
      const id = String(event.active.id);
      // active task may live in optimistic columns rather than the tasks prop
      const fromCols = (() => {
        for (const list of Object.values(columnsRef.current)) {
          const found = list.find((t) => t.id === id);
          if (found) return found;
        }
        return null;
      })();
      setActiveTask(fromCols ?? taskMap.get(id) ?? null);
    },
    [taskMap],
  );

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const { active, over } = event;
    if (!over) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    if (activeId === overId) return;

    setColumns((prev) => {
      const fromCol = findColumn(prev, activeId);
      const toCol = findDropColumn(prev, overId);
      if (!fromCol || !toCol || fromCol === toCol) return prev;

      const moving = prev[fromCol].find((t) => t.id === activeId);
      if (!moving) return prev;

      const fromList = prev[fromCol].filter((t) => t.id !== activeId);
      const toList = [...prev[toCol]];
      const overIndex = toList.findIndex((t) => t.id === overId);
      const insertAt = overIndex >= 0 ? overIndex : toList.length;
      toList.splice(insertAt, 0, moving);

      const next = { ...prev, [fromCol]: fromList, [toCol]: toList };
      columnsRef.current = next;
      return next;
    });
  }, []);

  const performStatusMove = useCallback(
    async (move: PendingExecutionMove) => {
      const reason = `Kanban move to ${move.toCol.replace('_', ' ')} by task creator`;
      const res = await updateTask(move.task.id, {
        status: move.targetStatus,
        assigneeId: move.assigneeId,
        forceExecutionStatus: true,
        metadata: { reason },
      });
      if (!res.ok) {
        notify?.(t('workspace.taskBoard.moveFailed', { message: res.message }), 'error');
        setColumns(bucketAll(tasks));
        return;
      }

      const updatedTask = res.data;
      committedTaskOverridesRef.current.set(updatedTask.id, {
        task: updatedTask,
        expiresAt: Date.now() + 15_000,
      });
      const actualCol = bucketTask(updatedTask);
      setColumns((prev) => {
        const next = replaceTaskInColumns(prev, updatedTask, actualCol);
        columnsRef.current = next;
        return next;
      });

      const title = updatedTask.title || move.task.title || move.task.id.slice(-8);
      if (actualCol === move.toCol) {
        notify?.(t('workspace.taskBoard.movedSuccess', { title, column: getColumnLabel(move.toCol) }), 'success');
      } else if (actualCol) {
        notify?.(
          t('workspace.taskBoard.moveKept', {
            title,
            column: getColumnLabel(actualCol),
          }),
          'info',
        );
      } else {
        notify?.(t('workspace.taskBoard.moveHidden', { title }), 'info');
      }
      onTaskChanged?.();
    },
    [notify, onTaskChanged, tasks, getColumnLabel, t],
  );

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      isDraggingRef.current = false;
      const activeId = String(active.id);
      setActiveTask(null);

      if (!over) {
        setColumns(bucketAll(tasks));
        return;
      }

      const original = taskMap.get(activeId);
      if (!original) {
        setColumns(bucketAll(tasks));
        return;
      }

      const finalCol = findColumn(columnsRef.current, activeId);
      if (!finalCol) {
        setColumns(bucketAll(tasks));
        return;
      }

      const originalCol = bucketTask(original);
      const overId = String(over.id);
      const targetCol = findDropColumn(columnsRef.current, overId) ?? finalCol;

      if (originalCol === targetCol) {
        // Same column — no PATCH needed.
        return;
      }

      // Outcome columns are terminal: refuse drops INTO them, and refuse
      // drags OUT of `cancelled` (the recycle bin is final). dnd-kit
      // already disables the droppable for these columns, but the guard
      // covers the case where a card was optimistically moved on
      // drag-over and we need to snap back from the props.
      if (OUTCOME_COLUMNS.has(targetCol) || originalCol === 'cancelled') {
        setColumns(bucketAll(tasks));
        notify?.('该列不能拖入/拖出', 'info');
        return;
      }

      if (targetCol !== finalCol) {
        setColumns((prev) => {
          const next = replaceTaskInColumns(prev, original, targetCol);
          columnsRef.current = next;
          return next;
        });
      }

      const plan = resolveKanbanMovePlan(original, originalCol, targetCol);
      if ('blocked' in plan) {
        // Drop into a column that requires an assignee (todo / in_progress)
        // but the task is unassigned — open the assignee picker dialog
        // instead of toasting an error. Pick + move happens in one flow.
        const targetStatus: TaskDTO['status'] = targetCol === 'in_progress' ? 'running' : 'pending';
        setPendingAssignmentMove({
          task: original,
          fromCol: originalCol,
          toCol: targetCol,
          targetStatus,
        });
        return;
      }

      const move: PendingExecutionMove = {
        task: original,
        fromCol: originalCol,
        toCol: targetCol,
        targetStatus: plan.targetStatus,
        assigneeId: plan.assigneeId,
      };

      if (shouldConfirmExecutionMove(original, originalCol, targetCol) && !readSkipExecutionWarning()) {
        setSkipFutureExecutionWarnings(false);
        setPendingExecutionMove(move);
        return;
      }

      await performStatusMove(move);
    },
    [tasks, taskMap, notify, performStatusMove, t],
  );

  const handleDragCancel = useCallback(() => {
    isDraggingRef.current = false;
    setActiveTask(null);
    setColumns(bucketAll(tasks));
  }, [tasks]);

  const confirmPendingExecutionMove = useCallback(async () => {
    const move = pendingExecutionMove;
    if (!move) return;
    if (skipFutureExecutionWarnings) {
      writeSkipExecutionWarning(true);
    }
    setPendingExecutionMove(null);
    await performStatusMove(move);
  }, [pendingExecutionMove, performStatusMove, skipFutureExecutionWarnings]);

  const cancelPendingExecutionMove = useCallback(() => {
    setPendingExecutionMove(null);
    setSkipFutureExecutionWarnings(false);
    setColumns(bucketAll(tasks));
  }, [tasks]);

  const completeAssignmentMove = useCallback(
    async (assigneeId: string) => {
      const move = pendingAssignmentMove;
      if (!move) return;
      setPendingAssignmentMove(null);
      await performStatusMove({
        task: move.task,
        fromCol: move.fromCol,
        toCol: move.toCol,
        targetStatus: move.targetStatus,
        assigneeId,
      });
    },
    [pendingAssignmentMove, performStatusMove],
  );

  const cancelAssignmentMove = useCallback(() => {
    setPendingAssignmentMove(null);
    setColumns(bucketAll(tasks));
  }, [tasks]);

  const pendingAgentKind = pendingExecutionMove?.task.assigneeId
    ? agentKindByImUserId[pendingExecutionMove.task.assigneeId]
    : undefined;
  const pendingTargetLabel = pendingExecutionMove ? getColumnLabel(pendingExecutionMove.toCol) : null;

  // Total count for the header
  const totalTasks = tasks.length;

  // Lifted out of the JSX so KanbanColumn can render the cards itself (it
  // owns the SortableContext + sort) without TaskBoard having to thread
  // every TaskCard prop through. Memoized to keep card identity stable
  // across cosmetic re-renders.
  const renderTaskCard = useCallback(
    (task: TaskDTO) => (
      <TaskCard
        isDark={isDark}
        task={task}
        agents={agents}
        agentKindByImUserId={agentKindByImUserId}
        taskAssets={assetsByTaskId.get(task.id)}
        onChanged={onTaskChanged}
        notify={notify}
        onOpen={onOpenTask ? () => onOpenTask(task) : undefined}
        onUploadAttachment={onUploadTaskAttachment ? () => onUploadTaskAttachment(task.id) : undefined}
        onOpenAsset={onOpenAsset}
        onOpenConversation={onOpenConversation}
      />
    ),
    [
      isDark,
      agents,
      agentKindByImUserId,
      assetsByTaskId,
      onTaskChanged,
      notify,
      onOpenTask,
      onUploadTaskAttachment,
      onOpenAsset,
      onOpenConversation,
    ],
  );

  return (
    // Fragment: TaskBoard returns TWO siblings to its parent (motion.main,
    // which is flex-col). The activity strip is a peer of the kanban
    // section, NOT a child of it. This way the strip is a `shrink-0`
    // sibling of the `flex-1` kanban section in motion.main's layout and
    // is guaranteed to never be clipped — kanban shrinks first.
    <>
      <section className="flex min-w-0 flex-1 min-h-0 flex-col">
        <SurfaceHeader
          isDark={isDark}
          title={t('workspace.taskBoard.title')}
          subtitle={t('workspace.taskBoard.subtitle', { count: totalTasks })}
          actions={
            <button
              type="button"
              onClick={() => setShowRecycleBin((v) => !v)}
              title={showRecycleBin ? '隐藏回收站' : '显示回收站'}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12px] font-medium transition-colors ${
                showRecycleBin
                  ? isDark
                    ? 'bg-rose-500/10 border-rose-500/30 text-rose-200'
                    : 'bg-rose-50 border-rose-200 text-rose-700'
                  : isDark
                    ? 'border-white/10 text-zinc-300 hover:bg-white/[0.04]'
                    : 'border-zinc-200 text-zinc-700 hover:bg-zinc-50'
              }`}
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span>回收站</span>
              {showRecycleBin ? <span className="opacity-70">·开</span> : null}
            </button>
          }
        />

        {/* Error band */}
        {error ? (
          <div
            className={`mx-5 mt-3 flex items-start gap-2 px-3 py-2 text-xs border ${radius.button} ${
              isDark ? 'bg-rose-500/10 border-rose-500/30 text-rose-200' : 'bg-rose-50 border-rose-200 text-rose-700'
            }`}
          >
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium">{t('workspace.taskBoard.loadFailed')}</p>
              <p className="opacity-80">{error}</p>
            </div>
          </div>
        ) : null}

        {/* Loading skeleton */}
        {loading && totalTasks === 0 ? (
          <div className="flex flex-1 min-h-0 gap-3 overflow-x-auto overflow-y-hidden p-5">
            {kanbanColumns.map((col, idx) => (
              <div
                key={col.key}
                className={`flex flex-1 min-w-[280px] flex-col border ${radius.pane} ${surface.pane[theme]} p-3 space-y-3`}
              >
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-zinc-500/40" />
                  <span
                    className={`text-[11px] font-bold uppercase tracking-wider ${
                      isDark ? 'text-zinc-400' : 'text-zinc-600'
                    }`}
                  >
                    {col.label}
                  </span>
                  <Loader2
                    className={`ml-auto w-3.5 h-3.5 animate-spin ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}
                    style={{ animationDelay: `${idx * 100}ms` }}
                  />
                </div>
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className={`h-20 rounded-xl animate-pulse ${isDark ? 'bg-white/[0.04]' : 'bg-zinc-100'}`}
                    style={{ animationDelay: `${(idx * 3 + i) * 80}ms` }}
                  />
                ))}
              </div>
            ))}
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={kanbanCollision}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
            onDragCancel={handleDragCancel}
          >
            {/* Single-layer flex wrapper, multica-style. Columns are direct
              flex-row children — `align-items: stretch` (default) sizes
              each column to wrapper height, no h-full chain needed.
              `flex-1 min-h-0` so wrapper can shrink below grid min-content
              and never push activity strip below motion.main's clip.
              `overflow-x-auto` for horizontal scroll past 5×280px;
              `overflow-y-hidden` defeats the CSS spec rule that would
              otherwise promote overflow-y to auto and let the wrapper
              itself scroll vertically. */}
            <div className="flex flex-1 min-h-0 gap-3 overflow-x-auto overflow-y-hidden p-5">
              {kanbanColumns.map((col, idx) => {
                const items = columns[col.key];
                return (
                  <KanbanColumn
                    key={col.key}
                    isDark={isDark}
                    columnKey={col.key}
                    label={col.label}
                    hint={col.hint}
                    addTitle={t('workspace.taskBoard.addToColumn', { column: col.label })}
                    emptyLabel={t('workspace.taskBoard.emptyDrop')}
                    count={items.length}
                    index={idx}
                    onAdd={onNewTask ? () => onNewTask(col.key) : undefined}
                    tasks={items}
                    renderTaskCard={renderTaskCard}
                  />
                );
              })}
            </div>

            <DragOverlay dropAnimation={null}>
              {activeTask ? (
                <div className="w-[280px] pointer-events-none">
                  <TaskCard
                    isDark={isDark}
                    task={activeTask}
                    agentKindByImUserId={agentKindByImUserId}
                    asOverlay
                    isDragging
                  />
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        )}

        <Dialog
          open={!!pendingExecutionMove}
          onOpenChange={(open) => {
            if (!open) cancelPendingExecutionMove();
          }}
        >
          <DialogContent className={`${surface.modal[theme]} ${radius.pane} border`} showCloseButton={false}>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-500" aria-hidden />
                {t('workspace.taskBoard.executionTitle')}
              </DialogTitle>
              <DialogDescription>
                {t('workspace.taskBoard.executionDescription', {
                  column: pendingTargetLabel ?? t('workspace.taskBoard.thisColumn'),
                })}
              </DialogDescription>
            </DialogHeader>

            <div
              className={`rounded-lg border p-3 text-sm ${
                isDark
                  ? 'border-white/[0.08] bg-white/[0.03] text-zinc-300'
                  : 'border-zinc-200 bg-zinc-50 text-zinc-700'
              }`}
            >
              {pendingExecutionMove?.toCol === 'in_progress' ? (
                <p>{t('workspace.taskBoard.executionInProgress')}</p>
              ) : pendingExecutionMove?.toCol === 'backlog' || pendingExecutionMove?.toCol === 'todo' ? (
                <p>
                  {t('workspace.taskBoard.executionBackToPending', {
                    column:
                      pendingExecutionMove?.toCol === 'backlog' ? getColumnLabel('backlog') : getColumnLabel('todo'),
                  })}
                </p>
              ) : (
                <p>{t('workspace.taskBoard.executionForce')}</p>
              )}
              {pendingAgentKind === 'long-running' ? (
                <p className="mt-2 text-xs opacity-80">{t('workspace.taskBoard.executionLongRunning')}</p>
              ) : null}
            </div>

            <label className={`flex items-center gap-2 text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
              <input
                type="checkbox"
                checked={skipFutureExecutionWarnings}
                onChange={(event) => setSkipFutureExecutionWarnings(event.currentTarget.checked)}
                className="h-3.5 w-3.5 rounded border-zinc-300 text-violet-600 focus:ring-violet-500"
              />
              {t('workspace.taskBoard.executionSkipWarning')}
            </label>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={cancelPendingExecutionMove}>
                {t('common.close')}
              </Button>
              <Button type="button" onClick={confirmPendingExecutionMove}>
                {t('workspace.taskBoard.changeStatus')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Assignee picker — opens when user drags an unassigned task into a
          column that requires an assignee. Pick + status change in one
          motion, no toast-then-retry friction. */}
        <Dialog
          open={!!pendingAssignmentMove}
          onOpenChange={(open) => {
            if (!open) cancelAssignmentMove();
          }}
        >
          <DialogContent className={`${surface.modal[theme]} ${radius.pane} border`} showCloseButton={false}>
            <DialogHeader>
              <DialogTitle>
                {pendingAssignmentMove?.toCol === 'in_progress'
                  ? t('workspace.taskBoard.assignBeforeInProgress')
                  : t('workspace.taskBoard.assignBeforeTodo')}
              </DialogTitle>
              <DialogDescription>
                {pendingAssignmentMove
                  ? `"${pendingAssignmentMove.task.title || pendingAssignmentMove.task.id.slice(-8)}"`
                  : null}
              </DialogDescription>
            </DialogHeader>

            <div
              className={`max-h-72 overflow-y-auto rounded-lg border ${isDark ? 'border-white/[0.06]' : 'border-zinc-200/70'}`}
            >
              {(agents ?? []).length === 0 ? (
                <div className={`px-3 py-6 text-center text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                  {t('workspace.taskBoard.noAgentsAvailable')}
                </div>
              ) : (
                <ul className="p-1">
                  {(agents ?? []).map((agent) => {
                    const kind = classifyAgent({ adapterName: agent.agentType ?? null });
                    const kindPreset = AGENT_KIND_PRESETS[kind];
                    const initials = avatarInitials(agent.name ?? agent.userId);
                    const grad = avatarGradient(agent.name || agent.userId);
                    return (
                      <li key={agent.userId}>
                        <button
                          type="button"
                          onClick={() => void completeAssignmentMove(agent.userId)}
                          data-testid={`task-board-assign-pick-${agent.userId}`}
                          className={`w-full flex items-center gap-3 px-3 py-2 rounded-md text-left text-[13px] transition-colors ${
                            isDark ? 'text-zinc-200 hover:bg-white/[0.05]' : 'text-zinc-800 hover:bg-zinc-100'
                          }`}
                        >
                          <span
                            className="shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-full text-[10px] font-bold text-white shadow-sm"
                            style={{ background: `linear-gradient(135deg, ${grad.from}, ${grad.to})` }}
                          >
                            {initials}
                          </span>
                          <span className="flex-1 min-w-0">
                            <span className="block truncate font-medium">{agent.name}</span>
                            {kindPreset ? (
                              <span
                                className={`block truncate text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
                              >
                                {kindPreset.shortLabel}
                              </span>
                            ) : null}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={cancelAssignmentMove}>
                {t('common.close')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </section>

      {/* Activity strip — independent shrink-0 sibling of the kanban section
        inside motion.main's flex-col. Lives outside <section> so its layout
        is fully decoupled: motion.main reserves activity's natural height
        first, kanban gets the remainder via flex-1. Activity is never
        clipped, regardless of how many cards or how tall the columns get. */}
      <BoardMetricsStrip isDark={isDark} tasks={tasks} agents={agents ?? EMPTY_AGENTS} />
    </>
  );
}

// Memoized: parent TaskBoard re-renders on every drag-over `setColumns`, but
// this strip only depends on `tasks` / `agents` / `isDark`. Recharts'
// ResponsiveContainer is sensitive to high-frequency re-renders of its
// containing tree (ResizeObserver feedback), so we isolate it here. The
// internal data builders are also memoized below to keep recharts' data prop
// referentially stable across cosmetic re-renders.
const BoardMetricsStrip = memo(function BoardMetricsStrip({
  isDark,
  tasks,
  agents,
}: {
  isDark: boolean;
  tasks: TaskDTO[];
  agents: AgentDTO[];
}) {
  const { t } = useI18n();
  const completed = useMemo(() => tasks.filter((task) => task.status === 'completed').length, [tasks]);
  const running = useMemo(
    () => tasks.filter((task) => task.status === 'running' || task.status === 'review').length,
    [tasks],
  );
  const efficiency = tasks.length > 0 ? Math.round((completed / tasks.length) * 100) : 0;
  const activeAgents = useMemo(
    () =>
      agents.filter(
        (agent) => agent.presence?.status === 'online' || agent.status === 'online' || agent.status === 'busy',
      ).length,
    [agents],
  );
  const velocity = Math.max(0, completed + Math.ceil(running / 2));
  const recent = useMemo(
    () =>
      tasks
        .slice()
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .slice(0, 3),
    [tasks],
  );
  const trendData = useMemo(() => buildTaskTrendData(tasks), [tasks]);
  const agentStatusData = useMemo(() => buildAgentStatusData(agents), [agents]);

  return (
    <div
      // Single-row 4-col grid from md+ so the strip stays ~130px tall
      // instead of the 2×2 stacked ~230px it had on md→xl screens. Keeps
      // the kanban column area dominant in the viewport.
      className={`mx-5 mb-4 grid shrink-0 gap-3 overflow-hidden rounded-2xl border px-4 py-3 md:grid-cols-[minmax(260px,1.35fr)_minmax(180px,1fr)_minmax(180px,1fr)_minmax(180px,1fr)] ${
        isDark ? 'border-white/[0.06] bg-white/[0.025]' : 'border-zinc-200/80 bg-white/75'
      }`}
    >
      <div className="min-w-0 overflow-hidden">
        <p className={`text-[10px] font-semibold ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
          {t('workspace.taskBoard.activity')}
        </p>
        <div className="mt-2 grid max-h-[88px] gap-1.5 overflow-hidden">
          {recent.length > 0 ? (
            recent.map((task) => (
              <div
                key={task.id}
                className="grid min-w-0 grid-cols-[54px_14px_minmax(0,1fr)] items-center gap-2 text-[11px]"
              >
                <span className={`tabular-nums ${isDark ? 'text-zinc-600' : 'text-zinc-500'}`}>
                  {formatActivityTime(task.updatedAt)}
                </span>
                <span
                  className={`h-3.5 w-3.5 rounded-full ${task.status === 'completed' ? 'bg-emerald-300' : task.status === 'running' || task.status === 'review' ? 'bg-amber-300' : 'bg-zinc-300'}`}
                />
                <span className={`truncate ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>{task.title}</span>
              </div>
            ))
          ) : (
            <div className={`flex h-12 items-center text-[11px] ${isDark ? 'text-zinc-600' : 'text-zinc-500'}`}>
              {t('workspace.taskBoard.noActivityYet')}
            </div>
          )}
        </div>
      </div>
      <MetricTrend
        isDark={isDark}
        label={t('workspace.taskBoard.teamEfficiency')}
        value={`${efficiency}%`}
        detail={`${completed}/${tasks.length} completed`}
        tone="emerald"
        data={trendData}
        dataKey="efficiency"
        unit="%"
      />
      <MetricTrend
        isDark={isDark}
        label={t('workspace.taskBoard.tasksVelocity')}
        value={`${velocity}`}
        detail={`${trendData.at(-1)?.updated ?? 0} ${t('workspace.taskBoard.updatedToday')}`}
        tone="violet"
        data={trendData}
        dataKey="updated"
      />
      <AgentStatusChart
        isDark={isDark}
        label={t('workspace.taskBoard.activeAgents')}
        activeAgents={activeAgents}
        totalAgents={agents.length}
        data={agentStatusData}
      />
    </div>
  );
});

function MetricTrend({
  isDark,
  label,
  value,
  detail,
  tone,
  data,
  dataKey,
  unit,
}: {
  isDark: boolean;
  label: string;
  value: string;
  detail: string;
  tone: 'emerald' | 'violet';
  data: TaskTrendPoint[];
  dataKey: 'efficiency' | 'updated';
  unit?: string;
}) {
  const stroke = tone === 'emerald' ? '#6ee7a8' : tone === 'violet' ? '#a78bfa' : '#38bdf8';
  const text = tone === 'emerald' ? 'text-emerald-500' : tone === 'violet' ? 'text-violet-500' : 'text-sky-500';
  return (
    <div className="grid min-w-0 grid-cols-[minmax(84px,0.55fr)_minmax(96px,1fr)] items-center gap-3 overflow-hidden">
      <div className="min-w-0">
        <p className={`truncate text-[10px] font-medium ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>{label}</p>
        <p className={`mt-1 text-lg font-bold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>{value}</p>
        <p className={`truncate text-[10px] font-semibold ${text}`}>{detail}</p>
      </div>
      <div className="h-14 min-w-0 overflow-hidden">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 6, right: 4, bottom: 0, left: 4 }}>
            <XAxis dataKey="label" hide />
            <YAxis hide domain={[0, dataKey === 'efficiency' ? 100 : 'dataMax + 1']} />
            <Tooltip
              cursor={false}
              contentStyle={{
                borderRadius: 10,
                border: isDark ? '1px solid rgba(255,255,255,0.08)' : '1px solid rgb(228,228,231)',
                background: isDark ? 'rgba(24,24,27,0.96)' : 'rgba(255,255,255,0.96)',
                color: isDark ? '#e4e4e7' : '#18181b',
                fontSize: 11,
              }}
              formatter={(raw) => [`${raw}${unit ?? ''}`, label]}
              labelFormatter={(labelValue) => String(labelValue)}
            />
            <Line type="monotone" dataKey={dataKey} stroke={stroke} strokeWidth={3} dot={false} activeDot={{ r: 3 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function AgentStatusChart({
  isDark,
  label,
  activeAgents,
  totalAgents,
  data,
}: {
  isDark: boolean;
  label: string;
  activeAgents: number;
  totalAgents: number;
  data: AgentStatusPoint[];
}) {
  const { t } = useI18n();
  return (
    <div className="grid min-w-0 grid-cols-[minmax(84px,0.55fr)_minmax(96px,1fr)] items-center gap-3 overflow-hidden">
      <div className="min-w-0">
        <p className={`truncate text-[10px] font-medium ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>{label}</p>
        <p className={`mt-1 text-lg font-bold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
          {activeAgents}/{totalAgents}
        </p>
        <p className="truncate text-[10px] font-semibold text-sky-500">{t('workspace.taskBoard.currentStatus')}</p>
      </div>
      <div className="h-14 min-w-0 overflow-hidden">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 2, bottom: 0, left: 2 }}>
            <XAxis dataKey="label" hide />
            <YAxis hide allowDecimals={false} domain={[0, 'dataMax + 1']} />
            <Tooltip
              cursor={false}
              contentStyle={{
                borderRadius: 10,
                border: isDark ? '1px solid rgba(255,255,255,0.08)' : '1px solid rgb(228,228,231)',
                background: isDark ? 'rgba(24,24,27,0.96)' : 'rgba(255,255,255,0.96)',
                color: isDark ? '#e4e4e7' : '#18181b',
                fontSize: 11,
              }}
            />
            <Bar dataKey="count" radius={[6, 6, 0, 0]} maxBarSize={18}>
              {data.map((entry) => (
                <Cell key={entry.label} fill={entry.color} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

interface TaskTrendPoint {
  key: string;
  label: string;
  updated: number;
  completed: number;
  efficiency: number;
}

interface AgentStatusPoint {
  label: string;
  count: number;
  color: string;
}

function buildTaskTrendData(tasks: TaskDTO[]): TaskTrendPoint[] {
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - (6 - index));
    const key = date.toISOString().slice(0, 10);
    return {
      key,
      label: date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      updated: 0,
      completed: 0,
      efficiency: 0,
    };
  });
  const byKey = new Map(days.map((day) => [day.key, day]));
  for (const task of tasks) {
    const updatedKey = dateKey(task.updatedAt);
    const updatedBucket = updatedKey ? byKey.get(updatedKey) : null;
    if (updatedBucket) updatedBucket.updated += 1;
    const completedKey = task.completedAt
      ? dateKey(task.completedAt)
      : task.status === 'completed'
        ? dateKey(task.updatedAt)
        : null;
    const completedBucket = completedKey ? byKey.get(completedKey) : null;
    if (completedBucket) completedBucket.completed += 1;
  }

  let cumulativeUpdated = 0;
  let cumulativeCompleted = 0;
  return days.map((day) => {
    cumulativeUpdated += day.updated;
    cumulativeCompleted += day.completed;
    return {
      ...day,
      efficiency: cumulativeUpdated > 0 ? Math.round((cumulativeCompleted / cumulativeUpdated) * 100) : 0,
    };
  });
}

function buildAgentStatusData(agents: AgentDTO[]): AgentStatusPoint[] {
  const counts = { online: 0, busy: 0, offline: 0 };
  for (const agent of agents) {
    const status = agent.presence?.status || agent.status;
    if (status === 'online') counts.online += 1;
    else if (status === 'busy') counts.busy += 1;
    else counts.offline += 1;
  }
  return [
    { label: 'Online', count: counts.online, color: '#38bdf8' },
    { label: 'Busy', count: counts.busy, color: '#a78bfa' },
    { label: 'Offline', count: counts.offline, color: '#a1a1aa' },
  ];
}

function dateKey(iso: string): string | null {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString().slice(0, 10);
}

function formatActivityTime(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return '';
  return new Date(time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
