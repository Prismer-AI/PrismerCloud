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
 *
 * v2.0.8 H2 — split out of a 1879-line monolith. This file owns the
 * top-level render + a couple of derived memos; DnD logic lives in
 * `./use-kanban-dnd`, dialogs / column / strip / helpers / config live
 * in sibling files.
 */

import { useCallback, useMemo, useState } from 'react';
import { DndContext, DragOverlay } from '@dnd-kit/core';
import { Loader2, AlertTriangle, Trash2 } from 'lucide-react';

import { useI18n } from '@/contexts/i18n-context';
import { TaskCard } from '../task-card';
import { SurfaceHeader } from '../surface-header';
import { type AssetDTO, type KanbanColumnKey } from '../../lib/types';
import { classifyAgent, type AgentKind } from '../../lib/agent-kind';
import { surface, radius } from '../../lib/design';

import { EMPTY_AGENTS, type TaskBoardProps } from './types';
import { kanbanCollision } from './helpers';
import { KanbanColumn } from './kanban-column';
import { BoardMetricsStrip } from './board-metrics-strip';
import { AssigneePickerDialog, ExecutionMoveDialog } from './dialogs';
import { buildKanbanColumns } from './column-config';
import { useKanbanDnd } from './use-kanban-dnd';

// Re-exports for backward compat. Tests + callers import these from
// `'./task-board'`; the index file is the public surface now.
export { computeKanbanPosition } from './helpers';
export type { TaskBoardProps } from './types';

export function TaskBoard({
  isDark,
  tasks,
  loading,
  error,
  agents,
  agentStatuses,
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
  const [showRecycleBin, setShowRecycleBin] = useState(false);
  const kanbanColumns = useMemo(() => buildKanbanColumns(t, showRecycleBin), [showRecycleBin, t]);
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

  // Map imUserId → role slug (agentType), so cards can pick a role-specific
  // icon (Crown / Wrench / Megaphone / …) instead of the fallback Bot.
  // Built alongside agentKindByImUserId rather than merged so each lookup
  // stays a flat O(1) read and the two responsibilities (adapter kind vs
  // org role) don't entangle.
  const agentTypeByImUserId = useMemo<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const a of agents ?? []) {
      if (a.agentType) out[a.userId] = a.agentType;
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

  // All DnD orchestration (optimistic columns, drag handlers, dialog
  // confirm/cancel) lives in this hook. Returns a ready-to-use bundle.
  const dnd = useKanbanDnd({ tasks, notify, onTaskChanged, getColumnLabel, t });

  const pendingAgentKind = dnd.pendingExecutionMove?.task.assigneeId
    ? agentKindByImUserId[dnd.pendingExecutionMove.task.assigneeId]
    : undefined;
  const pendingTargetLabel = dnd.pendingExecutionMove ? getColumnLabel(dnd.pendingExecutionMove.toCol) : null;

  // Total count for the header
  const totalTasks = tasks.length;

  // Lifted out of the JSX so KanbanColumn can render the cards itself (it
  // owns the SortableContext + sort) without TaskBoard having to thread
  // every TaskCard prop through. Memoized to keep card identity stable
  // across cosmetic re-renders.
  const renderTaskCard = useCallback(
    (task: TaskBoardProps['tasks'][number]) => (
      <TaskCard
        isDark={isDark}
        task={task}
        agents={agents}
        agentKindByImUserId={agentKindByImUserId}
        agentTypeByImUserId={agentTypeByImUserId}
        agentStatuses={agentStatuses}
        taskAssets={assetsByTaskId.get(task.id)}
        // Wave-8 W1 / L3: pass the full workspace asset list so the
        // CardEditPopover's `#filename` picker can build `assetRefs[]`
        // for any URIs the user inserts at save time.
        workspaceAssets={assets}
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
      agentTypeByImUserId,
      agentStatuses,
      assets,
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
      <section data-launch-tour-anchor="task-board" className="flex min-w-0 flex-1 min-h-0 flex-col">
        <SurfaceHeader
          isDark={isDark}
          title={t('workspace.taskBoard.title')}
          subtitle={t('workspace.taskBoard.subtitle', { count: totalTasks })}
          actions={
            <button
              type="button"
              onClick={() => setShowRecycleBin((v) => !v)}
              title={showRecycleBin ? t('workspace.taskBoard.hideRecycleBin') : t('workspace.taskBoard.showRecycleBin')}
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
              <span>{t('workspace.taskBoard.recycleBin')}</span>
              {showRecycleBin ? <span className="opacity-70">·{t('workspace.taskBoard.recycleBinOn')}</span> : null}
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
                className={`flex flex-1 min-w-[340px] flex-col border ${radius.pane} ${surface.pane[theme]} p-3 space-y-3`}
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
            sensors={dnd.sensors}
            collisionDetection={kanbanCollision}
            onDragStart={dnd.handleDragStart}
            onDragOver={dnd.handleDragOver}
            onDragEnd={dnd.handleDragEnd}
            onDragCancel={dnd.handleDragCancel}
          >
            <div className="flex flex-1 min-h-0 gap-3 overflow-x-auto overflow-y-hidden p-5">
              {kanbanColumns.map((col, idx) => {
                const items = dnd.columns[col.key];
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
              {dnd.activeTask ? (
                <div className="w-[340px] pointer-events-none">
                  <TaskCard
                    isDark={isDark}
                    task={dnd.activeTask}
                    agentKindByImUserId={agentKindByImUserId}
                    agentTypeByImUserId={agentTypeByImUserId}
                    asOverlay
                    isDragging
                  />
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        )}

        <ExecutionMoveDialog
          isDark={isDark}
          theme={theme}
          pendingExecutionMove={dnd.pendingExecutionMove}
          pendingTargetLabel={pendingTargetLabel}
          pendingAgentKind={pendingAgentKind}
          skipFutureExecutionWarnings={dnd.skipFutureExecutionWarnings}
          setSkipFutureExecutionWarnings={dnd.setSkipFutureExecutionWarnings}
          getColumnLabel={getColumnLabel}
          onConfirm={dnd.confirmPendingExecutionMove}
          onCancel={dnd.cancelPendingExecutionMove}
        />

        {/* Assignee picker — opens when user drags an unassigned task into a
          column that requires an assignee. Pick + status change in one
          motion, no toast-then-retry friction. */}
        <AssigneePickerDialog
          isDark={isDark}
          theme={theme}
          pendingAssignmentMove={dnd.pendingAssignmentMove}
          agents={agents}
          onPick={dnd.completeAssignmentMove}
          onCancel={dnd.cancelAssignmentMove}
        />
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
