'use client';

import React, { useMemo, useState } from 'react';
import {
  Archive,
  BellOff,
  Hash,
  Inbox,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Trash2,
  Users,
} from 'lucide-react';

import { useI18n } from '@/contexts/i18n-context';
import type { ConversationDTO } from '../lib/types';

type WorkspaceT = ReturnType<typeof useI18n>['t'];

export interface SessionDirectoryProps {
  isDark: boolean;
  sessions: ConversationDTO[];
  selectedSessionId?: string | null;
  title?: string;
  className?: string;
  loading?: boolean;
  refreshing?: boolean;
  searchValue?: string;
  searchPlaceholder?: string;
  onSearchChange?: (value: string) => void;
  onSelectSession: (id: string) => void;
  onNewSession?: () => void;
  onRefresh?: () => void;
  onRenameSession?: (session: ConversationDTO) => void;
  onArchiveSession?: (session: ConversationDTO) => void;
  onDeleteSession?: (session: ConversationDTO) => void;
  onTogglePinSession?: (session: ConversationDTO, pinned: boolean) => void;
  onToggleMuteSession?: (session: ConversationDTO, muted: boolean) => void;
}

function sessionLabel(session: ConversationDTO, t: WorkspaceT): string {
  if (session.displayTitle?.trim()) return session.displayTitle.trim();
  if (session.title?.trim()) return session.title.trim();
  if (session.type === 'direct') return t('workspace.sessionDirectory.directSession');
  return t('workspace.sessionDirectory.untitledSession');
}

function sessionAccess(session: ConversationDTO) {
  const role = session.myRole;
  return {
    canRename: session.viewerAccess?.canRename ?? (role === 'owner' || role === 'admin'),
    canArchive: session.viewerAccess?.canArchive ?? (role === 'owner' || role === 'admin'),
    canDelete: session.viewerAccess?.canDelete ?? role === 'owner',
    canLeave: session.viewerAccess?.canLeave ?? Boolean(role && role !== 'observer' && role !== 'owner'),
    canPin: session.viewerAccess?.canPin ?? Boolean(role),
    canMute: session.viewerAccess?.canMute ?? Boolean(role),
  };
}

function formatRelative(iso: string | null, t: WorkspaceT): string {
  if (!iso) return t('workspace.sessionDirectory.noMessagesYet');
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return t('workspace.sessionDirectory.noMessagesYet');
  const diff = Math.max(0, Date.now() - ts);
  if (diff < 30_000) return t('workspace.sessionDirectory.justNow');
  if (diff < 60_000) return t('workspace.sessionDirectory.secondsAgo', { count: Math.round(diff / 1000) });
  if (diff < 3_600_000) return t('workspace.sessionDirectory.minutesAgo', { count: Math.round(diff / 60_000) });
  if (diff < 86_400_000) return t('workspace.sessionDirectory.hoursAgo', { count: Math.round(diff / 3_600_000) });
  return t('workspace.sessionDirectory.daysAgo', { count: Math.round(diff / 86_400_000) });
}

export function SessionDirectory({
  isDark,
  sessions,
  selectedSessionId = null,
  title,
  className = '',
  loading = false,
  refreshing = false,
  searchValue,
  searchPlaceholder,
  onSearchChange,
  onSelectSession,
  onNewSession,
  onRenameSession,
  onArchiveSession,
  onDeleteSession,
  onTogglePinSession,
  onToggleMuteSession,
}: SessionDirectoryProps) {
  const { t } = useI18n();
  const [internalSearch, setInternalSearch] = useState('');
  const resolvedTitle = title ?? t('workspace.sessionDirectory.title');
  const resolvedSearchPlaceholder = searchPlaceholder ?? t('workspace.sessionDirectory.searchPlaceholder');
  const query = searchValue ?? internalSearch;
  const normalizedQuery = query.trim().toLowerCase();
  const filteredSessions = useMemo(() => {
    if (!normalizedQuery) return sessions;
    return sessions.filter((session) => {
      const label = sessionLabel(session, t).toLowerCase();
      const type = session.type?.toLowerCase() ?? '';
      return label.includes(normalizedQuery) || type.includes(normalizedQuery);
    });
  }, [normalizedQuery, sessions, t]);

  function setSearch(nextValue: string) {
    if (searchValue === undefined) setInternalSearch(nextValue);
    onSearchChange?.(nextValue);
  }

  return (
    <section
      data-testid="session-directory"
      className={`flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border ${
        isDark
          ? 'border-white/[0.06] bg-zinc-950/35 shadow-[0_22px_70px_-54px_rgba(139,92,246,0.9)]'
          : 'border-zinc-200/80 bg-white/76 shadow-[0_22px_70px_-56px_rgba(76,29,149,0.35)]'
      } ${className}`}
    >
      <div className={`shrink-0 border-b px-3 py-3 ${isDark ? 'border-white/[0.06]' : 'border-zinc-200/80'}`}>
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <p
              className={`text-[10px] font-bold uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
            >
              {t('workspace.sessionDirectory.workspaceAutoSync')}
            </p>
            <h2
              className={`flex min-w-0 items-center gap-1.5 truncate text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}
            >
              <span className="truncate">{resolvedTitle}</span>
              {refreshing ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-violet-400" /> : null}
            </h2>
          </div>
          {onNewSession ? (
            <button
              type="button"
              aria-label={t('workspace.sessionDirectory.newSession')}
              title={t('workspace.sessionDirectory.newSession')}
              onClick={onNewSession}
              className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-violet-600 px-3 text-xs font-semibold text-white shadow-[0_14px_34px_-22px_rgba(124,58,237,0.75)] transition-colors hover:bg-violet-500"
            >
              <Plus className="h-4 w-4" />
              <span>{t('workspace.sessionDirectory.new')}</span>
            </button>
          ) : null}
        </div>

        <label
          className={`mt-3 flex h-9 items-center gap-2 rounded-xl border px-3 ${
            isDark
              ? 'border-white/[0.07] bg-white/[0.035] text-zinc-300 focus-within:border-violet-300/35'
              : 'border-zinc-200 bg-white/80 text-zinc-700 focus-within:border-violet-300'
          }`}
        >
          <Search className={`h-4 w-4 shrink-0 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`} aria-hidden />
          <input
            value={query}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={resolvedSearchPlaceholder}
            aria-label={t('workspace.sessionDirectory.searchPlaceholder')}
            className={`min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-zinc-500 ${
              isDark ? 'text-zinc-100' : 'text-zinc-900'
            }`}
          />
        </label>
      </div>

      <div className={`min-h-0 flex-1 overflow-y-auto px-2 py-2 ${isDark ? 'bg-zinc-950/20' : 'bg-zinc-50/55'}`}>
        {loading ? (
          <StateMessage
            isDark={isDark}
            icon={<Loader2 className="h-7 w-7 animate-spin" />}
            title={t('workspace.sessionDirectory.loadingSessions')}
          />
        ) : filteredSessions.length === 0 ? (
          <StateMessage
            isDark={isDark}
            icon={<Inbox className="h-8 w-8" />}
            title={
              sessions.length === 0
                ? t('workspace.sessionDirectory.noSessionsYet')
                : t('workspace.sessionDirectory.noMatchingSessions')
            }
            detail={
              sessions.length === 0
                ? t('workspace.sessionDirectory.startSessionHint')
                : t('workspace.sessionDirectory.differentSearchHint')
            }
          />
        ) : (
          <ul className="space-y-1">
            {filteredSessions.map((session) => (
              <li key={session.id}>
                <SessionDirectoryRow
                  isDark={isDark}
                  session={session}
                  active={session.id === selectedSessionId}
                  onSelect={() => onSelectSession(session.id)}
                  onRename={onRenameSession ? () => onRenameSession(session) : undefined}
                  onArchive={onArchiveSession ? () => onArchiveSession(session) : undefined}
                  onDelete={onDeleteSession ? () => onDeleteSession(session) : undefined}
                  onTogglePin={onTogglePinSession ? () => onTogglePinSession(session, !session.pinned) : undefined}
                  onToggleMute={onToggleMuteSession ? () => onToggleMuteSession(session, !session.muted) : undefined}
                  t={t}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function SessionDirectoryRow({
  isDark,
  session,
  active,
  onSelect,
  onRename,
  onArchive,
  onDelete,
  onTogglePin,
  onToggleMute,
  t,
}: {
  isDark: boolean;
  session: ConversationDTO;
  active: boolean;
  onSelect: () => void;
  onRename?: () => void;
  onArchive?: () => void;
  onDelete?: () => void;
  onTogglePin?: () => void;
  onToggleMute?: () => void;
  t: WorkspaceT;
}) {
  const access = sessionAccess(session);
  const isGroup = session.type !== 'direct';
  const unread = session.unreadCount ?? 0;
  const hasUnread = unread > 0;
  const unreadText = unread > 99 ? '99+' : String(unread);
  const canDeleteOrLeave = access.canDelete || access.canLeave;

  return (
    <div
      data-testid={`session-directory-row-${session.id}`}
      data-pinned={session.pinned ? 'true' : undefined}
      data-muted={session.muted ? 'true' : undefined}
      data-unread={hasUnread ? unread : undefined}
      className={`group relative flex w-full items-center gap-1 rounded-2xl border px-2.5 py-2 transition-[background-color,border-color,box-shadow,color] ${
        active
          ? isDark
            ? 'border-violet-400/30 bg-violet-500/18 text-violet-100 shadow-[0_14px_42px_-22px_rgba(139,92,246,0.95)]'
            : 'border-violet-200 bg-violet-100 text-violet-950 shadow-[0_14px_38px_-24px_rgba(124,58,237,0.65)]'
          : isDark
            ? 'border-transparent text-zinc-300 hover:border-white/[0.06] hover:bg-white/[0.05]'
            : 'border-transparent text-zinc-700 hover:border-zinc-200 hover:bg-zinc-200/60'
      }`}
    >
      {active ? (
        <span className="absolute left-0 top-1/2 h-7 w-1 -translate-y-1/2 rounded-full bg-gradient-to-b from-violet-400 to-cyan-300" />
      ) : null}
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={active}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <span
          className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl ${
            active ? (isDark ? 'bg-white/[0.08]' : 'bg-white/70') : isDark ? 'bg-white/[0.04]' : 'bg-white'
          }`}
        >
          {session.pinned ? (
            <Pin className="h-4 w-4" aria-hidden />
          ) : isGroup ? (
            <Users className="h-4 w-4" aria-hidden />
          ) : (
            <MessageSquare className="h-4 w-4" aria-hidden />
          )}
          {hasUnread && !active ? (
            <span
              data-testid={`session-directory-unread-dot-${session.id}`}
              className={`absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full ring-2 ${
                isDark ? 'bg-rose-500 ring-zinc-950' : 'bg-rose-500 ring-white'
              }`}
              aria-hidden
            />
          ) : null}
        </span>
        <span className="min-w-0 flex-1">
          <span className={`block truncate text-xs ${hasUnread && !active ? 'font-bold' : 'font-semibold'}`}>
            {sessionLabel(session, t)}
          </span>
          <span
            className={`flex min-w-0 items-center gap-1.5 truncate text-[10px] ${
              hasUnread && !active
                ? isDark
                  ? 'font-semibold text-rose-300'
                  : 'font-semibold text-rose-600'
                : active
                  ? 'opacity-75'
                  : isDark
                    ? 'text-zinc-500'
                    : 'text-zinc-500'
            }`}
          >
            {session.muted ? (
              <BellOff
                className="h-3 w-3 shrink-0 opacity-70"
                aria-label={t('workspace.sessionDirectory.mutedSession')}
              />
            ) : null}
            <span className="truncate">
              {hasUnread
                ? t('workspace.sessionDirectory.newMessages', { count: unreadText })
                : formatRelative(session.lastMessageAt, t)}
            </span>
          </span>
        </span>
      </button>
      {hasUnread ? (
        <span
          data-testid={`session-directory-unread-badge-${session.id}`}
          className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums shadow-sm ${
            active ? (isDark ? 'bg-white/15 text-white' : 'bg-white text-violet-700') : 'bg-rose-500 text-white'
          }`}
        >
          {unreadText}
        </span>
      ) : null}
      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        {onTogglePin && access.canPin ? (
          <RowIconButton
            isDark={isDark}
            ariaLabel={
              session.pinned ? t('workspace.sessionDirectory.unpinSession') : t('workspace.sessionDirectory.pinSession')
            }
            onClick={onTogglePin}
          >
            {session.pinned ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
          </RowIconButton>
        ) : null}
        {onToggleMute && access.canMute ? (
          <RowIconButton
            isDark={isDark}
            ariaLabel={
              session.muted
                ? t('workspace.sessionDirectory.unmuteSession')
                : t('workspace.sessionDirectory.muteSession')
            }
            onClick={onToggleMute}
          >
            {session.muted ? <Hash className="h-3 w-3" /> : <BellOff className="h-3 w-3" />}
          </RowIconButton>
        ) : null}
        {onRename && access.canRename ? (
          <RowIconButton isDark={isDark} ariaLabel={t('workspace.sessionDirectory.renameSession')} onClick={onRename}>
            <Pencil className="h-3 w-3" />
          </RowIconButton>
        ) : null}
        {onArchive && access.canArchive ? (
          <RowIconButton isDark={isDark} ariaLabel={t('workspace.sessionDirectory.archiveSession')} onClick={onArchive}>
            <Archive className="h-3 w-3" />
          </RowIconButton>
        ) : null}
        {onDelete && canDeleteOrLeave ? (
          <RowIconButton
            isDark={isDark}
            ariaLabel={
              access.canDelete
                ? t('workspace.sessionDirectory.deleteSession')
                : t('workspace.sessionDirectory.leaveSession')
            }
            onClick={onDelete}
          >
            <Trash2 className="h-3 w-3" />
          </RowIconButton>
        ) : null}
        {!onTogglePin && !onToggleMute && !onRename && !onArchive && !onDelete ? (
          <MoreHorizontal className={`h-4 w-4 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`} aria-hidden />
        ) : null}
      </span>
    </div>
  );
}

function RowIconButton({
  isDark,
  ariaLabel,
  onClick,
  children,
}: {
  isDark: boolean;
  ariaLabel: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      title={ariaLabel}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={`inline-flex h-6 w-6 items-center justify-center rounded-lg ${
        isDark
          ? 'text-zinc-400 hover:bg-white/[0.08] hover:text-zinc-100'
          : 'text-zinc-500 hover:bg-white hover:text-zinc-900'
      }`}
    >
      {children}
    </button>
  );
}

function StateMessage({
  isDark,
  icon,
  title,
  detail,
}: {
  isDark: boolean;
  icon: React.ReactNode;
  title: string;
  detail?: string;
}) {
  return (
    <div className={`flex flex-col items-center px-6 py-12 text-center ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
      <div className="mb-2 opacity-45">{icon}</div>
      <p className="text-sm">{title}</p>
      {detail ? (
        <p className={`mt-1 max-w-xs text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>{detail}</p>
      ) : null}
    </div>
  );
}
