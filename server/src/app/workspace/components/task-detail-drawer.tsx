'use client';

/**
 * Task detail drawer — Wave-7 ζ.
 *
 * Slide-in right-side drawer that opens when a task card on the kanban is
 * clicked. Renders:
 *
 *   1. Header           — id badge, title, status + priority chips, agent kind +
 *                         assignee avatar.
 *   2. Description      — collapsed when empty; pre-wrap monospace block when
 *                         present (no react-markdown dependency in repo).
 *   3. Timeline         — vertical event stream of state transitions sourced
 *                         from the task itself (createdAt / assignedAt /
 *                         completedAt) plus live SSE `task.progress` events.
 *   4. Live log stream  — appended in-place to the timeline whenever a
 *                         `task.progress` SSE event for this task arrives.
 *                         Drawer-scoped EventSource opens only while the task
 *                         is in a non-terminal status.
 *   5. Result viewer    — task.result (string OR { output, metrics }) shown in
 *                         monospace on a `surface.inset` block when status is
 *                         `completed`.
 *   6. Action footer    — Cancel / Approve / Reject / Retry depending on
 *                         status. Approve + Reject hit the new mutation
 *                         helpers in lib/mutations.ts.
 *
 * Glassmorphism: `surface.modal` for the drawer body, `surface.inset` for
 * scoped panels. Spring-heavy slide-in via framer-motion. ESC key + backdrop
 * click both close. All async work cleans up on unmount (AbortController +
 * EventSource.close).
 *
 * Hard rule: this file does NOT import from `src/im/**` — only the public
 * frontend lib (types / mutations / im-api / agent-kind / design).
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Bot,
  Check,
  ChevronRight,
  CircleDashed,
  ClipboardCopy,
  Coins,
  FileText,
  Hash,
  Loader2,
  MessageSquare,
  Paperclip,
  Pencil,
  RotateCw,
  Target,
  Terminal,
  User as UserIcon,
  X,
} from 'lucide-react';
import { AGENT_KIND_PRESETS, classifyAgent, type AgentKind } from '../lib/agent-kind';
import {
  avatarGradient,
  avatarInitials,
  priorityAccent,
  radius,
  readTaskPriority,
  springHeavy,
  springSnap,
  springSoft,
  statusAccent,
  surface,
} from '../lib/design';
import { getWorkspaceToken, imFetch } from '../lib/im-api';
import { approveTask, cancelTask, isCancellableStatus, rejectTask, updateTask } from '../lib/mutations';
import type { AgentDTO, AssetDTO, TaskDTO, TaskDetailDTO, TaskLogDTO } from '../lib/types';
import { MemoryTextPreview } from './memory-text-preview';

/**
 * Wave-8 W2: typed view of the metadata bag we read off TaskDTO without
 * forcing the full WorkspaceTaskMetadata refactor (sibling W1 owns that).
 * The cloud writes these keys when fanning out agent runs under a parent
 * work_item / goal — see task.service.ts getTaskWithLogs, line 2510-2530.
 */
interface ParentRefs {
  parentTaskId?: string;
  goalTaskId?: string;
  kind?: string;
}

function readParentRefs(task: TaskDTO | null | undefined): ParentRefs {
  if (!task) return {};
  const meta = (task.metadata ?? {}) as Record<string, unknown>;
  return {
    parentTaskId: typeof meta.parentTaskId === 'string' ? meta.parentTaskId : undefined,
    goalTaskId: typeof meta.goalTaskId === 'string' ? meta.goalTaskId : undefined,
    kind: typeof meta.kind === 'string' ? meta.kind : undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────

export interface TaskDetailDrawerProps {
  isDark: boolean;
  task: TaskDTO | null;
  agents?: AgentDTO[];
  /** All workspace assets — drawer filters to ones produced by this task. */
  assets?: AssetDTO[];
  onClose: () => void;
  onChanged?: () => void;
  /**
   * W2-T4: re-target the drawer to a different task (parent breadcrumb chip,
   * agent_run subtask jumps). Page-level handler routes to its
   * `openTaskById` so off-board tasks fall through to the fetch path.
   */
  onOpenTask?: (taskId: string) => void;
  /** W2-T2: route an asset row click into the workspace inspector dialog. */
  onOpenAsset?: (assetId: string) => void;
  /**
   * Wave-8 W10: reverse-link from task → its linked chat session. When set,
   * the header "Session" chip becomes a clickable button that selects the
   * conversation in the left rail (and uncollapses the IM panel). Hidden
   * unless the task actually has `conversationId`.
   */
  onOpenChat?: (conversationId: string) => void;
  /**
   * Wave-9 Phase 3.3: jump from drawer → library, pre-selecting this
   * task's auto-folder (`/tasks/{taskId}`). When set, the drawer surfaces
   * a button next to the task's asset list that switches the workspace
   * shell to the Library surface and filters to that folder so users
   * see every artifact this task produced (including agent-output and
   * sandbox-output uploads) in one place.
   */
  onOpenLibrary?: (folderPath: string) => void;
  notify?: (message: string, type: 'success' | 'error' | 'info') => void;
}

// ─────────────────────────────────────────────────────────────────────
// Live SSE event shape
// ─────────────────────────────────────────────────────────────────────

interface LiveProgressEvent {
  ts: number;
  progress: number | null;
  message: string | null;
  metadata?: Record<string, unknown> | null;
}

interface TimelineEntry {
  key: string;
  kind: 'created' | 'assigned' | 'progress' | 'review' | 'completed' | 'failed' | 'cancelled';
  label: string;
  ts: number;
  message?: string | null;
  progress?: number | null;
  actorId?: string | null;
  metadata?: Record<string, unknown> | null;
}

// Status that means "still working / dispatch open" — drawer keeps SSE on.
const ACTIVE_STATUSES = new Set(['pending', 'assigned', 'running', 'in_progress']);
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

// ─────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────

export function TaskDetailDrawer({
  isDark,
  task,
  agents,
  assets,
  onClose,
  onChanged,
  onOpenTask,
  onOpenAsset,
  onOpenChat,
  onOpenLibrary,
  notify,
}: TaskDetailDrawerProps): ReactElement | null {
  const isOpen = !!task;
  const theme: 'dark' | 'light' = isDark ? 'dark' : 'light';

  // Live progress events captured during this drawer session, scoped per-task.
  const [liveEvents, setLiveEvents] = useState<LiveProgressEvent[]>([]);
  const [detail, setDetail] = useState<TaskDetailDTO | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'cancel' | 'approve' | 'reject' | 'retry' | 'reassign'>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [showRejectInput, setShowRejectInput] = useState(false);
  // W2-T1: assignee popover open state. Anchored at the assignee tile.
  const [assigneePickerOpen, setAssigneePickerOpen] = useState(false);
  // W2-T4: walk-up parent chain. Each entry is a TaskDTO fetched via
  // imFetch('/tasks/:id'). Bounded at 4 hops so a malformed cycle in
  // metadata.parentTaskId can't lock the drawer.
  const [parentChain, setParentChain] = useState<TaskDTO[]>([]);

  // Wipe live events whenever the focused task changes, so stale logs from a
  // previous task don't leak into the next one's timeline.
  const taskId = task?.id ?? null;
  const taskUpdatedAt = task?.updatedAt ?? null;
  useEffect(() => {
    setLiveEvents([]);
    setDetail(null);
    setDetailError(null);
    setShowRejectInput(false);
    setRejectReason('');
    setAssigneePickerOpen(false);
    setParentChain([]);
  }, [taskId]);

  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);

    (async () => {
      const res = await imFetch<TaskDetailDTO>(`/tasks/${encodeURIComponent(taskId)}`);
      if (cancelled) return;
      setDetailLoading(false);
      if (!res.ok) {
        setDetailError(res.message);
        return;
      }
      setDetail(res.data ?? null);
    })();

    return () => {
      cancelled = true;
    };
  }, [taskId, taskUpdatedAt]);

  // W2-T4: walk up parentTaskId / goalTaskId so the breadcrumb shows
  //   Goal: X  >  Work item: Y  >  Run: this
  // Falls back gracefully if any hop 404s — we just truncate the chain.
  // Bounded loop guards against malformed cycles in metadata.parentTaskId.
  const refsKey = useMemo(() => {
    const refs = readParentRefs(task);
    return `${refs.parentTaskId ?? ''}|${refs.goalTaskId ?? ''}`;
  }, [task]);
  useEffect(() => {
    if (!task) {
      setParentChain([]);
      return;
    }
    const seedRefs = readParentRefs(task);
    if (!seedRefs.parentTaskId && !seedRefs.goalTaskId) {
      setParentChain([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const chain: TaskDTO[] = [];
      const seen = new Set<string>([task.id]);
      let nextId: string | undefined = seedRefs.parentTaskId ?? seedRefs.goalTaskId;
      for (let hop = 0; hop < 4 && nextId && !seen.has(nextId); hop++) {
        seen.add(nextId);
        const res = await imFetch<{ task: TaskDTO } | TaskDTO>(`/tasks/${encodeURIComponent(nextId)}`);
        if (cancelled) return;
        if (!res.ok) break;
        const fetched = (res.data as { task?: TaskDTO }).task ?? (res.data as TaskDTO);
        chain.push(fetched);
        const refs = readParentRefs(fetched);
        // Stop climbing once we hit a goal — the chain reads goal → … → run.
        if (refs.kind === 'goal') break;
        nextId = refs.parentTaskId ?? refs.goalTaskId;
      }
      if (cancelled) return;
      // Order chain root-first so the breadcrumb reads left-to-right.
      setParentChain(chain.reverse());
    })();
    return () => {
      cancelled = true;
    };
  }, [task, refsKey]);

  // ─── ESC to close ─────────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  // ─── SSE subscription scoped to this drawer ────────────────────────
  // Inline EventSource (rather than reusing use-task-stream) because:
  //   1. We want fine-grained `task.progress` payloads for the timeline.
  //   2. The hook collapses everything into a single onUpdate() callback
  //      designed for the kanban refresh, not log streaming.
  // EventSource auto-reconnects on transient drops; we only close on unmount.
  useEffect(() => {
    if (!task) return;
    if (!ACTIVE_STATUSES.has(task.status)) return;

    const token = getWorkspaceToken();
    if (!token) return;

    let es: EventSource | null = null;
    try {
      es = new EventSource(`/api/im/tasks/events?token=${encodeURIComponent(token)}`);
    } catch {
      return;
    }

    const onProgress = (raw: MessageEvent) => {
      try {
        const data = JSON.parse(raw.data ?? '{}');
        if (!data || data.taskId !== task.id) return;
        setLiveEvents((prev) => [
          ...prev,
          {
            ts: Date.now(),
            progress: typeof data.progress === 'number' ? data.progress : null,
            message: typeof data.statusMessage === 'string' ? data.statusMessage : null,
            metadata: data.metadata ?? null,
          },
        ]);
      } catch {
        /* ignore malformed payloads */
      }
    };

    const onTerminal = (raw: MessageEvent) => {
      try {
        const data = JSON.parse(raw.data ?? '{}');
        if (!data || data.taskId !== task.id) return;
        // Surface terminal events as a final "log line" too — the parent will
        // refresh the canonical task via onChanged if it cares about status.
        const msg =
          raw.type === 'task.completed'
            ? 'Task completed'
            : raw.type === 'task.failed'
              ? `Task failed${typeof data.error === 'string' ? `: ${data.error}` : ''}`
              : raw.type === 'task.cancelled'
                ? 'Task cancelled'
                : null;
        if (msg) {
          setLiveEvents((prev) => [...prev, { ts: Date.now(), progress: null, message: msg, metadata: null }]);
        }
      } catch {
        /* ignore */
      }
    };

    es.addEventListener('task.progress', onProgress as EventListener);
    es.addEventListener('task.completed', onTerminal as EventListener);
    es.addEventListener('task.failed', onTerminal as EventListener);
    es.addEventListener('task.cancelled', onTerminal as EventListener);

    return () => {
      es?.removeEventListener('task.progress', onProgress as EventListener);
      es?.removeEventListener('task.completed', onTerminal as EventListener);
      es?.removeEventListener('task.failed', onTerminal as EventListener);
      es?.removeEventListener('task.cancelled', onTerminal as EventListener);
      es?.close();
    };
  }, [task]);

  // ─── Derived data ─────────────────────────────────────────────────

  const displayTask = detail?.task ?? task;

  const assigneeAgent = useMemo<AgentDTO | null>(() => {
    if (!displayTask?.assigneeId || !agents) return null;
    return agents.find((a) => a.userId === displayTask.assigneeId) ?? null;
  }, [displayTask, agents]);

  const agentKind: AgentKind | null = useMemo(() => {
    if (!displayTask) return null;
    if (assigneeAgent) {
      return classifyAgent({
        adapterName: (assigneeAgent.agentType as string | undefined) ?? null,
      });
    }
    if (displayTask.assigneeType === 'agent') return 'cli';
    return null;
  }, [displayTask, assigneeAgent]);

  const timeline = useMemo<TimelineEntry[]>(() => {
    if (!displayTask) return [];
    const entries: TimelineEntry[] = [];

    for (const log of detail?.logs ?? []) {
      const ts = Date.parse(log.createdAt);
      if (!Number.isFinite(ts)) continue;
      entries.push(logToTimelineEntry(log, displayTask, ts));
    }

    if (!entries.some((entry) => entry.kind === 'created')) {
      const createdAt = Date.parse(displayTask.createdAt);
      if (Number.isFinite(createdAt)) {
        entries.push({
          key: 'created',
          kind: 'created',
          label: 'Task created',
          ts: createdAt,
        });
      }
    }
    if (displayTask.assigneeId && !entries.some((entry) => entry.kind === 'assigned')) {
      const meta = displayTask.metadata ?? {};
      const rawAssignedAt = (meta as Record<string, unknown>).assignedAt;
      const firstLogAt = entries.length > 0 ? Math.min(...entries.map((entry) => entry.ts)) : NaN;
      const createdAt = Date.parse(displayTask.createdAt);
      const assignedAt =
        typeof rawAssignedAt === 'string'
          ? Date.parse(rawAssignedAt)
          : Number.isFinite(firstLogAt)
            ? firstLogAt + 1
            : createdAt;
      if (Number.isFinite(assignedAt)) {
        entries.push({
          key: 'assigned-fallback',
          kind: 'assigned',
          label: `Assigned to ${displayTask.assigneeName ?? displayTask.assigneeId.slice(-8)}`,
          ts: assignedAt,
        });
      }
    }
    for (const evt of liveEvents) {
      entries.push({
        key: `progress-${evt.ts}`,
        kind: 'progress',
        label:
          typeof evt.progress === 'number'
            ? `Progress · ${Math.round(Math.max(0, Math.min(1, evt.progress)) * 100)}%`
            : 'Progress',
        ts: evt.ts,
        message: evt.message,
        progress: evt.progress,
      });
    }
    if (displayTask.status === 'review') {
      const ts = Date.parse(displayTask.updatedAt);
      if (Number.isFinite(ts)) {
        entries.push({ key: 'review', kind: 'review', label: 'Awaiting review', ts });
      }
    }
    if (displayTask.status === 'completed') {
      const completedAt = displayTask.completedAt
        ? Date.parse(displayTask.completedAt)
        : Date.parse(displayTask.updatedAt);
      if (Number.isFinite(completedAt)) {
        entries.push({ key: 'completed', kind: 'completed', label: 'Completed', ts: completedAt });
      }
    } else if (displayTask.status === 'failed') {
      const ts = Date.parse(displayTask.updatedAt);
      if (Number.isFinite(ts)) {
        entries.push({ key: 'failed', kind: 'failed', label: 'Failed', ts });
      }
    } else if (displayTask.status === 'cancelled') {
      const ts = Date.parse(displayTask.updatedAt);
      if (Number.isFinite(ts)) {
        entries.push({ key: 'cancelled', kind: 'cancelled', label: 'Cancelled', ts });
      }
    }
    return dedupeTimeline(entries).sort((a, b) => a.ts - b.ts);
  }, [displayTask, detail?.logs, liveEvents]);

  const progressPct =
    displayTask && typeof displayTask.progress === 'number'
      ? Math.round(Math.max(0, Math.min(1, displayTask.progress)) * 100)
      : null;

  const priority = displayTask ? readTaskPriority(displayTask) : 'medium';
  const statusInfo = displayTask ? (statusAccent[displayTask.status] ?? statusAccent.backlog) : null;
  const taskBody = displayTask ? readTaskBody(displayTask) : null;

  // ─── Actions ──────────────────────────────────────────────────────

  const handleCancel = useCallback(async () => {
    if (!task || busy) return;
    setBusy('cancel');
    const res = await cancelTask(task.id);
    setBusy(null);
    if (!res.ok) {
      notify?.(`Couldn't cancel task: ${res.message}`, 'error');
      return;
    }
    notify?.(`Task "${task.title || task.id.slice(-8)}" cancelled.`, 'success');
    onChanged?.();
  }, [task, busy, notify, onChanged]);

  const handleApprove = useCallback(async () => {
    if (!task || busy) return;
    setBusy('approve');
    const res = await approveTask(task.id);
    setBusy(null);
    if (!res.ok) {
      notify?.(`Couldn't approve task: ${res.message}`, 'error');
      return;
    }
    notify?.('Task approved.', 'success');
    onChanged?.();
  }, [task, busy, notify, onChanged]);

  const handleReject = useCallback(async () => {
    if (!task || busy) return;
    const reason = rejectReason.trim();
    if (!reason) {
      setShowRejectInput(true);
      notify?.('Reason is required to reject.', 'info');
      return;
    }
    setBusy('reject');
    const res = await rejectTask(task.id, reason);
    setBusy(null);
    if (!res.ok) {
      notify?.(`Couldn't reject task: ${res.message}`, 'error');
      return;
    }
    notify?.('Task rejected.', 'success');
    setShowRejectInput(false);
    setRejectReason('');
    onChanged?.();
  }, [task, busy, rejectReason, notify, onChanged]);

  const handleRetry = useCallback(() => {
    notify?.('Retry coming soon.', 'info');
  }, [notify]);

  const copyId = useCallback(() => {
    if (!task) return;
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(task.id).catch(() => {
        /* ignore */
      });
      notify?.('Task ID copied.', 'success');
    }
  }, [task, notify]);

  // W2-T1: re-target the task to a different agent (or unassign) via PATCH
  // /tasks/:id { assigneeId }. The cloud rejects assignee changes on running
  // tasks with 409 — we surface that as a toast instead of swallowing it.
  const handleReassign = useCallback(
    async (assigneeId: string | null) => {
      if (!task || busy) return;
      setBusy('reassign');
      const res = await updateTask(task.id, { assigneeId });
      setBusy(null);
      setAssigneePickerOpen(false);
      if (!res.ok) {
        const hint = res.status === 409 ? 'Cancel the run first or wait for it to finish.' : res.message;
        notify?.(`Couldn't reassign task: ${hint}`, 'error');
        return;
      }
      const newName =
        agents?.find((agent) => agent.userId === assigneeId)?.name ??
        (assigneeId ? assigneeId.slice(-8) : 'unassigned');
      notify?.(`Task reassigned to ${newName}.`, 'success');
      onChanged?.();
    },
    [task, busy, agents, notify, onChanged],
  );

  // W2-T2: assets produced by this task (sourceTaskId match). The drawer
  // already had a result viewer; this surfaces structured artifacts that
  // the agent uploaded as side-effects of the run, separate from inline
  // result text.
  const taskAssets = useMemo<AssetDTO[]>(() => {
    if (!task || !assets) return [];
    return assets.filter((asset) => asset.sourceTaskId === task.id);
  }, [task, assets]);

  // ─────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────

  return (
    <AnimatePresence>
      {isOpen && displayTask ? (
        <motion.div
          key={`drawer-${displayTask.id}`}
          className="absolute inset-0 z-30"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          aria-hidden={false}
        >
          {/* Backdrop */}
          <motion.div
            data-testid="task-drawer-backdrop"
            onClick={onClose}
            className={`absolute inset-0 backdrop-blur-sm ${isDark ? 'bg-black/55' : 'bg-zinc-900/30'}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
          />

          {/* Drawer panel */}
          <motion.aside
            role="dialog"
            aria-label={`Task ${displayTask.title || displayTask.id}`}
            data-testid="task-detail-drawer"
            className={[
              'absolute right-0 top-0 bottom-0',
              'w-full sm:w-[480px] lg:w-[520px]',
              'flex flex-col overflow-hidden',
              radius.pane,
              'sm:rounded-l-3xl sm:rounded-r-none',
              'border-l',
              surface.modal[theme],
            ].join(' ')}
            initial={{ x: 540, opacity: 0.4 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 540, opacity: 0 }}
            transition={springHeavy}
          >
            {/* Header */}
            <header className="relative px-6 pt-5 pb-4 border-b border-white/5">
              <button
                type="button"
                onClick={onClose}
                aria-label="Close drawer"
                data-testid="task-drawer-close"
                className={`absolute top-4 right-4 p-2 ${radius.small} transition-colors ${
                  isDark
                    ? 'text-zinc-400 hover:text-white hover:bg-white/5'
                    : 'text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100'
                }`}
              >
                <X className="w-4 h-4" />
              </button>

              <motion.div
                initial={{ scale: 0.95, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={springSoft}
              >
                {/* W2-T4: parent breadcrumb (Goal > Work item > this run). */}
                {parentChain.length > 0 ? (
                  <Breadcrumb chain={parentChain} current={displayTask} isDark={isDark} onOpenTask={onOpenTask} />
                ) : null}

                {/* ID badge */}
                <button
                  type="button"
                  onClick={copyId}
                  title="Copy task ID"
                  data-testid="task-drawer-id"
                  className={`inline-flex items-center gap-1.5 px-2 py-0.5 ${radius.chip} text-[10px] font-mono transition-colors ${
                    isDark
                      ? 'bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-zinc-200'
                      : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 hover:text-zinc-900'
                  }`}
                >
                  <Hash className="w-3 h-3" />
                  <span className="truncate max-w-[180px]">{displayTask.id.slice(-12)}</span>
                  <ClipboardCopy className="w-3 h-3 opacity-60" />
                </button>

                {/* Title */}
                <h2
                  className={`mt-3 pr-10 text-xl font-bold leading-tight ${isDark ? 'text-zinc-50' : 'text-zinc-900'}`}
                >
                  {displayTask.title || 'Untitled task'}
                </h2>

                {/* Chips row */}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {statusInfo ? (
                    <span
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 ${radius.chip} text-[11px] border ${statusInfo.bg} ${statusInfo.text}`}
                    >
                      <span className={`inline-block w-1.5 h-1.5 ${radius.chip} ${statusInfo.dot}`} />
                      {displayTask.status}
                    </span>
                  ) : null}
                  <span
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 ${radius.chip} text-[11px] ${priorityAccent[priority].chipBg}`}
                  >
                    <span className={`inline-block w-1.5 h-1.5 ${radius.chip} ${priorityAccent[priority].dot}`} />
                    {priorityAccent[priority].label}
                  </span>
                  {typeof displayTask.budget === 'number' && displayTask.budget > 0 ? (
                    <span
                      className={`inline-flex items-center gap-1 px-2.5 py-1 ${radius.chip} text-[11px] ${
                        isDark ? 'bg-amber-500/10 text-amber-200' : 'bg-amber-50 text-amber-700'
                      }`}
                    >
                      <Coins className="w-3 h-3" />
                      {displayTask.budget}
                    </span>
                  ) : null}
                  {displayTask.conversationId ? (
                    onOpenChat ? (
                      // Wave-8 W10: reverse-link to chat. Clickable variant
                      // selects the conversation in the LeftRail and pops
                      // the IM panel back open (page.tsx handles both).
                      <button
                        type="button"
                        data-testid="task-drawer-open-chat"
                        onClick={() => onOpenChat(displayTask.conversationId!)}
                        title="Open the chat session linked to this task"
                        className={`inline-flex items-center gap-1 px-2.5 py-1 ${radius.chip} text-[11px] transition-colors ${
                          isDark
                            ? 'bg-violet-500/15 text-violet-200 hover:bg-violet-500/25'
                            : 'bg-violet-100 text-violet-700 hover:bg-violet-200'
                        }`}
                      >
                        <MessageSquare className="w-3 h-3" />
                        Open chat
                      </button>
                    ) : (
                      <span
                        className={`inline-flex items-center gap-1 px-2.5 py-1 ${radius.chip} text-[11px] ${
                          isDark ? 'bg-white/5 text-zinc-300' : 'bg-zinc-100 text-zinc-600'
                        }`}
                      >
                        <MessageSquare className="w-3 h-3" />
                        Session
                      </span>
                    )
                  ) : null}
                </div>

                {/* Assignee row — click to reassign (W2-T1). */}
                <div className="mt-4 relative">
                  <button
                    type="button"
                    onClick={() => setAssigneePickerOpen((open) => !open)}
                    disabled={busy === 'reassign'}
                    data-testid="task-drawer-assignee"
                    className={`group flex items-center gap-3 w-full text-left px-2 -mx-2 py-1.5 rounded-xl transition-colors ${
                      isDark ? 'hover:bg-white/[0.04]' : 'hover:bg-zinc-100/70'
                    } disabled:opacity-60`}
                  >
                    <AssigneeAvatar task={displayTask} kind={agentKind} />
                    <div className="flex-1 min-w-0">
                      <p
                        className={`text-[11px] uppercase tracking-wide ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
                      >
                        {agentKind
                          ? AGENT_KIND_PRESETS[agentKind].label
                          : displayTask.assigneeId
                            ? 'Assignee'
                            : 'Unassigned'}
                      </p>
                      <p className={`text-sm font-medium truncate ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
                        {displayTask.assigneeName ??
                          assigneeAgent?.name ??
                          (displayTask.assigneeId ? displayTask.assigneeId.slice(-8) : 'No one yet')}
                      </p>
                    </div>
                    <Pencil
                      className={`w-3.5 h-3.5 transition-opacity ${
                        isDark ? 'text-zinc-500' : 'text-zinc-400'
                      } opacity-0 group-hover:opacity-100`}
                    />
                  </button>
                  {assigneePickerOpen ? (
                    <AssigneePicker
                      isDark={isDark}
                      agents={agents ?? []}
                      currentAssigneeId={displayTask.assigneeId}
                      busy={busy === 'reassign'}
                      onPick={handleReassign}
                      onClose={() => setAssigneePickerOpen(false)}
                    />
                  ) : null}
                </div>

                {/* Progress bar */}
                {progressPct !== null ? (
                  <div className="mt-4">
                    <div className={`h-1.5 rounded-full overflow-hidden ${isDark ? 'bg-zinc-800' : 'bg-zinc-200'}`}>
                      <motion.div
                        className="h-full bg-gradient-to-r from-violet-400 via-cyan-400 to-emerald-400"
                        initial={{ width: 0 }}
                        animate={{ width: `${progressPct}%` }}
                        transition={springSoft}
                      />
                    </div>
                    <p className={`mt-1 text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                      {progressPct}%{displayTask.statusMessage ? ` · ${displayTask.statusMessage}` : ''}
                    </p>
                  </div>
                ) : null}
              </motion.div>
            </header>

            {/* Body — scrollable */}
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
              {/* Description — markdown rendered (headings / lists / code / links). */}
              {taskBody ? (
                <Section title="Description" isDark={isDark}>
                  <div
                    data-testid="task-detail-description"
                    className={`border ${radius.card} px-4 py-3 ${surface.inset[theme]}`}
                  >
                    <MemoryTextPreview content={taskBody} isDark={isDark} />
                  </div>
                </Section>
              ) : null}

              {detailLoading || detailError ? (
                <div
                  className={`flex items-center gap-2 text-[11px] ${
                    detailError
                      ? isDark
                        ? 'text-rose-300'
                        : 'text-rose-600'
                      : isDark
                        ? 'text-zinc-500'
                        : 'text-zinc-500'
                  }`}
                >
                  {detailLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                  <span>{detailError ? `Detail load failed: ${detailError}` : 'Loading task activity…'}</span>
                </div>
              ) : null}

              {/* Timeline */}
              <Section title="Timeline" isDark={isDark}>
                <ol className="relative pl-5">
                  <span
                    aria-hidden
                    className={`absolute left-1.5 top-1 bottom-1 w-px ${isDark ? 'bg-white/8' : 'bg-zinc-200'}`}
                  />
                  {timeline.length === 0 ? (
                    <li className={`py-2 text-[12px] italic ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                      No events recorded.
                    </li>
                  ) : (
                    timeline.map((entry) => <TimelineRow key={entry.key} entry={entry} isDark={isDark} />)
                  )}
                </ol>
              </Section>

              {/* Live log stream */}
              {ACTIVE_STATUSES.has(displayTask.status) ? (
                <Section title="Live stream" isDark={isDark} badge={<LiveBadge isDark={isDark} />}>
                  <div
                    className={`border ${radius.card} px-4 py-3 ${surface.inset[theme]} font-mono text-[12px] leading-relaxed`}
                  >
                    {liveEvents.length === 0 ? (
                      <p className={`flex items-center gap-2 ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                        <Loader2 className="w-3 h-3 animate-spin" />
                        Waiting for agent output…
                      </p>
                    ) : (
                      <ul className="space-y-1.5">
                        {liveEvents.map((evt) => (
                          <li key={evt.ts} className={`flex gap-2 ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
                            <span className={`shrink-0 ${isDark ? 'text-cyan-300' : 'text-cyan-600'}`}>
                              {formatClock(evt.ts)}
                            </span>
                            <span className="flex-1 break-words whitespace-pre-wrap">{formatLiveProgress(evt)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </Section>
              ) : null}

              {/* Result viewer */}
              {displayTask.status === 'completed' || isShellTask(displayTask) || displayTask.error ? (
                <Section title="Result" isDark={isDark}>
                  <ResultBlock task={displayTask} isDark={isDark} />
                </Section>
              ) : null}

              {/* W2-T2: artifacts produced by this run, hoisted out of the
                  result blob so they're 1-click to inspect instead of buried
                  inside ResultBlock. */}
              {taskAssets.length > 0 ? (
                <Section
                  title="Artifacts"
                  isDark={isDark}
                  badge={
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-mono ${
                          isDark ? 'bg-violet-500/15 text-violet-200' : 'bg-violet-50 text-violet-700'
                        }`}
                      >
                        <Paperclip className="w-3 h-3" />
                        {taskAssets.length}
                      </span>
                      {/* Wave-9 Phase 3.3: jump to library, pre-filtered to
                          this task's auto-folder (`/tasks/{taskId}`). The
                          daemon-side OutboxWatcher tags every agent-output
                          upload with that path, so the library view shows
                          every file the run produced in one place. Hidden
                          when the page-level handler isn't wired. */}
                      {onOpenLibrary ? (
                        <button
                          type="button"
                          onClick={() => onOpenLibrary(`/tasks/${task.id}`)}
                          data-testid="task-drawer-open-in-library"
                          className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-medium transition-colors ${
                            isDark
                              ? 'border border-white/[0.08] text-zinc-300 hover:bg-white/[0.04]'
                              : 'border border-zinc-200 text-zinc-600 hover:bg-zinc-100'
                          }`}
                        >
                          Open in Library
                        </button>
                      ) : null}
                    </div>
                  }
                >
                  <ul
                    className={`flex flex-col gap-1.5 border ${radius.card} px-2 py-2 ${surface.inset[theme]}`}
                    data-testid="task-drawer-artifacts"
                  >
                    {taskAssets.map((asset) => (
                      <li key={asset.id}>
                        <button
                          type="button"
                          onClick={() => onOpenAsset?.(asset.id)}
                          disabled={!onOpenAsset}
                          data-testid={`task-drawer-artifact-${asset.id}`}
                          className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg transition-colors text-left ${
                            isDark ? 'hover:bg-white/[0.04]' : 'hover:bg-zinc-100'
                          } disabled:cursor-default`}
                        >
                          <FileText className={`w-3.5 h-3.5 shrink-0 ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`} />
                          <span className={`text-[12px] truncate flex-1 ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
                            {readAssetTitle(asset)}
                          </span>
                          {asset.sizeBytes ? (
                            <span className={`text-[10px] font-mono ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                              {formatBytes(asset.sizeBytes)}
                            </span>
                          ) : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                </Section>
              ) : null}
            </div>

            {/* Footer — ActionFooter only cares about cancel/approve/reject/retry,
                so 'reassign' is filtered out of its busy view. */}
            <ActionFooter
              isDark={isDark}
              task={displayTask}
              busy={busy === 'reassign' ? null : busy}
              showRejectInput={showRejectInput}
              rejectReason={rejectReason}
              onRejectReasonChange={setRejectReason}
              onShowRejectInput={() => setShowRejectInput(true)}
              onCancel={handleCancel}
              onApprove={handleApprove}
              onReject={handleReject}
              onRetry={handleRetry}
            />
          </motion.aside>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────

function Section({
  title,
  isDark,
  badge,
  children,
}: {
  title: string;
  isDark: boolean;
  badge?: ReactNode;
  children: ReactNode;
}): ReactElement {
  return (
    <section>
      <div className="flex items-center gap-2 mb-2">
        <h3
          className={`text-[11px] uppercase tracking-[0.14em] font-semibold ${
            isDark ? 'text-zinc-400' : 'text-zinc-500'
          }`}
        >
          {title}
        </h3>
        {badge}
      </div>
      {children}
    </section>
  );
}

function LiveBadge({ isDark }: { isDark: boolean }): ReactElement {
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-mono uppercase ${
        isDark ? 'bg-emerald-500/15 text-emerald-300' : 'bg-emerald-50 text-emerald-700'
      }`}
    >
      <span className="relative flex w-1.5 h-1.5">
        <span className="absolute inset-0 rounded-full bg-emerald-400 animate-ping opacity-75" />
        <span className="relative inline-flex rounded-full w-1.5 h-1.5 bg-emerald-400" />
      </span>
      live
    </span>
  );
}

function AssigneeAvatar({ task, kind }: { task: TaskDTO; kind: AgentKind | null }): ReactElement {
  const seed = task.assigneeId ?? task.creatorId ?? task.id;
  const grad = avatarGradient(seed);
  const initials = avatarInitials(task.assigneeName ?? task.assigneeId?.slice(-2) ?? '?');
  const ring = kind ? AGENT_KIND_PRESETS[kind].accentRing : 'ring-zinc-400/20';
  return (
    <div
      className={`relative w-10 h-10 rounded-2xl flex items-center justify-center text-xs font-semibold text-white ring-2 ${ring}`}
      style={{
        background: `linear-gradient(135deg, ${grad.from}, ${grad.to})`,
      }}
    >
      {kind === 'cli' ? (
        <Bot className="w-4 h-4" />
      ) : kind === 'long-running' ? (
        <UserIcon className="w-4 h-4" />
      ) : task.assigneeId ? (
        <span>{initials}</span>
      ) : (
        <CircleDashed className="w-4 h-4 opacity-80" />
      )}
    </div>
  );
}

function logToTimelineEntry(log: TaskLogDTO, task: TaskDTO, ts: number): TimelineEntry {
  const action = log.action || 'updated';
  const kind: TimelineEntry['kind'] = (() => {
    if (action.includes('created')) return 'created';
    if (action.includes('assigned') || action.includes('dispatch')) return 'assigned';
    if (action.includes('completed') || action.includes('approved')) return 'completed';
    if (action.includes('failed') || action.includes('rejected')) return 'failed';
    if (action.includes('cancelled')) return 'cancelled';
    if (action.includes('review')) return 'review';
    return 'progress';
  })();

  const label = (() => {
    switch (kind) {
      case 'created':
        return 'Task created';
      case 'assigned':
        if (action.includes('dispatch')) return 'Dispatched to runtime';
        return `Assigned to ${task.assigneeName ?? task.assigneeId?.slice(-8) ?? 'assignee'}`;
      case 'completed':
        return action.includes('approved') ? 'Approved' : 'Completed';
      case 'failed':
        return action.includes('rejected') ? 'Rejected' : 'Failed';
      case 'cancelled':
        return 'Cancelled';
      case 'review':
        return 'Awaiting review';
      case 'progress':
        return humanizeAction(action);
    }
  })();

  return {
    key: `log-${log.id}`,
    kind,
    label,
    ts,
    message: log.message,
    actorId: log.actorId,
    metadata: log.metadata,
  };
}

function dedupeTimeline(entries: TimelineEntry[]): TimelineEntry[] {
  const seen = new Set<string>();
  const out: TimelineEntry[] = [];
  for (const entry of entries) {
    const sig = `${entry.kind}:${entry.ts}:${entry.label}:${entry.message ?? ''}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(entry);
  }
  return out;
}

function TimelineRow({ entry, isDark }: { entry: TimelineEntry; isDark: boolean }): ReactElement {
  const dotClass = (() => {
    switch (entry.kind) {
      case 'created':
        return 'bg-zinc-400';
      case 'assigned':
        return 'bg-sky-400';
      case 'progress':
        return 'bg-amber-400';
      case 'review':
        return 'bg-violet-400';
      case 'completed':
        return 'bg-emerald-400';
      case 'failed':
        return 'bg-rose-400';
      case 'cancelled':
        return 'bg-zinc-500';
    }
  })();
  return (
    <li className="relative pl-5 py-2">
      <span
        className={`absolute left-0 top-3 w-3 h-3 rounded-full ring-4 ${dotClass} ${
          isDark ? 'ring-zinc-900/85' : 'ring-white/90'
        }`}
      />
      <div className="flex items-baseline justify-between gap-3">
        <p className={`text-sm font-medium ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>{entry.label}</p>
        <time
          dateTime={new Date(entry.ts).toISOString()}
          className={`shrink-0 text-[10px] font-mono ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
          title={new Date(entry.ts).toISOString()}
        >
          {formatRelative(entry.ts)}
        </time>
      </div>
      {entry.message ? (
        <p className={`mt-0.5 text-[12px] leading-snug ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
          {entry.message}
        </p>
      ) : null}
      {entry.actorId ? (
        <p className={`mt-1 font-mono text-[10px] ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
          actor {entry.actorId.slice(-10)}
        </p>
      ) : null}
    </li>
  );
}

function ResultBlock({ task, isDark }: { task: TaskDTO; isDark: boolean }): ReactElement {
  const theme: 'dark' | 'light' = isDark ? 'dark' : 'light';
  // task.result arrives as `unknown` after JSON parse on the cloud side.
  // Common shapes: string | { output: string, metrics?: ... } | arbitrary obj.
  const raw = (task as unknown as { result?: unknown }).result;
  const error = (task as unknown as { error?: string | null }).error;
  let body: string;
  let metrics: unknown = null;
  if (error) {
    body = error;
  } else if (raw == null) {
    body = '(no result)';
  } else if (typeof raw === 'string') {
    body = raw;
  } else if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.output === 'string') {
      body = obj.output;
      metrics = obj.metrics ?? null;
    } else {
      body = safeStringify(raw);
    }
  } else {
    body = String(raw);
  }
  return (
    <div className="space-y-2">
      <pre
        className={`whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed border ${radius.card} px-4 py-3 max-h-[320px] overflow-auto ${surface.inset[theme]} ${
          isDark ? 'text-zinc-100' : 'text-zinc-900'
        }`}
      >
        {body}
      </pre>
      {metrics ? (
        <details className={`text-[11px] ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
          <summary className="cursor-pointer select-none">metrics</summary>
          <pre
            className={`mt-1 whitespace-pre-wrap break-words font-mono px-3 py-2 ${radius.card} ${surface.inset[theme]}`}
          >
            {safeStringify(metrics)}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

function isShellTask(task: TaskDTO): boolean {
  const execution = task.metadata?.execution;
  return (
    task.capability === 'shell' ||
    Boolean(
      execution && typeof execution === 'object' && !Array.isArray(execution) && (execution as any).kind === 'shell',
    )
  );
}

function readTaskBody(task: TaskDTO): string | null {
  // description is the single source of truth (post-collapse). The
  // `input.prompt` branch is a legacy tail for rows created before the
  // collapse refactor — drop it after a backfill migrates old rows.
  if (task.description?.trim()) return task.description;
  const legacyPrompt = task.input?.prompt;
  if (typeof legacyPrompt === 'string' && legacyPrompt.trim()) return legacyPrompt;
  const command = task.metadata?.execution;
  if (command && typeof command === 'object' && !Array.isArray(command)) {
    const cmd = (command as Record<string, unknown>).command;
    if (typeof cmd === 'string' && cmd.trim()) return cmd;
  }
  return null;
}

function humanizeAction(action: string): string {
  return action
    .replace(/^human_forced_/, 'Moved to ')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function formatLiveProgress(evt: LiveProgressEvent): string {
  const detail = evt.metadata;
  const stream = detail?.stream;
  const chunk = detail?.chunk;
  if ((stream === 'stdout' || stream === 'stderr') && typeof chunk === 'string') {
    return `[${stream}] ${chunk}`;
  }
  return evt.message ?? (typeof evt.progress === 'number' ? `progress ${Math.round(evt.progress * 100)}%` : '·');
}

function ActionFooter({
  isDark,
  task,
  busy,
  showRejectInput,
  rejectReason,
  onRejectReasonChange,
  onShowRejectInput,
  onCancel,
  onApprove,
  onReject,
  onRetry,
}: {
  isDark: boolean;
  task: TaskDTO;
  busy: null | 'cancel' | 'approve' | 'reject' | 'retry';
  showRejectInput: boolean;
  rejectReason: string;
  onRejectReasonChange: (v: string) => void;
  onShowRejectInput: () => void;
  onCancel: () => void;
  onApprove: () => void;
  onReject: () => void;
  onRetry: () => void;
}): ReactElement {
  const canCancel = isCancellableStatus(task.status);
  const isReview = task.status === 'review';
  const isFailed = task.status === 'failed';
  const isTerminal = TERMINAL_STATUSES.has(task.status);

  if (!canCancel && !isReview && !isFailed) {
    if (isTerminal) {
      return (
        <footer
          className={`px-6 py-3 border-t text-[11px] ${
            isDark ? 'border-white/5 text-zinc-500' : 'border-zinc-200 text-zinc-500'
          }`}
        >
          <span className="flex items-center gap-2">
            <Terminal className="w-3 h-3" />
            Task is {task.status}.
          </span>
        </footer>
      );
    }
    return <footer className="px-6 py-2" />;
  }

  return (
    <footer className={`px-6 py-3 border-t space-y-2 ${isDark ? 'border-white/5' : 'border-zinc-200'}`}>
      {showRejectInput ? (
        <input
          type="text"
          autoFocus
          value={rejectReason}
          onChange={(e) => onRejectReasonChange(e.target.value)}
          placeholder="Reason for rejection (required)…"
          className={`w-full px-3 py-2 ${radius.button} text-[13px] outline-none border transition-colors ${
            isDark
              ? 'bg-zinc-950/60 border-white/10 text-zinc-100 focus:border-rose-400/60 placeholder-zinc-500'
              : 'bg-white border-zinc-200 text-zinc-900 focus:border-rose-400 placeholder-zinc-400'
          }`}
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {canCancel ? (
          <FooterButton
            variant="rose"
            isDark={isDark}
            onClick={onCancel}
            busy={busy === 'cancel'}
            label="Cancel task"
            icon={<X className="w-3.5 h-3.5" />}
            testId="task-drawer-cancel"
          />
        ) : null}
        {isReview ? (
          <>
            <FooterButton
              variant="emerald"
              isDark={isDark}
              onClick={onApprove}
              busy={busy === 'approve'}
              label="Approve"
              icon={<Check className="w-3.5 h-3.5" />}
              testId="task-drawer-approve"
            />
            <FooterButton
              variant="rose"
              isDark={isDark}
              onClick={showRejectInput ? onReject : onShowRejectInput}
              busy={busy === 'reject'}
              label={showRejectInput ? 'Confirm reject' : 'Reject'}
              icon={<X className="w-3.5 h-3.5" />}
              testId="task-drawer-reject"
            />
          </>
        ) : null}
        {isFailed ? (
          <FooterButton
            variant="violet"
            isDark={isDark}
            onClick={onRetry}
            busy={busy === 'retry'}
            label="Retry"
            icon={<RotateCw className="w-3.5 h-3.5" />}
            testId="task-drawer-retry"
          />
        ) : null}
      </div>
    </footer>
  );
}

type FooterVariant = 'rose' | 'emerald' | 'violet';

const FOOTER_VARIANT: Record<FooterVariant, { dark: string; light: string; busy: string }> = {
  rose: {
    dark: 'bg-rose-500/15 border-rose-400/30 text-rose-200 hover:bg-rose-500/25',
    light: 'bg-rose-50 border-rose-200 text-rose-700 hover:bg-rose-100',
    busy: 'bg-rose-500/10 text-rose-300/60',
  },
  emerald: {
    dark: 'bg-emerald-500/15 border-emerald-400/30 text-emerald-200 hover:bg-emerald-500/25',
    light: 'bg-emerald-50 border-emerald-200 text-emerald-700 hover:bg-emerald-100',
    busy: 'bg-emerald-500/10 text-emerald-300/60',
  },
  violet: {
    dark: 'bg-violet-500/15 border-violet-400/30 text-violet-200 hover:bg-violet-500/25',
    light: 'bg-violet-50 border-violet-200 text-violet-700 hover:bg-violet-100',
    busy: 'bg-violet-500/10 text-violet-300/60',
  },
};

function FooterButton({
  variant,
  isDark,
  onClick,
  busy,
  label,
  icon,
  testId,
}: {
  variant: FooterVariant;
  isDark: boolean;
  onClick: () => void;
  busy: boolean;
  label: string;
  icon: ReactNode;
  testId?: string;
}): ReactElement {
  const v = FOOTER_VARIANT[variant];
  return (
    <motion.button
      type="button"
      onClick={onClick}
      disabled={busy}
      data-testid={testId}
      whileHover={{ scale: busy ? 1 : 1.02 }}
      whileTap={{ scale: busy ? 1 : 0.97 }}
      transition={springSnap}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 ${radius.button} text-[12px] font-medium border transition-colors disabled:cursor-not-allowed ${
        busy ? v.busy : isDark ? v.dark : v.light
      }`}
    >
      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : icon}
      {label}
    </motion.button>
  );
}

// ─────────────────────────────────────────────────────────────────────
// W2 — Breadcrumb + AssigneePicker
// ─────────────────────────────────────────────────────────────────────

function Breadcrumb({
  chain,
  current,
  isDark,
  onOpenTask,
}: {
  chain: TaskDTO[];
  current: TaskDTO;
  isDark: boolean;
  onOpenTask?: (taskId: string) => void;
}): ReactElement {
  return (
    <nav
      data-testid="task-drawer-breadcrumb"
      className={`mb-3 flex items-center gap-1 text-[10px] flex-wrap ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}
    >
      {chain.map((parent, i) => {
        const refs = readParentRefs(parent);
        const role: 'goal' | 'work' = refs.kind === 'goal' ? 'goal' : 'work';
        return (
          <span key={parent.id} className="inline-flex items-center gap-1">
            <button
              type="button"
              disabled={!onOpenTask}
              onClick={() => onOpenTask?.(parent.id)}
              data-testid={`task-drawer-breadcrumb-chip-${i}`}
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md transition-colors max-w-[200px] ${
                isDark
                  ? 'bg-white/[0.04] hover:bg-white/[0.08] text-zinc-300'
                  : 'bg-zinc-100 hover:bg-zinc-200 text-zinc-700'
              } disabled:cursor-default disabled:opacity-70`}
            >
              {role === 'goal' ? <Target className="w-3 h-3 shrink-0" /> : <Hash className="w-3 h-3 shrink-0" />}
              <span className="truncate">{parent.title || parent.id.slice(-8)}</span>
            </button>
            <ChevronRight className="w-3 h-3 opacity-50" />
          </span>
        );
      })}
      <span
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md font-medium ${
          isDark ? 'bg-violet-500/15 text-violet-200' : 'bg-violet-50 text-violet-700'
        }`}
      >
        {readParentRefs(current).kind === 'agent_run' ? 'Run' : 'Here'}
      </span>
    </nav>
  );
}

function AssigneePicker({
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
}): ReactElement {
  // Outside-click dismiss is handled by the popover wrapper itself: clicking
  // anywhere on the backdrop closes it. ESC also closes via the global
  // drawer ESC handler triggering re-render with assigneePickerOpen reset.
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden />
      <div
        data-testid="task-drawer-assignee-picker"
        className={`absolute left-0 right-0 top-full z-50 mt-2 max-h-72 overflow-y-auto rounded-xl border shadow-xl ${
          isDark ? 'bg-zinc-900 border-white/10' : 'bg-white border-zinc-200'
        }`}
      >
        <ul className="p-1">
          <li>
            <button
              type="button"
              disabled={busy}
              onClick={() => onPick(null)}
              data-testid="task-drawer-assignee-pick-unassign"
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left text-[12px] transition-colors ${
                isDark ? 'text-zinc-300 hover:bg-white/[0.04]' : 'text-zinc-700 hover:bg-zinc-100'
              } ${currentAssigneeId == null ? 'font-semibold' : ''} disabled:opacity-50`}
            >
              <CircleDashed className="w-3.5 h-3.5" />
              Unassign
            </button>
          </li>
          {agents.length === 0 ? (
            <li className={`px-3 py-2 text-[11px] italic ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
              No agents in this workspace yet.
            </li>
          ) : null}
          {agents.map((agent) => {
            const isCurrent = agent.userId === currentAssigneeId;
            return (
              <li key={agent.userId}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onPick(agent.userId)}
                  data-testid={`task-drawer-assignee-pick-${agent.userId}`}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left text-[12px] transition-colors ${
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

function readAssetTitle(asset: AssetDTO): string {
  const meta = asset.metadata ?? {};
  const t = (meta as Record<string, unknown>).title;
  if (typeof t === 'string' && t.trim()) return t;
  return asset.id.slice(-12);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function formatClock(ts: number): string {
  if (!Number.isFinite(ts)) return '--:--:--';
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function formatRelative(ts: number): string {
  if (!Number.isFinite(ts)) return '';
  const delta = Date.now() - ts;
  if (delta < 0) {
    const future = Math.abs(delta);
    if (future < 60_000) return 'soon';
    return new Date(ts).toLocaleString();
  }
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
