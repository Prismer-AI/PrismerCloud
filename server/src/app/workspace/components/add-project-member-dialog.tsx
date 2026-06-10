'use client';

/**
 * AddProjectMemberDialog — release201/16 Phase 10 (v2.0.8).
 *
 * Lets a project owner add a workspace member to a project. Two-step:
 *   1. Pick the workspace member via ContactPicker (16 §3.1.3)
 *   2. Choose a role (contributor / observer)
 *
 * Submits to `POST /api/im/projects/:id/members` (`addProjectMember`). The
 * server enforces the workspace member invariant (16 §3.3.3a) — surfacing
 * NOT_WORKSPACE_MEMBER here is defense-in-depth; the picker source already
 * filters to workspace members so it should not happen in practice.
 */

import { useId, useState } from 'react';
import { Loader2, UserPlus } from 'lucide-react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { addProjectMember } from '../lib/projects-api';
import type { ProjectMembershipRole } from '../lib/projects-api';
import { ContactPicker, type ContactPickerOption } from './contact-picker';

export function AddProjectMemberDialog({
  workspaceId,
  projectId,
  excludePrincipalIds,
  meImUserId,
  isDark,
  onOpenChange,
  onAdded,
}: {
  workspaceId: string;
  projectId: string;
  excludePrincipalIds: string[];
  meImUserId: string | null;
  isDark: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: () => void;
}) {
  const [selected, setSelected] = useState<ContactPickerOption | null>(null);
  const [role, setRole] = useState<ProjectMembershipRole>('contributor');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const roleId = useId();

  const textMuted = isDark ? 'text-zinc-400' : 'text-zinc-600';
  const textPrimary = isDark ? 'text-zinc-100' : 'text-zinc-900';
  const subtleBg = isDark ? 'bg-zinc-950 border-white/10' : 'bg-zinc-50 border-zinc-300';
  const input = isDark
    ? 'bg-zinc-900 border-white/10 text-zinc-100 focus:ring-violet-500/40'
    : 'bg-white border-zinc-300 text-zinc-900 focus:ring-violet-400';
  const inputClass = `w-full rounded-md border px-3 py-1.5 text-sm outline-none focus:ring-1 ${input}`;

  async function submit() {
    if (!selected) return;
    setError(null);
    setSubmitting(true);
    const res = await addProjectMember(projectId, {
      principalKind: 'user',
      principalId: selected.imUserId,
      role,
    });
    setSubmitting(false);
    if (!res.ok) {
      // Surface common server-side codes in plain language; show the raw
      // message otherwise so we don't hide unexpected failures.
      const friendly = (() => {
        switch (res.error) {
          case 'NOT_WORKSPACE_MEMBER':
            return 'That user is not in this workspace yet.';
          case 'PROJECT_CONFLICT':
            return 'That user is already a member of this project.';
          default:
            return res.message;
        }
      })();
      setError(friendly);
      return;
    }
    onAdded();
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add member</DialogTitle>
        </DialogHeader>

        {!selected ? (
          <ContactPicker
            workspaceId={workspaceId}
            excludePrincipalIds={excludePrincipalIds}
            excludeSelfId={meImUserId}
            isDark={isDark}
            onSelect={setSelected}
          />
        ) : (
          <>
            <div className={`flex items-center gap-2 rounded border px-3 py-2 ${subtleBg}`}>
              <div className="flex-1 min-w-0">
                <div className={`text-sm font-medium ${textPrimary} truncate`}>{selected.displayName}</div>
                <div className={`text-[11px] font-mono ${textMuted} truncate`}>{selected.imUserId}</div>
              </div>
              <Button variant="ghost" size="xs" onClick={() => setSelected(null)}>
                Change
              </Button>
            </div>
            <label htmlFor={roleId} className="space-y-1 block">
              <span className={`text-[11px] ${textMuted}`}>Role</span>
              <select
                id={roleId}
                value={role}
                onChange={(e) => setRole(e.target.value as ProjectMembershipRole)}
                className={inputClass}
              >
                <option value="contributor">contributor</option>
                <option value="observer">observer</option>
              </select>
            </label>
          </>
        )}

        {error ? (
          <p className={`text-xs ${isDark ? 'text-red-300' : 'text-red-600'}`} role="alert">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!selected || submitting}>
            {submitting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
            ) : (
              <UserPlus className="h-3.5 w-3.5 mr-1" />
            )}
            Add to project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
