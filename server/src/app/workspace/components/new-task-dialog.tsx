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
import { createTask } from '../lib/mutations';
import type { AgentDTO, AgentProfileDTO, KanbanColumnKey, WorkspaceTaskKind } from '../lib/types';

interface NewTaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  agents: AgentDTO[];
  profiles: AgentProfileDTO[];
  /** Default assignee — usually the conversation's first agent if available. */
  defaultAssigneeId?: string;
  conversationId?: string;
  initialColumn?: KanbanColumnKey | null;
  initialKind?: Extract<WorkspaceTaskKind, 'work_item' | 'goal'>;
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
  defaultAssigneeId,
  conversationId,
  initialColumn,
  initialKind,
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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      // Prefer the provided default; otherwise pick the first agent so the form
      // is immediately submittable. Empty string = "marketplace / unassigned".
      const fallback = defaultAssigneeId ?? agents[0]?.userId ?? '';
      setAssigneeId(initialColumn === 'backlog' ? '' : fallback);
    }
  }, [open, defaultAssigneeId, agents, initialColumn, initialKind]);

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
    kind: useId(),
    priority: useId(),
    due: useId(),
    capability: useId(),
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
    const res = await createTask({
      workspaceId,
      title: title.trim(),
      description: description.trim() || undefined,
      assigneeId: assigneeId || undefined,
      capability: capability.trim() || undefined,
      profileId: profileId || undefined,
      conversationId: conversationId,
      metadata: {
        kind,
        priority,
        ...(dueDate ? { dueDate: new Date(dueDate).toISOString() } : {}),
        ...(conversationId ? { context: { linkedConversationId: conversationId } } : {}),
        ...(kind === 'goal'
          ? {
              intent: 'standing_objective',
              goal: {
                status: 'active',
                priority: priority === 'urgent' ? 'high' : priority,
                linkedConversationIds: conversationId ? [conversationId] : [],
                linkedTaskIds: [],
                lastActivityAt: new Date().toISOString(),
              },
            }
          : {}),
      },
    });
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
            <textarea
              id={ids.description}
              data-testid="new-task-description"
              className={`${inputClass} min-h-[120px] resize-y`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What should be done. Markdown supported — links, lists, code. The executing agent sees this verbatim."
              maxLength={4000}
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
                <option value="">{assigneeProfiles.length === 0 ? '(daemon picks)' : '— auto —'}</option>
                {assigneeProfiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.adapterName} · {p.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

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
