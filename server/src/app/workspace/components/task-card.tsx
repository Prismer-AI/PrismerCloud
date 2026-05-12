'use client';

/**
 * /workspace TaskCard — Wave-7 ζ glass kanban card.
 *
 * Replaces the bare 132-line stack with a richer card layout matched to
 * Multica's board-card.tsx structure: ID badge, title, priority chip,
 * agent kind icon, avatar+initials gradient circle, optional progress
 * bar, footer with relative time + meta affordances.
 *
 * Drag-and-drop is wired by the parent `TaskBoard` via `useSortable`;
 * this component takes the resulting `isDragging` flag and lifts itself
 * accordingly. Clicking anywhere on the card fires `onOpen()`. The cancel
 * button stops propagation so it never triggers the drawer.
 */

import { useState, type CSSProperties, type MouseEvent } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { motion } from 'framer-motion';
import {
  Bot,
  User,
  MessageSquare,
  Coins,
  X,
  Terminal,
  Brain,
  Clock,
  MoreVertical,
  CircleDashed,
  Check,
  Paperclip,
  FileText,
  Pencil,
} from 'lucide-react';
import type { AgentDTO, AssetDTO, TaskDTO } from '../lib/types';
import {
  approveTask,
  cancelTask,
  isCancellableStatus,
  pauseTask,
  rejectTask,
  reopenTask,
  startTask,
  updateTask,
} from '../lib/mutations';
import { TaskCardActions } from './task-card-actions';
import { AGENT_KIND_PRESETS, type AgentKind } from '../lib/agent-kind';
import { useI18n } from '@/contexts/i18n-context';
import {
  surface,
  radius,
  springSnap,
  priorityAccent,
  readTaskPriority,
  avatarGradient,
  avatarInitials,
} from '../lib/design';

// ─── Public props ─────────────────────────────────────────────────

export interface TaskCardProps {
  isDark: boolean;
  task: TaskDTO;
  /** Lookup map { imUserId → AgentKind }; lets the card show CLI vs long-running glyph. */
  agentKindByImUserId?: Record<string, AgentKind>;
  /** Workspace agents — drives the W2-T1 reassign popover. Optional; if omitted, the menu hides. */
  agents?: AgentDTO[];
  /** Assets produced by this task — drives the W2-T2 artifact badge. Already filtered by sourceTaskId. */
  taskAssets?: AssetDTO[];
  /** Called after a successful cancel so the parent can refresh the list. */
  onChanged?: () => void;
  notify?: (message: string, type: 'success' | 'error' | 'info') => void;
  /** Click → open detail drawer. */
  onOpen?: () => void;
  /** W2-T2: route artifact clicks into the workspace inspector. */
  onOpenAsset?: (assetId: string) => void;
  /** Open the uploader with this task bound as the attachment source. */
  onUploadAttachment?: () => void;
  /** W2-T5: switch the workspace IM channel to this task's linked conversation. */
  onOpenConversation?: (conversationId: string) => void;
  /** Set true by the DragOverlay clone for elevation/tilt. */
  isDragging?: boolean;
  /** Hide internal sortable wiring — the DragOverlay clone uses this. */
  asOverlay?: boolean;
}

// ─── Card chrome ─────────────────────────────────────────────────

interface CardBodyProps extends Omit<TaskCardProps, 'isDragging' | 'asOverlay'> {
  cancelling: boolean;
  busyAction: boolean;
  onCancelClick: (e?: MouseEvent) => void;
  onStart: () => void;
  onPause: () => void;
  onApprove: () => void;
  onReject: () => void;
  onReopen: () => void;
  dragHandleProps?: Record<string, unknown>;
  isOverlay: boolean;
  isDraggingActive: boolean;
}

function CardBody({
  isDark,
  task,
  agents,
  agentKindByImUserId,
  taskAssets,
  onOpen,
  onOpenAsset,
  onUploadAttachment,
  onOpenConversation,
  notify,
  onChanged,
  cancelling,
  busyAction,
  onCancelClick,
  onStart,
  onPause,
  onApprove,
  onReject,
  onReopen,
  dragHandleProps,
  isOverlay,
  isDraggingActive,
}: CardBodyProps) {
  const theme: 'dark' | 'light' = isDark ? 'dark' : 'light';
  const { t } = useI18n();
  const idBadge = `T-${task.id.slice(-4).toUpperCase()}`;
  const priority = readTaskPriority(task);
  const priorityCfg = priorityAccent[priority];

  const progressPct =
    typeof task.progress === 'number' ? Math.round(Math.max(0, Math.min(1, task.progress)) * 100) : null;
  const taskBody = readTaskBody(task);

  const canCancel = isCancellableStatus(task.status);

  // W2-T1: ⋮ menu state. Two layers — overflow opens a small dropdown,
  // "Reassign…" inside swaps the dropdown for an agent picker without
  // closing it. ESC / outside-click closes both.
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [reassigning, setReassigning] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);
  const [editTitle, setEditTitle] = useState(task.title ?? '');
  const [editDescription, setEditDescription] = useState(task.description ?? '');
  // W2-T2: artifact popover state (1-click peek without entering the drawer).
  const [artifactOpen, setArtifactOpen] = useState(false);

  const artifactCount = taskAssets?.length ?? 0;
  const canReassign = (agents?.length ?? 0) > 0;

  const assigneeName = task.assigneeName ?? task.assigneeId?.slice(-8) ?? null;
  const assigneeSeed = task.assigneeName || task.assigneeId || task.id;
  const assigneeIsAgent = task.assigneeType === 'agent';

  const kind: AgentKind | null =
    assigneeIsAgent && task.assigneeId && agentKindByImUserId?.[task.assigneeId]
      ? agentKindByImUserId[task.assigneeId]
      : assigneeIsAgent
        ? 'cli'
        : null;
  const kindPreset = kind ? AGENT_KIND_PRESETS[kind] : null;

  const avatar = avatarGradient(assigneeSeed);
  const initials = avatarInitials(assigneeName ?? '?');

  const handleClick = (e: MouseEvent) => {
    if (cancelling) return;
    // Don't fire onOpen while dragging — pointer activation could leak.
    if (isDraggingActive) return;
    // Inline popovers (⋮ menu, artifact peek) handle their own clicks via
    // stopPropagation; this is a belt-and-braces guard for nested elements.
    if (menuOpen || pickerOpen || artifactOpen) return;
    if (editorOpen) return;
    e.preventDefault();
    onOpen?.();
  };

  async function handleSaveEdit() {
    if (savingEdit) return;
    const nextTitle = editTitle.trim();
    const nextDescription = editDescription.trim();
    if (!nextTitle) {
      notify?.(t('workspace.taskBoard.taskTitleRequired'), 'info');
      return;
    }
    setSavingEdit(true);
    const res = await updateTask(task.id, {
      title: nextTitle,
      description: nextDescription || null,
    });
    setSavingEdit(false);
    if (!res.ok) {
      notify?.(t('workspace.taskBoard.editFailed', { message: res.message }), 'error');
      return;
    }
    setEditorOpen(false);
    notify?.(t('workspace.taskBoard.editSaved'), 'success');
    onChanged?.();
  }

  async function handlePickAssignee(assigneeId: string | null) {
    if (reassigning) return;
    setReassigning(true);
    const res = await updateTask(task.id, { assigneeId });
    setReassigning(false);
    setPickerOpen(false);
    setMenuOpen(false);
    if (!res.ok) {
      const hint = res.status === 409 ? 'Cancel the run first or wait for it to finish.' : res.message;
      notify?.(`Couldn't reassign task: ${hint}`, 'error');
      return;
    }
    const newName =
      agents?.find((agent) => agent.userId === assigneeId)?.name ?? (assigneeId ? assigneeId.slice(-8) : 'unassigned');
    notify?.(`Task reassigned to ${newName}.`, 'success');
    onChanged?.();
  }

  return (
    <motion.article
      data-testid={`task-card-${task.id}`}
      data-task-priority={priority}
      onClick={handleClick}
      whileHover={isOverlay ? undefined : { y: -2 }}
      transition={springSnap}
      className={[
        // Fixed card size — uniform visual rhythm regardless of content.
        // `flex flex-col` + `mt-auto` on footer pins the avatar/time row to
        // the bottom; line-clamp on description/status caps text lines.
        'relative cursor-pointer border text-sm select-none',
        'h-[200px] flex flex-col',
        radius.card,
        surface.card[theme],
        'p-3 pr-2.5',
        'transition-[border-color,box-shadow] duration-200',
        isDark
          ? 'hover:border-violet-400/40 hover:shadow-[0_8px_30px_-10px_rgba(139,92,246,0.4)]'
          : 'hover:border-violet-400/60 hover:shadow-[0_8px_28px_-12px_rgba(139,92,246,0.3)]',
        isOverlay
          ? 'rotate-[1.5deg] scale-[1.03] shadow-[0_25px_60px_-15px_rgba(0,0,0,0.55)] ring-1 ring-violet-400/40'
          : '',
        isDraggingActive && !isOverlay ? 'opacity-40' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      {...(dragHandleProps ?? {})}
    >
      {/* Top row: ID badge + cancel */}
      <div className="flex items-start gap-2 shrink-0">
        <span
          className={`shrink-0 inline-flex items-center font-mono text-[10px] tracking-wider px-1.5 py-0.5 rounded-md border ${
            isDark ? 'border-white/10 bg-white/[0.04] text-zinc-400' : 'border-zinc-200 bg-zinc-50 text-zinc-500'
          }`}
          title={`Task ${task.id}`}
          data-testid={`task-card-drag-handle-${task.id}`}
        >
          {idBadge}
        </span>

        <h4
          className={`flex-1 min-w-0 font-medium leading-snug line-clamp-2 ${
            isDark ? 'text-zinc-100' : 'text-zinc-900'
          }`}
        >
          {task.title || 'Untitled task'}
        </h4>

        {/* W2-T1: ⋮ overflow — Edit / Reassign / Add attachment / Cancel.
            Cancel moved here from inline (X) button — high-frequency state
            transitions (Start/Pause/Approve/Reject/Reopen) now live on the
            TaskCardActions bar at the card foot. */}
        {canReassign ? (
          <div className="relative">
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                setMenuOpen((open) => !open);
                setPickerOpen(false);
                setArtifactOpen(false);
                setEditorOpen(false);
              }}
              title="More actions"
              data-testid={`task-more-${task.id}`}
              className={`shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-md transition-colors ${
                isDark
                  ? 'text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.06]'
                  : 'text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100'
              }`}
            >
              <MoreVertical className="w-3.5 h-3.5" />
            </button>
            {menuOpen ? (
              <CardOverflowMenu
                isDark={isDark}
                onEdit={() => {
                  setEditTitle(task.title ?? '');
                  setEditDescription(task.description ?? '');
                  setEditorOpen(true);
                  setMenuOpen(false);
                  setPickerOpen(false);
                  setArtifactOpen(false);
                }}
                onReassign={() => {
                  setPickerOpen(true);
                  setMenuOpen(false);
                }}
                onAddAttachment={() => {
                  setMenuOpen(false);
                  onUploadAttachment?.();
                }}
                onCancel={
                  canCancel
                    ? () => {
                        setMenuOpen(false);
                        onCancelClick();
                      }
                    : undefined
                }
                onClose={() => setMenuOpen(false)}
              />
            ) : null}
            {pickerOpen ? (
              <CardAssigneePicker
                isDark={isDark}
                agents={agents ?? []}
                currentAssigneeId={task.assigneeId}
                busy={reassigning}
                onPick={handlePickAssignee}
                onClose={() => setPickerOpen(false)}
              />
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Description preview */}
      {taskBody ? (
        <p className={`mt-1.5 text-xs leading-relaxed line-clamp-2 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
          {taskBody}
        </p>
      ) : null}

      {/* Status message — italic, smaller */}
      {task.statusMessage ? (
        <p className={`mt-1.5 text-[11px] italic line-clamp-1 ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
          {task.statusMessage}
        </p>
      ) : null}

      {/* Mid row: priority chip + agent kind chip — single row, clip if too
          many. Wrapping would push footer past the card's fixed height. */}
      <div className="mt-2.5 flex shrink-0 items-center gap-1.5 flex-nowrap overflow-hidden">
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium border ${priorityCfg.chipBg} ${
            isDark ? 'border-white/10' : 'border-zinc-200/70'
          }`}
          title={`Priority: ${priorityCfg.label}`}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${priorityCfg.dot}`} />
          {priorityCfg.label}
        </span>

        {kindPreset ? (
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium border ${kindPreset.chipBg}`}
            title={kindPreset.description}
          >
            {kind === 'long-running' ? <Brain className="w-3 h-3" /> : <Terminal className="w-3 h-3" />}
            {kindPreset.shortLabel}
          </span>
        ) : null}

        {task.conversationId ? (
          // W2-T5: tooltip-only span → clickable jump back to the linked
          // session, mirroring how Multica's task list links bubble back to
          // the source thread.
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              if (task.conversationId) onOpenConversation?.(task.conversationId);
            }}
            disabled={!onOpenConversation}
            title="Open linked conversation"
            data-testid={`task-card-conversation-${task.id}`}
            className={`inline-flex items-center justify-center w-5 h-5 rounded-full transition-colors ${
              isDark
                ? 'bg-white/[0.04] text-zinc-400 hover:bg-cyan-500/15 hover:text-cyan-200'
                : 'bg-zinc-100 text-zinc-500 hover:bg-cyan-50 hover:text-cyan-700'
            } disabled:cursor-default disabled:hover:bg-inherit disabled:hover:text-inherit`}
          >
            <MessageSquare className="w-3 h-3" />
          </button>
        ) : null}

        {/* W2-T2: artifact badge — count chip with click-to-peek popover. */}
        {artifactCount > 0 ? (
          <div className="relative">
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                setArtifactOpen((open) => !open);
                setMenuOpen(false);
                setPickerOpen(false);
              }}
              title={`${artifactCount} artifact${artifactCount === 1 ? '' : 's'}`}
              data-testid={`task-card-artifacts-${task.id}`}
              className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] transition-colors ${
                isDark
                  ? 'bg-violet-500/10 text-violet-200 hover:bg-violet-500/20'
                  : 'bg-violet-50 text-violet-700 hover:bg-violet-100'
              }`}
            >
              <Paperclip className="w-3 h-3" /> {artifactCount}
            </button>
            {artifactOpen ? (
              <CardArtifactPopover
                isDark={isDark}
                assets={taskAssets ?? []}
                onPick={(assetId) => {
                  setArtifactOpen(false);
                  onOpenAsset?.(assetId);
                }}
                onClose={() => setArtifactOpen(false)}
              />
            ) : null}
          </div>
        ) : null}

        {task.capability ? (
          <span
            className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] ${
              isDark ? 'bg-white/[0.04] text-zinc-400' : 'bg-zinc-100 text-zinc-500'
            }`}
            title="Capability"
          >
            {task.capability}
          </span>
        ) : null}

        {typeof task.budget === 'number' && task.budget > 0 ? (
          <span
            className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] ${
              isDark ? 'bg-amber-500/10 text-amber-200' : 'bg-amber-50 text-amber-700'
            }`}
            title="Budget"
          >
            <Coins className="w-3 h-3" /> {task.budget}
          </span>
        ) : null}
      </div>

      {editorOpen ? (
        <CardEditPopover
          isDark={isDark}
          title={editTitle}
          description={editDescription}
          saving={savingEdit}
          onTitleChange={setEditTitle}
          onDescriptionChange={setEditDescription}
          onSave={() => void handleSaveEdit()}
          onClose={() => setEditorOpen(false)}
        />
      ) : null}

      {/* Progress bar */}
      {progressPct !== null ? (
        <div className="mt-2.5 shrink-0">
          <div className={`h-1 rounded-full overflow-hidden ${isDark ? 'bg-zinc-800/80' : 'bg-zinc-200'}`}>
            <div
              className="h-full bg-gradient-to-r from-violet-400 via-fuchsia-400 to-cyan-400"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <p className={`mt-1 text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>{progressPct}% complete</p>
        </div>
      ) : null}

      {/* Footer: avatar + name + relative time. `mt-auto` pushes it to the
          bottom of the fixed-height card regardless of how much content sits
          above it — uniform visual baseline across cards. */}
      <footer className="mt-auto pt-3 flex shrink-0 items-center gap-2">
        {assigneeName ? (
          <div className="flex items-center gap-1.5 min-w-0 flex-1">
            <span
              className={`relative shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-full text-[9px] font-bold text-white shadow-sm ${
                kindPreset ? `ring-2 ${kindPreset.accentRing}` : ''
              }`}
              style={{
                background: `linear-gradient(135deg, ${avatar.from}, ${avatar.to})`,
              }}
              title={assigneeName}
            >
              {assigneeIsAgent ? <Bot className="w-3 h-3" /> : initials}
            </span>
            <span className={`text-[11px] truncate ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>{assigneeName}</span>
          </div>
        ) : (
          <div
            className={`flex items-center gap-1.5 min-w-0 flex-1 text-[11px] ${
              isDark ? 'text-zinc-500' : 'text-zinc-500'
            }`}
          >
            <span
              className={`shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-full border border-dashed ${
                isDark ? 'border-white/10 text-zinc-600' : 'border-zinc-300 text-zinc-400'
              }`}
            >
              <User className="w-3 h-3" />
            </span>
            Unassigned
          </div>
        )}

        <span
          className={`shrink-0 inline-flex items-center gap-1 text-[10px] ${
            isDark ? 'text-zinc-500' : 'text-zinc-500'
          }`}
          title={new Date(task.updatedAt).toLocaleString()}
        >
          <Clock className="w-3 h-3" />
          {formatRelative(task.updatedAt)}
        </span>
      </footer>

      {/* Column-specific quick actions (Start / Pause / Approve / Reject /
          Reopen / View output / Assign). The transition mutations are wired
          via SortableTaskCard; Assign/Reassign reuse CardBody's local picker
          state so we don't have to invert pickerOpen ownership. Cancel stays
          in the overflow menu (above). Suppressed under the DragOverlay clone
          (`isOverlay`): the clone is a ghost preview, so rendering disabled
          action buttons under the drag preview is misleading. */}
      {!isOverlay ? (
        <div className="mt-2 shrink-0">
          <TaskCardActions
            task={task}
            disabled={busyAction || cancelling}
            onStart={onStart}
            onPause={onPause}
            onApprove={onApprove}
            onReject={onReject}
            onReopen={onReopen}
            onAssign={() => {
              setPickerOpen(true);
              setMenuOpen(false);
              setArtifactOpen(false);
              setEditorOpen(false);
            }}
            onReassign={() => {
              setPickerOpen(true);
              setMenuOpen(false);
              setArtifactOpen(false);
              setEditorOpen(false);
            }}
            onViewOutput={onOpen}
          />
        </div>
      ) : null}
    </motion.article>
  );
}

// ─── Outer (sortable) wrapper ─────────────────────────────────────

export function TaskCard(props: TaskCardProps) {
  // The DragOverlay clone passes `asOverlay`; in that mode we render a
  // bare CardBody without sortable wiring, since `useSortable` would
  // double-register the same id and break the active drop target.
  if (props.asOverlay) {
    return (
      <CardBody
        {...props}
        cancelling={false}
        busyAction={false}
        onCancelClick={() => undefined}
        onStart={() => undefined}
        onPause={() => undefined}
        onApprove={() => undefined}
        onReject={() => undefined}
        onReopen={() => undefined}
        isOverlay
        isDraggingActive={Boolean(props.isDragging)}
      />
    );
  }
  return <SortableTaskCard {...props} />;
}

function SortableTaskCard(props: TaskCardProps) {
  const { task, onChanged, notify } = props;
  const [cancelling, setCancelling] = useState(false);
  // Single in-flight latch shared across Start/Pause/Approve/Reject/Reopen so
  // the user can't double-fire a state transition while the previous mutation
  // is still resolving. We don't bother distinguishing per-action busy: the
  // card disables the whole action bar atomically.
  const [busyAction, setBusyAction] = useState(false);

  // Normal sortable card
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: { type: 'task', taskId: task.id },
  });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  async function handleCancel(e?: MouseEvent) {
    e?.stopPropagation();
    e?.preventDefault();
    if (cancelling) return;
    setCancelling(true);
    const res = await cancelTask(task.id);
    setCancelling(false);
    if (!res.ok) {
      notify?.(`Couldn't cancel task: ${res.message}`, 'error');
      return;
    }
    notify?.(`Task "${task.title || task.id.slice(-8)}" cancelled.`, 'success');
    onChanged?.();
  }

  async function runMutation(
    label: string,
    fn: () => Promise<{ ok: boolean; message?: string }>,
    successMessage?: string,
  ) {
    if (busyAction) return;
    setBusyAction(true);
    try {
      const res = await fn();
      if (!res.ok) {
        notify?.(`${label}失败: ${res.message ?? '未知错误'}`, 'error');
        return;
      }
      if (successMessage) notify?.(successMessage, 'success');
      onChanged?.();
    } finally {
      setBusyAction(false);
    }
  }

  const handleStart = () => runMutation('开始', () => startTask(task.id), '任务已开始');
  const handlePause = () => runMutation('暂停', () => pauseTask(task.id), '任务已暂停');
  const handleApprove = () => runMutation('通过', () => approveTask(task.id), '已通过');
  const handleReopen = () => runMutation('重启', () => reopenTask(task.id), '任务已重启');
  const handleReject = () => {
    // The drawer hosts the canonical reject UI (inline reason input + submit).
    // Card-level button just routes there — keeps reject UX consistent across
    // entry points and avoids the unstyled native prompt() dialog.
    props.onOpen?.();
  };

  return (
    <div ref={setNodeRef} style={style}>
      <CardBody
        {...props}
        cancelling={cancelling}
        busyAction={busyAction}
        onCancelClick={handleCancel}
        onStart={handleStart}
        onPause={handlePause}
        onApprove={handleApprove}
        onReject={handleReject}
        onReopen={handleReopen}
        dragHandleProps={{ ...attributes, ...listeners }}
        isOverlay={false}
        isDraggingActive={isDragging}
      />
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const delta = Date.now() - t;
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return new Date(iso).toLocaleDateString();
}

function readTaskBody(task: TaskDTO): string | null {
  // description is the single source of truth (post-collapse). The
  // `input.prompt` branch is a legacy tail for rows created before the
  // collapse refactor — drop it after a backfill migrates old rows.
  if (task.description?.trim()) return task.description;
  const legacyPrompt = task.input?.prompt;
  if (typeof legacyPrompt === 'string' && legacyPrompt.trim()) return legacyPrompt;
  const execution = task.metadata?.execution;
  if (execution && typeof execution === 'object' && !Array.isArray(execution)) {
    const command = (execution as Record<string, unknown>).command;
    if (typeof command === 'string' && command.trim()) return command;
  }
  return null;
}

// ─── W2 popovers ──────────────────────────────────────────────────

function CardOverflowMenu({
  isDark,
  onEdit,
  onReassign,
  onAddAttachment,
  onCancel,
  onClose,
}: {
  isDark: boolean;
  onEdit: () => void;
  onReassign: () => void;
  onAddAttachment?: () => void;
  onCancel?: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden />
      <div
        data-testid="task-card-menu"
        onPointerDown={(e) => e.stopPropagation()}
        className={`absolute right-0 top-full z-50 mt-1 min-w-[140px] rounded-lg border shadow-xl ${
          isDark ? 'bg-zinc-900 border-white/10' : 'bg-white border-zinc-200'
        }`}
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
          data-testid="task-card-menu-edit"
          className={`w-full flex items-center gap-2 px-3 py-2 text-[12px] text-left rounded-lg ${
            isDark ? 'text-zinc-200 hover:bg-white/[0.04]' : 'text-zinc-800 hover:bg-zinc-100'
          }`}
        >
          <Pencil className="w-3.5 h-3.5" />
          {t('workspace.taskBoard.editTask')}
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onReassign();
          }}
          data-testid="task-card-menu-reassign"
          className={`w-full flex items-center gap-2 px-3 py-2 text-[12px] text-left rounded-lg ${
            isDark ? 'text-zinc-200 hover:bg-white/[0.04]' : 'text-zinc-800 hover:bg-zinc-100'
          }`}
        >
          <Bot className="w-3.5 h-3.5" />
          {t('workspace.taskBoard.reassignTask')}
        </button>
        {onAddAttachment ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onAddAttachment();
            }}
            data-testid="task-card-menu-attachment"
            className={`w-full flex items-center gap-2 px-3 py-2 text-[12px] text-left rounded-lg ${
              isDark ? 'text-zinc-200 hover:bg-white/[0.04]' : 'text-zinc-800 hover:bg-zinc-100'
            }`}
          >
            <Paperclip className="w-3.5 h-3.5" />
            {t('workspace.taskBoard.addAttachment')}
          </button>
        ) : null}
        {onCancel ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onCancel();
            }}
            data-testid="task-card-menu-cancel"
            className={`w-full flex items-center gap-2 px-3 py-2 text-[12px] text-left rounded-lg ${
              isDark ? 'text-rose-300 hover:bg-rose-500/10' : 'text-rose-600 hover:bg-rose-50'
            }`}
          >
            <X className="w-3.5 h-3.5" />
            取消任务
          </button>
        ) : null}
      </div>
    </>
  );
}

function CardEditPopover({
  isDark,
  title,
  description,
  saving,
  onTitleChange,
  onDescriptionChange,
  onSave,
  onClose,
}: {
  isDark: boolean;
  title: string;
  description: string;
  saving: boolean;
  onTitleChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden />
      <div
        data-testid="task-card-editor"
        onPointerDown={(e) => e.stopPropagation()}
        className={`absolute left-0 top-full z-50 mt-2 w-[280px] rounded-xl border p-3 shadow-2xl ${
          isDark ? 'bg-zinc-950 border-white/10' : 'bg-white border-zinc-200'
        }`}
      >
        <div className="space-y-2">
          <label className={`block text-[11px] font-semibold ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>
            {t('workspace.taskBoard.taskTitle')}
            <input
              value={title}
              onChange={(event) => onTitleChange(event.target.value)}
              className={`mt-1 h-9 w-full rounded-lg border px-2.5 text-sm outline-none ${
                isDark
                  ? 'border-white/10 bg-white/[0.04] text-zinc-100 placeholder:text-zinc-600'
                  : 'border-zinc-200 bg-white text-zinc-900 placeholder:text-zinc-400'
              }`}
            />
          </label>
          <label className={`block text-[11px] font-semibold ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>
            {t('workspace.taskBoard.taskDescription')}
            <textarea
              value={description}
              onChange={(event) => onDescriptionChange(event.target.value)}
              rows={4}
              className={`mt-1 w-full resize-none rounded-lg border px-2.5 py-2 text-sm outline-none ${
                isDark
                  ? 'border-white/10 bg-white/[0.04] text-zinc-100 placeholder:text-zinc-600'
                  : 'border-zinc-200 bg-white text-zinc-900 placeholder:text-zinc-400'
              }`}
            />
          </label>
        </div>
        <div className="mt-3 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${
              isDark ? 'text-zinc-300 hover:bg-white/[0.05]' : 'text-zinc-600 hover:bg-zinc-100'
            }`}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60 ${
              isDark ? 'bg-violet-500 hover:bg-violet-400' : 'bg-violet-600 hover:bg-violet-700'
            }`}
          >
            {saving ? t('common.loading') : t('common.save')}
          </button>
        </div>
      </div>
    </>
  );
}

function CardAssigneePicker({
  isDark,
  agents,
  currentAssigneeId,
  busy,
  onPick,
  onClose,
}: {
  isDark: boolean;
  agents: AgentDTO[];
  currentAssigneeId: string | null;
  busy: boolean;
  onPick: (assigneeId: string | null) => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden />
      <div
        data-testid="task-card-assignee-picker"
        onPointerDown={(e) => e.stopPropagation()}
        className={`absolute right-0 top-full z-50 mt-1 min-w-[200px] max-h-64 overflow-y-auto rounded-lg border shadow-xl ${
          isDark ? 'bg-zinc-900 border-white/10' : 'bg-white border-zinc-200'
        }`}
      >
        <ul className="p-1">
          <li>
            <button
              type="button"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                onPick(null);
              }}
              data-testid="task-card-assignee-pick-unassign"
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-md text-left text-[12px] ${
                isDark ? 'text-zinc-300 hover:bg-white/[0.04]' : 'text-zinc-700 hover:bg-zinc-100'
              } ${currentAssigneeId == null ? 'font-semibold' : ''} disabled:opacity-50`}
            >
              <CircleDashed className="w-3.5 h-3.5" />
              Unassign
            </button>
          </li>
          {agents.map((agent) => {
            const isCurrent = agent.userId === currentAssigneeId;
            return (
              <li key={agent.userId}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={(e) => {
                    e.stopPropagation();
                    onPick(agent.userId);
                  }}
                  data-testid={`task-card-assignee-pick-${agent.userId}`}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded-md text-left text-[12px] ${
                    isDark ? 'text-zinc-200 hover:bg-white/[0.04]' : 'text-zinc-800 hover:bg-zinc-100'
                  } ${isCurrent ? 'font-semibold' : ''} disabled:opacity-50`}
                >
                  <Bot className="w-3.5 h-3.5 shrink-0 opacity-80" />
                  <span className="flex-1 truncate">{agent.name}</span>
                  {isCurrent ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : null}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </>
  );
}

function CardArtifactPopover({
  isDark,
  assets,
  onPick,
  onClose,
}: {
  isDark: boolean;
  assets: AssetDTO[];
  onPick: (assetId: string) => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden />
      <div
        data-testid="task-card-artifact-popover"
        onPointerDown={(e) => e.stopPropagation()}
        className={`absolute left-0 top-full z-50 mt-1 min-w-[220px] max-h-72 overflow-y-auto rounded-lg border shadow-xl ${
          isDark ? 'bg-zinc-900 border-white/10' : 'bg-white border-zinc-200'
        }`}
      >
        <ul className="p-1">
          {assets.map((asset) => {
            const meta = asset.metadata ?? {};
            const title =
              typeof (meta as Record<string, unknown>).title === 'string'
                ? ((meta as Record<string, unknown>).title as string)
                : asset.id.slice(-12);
            return (
              <li key={asset.id}>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onPick(asset.id);
                  }}
                  data-testid={`task-card-artifact-${asset.id}`}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded-md text-left text-[12px] ${
                    isDark ? 'text-zinc-200 hover:bg-white/[0.04]' : 'text-zinc-800 hover:bg-zinc-100'
                  }`}
                >
                  <FileText className={`w-3.5 h-3.5 shrink-0 ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`} />
                  <span className="flex-1 truncate">{title}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </>
  );
}
