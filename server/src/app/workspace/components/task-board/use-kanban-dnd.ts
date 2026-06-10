'use client';

/**
 * useKanbanDnd — encapsulates the DnD orchestration for the kanban board.
 *
 * Pulled out of `index.tsx` (which sat at ~680 lines pre-extraction) to
 * keep the orchestration component slim. Owns:
 *   - the optimistic `columns` state (bucketed view of `tasks`)
 *   - all dnd-kit callbacks (drag start / over / end / cancel)
 *   - the two pending-move dialogs' state (execution warning + assignee
 *     picker) + their confirm/cancel handlers
 *
 * Returns a fully wired-up bundle the parent feeds to `<DndContext>` and
 * to `<ExecutionMoveDialog>` / `<AssigneePickerDialog>`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from '@dnd-kit/core';

import type { TranslationKey } from '@/lib/i18n';
import type { TaskDTO, KanbanColumnKey } from '../../lib/types';
import { transitionTask, type TaskStatus } from '../../lib/mutations';

import {
  COLUMN_IDS,
  bucketAll,
  computeKanbanPosition,
  describeTransitionError,
  findColumn,
  findDropColumn,
  readSkipExecutionWarning,
  replaceTaskInColumns,
  resolveKanbanMovePlan,
  shouldConfirmExecutionMove,
  sortTasks,
  taskKanbanColumn,
  writeSkipExecutionWarning,
} from './helpers';
import { OUTCOME_COLUMNS, type PendingAssignmentMove, type PendingExecutionMove, type TaskOverride } from './types';

interface UseKanbanDndArgs {
  tasks: TaskDTO[];
  notify?: (message: string, type: 'success' | 'error' | 'info') => void;
  onTaskChanged?: () => void;
  getColumnLabel: (column: KanbanColumnKey) => string;
  t: (key: TranslationKey, values?: Record<string, string | number>) => string;
}

export function useKanbanDnd({ tasks, notify, onTaskChanged, getColumnLabel, t }: UseKanbanDndArgs) {
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
    for (const task of tasks) m.set(task.id, task);
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
          const found = list.find((task) => task.id === id);
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

      const moving = prev[fromCol].find((task) => task.id === activeId);
      if (!moving) return prev;

      const fromList = prev[fromCol].filter((task) => task.id !== activeId);
      const toList = [...prev[toCol]];
      const overIndex = toList.findIndex((task) => task.id === overId);
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
      // v2.0 P5 — go through the unified state-machine endpoint. The server
      // validates the TRANSITIONS matrix and persists `position` atomically.
      // The legacy updateTask({status, metadata.kanban.*}) path is still
      // accepted by the server (deprecated in P8) but no new code calls it.
      const res = await transitionTask(move.task.id, {
        to: move.targetStatus,
        assigneeId: move.assigneeId,
        position: move.position,
        reason,
      });
      if (!res.ok) {
        notify?.(describeTransitionError(res, t('workspace.taskBoard.moveFailed', { message: res.message })), 'error');
        setColumns(bucketAll(tasks));
        return;
      }

      const updatedTask = res.data;
      committedTaskOverridesRef.current.set(updatedTask.id, {
        task: updatedTask,
        expiresAt: Date.now() + 15_000,
      });
      const actualCol = taskKanbanColumn(updatedTask);
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

      const originalCol = taskKanbanColumn(original);
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
        notify?.(t('workspace.taskBoard.outcomeColumnLocked'), 'info');
        return;
      }

      if (targetCol !== finalCol) {
        setColumns((prev) => {
          const next = replaceTaskInColumns(prev, original, targetCol);
          columnsRef.current = next;
          return next;
        });
      }

      // Compute the B-tree midpoint position for the new column. We look
      // at the optimistic column state (`columnsRef.current[targetCol]`)
      // because the user dropped onto a visual slot, not a server slot —
      // dnd-kit's drag-over already moved the card there in our local copy.
      const sortedNeighbors = sortTasks(
        (columnsRef.current[targetCol] ?? []).filter((task) => task.id !== original.id),
        'kanban',
      );
      // If the drag ended on a column drop-zone (not a card), put the task
      // at the bottom. Otherwise insert before the hovered card.
      const dropOverCardId = COLUMN_IDS.has(overId) ? null : overId;
      const dropIndex =
        dropOverCardId === null
          ? sortedNeighbors.length
          : Math.max(
              0,
              sortedNeighbors.findIndex((task) => task.id === dropOverCardId),
            );
      const position = computeKanbanPosition(sortedNeighbors, dropIndex);

      const plan = resolveKanbanMovePlan(original, originalCol, targetCol);
      if ('blocked' in plan) {
        // Drop into a column that requires an assignee (todo / in_progress)
        // but the task is unassigned — open the assignee picker dialog
        // instead of toasting an error. Pick + move happens in one flow.
        // v2.0 P5: Todo == 'assigned' (was 'pending+assignee' pre-P3).
        const targetStatus: TaskStatus = targetCol === 'in_progress' ? 'running' : 'assigned';
        setPendingAssignmentMove({
          task: original,
          fromCol: originalCol,
          toCol: targetCol,
          targetStatus,
          position,
        });
        return;
      }

      const move: PendingExecutionMove = {
        task: original,
        fromCol: originalCol,
        toCol: targetCol,
        targetStatus: plan.targetStatus,
        assigneeId: plan.assigneeId,
        position,
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
        position: move.position,
      });
    },
    [pendingAssignmentMove, performStatusMove],
  );

  const cancelAssignmentMove = useCallback(() => {
    setPendingAssignmentMove(null);
    setColumns(bucketAll(tasks));
  }, [tasks]);

  return {
    columns,
    activeTask,
    sensors,
    handleDragStart,
    handleDragOver,
    handleDragEnd,
    handleDragCancel,
    pendingExecutionMove,
    pendingAssignmentMove,
    skipFutureExecutionWarnings,
    setSkipFutureExecutionWarnings,
    confirmPendingExecutionMove,
    cancelPendingExecutionMove,
    completeAssignmentMove,
    cancelAssignmentMove,
  };
}
