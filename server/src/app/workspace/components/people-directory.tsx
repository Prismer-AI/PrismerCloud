'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import QRCode from 'qrcode';
import { Check, Copy, Loader2, MessageCircle, MoreHorizontal, QrCode, Search, Send, UserPlus, Users, X } from 'lucide-react';

import { copyText } from '@/lib/clipboard';
import { cn } from '@/lib/utils';
import type { AgentLiveStatus } from '../lib/agent-status';
import { avatarGradient, avatarInitials } from '../lib/design';
import { imFetch } from '../lib/im-api';
import type { AgentDTO, ContactFriendDTO, ContactRequestDTO, UserProfileDTO } from '../lib/types';
import { AgentAvatar } from './agent-avatar';
import { LayoutToggle } from './card-shelf';
import { ProfileCardShelf, type ProfileCardRecord, type ProfileLayoutMode } from './profile-card';
import { SurfaceHeader } from './surface-header';
import { useI18n } from '@/contexts/i18n-context';

type PeopleDirectoryTab = 'people' | 'requests' | 'add' | 'qr';

export interface PeopleDirectoryPerson {
  id: string;
  kind?: 'human' | 'agent';
  name: string;
  username?: string | null;
  handle?: string | null;
  avatarSeed?: string;
  subtitle?: string;
  description?: string | null;
  badges?: string[];
  statusText?: string;
  statusTone?: ProfileCardRecord['statusTone'];
  agentRoleSlug?: string | null;
  liveStatus?: AgentLiveStatus | null;
  remark?: string | null;
  source?: ContactFriendDTO | AgentDTO | null;
}

export interface PeopleDirectoryLookupResult {
  id: string;
  username: string;
  displayName: string;
  role?: string;
  agentType?: string | null;
  avatarUrl?: string | null;
}

export interface PeopleDirectoryProps {
  isDark: boolean;
  me: UserProfileDTO | null;
  friends: ContactFriendDTO[];
  agents?: AgentDTO[];
  agentStatuses?: Map<string, AgentLiveStatus>;
  receivedRequests: ContactRequestDTO[];
  sentRequests: ContactRequestDTO[];
  prefillUserId?: string | null;
  onReload?: () => Promise<void>;
  onOpenSession?: (conversationId: string) => void | Promise<void>;
  onStartChat?: (userId: string) => Promise<void>;
  onOpenAgentProfile?: (agentId: string) => void;
  onRemoveAgent?: (agent: AgentDTO) => Promise<void>;
  notify: (message: string, type: 'success' | 'error' | 'info') => void;
  people?: PeopleDirectoryPerson[];
  initialTab?: PeopleDirectoryTab;
  compact?: boolean;
  title?: string;
  subtitle?: string;
  className?: string;
  inviteUrl?: string;
  qrDataUrl?: string | null;
  prefillIdentifier?: string | null;
  onStartDirectChat?: (userId: string, person: PeopleDirectoryPerson) => void | Promise<void>;
  onOpenProfile?: (person: PeopleDirectoryPerson) => void;
  onCopyHandle?: (handle: string, person: PeopleDirectoryPerson) => void | Promise<void>;
  onOpenRequests?: () => void;
  onOpenAddFriend?: () => void;
  onOpenQr?: () => void;
  onLookupUser?: (identifier: string) => Promise<PeopleDirectoryLookupResult | null>;
  onSendFriendRequest?: (userId: string, reason?: string) => Promise<void> | void;
  onAcceptRequest?: (requestId: string) => Promise<void> | void;
  onRejectRequest?: (requestId: string) => Promise<void> | void;
  onCancelRequest?: (requestId: string) => Promise<void> | void;
}

type WorkspaceT = ReturnType<typeof useI18n>['t'];

export function PeopleDirectory({
  isDark,
  me,
  people,
  friends,
  agents = [],
  agentStatuses,
  receivedRequests,
  sentRequests,
  prefillUserId,
  onReload,
  onOpenSession,
  onStartChat,
  onOpenAgentProfile,
  onRemoveAgent,
  notify,
  initialTab = 'people',
  compact = false,
  title,
  subtitle,
  className,
  inviteUrl: inviteUrlProp,
  qrDataUrl: qrDataUrlProp,
  prefillIdentifier,
  onStartDirectChat,
  onOpenProfile,
  onCopyHandle,
  onOpenRequests,
  onOpenAddFriend,
  onOpenQr,
  onLookupUser,
  onSendFriendRequest,
  onAcceptRequest,
  onRejectRequest,
  onCancelRequest,
}: PeopleDirectoryProps) {
  const { t } = useI18n();
  const resolvedTitle = title ?? t('workspace.people.contactsTab');
  const resolvedSubtitle = subtitle ?? t('workspace.people.defaultSubtitle');
  const [tab, setTab] = useState<PeopleDirectoryTab>(initialTab);
  const [layout, setLayout] = useState<ProfileLayoutMode>('list');
  const [identifier, setIdentifier] = useState(prefillIdentifier ?? prefillUserId ?? '');
  const [reason, setReason] = useState('');
  const [lookupResult, setLookupResult] = useState<PeopleDirectoryLookupResult | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [submitLoading, setSubmitLoading] = useState(false);
  const [busyRequestId, setBusyRequestId] = useState<string | null>(null);
  const [generatedQrDataUrl, setGeneratedQrDataUrl] = useState<string | null>(null);

  const inviteUrl = useMemo(() => {
    if (inviteUrlProp) return inviteUrlProp;
    if (!me) return '';
    if (typeof window === 'undefined') return `prismer://contact?userId=${encodeURIComponent(me.id)}`;
    const url = new URL('/workspace', window.location.origin);
    url.searchParams.set('addContact', me.id);
    return url.toString();
  }, [inviteUrlProp, me]);

  useEffect(() => {
    const next = prefillIdentifier ?? prefillUserId;
    if (!next) return;
    setIdentifier(next);
    setTab('add');
  }, [prefillIdentifier, prefillUserId]);

  useEffect(() => {
    if (!prefillUserId) return;
    let cancelled = false;
    setLookupLoading(true);
    imFetch<PeopleDirectoryLookupResult>(`/users/${encodeURIComponent(prefillUserId)}`).then((res) => {
      if (cancelled) return;
      setLookupLoading(false);
      if (!res.ok) {
        notify(t('workspace.people.contactLinkInvalid', { message: res.message }), 'error');
        return;
      }
      setLookupResult(res.data);
      setIdentifier(res.data.username);
    });
    return () => {
      cancelled = true;
    };
  }, [prefillUserId, notify, t]);

  useEffect(() => {
    if (!inviteUrl || qrDataUrlProp !== undefined) return;
    let cancelled = false;
    QRCode.toDataURL(inviteUrl, { margin: 1, width: 224, color: { dark: '#111827', light: '#ffffff' } })
      .then((url) => {
        if (!cancelled) setGeneratedQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setGeneratedQrDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [inviteUrl, qrDataUrlProp]);

  const directoryPeople = useMemo(
    () => people ?? buildPeopleFromContacts({ friends, agents, agentStatuses, t }),
    [agentStatuses, agents, friends, people, t],
  );

  const qrDataUrl = qrDataUrlProp ?? generatedQrDataUrl;
  const panelClass = isDark ? 'border-white/[0.06] bg-zinc-950/25' : 'border-zinc-200 bg-white/70';
  const muted = isDark ? 'text-zinc-500' : 'text-zinc-500';

  function selectTab(next: PeopleDirectoryTab) {
    setTab(next);
    if (next === 'requests') onOpenRequests?.();
    if (next === 'add') onOpenAddFriend?.();
    if (next === 'qr') onOpenQr?.();
  }

  async function copyHandle(handle: string) {
    const res = await copyText(handle);
    if (!res.ok) {
      notify(res.error ?? t('workspace.people.copyFailed'), 'error');
      return;
    }
    notify(t('workspace.people.handleCopied', { handle }), 'success');
  }

  async function copyInvite() {
    if (!inviteUrl) return;
    const res = await copyText(inviteUrl);
    if (!res.ok) {
      notify(res.error ?? t('workspace.people.copyFailed'), 'error');
      return;
    }
    notify(t('workspace.people.contactLinkCopied'), 'success');
  }

  async function lookup() {
    const typed = identifier.trim();
    if (!typed || lookupLoading) return;
    setLookupLoading(true);
    setLookupResult(null);
    try {
      const result = onLookupUser ? await onLookupUser(typed) : await lookupUserByIdentifier(typed);
      setLookupResult(result);
      if (!result) notify(t('workspace.people.noUserMatches', { query: typed }), 'info');
    } catch (err) {
      notify(err instanceof Error ? err.message : t('workspace.people.lookupFailed'), 'error');
    } finally {
      setLookupLoading(false);
    }
  }

  async function sendRequest(userId = lookupResult?.id) {
    if (!userId || submitLoading) return;
    setSubmitLoading(true);
    try {
      if (onSendFriendRequest) {
        await onSendFriendRequest(userId, reason.trim() || undefined);
      } else {
        await sendFriendRequest(userId, reason.trim() || undefined, prefillUserId === userId);
      }
      setReason('');
      notify(t('workspace.people.friendRequestSent'), 'success');
      await onReload?.();
    } catch (err) {
      notify(err instanceof Error ? err.message : t('workspace.people.friendRequestFailed'), 'error');
    } finally {
      setSubmitLoading(false);
    }
  }

  async function runRequestAction(requestId: string, action?: (requestId: string) => Promise<void> | void) {
    if (busyRequestId) return;
    setBusyRequestId(requestId);
    try {
      await action?.(requestId);
      await onReload?.();
    } catch (err) {
      notify(err instanceof Error ? err.message : t('workspace.people.requestActionFailed'), 'error');
    } finally {
      setBusyRequestId(null);
    }
  }

  async function acceptRequest(requestId: string) {
    if (onAcceptRequest) {
      await onAcceptRequest(requestId);
      return;
    }
    const res = await imFetch<{ conversationId?: string }>(
      `/contacts/requests/${encodeURIComponent(requestId)}/accept`,
      {
        method: 'POST',
      },
    );
    if (!res.ok) throw new Error(res.message);
    notify(t('workspace.people.friendRequestAccepted'), 'success');
    if (res.data?.conversationId) {
      await onOpenSession?.(res.data.conversationId);
    } else {
      notify(t('workspace.people.friendAddedButChatCouldNotOpen'), 'info');
    }
  }

  async function rejectRequest(requestId: string) {
    if (onRejectRequest) {
      await onRejectRequest(requestId);
      return;
    }
    const res = await imFetch(`/contacts/requests/${encodeURIComponent(requestId)}/reject`, { method: 'POST' });
    if (!res.ok) throw new Error(res.message);
    notify(t('workspace.people.friendRequestRejected'), 'success');
  }

  async function cancelRequest(requestId: string) {
    if (onCancelRequest) {
      await onCancelRequest(requestId);
      return;
    }
    const res = await imFetch(`/contacts/requests/${encodeURIComponent(requestId)}/cancel`, { method: 'DELETE' });
    if (!res.ok) throw new Error(res.message);
    notify(t('workspace.people.friendRequestWithdrawn'), 'success');
  }

  async function startDirectChat(person: PeopleDirectoryPerson) {
    if (onStartDirectChat) {
      await onStartDirectChat(person.id, person);
      return;
    }
    await onStartChat?.(person.id);
  }

  const profileCards: ProfileCardRecord[] = directoryPeople.map((person) => {
    const handle = person.handle ?? (person.username ? `@${person.username}` : '');
    return {
      id: person.id,
      kind: person.kind ?? 'human',
      name: person.name,
      handle,
      avatarSeed: person.avatarSeed ?? person.id,
      subtitle: person.subtitle,
      description: person.description ?? undefined,
      badges: person.badges,
      statusText: person.statusText,
      statusTone: person.statusTone,
      agentRoleSlug: person.agentRoleSlug,
      liveStatus: person.liveStatus,
      remark: person.remark,
      onPrimaryAction: () => void startDirectChat(person),
      onChat: () => void startDirectChat(person),
      onOpenProfile: buildOpenProfileHandler(person, onOpenProfile, onOpenAgentProfile),
      onCopyHandle: handle
        ? () => {
            if (onCopyHandle) {
              void onCopyHandle(handle, person);
              return;
            }
            void copyHandle(handle);
          }
        : undefined,
      onRemove: buildRemoveHandler(person, agents, onRemoveAgent, onReload, notify, t),
    };
  });

  const tabItems = [
    {
      key: 'people',
      label: t('workspace.people.contactsTab'),
      shortLabel: t('workspace.people.allShort'),
      icon: Users,
    },
    {
      key: 'requests',
      label: receivedRequests.length
        ? t('workspace.people.requestsWithCount', { count: receivedRequests.length })
        : t('workspace.people.requests'),
      shortLabel: receivedRequests.length
        ? t('workspace.people.requestsShortWithCount', { count: receivedRequests.length })
        : t('workspace.people.requestsShort'),
      icon: Check,
    },
    { key: 'add', label: t('workspace.people.addTab'), shortLabel: t('workspace.people.addShort'), icon: UserPlus },
    { key: 'qr', label: t('workspace.people.qrTab'), shortLabel: t('workspace.people.qrShort'), icon: QrCode },
  ] as const;

  const compactActions = compact ? (
    <div className="flex items-center gap-1.5">
      <PeopleDirectoryActionButton
        isDark={isDark}
        active={tab === 'people'}
        label={tabItems[0].label}
        icon={<Users className="h-3.5 w-3.5" />}
        onClick={() => selectTab('people')}
        iconOnly
      />
      <PeopleDirectoryActionButton
        isDark={isDark}
        active={tab === 'requests'}
        label={tabItems[1].label}
        icon={<Check className="h-3.5 w-3.5" />}
        onClick={() => selectTab('requests')}
        iconOnly
      />
      <PeopleDirectoryActionButton
        isDark={isDark}
        active={tab === 'add'}
        label={tabItems[2].label}
        icon={<UserPlus className="h-3.5 w-3.5" />}
        onClick={() => selectTab('add')}
        iconOnly
      />
      <PeopleDirectoryActionButton
        isDark={isDark}
        active={tab === 'qr'}
        label={tabItems[3].label}
        icon={<QrCode className="h-3.5 w-3.5" />}
        onClick={() => selectTab('qr')}
        iconOnly
      />
    </div>
  ) : null;

  const tabList = (dense: boolean) => (
    <div
      className={cn(
        dense ? 'grid grid-cols-4 gap-1' : 'flex rounded-xl border p-1',
        isDark ? 'border-white/[0.06] bg-zinc-900/70' : 'border-zinc-200 bg-zinc-100',
      )}
      role="tablist"
      aria-label={t('workspace.people.directoryViews')}
    >
      {tabItems.map((item) => {
        const Icon = item.icon;
        const active = tab === item.key;
        return (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={active}
            aria-label={item.label}
            title={item.label}
            onClick={() => selectTab(item.key as PeopleDirectoryTab)}
            className={cn(
              'inline-flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-lg px-2 text-xs font-semibold transition-colors',
              active
                ? isDark
                  ? 'bg-white/[0.08] text-zinc-100'
                  : 'bg-white text-zinc-950 shadow-sm'
                : isDark
                  ? 'text-zinc-400 hover:text-zinc-100'
                  : 'text-zinc-600 hover:text-zinc-950',
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="truncate">{dense ? item.shortLabel : item.label}</span>
          </button>
        );
      })}
    </div>
  );

  return (
    <section className={cn('flex min-h-0 flex-1 flex-col', className)} data-testid="people-directory">
      {compact ? (
        <header className={`shrink-0 border-b px-3 py-3 ${isDark ? 'border-white/[0.06]' : 'border-zinc-200/80'}`}>
          <div className="flex min-w-0 items-center gap-2">
            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  'text-[10px] font-bold uppercase tracking-wider',
                  isDark ? 'text-zinc-500' : 'text-zinc-500',
                )}
              >
                {t('workspace.people.directory')}
              </p>
              <h2 className={cn('truncate text-sm font-semibold', isDark ? 'text-zinc-100' : 'text-zinc-950')}>
                {resolvedTitle}
              </h2>
              <p className={cn('mt-0.5 truncate text-[11px]', isDark ? 'text-zinc-500' : 'text-zinc-500')}>
                {t('workspace.people.directoryCount', { contacts: profileCards.length, agents: agents.length })}
              </p>
            </div>
            {tab === 'people' && profileCards.length > 0 ? (
              // 2026-05-30 (A3) — flatten gap to 0 and force `justify-center`
              // so both icons share identical bounding boxes (8×8) with the
              // glyph at the exact centre. Previously `gap-2` + collapsed
              // text label left the icon visually nudged to one side.
              <LayoutToggle
                isDark={isDark}
                layout={layout}
                onChange={setLayout}
                availableLayouts={['list', 'grid']}
                className="[&_button]:h-8 [&_button]:w-8 [&_button]:justify-center [&_button]:gap-0 [&_button]:px-0 [&_button_span]:sr-only"
              />
            ) : null}
          </div>
          <div className="mt-3">{compactActions}</div>
        </header>
      ) : (
        <SurfaceHeader
          isDark={isDark}
          title={resolvedTitle}
          subtitle={resolvedSubtitle}
          actions={
            <>
              {tab === 'people' && profileCards.length > 0 ? (
                <LayoutToggle
                  isDark={isDark}
                  layout={layout}
                  onChange={setLayout}
                  availableLayouts={['list', 'grid']}
                />
              ) : null}
              {tabList(false)}
            </>
          }
        />
      )}

      <div className={cn('min-h-0 flex-1 overflow-y-auto', compact ? 'p-2.5' : 'p-4 sm:p-5')}>
        {tab === 'people' ? (
          profileCards.length > 0 ? (
            compact && layout === 'list' ? (
              // compact + list 模式：用更紧致的 single-row 行；其它情况
              // (含 grid) 走完整 ProfileCardShelf 以便 LayoutToggle 切换、
              // 行内 onRemove overflow menu、和外面非 compact 模式一致的
              // 用户操作面。
              <CompactPeopleList isDark={isDark} profiles={profileCards} />
            ) : (
              <ProfileCardShelf
                isDark={isDark}
                profiles={profileCards}
                layout={layout}
                availableLayouts={['list', 'grid']}
              />
            )
          ) : (
            <PeopleDirectoryEmptyState
              isDark={isDark}
              title={t('workspace.people.noContactsYet')}
              text={t('workspace.people.noContactsHint')}
            />
          )
        ) : null}

        {tab === 'requests' ? (
          <div className={cn('grid gap-4', compact ? '' : 'xl:grid-cols-2')}>
            <PeopleDirectoryRequestColumn
              isDark={isDark}
              title={t('workspace.people.received')}
              empty={t('workspace.people.noIncomingRequests')}
              requests={receivedRequests}
              busyRequestId={busyRequestId}
              mode="received"
              onAccept={(id) => runRequestAction(id, acceptRequest)}
              onReject={(id) => runRequestAction(id, rejectRequest)}
            />
            <PeopleDirectoryRequestColumn
              isDark={isDark}
              title={t('workspace.people.sent')}
              empty={t('workspace.people.noOutgoingRequests')}
              requests={sentRequests}
              busyRequestId={busyRequestId}
              mode="sent"
              onCancel={(id) => runRequestAction(id, cancelRequest)}
            />
          </div>
        ) : null}

        {tab === 'add' ? (
          <div
            className={cn(
              'grid gap-3 rounded-2xl border p-3',
              !compact && 'xl:grid-cols-[minmax(0,420px)_1fr]',
              panelClass,
            )}
          >
            <div>
              <label className="grid gap-1.5">
                <span className={cn('text-xs font-semibold', muted)}>{t('workspace.people.usernameHint')}</span>
                <div
                  className={cn(
                    'flex items-center gap-2 rounded-xl border px-3 py-2',
                    isDark ? 'border-white/[0.08] bg-zinc-950/70' : 'border-zinc-200 bg-white',
                  )}
                >
                  <Search className={cn('h-4 w-4', muted)} />
                  <input
                    value={identifier}
                    onChange={(event) => setIdentifier(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void lookup();
                    }}
                    placeholder={t('workspace.people.searchContacts')}
                    className={cn(
                      'min-w-0 flex-1 bg-transparent text-sm outline-none',
                      isDark ? 'text-zinc-100 placeholder:text-zinc-600' : 'text-zinc-950 placeholder:text-zinc-400',
                    )}
                  />
                  <button
                    type="button"
                    onClick={() => void lookup()}
                    disabled={lookupLoading || !identifier.trim()}
                    aria-label={t('workspace.people.searchContacts')}
                    className={cn(
                      'inline-flex h-8 w-8 items-center justify-center rounded-lg transition-colors disabled:opacity-50',
                      isDark ? 'bg-white/[0.06] text-zinc-200' : 'bg-zinc-100 text-zinc-700',
                    )}
                  >
                    {lookupLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                  </button>
                </div>
              </label>
              <label className="mt-3 grid gap-1.5">
                <span className={cn('text-xs font-semibold', muted)}>{t('workspace.people.reason')}</span>
                {!compact ? (
                  <textarea
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder={t('workspace.people.optionalNote')}
                    rows={4}
                    className={cn(
                      'resize-none rounded-xl border px-3 py-2 text-sm outline-none focus:ring-1',
                      isDark
                        ? 'border-white/[0.08] bg-zinc-950/70 text-zinc-100 placeholder:text-zinc-600 focus:ring-violet-500/40'
                        : 'border-zinc-200 bg-white text-zinc-950 placeholder:text-zinc-400 focus:ring-violet-400',
                    )}
                  />
                ) : null}
              </label>
            </div>

            <div
              className={cn(
                'rounded-2xl border p-3',
                isDark ? 'border-white/[0.06] bg-white/[0.025]' : 'border-zinc-200 bg-white/75',
              )}
            >
              {lookupResult ? (
                <div className="flex h-full flex-col justify-between gap-4">
                  <div>
                    <p className={cn('text-sm font-semibold', isDark ? 'text-zinc-100' : 'text-zinc-950')}>
                      {lookupResult.displayName || lookupResult.username}
                    </p>
                    <p className={cn('mt-1 text-xs', muted)}>@{lookupResult.username}</p>
                    <p className={cn('mt-3 text-xs', isDark ? 'text-zinc-400' : 'text-zinc-600')}>
                      {lookupResult.agentType ?? lookupResult.role ?? t('workspace.people.human')}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void sendRequest()}
                    disabled={submitLoading}
                    aria-label={t('workspace.people.sendFriendRequest')}
                    className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-violet-600 px-4 text-sm font-semibold text-white shadow-sm disabled:opacity-50"
                  >
                    {submitLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                    {t('workspace.people.sendFriendRequest')}
                  </button>
                </div>
              ) : (
                <PeopleDirectoryEmptyState
                  isDark={isDark}
                  title={t('workspace.people.findSomeone')}
                  text={t('workspace.people.findSomeoneHint')}
                  compact
                />
              )}
            </div>
          </div>
        ) : null}

        {tab === 'qr' ? (
          <div className={cn('grid gap-3 rounded-2xl border p-3', !compact && 'xl:grid-cols-[280px_1fr]', panelClass)}>
            <div
              className={cn(
                'grid place-items-center rounded-2xl border p-3',
                isDark ? 'border-white/[0.06] bg-white' : 'border-zinc-200 bg-white',
              )}
            >
              {qrDataUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={qrDataUrl}
                  alt={t('workspace.people.contactQrCode')}
                  className={compact ? 'h-44 w-44' : 'h-56 w-56'}
                />
              ) : (
                <QrCode
                  className="h-16 w-16 text-zinc-400"
                  aria-label={t('workspace.people.contactQrCodeUnavailable')}
                />
              )}
            </div>
            <div className="flex min-w-0 flex-col justify-between gap-4">
              <div>
                <h3 className={cn('text-sm font-semibold', isDark ? 'text-zinc-100' : 'text-zinc-950')}>
                  {t('workspace.people.shareContactLink')}
                </h3>
                <p className={cn('mt-2 text-sm leading-relaxed', isDark ? 'text-zinc-400' : 'text-zinc-600')}>
                  {t('workspace.people.shareContactLinkHint')}
                </p>
                {inviteUrl ? (
                  <p className={cn('mt-4 break-all rounded-xl border px-3 py-2 text-xs', panelClass)}>{inviteUrl}</p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => void copyInvite()}
                disabled={!inviteUrl}
                aria-label={t('workspace.people.copyLink')}
                className={cn(
                  'inline-flex h-10 items-center justify-center gap-2 rounded-xl border px-4 text-sm font-semibold transition-colors disabled:opacity-50',
                  compact ? 'w-full' : 'w-fit',
                  isDark
                    ? 'border-white/[0.08] bg-white/[0.04] text-zinc-100 hover:bg-white/[0.08]'
                    : 'border-zinc-200 bg-white text-zinc-800 hover:bg-zinc-50',
                )}
              >
                <Copy className="h-4 w-4" />
                {t('workspace.people.copyLink')}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function buildPeopleFromContacts({
  friends,
  agents,
  agentStatuses,
  t,
}: {
  friends: ContactFriendDTO[];
  agents: AgentDTO[];
  agentStatuses?: Map<string, AgentLiveStatus>;
  t: WorkspaceT;
}): PeopleDirectoryPerson[] {
  const map = new Map<string, PeopleDirectoryPerson>();

  for (const friend of friends) {
    const lastSeen = friend.lastSeenAt
      ? t('workspace.people.lastSeen', { date: new Date(friend.lastSeenAt).toLocaleDateString() })
      : null;
    map.set(friend.userId, {
      id: friend.userId,
      kind: friend.isAgent ? 'agent' : 'human',
      name: friend.remark || friend.displayName || friend.username,
      username: friend.username,
      avatarSeed: friend.userId,
      subtitle: friend.isAgent ? t('workspace.people.agentContact') : t('workspace.people.humanContact'),
      description: lastSeen,
      badges: [friend.isAgent ? t('workspace.people.contactAgent') : t('workspace.people.contact')],
      statusText: t('workspace.people.friend'),
      statusTone: friend.isAgent ? 'violet' : 'cyan',
      remark: friend.remark,
      source: friend,
    });
  }

  for (const agent of agents) {
    const existing = map.get(agent.userId);
    const presence = agent.presence?.status || agent.status || 'registered';
    const liveStatus = agentStatuses?.get(agent.userId) ?? null;
    map.set(agent.userId, {
      id: agent.userId,
      kind: 'agent',
      name: existing?.name || agent.name,
      username: agent.username ?? agent.name,
      avatarSeed: agent.userId,
      subtitle: agent.agentType || t('workspace.people.workspaceAgent'),
      description:
        agent.capabilities && agent.capabilities.length > 0
          ? agent.capabilities.slice(0, 4).join(' · ')
          : agent.description || existing?.description || t('workspace.people.activatedWorkspaceAgent'),
      badges: Array.from(
        new Set([
          ...(existing?.badges ?? []),
          t('workspace.people.activated'),
          agent.agentType || t('workspace.people.agent'),
        ]),
      ),
      statusText: liveStatus?.kind ?? presence,
      statusTone:
        presence === 'online' ? 'emerald' : presence === 'busy' ? 'amber' : presence === 'offline' ? 'slate' : 'violet',
      agentRoleSlug: agent.agentType,
      liveStatus,
      remark: existing?.remark ?? null,
      source: agent,
    });
  }

  return Array.from(map.values()).sort((a, b) => {
    if ((a.kind ?? 'human') !== (b.kind ?? 'human')) return a.kind === 'agent' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

async function lookupUserByIdentifier(identifier: string): Promise<PeopleDirectoryLookupResult | null> {
  const res = await imFetch<PeopleDirectoryLookupResult>(
    `/users/lookup?identifier=${encodeURIComponent(identifier)}&humanOnly=true`,
  );
  if (!res.ok) {
    if (/not found|no user/i.test(res.message)) return null;
    throw new Error(res.message);
  }
  return res.data;
}

async function sendFriendRequest(userId: string, reason: string | undefined, fromQr: boolean) {
  const res = await imFetch<ContactRequestDTO>('/contacts/request', {
    method: 'POST',
    body: JSON.stringify({
      userId,
      reason,
      source: fromQr ? 'workspace_qr' : 'workspace_people_directory',
    }),
  });
  if (!res.ok) throw new Error(res.message);
}

function buildOpenProfileHandler(
  person: PeopleDirectoryPerson,
  onOpenProfile: PeopleDirectoryProps['onOpenProfile'],
  onOpenAgentProfile: PeopleDirectoryProps['onOpenAgentProfile'],
) {
  if (onOpenProfile) return () => onOpenProfile(person);
  if (person.kind !== 'agent' || !onOpenAgentProfile) return undefined;
  const source = person.source;
  if (source && 'agentId' in source) return () => onOpenAgentProfile(source.agentId);
  return undefined;
}

function buildRemoveHandler(
  person: PeopleDirectoryPerson,
  agents: AgentDTO[],
  onRemoveAgent: PeopleDirectoryProps['onRemoveAgent'],
  onReload: PeopleDirectoryProps['onReload'],
  notify: PeopleDirectoryProps['notify'],
  t: WorkspaceT,
) {
  // 2026-05-30 (A3) — friend (human) removal is now wired through the
  // standard `/contacts/:id/remove` endpoint so the overflow-menu "Remove"
  // entry in ProfileCard is actionable for human contacts too, not just
  // agents. The same one-intent-one-affordance principle (memory:
  // feedback_one_intent_one_affordance) — Remove must be a visible
  // actionable in chats context, not gated behind a separate Friends tab.
  if (person.kind === 'agent') {
    if (!onRemoveAgent) return undefined;
    const agent =
      (person.source && 'agentId' in person.source ? person.source : null) ??
      agents.find((item) => item.userId === person.id);
    if (!agent) return undefined;
    return () => {
      void onRemoveAgent(agent)
        .then(async () => {
          notify(t('workspace.people.agentRemoved'), 'success');
          await onReload?.();
        })
        .catch((err) => notify(err instanceof Error ? err.message : t('workspace.people.agentRemovalFailed'), 'error'));
    };
  }
  // Human contact — call DELETE /contacts/:id/remove directly. Confirmation
  // happens via window.confirm; the menu item is already labelled "Remove"
  // and styled as `danger` in ProfileCard.
  return () => {
    if (typeof window !== 'undefined' && !window.confirm(t('workspace.people.confirmRemoveContact'))) return;
    void (async () => {
      const res = await imFetch(`/contacts/${encodeURIComponent(person.id)}/remove`, { method: 'DELETE' });
      if (!res.ok) {
        notify(res.message, 'error');
        return;
      }
      notify(t('workspace.people.contactRemoved'), 'success');
      await onReload?.();
    })();
  };
}

function PeopleDirectoryRequestColumn({
  isDark,
  title,
  empty,
  requests,
  busyRequestId,
  mode,
  onAccept,
  onReject,
  onCancel,
}: {
  isDark: boolean;
  title: string;
  empty: string;
  requests: ContactRequestDTO[];
  busyRequestId: string | null;
  mode: 'received' | 'sent';
  onAccept?: (requestId: string) => void;
  onReject?: (requestId: string) => void;
  onCancel?: (requestId: string) => void;
}) {
  const { t } = useI18n();
  return (
    <section>
      <h3 className={cn('mb-3 text-sm font-semibold', isDark ? 'text-zinc-200' : 'text-zinc-800')}>{title}</h3>
      <div className="grid gap-3">
        {requests.length === 0 ? (
          <PeopleDirectoryEmptyState
            isDark={isDark}
            title={empty}
            text={t('workspace.people.nothingNeedsAttention')}
            compact
          />
        ) : (
          requests.map((request) => {
            const user = mode === 'received' ? request.fromUser : request.toUser;
            const busy = busyRequestId === request.id;
            return (
              <article
                key={request.id}
                className={cn(
                  'rounded-2xl border p-4',
                  isDark ? 'border-white/[0.06] bg-white/[0.025]' : 'border-zinc-200 bg-white/75',
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className={cn('truncate text-sm font-semibold', isDark ? 'text-zinc-100' : 'text-zinc-900')}>
                      {user?.displayName || user?.username || t('workspace.people.unknownUser')}
                    </p>
                    {user?.username ? <p className="mt-1 truncate text-xs text-zinc-500">@{user.username}</p> : null}
                    {request.reason ? (
                      <p className={cn('mt-3 text-xs leading-relaxed', isDark ? 'text-zinc-400' : 'text-zinc-600')}>
                        {request.reason}
                      </p>
                    ) : null}
                  </div>
                  <span
                    className={cn(
                      'shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-semibold',
                      isDark
                        ? 'border-white/[0.08] bg-white/[0.04] text-zinc-300'
                        : 'border-zinc-200 bg-zinc-50 text-zinc-600',
                    )}
                  >
                    {request.status}
                  </span>
                </div>
                {mode === 'received' ? (
                  <div className="mt-4 flex flex-wrap gap-2">
                    <PeopleDirectoryIconButton
                      isDark={isDark}
                      label={t('workspace.people.acceptRequest')}
                      disabled={busy || !onAccept}
                      onClick={() => onAccept?.(request.id)}
                    >
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                    </PeopleDirectoryIconButton>
                    <PeopleDirectoryIconButton
                      isDark={isDark}
                      label={t('workspace.people.rejectRequest')}
                      disabled={busy || !onReject}
                      onClick={() => onReject?.(request.id)}
                    >
                      <X className="h-4 w-4" />
                    </PeopleDirectoryIconButton>
                  </div>
                ) : (
                  <div className="mt-4">
                    <PeopleDirectoryIconButton
                      isDark={isDark}
                      label={t('workspace.people.cancelRequest')}
                      disabled={busy || !onCancel}
                      onClick={() => onCancel?.(request.id)}
                    >
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
                    </PeopleDirectoryIconButton>
                  </div>
                )}
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}

function PeopleDirectoryIconButton({
  isDark,
  label,
  disabled,
  onClick,
  children,
}: {
  isDark: boolean;
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex h-9 w-9 items-center justify-center rounded-xl border transition-colors disabled:opacity-50',
        isDark
          ? 'border-white/[0.08] bg-white/[0.04] text-zinc-100 hover:bg-white/[0.08]'
          : 'border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50',
      )}
    >
      {children}
    </button>
  );
}

function PeopleDirectoryActionButton({
  isDark,
  active,
  label,
  icon,
  onClick,
  iconOnly = false,
}: {
  isDark: boolean;
  active: boolean;
  label: string;
  icon: ReactNode;
  onClick: () => void;
  iconOnly?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      title={label}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 min-w-0 items-center justify-center gap-1 rounded-lg border text-[11px] font-semibold transition-colors',
        iconOnly ? 'w-8 px-0' : 'px-2',
        active
          ? isDark
            ? 'border-violet-300/30 bg-violet-500/16 text-violet-100'
            : 'border-violet-200 bg-violet-50 text-violet-700'
          : isDark
            ? 'border-white/[0.06] bg-white/[0.03] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100'
            : 'border-zinc-200 bg-white/75 text-zinc-600 hover:bg-zinc-50 hover:text-zinc-950',
      )}
    >
      {icon}
      <span className={cn('truncate', iconOnly && 'sr-only')}>{label}</span>
    </button>
  );
}

function CompactPeopleList({ isDark, profiles }: { isDark: boolean; profiles: ProfileCardRecord[] }) {
  return (
    <div className="grid gap-1.5">
      {profiles.map((profile) => (
        <CompactPeopleRow key={profile.id} isDark={isDark} profile={profile} />
      ))}
    </div>
  );
}

function CompactPeopleRow({ isDark, profile }: { isDark: boolean; profile: ProfileCardRecord }) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div
      className={cn(
        'group flex min-h-[50px] w-full min-w-0 items-center gap-2 rounded-xl border px-2 py-1.5 transition-colors',
        isDark
          ? 'border-white/[0.05] bg-white/[0.025] text-zinc-100 hover:bg-white/[0.055]'
          : 'border-zinc-200/80 bg-white/80 text-zinc-950 hover:bg-zinc-50',
      )}
    >
      <button
        type="button"
        onClick={profile.onPrimaryAction ?? profile.onChat}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <CompactPeopleAvatar isDark={isDark} profile={profile} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[13px] font-semibold leading-5">{profile.name}</span>
            <span
              className={cn(
                'h-1.5 w-1.5 shrink-0 rounded-full',
                profile.liveStatus?.kind === 'working'
                  ? 'bg-emerald-400'
                  : profile.liveStatus?.kind === 'waiting'
                    ? 'bg-amber-400'
                    : profile.liveStatus?.kind === 'stuck'
                      ? 'bg-rose-400'
                      : profile.liveStatus?.kind === 'offline'
                        ? 'bg-zinc-500'
                        : isDark
                          ? 'bg-zinc-600'
                          : 'bg-zinc-300',
              )}
            />
          </span>
          <span className={cn('mt-0.5 block truncate text-[11px]', isDark ? 'text-zinc-500' : 'text-zinc-500')}>
            {profile.handle || profile.subtitle || (profile.kind === 'agent' ? 'Agent' : 'Contact')}
          </span>
        </span>
      </button>
      {profile.onChat ? (
        <button
          type="button"
          onClick={profile.onChat}
          aria-label="Open chat"
          className={cn(
            'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
            isDark
              ? 'text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-100'
              : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-900',
          )}
        >
          <MessageCircle className="h-4 w-4" />
        </button>
      ) : null}
      {profile.onRemove ? (
        <div className="relative shrink-0">
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="More"
            data-testid="compact-people-row-overflow"
            data-profile-id={profile.id}
            className={cn(
              'inline-flex h-8 w-8 items-center justify-center rounded-lg',
              isDark
                ? 'text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-100'
                : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-900',
            )}
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
          {menuOpen ? (
            <>
              <button
                type="button"
                aria-hidden
                onClick={() => setMenuOpen(false)}
                className="fixed inset-0 z-30 cursor-default"
              />
              <div
                role="menu"
                className={cn(
                  'absolute right-0 top-9 z-40 min-w-[140px] overflow-hidden rounded-xl border shadow-lg',
                  isDark ? 'border-white/[0.08] bg-zinc-950/95' : 'border-zinc-200 bg-white',
                )}
              >
                <button
                  type="button"
                  role="menuitem"
                  data-testid="compact-people-row-remove"
                  onClick={() => {
                    setMenuOpen(false);
                    profile.onRemove?.();
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-2 text-left text-[12px]',
                    isDark ? 'text-rose-300 hover:bg-rose-500/10' : 'text-rose-600 hover:bg-rose-50',
                  )}
                >
                  <X className="h-3.5 w-3.5" />
                  {profile.kind === 'agent' ? '移除 Agent' : '移除联系人'}
                </button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function CompactPeopleAvatar({ isDark, profile }: { isDark: boolean; profile: ProfileCardRecord }) {
  if (profile.kind === 'agent') {
    return (
      <AgentAvatar
        fallback={{
          seed: profile.avatarSeed ?? profile.id,
          label: profile.name || profile.handle || 'Agent',
          roleSlug: profile.agentRoleSlug,
          // handle (`@engineer`) is the reliable role-icon source — agentRoleSlug
          // is often a generic tier and the localized name never matches. Keeps
          // this icon identical to the session chip / member popover.
          handle: profile.handle,
        }}
        status={profile.liveStatus ?? null}
        size="sm"
        isDark={isDark}
      />
    );
  }

  const seed = profile.avatarSeed ?? profile.id;
  const avatar = avatarGradient(seed);
  const initials = avatarInitials(profile.name || profile.handle || '?');
  const ring =
    profile.liveStatus?.kind === 'working'
      ? 'ring-2 ring-emerald-400/60'
      : profile.liveStatus?.kind === 'waiting'
        ? 'ring-2 ring-amber-400/60'
        : profile.liveStatus?.kind === 'stuck'
          ? 'ring-2 ring-rose-400/60'
          : profile.liveStatus?.kind === 'offline'
            ? isDark
              ? 'ring-1 ring-zinc-600'
              : 'ring-1 ring-zinc-300'
            : '';
  return (
    <span
      className={cn(
        'relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-[11px] font-bold text-white shadow-sm',
        ring,
      )}
      style={{ background: `linear-gradient(135deg, ${avatar.from}, ${avatar.to})` }}
    >
      {initials}
      <span
        className={cn(
          'absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-md border',
          isDark ? 'border-zinc-950 bg-cyan-500' : 'border-white bg-cyan-600',
        )}
      >
        <Users className="h-2.5 w-2.5 text-white" />
      </span>
    </span>
  );
}

function PeopleDirectoryEmptyState({
  isDark,
  title,
  text,
  compact = false,
}: {
  isDark: boolean;
  title: string;
  text: string;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        'rounded-2xl border text-center',
        compact ? 'px-4 py-6' : 'px-6 py-10',
        isDark ? 'border-white/[0.06] bg-white/[0.025]' : 'border-zinc-200 bg-white/75',
      )}
    >
      <p className={cn('text-sm font-semibold', isDark ? 'text-zinc-200' : 'text-zinc-800')}>{title}</p>
      <p className={cn('mx-auto mt-2 max-w-md text-sm leading-relaxed', isDark ? 'text-zinc-500' : 'text-zinc-500')}>
        {text}
      </p>
    </div>
  );
}
