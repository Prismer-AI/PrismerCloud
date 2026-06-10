/**
 * Shared types + constants for the kanban TaskBoard.
 *
 * Extracted from the (formerly monolithic) `task-board.tsx` to keep
 * each sibling file under ~500 lines. All public re-exports live at
 * `./index.tsx`.
 */

import type { ReactNode } from 'react';
import type { TranslationKey } from '@/lib/i18n';
import type { KanbanColumnKey, TaskDTO, AgentDTO, AssetDTO } from '../../lib/types';
import type { TaskStatus } from '../../lib/mutations';
import type { AgentLiveStatus } from '../../lib/agent-status';

// ─── Public props ─────────────────────────────────────────────────

export interface TaskBoardProps {
  isDark: boolean;
  tasks: TaskDTO[];
  loading: boolean;
  error: string | null;
  agents?: AgentDTO[];
  /** Task 3 — workspace-wide agent live status map (from page.tsx). */
  agentStatuses?: Map<string, AgentLiveStatus>;
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

// ─── Column ↔ wire-status mapping (v2.0 state machine) ────────────
//
// release 200 P3 finalised the state machine — TODO now maps to `assigned`
// (not `pending`); the assignee is required by the matrix on the server side.
// `backlog` is the only column that maps to `pending`, and only when the
// task has no assignee (otherwise it'd land in Todo). The drag handler
// blocks unassigned drops into Todo so we never see a snap-back.
export const columnToStatus: Record<KanbanColumnKey, TaskStatus> = {
  backlog: 'pending',
  todo: 'assigned',
  in_progress: 'running',
  review: 'review',
  blocked: 'blocked',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
};

export const EXECUTION_STATUS_WARNING_KEY = 'workspace:tasks:skip-execution-status-warning';
export const EXECUTION_STATUSES: ReadonlySet<string> = new Set(['assigned', 'running', 'review', 'completed']);

// Outcome columns are read-only terminal states: dropping INTO them or
// dragging cards OUT of `cancelled` is forbidden by the kanban contract.
// Wired into `useDroppable({ disabled })` per column AND into the
// `handleDragEnd` guard so neither dnd-kit nor the PATCH path can fire.
export const OUTCOME_COLUMNS: ReadonlySet<KanbanColumnKey> = new Set(['completed', 'failed', 'cancelled']);

// Stable empty array — passing `agents ?? []` inline allocates a fresh array on
// every render, which defeats `BoardMetricsStrip`'s React.memo and feeds new
// references into recharts on each parent re-render. During drag, that lands
// inside ResponsiveContainer's ResizeObserver loop and trips React's max-depth
// guard. Use this shared sentinel instead.
export const EMPTY_AGENTS: AgentDTO[] = [];

// ─── Per-column sort ───────────────────────────────────────────────

export type ColumnSort = 'kanban' | 'priority' | 'updated' | 'title' | 'completed_desc';

export const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

export interface SortOption {
  value: ColumnSort;
  labelKey: TranslationKey;
  icon: ReactNode;
}

// ─── Drag state types ────────────────────────────────────────────

export interface PendingExecutionMove {
  task: TaskDTO;
  fromCol: KanbanColumnKey | null;
  toCol: KanbanColumnKey;
  targetStatus: TaskStatus;
  assigneeId?: string | null;
  /**
   * B-tree midpoint for the drop slot, computed at drag-end time. Forwarded
   * to `/transition` so the server stores the new ordering atomically with
   * the status change.
   */
  position?: number;
}

// User dragged an unassigned task into a column that requires an assignee
// (`todo` or `in_progress`). Instead of toasting an error and snapping
// back, we open an inline assignee picker — pick + move in one motion.
export interface PendingAssignmentMove {
  task: TaskDTO;
  fromCol: KanbanColumnKey | null;
  toCol: KanbanColumnKey;
  targetStatus: TaskStatus;
  position?: number;
}

export interface TaskOverride {
  task: TaskDTO;
  expiresAt: number;
}

export type KanbanMovePlan =
  | { blocked: 'workspace.taskBoard.assignBeforeTodo' | 'workspace.taskBoard.assignBeforeInProgress' }
  | {
      targetStatus: TaskStatus;
      assigneeId?: string | null;
    };

// ─── BoardMetricsStrip data shapes ───────────────────────────────

export interface TaskTrendPoint {
  key: string;
  label: string;
  updated: number;
  completed: number;
  efficiency: number;
}

export interface AgentStatusPoint {
  label: string;
  count: number;
  color: string;
}

// ─── Column droppable wrapper props ──────────────────────────────

export interface KanbanColumnProps {
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

// ─── Column tint palette ─────────────────────────────────────────

export const columnTint: Record<
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
  blocked: {
    // Orange tint signals "needs human attention" — distinct from amber
    // (in_progress) so a quick glance separates "running" from "stuck".
    bg: 'bg-orange-500/[0.05]',
    darkTop: 'rgba(249,115,22,0.10)',
    darkBottom: 'rgba(249,115,22,0.02)',
    lightTop: 'rgba(249,115,22,0.10)',
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
