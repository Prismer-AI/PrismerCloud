'use client';

/**
 * "New Task" modal — wraps `POST /api/im/tasks` per the task-orchestration
 * cookbook (§API surface).
 *
 * The cookbook fix-callout is important: `input` MUST be sent as an object
 * `{ prompt: "..." }`, not a bare string — otherwise the daemon's
 * `parseJsonObject` unwraps to a string and the agent silently receives the
 * task title instead of the prompt. The `createTask` helper in mutations.ts
 * already wraps for us.
 */

import { useEffect, useId, useMemo, useState } from 'react';
import { Bot, CalendarDays, Flag, Loader2, Sparkles } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { createTask, createDirectConversation } from '../lib/mutations';
import type { AgentDTO, AgentProfileDTO, AssetDTO, KanbanColumnKey, WorkspaceTaskKind } from '../lib/types';
import type { ProjectWithCountsDTO } from '../lib/projects-api';
import { TaskDescriptionEditor } from './task-description-editor';
import { buildAssetRefsFromDescription } from '../lib/task-asset-refs';
import { TaskCriteriaEditor, type CriterionDraft } from './task-criteria-editor';
import { imFetch } from '../lib/im-api';

interface NewTaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  agents: AgentDTO[];
  profiles: AgentProfileDTO[];
  /**
   * Wave-8 W1 / L3 — workspace asset list used by the description editor's
   * `#filename` picker to build `assetRefs[]` at submit time. Optional;
   * when omitted the picker still works (fetches its own list via
   * /api/im/assets) but no structured refs are sent on the wire.
   */
  workspaceAssets?: AssetDTO[];
  /** Default assignee — usually the conversation's first agent if available. */
  defaultAssigneeId?: string;
  conversationId?: string;
  initialColumn?: KanbanColumnKey | null;
  initialKind?: Extract<WorkspaceTaskKind, 'work_item' | 'goal'>;
  /**
   * release201/09 §8.6 — project scope picker. List of active projects in
   * the workspace (from useProjects hook). When empty, the Project field
   * is hidden entirely (workspaces that don't use projects don't get a
   * mystery dropdown).
   */
  projects?: ProjectWithCountsDTO[];
  /**
   * Currently-active project filter (workspace-wide). Pre-selected when
   * the dialog opens; "None — workspace level" stays available so user
   * can always opt out of scoping a single task.
   */
  defaultProjectId?: string | null;
  onCreated: () => void;
  isDark: boolean;
  notify: (message: string, type: 'success' | 'error' | 'info') => void;
}

export function NewTaskDialog({
  open,
  onOpenChange,
  workspaceId,
  agents,
  profiles,
  workspaceAssets,
  defaultAssigneeId,
  conversationId,
  initialColumn,
  initialKind,
  projects,
  defaultProjectId,
  onCreated,
  isDark,
  notify,
}: NewTaskDialogProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [kind, setKind] = useState<Extract<WorkspaceTaskKind, 'work_item' | 'goal'>>('work_item');
  const [priority, setPriority] = useState<'low' | 'medium' | 'high' | 'urgent'>('medium');
  const [dueDate, setDueDate] = useState('');
  const [capability, setCapability] = useState('');
  const [assigneeId, setAssigneeId] = useState<string>('');
  const [profileId, setProfileId] = useState<string>('');
  // release202/08 Phase 2 — where the task's progress/result/digest surface.
  // A manually-created kanban card has NO originating chat, so we must NOT
  // silently inherit the active (often group) conversation. Default 'kanban'
  // (no chat, lives on the board + drawer); the user explicitly opts into the
  // current conversation or a DM with the assignee.
  const [deliveryTarget, setDeliveryTarget] = useState<'kanban' | 'conversation' | 'dm'>('kanban');
  // release201/09 §8.6 — task project scope. Empty string sentinel = "None
  // (workspace-level)" which sends projectId=null on POST. Specific id =
  // scope this task to that project.
  const [projectId, setProjectId] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // release201/10 §8.1 — acceptance criteria draft. UI mode tracks whether
  // the user opted to use the template (default) or hand-fill, so the API
  // call can opt-out of auto-template application when criteria are present.
  const [acceptanceMode, setAcceptanceMode] = useState<'auto' | 'manual' | 'none'>('auto');
  const [criteriaDraft, setCriteriaDraft] = useState<CriterionDraft[]>([]);
  const [criteriaExpanded, setCriteriaExpanded] = useState(false);

  // First-render setup + reset on each open.
  useEffect(() => {
    if (open) {
      setTitle('');
      setDescription('');
      setKind(initialKind ?? 'work_item');
      setPriority('medium');
      setDueDate('');
      setCapability('');
      setError(null);
      setSubmitting(false);
      setAcceptanceMode('auto');
      setCriteriaDraft([]);
      setCriteriaExpanded(false);
      // Prefer the provided default; otherwise pick the first agent so the form
      // is immediately submittable. Empty string = "marketplace / unassigned".
      const fallback = defaultAssigneeId ?? agents[0]?.userId ?? '';
      setAssigneeId(initialColumn === 'backlog' ? '' : fallback);
      // Default project: caller's activeProject when it points to a real
      // project id; sentinel values ('all' / '__unscoped') fall back to
      // empty string (workspace-level).
      const dp = defaultProjectId ?? '';
      setProjectId(dp && dp !== 'all' && dp !== '__unscoped' && (projects ?? []).some((p) => p.id === dp) ? dp : '');
      // Phase 2 — always reset to 'kanban'; never auto-inherit the open
      // conversation (the bug this fixes: a card made while a group chat was
      // open silently dumped its digest into that group).
      setDeliveryTarget('kanban');
    }
  }, [open, defaultAssigneeId, agents, initialColumn, initialKind, defaultProjectId, projects]);

  // When the assignee changes, narrow profile choices and pick a sensible
  // default (the agent's first profile). The cookbook lets daemon resolve a
  // profile if `profileId` is empty, so we also keep "auto" as the default.
  const assigneeProfiles = useMemo(
    () => profiles.filter((p) => p.agentImUserId === assigneeId),
    [profiles, assigneeId],
  );
  useEffect(() => {
    setProfileId(assigneeProfiles[0]?.id ?? '');
  }, [assigneeProfiles]);

  const ids = {
    title: useId(),
    description: useId(),
    assignee: useId(),
    profile: useId(),
    delivery: useId(),
    kind: useId(),
    priority: useId(),
    due: useId(),
    capability: useId(),
    project: useId(),
  };

  const inputClass = `w-full rounded-md border px-3 py-1.5 text-sm outline-none focus:ring-1 ${
    isDark
      ? 'bg-zinc-900 border-white/10 text-zinc-100 focus:ring-violet-500/40'
      : 'bg-white border-zinc-300 text-zinc-900 focus:ring-violet-400'
  }`;
  const labelClass = `text-xs font-medium ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`;

  const suggestedAgents = useMemo(
    () => suggestAgentsForCapability(agents, capability || title || description),
    [agents, capability, title, description],
  );
  const canSubmit = !submitting && title.trim().length > 0;

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    // Wave-8 W1 / L3: extract `prismer://...asset/<hash>` URIs the user
    // dropped into the description via the `#filename` picker and send the
    // resolved set as `assetRefs[]` so the daemon's dispatch hydrator can
    // ingest them at run start.
    const wireDescription = description.trim() || undefined;
    const refs = buildAssetRefsFromDescription(wireDescription, workspaceAssets, workspaceId);
    // release202/08 Phase 2 — resolve the chosen delivery target into the
    // task's conversationId. 'kanban' → undefined (no chat, board-only);
    // 'conversation' → the open conversation; 'dm' → ensure/create the
    // creator↔assignee direct conversation. Falls back to kanban if the
    // chosen target isn't resolvable (e.g. DM create failed / assignee
    // cleared), never silently inheriting the open conversation.
    let effectiveConversationId: string | undefined;
    if (deliveryTarget === 'conversation' && conversationId) {
      effectiveConversationId = conversationId;
    } else if (deliveryTarget === 'dm' && assigneeId) {
      const dm = await createDirectConversation(assigneeId, workspaceId);
      // Soft fallback: if the DM can't be ensured, the task is still created
      // board-only (kanban) rather than failing or leaking to a group.
      if (dm.ok && dm.data?.id) effectiveConversationId = dm.data.id;
    }
    const res = await createTask({
      workspaceId,
      title: title.trim(),
      description: wireDescription,
      assigneeId: assigneeId || undefined,
      capability: capability.trim() || undefined,
      profileId: profileId || undefined,
      conversationId: effectiveConversationId,
      // release201/09 §3.3 + §4.1 — projectId is opt-in. Empty string maps
      // to NULL (workspace-level task). Non-empty must be an active
      // project in this workspace (service validates).
      ...(projectId ? { projectId } : {}),
      ...(refs.length > 0 ? { assetRefs: refs } : {}),
      metadata: {
        kind,
        priority,
        ...(dueDate ? { dueDate: new Date(dueDate).toISOString() } : {}),
        ...(effectiveConversationId ? { context: { linkedConversationId: effectiveConversationId } } : {}),
        // release201/10 §8.1 — when user hand-fills criteria OR chooses
        // "None", instruct cloud to skip the default template auto-apply.
        ...(acceptanceMode !== 'auto' ? { skipAcceptanceTemplate: true } : {}),
        ...(kind === 'goal'
          ? {
              intent: 'standing_objective',
              goal: {
                status: 'active',
                priority: priority === 'urgent' ? 'high' : priority,
                linkedConversationIds: effectiveConversationId ? [effectiveConversationId] : [],
                linkedTaskIds: [],
                lastActivityAt: new Date().toISOString(),
              },
            }
          : {}),
      },
    });
    // release201/10 §8.1 — after task creation, push hand-filled criteria
    // through /tasks/:id/criteria. Best-effort: failures surface to user
    // as a notify warning but the task is already created.
    if (res.ok && res.data?.id && acceptanceMode === 'manual' && criteriaDraft.length > 0) {
      const taskId = res.data.id;
      for (const c of criteriaDraft) {
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
          notify(`Criterion add failed: ${(err as Error).message}`, 'error');
        }
      }
    }
    setSubmitting(false);
    if (!res.ok) {
      setError(res.message);
      notify(`Couldn't create task: ${res.message}`, 'error');
      return;
    }
    notify(assigneeId ? `Task "${title}" dispatched.` : `Task "${title}" created in Backlog.`, 'success');
    onCreated();
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription>
            Create a task and dispatch it to an agent. The daemon will pick it up via WS.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          {/*
            release201/09 §8.6 — Project picker. Only render when the
            workspace has at least one project; otherwise hide entirely
            (Phase 1+ workspaces without projects shouldn't see a mystery
            empty dropdown). "None — workspace level" is always present
            so users can opt out per-task even when project filter is
            pre-selected.
          */}
          {projects && projects.length > 0 ? (
            <label className="grid gap-1" htmlFor={ids.project}>
              <span className={labelClass}>Project</span>
              <select
                id={ids.project}
                data-testid="new-task-project"
                className={inputClass}
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
              >
                <option value="">— None (workspace level) —</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <div className="grid gap-2 sm:grid-cols-2">
            <label className="grid gap-1" htmlFor={ids.kind}>
              <span className={labelClass}>Type</span>
              <select
                id={ids.kind}
                data-testid="new-task-kind"
                className={inputClass}
                value={kind}
                onChange={(e) => setKind(e.target.value as 'work_item' | 'goal')}
              >
                <option value="work_item">Work item</option>
                <option value="goal">Goal</option>
              </select>
            </label>
            <label className="grid gap-1" htmlFor={ids.priority}>
              <span className={labelClass}>Priority</span>
              <select
                id={ids.priority}
                data-testid="new-task-priority"
                className={inputClass}
                value={priority}
                onChange={(e) => setPriority(e.target.value as 'low' | 'medium' | 'high' | 'urgent')}
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </label>
          </div>

          <label className="grid gap-1" htmlFor={ids.title}>
            <span className={labelClass}>Title</span>
            <input
              id={ids.title}
              data-testid="new-task-title"
              className={inputClass}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Summarize last 24h of #eng-product"
              autoFocus
              maxLength={200}
            />
          </label>

          <label className="grid gap-1" htmlFor={ids.description}>
            <span className={labelClass}>Description</span>
            {/* Wave-8 W1 / L3: same `#filename` autocomplete as the
                drawer + card editor. Type `#` after a space to open the
                workspace asset picker. Selected files are inserted as
                markdown links (`[spec.md](prismer://...)`); the resolved
                `assetRefs[]` ships alongside the description on submit. */}
            <TaskDescriptionEditor
              id={ids.description}
              isDark={isDark}
              value={description}
              onChange={setDescription}
              workspaceId={workspaceId}
              rows={5}
              maxLength={4000}
              placeholder="What should be done. Markdown supported — links, lists, code. Type # to attach a workspace file. The executing agent sees this verbatim."
              data-testid="new-task-description"
              className={`${inputClass} min-h-[120px] resize-y`}
            />
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1" htmlFor={ids.capability}>
              <span className={labelClass}>Capability</span>
              <input
                id={ids.capability}
                data-testid="new-task-capability"
                className={inputClass}
                value={capability}
                onChange={(e) => setCapability(e.target.value)}
                placeholder="planning, code, research..."
                maxLength={80}
              />
            </label>
            <label className="grid gap-1" htmlFor={ids.due}>
              <span className={labelClass}>Due</span>
              <input
                id={ids.due}
                data-testid="new-task-due"
                className={inputClass}
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                type="datetime-local"
              />
            </label>
          </div>

          {suggestedAgents.length > 0 ? (
            <div
              className={`rounded-2xl border p-3 ${
                isDark ? 'border-white/10 bg-white/[0.03]' : 'border-zinc-200 bg-zinc-50'
              }`}
            >
              <div
                className={`mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider ${
                  isDark ? 'text-zinc-400' : 'text-zinc-500'
                }`}
              >
                <Sparkles className="h-3.5 w-3.5" />
                Suggested agents
              </div>
              <div className="flex flex-wrap gap-2">
                {suggestedAgents.slice(0, 4).map((agent) => (
                  <button
                    key={agent.userId}
                    type="button"
                    onClick={() => setAssigneeId(agent.userId)}
                    className={`inline-flex items-center gap-1.5 rounded-2xl border px-2.5 py-1 text-xs ${
                      assigneeId === agent.userId
                        ? isDark
                          ? 'border-violet-400/40 bg-violet-500/20 text-violet-100'
                          : 'border-violet-200 bg-violet-100 text-violet-800'
                        : isDark
                          ? 'border-white/10 bg-white/[0.03] text-zinc-300'
                          : 'border-zinc-200 bg-white text-zinc-700'
                    }`}
                  >
                    <Bot className="h-3.5 w-3.5" />
                    {agent.name}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-3">
            <label className="grid gap-1" htmlFor={ids.assignee}>
              <span className={labelClass}>Assignee</span>
              <select
                id={ids.assignee}
                data-testid="new-task-assignee"
                className={inputClass}
                value={assigneeId}
                onChange={(e) => setAssigneeId(e.target.value)}
              >
                <option value="">— Marketplace (no assignee) —</option>
                {agents.map((a) => (
                  <option key={a.userId} value={a.userId}>
                    {a.name}
                    {a.agentType ? ` · ${a.agentType}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1" htmlFor={ids.profile}>
              <span className={labelClass}>Profile</span>
              <select
                id={ids.profile}
                data-testid="new-task-profile"
                className={inputClass}
                value={profileId}
                onChange={(e) => setProfileId(e.target.value)}
                disabled={!assigneeId || assigneeProfiles.length === 0}
              >
                <option value="">{assigneeProfiles.length === 0 ? '(auto-assigned)' : '— auto —'}</option>
                {assigneeProfiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.adapterName} · {p.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {/* release202/08 Phase 2 — explicit delivery target. A kanban card has
              no originating chat; default 'kanban' (board + drawer only) and let
              the user opt into the current conversation or a DM with the
              assignee. Never silently inherit the open (group) conversation. */}
          <label className="grid gap-1" htmlFor={ids.delivery}>
            <span className={labelClass}>进度 / 产物发送到</span>
            <select
              id={ids.delivery}
              data-testid="new-task-delivery"
              className={inputClass}
              value={deliveryTarget}
              onChange={(e) => setDeliveryTarget(e.target.value as 'kanban' | 'conversation' | 'dm')}
            >
              <option value="kanban">仅看板（不进任何聊天）</option>
              {conversationId ? <option value="conversation">当前会话</option> : null}
              {assigneeId ? <option value="dm">与执行 agent 的私聊</option> : null}
            </select>
          </label>

          <div
            className={`grid gap-2 rounded-2xl border px-3 py-2 text-[11px] ${
              isDark ? 'border-white/10 bg-white/[0.03] text-zinc-400' : 'border-zinc-200 bg-zinc-50 text-zinc-600'
            }`}
          >
            <span className="inline-flex items-center gap-1.5">
              <Flag className="h-3.5 w-3.5" />
              {kind === 'goal'
                ? 'Goal context is loaded into future agent prompts.'
                : 'Work items appear on the board and dispatch as child agent runs.'}
            </span>
            {dueDate ? (
              <span className="inline-flex items-center gap-1.5">
                <CalendarDays className="h-3.5 w-3.5" />
                Due date is stored in task metadata for board and mobile parity.
              </span>
            ) : null}
          </div>

          {/* release201/10 §8.1 — Acceptance criteria folding region. */}
          <div
            className={`rounded-2xl border ${
              isDark ? 'border-white/10 bg-white/[0.02]' : 'border-zinc-200 bg-zinc-50'
            }`}
          >
            <button
              type="button"
              onClick={() => setCriteriaExpanded((s) => !s)}
              className={`flex w-full items-center justify-between px-3 py-2 text-xs font-semibold ${
                isDark ? 'text-zinc-200' : 'text-zinc-800'
              }`}
              data-testid="acceptance-expand"
            >
              <span>Acceptance criteria</span>
              <span className={`text-[10px] ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>
                {acceptanceMode === 'auto'
                  ? 'auto (by capability)'
                  : acceptanceMode === 'manual'
                    ? `${criteriaDraft.length} criteria`
                    : 'none'}
              </span>
            </button>
            {criteriaExpanded ? (
              <div className="border-t border-inherit px-3 py-2">
                <label className="grid gap-1">
                  <span className={`text-[11px] font-medium ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
                    Use template
                  </span>
                  <select
                    className={inputClass}
                    value={acceptanceMode}
                    onChange={(e) => {
                      const next = e.target.value as 'auto' | 'manual' | 'none';
                      setAcceptanceMode(next);
                      if (next !== 'manual') setCriteriaDraft([]);
                    }}
                    data-testid="acceptance-mode"
                  >
                    <option value="auto">Auto-detect by capability (default)</option>
                    <option value="manual">Manual (hand-fill below)</option>
                    <option value="none">None (skip acceptance gate)</option>
                  </select>
                </label>
                {acceptanceMode === 'manual' ? (
                  <div className="mt-2">
                    <TaskCriteriaEditor isDark={isDark} value={criteriaDraft} onChange={setCriteriaDraft} />
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          {error ? (
            <p className={`text-xs ${isDark ? 'text-red-300' : 'text-red-600'}`} role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit} data-testid="new-task-submit">
            {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : null}
            Dispatch task
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function suggestAgentsForCapability(agents: AgentDTO[], query: string): AgentDTO[] {
  const q = query.trim().toLowerCase();
  if (!q) return agents;
  return [...agents].sort((a, b) => scoreAgent(b, q) - scoreAgent(a, q));
}

function scoreAgent(agent: AgentDTO, query: string): number {
  const haystack = [agent.name, agent.agentType, ...(agent.capabilities ?? [])].filter(Boolean).join(' ').toLowerCase();
  let score = 0;
  for (const token of query.split(/[^a-z0-9_-]+/).filter(Boolean)) {
    if (haystack.includes(token)) score += 2;
    if ((agent.capabilities ?? []).some((cap) => cap.toLowerCase().includes(token))) score += 3;
  }
  if (/code|implement|fix|test|repo/.test(query) && /codex|claude|code/.test(haystack)) score += 4;
  if (
    /plan|goal|operate|coordinate|research|marketing|ceo|cmo|coo|pm/.test(query) &&
    /hermes|openclaw/.test(haystack)
  ) {
    score += 4;
  }
  return score;
}
