'use client';

/**
 * "New Session" modal — direct mode creates a real direct conversation while
 * group mode uses `/api/im/groups`. Direct chat titles are viewer-specific and
 * are derived by the conversations API from the other participant.
 */

import { useEffect, useId, useMemo, useState } from 'react';
import { Loader2, Bot, User } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { createDirectConversation, createGroupConversation } from '../lib/mutations';
import { imFetch } from '../lib/im-api';
import type { AgentDTO } from '../lib/types';

type Mode = 'direct' | 'group';

interface ManualMember {
  id: string;
  username: string;
  displayName: string;
  role: 'human' | 'agent';
}

interface UserLookupResponse {
  id: string;
  username: string;
  displayName: string;
  role: string;
  agentType?: string | null;
  avatarUrl?: string | null;
  createdAt?: string;
}

// Wave-8 W8 C5: relationship status returned by GET /contacts/status. Drives
// the inline chip we render below the "Add by username" search row so the
// user knows whether the target is already a friend, has a pending request
// in flight, or is blocked. Blocked-by-them is a hard refusal.
type ContactStatus =
  | 'self'
  | 'friend'
  | 'pending_sent'
  | 'pending_received'
  | 'blocked_by_me'
  | 'blocked_by_them'
  | 'stranger';

interface ContactStatusResponse {
  status: ContactStatus;
  user: { id: string; username: string; displayName: string; role: string };
  requestId?: string;
}

function statusLabel(status: ContactStatus): { label: string; tone: 'ok' | 'info' | 'warn' | 'block' } {
  switch (status) {
    case 'self':
      return { label: "That's you", tone: 'info' };
    case 'friend':
      return { label: 'Already friend', tone: 'ok' };
    case 'pending_sent':
      return { label: 'Pending request', tone: 'info' };
    case 'pending_received':
      return { label: 'They sent you a request', tone: 'info' };
    case 'blocked_by_me':
      return { label: 'You blocked them', tone: 'warn' };
    case 'blocked_by_them':
      return { label: 'They blocked you', tone: 'block' };
    case 'stranger':
    default:
      return { label: 'Stranger — request sent on add', tone: 'info' };
  }
}

interface NewChannelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId?: string | null;
  agents: AgentDTO[];
  /** Called with the new group/conversation id so the page can refresh + select. */
  onCreated: (conversationId: string) => void;
  isDark: boolean;
  notify: (message: string, type: 'success' | 'error' | 'info') => void;
}

export function NewChannelDialog({
  open,
  onOpenChange,
  workspaceId,
  agents,
  onCreated,
  isDark,
  notify,
}: NewChannelDialogProps) {
  const [mode, setMode] = useState<Mode>('direct');
  const [title, setTitle] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manuallyAddedMembers, setManuallyAddedMembers] = useState<ManualMember[]>([]);
  const [usernameInput, setUsernameInput] = useState('');
  const [lookupBusy, setLookupBusy] = useState(false);
  // Wave-8 W8 C5: per-username status chip (cleared when input mutates).
  const [statusInfo, setStatusInfo] = useState<ContactStatusResponse | null>(null);

  useEffect(() => {
    if (open) {
      setMode('direct');
      setTitle('');
      setSelected(new Set());
      setError(null);
      setSubmitting(false);
      setManuallyAddedMembers([]);
      setUsernameInput('');
      setLookupBusy(false);
      setStatusInfo(null);
    }
  }, [open]);

  // Reset the chip when the user is editing the input — a stale chip from a
  // prior search would lie about the new entry.
  useEffect(() => {
    setStatusInfo(null);
  }, [usernameInput]);

  const titleId = useId();

  // For direct mode we constrain to exactly one selected counterparty; for
  // group mode the user picks any number (cookbook 3 §1 shows multi-member).
  const canSubmit = useMemo(() => {
    if (submitting) return false;
    if (mode === 'direct') return selected.size === 1;
    // group requires title + at least one member (creator auto-added)
    return title.trim().length > 0 && selected.size >= 1;
  }, [submitting, mode, selected, title]);

  function toggleMember(userId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) {
        next.delete(userId);
      } else {
        if (mode === 'direct') next.clear(); // single-select for 1:1
        next.add(userId);
      }
      return next;
    });
  }

  async function handleAddByUsername() {
    const typed = usernameInput.trim();
    if (!typed || lookupBusy) return;
    setLookupBusy(true);
    setError(null);

    // Wave-8 W8 C5: hit /contacts/status FIRST so we can render the chip and
    // refuse blocked_by_them before mutating the member list. /contacts/status
    // also returns the resolved IMUser so we don't need a second
    // /users/by-username call. 404 means the target user doesn't exist.
    const cleaned = typed.replace(/^@/, '');
    const statusRes = await imFetch<ContactStatusResponse>(`/contacts/status?username=${encodeURIComponent(cleaned)}`);
    setLookupBusy(false);
    if (!statusRes.ok) {
      const msg = statusRes.status === 404 ? `User "${typed}" not found.` : statusRes.message;
      notify(msg, 'error');
      return;
    }
    setStatusInfo(statusRes.data);

    if (statusRes.data.status === 'blocked_by_them') {
      // Hard refusal — don't add the row. The chip already explains why.
      notify(`Cannot add ${statusRes.data.user.displayName}: they have blocked you.`, 'error');
      return;
    }
    if (statusRes.data.status === 'self') {
      notify("You can't add yourself.", 'info');
      return;
    }

    const u = statusRes.data.user;
    if (manuallyAddedMembers.some((m) => m.id === u.id) || selected.has(u.id)) {
      notify(`${u.displayName} is already added.`, 'info');
      setUsernameInput('');
      return;
    }
    const role: 'human' | 'agent' = u.role === 'agent' ? 'agent' : 'human';
    setManuallyAddedMembers((prev) => [...prev, { id: u.id, username: u.username, displayName: u.displayName, role }]);
    setSelected((prev) => {
      const next = new Set(prev);
      next.add(u.id);
      return next;
    });
    setUsernameInput('');
    setStatusInfo(null);
  }

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    const memberIds = Array.from(selected);
    if (mode === 'direct') {
      const targetId = memberIds[0];
      const target = agents.find((a) => a.userId === targetId);
      const res = await createDirectConversation(targetId, workspaceId);
      setSubmitting(false);
      if (!res.ok) {
        setError(res.message);
        notify(`Couldn't create session: ${res.message}`, 'error');
        return;
      }
      notify(`Session with ${target?.name ?? 'contact'} opened.`, 'success');
      onCreated(res.data.id);
      onOpenChange(false);
      return;
    }

    const computedTitle = title.trim();
    const res = await createGroupConversation({
      title: computedTitle,
      members: memberIds,
    });
    setSubmitting(false);
    if (!res.ok) {
      setError(res.message);
      notify(`Couldn't create session: ${res.message}`, 'error');
      return;
    }
    notify(`Session ${computedTitle} created.`, 'success');
    onCreated(res.data.groupId);
    onOpenChange(false);
  }

  const inputClass = `w-full rounded-md border px-3 py-1.5 text-sm outline-none focus:ring-1 ${
    isDark
      ? 'bg-zinc-900 border-white/10 text-zinc-100 focus:ring-violet-500/40'
      : 'bg-white border-zinc-300 text-zinc-900 focus:ring-violet-400'
  }`;
  const labelClass = `text-xs font-medium ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New session</DialogTitle>
          <DialogDescription>
            Start a 1:1 or group session. You&apos;ll be added automatically as the owner.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          {/* mode toggle */}
          <div className="flex items-center gap-2" role="tablist">
            {(['direct', 'group'] as Mode[]).map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                data-testid={`new-channel-mode-${m}`}
                onClick={() => {
                  setMode(m);
                  if (m === 'direct' && selected.size > 1) {
                    setSelected(new Set([...selected].slice(0, 1)));
                  }
                }}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  mode === m
                    ? isDark
                      ? 'bg-violet-500/20 text-violet-200'
                      : 'bg-violet-100 text-violet-800'
                    : isDark
                      ? 'bg-zinc-900 text-zinc-400 hover:bg-zinc-800'
                      : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'
                }`}
              >
                {m === 'direct' ? '1:1 chat' : 'Group'}
              </button>
            ))}
          </div>

          {mode === 'group' ? (
            <label className="grid gap-1" htmlFor={titleId}>
              <span className={labelClass}>Group title</span>
              <input
                id={titleId}
                data-testid="new-channel-title"
                className={inputClass}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Sprint planning"
                maxLength={120}
                autoFocus
              />
            </label>
          ) : null}

          <div className="grid gap-1">
            <span className={labelClass}>{mode === 'direct' ? 'Counterparty' : 'Members'}</span>
            <div
              className={`max-h-56 overflow-y-auto rounded-md border ${
                isDark ? 'border-white/10 bg-zinc-900/60' : 'border-zinc-200 bg-zinc-50'
              }`}
            >
              {agents.length === 0 ? (
                <p className={`px-3 py-3 text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                  No agents yet — register one with &quot;+ Agent&quot; first.
                </p>
              ) : (
                <ul className="py-1">
                  {agents.map((a) => {
                    const checked = selected.has(a.userId);
                    return (
                      <li key={a.userId}>
                        <label
                          className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer text-sm ${
                            checked
                              ? isDark
                                ? 'bg-violet-500/15 text-violet-200'
                                : 'bg-violet-100 text-violet-900'
                              : isDark
                                ? 'text-zinc-300 hover:bg-white/5'
                                : 'text-zinc-700 hover:bg-zinc-100'
                          }`}
                        >
                          <input
                            type={mode === 'direct' ? 'radio' : 'checkbox'}
                            name="new-channel-member"
                            data-testid={`new-channel-member-${a.userId}`}
                            checked={checked}
                            onChange={() => toggleMember(a.userId)}
                            className="accent-violet-500"
                          />
                          {a.agentType ? (
                            <Bot className="w-3.5 h-3.5 opacity-70 shrink-0" />
                          ) : (
                            <User className="w-3.5 h-3.5 opacity-70 shrink-0" />
                          )}
                          <span className="truncate">{a.name}</span>
                          {a.agentType ? (
                            <span className={`ml-auto text-[10px] uppercase opacity-70 shrink-0`}>{a.agentType}</span>
                          ) : null}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>

          {mode === 'group' ? (
            <div className="grid gap-1">
              <span className={labelClass}>Add by username</span>
              <div className="flex items-center gap-2">
                <input
                  data-testid="new-channel-username-input"
                  className={inputClass}
                  value={usernameInput}
                  onChange={(e) => setUsernameInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleAddByUsername();
                    }
                  }}
                  placeholder="alice"
                  maxLength={64}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid="new-channel-username-add"
                  onClick={handleAddByUsername}
                  disabled={!usernameInput.trim() || lookupBusy || statusInfo?.status === 'blocked_by_them'}
                >
                  {lookupBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : '+'}
                </Button>
              </div>
              {statusInfo ? (
                <p
                  data-testid={`new-channel-username-status-${statusInfo.status}`}
                  className={`mt-1 inline-flex items-center self-start rounded-full px-2 py-0.5 text-[10px] font-medium ${
                    statusLabel(statusInfo.status).tone === 'block'
                      ? isDark
                        ? 'bg-red-500/15 text-red-300'
                        : 'bg-red-100 text-red-700'
                      : statusLabel(statusInfo.status).tone === 'warn'
                        ? isDark
                          ? 'bg-amber-500/15 text-amber-300'
                          : 'bg-amber-100 text-amber-700'
                        : statusLabel(statusInfo.status).tone === 'ok'
                          ? isDark
                            ? 'bg-emerald-500/15 text-emerald-300'
                            : 'bg-emerald-100 text-emerald-700'
                          : isDark
                            ? 'bg-zinc-800 text-zinc-300'
                            : 'bg-zinc-100 text-zinc-700'
                  }`}
                >
                  {statusLabel(statusInfo.status).label}
                  {statusInfo.user.username ? ` · @${statusInfo.user.username}` : null}
                </p>
              ) : null}
              {manuallyAddedMembers.length > 0 ? (
                <div
                  className={`mt-1 max-h-40 overflow-y-auto rounded-md border ${
                    isDark ? 'border-white/10 bg-zinc-900/60' : 'border-zinc-200 bg-zinc-50'
                  }`}
                >
                  <ul className="py-1">
                    {manuallyAddedMembers.map((m) => {
                      const checked = selected.has(m.id);
                      return (
                        <li key={m.id}>
                          <label
                            className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer text-sm ${
                              checked
                                ? isDark
                                  ? 'bg-violet-500/15 text-violet-200'
                                  : 'bg-violet-100 text-violet-900'
                                : isDark
                                  ? 'text-zinc-300 hover:bg-white/5'
                                  : 'text-zinc-700 hover:bg-zinc-100'
                            }`}
                          >
                            <input
                              type="checkbox"
                              data-testid={`new-channel-manual-member-${m.id}`}
                              checked={checked}
                              onChange={() => toggleMember(m.id)}
                              className="accent-violet-500"
                            />
                            {m.role === 'agent' ? (
                              <Bot className="w-3.5 h-3.5 opacity-70 shrink-0" />
                            ) : (
                              <User className="w-3.5 h-3.5 opacity-70 shrink-0" />
                            )}
                            <span className="truncate">{m.displayName}</span>
                            <span className="ml-auto text-[10px] uppercase opacity-70 shrink-0">{m.role}</span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}

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
          <Button onClick={handleSubmit} disabled={!canSubmit} data-testid="new-channel-submit">
            {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : null}
            Create session
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
