/**
 * Pure helpers for the kanban TaskBoard — column bucketing, sort, midpoint
 * positioning, status-machine planning, error formatting, localStorage
 * preferences, BoardMetricsStrip data builders, dnd-kit collision tuning.
 *
 * Extracted from `task-board.tsx` so the orchestration file stays focused
 * on hooks + JSX. All functions here are pure / side-effect-bounded (the
 * read/writeSkipExecutionWarning pair is the only stateful exception, and
 * it touches localStorage only).
 */

import { pointerWithin, closestCenter, type CollisionDetection } from '@dnd-kit/core';

import { KANBAN_COLUMNS, bucketTask, type TaskDTO, type KanbanColumnKey, type AgentDTO } from '../../lib/types';
import { readTaskPriority } from '../../lib/design';
import type { TaskStatus } from '../../lib/mutations';

import {
  columnToStatus,
  EXECUTION_STATUS_WARNING_KEY,
  EXECUTION_STATUSES,
  PRIORITY_ORDER,
  type ColumnSort,
  type KanbanMovePlan,
  type TaskTrendPoint,
  type AgentStatusPoint,
} from './types';

export const COLUMN_IDS: ReadonlySet<string> = new Set(KANBAN_COLUMNS.map((c) => c.key));

// ─── Kanban column + ordering (release 200 P5) ─────────────────────
//
// Before P5 the board read `metadata.kanban.{columnId,cardStatus,cardOrder}`
// to recover the column + intra-column order. P3 promoted `position` to a
// real `IMTask.position` DOUBLE column (migration 342 + backfill 345) and
// finalised the state-machine matrix; the metadata.kanban.* triple is no
// longer written. We still tolerate legacy rows where status === 'pending'
// AND assigneeId is set (the v1 representation of Todo) by routing them to
// 'todo' visually — once the user drags the card the server normalises to
// 'assigned' on its own.

export function taskKanbanColumn(task: TaskDTO): KanbanColumnKey | null {
  // `bucketTask` already encodes the post-P3 status→column mapping
  // (pending+assignee → todo, assigned → todo, etc.) so we delegate
  // wholesale. Kept as a thin wrapper to preserve the call-site name.
  return bucketTask(task);
}

export function taskKanbanPriority(task: TaskDTO): string {
  return readTaskPriority(task);
}

export function taskKanbanPosition(task: TaskDTO): number | null {
  return typeof task.position === 'number' && Number.isFinite(task.position) ? task.position : null;
}

export function compareKanbanOrder(a: TaskDTO, b: TaskDTO): number {
  const pa = taskKanbanPosition(a);
  const pb = taskKanbanPosition(b);
  if (pa !== null && pb !== null && pa !== pb) return pa - pb;
  if (pa !== null) return -1;
  if (pb !== null) return 1;
  // Fallback for rows without a position (e.g. legacy rows that escaped
  // the backfill, or freshly-created tasks pre-position-write). updatedAt
  // DESC keeps the "most-recent on top" UX consistent with v1.
  return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
}

/**
 * B-tree midpoint position for kanban reorder. `neighbors` is the same-column
 * list (sorted by `position` ASC, excluding the dragged task); `targetIndex`
 * is the drop slot (`0` = top, `neighbors.length` = bottom).
 *
 * The midpoint rule keeps writes O(1) instead of renumbering siblings:
 *   - empty column                  → `0`
 *   - dropped above first item      → `first.position - 1`
 *   - dropped below last item       → `last.position + 1`
 *   - dropped between a and b       → `(a.position + b.position) / 2`
 *
 * Adjacent .position values can converge over many reorders (Brent's bound:
 * 53 midpoints before doubles lose precision). The server is free to
 * renumber a column when min-gap falls below epsilon; that's out of scope
 * for P5.
 */
export function computeKanbanPosition(neighbors: TaskDTO[], targetIndex: number): number {
  if (neighbors.length === 0) return 0;
  if (targetIndex <= 0) {
    const first = taskKanbanPosition(neighbors[0]) ?? 0;
    return first - 1;
  }
  if (targetIndex >= neighbors.length) {
    const last = taskKanbanPosition(neighbors[neighbors.length - 1]) ?? 0;
    return last + 1;
  }
  const a = taskKanbanPosition(neighbors[targetIndex - 1]) ?? 0;
  const b = taskKanbanPosition(neighbors[targetIndex]) ?? 0;
  return (a + b) / 2;
}

export function sortTasks(tasks: TaskDTO[], sort: ColumnSort): TaskDTO[] {
  const arr = [...tasks];
  switch (sort) {
    case 'priority':
      arr.sort((a, b) => {
        const pa = PRIORITY_ORDER[taskKanbanPriority(a)] ?? 99;
        const pb = PRIORITY_ORDER[taskKanbanPriority(b)] ?? 99;
        if (pa !== pb) return pa - pb;
        return compareKanbanOrder(a, b);
      });
      break;
    case 'kanban':
      arr.sort(compareKanbanOrder);
      break;
    case 'updated':
      arr.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      break;
    case 'title':
      arr.sort((a, b) => (a.title ?? '').localeCompare(b.title ?? ''));
      break;
    case 'completed_desc':
      // DONE timeline — most-recently-finished first. Falls back to
      // updatedAt when completedAt is missing (legacy rows).
      arr.sort((a, b) => {
        const ca = a.completedAt ? Date.parse(a.completedAt) : Date.parse(a.updatedAt);
        const cb = b.completedAt ? Date.parse(b.completedAt) : Date.parse(b.updatedAt);
        return cb - ca;
      });
      break;
  }
  return arr;
}

// ─── Collision tuned for kanban (cards over columns) ────────────────

export const kanbanCollision: CollisionDetection = (args) => {
  const pointer = pointerWithin(args);
  if (pointer.length > 0) {
    const cards = pointer.filter((c) => !COLUMN_IDS.has(String(c.id)));
    if (cards.length > 0) return cards;
  }
  return closestCenter(args);
};

// ─── Column bucketing ──────────────────────────────────────────────

export function bucketAll(tasks: TaskDTO[]): Record<KanbanColumnKey, TaskDTO[]> {
  const cols: Record<KanbanColumnKey, TaskDTO[]> = {
    backlog: [],
    todo: [],
    in_progress: [],
    review: [],
    blocked: [],
    completed: [],
    failed: [],
    cancelled: [],
  };
  for (const task of tasks) {
    const col = taskKanbanColumn(task);
    if (col) cols[col].push(task);
  }
  return cols;
}

export function findColumn(cols: Record<KanbanColumnKey, TaskDTO[]>, id: string): KanbanColumnKey | null {
  if (COLUMN_IDS.has(id)) return id as KanbanColumnKey;
  for (const key of Object.keys(cols) as KanbanColumnKey[]) {
    if (cols[key].some((t) => t.id === id)) return key;
  }
  return null;
}

export function findDropColumn(cols: Record<KanbanColumnKey, TaskDTO[]>, overId: string): KanbanColumnKey | null {
  if (COLUMN_IDS.has(overId)) return overId as KanbanColumnKey;
  return findColumn(cols, overId);
}

export function replaceTaskInColumns(
  cols: Record<KanbanColumnKey, TaskDTO[]>,
  task: TaskDTO,
  targetCol: KanbanColumnKey | null,
): Record<KanbanColumnKey, TaskDTO[]> {
  const next: Record<KanbanColumnKey, TaskDTO[]> = {
    backlog: cols.backlog.filter((t: TaskDTO) => t.id !== task.id),
    todo: cols.todo.filter((t: TaskDTO) => t.id !== task.id),
    in_progress: cols.in_progress.filter((t: TaskDTO) => t.id !== task.id),
    review: cols.review.filter((t: TaskDTO) => t.id !== task.id),
    blocked: cols.blocked.filter((t: TaskDTO) => t.id !== task.id),
    completed: cols.completed.filter((t: TaskDTO) => t.id !== task.id),
    failed: cols.failed.filter((t: TaskDTO) => t.id !== task.id),
    cancelled: cols.cancelled.filter((t: TaskDTO) => t.id !== task.id),
  };
  if (!targetCol) return next;
  next[targetCol] = [...next[targetCol], task];
  return next;
}

// ─── Execution-state move planning ─────────────────────────────────

export function shouldConfirmExecutionMove(
  task: TaskDTO,
  fromCol: KanbanColumnKey | null,
  toCol: KanbanColumnKey,
): boolean {
  if (fromCol === toCol) return false;
  const targetStatus = columnToStatus[toCol];
  if (targetStatus === task.status && toCol !== 'backlog') return false;
  return EXECUTION_STATUSES.has(task.status) || EXECUTION_STATUSES.has(targetStatus);
}

export function resolveKanbanMovePlan(
  task: TaskDTO,
  _fromCol: KanbanColumnKey | null,
  toCol: KanbanColumnKey,
): KanbanMovePlan {
  if (toCol === 'backlog') {
    // Backlog == unassigned + pending. Server-side transition matrix only
    // allows {pending,assigned,blocked,review} → pending; the assigneeId:null
    // is what differentiates "back to pool" from a reassign.
    return {
      targetStatus: 'pending',
      assigneeId: null,
    };
  }
  if (toCol === 'todo') {
    // v2.0: Todo == 'assigned'. Server requires an assignee for this status.
    if (!task.assigneeId) {
      return { blocked: 'workspace.taskBoard.assignBeforeTodo' };
    }
    return {
      targetStatus: 'assigned',
      assigneeId: task.assigneeId,
    };
  }
  if (toCol === 'in_progress') {
    if (!task.assigneeId) {
      return { blocked: 'workspace.taskBoard.assignBeforeInProgress' };
    }
    return {
      targetStatus: 'running',
      assigneeId: task.assigneeId,
    };
  }
  if (toCol === 'review') {
    return {
      targetStatus: 'review',
      assigneeId: task.assigneeId ?? undefined,
    };
  }
  if (toCol === 'blocked') {
    // `blocked` requires assignee (matrix §5.2). Without one, the server
    // would refuse the transition — so we route the user through the
    // assignee picker the same way `todo` / `in_progress` does.
    if (!task.assigneeId) {
      return { blocked: 'workspace.taskBoard.assignBeforeInProgress' };
    }
    return {
      targetStatus: 'blocked',
      assigneeId: task.assigneeId,
    };
  }
  // Drops into completed/failed/cancelled are blocked upstream (OUTCOME_COLUMNS).
  // Defensive default for any column we haven't accounted for above.
  return {
    targetStatus: 'completed',
    assigneeId: task.assigneeId ?? undefined,
  };
}

/**
 * Turn a `/transition` failure into a user-readable string. P3's error
 * envelope carries structured fields (allowedFromHere / requiredTiers) on
 * `result.raw.error`; we surface them when present, otherwise we fall back
 * to the generic message.
 */
export function describeTransitionError(
  res: { ok: false; status: number; error: string; message: string; raw?: unknown },
  fallback: string,
): string {
  const env = res.raw && typeof res.raw === 'object' ? (res.raw as { error?: unknown }).error : undefined;
  if (env && typeof env === 'object') {
    const code = (env as { code?: string }).code;
    if (code === 'invalid-transition') {
      const allowed = (env as { allowedFromHere?: string[] }).allowedFromHere ?? [];
      const fromTo = `${(env as { from?: string }).from ?? '?'} → ${(env as { to?: string }).to ?? '?'}`;
      if (allowed.length > 0) {
        return `无法从 ${fromTo} 直接转换;允许的下一步:${allowed.join(' / ')}`;
      }
      return `状态转换 ${fromTo} 被状态机拒绝`;
    }
    if (code === 'forbidden') {
      const required = (env as { requiredTiers?: string[] }).requiredTiers ?? [];
      const actor = (env as { actorTier?: string }).actorTier;
      if (required.length > 0) {
        return `没有权限做这个操作(需要 ${required.join('/')} 角色,当前 ${actor ?? '未知'})`;
      }
      return '没有权限做这个操作';
    }
  }
  return fallback;
}

// ─── localStorage preferences ─────────────────────────────────────

export function readSkipExecutionWarning(): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(EXECUTION_STATUS_WARNING_KEY) === 'true';
}

export function writeSkipExecutionWarning(skip: boolean): void {
  if (typeof window === 'undefined') return;
  if (skip) window.localStorage.setItem(EXECUTION_STATUS_WARNING_KEY, 'true');
  else window.localStorage.removeItem(EXECUTION_STATUS_WARNING_KEY);
}

// ─── BoardMetricsStrip data builders ─────────────────────────────

export function buildTaskTrendData(tasks: TaskDTO[]): TaskTrendPoint[] {
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

export function buildAgentStatusData(
  agents: AgentDTO[],
  labels: { online: string; busy: string; offline: string },
): AgentStatusPoint[] {
  const counts = { online: 0, busy: 0, offline: 0 };
  for (const agent of agents) {
    const status = agent.presence?.status || agent.status;
    if (status === 'online') counts.online += 1;
    else if (status === 'busy') counts.busy += 1;
    else counts.offline += 1;
  }
  return [
    { label: labels.online, count: counts.online, color: '#38bdf8' },
    { label: labels.busy, count: counts.busy, color: '#a78bfa' },
    { label: labels.offline, count: counts.offline, color: '#a1a1aa' },
  ];
}

export function dateKey(iso: string): string | null {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString().slice(0, 10);
}

export function formatActivityTime(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return '';
  return new Date(time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// ─── SSR-safe layout effect ──────────────────────────────────────

// Next.js warns when useLayoutEffect runs on the server (no DOM, no layout).
// Fall back to useEffect during SSR; on the client we still get the
// synchronous-before-paint behavior the portal-positioning math needs.
// Re-exported for the ColumnFilter portal in kanban-column.tsx.
import { useEffect, useLayoutEffect } from 'react';
export const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;
