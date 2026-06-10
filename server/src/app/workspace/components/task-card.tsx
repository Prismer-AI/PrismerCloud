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

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
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
  Pencil,
} from 'lucide-react';
import type { AgentDTO, AssetDTO, TaskDTO } from '../lib/types';
import { imFetch } from '../lib/im-api';
import { isCancellableStatus, pauseTask, reopenTask, startTask, transitionTask, updateTask } from '../lib/mutations';
import { TaskCardActions } from './task-card-actions';
import { AGENT_KIND_PRESETS, type AgentKind } from '../lib/agent-kind';
import { getAgentRoleIcon } from '../lib/agent-role-icon';
import type { AgentLiveStatus } from '../lib/agent-status';
import { AgentAvatar } from './agent-avatar';
import { useI18n } from '@/contexts/i18n-context';
import { surface, radius, springSoft, priorityAccent, avatarGradient, avatarInitials } from '../lib/design';
import { WorkProductCard } from './work-products';
import { TaskDescriptionEditor } from './task-description-editor';
import { buildAssetRefsFromDescription } from '../lib/task-asset-refs';

// ─── Public props ─────────────────────────────────────────────────

export interface TaskCardProps {
  isDark: boolean;
  task: TaskDTO;
  /** Lookup map { imUserId → AgentKind }; lets the card show CLI vs long-running glyph. */
  agentKindByImUserId?: Record<string, AgentKind>;
  /**
   * Lookup map { imUserId → role slug (`agentType`) }. Drives the
   * role-specific avatar icon (Crown for CEO, Wrench for Engineer, etc.);
   * falls back to `Bot` when the role is missing or unrecognised.
   */
  agentTypeByImUserId?: Record<string, string>;
  /** Task 3 — workspace-wide agent live status map (from page.tsx). */
  agentStatuses?: Map<string, AgentLiveStatus>;
  /** Workspace agents — drives the W2-T1 reassign popover. Optional; if omitted, the menu hides. */
  agents?: AgentDTO[];
  /** Assets produced by this task — drives the W2-T2 artifact badge. Already filtered by sourceTaskId. */
  taskAssets?: AssetDTO[];
  /**
   * Full workspace asset list — needed by the L3 CardEditPopover so the
   * `#filename` picker can cross-reference newly-selected items into the
   * `assetRefs[]` payload at save time. Optional; if omitted, the picker
   * still works (picker fetches its own list) but the save path falls back
   * to in-text URIs only (daemon's uriResolver still handles those).
   */
  workspaceAssets?: AssetDTO[];
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
  onUnblock: () => void;
  onRestore: () => void;
  dragHandleProps?: Record<string, unknown>;
  isOverlay: boolean;
  isDraggingActive: boolean;
}

function CardBody({
  isDark,
  task,
  agents,
  agentKindByImUserId,
  agentTypeByImUserId,
  agentStatuses,
  taskAssets,
  workspaceAssets,
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
  onUnblock,
  onRestore,
  dragHandleProps,
  isOverlay,
  isDraggingActive,
}: CardBodyProps) {
  const theme: 'dark' | 'light' = isDark ? 'dark' : 'light';
  const { t } = useI18n();
  const idBadge = `T-${task.id.slice(-4).toUpperCase()}`;
  const priority = readTaskCardPriority(task);
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

  // 2026-05-20 — anchors for portal-positioned popovers. Each trigger
  // button (⋮ menu / title-edit hit-area / paperclip artifact pill) gets
  // its own ref so the corresponding popover (now portaled to document
  // .body to escape the framer-motion transform stacking context) can
  // re-position relative to viewport coordinates as the page scrolls.
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const artifactTriggerRef = useRef<HTMLButtonElement>(null);

  // Outside-click dismiss for menuOpen / pickerOpen / artifactOpen. The
  // existing `fixed inset-0` backdrops INSIDE each popover catch clicks
  // landing on the card itself, but `motion.article` has a transform
  // applied by framer-motion, which makes `fixed` resolve against the
  // card — not the viewport. So clicks outside the card never reach the
  // backdrop. A document-level pointerdown listener catches those.
  const cardRef = useRef<HTMLElement | null>(null);
  const anyPopoverOpen = menuOpen || pickerOpen || artifactOpen;
  useEffect(() => {
    if (!anyPopoverOpen) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (cardRef.current?.contains(target)) return; // in-card → existing backdrops handle it
      setMenuOpen(false);
      setPickerOpen(false);
      setArtifactOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setMenuOpen(false);
      setPickerOpen(false);
      setArtifactOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [anyPopoverOpen]);

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

  // Role-specific avatar icon (Crown / Wrench / Megaphone / …). Falls back
  // to Bot when the role slug is unknown or this isn't an agent at all.
  // The slug arrives via `agentTypeByImUserId` (passed down from the
  // workspace task board); when absent we degrade gracefully.
  const roleSlug = assigneeIsAgent && task.assigneeId ? (agentTypeByImUserId?.[task.assigneeId] ?? null) : null;
  const RoleIcon = getAgentRoleIcon(roleSlug);

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
    // Wave-8 W1 / L3: extract any `prismer://...asset/<hash>` URIs the user
    // inserted via the `#filename` picker and ship them as structured refs
    // so the daemon's dispatch hydrator picks up the bytes. Falls back to
    // in-text URIs only when the workspace asset list isn't threaded
    // through (still works — daemon's uriResolver handles in-text URIs).
    const wireDescription = nextDescription || null;
    // PATCH path — always send `assetRefs` (even empty) so the server can
    // clear `linkedAssetIds` when the user removed every attachment URI
    // from the description.
    const refs = task.workspaceId
      ? buildAssetRefsFromDescription(wireDescription, workspaceAssets, task.workspaceId)
      : [];
    const res = await updateTask(task.id, {
      title: nextTitle,
      description: wireDescription,
      assetRefs: refs,
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
    // v2.0 P5 — Unassign goes through the state machine so the server can
    // enforce the {assigned,blocked,review} → pending matrix and clear the
    // assignee atomically. Reassign (non-null) stays on PATCH for now;
    // the dedicated reassign endpoint will land alongside P6.
    const res =
      assigneeId === null
        ? await transitionTask(task.id, {
            to: 'pending',
            assigneeId: null,
            reason: 'Unassigned via task card',
          })
        : await updateTask(task.id, { assigneeId });
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
      ref={cardRef}
      data-testid={`task-card-${task.id}`}
      data-task-id={task.id}
      data-task-priority={priority}
      onClick={handleClick}
      // Spring-physics expansion: `maxHeight` is animated by framer-motion
      // (not CSS) so hover-in / hover-out has real damping. springSoft is
      // the same preset used elsewhere in the workspace for card-scale
      // transitions — settles in ~250ms with a barely-visible overshoot.
      //
      // 2026-05-29 (Bug 6) — promoted the prior hover height (7.5 lines)
      // to the idle/default. Hover now expands to 10 description lines
      // (text-xs leading-relaxed → ~19.5px per line, ~195px). Idle 304 =
      // chrome (~153) + 7.5 lines; hover 348 = chrome + 10 lines. Cards
      // with shorter descriptions naturally shrink — the flex column +
      // overflow-hidden wrapper means height is bounded, not forced.
      initial={false}
      animate={isOverlay ? undefined : { maxHeight: 304 }}
      whileHover={isOverlay ? undefined : { y: -2, maxHeight: 348 }}
      transition={springSoft}
      className={[
        // Card sizing: idle = 304px (7.5 description lines + chrome) —
        // this is the prior hover height promoted to default per Bug 6.
        // Hover expansion to 348px (10 lines) is driven by framer above.
        // The NAMED group `group/card` scopes the fade-out toggle to this
        // single card — the kanban column also uses an unnamed `group`
        // for its own styling, and an unnamed `group-hover:` would
        // resolve to the column and expand every card whenever ANY card
        // was hovered. `hover:z-10` lifts the expanded card above its
        // neighbors. `flex flex-col` + `mt-auto` on footer pins the
        // avatar/time row.
        'group/card relative cursor-pointer border text-sm select-none',
        'min-h-[304px] flex flex-col overflow-hidden',
        'hover:z-10',
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
              ref={moreButtonRef}
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
                anchorRef={moreButtonRef}
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
                anchorRef={moreButtonRef}
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

      {/* Description preview.
       *
       * NO `line-clamp` — that was a CSS-only snap-toggle that broke the
       * spring illusion (the height animates with springSoft physics, but
       * line-clamp's line-count change is instant). Instead the wrapper
       * uses `overflow-hidden min-h-0` and the flex algorithm naturally
       * shrinks it to whatever space the card max-height permits. When the
       * card max-height springs from 200 → 420 on hover, the wrapper
       * shrink-back releases more text continuously — every visible
       * change is driven by the same spring.
       *
       * The fade gradient still pins to the wrapper bottom so the clipped
       * edge feels soft; it fades out on hover where there's nothing left
       * to truncate.
       */}
      {taskBody ? (
        <div className="relative mt-1.5 min-h-0 overflow-hidden">
          <p className={`text-xs leading-relaxed ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>{taskBody}</p>
          <div
            aria-hidden
            className={`pointer-events-none absolute inset-x-0 bottom-0 h-5 opacity-100 transition-opacity duration-150 group-hover/card:opacity-0 ${
              isDark
                ? 'bg-gradient-to-t from-zinc-900 via-zinc-900/60 to-transparent'
                : 'bg-gradient-to-t from-white via-white/70 to-transparent'
            }`}
          />
        </div>
      ) : null}

      {/* Status message —
       *  - BLOCKED: surface as a high-contrast banner so the blocker reason
       *    reads at a glance (P6 §7.1: "看 agent 卡哪儿了").
       *  - other states: low-key italic line. */}
      {task.statusMessage ? (
        task.status === 'blocked' ? (
          <div
            className={`mt-2 shrink-0 rounded-lg border px-2 py-1.5 text-[11px] ${
              isDark
                ? 'border-orange-400/30 bg-orange-500/10 text-orange-100'
                : 'border-orange-300/70 bg-orange-50 text-orange-800'
            }`}
            data-testid={`task-card-blocked-reason-${task.id}`}
            title={task.statusMessage}
          >
            <span className="block font-semibold text-[10px] uppercase tracking-wide opacity-80">卡点原因</span>
            <span className="block line-clamp-2 leading-snug">{task.statusMessage}</span>
          </div>
        ) : (
          <p className={`mt-1.5 text-[11px] italic line-clamp-1 ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
            {task.statusMessage}
          </p>
        )
      ) : null}

      {/* P6 — REVIEW + DONE summary preview. Show a clipped first-pass of the
       *  task's result so the reviewer / observer can size up the deliverable
       *  without opening the drawer. The drawer still hosts the full output
       *  (click anywhere on the card to open). */}
      {(task.status === 'review' || task.status === 'completed') && readTaskResultPreview(task) ? (
        <div
          className={`mt-2 shrink-0 rounded-lg border px-2 py-1.5 text-[11px] ${
            isDark
              ? task.status === 'review'
                ? 'border-violet-400/25 bg-violet-500/10 text-violet-100'
                : 'border-emerald-400/25 bg-emerald-500/10 text-emerald-100'
              : task.status === 'review'
                ? 'border-violet-300/70 bg-violet-50 text-violet-900'
                : 'border-emerald-300/70 bg-emerald-50 text-emerald-900'
          }`}
          data-testid={`task-card-result-preview-${task.id}`}
        >
          <span className="block text-[10px] font-semibold uppercase tracking-wide opacity-80">
            {task.status === 'review' ? '提交摘要' : '完成结果'}
          </span>
          <span className="block line-clamp-2 leading-snug">{readTaskResultPreview(task)}</span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              onOpen?.();
            }}
            className={`mt-0.5 text-[10px] underline-offset-2 hover:underline ${
              isDark ? 'opacity-80 hover:opacity-100' : 'opacity-80 hover:opacity-100'
            }`}
          >
            查看完整结果 →
          </button>
        </div>
      ) : null}

      {editorOpen ? (
        <CardEditPopover
          isDark={isDark}
          // Editor opens from the ⋮ menu's "Edit" item; anchor to the
          // same trigger so the dialog appears next to the menu's prior
          // position.
          anchorRef={moreButtonRef}
          title={editTitle}
          description={editDescription}
          saving={savingEdit}
          workspaceId={task.workspaceId ?? null}
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

      {/* Footer: avatar + name | priority + kind chips | relative time.
          The chip cluster used to occupy its own row above this — moving
          it into the footer reclaims vertical space for the description
          and keeps the visual baseline tight. `mt-auto` pushes the whole
          row to the bottom; assignee shrinks first when chips fight for
          width. */}
      <footer className="mt-auto pt-3 flex shrink-0 items-center gap-2">
        {assigneeName ? (
          <div className="flex min-w-0 items-center gap-1.5">
            {assigneeIsAgent && task.assigneeId ? (
              <AgentAvatar
                agent={{
                  agentId: task.assigneeId,
                  userId: task.assigneeId,
                  name: assigneeName,
                  agentType: roleSlug,
                }}
                status={agentStatuses?.get(task.assigneeId) ?? null}
                size="xs"
                isDark={isDark}
              />
            ) : (
              <span
                className={`relative shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-full text-[9px] font-bold text-white shadow-sm ${
                  kindPreset ? `ring-2 ${kindPreset.accentRing}` : ''
                }`}
                style={{
                  background: `linear-gradient(135deg, ${avatar.from}, ${avatar.to})`,
                }}
                title={assigneeName}
              >
                {initials}
              </span>
            )}
            <span className={`text-[11px] truncate ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>{assigneeName}</span>
          </div>
        ) : (
          <div
            className={`flex min-w-0 items-center gap-1.5 text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
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

        {/* Chip cluster — priority + kind always render; conversation /
            artifact / capability / budget are conditional. The whole
            block is `shrink-0 overflow-hidden` so the assignee name
            truncates first when the column is narrow. */}
        <div className="ml-1 flex shrink min-w-0 items-center gap-1 overflow-hidden flex-nowrap">
          <span
            className={`shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium border ${priorityCfg.chipBg} ${
              isDark ? 'border-white/10' : 'border-zinc-200/70'
            }`}
            title={`Priority: ${priorityCfg.label}`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${priorityCfg.dot}`} />
            {priorityCfg.label}
          </span>

          {kindPreset ? (
            <span
              className={`shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium border ${kindPreset.chipBg}`}
              title={kindPreset.description}
            >
              {kind === 'long-running' ? <Brain className="w-3 h-3" /> : <Terminal className="w-3 h-3" />}
              {kindPreset.shortLabel}
            </span>
          ) : null}

          {task.conversationId ? (
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
              className={`shrink-0 inline-flex items-center justify-center w-5 h-5 rounded-full transition-colors ${
                isDark
                  ? 'bg-white/[0.04] text-zinc-400 hover:bg-cyan-500/15 hover:text-cyan-200'
                  : 'bg-zinc-100 text-zinc-500 hover:bg-cyan-50 hover:text-cyan-700'
              } disabled:cursor-default disabled:hover:bg-inherit disabled:hover:text-inherit`}
            >
              <MessageSquare className="w-3 h-3" />
            </button>
          ) : null}

          {artifactCount > 0 ? (
            <div className="relative shrink-0">
              <button
                ref={artifactTriggerRef}
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
                  anchorRef={artifactTriggerRef}
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
              className={`shrink-0 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] ${
                isDark ? 'bg-white/[0.04] text-zinc-400' : 'bg-zinc-100 text-zinc-500'
              }`}
              title="Capability"
            >
              {task.capability}
            </span>
          ) : null}

          {typeof task.budget === 'number' && task.budget > 0 ? (
            <span
              className={`shrink-0 inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] ${
                isDark ? 'bg-amber-500/10 text-amber-200' : 'bg-amber-50 text-amber-700'
              }`}
              title="Budget"
            >
              <Coins className="w-3 h-3" /> {task.budget}
            </span>
          ) : null}
        </div>

        <span
          className={`ml-auto shrink-0 inline-flex items-center gap-1 text-[10px] ${
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
      {/* release201/10 rev 2 §8.4 — mini TODO + acceptance progress.
          TODO bar fetches lazily for status=running/review tasks (where
          the orchestrator most needs the signal). */}
      {!isOverlay && (task.status === 'running' || task.status === 'review') ? (
        <div className="mt-1.5 shrink-0">
          <TodoMiniBar taskId={task.id} isDark={isDark} />
        </div>
      ) : null}
      {!isOverlay && task.acceptanceTotalCount && task.acceptanceTotalCount > 0 ? (
        <div className="mt-1.5 shrink-0">
          <AcceptanceMiniBar task={task} isDark={isDark} />
        </div>
      ) : null}

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
            onUnblock={onUnblock}
            onRestore={onRestore}
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
            onViewOutput={() => {
              // 2026-05-24 — "查看产物" 之前接到 onOpen(打开 detail drawer)
              // 跟按钮文案完全不符。改成:单产物直接预览;多产物打开
              // 卡片自带的 CardArtifactPopover 让用户选;无产物兜底打开
              // detail drawer 让用户看 RESULT。
              const assets = taskAssets ?? [];
              if (assets.length === 1) {
                onOpenAsset?.(assets[0].id);
              } else if (assets.length > 1) {
                setArtifactOpen(true);
                setMenuOpen(false);
                setPickerOpen(false);
              } else {
                onOpen?.();
              }
            }}
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
        onUnblock={() => undefined}
        onRestore={() => undefined}
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
    // v2.0 P5 — cancel via the unified state-machine endpoint. The legacy
    // DELETE /tasks/:id soft-delete still exists and produces the same DB
    // outcome (status='cancelled'), but only `/transition` records the
    // transition log entry that the audit trail in §6.3 expects.
    const res = await transitionTask(task.id, { to: 'cancelled', reason: 'Cancelled by user' });
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
  // Approve: review → completed (v2.0 §6.1). Going through /transition so
  // the audit log records the transition + actor + reason.
  const handleApprove = () =>
    runMutation('通过', () => transitionTask(task.id, { to: 'completed', reason: 'Approved' }), '已通过');
  const handleReopen = () => runMutation('重启', () => reopenTask(task.id), '任务已重启');
  const handleReject = () => {
    // The drawer hosts the canonical reject UI (inline reason input + submit).
    // Card-level button just routes there — keeps reject UX consistent across
    // entry points and avoids the unstyled native prompt() dialog.
    props.onOpen?.();
  };
  // P6 BLOCKED → running. Server enforces creator/owner/admin/orchestrator/
  // assignee per TRANSITIONS matrix; assignee self-unblock is allowed by
  // design (agent self-reports → self-resolves).
  const handleUnblock = () =>
    runMutation('继续', () => transitionTask(task.id, { to: 'running', reason: 'Unblocked' }), '任务已继续');
  // P6 CANCELLED → pending (restore from recycle bin). Per the TRANSITIONS
  // matrix only creator/owner/admin/orchestrator can do this; if the actor
  // lacks the tier the server returns 403 and we surface it via
  // describeTransitionError-style toast in runMutation's error path.
  const handleRestore = () =>
    runMutation(
      '还原',
      () => transitionTask(task.id, { to: 'pending', reason: 'Restored from recycle bin' }),
      '任务已还原到构思',
    );

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
        onUnblock={handleUnblock}
        onRestore={handleRestore}
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

/**
 * Pull a short, human-readable preview from a task's `result` payload (or
 * `metadata.output` / `metadata.summary`). Used by REVIEW + DONE cards.
 *
 * Truncates to ~80 chars at a word boundary — the full text lives in the
 * drawer.
 */
function readTaskResultPreview(task: TaskDTO): string | null {
  const candidates: unknown[] = [
    task.result,
    (task.metadata as Record<string, unknown> | undefined)?.summary,
    (task.metadata as Record<string, unknown> | undefined)?.output,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return clipPreview(candidate.trim());
    }
    if (candidate && typeof candidate === 'object') {
      const obj = candidate as Record<string, unknown>;
      const textish = obj.summary ?? obj.text ?? obj.message ?? obj.output;
      if (typeof textish === 'string' && textish.trim()) {
        return clipPreview(textish.trim());
      }
    }
  }
  return null;
}

function clipPreview(text: string): string {
  const max = 80;
  if (text.length <= max) return text;
  // Trim at the last whitespace before the limit so we don't cut a word.
  const slice = text.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  const trimmed = lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${trimmed}…`;
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
//
// 2026-05-20 — All popovers in this file render via createPortal to
// document.body. The card root is `<motion.article>` (framer-motion) which
// applies an inline `transform` style. CSS spec: a transformed ancestor
// becomes the containing block for `position: fixed` descendants AND
// creates a new stacking context, so `fixed inset-0` is clipped to the
// card box and `z-50` is locally bounded — neighbouring kanban cards in
// the same column then visually overlap an "open" dropdown. Portaling
// the popover + backdrop out of the card subtree restores the
// viewport-wide `fixed` semantics and a globally-comparable z-index.
//
// usePopoverPosition keeps the dropdown glued to its trigger as the
// viewport scrolls/resizes (sticky cards repositioning during animation,
// `overflow-y-auto` columns scrolling, etc.).

type PopoverAlign = 'left' | 'right';

function usePopoverPosition(
  anchorRef: React.RefObject<HTMLElement | null>,
  align: PopoverAlign,
): { top: number; left?: number; right?: number } | null {
  const [coords, setCoords] = useState<{ top: number; left?: number; right?: number } | null>(null);
  useLayoutEffect(() => {
    const update = (): void => {
      const el = anchorRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setCoords(
        align === 'right'
          ? { top: rect.bottom + 4, right: Math.max(0, window.innerWidth - rect.right) }
          : { top: rect.bottom + 4, left: rect.left },
      );
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [anchorRef, align]);
  return coords;
}

function CardOverflowMenu({
  isDark,
  anchorRef,
  onEdit,
  onReassign,
  onAddAttachment,
  onCancel,
  onClose,
}: {
  isDark: boolean;
  anchorRef: React.RefObject<HTMLElement | null>;
  onEdit: () => void;
  onReassign: () => void;
  onAddAttachment?: () => void;
  onCancel?: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const coords = usePopoverPosition(anchorRef, 'right');
  if (typeof document === 'undefined' || !coords) return null;
  return createPortal(
    <>
      <div className="fixed inset-0 z-[200]" onClick={onClose} aria-hidden />
      <div
        data-testid="task-card-menu"
        onPointerDown={(e) => e.stopPropagation()}
        style={{ position: 'fixed', top: coords.top, right: coords.right, left: coords.left }}
        className={`z-[201] min-w-[140px] rounded-lg border shadow-xl ${
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
    </>,
    document.body,
  );
}

function CardEditPopover({
  isDark,
  anchorRef,
  title,
  description,
  saving,
  workspaceId,
  onTitleChange,
  onDescriptionChange,
  onSave,
  onClose,
}: {
  isDark: boolean;
  anchorRef: React.RefObject<HTMLElement | null>;
  title: string;
  description: string;
  saving: boolean;
  /** Wave-8 W1 / L3: workspace scope for the `#filename` asset picker. */
  workspaceId: string | null;
  onTitleChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const coords = usePopoverPosition(anchorRef, 'left');
  if (typeof document === 'undefined' || !coords) return null;
  return createPortal(
    <>
      <div className="fixed inset-0 z-[200]" onClick={onClose} aria-hidden />
      <div
        data-testid="task-card-editor"
        onPointerDown={(e) => e.stopPropagation()}
        style={{ position: 'fixed', top: coords.top, left: coords.left, right: coords.right }}
        className={`z-[201] w-[280px] rounded-xl border p-3 shadow-2xl ${
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
            {/* Wave-8 W1 / L3: TaskDescriptionEditor adds the same
                `#filename` autocomplete as the drawer F2. The picker
                anchors absolute above the textarea, which lives inside a
                fixed-position popover — works fine because the picker's
                `bottom-full` resolves against its own positioning context. */}
            <div className="mt-1">
              <TaskDescriptionEditor
                isDark={isDark}
                value={description}
                onChange={onDescriptionChange}
                workspaceId={workspaceId}
                rows={4}
                className={`w-full resize-none rounded-lg border px-2.5 py-2 text-sm outline-none ${
                  isDark
                    ? 'border-white/10 bg-white/[0.04] text-zinc-100 placeholder:text-zinc-600'
                    : 'border-zinc-200 bg-white text-zinc-900 placeholder:text-zinc-400'
                }`}
              />
            </div>
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
    </>,
    document.body,
  );
}

function CardAssigneePicker({
  isDark,
  anchorRef,
  agents,
  currentAssigneeId,
  busy,
  onPick,
  onClose,
}: {
  isDark: boolean;
  anchorRef: React.RefObject<HTMLElement | null>;
  agents: AgentDTO[];
  currentAssigneeId: string | null;
  busy: boolean;
  onPick: (assigneeId: string | null) => void;
  onClose: () => void;
}) {
  const coords = usePopoverPosition(anchorRef, 'right');
  if (typeof document === 'undefined' || !coords) return null;
  return createPortal(
    <>
      <div className="fixed inset-0 z-[200]" onClick={onClose} aria-hidden />
      <div
        data-testid="task-card-assignee-picker"
        onPointerDown={(e) => e.stopPropagation()}
        style={{ position: 'fixed', top: coords.top, right: coords.right, left: coords.left }}
        className={`z-[201] min-w-[200px] max-h-64 overflow-y-auto rounded-lg border shadow-xl ${
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
            const AgentRoleIcon = getAgentRoleIcon(agent.agentType ?? null);
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
                  <AgentRoleIcon className="w-3.5 h-3.5 shrink-0 opacity-80" />
                  <span className="flex-1 truncate">{agent.name}</span>
                  {isCurrent ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : null}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </>,
    document.body,
  );
}

function CardArtifactPopover({
  isDark,
  anchorRef,
  assets,
  onPick,
  onClose,
}: {
  isDark: boolean;
  anchorRef: React.RefObject<HTMLElement | null>;
  assets: AssetDTO[];
  onPick: (assetId: string) => void;
  onClose: () => void;
}) {
  const coords = usePopoverPosition(anchorRef, 'left');
  if (typeof document === 'undefined' || !coords) return null;
  return createPortal(
    <>
      <div className="fixed inset-0 z-[200]" onClick={onClose} aria-hidden />
      <div
        data-testid="task-card-artifact-popover"
        onPointerDown={(e) => e.stopPropagation()}
        style={{ position: 'fixed', top: coords.top, left: coords.left, right: coords.right }}
        className={`z-[201] min-w-[220px] max-h-72 overflow-y-auto rounded-lg border shadow-xl ${
          isDark ? 'bg-zinc-900 border-white/10' : 'bg-white border-zinc-200'
        }`}
      >
        <ul className="p-1">
          {assets.map((asset) => (
            <li key={asset.id} className="p-1" data-testid={`task-card-artifact-${asset.id}`}>
              <div onClick={(e) => e.stopPropagation()}>
                <WorkProductCard asset={asset} isDark={isDark} compact onOpen={onPick} />
              </div>
            </li>
          ))}
        </ul>
      </div>
    </>,
    document.body,
  );
}

function readTaskCardPriority(task: TaskDTO): keyof typeof priorityAccent {
  // release 200 P5 — `metadata.kanban.cardPriority` is no longer written
  // (and never read on the wire side). Read priority off the typed
  // `metadata.priority` field if present, otherwise derive from deadline.
  const meta = task.metadata ?? {};
  const fallback = meta.priority;
  if (fallback === 'urgent' || fallback === 'high' || fallback === 'medium' || fallback === 'low') return fallback;
  if (task.deadline) {
    const hours = (Date.parse(task.deadline) - Date.now()) / 36e5;
    if (Number.isFinite(hours) && hours < 24) return 'high';
  }
  return 'medium';
}

/**
 * release201/10 §8.4 — minimal acceptance progress bar shown on the
 * Kanban card foot. Uses the rolled-up acceptanceStatus chip + a dot
 * sequence so reviewers see "3/5 acceptance" at a glance.
 */
function AcceptanceMiniBar({ task, isDark }: { task: TaskDTO; isDark: boolean }) {
  const total = task.acceptanceTotalCount ?? 0;
  if (total === 0) return null;
  const done = task.acceptanceCompletedCount ?? 0;
  const overall = task.acceptanceStatus ?? 'none';
  const dots: Array<'passed' | 'failed' | 'pending'> = [];
  if (overall === 'passed') {
    for (let i = 0; i < total; i++) dots.push('passed');
  } else if (overall === 'failed') {
    // mix: assume failed at least one — show all dots as either passed or failed
    for (let i = 0; i < total; i++) dots.push(i < done ? 'failed' : 'pending');
  } else {
    for (let i = 0; i < total; i++) dots.push(i < done ? 'passed' : 'pending');
  }
  const colourOf = (s: 'passed' | 'failed' | 'pending') =>
    s === 'passed'
      ? isDark
        ? 'bg-emerald-400'
        : 'bg-emerald-500'
      : s === 'failed'
        ? isDark
          ? 'bg-rose-400'
          : 'bg-rose-500'
        : isDark
          ? 'bg-zinc-600'
          : 'bg-zinc-300';
  return (
    <div className={`flex items-center gap-1.5 text-[10px] ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>
      <div className="flex gap-0.5">
        {dots.map((s, i) => (
          <span key={i} className={`block h-1.5 w-1.5 rounded-full ${colourOf(s)}`} />
        ))}
      </div>
      <span>
        {done}/{total} acceptance
      </span>
    </div>
  );
}

/**
 * release201/10 rev 2 §8.4 — TODO mini progress bar. Fetches TODO.md
 * progress lazily for running/review tasks so the kanban board surfaces
 * "where is the work" without forcing the list endpoint to enrich every
 * row.
 *
 * Colour thresholds (§8.4): ≥80% emerald / 50-79% amber / <50% rose.
 * Exported so the focused unit test in
 * `__tests__/task-card-todo-mini-bar.test.tsx` can drive the fetch
 * directly without mounting the whole TaskCard chrome.
 */
export function TodoMiniBar({ taskId, isDark }: { taskId: string; isDark: boolean }) {
  const [data, setData] = useState<{
    doneCount: number;
    totalCount: number;
    progressPct: number;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await imFetch<typeof data>(`/tasks/${encodeURIComponent(taskId)}/todo`);
        if (!cancelled && res.ok) setData(res.data ?? null);
      } catch {
        /* swallow */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  if (!data || data.totalCount === 0) return null;
  const pct = Math.round(data.progressPct * 100);
  const barColor =
    pct >= 80
      ? isDark
        ? 'bg-emerald-400'
        : 'bg-emerald-500'
      : pct >= 50
        ? isDark
          ? 'bg-amber-400'
          : 'bg-amber-500'
        : isDark
          ? 'bg-rose-400'
          : 'bg-rose-500';
  return (
    <div className={`flex items-center gap-1.5 text-[10px] ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>
      <div className={`relative h-1 flex-1 overflow-hidden rounded-full ${isDark ? 'bg-zinc-800' : 'bg-zinc-200'}`}>
        <div
          className={`absolute inset-y-0 left-0 ${barColor}`}
          style={{ width: `${pct}%` }}
          data-testid="todo-mini-bar"
        />
      </div>
      <span>
        {data.doneCount}/{data.totalCount} TODO
      </span>
    </div>
  );
}
