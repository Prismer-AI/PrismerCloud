'use client';

/**
 * Workspace Members + Invites — release201/16 Phase 9 (v2.0.8).
 *
 * Inline section rendered on /workspace/[wsId]/settings. Two tabs:
 *   - Members: list workspace members, change role (owner-only), remove
 *     (owner-only). Owner row is non-removable (ownership transfer is v2.1+).
 *   - Invites: list outstanding invites, mint new, revoke pending.
 *
 * Design notes (16 §3.1 + memory feedback_use_design_system_primitives):
 *   - shadcn primitives only: Tabs / Button / Badge / AlertDialog / Dialog
 *   - one intent → one affordance (feedback_one_intent_one_affordance)
 *   - reuses isDark + zinc palette to match neighbouring settings sections
 *     (ChiefOfStaffSection, ClearWorkspaceDialog) — not the CSS-variable
 *     theme path used by the public invite landing page
 *   - invite "addressee" column shows email OR imUserId, never both (we
 *     never mint both)
 *
 * Auth: owner/admin can mint invites and revoke; only owner can change
 * roles or remove members. All gating is also enforced server-side.
 */

import { useEffect, useId, useState } from 'react';
import { Loader2, UserPlus, Trash2, Mail, AtSign, Copy, Check } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useI18n } from '@/contexts/i18n-context';
import { imFetch } from '../../lib/im-api';

type WorkspaceRole = 'owner' | 'admin' | 'member';
type InviteRole = 'admin' | 'member';
type InviteStatus = 'pending' | 'accepted' | 'rejected' | 'revoked' | 'expired';

interface MemberRow {
  id: string;
  workspaceId: string;
  memberImUserId: string;
  role: WorkspaceRole;
  joinedAt: string;
}

interface InviteRow {
  id: string;
  workspaceId: string;
  inviterUserId: string;
  token: string;
  inviteeEmail: string | null;
  inviteeImUserId: string | null;
  role: InviteRole;
  status: InviteStatus;
  expiresAt: string;
  acceptedByUserId: string | null;
  acceptedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function MembersSection({
  workspaceId,
  isOwner,
  meImUserId,
  isDark,
}: {
  workspaceId: string;
  isOwner: boolean;
  meImUserId: string | null;
  isDark: boolean;
}) {
  const { t } = useI18n();
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(true);
  const [loadingInvites, setLoadingInvites] = useState(true);
  const [showInviteDialog, setShowInviteDialog] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // AlertDialog state for destructive ops — replaces window.confirm()
  // (which the Wave-8 W4 audit specifically called out as a UX regression).
  const [pendingRemoveMember, setPendingRemoveMember] = useState<MemberRow | null>(null);
  const [pendingRevokeInvite, setPendingRevokeInvite] = useState<InviteRow | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [revokeBusy, setRevokeBusy] = useState(false);

  const myMember = members.find((m) => m.memberImUserId === meImUserId);
  // owner/admin can mint; only owner can change/remove (mirrors server invariants)
  const isOwnerOrAdmin = isOwner || myMember?.role === 'admin';

  const textPrimary = isDark ? 'text-zinc-100' : 'text-zinc-900';
  const textMuted = isDark ? 'text-zinc-400' : 'text-zinc-600';
  const borderColor = isDark ? 'border-zinc-800' : 'border-zinc-200';
  const surface = isDark ? 'bg-zinc-900' : 'bg-white';

  async function loadMembers() {
    setLoadingMembers(true);
    const res = await imFetch<MemberRow[]>(`/workspaces/${encodeURIComponent(workspaceId)}/members`);
    if (res.ok) setMembers(res.data);
    setLoadingMembers(false);
  }
  async function loadInvites() {
    if (!isOwnerOrAdmin) {
      setLoadingInvites(false);
      return;
    }
    setLoadingInvites(true);
    const res = await imFetch<InviteRow[]>(`/workspaces/${encodeURIComponent(workspaceId)}/invites`);
    if (res.ok) setInvites(res.data);
    setLoadingInvites(false);
  }

  useEffect(() => {
    loadMembers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  useEffect(() => {
    loadInvites();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, isOwnerOrAdmin]);

  async function changeRole(memberId: string, role: 'admin' | 'member') {
    setActionError(null);
    const res = await imFetch(
      `/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(memberId)}`,
      { method: 'PATCH', body: JSON.stringify({ role }) },
    );
    if (!res.ok) setActionError(res.message);
    await loadMembers();
  }

  async function confirmRemoveMember() {
    if (!pendingRemoveMember) return;
    setRemoveBusy(true);
    setActionError(null);
    const res = await imFetch(
      `/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(pendingRemoveMember.id)}`,
      { method: 'DELETE' },
    );
    setRemoveBusy(false);
    if (!res.ok) setActionError(res.message);
    setPendingRemoveMember(null);
    await loadMembers();
  }

  async function confirmRevokeInvite() {
    if (!pendingRevokeInvite) return;
    setRevokeBusy(true);
    setActionError(null);
    const res = await imFetch(
      `/workspaces/${encodeURIComponent(workspaceId)}/invites/${encodeURIComponent(pendingRevokeInvite.id)}`,
      { method: 'DELETE' },
    );
    setRevokeBusy(false);
    if (!res.ok) setActionError(res.message);
    setPendingRevokeInvite(null);
    await loadInvites();
  }

  const pendingInviteCount = invites.filter((i) => i.status === 'pending').length;

  return (
    <section className={`rounded-lg border ${borderColor} ${surface} overflow-hidden`}>
      <div className={`flex items-center justify-between px-4 py-3 border-b ${borderColor}`}>
        <div>
          <h2 className={`text-sm font-semibold ${textPrimary}`}>{t('wsSettings.people.title')}</h2>
          <p className={`text-xs ${textMuted}`}>{t('wsSettings.people.subtitle')}</p>
        </div>
        {isOwnerOrAdmin ? (
          <Button size="sm" onClick={() => setShowInviteDialog(true)}>
            <UserPlus className="h-3.5 w-3.5" />
            {t('wsSettings.people.invite')}
          </Button>
        ) : null}
      </div>

      {actionError ? (
        <div className="mx-3 mt-3 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-400">
          {actionError}
        </div>
      ) : null}

      <Tabs defaultValue="members" className="p-3">
        <TabsList>
          <TabsTrigger value="members">{t('wsSettings.people.membersTab', { count: members.length })}</TabsTrigger>
          <TabsTrigger value="invites" disabled={!isOwnerOrAdmin}>
            {t('wsSettings.people.invitesTab')}
            {isOwnerOrAdmin ? ` (${pendingInviteCount})` : ''}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="members">
          {loadingMembers ? (
            <Spinner muted={textMuted} />
          ) : (
            <MemberList
              members={members}
              isOwner={isOwner}
              meImUserId={meImUserId}
              onRoleChange={changeRole}
              onRemoveRequest={setPendingRemoveMember}
              isDark={isDark}
            />
          )}
        </TabsContent>

        <TabsContent value="invites">
          {loadingInvites ? (
            <Spinner muted={textMuted} />
          ) : isOwnerOrAdmin ? (
            <InviteList invites={invites} onRevokeRequest={setPendingRevokeInvite} isDark={isDark} />
          ) : (
            <p className={`text-xs ${textMuted}`}>{t('wsSettings.people.onlyOwnersInvites')}</p>
          )}
        </TabsContent>
      </Tabs>

      {showInviteDialog ? (
        <InviteCreateDialog
          workspaceId={workspaceId}
          isDark={isDark}
          onOpenChange={(open) => setShowInviteDialog(open)}
          onCreated={() => {
            setShowInviteDialog(false);
            loadInvites();
          }}
        />
      ) : null}

      <AlertDialog open={!!pendingRemoveMember} onOpenChange={(open) => !open && setPendingRemoveMember(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('wsSettings.people.removeMemberTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('wsSettings.people.removeMemberDesc')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removeBusy}>{t('wsSettings.people.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                // Keep the dialog open while the request is in flight so the
                // user sees the spinner; we manage close via setPending* on
                // completion. Radix closes by default on click — preventDefault
                // and close from confirm fn.
                e.preventDefault();
                void confirmRemoveMember();
              }}
              disabled={removeBusy}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {removeBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {t('wsSettings.people.remove')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!pendingRevokeInvite} onOpenChange={(open) => !open && setPendingRevokeInvite(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('wsSettings.people.revokeInviteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('wsSettings.people.revokeInviteDesc')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revokeBusy}>{t('wsSettings.people.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void confirmRevokeInvite();
              }}
              disabled={revokeBusy}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {revokeBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {t('wsSettings.people.revoke')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function Spinner({ muted }: { muted: string }) {
  const { t } = useI18n();
  return (
    <div className={`flex items-center gap-2 text-xs ${muted}`}>
      <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t('wsSettings.people.loading')}
    </div>
  );
}

function MemberList({
  members,
  isOwner,
  meImUserId,
  onRoleChange,
  onRemoveRequest,
  isDark,
}: {
  members: MemberRow[];
  isOwner: boolean;
  meImUserId: string | null;
  onRoleChange: (memberId: string, role: 'admin' | 'member') => void;
  onRemoveRequest: (m: MemberRow) => void;
  isDark: boolean;
}) {
  const { t } = useI18n();
  const textPrimary = isDark ? 'text-zinc-100' : 'text-zinc-900';
  const textMuted = isDark ? 'text-zinc-400' : 'text-zinc-500';
  const row = isDark ? 'border-zinc-800' : 'border-zinc-200';
  const select = isDark ? 'bg-zinc-950 border-zinc-800 text-zinc-100' : 'bg-white border-zinc-300 text-zinc-900';

  return (
    <ul className="space-y-1 mt-2">
      {members.map((m) => {
        const isSelf = m.memberImUserId === meImUserId;
        const isOwnerRow = m.role === 'owner';
        return (
          <li key={m.id} className={`flex items-center justify-between gap-2 rounded border ${row} px-3 py-2`}>
            <div className="flex-1 min-w-0">
              <div className={`text-xs font-mono ${textPrimary} truncate`}>{m.memberImUserId}</div>
              <div className={`text-[11px] ${textMuted}`}>
                {t('wsSettings.people.joined', { date: new Date(m.joinedAt).toLocaleDateString() })}
              </div>
            </div>
            <RoleBadge role={m.role} />
            {isOwner && !isOwnerRow && !isSelf ? (
              <>
                <select
                  value={m.role}
                  onChange={(e) => onRoleChange(m.id, e.target.value as 'admin' | 'member')}
                  className={`rounded border text-xs px-1 py-0.5 ${select}`}
                >
                  <option value="admin">{t('wsSettings.people.roleAdmin')}</option>
                  <option value="member">{t('wsSettings.people.roleMember')}</option>
                </select>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => onRemoveRequest(m)}
                  aria-label={t('wsSettings.people.removeMember')}
                  className="text-red-500 hover:text-red-600"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function RoleBadge({ role }: { role: WorkspaceRole }) {
  // shadcn Badge variant map. owner / admin lean on visual hierarchy that
  // matches our other status chips elsewhere in workspace; 'member' stays
  // secondary to avoid noise on the most common row.
  const variant: 'default' | 'secondary' | 'destructive' | 'outline' =
    role === 'owner' ? 'default' : role === 'admin' ? 'outline' : 'secondary';
  return (
    <Badge variant={variant} className="font-mono text-[10px]">
      {role}
    </Badge>
  );
}

function InviteList({
  invites,
  onRevokeRequest,
  isDark,
}: {
  invites: InviteRow[];
  onRevokeRequest: (i: InviteRow) => void;
  isDark: boolean;
}) {
  const { t } = useI18n();
  const textPrimary = isDark ? 'text-zinc-100' : 'text-zinc-900';
  const textMuted = isDark ? 'text-zinc-400' : 'text-zinc-500';
  const row = isDark ? 'border-zinc-800' : 'border-zinc-200';

  if (invites.length === 0) {
    return <p className={`text-xs ${textMuted} mt-2`}>{t('wsSettings.people.noInvites')}</p>;
  }

  return (
    <ul className="space-y-1 mt-2">
      {invites.map((inv) => (
        <li key={inv.id} className={`flex items-center justify-between gap-2 rounded border ${row} px-3 py-2`}>
          <div className="flex-1 min-w-0">
            <div className={`flex items-center gap-1.5 text-xs ${textPrimary}`}>
              {inv.inviteeEmail ? <Mail className="h-3 w-3" /> : <AtSign className="h-3 w-3" />}
              <span className="truncate font-mono">{inv.inviteeEmail ?? inv.inviteeImUserId}</span>
            </div>
            <div className={`text-[11px] ${textMuted}`}>
              <span>{t('wsSettings.people.inviteRole', { role: inv.role })}</span> ·{' '}
              <span>{t('wsSettings.people.inviteExpires', { date: new Date(inv.expiresAt).toLocaleDateString() })}</span>
            </div>
          </div>
          <InviteStatusBadge status={inv.status} />
          {inv.status === 'pending' ? <CopyLinkButton token={inv.token} /> : null}
          {inv.status === 'pending' ? (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => onRevokeRequest(inv)}
              aria-label={t('wsSettings.people.revokeInviteAria')}
              className="text-red-500 hover:text-red-600"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function InviteStatusBadge({ status }: { status: InviteStatus }) {
  const variant: 'default' | 'secondary' | 'destructive' | 'outline' =
    status === 'accepted'
      ? 'default'
      : status === 'pending'
        ? 'outline'
        : status === 'rejected'
          ? 'destructive'
          : 'secondary';
  return (
    <Badge variant={variant} className="font-mono text-[10px]">
      {status}
    </Badge>
  );
}

function CopyLinkButton({ token }: { token: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  function copy() {
    if (typeof window === 'undefined') return;
    const url = `${window.location.origin}/invite/${token}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }
  return (
    <Button variant="ghost" size="xs" onClick={copy} aria-label={t('wsSettings.people.copyInviteAria')}>
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
    </Button>
  );
}

function InviteCreateDialog({
  workspaceId,
  isDark,
  onOpenChange,
  onCreated,
}: {
  workspaceId: string;
  isDark: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState<'email' | 'imuser'>('email');
  const [email, setEmail] = useState('');
  const [imUserId, setImUserId] = useState('');
  const [role, setRole] = useState<InviteRole>('member');
  const [days, setDays] = useState(7);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const emailId = useId();
  const imUserIdId = useId();
  const roleId = useId();
  const daysId = useId();

  const textMuted = isDark ? 'text-zinc-400' : 'text-zinc-600';
  const input = isDark
    ? 'bg-zinc-900 border-white/10 text-zinc-100 focus:ring-violet-500/40'
    : 'bg-white border-zinc-300 text-zinc-900 focus:ring-violet-400';
  const inputClass = `w-full rounded-md border px-3 py-1.5 text-sm outline-none focus:ring-1 ${input}`;

  async function submit() {
    setError(null);
    setSubmitting(true);
    const body: Record<string, unknown> = { role, expiresInDays: days };
    if (mode === 'email') body.inviteeEmail = email.trim();
    else body.inviteeImUserId = imUserId.trim();
    const res = await imFetch(`/workspaces/${encodeURIComponent(workspaceId)}/invites`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    setSubmitting(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    onCreated();
  }

  const canSubmit = !submitting && (mode === 'email' ? !!email.trim() : !!imUserId.trim()) && days >= 1 && days <= 30;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('wsSettings.people.inviteTitle')}</DialogTitle>
        </DialogHeader>
        <Tabs value={mode} onValueChange={(v) => setMode(v as 'email' | 'imuser')}>
          <TabsList>
            <TabsTrigger value="email">{t('wsSettings.people.inviteEmailTab')}</TabsTrigger>
            <TabsTrigger value="imuser">{t('wsSettings.people.inviteUserTab')}</TabsTrigger>
          </TabsList>
          <TabsContent value="email" className="space-y-2">
            <label htmlFor={emailId} className={`text-xs ${textMuted}`}>
              {t('wsSettings.people.emailLabel')}
            </label>
            <input
              id={emailId}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t('wsSettings.people.emailPlaceholder')}
              className={`${inputClass} font-mono`}
              autoFocus
            />
          </TabsContent>
          <TabsContent value="imuser" className="space-y-2">
            <label htmlFor={imUserIdId} className={`text-xs ${textMuted}`}>
              {t('wsSettings.people.imUserIdLabel')}
            </label>
            <input
              id={imUserIdId}
              type="text"
              value={imUserId}
              onChange={(e) => setImUserId(e.target.value)}
              placeholder={t('wsSettings.people.imUserIdPlaceholder')}
              className={`${inputClass} font-mono`}
              autoFocus
            />
          </TabsContent>
        </Tabs>

        <div className="grid grid-cols-2 gap-2">
          <label htmlFor={roleId} className="space-y-1 block">
            <span className={`text-[11px] ${textMuted}`}>{t('wsSettings.people.roleLabel')}</span>
            <select
              id={roleId}
              value={role}
              onChange={(e) => setRole(e.target.value as InviteRole)}
              className={inputClass}
            >
              <option value="member">{t('wsSettings.people.roleMember')}</option>
              <option value="admin">{t('wsSettings.people.roleAdmin')}</option>
            </select>
          </label>
          <label htmlFor={daysId} className="space-y-1 block">
            <span className={`text-[11px] ${textMuted}`}>{t('wsSettings.people.expiresLabel')}</span>
            <input
              id={daysId}
              type="number"
              min={1}
              max={30}
              value={days}
              onChange={(e) => setDays(Math.max(1, Math.min(30, parseInt(e.target.value, 10) || 7)))}
              className={inputClass}
            />
          </label>
        </div>

        {error ? (
          <p className={`text-xs ${isDark ? 'text-red-300' : 'text-red-600'}`} role="alert">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t('wsSettings.people.cancel')}
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {submitting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
            ) : (
              <UserPlus className="h-3.5 w-3.5 mr-1" />
            )}
            {t('wsSettings.people.sendInvite')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
