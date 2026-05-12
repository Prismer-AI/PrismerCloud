'use client';

/**
 * AddMemberDialog — adds a human or agent to an existing group conversation.
 *
 * Wave-8 W4 audit S2: the backend has shipped `POST /api/im/groups/:id/members`
 * for ages, but the only UI path was "include in NewChannelDialog at create
 * time". Once a group existed, owners had no way to grow it. This dialog
 * reuses the username-lookup interaction from `new-channel-dialog.tsx` —
 * type a username, click +, the row appears, then Confirm calls the backend.
 */

import { useEffect, useId, useState } from 'react';
import { Loader2, Bot, User, X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { addGroupMember } from '../lib/mutations';
import { imFetch } from '../lib/im-api';

interface UserLookupResponse {
  id: string;
  username: string;
  displayName: string;
  role: string;
  agentType?: string | null;
  avatarUrl?: string | null;
  createdAt?: string;
}

interface PendingMember {
  id: string;
  username: string;
  displayName: string;
  role: 'human' | 'agent';
}

interface AddMemberDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupId: string;
  /** imUserIds already in the group — used to short-circuit duplicate adds. */
  existingMemberIds: string[];
  onAdded: () => void;
  isDark: boolean;
  notify: (message: string, type: 'success' | 'error' | 'info') => void;
}

export function AddMemberDialog({
  open,
  onOpenChange,
  groupId,
  existingMemberIds,
  onAdded,
  isDark,
  notify,
}: AddMemberDialogProps) {
  const [usernameInput, setUsernameInput] = useState('');
  const [lookupBusy, setLookupBusy] = useState(false);
  const [pending, setPending] = useState<PendingMember[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();

  useEffect(() => {
    if (open) {
      setUsernameInput('');
      setPending([]);
      setLookupBusy(false);
      setSubmitting(false);
      setError(null);
    }
  }, [open]);

  async function handleLookup() {
    const typed = usernameInput.trim();
    if (!typed || lookupBusy) return;
    setLookupBusy(true);
    setError(null);
    const res = await imFetch<UserLookupResponse>(`/users/by-username/${encodeURIComponent(typed)}`);
    setLookupBusy(false);
    if (!res.ok) {
      const msg = res.status === 404 ? `User "${typed}" not found.` : res.message;
      notify(msg, 'error');
      return;
    }
    const u = res.data;
    if (existingMemberIds.includes(u.id) || pending.some((m) => m.id === u.id)) {
      notify(`${u.displayName} is already in this group.`, 'info');
      setUsernameInput('');
      return;
    }
    const role: 'human' | 'agent' = u.role === 'agent' ? 'agent' : 'human';
    setPending((prev) => [...prev, { id: u.id, username: u.username, displayName: u.displayName, role }]);
    setUsernameInput('');
  }

  function removePending(id: string) {
    setPending((prev) => prev.filter((m) => m.id !== id));
  }

  async function handleSubmit() {
    if (pending.length === 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    // Best-effort sequential adds — `POST /groups/:id/members` accepts a
    // single userId per call, so we serialize and surface the first failure.
    let added = 0;
    let firstFailure: string | null = null;
    for (const m of pending) {
      const res = await addGroupMember(groupId, m.id);
      if (res.ok) {
        added += 1;
      } else if (!firstFailure) {
        firstFailure = res.message;
      }
    }
    setSubmitting(false);
    if (firstFailure && added === 0) {
      setError(firstFailure);
      notify(`Couldn't add member: ${firstFailure}`, 'error');
      return;
    }
    if (firstFailure) {
      // Partial success — added some but not all. Surface the message and
      // still close so the caller can re-open if they want to retry.
      notify(`Added ${added} of ${pending.length}; ${firstFailure}`, 'info');
    } else {
      notify(`Added ${added} ${added === 1 ? 'member' : 'members'}.`, 'success');
    }
    onAdded();
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
          <DialogTitle>Add member</DialogTitle>
          <DialogDescription>
            Find a human or agent by username. New members can read history from the moment they&apos;re added.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1">
            <span className={labelClass}>Username</span>
            <div className="flex items-center gap-2">
              <input
                id={inputId}
                data-testid="add-member-username-input"
                className={inputClass}
                value={usernameInput}
                onChange={(e) => setUsernameInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void handleLookup();
                  }
                }}
                placeholder="alice"
                maxLength={64}
                autoFocus
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="add-member-lookup"
                onClick={handleLookup}
                disabled={!usernameInput.trim() || lookupBusy}
              >
                {lookupBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : '+'}
              </Button>
            </div>
          </div>

          {pending.length > 0 ? (
            <div className="grid gap-1">
              <span className={labelClass}>To add</span>
              <ul
                className={`max-h-48 overflow-y-auto rounded-md border ${
                  isDark ? 'border-white/10 bg-zinc-900/60' : 'border-zinc-200 bg-zinc-50'
                }`}
                data-testid="add-member-pending-list"
              >
                {pending.map((m) => (
                  <li
                    key={m.id}
                    className={`flex items-center gap-2 px-3 py-1.5 text-sm border-b last:border-b-0 ${
                      isDark ? 'border-white/5 text-zinc-200' : 'border-zinc-100 text-zinc-800'
                    }`}
                    data-testid={`add-member-pending-${m.username}`}
                  >
                    {m.role === 'agent' ? (
                      <Bot className="w-3.5 h-3.5 opacity-70 shrink-0" />
                    ) : (
                      <User className="w-3.5 h-3.5 opacity-70 shrink-0" />
                    )}
                    <span className="truncate flex-1">{m.displayName}</span>
                    <span className="text-[10px] uppercase opacity-70">{m.role}</span>
                    <button
                      type="button"
                      onClick={() => removePending(m.id)}
                      className={`p-1 rounded ${
                        isDark ? 'text-zinc-400 hover:bg-white/5' : 'text-zinc-500 hover:bg-zinc-200/60'
                      }`}
                      title="Remove"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </li>
                ))}
              </ul>
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
          <Button data-testid="add-member-submit" onClick={handleSubmit} disabled={pending.length === 0 || submitting}>
            {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : null}
            Add {pending.length || ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
