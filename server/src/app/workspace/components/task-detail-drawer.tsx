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
import Editor from '@monaco-editor/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  ClipboardCopy,
  Coins,
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
import { getAgentRoleIcon } from '../lib/agent-role-icon';
import type { AgentLiveStatus } from '../lib/agent-status';
import { AgentAvatar } from './agent-avatar';
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
import { isCancellableStatus, transitionTask, updateTask } from '../lib/mutations';
import type { AgentDTO, AssetDTO, TaskDTO, TaskDetailDTO, TaskLogDTO, TaskRunEventDTO } from '../lib/types';
import { copyText } from '@/lib/clipboard';
import { MemoryTextPreview } from './memory-text-preview';
import { WorkProductCard } from './work-products';
import { TaskDescriptionEditor } from './task-description-editor';
import {
  buildAssetRefsFromDescription,
  extractAssetUris,
  removeAssetUri,
  resolveAssetUris,
} from '../lib/task-asset-refs';
import { TaskCriteriaEditor, type CriterionDraft } from './task-criteria-editor';

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
  /** Task 3 — workspace-wide agent live status map (from page.tsx). */
  agentStatuses?: Map<string, AgentLiveStatus>;
  /** All workspace assets — drawer filters to ones produced by this task. */
  assets?: AssetDTO[];
  /**
   * P6.5 inline edit (§6.2): IM user id of the viewer. Used to gate the
   * title / description / priority edit affordances client-side. Backend
   * already enforces permissions on PATCH /tasks/:id, so this is only a UX
   * gate — when unset the affordances simply stay hidden.
   */
  currentUserId?: string | null;
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

// P6.5 — priority values picker can write. Mirrors `priorityAccent` keys in
// design.ts so the chip + dropdown render with the same palette tokens.
type TaskPriorityValue = 'low' | 'medium' | 'high' | 'urgent';
const PRIORITY_OPTIONS: TaskPriorityValue[] = ['urgent', 'high', 'medium', 'low'];

// ─────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────

export function TaskDetailDrawer({
  isDark,
  task,
  agents,
  agentStatuses,
  assets,
  currentUserId,
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

  // ─── P6.5 — inline edit state (closes §6.2 gap) ───────────────────
  //
  // Three independent local edit machines for title / description / priority.
  // They're kept separate (vs one shared hook) because each has distinct save
  // semantics (Enter / Cmd+Enter / pick-saves), and merging them would create
  // more conditional branches than the duplication costs.
  //
  // `optimisticOverlay` is a shallow patch applied on top of `displayTask`
  // BEFORE the await on updateTask — that's how the new value appears
  // immediately. On failure the relevant overlay keys are cleared and
  // `notify` surfaces the error.
  type OptimisticOverlay = Partial<{
    title: string;
    description: string | null;
    metadata: Record<string, unknown>;
  }>;
  const [optimisticOverlay, setOptimisticOverlay] = useState<OptimisticOverlay>({});
  const [titleEdit, setTitleEdit] = useState<{ editing: boolean; value: string; saving: boolean }>({
    editing: false,
    value: '',
    saving: false,
  });
  const [descEdit, setDescEdit] = useState<{ editing: boolean; value: string; saving: boolean }>({
    editing: false,
    value: '',
    saving: false,
  });
  const [priorityEdit, setPriorityEdit] = useState<{ open: boolean; saving: boolean }>({
    open: false,
    saving: false,
  });
  const priorityWrapperRef = useRef<HTMLDivElement>(null);

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
    // P6.5 — drop any pending edits / optimistic overlay when the focused
    // task changes so stale buffers don't leak between drawer sessions.
    setOptimisticOverlay({});
    setTitleEdit({ editing: false, value: '', saving: false });
    setDescEdit({ editing: false, value: '', saving: false });
    setPriorityEdit({ open: false, saving: false });
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

  const baseTask = detail?.task ?? task;
  // P6.5 — merge optimistic overlay so newly-edited title / description /
  // priority appear instantly. Metadata is shallow-merged so we don't blow
  // away unrelated bag fields (parentTaskId, kanban, execution, …) when only
  // priority changes.
  const displayTask = useMemo<TaskDTO | null>(() => {
    if (!baseTask) return null;
    const hasOverlay =
      optimisticOverlay.title !== undefined ||
      optimisticOverlay.description !== undefined ||
      optimisticOverlay.metadata !== undefined;
    if (!hasOverlay) return baseTask;
    return {
      ...baseTask,
      ...(optimisticOverlay.title !== undefined ? { title: optimisticOverlay.title } : null),
      ...(optimisticOverlay.description !== undefined ? { description: optimisticOverlay.description } : null),
      metadata: optimisticOverlay.metadata
        ? { ...(baseTask.metadata ?? {}), ...optimisticOverlay.metadata }
        : baseTask.metadata,
    };
  }, [baseTask, optimisticOverlay]);

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
    for (const event of detail?.runEvents ?? []) {
      const ts = Date.parse(event.createdAt);
      if (!Number.isFinite(ts)) continue;
      entries.push(runEventToTimelineEntry(event, ts));
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
  }, [displayTask, detail?.logs, detail?.runEvents, liveEvents]);

  const progressPct =
    displayTask && typeof displayTask.progress === 'number'
      ? Math.round(Math.max(0, Math.min(1, displayTask.progress)) * 100)
      : null;

  const priority = displayTask ? readTaskPriority(displayTask) : 'medium';
  const statusInfo = displayTask ? (statusAccent[displayTask.status] ?? statusAccent.backlog) : null;
  const taskBody = displayTask ? readTaskBody(displayTask) : null;

  // ─── P6.5 — permission gate for inline edit affordances ──────────────
  //
  // Backend enforces the real matrix (L0/L1/L2 always; L3 only if creator;
  // L4 executor never — see §6.2). This client-side gate is **fail-open**:
  // we surface the edit affordance and let the backend reject when needed.
  //
  // The earlier fail-closed creator-only fallback hid the edit affordance
  // for any task NOT created by the current user — which in practice means
  // any task minted via agent dispatch (creatorId = agent.id ≠ user.id).
  // That swallowed the most common edit case for human owners. Backend
  // 403 + the existing `notify?.(..., 'error')` plumbing in the save
  // handlers is the right safety net.
  //
  // Only two explicit hides:
  //   1. `viewerAccess.canManage === false` (read it if backend ever emits
  //      it on TaskDTO; harmless cast otherwise).
  //   2. Executor-as-self: an agent viewer who's also the assignee can't
  //      rewrite the spec it was handed. (Today `currentUserId` is always
  //      a human in this UI, so this branch is forward-compat for when
  //      agents render the drawer.)
  const canEditContent = useMemo<boolean>(() => {
    if (!displayTask) return false;
    const access = (displayTask as unknown as { viewerAccess?: { canManage?: boolean } }).viewerAccess;
    if (access?.canManage === false) return false;
    if (displayTask.assigneeType === 'agent' && displayTask.assigneeId && displayTask.assigneeId === currentUserId) {
      return false;
    }
    return true;
  }, [displayTask, currentUserId]);

  // ─── Actions ──────────────────────────────────────────────────────

  // v2.0 P5 — Cancel / Approve / Reject all route through the unified
  // state-machine endpoint so the server's TRANSITIONS matrix is the
  // single source of truth for what's allowed and who can do it.
  const handleCancel = useCallback(async () => {
    if (!task || busy) return;
    setBusy('cancel');
    const res = await transitionTask(task.id, { to: 'cancelled', reason: 'Cancelled by user' });
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
    const res = await transitionTask(task.id, { to: 'completed', reason: 'Approved' });
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
    // Reject: review → assigned (back to the assignee with a comment).
    // `reviewComment` is the structured field the server expects; we also
    // pass `reason` so the transition log carries it.
    const res = await transitionTask(task.id, {
      to: 'assigned',
      reason: 'Rejected — needs rework',
      reviewComment: reason,
    });
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
    void copyText(task.id).then((res) => {
      notify?.(res.ok ? 'Task ID copied.' : (res.error ?? 'Copy failed.'), res.ok ? 'success' : 'error');
    });
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

  // ─── P6.5 — inline edit handlers (F1 title, F2 description, F3 priority) ──
  //
  // All three follow the same shape:
  //   1. Capture pre-edit value (for rollback).
  //   2. Apply optimistic overlay so UI updates BEFORE the await.
  //   3. Await updateTask.
  //   4. On failure: roll back overlay, surface notify error.
  //   5. On success: keep overlay until onChanged refreshes the canonical task.

  const handleSaveTitle = useCallback(async () => {
    if (!task) return;
    const trimmed = titleEdit.value.trim();
    // Empty title is rejected by the server too — bail before optimistic flip.
    if (!trimmed) {
      notify?.('Title cannot be empty.', 'error');
      return;
    }
    const previousTitle = displayTask?.title ?? '';
    if (trimmed === previousTitle) {
      // No-op edit; just exit edit mode.
      setTitleEdit({ editing: false, value: '', saving: false });
      return;
    }
    setTitleEdit((prev) => ({ ...prev, saving: true }));
    setOptimisticOverlay((prev) => ({ ...prev, title: trimmed }));
    const res = await updateTask(task.id, { title: trimmed });
    if (!res.ok) {
      // Rollback: drop the title key from overlay so UI reverts.
      setOptimisticOverlay((prev) => {
        const { title: _drop, ...rest } = prev;
        void _drop;
        return rest;
      });
      setTitleEdit((prev) => ({ ...prev, saving: false }));
      notify?.(`Couldn't save title: ${res.message}`, 'error');
      return;
    }
    setTitleEdit({ editing: false, value: '', saving: false });
    notify?.('Title saved.', 'success');
    onChanged?.();
  }, [task, displayTask, titleEdit.value, notify, onChanged]);

  const handleCancelTitle = useCallback(() => {
    setTitleEdit({ editing: false, value: '', saving: false });
  }, []);

  const handleSaveDescription = useCallback(async () => {
    if (!task) return;
    const trimmed = descEdit.value;
    const previousDesc = displayTask?.description ?? '';
    if (trimmed === previousDesc) {
      setDescEdit({ editing: false, value: '', saving: false });
      return;
    }
    // Empty string → server clears description (description: null).
    const wireValue: string | null = trimmed.trim() === '' ? null : trimmed;
    setDescEdit((prev) => ({ ...prev, saving: true }));
    setOptimisticOverlay((prev) => ({ ...prev, description: wireValue }));
    // Wave-8 W1 / L2: extract `prismer://...asset/<hash>` URIs from the
    // new description text, cross-reference with the workspace asset list,
    // and send `assetRefs[]` alongside the PATCH. Server validates them
    // and folds into metadata.assets.linkedAssetIds so the daemon's
    // dispatch hydrator picks them up. We send `assetRefs` only when the
    // workspace asset list is available — otherwise the server can't
    // validate, and we don't want to spuriously clear anything.
    // Send `assetRefs` unconditionally (even when refs=[]) so the server
    // can drop `linkedAssetIds` when the user removed the last URI from
    // the description — the conditional spread used here previously meant
    // the field was omitted, and the daemon kept re-attaching dropped refs.
    const refs = displayTask?.workspaceId
      ? buildAssetRefsFromDescription(wireValue, assets, displayTask.workspaceId)
      : [];
    const res = await updateTask(task.id, {
      description: wireValue,
      assetRefs: refs,
    });
    if (!res.ok) {
      setOptimisticOverlay((prev) => {
        const { description: _drop, ...rest } = prev;
        void _drop;
        return rest;
      });
      setDescEdit((prev) => ({ ...prev, saving: false }));
      notify?.(`Couldn't save description: ${res.message}`, 'error');
      return;
    }
    setDescEdit({ editing: false, value: '', saving: false });
    notify?.('Description saved.', 'success');
    onChanged?.();
  }, [task, displayTask, descEdit.value, assets, notify, onChanged]);

  const handleCancelDescription = useCallback(() => {
    setDescEdit({ editing: false, value: '', saving: false });
  }, []);

  const handlePickPriority = useCallback(
    async (next: TaskPriorityValue) => {
      if (!task) return;
      const currentPriority = priority;
      if (next === currentPriority) {
        setPriorityEdit({ open: false, saving: false });
        return;
      }
      setPriorityEdit({ open: false, saving: true });
      const existingMeta = (displayTask?.metadata ?? {}) as Record<string, unknown>;
      const nextMeta = { ...existingMeta, priority: next };
      setOptimisticOverlay((prev) => ({
        ...prev,
        metadata: { ...(prev.metadata ?? {}), priority: next },
      }));
      const res = await updateTask(task.id, { metadata: nextMeta });
      if (!res.ok) {
        // Rollback: clear priority from overlay.metadata. If overlay.metadata
        // only held priority, drop the key entirely so we revert cleanly.
        setOptimisticOverlay((prev) => {
          if (!prev.metadata) return prev;
          const { priority: _drop, ...rest } = prev.metadata as Record<string, unknown>;
          void _drop;
          if (Object.keys(rest).length === 0) {
            const { metadata: _m, ...without } = prev;
            void _m;
            return without;
          }
          return { ...prev, metadata: rest };
        });
        setPriorityEdit({ open: false, saving: false });
        notify?.(`Couldn't change priority: ${res.message}`, 'error');
        return;
      }
      setPriorityEdit({ open: false, saving: false });
      notify?.('Priority updated.', 'success');
      onChanged?.();
    },
    [task, displayTask, priority, notify, onChanged],
  );

  // Outside-click + Escape close for the priority dropdown. Mirrors the
  // pattern used by asset-filter-menu so behaviour feels consistent.
  useEffect(() => {
    if (!priorityEdit.open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPriorityEdit({ open: false, saving: false });
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (priorityWrapperRef.current?.contains(target)) return;
      setPriorityEdit({ open: false, saving: false });
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [priorityEdit.open]);

  // W2-T2: assets produced by this task (sourceTaskId match). The drawer
  // already had a result viewer; this surfaces structured artifacts that
  // the agent uploaded as side-effects of the run, separate from inline
  // result text.
  //
  // 2026-05-23 fix: rely on a per-task targeted fetch instead of filtering
  // the workspace-level `assets` prop alone. Page-level `reloadAssets`
  // pulls `/assets?workspaceId=X&limit=100`, so workspaces with > 100 total
  // assets push agent-output rows beyond the cutoff and the drawer would
  // show no artifacts even when the task did upload files. Forensic on
  // test env (5/22) showed 31 agent-output assets but only ~2 surfaced.
  const [drawerFetchedAssets, setDrawerFetchedAssets] = useState<AssetDTO[]>([]);
  useEffect(() => {
    if (!task?.id || !task.workspaceId) {
      setDrawerFetchedAssets([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const res = await imFetch<AssetDTO[]>(
        `/assets?workspaceId=${encodeURIComponent(task.workspaceId!)}&taskId=${encodeURIComponent(task.id)}&limit=50`,
      );
      if (cancelled) return;
      if (res.ok) setDrawerFetchedAssets(res.data ?? []);
      else setDrawerFetchedAssets([]);
    })();
    return () => {
      cancelled = true;
    };
  }, [task?.id, task?.workspaceId]);

  const taskAssets = useMemo<AssetDTO[]>(() => {
    if (!task) return [];
    // Combine workspace-level filter (covers the case where assets prop
    // already has it) + drawer-level targeted fetch (covers the >100-cap
    // overflow case). Dedupe by id.
    //
    // release201/09 §9.4a.4 — Artifacts tab is task-bound only. When
    // an owner clicks Promote ↑ on a row, its boundKind flips to
    // 'workspace-file' and it disappears from this filtered list (moves
    // to Library Root); the user gets the success toast and the row
    // visibly drops out without a full reload.
    const byId = new Map<string, AssetDTO>();
    if (assets) {
      for (const a of assets) {
        if (a.sourceTaskId === task.id && (a.boundKind ?? 'task-bound') === 'task-bound') {
          byId.set(a.id, a);
        }
      }
    }
    for (const a of drawerFetchedAssets) {
      if ((a.boundKind ?? 'task-bound') === 'task-bound') {
        byId.set(a.id, a);
      }
    }
    return Array.from(byId.values()).sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return tb - ta;
    });
  }, [task, assets, drawerFetchedAssets]);

  /**
   * release201/09 §9.4a.4 — Promote a task-bound asset to workspace-file
   * scope. Single PATCH /api/im/assets/:id that flips boundKind +
   * sourceTaskId + folderPath in one call; on success we trigger a
   * refresh through the existing onTaskChanged path so the Artifacts list
   * re-renders without the promoted row.
   */
  const handlePromoteAsset = useCallback(
    async (assetId: string) => {
      const token = getWorkspaceToken();
      if (!token) {
        notify?.('Not authenticated.', 'error');
        return;
      }
      try {
        const res = await fetch(`/api/im/assets/${encodeURIComponent(assetId)}`, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            boundKind: 'workspace-file',
            sourceTaskId: null,
            folderPath: null,
          }),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          notify?.(`Promote failed: ${res.status} ${text.slice(0, 120)}`, 'error');
          return;
        }
        notify?.('Promoted to workspace file. Now visible in Library Root.', 'success');
        // Trigger the drawer's existing refresh path so Artifacts list
        // refetches and the promoted row drops.
        onChanged?.();
      } catch (err) {
        notify?.(`Promote failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    },
    [notify, onChanged],
  );

  // Wave-8 W1 / L4: attached assets — extracted from any
  // `prismer://workspace/<wsId>/asset/<hash>` URIs in the description text
  // and cross-referenced against the workspace asset list for display
  // metadata (filename + mime + size). Distinct from `taskAssets` above
  // (those are products of the task; these are inputs the human attached).
  //
  // We deliberately do this against the displayTask body — the same text
  // we render in the description preview — so the chip row stays in lock
  // step with what the user can see. When the editor is open the chips
  // still reflect the LAST SAVED body; the X-button in chips writes-through
  // to the description, which then re-runs through `displayTask`.
  const attachedAssets = useMemo(() => {
    if (!displayTask || !assets) return [];
    const wsId = displayTask.workspaceId;
    if (!wsId) return [];
    const sourceText = displayTask.description ?? taskBody ?? '';
    const extracted = extractAssetUris(sourceText);
    if (extracted.length === 0) return [];
    return resolveAssetUris(extracted, assets, wsId);
  }, [displayTask, assets, taskBody]);

  // Wave-8 W1 / L4: detach an asset from the description by stripping its
  // URI and writing the new description back through the existing PATCH
  // flow. Triggers the same `assetRefs[]` re-validation as a manual save
  // because the URI is gone, so the resulting refs list shrinks by one.
  const handleDetachAsset = useCallback(
    async (contentHash: string) => {
      if (!task || !displayTask) return;
      const currentBody = displayTask.description ?? taskBody ?? '';
      const nextBody = removeAssetUri(currentBody, contentHash);
      if (nextBody === currentBody) return;
      const wireValue: string | null = nextBody.trim() === '' ? null : nextBody;
      setOptimisticOverlay((prev) => ({ ...prev, description: wireValue }));
      // Always send `assetRefs` (even empty) — when the user removed the
      // last attachment, the server needs the explicit `[]` to clear
      // `linkedAssetIds`. Conditional spread would silently keep the old
      // refs and the daemon dispatch would re-attach the dropped asset.
      const refs = displayTask.workspaceId
        ? buildAssetRefsFromDescription(wireValue, assets, displayTask.workspaceId)
        : [];
      const res = await updateTask(task.id, {
        description: wireValue,
        assetRefs: refs,
      });
      if (!res.ok) {
        setOptimisticOverlay((prev) => {
          const { description: _drop, ...rest } = prev;
          void _drop;
          return rest;
        });
        notify?.(`Couldn't detach asset: ${res.message}`, 'error');
        return;
      }
      notify?.('Attachment removed.', 'success');
      onChanged?.();
    },
    [task, displayTask, assets, taskBody, notify, onChanged],
  );

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

                {/* Title — F1 inline editable. Click to enter edit mode,
                    Enter / blur saves, Escape cancels. Hidden when the
                    viewer doesn't have edit permission. */}
                {titleEdit.editing ? (
                  <input
                    type="text"
                    autoFocus
                    value={titleEdit.value}
                    disabled={titleEdit.saving}
                    onChange={(event) => setTitleEdit((prev) => ({ ...prev, value: event.target.value }))}
                    onBlur={() => {
                      if (titleEdit.saving) return;
                      void handleSaveTitle();
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        void handleSaveTitle();
                      } else if (event.key === 'Escape') {
                        event.preventDefault();
                        handleCancelTitle();
                      }
                    }}
                    data-testid="task-drawer-title-input"
                    className={`mt-3 w-full pr-10 text-xl font-bold leading-tight outline-none border px-2.5 py-1 ${radius.small} ${surface.inset[theme]} ${
                      isDark ? 'text-zinc-50 focus:border-violet-400/60' : 'text-zinc-900 focus:border-violet-500'
                    } disabled:opacity-60`}
                  />
                ) : canEditContent ? (
                  <button
                    type="button"
                    onClick={() =>
                      setTitleEdit({
                        editing: true,
                        value: displayTask.title || '',
                        saving: false,
                      })
                    }
                    data-testid="task-drawer-title"
                    title="Click to edit title"
                    className={`group mt-3 pr-10 w-full text-left text-xl font-bold leading-tight transition-colors rounded ${
                      isDark ? 'text-zinc-50 hover:bg-white/[0.04]' : 'text-zinc-900 hover:bg-zinc-100/70'
                    }`}
                  >
                    {displayTask.title || 'Untitled task'}
                    <Pencil
                      className={`inline-block ml-2 w-3.5 h-3.5 align-middle opacity-0 group-hover:opacity-100 transition-opacity ${
                        isDark ? 'text-zinc-500' : 'text-zinc-400'
                      }`}
                    />
                  </button>
                ) : (
                  <h2
                    data-testid="task-drawer-title"
                    className={`mt-3 pr-10 text-xl font-bold leading-tight ${isDark ? 'text-zinc-50' : 'text-zinc-900'}`}
                  >
                    {displayTask.title || 'Untitled task'}
                  </h2>
                )}

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
                  {/* F3 — priority chip → picker. Hidden affordance when
                      the viewer can't manage; renders as a static chip then. */}
                  {canEditContent ? (
                    <div ref={priorityWrapperRef} className="relative inline-flex">
                      <button
                        type="button"
                        onClick={() => setPriorityEdit((prev) => ({ open: !prev.open, saving: prev.saving }))}
                        disabled={priorityEdit.saving}
                        aria-haspopup="menu"
                        aria-expanded={priorityEdit.open}
                        data-testid="task-drawer-priority-chip"
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1 ${radius.chip} text-[11px] transition-colors ${priorityAccent[priority].chipBg} hover:brightness-110 disabled:opacity-60`}
                      >
                        <span className={`inline-block w-1.5 h-1.5 ${radius.chip} ${priorityAccent[priority].dot}`} />
                        {priorityAccent[priority].label}
                        {priorityEdit.saving ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <ChevronDown
                            className={`w-3 h-3 transition-transform ${priorityEdit.open ? 'rotate-180' : ''}`}
                          />
                        )}
                      </button>
                      {priorityEdit.open ? (
                        <div
                          role="menu"
                          data-testid="task-drawer-priority-menu"
                          className={`absolute left-0 top-full z-30 mt-1.5 w-36 overflow-hidden rounded-xl border p-1 shadow-2xl ${
                            isDark
                              ? 'border-white/[0.08] bg-zinc-950 text-zinc-100'
                              : 'border-zinc-200 bg-white text-zinc-900'
                          }`}
                        >
                          {PRIORITY_OPTIONS.map((option) => {
                            const active = option === priority;
                            const accent = priorityAccent[option];
                            return (
                              <button
                                key={option}
                                type="button"
                                role="menuitem"
                                onClick={() => void handlePickPriority(option)}
                                data-testid={`task-drawer-priority-option-${option}`}
                                className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] transition-colors ${
                                  isDark ? 'hover:bg-white/[0.05]' : 'hover:bg-zinc-100'
                                } ${active ? 'font-semibold' : ''}`}
                              >
                                <span className="inline-flex items-center gap-2">
                                  <span className={`inline-block w-1.5 h-1.5 ${radius.chip} ${accent.dot}`} />
                                  {accent.label}
                                </span>
                                {active ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : null}
                              </button>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <span
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 ${radius.chip} text-[11px] ${priorityAccent[priority].chipBg}`}
                    >
                      <span className={`inline-block w-1.5 h-1.5 ${radius.chip} ${priorityAccent[priority].dot}`} />
                      {priorityAccent[priority].label}
                    </span>
                  )}
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
                  {/* Wave-8 W1 / L4: attached-asset chips. Source of truth
                      is `prismer://workspace/<ws>/asset/<hash>` URIs in the
                      description text — `attachedAssets` is the dedup'd +
                      resolved list. Hidden when no URIs resolve. Clicking
                      a chip opens the asset viewer (same callback the
                      Artifacts section uses). X removes the URI from the
                      description (only when the viewer can edit; otherwise
                      the chip is read-only). */}
                  {attachedAssets.map(({ asset, contentHash }) => (
                    <span
                      key={asset.id}
                      className={`group/asset inline-flex items-center gap-1 px-2.5 py-1 ${radius.chip} text-[11px] transition-colors ${
                        isDark
                          ? 'bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/15'
                          : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                      }`}
                      data-testid={`task-drawer-asset-chip-${asset.id}`}
                    >
                      <button
                        type="button"
                        onClick={() => onOpenAsset?.(asset.id)}
                        disabled={!onOpenAsset}
                        title={asset.filename ?? asset.id}
                        className="inline-flex items-center gap-1 max-w-[200px]"
                      >
                        <Paperclip className="w-3 h-3 shrink-0" />
                        <span className="truncate">{asset.filename ?? `${contentHash.slice(0, 8)}…`}</span>
                      </button>
                      {canEditContent ? (
                        <button
                          type="button"
                          onClick={() => void handleDetachAsset(contentHash)}
                          title="Remove this attachment"
                          aria-label="Remove attachment"
                          data-testid={`task-drawer-asset-chip-remove-${asset.id}`}
                          className={`inline-flex items-center justify-center w-3.5 h-3.5 rounded-full transition-opacity opacity-60 hover:opacity-100 ${
                            isDark ? 'hover:bg-white/10' : 'hover:bg-zinc-200/60'
                          }`}
                        >
                          <X className="w-2.5 h-2.5" />
                        </button>
                      ) : null}
                    </span>
                  ))}
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
                    <AssigneeAvatar
                      task={displayTask}
                      kind={agentKind}
                      assigneeAgent={assigneeAgent}
                      status={displayTask.assigneeId ? (agentStatuses?.get(displayTask.assigneeId) ?? null) : null}
                      isDark={isDark}
                    />
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
              {/* Description — F2 inline editable. Section is rendered when
                  the task has a body OR the viewer can edit (so empty tasks
                  still expose an "Add description" affordance). The edit-mode
                  swap replaces MemoryTextPreview with a textarea + save/cancel
                  buttons; Cmd/Ctrl+Enter saves, Escape cancels, blur is NOT
                  auto-save (long-form input). */}
              {taskBody || canEditContent ? (
                <Section
                  title="Description"
                  isDark={isDark}
                  badge={
                    canEditContent && !descEdit.editing ? (
                      <button
                        type="button"
                        onClick={() =>
                          setDescEdit({
                            editing: true,
                            value: displayTask.description ?? taskBody ?? '',
                            saving: false,
                          })
                        }
                        title={taskBody ? 'Edit description' : 'Add description'}
                        data-testid="task-drawer-description-edit"
                        className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                          isDark
                            ? 'text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200'
                            : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800'
                        }`}
                      >
                        <Pencil className="w-3 h-3" />
                        {taskBody ? 'Edit' : 'Add'}
                      </button>
                    ) : null
                  }
                >
                  {descEdit.editing ? (
                    <div className="space-y-2">
                      {/* Wave-8 W1 / L2: TaskDescriptionEditor adds the
                          `#filename` asset picker to the F2 textarea while
                          keeping the existing Cmd/Ctrl+Enter save + Esc
                          cancel keyboard contract intact. The picker is
                          anchored above the textarea (absolute positioning
                          from AssetPicker), so we don't need to wrap in any
                          additional positioning context. */}
                      <TaskDescriptionEditor
                        isDark={isDark}
                        autoFocus
                        value={descEdit.value}
                        disabled={descEdit.saving}
                        rows={6}
                        workspaceId={displayTask.workspaceId ?? null}
                        onChange={(next) => setDescEdit((prev) => ({ ...prev, value: next }))}
                        onSubmit={() => void handleSaveDescription()}
                        onCancel={handleCancelDescription}
                        placeholder="Add a description… (Cmd/Ctrl+Enter to save, Esc to cancel)"
                        data-testid="task-drawer-description-input"
                        className={`w-full resize-y border ${radius.card} px-4 py-3 text-[13px] leading-relaxed outline-none transition-colors ${surface.inset[theme]} ${
                          isDark
                            ? 'text-zinc-100 placeholder:text-zinc-600 focus:border-violet-400/60'
                            : 'text-zinc-900 placeholder:text-zinc-400 focus:border-violet-500'
                        } disabled:opacity-60`}
                      />
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={handleCancelDescription}
                          disabled={descEdit.saving}
                          data-testid="task-drawer-description-cancel"
                          className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                            isDark ? 'text-zinc-300 hover:bg-white/[0.05]' : 'text-zinc-600 hover:bg-zinc-100'
                          } disabled:opacity-50`}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleSaveDescription()}
                          disabled={descEdit.saving}
                          data-testid="task-drawer-description-save"
                          className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60 transition-colors ${
                            isDark ? 'bg-violet-500 hover:bg-violet-400' : 'bg-violet-600 hover:bg-violet-700'
                          }`}
                        >
                          {descEdit.saving ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                          Save
                        </button>
                      </div>
                    </div>
                  ) : taskBody ? (
                    <div
                      data-testid="task-detail-description"
                      className={`border ${radius.card} px-4 py-3 ${surface.inset[theme]}`}
                    >
                      <MemoryTextPreview content={taskBody} isDark={isDark} />
                    </div>
                  ) : (
                    <div
                      data-testid="task-detail-description-empty"
                      className={`border ${radius.card} px-4 py-3 text-[12px] italic ${surface.inset[theme]} ${
                        isDark ? 'text-zinc-500' : 'text-zinc-500'
                      }`}
                    >
                      No description yet — click Add to write one.
                    </div>
                  )}
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

              {/* release201/10 rev 2 §8.2 — SPEC.md + TODO.md + Acceptance criteria. */}
              <SpecSection
                taskId={displayTask.id}
                isDark={isDark}
                isOwner={displayTask.creatorId === currentUserId}
                notify={notify}
              />
              <TodoSection
                taskId={displayTask.id}
                isDark={isDark}
                isAssignee={displayTask.assigneeId === currentUserId}
                notify={notify}
              />
              <AcceptanceSection
                taskId={displayTask.id}
                workspaceId={displayTask.workspaceId ?? null}
                assets={assets ?? []}
                isDark={isDark}
                notify={notify}
                onChanged={onChanged}
              />

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

              {/* Result viewer. 2026-05-20 — also show in `review` /
                  `failed` states: the assignee has submitted output (review)
                  or the run produced partial output before failing. Previously
                  hidden in `review` → user couldn't see the agent's deliverable
                  until they approved → "task done but output not in detail". */}
              {displayTask.status === 'completed' ||
              displayTask.status === 'review' ||
              displayTask.status === 'failed' ||
              isShellTask(displayTask) ||
              displayTask.error ? (
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
                  <ul className="grid gap-2" data-testid="task-drawer-artifacts">
                    {taskAssets.map((asset) => (
                      <li key={asset.id}>
                        <WorkProductCard
                          asset={asset}
                          isDark={isDark}
                          compact
                          onOpen={onOpenAsset}
                          // release201/09 §9.4a.4 — only viewers with task
                          // edit permission can promote; mirror the
                          // description-edit gate (`canEditContent`).
                          onPromote={canEditContent ? handlePromoteAsset : undefined}
                          showBoundKindChip
                        />
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

function AssigneeAvatar({
  task,
  kind,
  assigneeAgent,
  status,
  isDark,
}: {
  task: TaskDTO;
  kind: AgentKind | null;
  assigneeAgent: AgentDTO | null;
  status: AgentLiveStatus | null;
  isDark: boolean;
}): ReactElement {
  const seed = task.assigneeId ?? task.creatorId ?? task.id;
  const grad = avatarGradient(seed);
  const initials = avatarInitials(task.assigneeName ?? task.assigneeId?.slice(-2) ?? '?');
  const ring = kind ? AGENT_KIND_PRESETS[kind].accentRing : 'ring-zinc-400/20';

  // Agent assignee — promote to AgentAvatar so we get the role icon + status
  // ring + hover popover for free. The legacy AGENT_KIND_PRESETS accent ring
  // is dropped in favor of the live-status ring (working/waiting/stuck) so
  // the drawer's avatar matches the kanban card / contacts row.
  if (assigneeAgent) {
    return <AgentAvatar agent={assigneeAgent} status={status} size="md" isDark={isDark} />;
  }

  return (
    <div
      className={`relative w-10 h-10 rounded-2xl flex items-center justify-center text-xs font-semibold text-white ring-2 ${ring}`}
      style={{
        background: `linear-gradient(135deg, ${grad.from}, ${grad.to})`,
      }}
    >
      {kind === 'long-running' ? (
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

function runEventToTimelineEntry(event: TaskRunEventDTO, ts: number): TimelineEntry {
  const payload = event.payload ?? {};
  const payloadEvent = typeof payload.event === 'string' ? payload.event : null;
  const payloadKind = typeof payload.kind === 'string' ? payload.kind : null;
  const tool =
    typeof payload.tool === 'string'
      ? payload.tool
      : typeof payload.name === 'string'
        ? payload.name
        : payloadKind === 'tool' && payloadEvent
          ? payloadEvent
          : null;
  const summary =
    typeof payload.summary === 'string'
      ? payload.summary
      : typeof payload.preview === 'string'
        ? payload.preview
        : typeof payload.text === 'string'
          ? payload.text
          : null;
  const kind: TimelineEntry['kind'] = (() => {
    if (event.type.includes('completed')) return 'completed';
    if (event.type.includes('failed') || event.level === 'error') return 'failed';
    if (event.type.includes('dispatched') || event.type.includes('assigned')) return 'assigned';
    return 'progress';
  })();
  const label = (() => {
    if (kind === 'assigned') return 'Agent run dispatched';
    if (kind === 'completed') return 'Agent run completed';
    if (kind === 'failed') return 'Agent run failed';
    if (payloadKind === 'reasoning' || payloadEvent === 'reasoning.available') return 'Reasoning';
    if (tool) return `Tool · ${tool}`;
    return humanizeAction(event.type);
  })();

  return {
    key: `run-event-${event.id}`,
    kind,
    label,
    ts,
    message: summary ?? event.message,
    actorId: event.actorId,
    metadata: payload,
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
      {entry.message ? <TimelineMessage content={entry.message} isDark={isDark} /> : null}
      {entry.actorId ? (
        <p className={`mt-1 font-mono text-[10px] ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
          actor {entry.actorId.slice(-10)}
        </p>
      ) : null}
      {entry.metadata ? <TimelineMetadata metadata={entry.metadata} isDark={isDark} /> : null}
    </li>
  );
}

function TimelineMessage({ content, isDark }: { content: string; isDark: boolean }): ReactElement {
  return (
    <div
      className={`mt-1 max-w-full break-words text-[12px] leading-relaxed ${
        isDark ? 'text-zinc-400' : 'text-zinc-600'
      } [&_*]:max-w-full [&_p]:m-0 [&_p+p]:mt-1.5 [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-4 [&_li]:my-0.5 [&_code]:rounded [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[11px] [&_pre]:my-2 [&_pre]:max-h-48 [&_pre]:overflow-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:p-2 [&_pre_code]:bg-transparent [&_pre_code]:p-0 ${
        isDark
          ? '[&_code]:bg-white/[0.06] [&_pre]:border-white/[0.08] [&_pre]:bg-black/20'
          : '[&_code]:bg-zinc-100 [&_pre]:border-zinc-200 [&_pre]:bg-white/70'
      }`}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre({ children }) {
            return <>{children}</>;
          },
          code({ className, children, ...props }: { className?: string; children?: ReactNode }) {
            const language = typeof className === 'string' ? className.replace(/^language-/, '') : '';
            const value = String(children ?? '').replace(/\n$/, '');
            if (language) {
              return <TimelineCodeBlock code={value} language={language} isDark={isDark} />;
            }
            return (
              <code
                className={`rounded px-1 py-0.5 font-mono text-[11px] ${
                  isDark ? 'bg-white/[0.06] text-zinc-200' : 'bg-zinc-100 text-zinc-700'
                }`}
                {...props}
              >
                {children}
              </code>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function TimelineCodeBlock({
  code,
  language,
  isDark,
}: {
  code: string;
  language: string;
  isDark: boolean;
}): ReactElement {
  const height = Math.min(360, Math.max(96, code.split('\n').length * 20 + 24));
  return (
    <div
      className={`my-2 overflow-hidden rounded-lg border ${
        isDark ? 'border-white/[0.08] bg-[#0d1117]' : 'border-zinc-200 bg-white'
      }`}
    >
      <div
        className={`flex items-center justify-between border-b px-3 py-1.5 text-[10px] font-medium ${
          isDark ? 'border-white/[0.08] text-zinc-400' : 'border-zinc-200 text-zinc-500'
        }`}
      >
        <span>{language}</span>
      </div>
      <Editor
        height={height}
        language={language}
        value={code}
        theme={isDark ? 'vs-dark' : 'light'}
        options={{
          readOnly: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          wordWrap: 'on',
          lineNumbers: 'on',
          folding: false,
          glyphMargin: false,
          lineDecorationsWidth: 8,
          lineNumbersMinChars: 3,
          renderLineHighlight: 'none',
          fontSize: 12,
          fontFamily:
            'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
          automaticLayout: true,
          overviewRulerLanes: 0,
          hideCursorInOverviewRuler: true,
          scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
        }}
      />
    </div>
  );
}

function TimelineMetadata({
  metadata,
  isDark,
}: {
  metadata: Record<string, unknown>;
  isDark: boolean;
}): ReactElement | null {
  const details = buildTimelineDetails(metadata);
  if (details.chips.length === 0 && !details.raw) return null;
  return (
    <div className="mt-2 space-y-1.5">
      {details.chips.length ? (
        <div className="flex flex-wrap gap-1.5">
          {details.chips.map((chip) => (
            <span
              key={`${chip.label}:${chip.value}`}
              className={`inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] ${
                isDark
                  ? 'border-white/[0.08] bg-white/[0.04] text-zinc-300'
                  : 'border-zinc-200 bg-white/70 text-zinc-600'
              }`}
            >
              <span className={isDark ? 'text-zinc-500' : 'text-zinc-400'}>{chip.label}</span>
              <span className="truncate font-mono">{chip.value}</span>
            </span>
          ))}
        </div>
      ) : null}
      {details.raw ? (
        <details className={`text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
          <summary className="cursor-pointer select-none">payload</summary>
          <pre
            className={`mt-1 max-h-36 overflow-auto rounded-lg border px-3 py-2 leading-relaxed ${
              isDark ? 'border-white/[0.08] bg-black/20 text-zinc-300' : 'border-zinc-200/80 bg-white/70 text-zinc-700'
            }`}
          >
            {details.raw}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

function buildTimelineDetails(metadata: Record<string, unknown>): {
  chips: Array<{ label: string; value: string }>;
  raw: string | null;
} {
  const chips: Array<{ label: string; value: string }> = [];
  const push = (label: string, value: unknown) => {
    if (value === undefined || value === null || value === '') return;
    const text =
      typeof value === 'string'
        ? value
        : typeof value === 'number' || typeof value === 'boolean'
          ? String(value)
          : null;
    if (text) chips.push({ label, value: text.length > 96 ? `${text.slice(0, 96)}...` : text });
  };
  push('kind', metadata.kind);
  push('event', metadata.event);
  push('tool', metadata.tool);
  push('progress', typeof metadata.progress === 'number' ? `${Math.round(metadata.progress * 100)}%` : undefined);
  push('duration', typeof metadata.duration === 'number' ? `${metadata.duration}s` : undefined);
  push('error', metadata.error);
  if (Array.isArray(metadata.assetIds) && metadata.assetIds.length) {
    push('assets', metadata.assetIds.join(', '));
  }

  const rawSource: Record<string, unknown> = {};
  for (const key of ['arguments', 'result']) {
    if (metadata[key] !== undefined) rawSource[key] = metadata[key];
  }
  const text = Object.keys(rawSource).length ? safeStringify(rawSource) : null;
  if (!text || text === '{}') return { chips, raw: null };
  return { chips, raw: text.length > 1200 ? `${text.slice(0, 1200)}\n...` : text };
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
      execution &&
      typeof execution === 'object' &&
      !Array.isArray(execution) &&
      (execution as Record<string, unknown>).kind === 'shell',
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
            const RoleIcon = getAgentRoleIcon(agent.agentType ?? null);
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
                  <RoleIcon className="w-3.5 h-3.5 shrink-0 opacity-80" />
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

// ═════════════════════════════════════════════════════════════════════
// release201/10 rev 2 §8.2 — AcceptanceSection + SpecSection + TodoSection
// ═════════════════════════════════════════════════════════════════════

interface AcceptanceCriterionView {
  id: string;
  verifyMode: 'qualitative' | 'quantitative' | 'agent-self-check' | 'manual';
  expectation: string;
  verifierAgentId: string | null;
  status: 'pending' | 'passed' | 'failed' | 'n/a' | 'waived';
  required?: boolean;
  verifiedAt?: string | null;
  verifiedBy?: string | null;
  verifyOutcomeNote?: string | null;
  evidenceRefs?: Array<string | { ref: string; crossTaskConfirmed?: boolean; note?: string }>;
}

interface AcceptanceView {
  overall: 'none' | 'pending' | 'partial' | 'passed' | 'failed';
  criteria: AcceptanceCriterionView[];
  completedCount: number;
  totalCount: number;
  passRate: number;
}

interface AcceptanceSectionProps {
  taskId: string;
  workspaceId: string | null;
  assets: AssetDTO[];
  isDark: boolean;
  notify?: (message: string, type: 'success' | 'error' | 'info') => void;
  onChanged?: () => void;
}

function AcceptanceSection({
  taskId,
  workspaceId: _ws,
  assets: _a,
  isDark,
  notify,
  onChanged,
}: AcceptanceSectionProps): ReactElement {
  const [view, setView] = useState<AcceptanceView | null>(null);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addDraft, setAddDraft] = useState<CriterionDraft[]>([]);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await imFetch<AcceptanceView>(`/tasks/${encodeURIComponent(taskId)}/acceptance`);
      if (res.ok) setView(res.data ?? null);
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function verify(cid: string, outcome: 'passed' | 'failed' | 'n/a') {
    try {
      const res = await imFetch(`/tasks/${encodeURIComponent(taskId)}/criteria/${encodeURIComponent(cid)}/verify`, {
        method: 'POST',
        body: JSON.stringify({ outcome }),
      });
      if (!res.ok) {
        notify?.(`Verify failed: ${res.message ?? 'error'}`, 'error');
        return;
      }
      void reload();
      onChanged?.();
    } catch (err) {
      notify?.(`Verify failed: ${(err as Error).message}`, 'error');
    }
  }

  async function commitAdded() {
    if (addDraft.length === 0) {
      setAdding(false);
      return;
    }
    for (const c of addDraft) {
      if (!c.expectation.trim()) continue;
      try {
        await imFetch(`/tasks/${encodeURIComponent(taskId)}/criteria`, {
          method: 'POST',
          body: JSON.stringify({
            verifyMode: c.verifyMode,
            expectation: c.expectation,
            verifierAgentId: c.verifierAgentId ?? null,
            required: c.required !== false,
            weight: c.weight ?? 1,
          }),
        });
      } catch (err) {
        notify?.(`Add criterion failed: ${(err as Error).message}`, 'error');
      }
    }
    setAddDraft([]);
    setAdding(false);
    void reload();
    onChanged?.();
  }

  async function removeCriterion(cid: string) {
    if (!confirm('Remove this criterion?')) return;
    try {
      await imFetch(`/tasks/${encodeURIComponent(taskId)}/criteria/${encodeURIComponent(cid)}`, {
        method: 'DELETE',
      });
      void reload();
    } catch (err) {
      notify?.(`Remove failed: ${(err as Error).message}`, 'error');
    }
  }

  const overallChip = view?.overall ?? 'none';
  const overallStyle =
    overallChip === 'passed'
      ? isDark
        ? 'bg-emerald-500/15 text-emerald-200'
        : 'bg-emerald-50 text-emerald-700'
      : overallChip === 'failed'
        ? isDark
          ? 'bg-rose-500/15 text-rose-200'
          : 'bg-rose-50 text-rose-700'
        : overallChip === 'partial'
          ? isDark
            ? 'bg-amber-500/15 text-amber-200'
            : 'bg-amber-50 text-amber-700'
          : isDark
            ? 'bg-white/5 text-zinc-300'
            : 'bg-zinc-100 text-zinc-600';

  return (
    <Section
      title="Acceptance"
      isDark={isDark}
      badge={
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${overallStyle}`}>
          {overallChip}
          {view ? ` ${view.completedCount}/${view.totalCount}` : ''}
        </span>
      }
    >
      <div
        className={`rounded-2xl border px-3 py-2 ${isDark ? 'border-white/10 bg-white/[0.02]' : 'border-zinc-200 bg-white'}`}
      >
        {loading && !view ? (
          <p className={`flex items-center gap-2 text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
            <Loader2 className="h-3 w-3 animate-spin" /> Loading acceptance…
          </p>
        ) : !view || view.criteria.length === 0 ? (
          <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
            No acceptance criteria. The task can still be reviewed/completed (Soft gate).
          </p>
        ) : (
          <ul className="space-y-1.5">
            {view.criteria.map((c) => {
              const icon =
                c.status === 'passed'
                  ? '✓'
                  : c.status === 'failed'
                    ? '✗'
                    : c.status === 'n/a' || c.status === 'waived'
                      ? '·'
                      : '◯';
              const colour =
                c.status === 'passed'
                  ? isDark
                    ? 'text-emerald-300'
                    : 'text-emerald-700'
                  : c.status === 'failed'
                    ? isDark
                      ? 'text-rose-300'
                      : 'text-rose-700'
                    : isDark
                      ? 'text-zinc-400'
                      : 'text-zinc-500';
              return (
                <li key={c.id} className="flex items-start gap-2 text-xs">
                  <span className={`mt-0.5 ${colour}`} aria-hidden>
                    {icon}
                  </span>
                  <div className="flex-1">
                    <div className={`${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
                      {c.expectation}
                      <span
                        className={`ml-2 inline-flex rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${
                          isDark ? 'bg-white/10 text-zinc-400' : 'bg-zinc-100 text-zinc-600'
                        }`}
                      >
                        {c.verifyMode}
                      </span>
                      {c.verifierAgentId ? (
                        <span className={`ml-1 text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                          → @{c.verifierAgentId}
                        </span>
                      ) : null}
                      {c.required === false ? (
                        <span className={`ml-1 text-[10px] italic ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                          optional
                        </span>
                      ) : null}
                    </div>
                    {c.verifyOutcomeNote ? (
                      <div className={`mt-0.5 text-[10px] ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>
                        {c.verifyOutcomeNote}
                        {c.verifiedBy ? ` — by ${c.verifiedBy}` : ''}
                        {c.verifiedAt ? ` · ${formatRelative(new Date(c.verifiedAt).getTime())}` : ''}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button
                      className={`rounded px-1.5 py-0.5 text-[10px] ${
                        isDark
                          ? 'bg-emerald-500/20 text-emerald-200 hover:bg-emerald-500/30'
                          : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                      }`}
                      onClick={() => void verify(c.id, 'passed')}
                      title="Mark passed"
                      data-testid={`acceptance-pass-${c.id}`}
                    >
                      Pass
                    </button>
                    <button
                      className={`rounded px-1.5 py-0.5 text-[10px] ${
                        isDark
                          ? 'bg-rose-500/20 text-rose-200 hover:bg-rose-500/30'
                          : 'bg-rose-50 text-rose-700 hover:bg-rose-100'
                      }`}
                      onClick={() => void verify(c.id, 'failed')}
                      title="Mark failed"
                    >
                      Fail
                    </button>
                    <button
                      className={`rounded px-1.5 py-0.5 text-[10px] ${
                        isDark
                          ? 'bg-white/10 text-zinc-300 hover:bg-white/20'
                          : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'
                      }`}
                      onClick={() => void removeCriterion(c.id)}
                      title="Remove criterion"
                    >
                      ✕
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setAdding((s) => !s)}
            className={`rounded-md border px-2.5 py-1 text-xs ${
              isDark
                ? 'border-white/10 bg-white/[0.03] text-zinc-200 hover:bg-white/[0.06]'
                : 'border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50'
            }`}
            data-testid="acceptance-toggle-add"
          >
            {adding ? 'Cancel add' : '+ Add criterion'}
          </button>
        </div>
        {adding ? (
          <div className="mt-2 space-y-2">
            <TaskCriteriaEditor isDark={isDark} value={addDraft} onChange={setAddDraft} />
            <button
              type="button"
              onClick={() => void commitAdded()}
              className={`rounded-md px-3 py-1 text-xs font-semibold ${
                isDark
                  ? 'bg-violet-500/30 text-violet-100 hover:bg-violet-500/40'
                  : 'bg-violet-100 text-violet-800 hover:bg-violet-200'
              }`}
              data-testid="acceptance-commit-add"
            >
              Save
            </button>
          </div>
        ) : null}
      </div>
    </Section>
  );
}

// ═════════════════════════════════════════════════════════════════════
// release201/10 rev 2 §8.2 — SpecSection (SPEC.md viewer + owner editor)
// ═════════════════════════════════════════════════════════════════════

interface SpecSectionProps {
  taskId: string;
  isDark: boolean;
  isOwner?: boolean;
  notify?: (message: string, type: 'success' | 'error' | 'info') => void;
}

function SpecSection({ taskId, isDark, isOwner, notify }: SpecSectionProps): ReactElement {
  const [markdown, setMarkdown] = useState<string>('');
  const [revision, setRevision] = useState<number>(0);
  const [editing, setEditing] = useState<boolean>(false);
  const [draft, setDraft] = useState<string>('');
  const [saving, setSaving] = useState<boolean>(false);

  const SPEC_TEMPLATE = '## Goal\n\n\n## Background\n\n\n## Constraints\n\n\n## Out of scope\n\n';

  const load = useCallback(async () => {
    try {
      const res = await imFetch<{ markdown: string; revision: number }>(`/tasks/${encodeURIComponent(taskId)}/spec`);
      if (res.ok && res.data) {
        setMarkdown(res.data.markdown ?? '');
        setRevision(res.data.revision ?? 0);
      }
    } catch (err) {
      notify?.(`Load SPEC failed: ${(err as Error).message}`, 'error');
    }
  }, [taskId, notify]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setSaving(true);
    try {
      const res = await imFetch(`/tasks/${encodeURIComponent(taskId)}/spec`, {
        method: 'PUT',
        body: JSON.stringify({ markdown: draft }),
      });
      if (!res.ok) {
        notify?.(`Save SPEC failed: ${res.message ?? 'error'}`, 'error');
        return;
      }
      setEditing(false);
      void load();
    } catch (err) {
      notify?.(`Save SPEC failed: ${(err as Error).message}`, 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section
      title="SPEC.md"
      isDark={isDark}
      badge={
        revision > 0 ? (
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
              isDark ? 'bg-white/5 text-zinc-300' : 'bg-zinc-100 text-zinc-600'
            }`}
          >
            rev {revision}
          </span>
        ) : null
      }
    >
      <div
        className={`rounded-2xl border px-3 py-2 ${isDark ? 'border-white/10 bg-white/[0.02]' : 'border-zinc-200 bg-white'}`}
      >
        {editing ? (
          <div className="space-y-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              data-testid="spec-editor-textarea"
              className={`w-full min-h-[260px] resize-y rounded-md border px-2 py-1.5 font-mono text-xs ${
                isDark ? 'bg-zinc-900 border-white/10 text-zinc-100' : 'bg-white border-zinc-300 text-zinc-900'
              }`}
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving}
                data-testid="spec-save"
                className={`rounded-md px-3 py-1 text-xs font-semibold ${
                  isDark
                    ? 'bg-violet-500/30 text-violet-100 hover:bg-violet-500/40'
                    : 'bg-violet-100 text-violet-800 hover:bg-violet-200'
                } disabled:opacity-60`}
              >
                {saving ? 'Saving…' : 'Save SPEC'}
              </button>
              <button
                type="button"
                onClick={() => setEditing(false)}
                className={`rounded-md border px-2.5 py-1 text-xs ${
                  isDark ? 'border-white/10 text-zinc-300' : 'border-zinc-200 text-zinc-700'
                }`}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : markdown.trim() ? (
          <pre className={`whitespace-pre-wrap font-mono text-xs ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
            {markdown}
          </pre>
        ) : (
          <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
            No SPEC.md yet.{' '}
            {isOwner ? 'Author one to anchor what done looks like.' : 'Owner has not written a SPEC yet.'}
          </p>
        )}
        {!editing && isOwner ? (
          <div className="mt-2">
            <button
              type="button"
              data-testid="spec-edit"
              onClick={() => {
                setDraft(markdown || SPEC_TEMPLATE);
                setEditing(true);
              }}
              className={`rounded-md border px-2.5 py-1 text-xs ${
                isDark
                  ? 'border-white/10 bg-white/[0.03] text-zinc-200 hover:bg-white/[0.06]'
                  : 'border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50'
              }`}
            >
              {markdown.trim() ? 'Edit SPEC' : 'Write SPEC'}
            </button>
          </div>
        ) : null}
      </div>
    </Section>
  );
}

// ═════════════════════════════════════════════════════════════════════
// release201/10 rev 2 §8.2 — TodoSection (TODO.md interactive checklist)
// ═════════════════════════════════════════════════════════════════════

interface TodoSectionProps {
  taskId: string;
  isDark: boolean;
  isAssignee?: boolean;
  notify?: (message: string, type: 'success' | 'error' | 'info') => void;
}

interface TodoItemView {
  index: number;
  depth: number;
  status: 'pending' | 'done';
  text: string;
}

interface TodoView {
  markdown: string;
  items: TodoItemView[];
  doneCount: number;
  totalCount: number;
  progressPct: number;
  revision: number;
}

function TodoSection({ taskId, isDark, isAssignee, notify }: TodoSectionProps): ReactElement {
  const [view, setView] = useState<TodoView | null>(null);
  const [draftText, setDraftText] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);

  const load = useCallback(async () => {
    try {
      const res = await imFetch<TodoView>(`/tasks/${encodeURIComponent(taskId)}/todo`);
      if (res.ok && res.data) setView(res.data);
    } catch (err) {
      notify?.(`Load TODO failed: ${(err as Error).message}`, 'error');
    }
  }, [taskId, notify]);

  useEffect(() => {
    void load();
  }, [load]);

  async function add() {
    if (!draftText.trim()) return;
    setBusy(true);
    try {
      const res = await imFetch(`/tasks/${encodeURIComponent(taskId)}/todo/items`, {
        method: 'POST',
        body: JSON.stringify({ text: draftText }),
      });
      if (!res.ok) {
        notify?.(`Add TODO failed: ${res.message ?? 'error'}`, 'error');
        return;
      }
      setDraftText('');
      void load();
    } finally {
      setBusy(false);
    }
  }

  async function toggle(idx: number, done: boolean) {
    setBusy(true);
    try {
      const res = await imFetch(`/tasks/${encodeURIComponent(taskId)}/todo/items/${idx}`, {
        method: 'PATCH',
        body: JSON.stringify({ done }),
      });
      if (!res.ok) {
        notify?.(`Toggle TODO failed: ${res.message ?? 'error'}`, 'error');
        return;
      }
      void load();
    } finally {
      setBusy(false);
    }
  }

  async function remove(idx: number) {
    setBusy(true);
    try {
      const res = await imFetch(`/tasks/${encodeURIComponent(taskId)}/todo/items/${idx}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        notify?.(`Remove TODO failed: ${res.message ?? 'error'}`, 'error');
        return;
      }
      void load();
    } finally {
      setBusy(false);
    }
  }

  const progressPct = view ? Math.round(view.progressPct * 100) : 0;
  const progressColour =
    progressPct >= 80
      ? isDark
        ? 'bg-emerald-500/15 text-emerald-200'
        : 'bg-emerald-50 text-emerald-700'
      : progressPct >= 50
        ? isDark
          ? 'bg-amber-500/15 text-amber-200'
          : 'bg-amber-50 text-amber-700'
        : isDark
          ? 'bg-rose-500/15 text-rose-200'
          : 'bg-rose-50 text-rose-700';

  return (
    <Section
      title="TODO.md"
      isDark={isDark}
      badge={
        view && view.totalCount > 0 ? (
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${progressColour}`}>
            {view.doneCount}/{view.totalCount} · {progressPct}%
          </span>
        ) : null
      }
    >
      <div
        className={`rounded-2xl border px-3 py-2 ${isDark ? 'border-white/10 bg-white/[0.02]' : 'border-zinc-200 bg-white'}`}
      >
        {!view || view.items.length === 0 ? (
          <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
            No TODO items yet.{' '}
            {isAssignee ? 'Decompose the SPEC into 3–15 steps.' : 'Assignee has not authored a plan yet.'}
          </p>
        ) : (
          <ul className="space-y-1">
            {view.items.map((it) => (
              <li
                key={it.index}
                className="flex items-start gap-2 text-xs"
                style={{ marginLeft: `${it.depth * 12}px` }}
              >
                <input
                  type="checkbox"
                  checked={it.status === 'done'}
                  onChange={(e) => void toggle(it.index, e.target.checked)}
                  disabled={busy || !isAssignee}
                  data-testid={`todo-toggle-${it.index}`}
                  className="mt-0.5"
                />
                <span
                  className={`flex-1 ${
                    it.status === 'done'
                      ? `line-through ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`
                      : isDark
                        ? 'text-zinc-100'
                        : 'text-zinc-900'
                  }`}
                >
                  {it.text}
                </span>
                {isAssignee ? (
                  <button
                    type="button"
                    onClick={() => void remove(it.index)}
                    className="text-rose-500 hover:text-rose-600"
                    title="Remove item"
                    data-testid={`todo-remove-${it.index}`}
                  >
                    ✕
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {isAssignee ? (
          <div className="mt-2 flex items-center gap-2">
            <input
              type="text"
              value={draftText}
              onChange={(e) => setDraftText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void add();
              }}
              placeholder="Add a new TODO item…"
              data-testid="todo-add-input"
              className={`flex-1 rounded-md border px-2 py-1 text-xs outline-none focus:ring-1 ${
                isDark
                  ? 'bg-zinc-900 border-white/10 text-zinc-100 focus:ring-violet-500/40'
                  : 'bg-white border-zinc-300 text-zinc-900 focus:ring-violet-400'
              }`}
            />
            <button
              type="button"
              onClick={() => void add()}
              disabled={busy || !draftText.trim()}
              data-testid="todo-add"
              className={`rounded-md px-3 py-1 text-xs font-semibold ${
                isDark
                  ? 'bg-violet-500/30 text-violet-100 hover:bg-violet-500/40'
                  : 'bg-violet-100 text-violet-800 hover:bg-violet-200'
              } disabled:opacity-60`}
            >
              Add
            </button>
          </div>
        ) : null}
      </div>
    </Section>
  );
}
