'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import {
  Check,
  Compass,
  Copy,
  Loader2,
  MessageCircle,
  QrCode,
  Search,
  Send,
  ShieldOff,
  User,
  UserPlus,
  X,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useI18n } from '@/contexts/i18n-context';
import { cn } from '@/lib/utils';
import { avatarGradient, avatarInitials } from '../lib/design';
import { imFetch } from '../lib/im-api';
import { ProfileCardShelf, type ProfileCardRecord } from './profile-card';
import { SurfaceHeader } from './surface-header';
import type { AgentDTO, ContactFriendDTO, ContactRequestDTO, UserProfileDTO } from '../lib/types';

type ContactTab = 'friends' | 'requests' | 'discover' | 'add' | 'qr';

interface DiscoverResult {
  userId: string;
  username: string;
  displayName: string;
  role: 'human' | 'agent' | string;
  agentType?: string | null;
  capabilities?: string[] | null;
  description?: string | null;
  status?: 'online' | 'busy' | 'offline' | string | null;
  isContact?: boolean;
}

type DiscoverTypeFilter = 'all' | 'human' | 'agent';

interface ContactsPanelProps {
  isDark: boolean;
  me: UserProfileDTO | null;
  friends: ContactFriendDTO[];
  agents?: AgentDTO[];
  receivedRequests: ContactRequestDTO[];
  sentRequests: ContactRequestDTO[];
  prefillUserId?: string | null;
  onReload: () => Promise<void>;
  onOpenSession: (conversationId: string) => void | Promise<void>;
  onStartChat: (userId: string) => Promise<void>;
  onOpenAgentProfile?: (agentId: string) => void;
  notify: (message: string, type: 'success' | 'error' | 'info') => void;
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

interface BlockedContactDTO {
  userId: string;
  username: string;
  displayName: string;
  role?: string;
  avatarUrl?: string | null;
  reason?: string | null;
  blockedAt?: string;
}

export function ContactsPanel({
  isDark,
  me,
  friends,
  agents = [],
  receivedRequests,
  sentRequests,
  prefillUserId,
  onReload,
  onOpenSession,
  onStartChat,
  onOpenAgentProfile,
  notify,
}: ContactsPanelProps) {
  const { t } = useI18n();
  const [tab, setTab] = useState<ContactTab>('friends');
  const [username, setUsername] = useState('');
  const [reason, setReason] = useState('');
  const [target, setTarget] = useState<UserLookupResponse | null>(null);
  const [targetLoading, setTargetLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [busyRequestId, setBusyRequestId] = useState<string | null>(null);
  const [busyContactId, setBusyContactId] = useState<string | null>(null);
  const [busyChatId, setBusyChatId] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<BlockedContactDTO[]>([]);
  const [blockedLoaded, setBlockedLoaded] = useState(false);
  const [discoverQuery, setDiscoverQuery] = useState('');
  const [discoverType, setDiscoverType] = useState<DiscoverTypeFilter>('all');
  const [discoverResults, setDiscoverResults] = useState<DiscoverResult[]>([]);
  const [discoverLoading, setDiscoverLoading] = useState(false);
  const [discoverLoaded, setDiscoverLoaded] = useState(false);
  const [discoverBusyId, setDiscoverBusyId] = useState<string | null>(null);
  const [selectedProfileIds, setSelectedProfileIds] = useState<Set<string>>(new Set());

  // Indexes for the Discover tab — let us cheaply compute relationship state
  // (already friend / pending sent / pending received) for each result row.
  const friendIds = useMemo(() => new Set(friends.map((f) => f.userId)), [friends]);
  const sentIds = useMemo(() => new Set(sentRequests.map((r) => r.toUserId)), [sentRequests]);
  const receivedByFromId = useMemo(() => {
    const map = new Map<string, ContactRequestDTO>();
    for (const r of receivedRequests) map.set(r.fromUserId, r);
    return map;
  }, [receivedRequests]);

  const inviteUrl = useMemo(() => {
    if (!me) return '';
    if (typeof window === 'undefined') return `prismer://contact?userId=${encodeURIComponent(me.id)}`;
    const url = new URL('/workspace', window.location.origin);
    url.searchParams.set('addContact', me.id);
    return url.toString();
  }, [me]);

  useEffect(() => {
    if (!inviteUrl) return;
    let cancelled = false;
    QRCode.toDataURL(inviteUrl, { margin: 1, width: 224, color: { dark: '#111827', light: '#ffffff' } })
      .then((url: string) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [inviteUrl]);

  useEffect(() => {
    if (!prefillUserId) return;
    setTab('add');
    setTargetLoading(true);
    imFetch<UserLookupResponse>(`/users/${encodeURIComponent(prefillUserId)}`).then((res) => {
      setTargetLoading(false);
      if (!res.ok) {
        notify(`Contact link invalid: ${res.message}`, 'error');
        return;
      }
      setTarget(res.data);
      setUsername(res.data.username);
    });
  }, [prefillUserId, notify]);

  async function lookupByUsername() {
    const typed = username.trim().replace(/^@/, '');
    if (!typed || targetLoading) return;
    setTargetLoading(true);
    setTarget(null);
    const res = await imFetch<UserLookupResponse>(`/users/by-username/${encodeURIComponent(typed)}`);
    setTargetLoading(false);
    if (!res.ok) {
      notify(res.status === 404 ? `User "${typed}" not found.` : res.message, 'error');
      return;
    }
    setTarget(res.data);
  }

  async function sendFriendRequest(userId = target?.id) {
    if (!userId || submitting) return;
    setSubmitting(true);
    const res = await imFetch<ContactRequestDTO>('/contacts/request', {
      method: 'POST',
      body: JSON.stringify({
        userId,
        reason: reason.trim() || undefined,
        source: prefillUserId === userId ? 'workspace_qr' : 'workspace_contacts',
      }),
    });
    setSubmitting(false);
    if (!res.ok) {
      notify(res.message, 'error');
      return;
    }
    notify('Friend request sent.', 'success');
    setReason('');
    await onReload();
  }

  async function acceptRequest(requestId: string) {
    setBusyRequestId(requestId);
    const res = await imFetch<{ conversationId?: string }>(
      `/contacts/requests/${encodeURIComponent(requestId)}/accept`,
      {
        method: 'POST',
      },
    );
    if (!res.ok) {
      setBusyRequestId(null);
      notify(res.message, 'error');
      return;
    }
    notify('Friend request accepted.', 'success');
    await onReload();
    if (res.data?.conversationId) {
      await onOpenSession(res.data.conversationId);
    } else {
      // Server should always return a conversationId per acceptRequest's
      // contract — surface this as a warning instead of silently swallowing
      // it so a regression here is visible during e2e and to users.
      notify('Friend added, but the chat could not be opened automatically.', 'info');
    }
    setBusyRequestId(null);
  }

  async function rejectRequest(requestId: string) {
    setBusyRequestId(requestId);
    const res = await imFetch(`/contacts/requests/${encodeURIComponent(requestId)}/reject`, { method: 'POST' });
    setBusyRequestId(null);
    if (!res.ok) {
      notify(res.message, 'error');
      return;
    }
    notify('Friend request rejected.', 'success');
    await onReload();
  }

  // Wave-8 W8 C4: sender-side withdrawal of a pending Sent request. Hits the
  // new DELETE /contacts/requests/:id/cancel endpoint, then triggers an
  // onReload so the Sent column drops the row. The recipient's side is taken
  // care of by the SSE `contact.cancelled` fan-out (page.tsx subscribes).
  async function cancelRequest(requestId: string) {
    setBusyRequestId(requestId);
    const res = await imFetch(`/contacts/requests/${encodeURIComponent(requestId)}/cancel`, { method: 'DELETE' });
    setBusyRequestId(null);
    if (!res.ok) {
      notify(res.message, 'error');
      return;
    }
    notify('Friend request withdrawn.', 'success');
    await onReload();
  }

  async function removeFriend(contactId: string) {
    setBusyContactId(contactId);
    const res = await imFetch(`/contacts/${encodeURIComponent(contactId)}/remove`, { method: 'DELETE' });
    setBusyContactId(null);
    if (!res.ok) {
      notify(res.message, 'error');
      return;
    }
    notify('Contact removed.', 'success');
    await onReload();
  }

  async function blockUser(contactId: string) {
    setBusyContactId(contactId);
    const res = await imFetch(`/contacts/${encodeURIComponent(contactId)}/block`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Blocked from workspace contacts' }),
    });
    setBusyContactId(null);
    if (!res.ok) {
      notify(res.message, 'error');
      return;
    }
    notify('User blocked.', 'success');
    setBlockedLoaded(false);
    await onReload();
  }

  async function updateRemark(contactId: string, remark: string) {
    setBusyContactId(contactId);
    const res = await imFetch(`/contacts/${encodeURIComponent(contactId)}/remark`, {
      method: 'PATCH',
      body: JSON.stringify({ remark }),
    });
    setBusyContactId(null);
    if (!res.ok) {
      notify(res.message, 'error');
      return;
    }
    notify(remark.trim() ? 'Contact remark saved.' : 'Contact remark cleared.', 'success');
    await onReload();
  }

  const reloadBlocked = useCallback(async () => {
    const res = await imFetch<BlockedContactDTO[]>('/contacts/blocked?limit=100');
    if (!res.ok) {
      notify(`Blocklist failed: ${res.message}`, 'error');
      return;
    }
    setBlocked(res.data ?? []);
    setBlockedLoaded(true);
  }, [notify]);

  useEffect(() => {
    if (tab !== 'requests' || blockedLoaded) return;
    void reloadBlocked();
  }, [tab, blockedLoaded, reloadBlocked]);

  // Auto-load discover results the first time the tab opens — match the QR
  // tab's pattern of "show something useful immediately".
  useEffect(() => {
    if (tab !== 'discover' || discoverLoaded || discoverLoading) return;
    void runDiscover();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  useEffect(() => {
    if (tab !== 'friends' && selectedProfileIds.size > 0) {
      setSelectedProfileIds(new Set());
    }
  }, [selectedProfileIds, tab]);

  async function unblockUser(contactId: string) {
    setBusyContactId(contactId);
    const res = await imFetch(`/contacts/${encodeURIComponent(contactId)}/block`, { method: 'DELETE' });
    setBusyContactId(null);
    if (!res.ok) {
      notify(res.message, 'error');
      return;
    }
    notify('User unblocked.', 'success');
    await reloadBlocked();
    await onReload();
  }

  async function startChat(contactId: string) {
    setBusyChatId(contactId);
    await onStartChat(contactId);
    setBusyChatId(null);
  }

  async function runDiscover(opts?: { silent?: boolean }) {
    if (discoverLoading) return;
    setDiscoverLoading(true);
    if (!opts?.silent) setDiscoverResults([]);
    const params = new URLSearchParams();
    const trimmed = discoverQuery.trim();
    if (trimmed) params.set('q', trimmed);
    if (discoverType !== 'all') params.set('type', discoverType);
    params.set('limit', '50');
    const res = await imFetch<DiscoverResult[]>(`/discover?${params.toString()}`);
    setDiscoverLoading(false);
    if (!res.ok) {
      notify(`Discover failed: ${res.message}`, 'error');
      return;
    }
    setDiscoverResults(res.data ?? []);
    setDiscoverLoaded(true);
  }

  async function sendFromDiscover(userId: string) {
    setDiscoverBusyId(userId);
    const res = await imFetch<ContactRequestDTO>('/contacts/request', {
      method: 'POST',
      body: JSON.stringify({ userId, source: 'workspace_discover' }),
    });
    setDiscoverBusyId(null);
    if (!res.ok) {
      notify(res.message, 'error');
      return;
    }
    notify('Friend request sent.', 'success');
    await onReload();
  }

  async function copyInvite() {
    if (!inviteUrl) return;
    await navigator.clipboard.writeText(inviteUrl);
    notify('Contact link copied.', 'success');
  }

  async function copyHandle(handle: string) {
    await navigator.clipboard.writeText(handle);
    notify(`${handle} copied.`, 'success');
  }

  function toggleProfileSelected(profileId: string) {
    setSelectedProfileIds((prev) => {
      const next = new Set(prev);
      if (next.has(profileId)) next.delete(profileId);
      else next.add(profileId);
      return next;
    });
  }

  function clearProfileSelection() {
    setSelectedProfileIds(new Set());
  }

  async function bulkRemoveSelected() {
    const selectedFriends = friends.filter((friend) => selectedProfileIds.has(friend.userId));
    if (selectedFriends.length === 0) return;
    if (
      !window.confirm(`Remove ${selectedFriends.length} selected contact${selectedFriends.length === 1 ? '' : 's'}?`)
    ) {
      return;
    }
    for (const friend of selectedFriends) {
      await removeFriend(friend.userId);
    }
    clearProfileSelection();
  }

  async function bulkBlockSelected() {
    const selectedFriends = friends.filter((friend) => selectedProfileIds.has(friend.userId));
    if (selectedFriends.length === 0) return;
    if (
      !window.confirm(`Block ${selectedFriends.length} selected contact${selectedFriends.length === 1 ? '' : 's'}?`)
    ) {
      return;
    }
    for (const friend of selectedFriends) {
      await blockUser(friend.userId);
    }
    clearProfileSelection();
  }

  const profileCards = (() => {
    const map = new Map<string, ProfileCardRecord>();

    for (const friend of friends) {
      const lastSeen = friend.lastSeenAt ? `Last seen ${new Date(friend.lastSeenAt).toLocaleDateString()}` : undefined;
      map.set(friend.userId, {
        id: friend.userId,
        kind: friend.isAgent ? 'agent' : 'human',
        name: friend.remark || friend.displayName || friend.username,
        handle: `@${friend.username}`,
        avatarSeed: friend.userId,
        statusText: 'Friend',
        statusTone: friend.isAgent ? 'violet' : 'cyan',
        subtitle: friend.isAgent ? 'Agent contact' : 'Human contact',
        description: lastSeen,
        badges: [friend.isAgent ? 'Contact agent' : 'Contact'],
        remark: friend.remark,
        onPrimaryAction: () => void startChat(friend.userId),
        onChat: () => void startChat(friend.userId),
        onCopyHandle: () => void copyHandle(`@${friend.username}`),
        onRemark: (remark) => void updateRemark(friend.userId, remark),
        onRemove: () => void removeFriend(friend.userId),
        onBlock: () => void blockUser(friend.userId),
      });
    }

    for (const agent of agents) {
      const existing = map.get(agent.userId);
      const presence = agent.presence?.status || agent.status || 'registered';
      const statusTone =
        presence === 'online' ? 'emerald' : presence === 'busy' ? 'amber' : presence === 'offline' ? 'slate' : 'violet';
      const description =
        agent.capabilities && agent.capabilities.length > 0
          ? agent.capabilities.slice(0, 4).join(' · ')
          : agent.description || 'Activated workspace agent';
      const agentCard: ProfileCardRecord = {
        id: agent.userId,
        kind: 'agent',
        name: existing?.name || agent.name,
        handle: `@${agent.name}`,
        avatarSeed: agent.userId,
        statusText: presence,
        statusTone,
        subtitle: agent.agentType || 'Workspace agent',
        description,
        badges: Array.from(new Set([...(existing?.badges ?? []), 'Activated', agent.agentType || 'agent'])),
        remark: existing?.remark ?? null,
        onPrimaryAction: () => onOpenAgentProfile?.(agent.agentId),
        onChat: () => void startChat(agent.userId),
        onOpenProfile: onOpenAgentProfile ? () => onOpenAgentProfile(agent.agentId) : undefined,
        onCopyHandle: () => void copyHandle(`@${agent.name}`),
        onRemark: existing?.onRemark,
        onRemove: existing?.onRemove,
        onBlock: existing?.onBlock,
      };
      map.set(agent.userId, agentCard);
    }

    return Array.from(map.values()).sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'agent' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  })();

  const selectedProfiles = profileCards.filter((profile) => selectedProfileIds.has(profile.id));
  const selectedFriendCount = friends.filter((friend) => selectedProfileIds.has(friend.userId)).length;
  const selectedAgentCount = selectedProfiles.filter((profile) => profile.kind === 'agent').length;

  const panelClass = isDark ? 'border-white/[0.06] bg-zinc-950/25' : 'border-zinc-200 bg-white/70';
  const muted = isDark ? 'text-zinc-500' : 'text-zinc-500';

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <SurfaceHeader
        isDark={isDark}
        title={t('workspace.contacts.title')}
        subtitle={t('workspace.contacts.subtitle')}
        actions={
          <div
            className={`flex rounded-xl border p-1 ${
              isDark ? 'border-white/[0.06] bg-zinc-900/70' : 'border-zinc-200 bg-zinc-100'
            }`}
          >
            {[
              ['friends', 'Friends'],
              ['requests', `Requests${receivedRequests.length ? ` ${receivedRequests.length}` : ''}`],
              ['discover', 'Discover'],
              ['add', 'Add'],
              ['qr', 'QR'],
            ].map(([key, label]) => (
              <button
                key={key}
                type="button"
                data-testid={`contacts-tab-${key}`}
                onClick={() => setTab(key as ContactTab)}
                className={cn(
                  'rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors',
                  tab === key
                    ? isDark
                      ? 'bg-white/[0.08] text-zinc-100'
                      : 'bg-white text-zinc-950 shadow-sm'
                    : isDark
                      ? 'text-zinc-400 hover:text-zinc-100'
                      : 'text-zinc-600 hover:text-zinc-950',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
        {tab === 'friends' ? (
          <div className="space-y-4">
            {profileCards.length === 0 ? (
              <EmptyState
                isDark={isDark}
                title="No profiles yet"
                text="Search a username, share your QR contact link, or activate an agent to populate this workspace profile list."
              />
            ) : (
              <>
                <div
                  className={`flex flex-wrap items-center justify-between gap-2 rounded-2xl border px-3 py-2 ${
                    isDark ? 'border-white/[0.06] bg-white/[0.025]' : 'border-zinc-200 bg-white/75'
                  }`}
                >
                  <div className="min-w-0">
                    <p className={`text-xs font-semibold ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
                      {profileCards.length} profiles · {friends.length} contacts · {agents.length} active agents
                    </p>
                    {selectedProfiles.length > 0 ? (
                      <p className={`mt-0.5 text-[11px] ${muted}`}>
                        {selectedProfiles.length} selected
                        {selectedAgentCount > 0 ? ` · ${selectedAgentCount} agents` : ''}
                        {selectedFriendCount > 0 ? ` · ${selectedFriendCount} contacts` : ''}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setSelectedProfileIds(new Set(profileCards.map((p) => p.id)))}
                    >
                      Select all
                    </Button>
                    {selectedProfiles.length > 0 ? (
                      <>
                        {selectedProfiles.length === 1 ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => selectedProfiles[0]?.onPrimaryAction?.()}
                          >
                            Open
                          </Button>
                        ) : null}
                        {selectedFriendCount > 0 ? (
                          <>
                            <Button type="button" size="sm" variant="outline" onClick={() => void bulkRemoveSelected()}>
                              Remove
                            </Button>
                            <Button type="button" size="sm" variant="outline" onClick={() => void bulkBlockSelected()}>
                              Block
                            </Button>
                          </>
                        ) : null}
                        <Button type="button" size="sm" variant="ghost" onClick={clearProfileSelection}>
                          Clear
                        </Button>
                      </>
                    ) : null}
                  </div>
                </div>
                <ProfileCardShelf
                  isDark={isDark}
                  profiles={profileCards}
                  selectedIds={selectedProfileIds}
                  onToggleSelected={toggleProfileSelected}
                  defaultLayout="list"
                  availableLayouts={['list', 'grid']}
                />
              </>
            )}
          </div>
        ) : null}

        {tab === 'requests' ? (
          <div className="grid gap-5 xl:grid-cols-2">
            <RequestColumn
              title="Received"
              empty="No incoming friend requests."
              isDark={isDark}
              requests={receivedRequests}
              busyRequestId={busyRequestId}
              mode="received"
              onAccept={acceptRequest}
              onReject={rejectRequest}
            />
            <RequestColumn
              title="Sent"
              empty="No pending requests sent."
              isDark={isDark}
              requests={sentRequests}
              busyRequestId={busyRequestId}
              mode="sent"
              onAccept={acceptRequest}
              onReject={rejectRequest}
              onCancel={cancelRequest}
            />
            <div className="xl:col-span-2">
              <h3 className={`mb-3 text-sm font-semibold ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>Blocked</h3>
              <div className="grid gap-3 xl:grid-cols-2">
                {!blockedLoaded ? (
                  <EmptyState
                    isDark={isDark}
                    title="Blocklist not loaded"
                    text="Open Requests to load blocked contacts."
                    compact
                  />
                ) : blocked.length === 0 ? (
                  <EmptyState isDark={isDark} title="No blocked contacts" compact />
                ) : (
                  blocked.map((item) => (
                    <div
                      key={item.userId}
                      className={`rounded-2xl border p-4 ${isDark ? 'border-white/[0.06] bg-zinc-900/50' : 'border-zinc-200 bg-white'}`}
                    >
                      <div className="flex items-center gap-3">
                        <Avatar id={item.userId} label={item.displayName || item.username} />
                        <div className="min-w-0 flex-1">
                          <p className={`truncate text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-950'}`}>
                            {item.displayName || item.username}
                          </p>
                          <p className={`truncate text-xs ${muted}`}>@{item.username}</p>
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => unblockUser(item.userId)}
                          disabled={busyContactId === item.userId}
                        >
                          {busyContactId === item.userId ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <ShieldOff className="h-4 w-4" />
                          )}
                          Unblock
                        </Button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        ) : null}

        {tab === 'discover' ? (
          <div className="grid gap-4">
            <div className={`rounded-2xl border p-4 ${panelClass}`}>
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-0 flex-1">
                  <Search className={`pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 ${muted}`} />
                  <input
                    value={discoverQuery}
                    onChange={(event) => setDiscoverQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        void runDiscover();
                      }
                    }}
                    data-testid="contacts-discover-query"
                    placeholder="Search by name, username, or capability"
                    className={cn(
                      'w-full rounded-lg border px-3 py-2 pl-9 text-sm outline-none focus:ring-1',
                      isDark
                        ? 'border-white/10 bg-zinc-950 text-zinc-100 focus:ring-violet-500/40'
                        : 'border-zinc-300 bg-white text-zinc-900 focus:ring-violet-400',
                    )}
                  />
                </div>
                <select
                  value={discoverType}
                  onChange={(event) => setDiscoverType(event.target.value as DiscoverTypeFilter)}
                  data-testid="contacts-discover-type"
                  className={cn(
                    'rounded-lg border px-3 py-2 text-sm outline-none focus:ring-1',
                    isDark
                      ? 'border-white/10 bg-zinc-950 text-zinc-100 focus:ring-violet-500/40'
                      : 'border-zinc-300 bg-white text-zinc-900 focus:ring-violet-400',
                  )}
                >
                  <option value="all">Everyone</option>
                  <option value="human">People</option>
                  <option value="agent">Agents</option>
                </select>
                <Button
                  type="button"
                  data-testid="contacts-discover-search"
                  onClick={() => void runDiscover()}
                  disabled={discoverLoading}
                >
                  {discoverLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Compass className="h-4 w-4" />}
                  Search
                </Button>
              </div>
            </div>

            {discoverLoading && discoverResults.length === 0 ? (
              <div className="flex justify-center py-8">
                <Loader2 className={`h-5 w-5 animate-spin ${muted}`} />
              </div>
            ) : discoverResults.length === 0 ? (
              <EmptyState
                isDark={isDark}
                title={discoverLoaded ? 'No matches' : 'Browse the directory'}
                text={
                  discoverLoaded
                    ? 'Try a different keyword or type filter — agents and humans both index by name and capabilities.'
                    : 'Hit search to see who else is on Prismer right now.'
                }
              />
            ) : (
              <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3" data-testid="contacts-discover-results">
                {discoverResults.map((result) => {
                  const isSelf = me?.id === result.userId;
                  const isFriend = friendIds.has(result.userId);
                  const pendingSent = sentIds.has(result.userId);
                  const pendingReceived = receivedByFromId.get(result.userId);
                  const busy = discoverBusyId === result.userId;
                  return (
                    <div
                      key={result.userId}
                      data-testid={`contacts-discover-result-${result.username}`}
                      className={`rounded-2xl border p-4 ${isDark ? 'border-white/[0.06] bg-zinc-900/50' : 'border-zinc-200 bg-white'}`}
                    >
                      <div className="flex items-start gap-3">
                        <Avatar id={result.userId} label={result.displayName || result.username} />
                        <div className="min-w-0 flex-1">
                          <p className={`truncate text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-950'}`}>
                            {result.displayName || result.username}
                          </p>
                          <p className={`truncate text-xs ${muted}`}>@{result.username}</p>
                          <div className="mt-1 flex flex-wrap items-center gap-1">
                            <span
                              className={`inline-flex rounded-full px-2 py-0.5 text-[10px] ${isDark ? 'bg-white/[0.06] text-zinc-300' : 'bg-zinc-100 text-zinc-700'}`}
                            >
                              {result.role === 'agent' ? result.agentType || 'agent' : 'human'}
                            </span>
                            {result.status ? (
                              <span
                                className={`inline-flex rounded-full px-2 py-0.5 text-[10px] ${
                                  result.status === 'online'
                                    ? isDark
                                      ? 'bg-emerald-500/15 text-emerald-300'
                                      : 'bg-emerald-100 text-emerald-700'
                                    : isDark
                                      ? 'bg-white/[0.06] text-zinc-300'
                                      : 'bg-zinc-100 text-zinc-700'
                                }`}
                              >
                                {result.status}
                              </span>
                            ) : null}
                          </div>
                          {result.description ? (
                            <p className={`mt-2 line-clamp-2 text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
                              {result.description}
                            </p>
                          ) : null}
                          {result.capabilities && result.capabilities.length > 0 ? (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {result.capabilities.slice(0, 4).map((cap) => (
                                <span
                                  key={cap}
                                  className={`inline-flex rounded-full px-2 py-0.5 text-[10px] ${isDark ? 'bg-violet-500/10 text-violet-200' : 'bg-violet-50 text-violet-700'}`}
                                >
                                  {cap}
                                </span>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </div>
                      <div className="mt-4 flex flex-wrap gap-2">
                        {isSelf ? (
                          <span className={`text-xs ${muted}`}>That&rsquo;s you.</span>
                        ) : isFriend ? (
                          <Button
                            type="button"
                            size="sm"
                            data-testid={`contacts-discover-message-${result.username}`}
                            onClick={() => startChat(result.userId)}
                            disabled={busyChatId === result.userId}
                          >
                            {busyChatId === result.userId ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <MessageCircle className="h-4 w-4" />
                            )}
                            Message
                          </Button>
                        ) : pendingSent ? (
                          <Button type="button" size="sm" variant="outline" disabled>
                            <Check className="h-4 w-4" />
                            Pending
                          </Button>
                        ) : pendingReceived ? (
                          <Button
                            type="button"
                            size="sm"
                            data-testid={`contacts-discover-accept-${result.username}`}
                            onClick={() => acceptRequest(pendingReceived.id)}
                            disabled={busyRequestId === pendingReceived.id}
                          >
                            {busyRequestId === pendingReceived.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Check className="h-4 w-4" />
                            )}
                            Accept request
                          </Button>
                        ) : (
                          <Button
                            type="button"
                            size="sm"
                            data-testid={`contacts-discover-send-${result.username}`}
                            onClick={() => sendFromDiscover(result.userId)}
                            disabled={busy}
                          >
                            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
                            Send request
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : null}

        {tab === 'add' ? (
          <div className="grid gap-4 xl:grid-cols-[minmax(0,420px)_1fr]">
            <div className={`rounded-2xl border p-4 ${panelClass}`}>
              <label className="grid gap-1.5">
                <span className={`text-xs font-semibold ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>Username</span>
                <div className="flex gap-2">
                  <input
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        void lookupByUsername();
                      }
                    }}
                    placeholder="alice"
                    className={cn(
                      'min-w-0 flex-1 rounded-lg border px-3 py-2 text-sm outline-none focus:ring-1',
                      isDark
                        ? 'border-white/10 bg-zinc-950 text-zinc-100 focus:ring-violet-500/40'
                        : 'border-zinc-300 bg-white text-zinc-900 focus:ring-violet-400',
                    )}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={lookupByUsername}
                    disabled={!username.trim() || targetLoading}
                  >
                    {targetLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                  </Button>
                </div>
              </label>
              <label className="mt-3 grid gap-1.5">
                <span className={`text-xs font-semibold ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
                  Request note
                </span>
                <textarea
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="Hi, let's connect on Prismer."
                  maxLength={240}
                  rows={3}
                  className={cn(
                    'resize-none rounded-lg border px-3 py-2 text-sm outline-none focus:ring-1',
                    isDark
                      ? 'border-white/10 bg-zinc-950 text-zinc-100 focus:ring-violet-500/40'
                      : 'border-zinc-300 bg-white text-zinc-900 focus:ring-violet-400',
                  )}
                />
              </label>
            </div>
            <div className={`rounded-2xl border p-4 ${panelClass}`}>
              {targetLoading ? (
                <div className="flex min-h-48 items-center justify-center">
                  <Loader2 className={`h-5 w-5 animate-spin ${muted}`} />
                </div>
              ) : target ? (
                <LookupCard
                  isDark={isDark}
                  user={target}
                  submitting={submitting}
                  onSend={() => sendFriendRequest(target.id)}
                />
              ) : (
                <EmptyState
                  isDark={isDark}
                  title="Find someone"
                  text="Enter an exact username to send a friend request. Scanned contact links also appear here."
                />
              )}
            </div>
          </div>
        ) : null}

        {tab === 'qr' ? (
          <div className="grid gap-4 xl:grid-cols-[280px_1fr]">
            <div className={`rounded-2xl border p-5 ${panelClass}`}>
              <div
                className={`flex aspect-square items-center justify-center rounded-2xl border ${isDark ? 'border-white/[0.06] bg-white' : 'border-zinc-200 bg-white'}`}
              >
                {qrDataUrl ? (
                  <img src={qrDataUrl} alt="Contact QR code" className="h-[224px] w-[224px]" />
                ) : (
                  <QrCode className="h-16 w-16 text-zinc-400" />
                )}
              </div>
              <Button type="button" className="mt-4 w-full" onClick={copyInvite} disabled={!inviteUrl}>
                <Copy className="h-4 w-4" />
                Copy link
              </Button>
            </div>
            <div className={`rounded-2xl border p-5 ${panelClass}`}>
              <p className={`text-xs font-bold uppercase tracking-wider ${muted}`}>Your contact card</p>
              <div className="mt-4 flex items-center gap-3">
                <Avatar id={me?.id ?? 'me'} label={me?.displayName ?? me?.username ?? 'Me'} />
                <div className="min-w-0">
                  <p className={`truncate text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-950'}`}>
                    {me?.displayName ?? 'You'}
                  </p>
                  <p className={`truncate text-xs ${muted}`}>@{me?.username ?? 'unknown'}</p>
                </div>
              </div>
              <div
                className={`mt-4 rounded-xl border px-3 py-2 text-xs ${isDark ? 'border-white/[0.06] bg-zinc-950 text-zinc-400' : 'border-zinc-200 bg-zinc-50 text-zinc-600'}`}
              >
                <p className="break-all">{inviteUrl || 'No contact link available.'}</p>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function RequestColumn({
  title,
  empty,
  isDark,
  requests,
  busyRequestId,
  mode,
  onAccept,
  onReject,
  onCancel,
}: {
  title: string;
  empty: string;
  isDark: boolean;
  requests: ContactRequestDTO[];
  busyRequestId: string | null;
  mode: 'received' | 'sent';
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  onCancel?: (id: string) => void;
}) {
  return (
    <div>
      <h3 className={`mb-3 text-sm font-semibold ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>{title}</h3>
      <div className="grid gap-3">
        {requests.length === 0 ? (
          <EmptyState isDark={isDark} title={empty} compact />
        ) : (
          requests.map((request) => {
            const person = mode === 'received' ? request.fromUser : request.toUser;
            return (
              <div
                key={request.id}
                className={`rounded-2xl border p-4 ${isDark ? 'border-white/[0.06] bg-zinc-900/50' : 'border-zinc-200 bg-white'}`}
              >
                <div className="flex items-start gap-3">
                  <Avatar
                    id={mode === 'received' ? request.fromUserId : request.toUserId}
                    label={person?.displayName ?? person?.username ?? 'User'}
                  />
                  <div className="min-w-0 flex-1">
                    <p className={`truncate text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-950'}`}>
                      {person?.displayName ?? 'Unknown user'}
                    </p>
                    <p className={`truncate text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                      @{person?.username ?? 'unknown'}
                    </p>
                    {request.reason ? (
                      <p className={`mt-2 text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>{request.reason}</p>
                    ) : null}
                  </div>
                </div>
                {mode === 'received' ? (
                  <div className="mt-4 flex gap-2" data-testid={`contacts-request-actions-${request.id}`}>
                    <Button
                      type="button"
                      size="sm"
                      data-testid={`contacts-request-accept-${request.id}`}
                      onClick={() => onAccept(request.id)}
                      disabled={busyRequestId === request.id}
                    >
                      {busyRequestId === request.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Check className="h-4 w-4" />
                      )}
                      Accept
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      data-testid={`contacts-request-reject-${request.id}`}
                      onClick={() => onReject(request.id)}
                      disabled={busyRequestId === request.id}
                    >
                      <X className="h-4 w-4" />
                      Reject
                    </Button>
                  </div>
                ) : (
                  <div className="mt-4 flex gap-2" data-testid={`contacts-request-actions-${request.id}`}>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      data-testid={`contacts-request-cancel-${request.id}`}
                      onClick={() => onCancel?.(request.id)}
                      disabled={busyRequestId === request.id || !onCancel}
                    >
                      {busyRequestId === request.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <X className="h-4 w-4" />
                      )}
                      Cancel
                    </Button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function LookupCard({
  isDark,
  user,
  submitting,
  onSend,
}: {
  isDark: boolean;
  user: UserLookupResponse;
  submitting: boolean;
  onSend: () => void;
}) {
  return (
    <div className="flex min-h-48 flex-col justify-between gap-4">
      <div className="flex items-start gap-3">
        <Avatar id={user.id} label={user.displayName || user.username} />
        <div className="min-w-0">
          <p className={`truncate text-base font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-950'}`}>
            {user.displayName}
          </p>
          <p className={`truncate text-sm ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>@{user.username}</p>
          <p
            className={`mt-2 inline-flex rounded-full px-2 py-0.5 text-xs ${isDark ? 'bg-white/[0.06] text-zinc-300' : 'bg-zinc-100 text-zinc-700'}`}
          >
            {user.role === 'agent' ? user.agentType || 'agent' : 'human'}
          </p>
        </div>
      </div>
      <Button type="button" onClick={onSend} disabled={submitting}>
        {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        Send friend request
      </Button>
    </div>
  );
}

function Avatar({ id, label }: { id: string; label: string }) {
  const avatar = avatarGradient(id);
  return (
    <span
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-xs font-bold text-white"
      style={{ background: `linear-gradient(135deg, ${avatar.from}, ${avatar.to})` }}
    >
      {label ? avatarInitials(label) : <User className="h-4 w-4" />}
    </span>
  );
}

function EmptyState({
  isDark,
  title,
  text,
  compact = false,
}: {
  isDark: boolean;
  title: string;
  text?: string;
  compact?: boolean;
}) {
  return (
    <div
      className={`rounded-2xl border border-dashed ${compact ? 'p-4' : 'p-6'} ${isDark ? 'border-white/[0.08] text-zinc-500' : 'border-zinc-200 text-zinc-500'}`}
    >
      <p className={`text-sm font-semibold ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>{title}</p>
      {text ? <p className="mt-1 text-xs">{text}</p> : null}
    </div>
  );
}
