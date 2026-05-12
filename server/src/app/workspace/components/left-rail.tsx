'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Archive,
  BarChart3,
  ChevronDown,
  ChevronRight,
  Contact,
  Edit3,
  KanbanSquare,
  Library,
  LogOut,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Smartphone,
  Users,
} from 'lucide-react';

import { springSnap, springSoft } from '../lib/design';
import { useI18n } from '@/contexts/i18n-context';
import type {
  AgentDTO,
  AssetDTO,
  ContactFriendDTO,
  ConversationDTO,
  RuntimeDeviceDTO,
  WorkspaceRuntimeDTO,
} from '../lib/types';

export type WorkspaceSurface = 'tasks' | 'contacts' | 'library' | 'runtime';

interface LeftRailProps {
  isDark: boolean;
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  sessions: ConversationDTO[];
  tasksCount: number;
  inProgressCount: number;
  doneCount: number;
  contacts: ContactFriendDTO[];
  /** Number of pending received friend requests — drives the Contacts tile badge. */
  pendingContactRequests?: number;
  /** Memory Line B / B7 — pending memory proposal count drives the Library tile red dot. */
  pendingMemoryProposals?: number;
  assets: AssetDTO[];
  agents: AgentDTO[];
  runtime: WorkspaceRuntimeDTO | null;
  selectedSessionId: string | null;
  activeSurface: WorkspaceSurface;
  onSelectSession: (id: string | null) => void;
  onSelectSurface: (surface: WorkspaceSurface) => void;
  /**
   * §30 B3.7 — unified creation entry for the nav surface (device/agent
   * creation). Opens `<UnifiedCreationModal>` for the collapsed + the
   * RuntimeManager panel.
   */
  onOpenCreation?: () => void;
  /**
   * Dedicated session-creation callback for the Sessions header "+".
   * Creates a new conversation directly — NOT the unified creation modal,
   * since the Sessions "+" is a session-only affordance.
   */
  onNewSession?: () => void;
  onRenameSession?: (session: ConversationDTO) => void;
  onArchiveSession?: (session: ConversationDTO) => void;
  onDeleteSession?: (session: ConversationDTO) => void;
}

function sessionLabel(session: ConversationDTO): string {
  if (session.displayTitle?.trim()) return session.displayTitle.trim();
  if (session.title?.trim()) return session.title.trim();
  if (session.type === 'direct') return 'Direct session';
  return 'Untitled session';
}

const DEVICE_ONLINE_WINDOW_MS = 90_000;

function isDeviceOnline(device: RuntimeDeviceDTO, now: number): boolean {
  if (!device.lastSeenAt) return false;
  const ts = Date.parse(device.lastSeenAt);
  if (Number.isNaN(ts)) return false;
  return now - ts <= DEVICE_ONLINE_WINDOW_MS;
}

function formatRelative(iso: string | null, now: number): string {
  if (!iso) return 'never';
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return 'never';
  const diff = Math.max(0, now - ts);
  if (diff < 30_000) return 'just now';
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

export function LeftRail({
  isDark,
  collapsed = false,
  onCollapsedChange,
  sessions,
  tasksCount,
  inProgressCount,
  doneCount,
  contacts,
  pendingContactRequests = 0,
  pendingMemoryProposals = 0,
  assets,
  agents,
  runtime,
  selectedSessionId,
  activeSurface,
  onSelectSession,
  onSelectSurface,
  onOpenCreation,
  onNewSession,
  onRenameSession,
  onArchiveSession,
  onDeleteSession,
}: LeftRailProps) {
  const { t } = useI18n();
  const [now, setNow] = useState(0);
  const devices = useMemo(() => runtime?.devices ?? [], [runtime]);
  const onlineDeviceCount = useMemo(() => devices.filter((d) => isDeviceOnline(d, now)).length, [devices, now]);
  const [collapsedSections, setCollapsedSections] = useState<Record<'sessions', boolean>>({
    sessions: false,
  });

  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  function toggleSection(section: keyof typeof collapsedSections) {
    setCollapsedSections((prev) => ({ ...prev, [section]: !prev[section] }));
  }

  if (collapsed) {
    return (
      <aside
        className={`hidden w-14 shrink-0 flex-col items-center gap-2 overflow-hidden border px-2 py-3 transition-[width] duration-200 lg:flex ${
          isDark ? 'border-white/[0.06] bg-zinc-950/30' : 'border-zinc-200 bg-zinc-50/70'
        } rounded-2xl`}
      >
        <IconButton isDark={isDark} title="Expand navigation" onClick={() => onCollapsedChange?.(false)}>
          <PanelLeftOpen className="h-4 w-4" />
        </IconButton>
        <IconButton isDark={isDark} title={t('workspace.leftRail.sessions')} onClick={() => onCollapsedChange?.(false)}>
          <MessageSquare className="h-4 w-4" />
        </IconButton>
        <IconButton isDark={isDark} title={t('workspace.leftRail.tasks')} onClick={() => onSelectSurface('tasks')}>
          <KanbanSquare className="h-4 w-4" />
        </IconButton>
        <IconButton
          isDark={isDark}
          title={t('workspace.leftRail.contacts')}
          onClick={() => onSelectSurface('contacts')}
        >
          <Contact className="h-4 w-4" />
        </IconButton>
        <IconButton isDark={isDark} title={t('workspace.leftRail.library')} onClick={() => onSelectSurface('library')}>
          <Library className="h-4 w-4" />
        </IconButton>
        <IconButton isDark={isDark} title={t('workspace.leftRail.devices')} onClick={() => onSelectSurface('runtime')}>
          <Smartphone className="h-4 w-4" />
        </IconButton>
        {/*
          §30 B3.7 — collapsed-rail "Create" shortcut. Replaces the
          legacy Bot icon (which only opened NewAgentDialog) with a `+`
          that opens the unified creation modal. Lets the user pick
          the surface from the modal's Pro tiles.
        */}
        {onOpenCreation ? (
          <IconButton isDark={isDark} title="Create" onClick={onOpenCreation}>
            <Plus className="h-4 w-4" />
          </IconButton>
        ) : null}
      </aside>
    );
  }

  return (
    <aside
      className={`hidden w-[260px] shrink-0 flex-col overflow-hidden border transition-[width] duration-200 lg:flex ${
        isDark
          ? 'border-white/[0.06] bg-zinc-950/30 shadow-[0_22px_70px_-54px_rgba(139,92,246,0.9)]'
          : 'border-zinc-200/80 bg-white/72 shadow-[0_22px_70px_-56px_rgba(76,29,149,0.35)]'
      } rounded-2xl`}
    >
      <div className="flex items-center gap-2 px-3 py-3">
        <button
          type="button"
          onClick={() => onCollapsedChange?.(true)}
          data-testid="leftrail-collapse-toggle"
          title="Collapse workspace rail"
          className={`inline-flex h-8 w-8 items-center justify-center rounded-xl transition-colors ${
            isDark
              ? 'text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-100'
              : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900'
          }`}
        >
          <PanelLeftClose className="h-4 w-4" />
        </button>
        <div className="min-w-0">
          <p className={`text-[10px] font-bold uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
            {t('nav.workspace')}
          </p>
          <p className={`truncate text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
            {t('workspace.leftRail.sessions')} / {t('workspace.leftRail.devices')}
          </p>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          <Section
            title={t('nav.workspace')}
            detail={
              activeSurface === 'tasks'
                ? t('workspace.leftRail.tasks')
                : activeSurface === 'contacts'
                  ? t('workspace.leftRail.contacts')
                  : activeSurface === 'library'
                    ? t('workspace.leftRail.library')
                    : t('workspace.leftRail.devices')
            }
            isDark={isDark}
            collapsed={false}
            onToggleCollapsed={() => undefined}
          >
            <RailNavItem
              isDark={isDark}
              active={activeSurface === 'tasks'}
              icon={<KanbanSquare className="h-4 w-4" />}
              label={t('workspace.taskBoard.title')}
              detail="Kanban"
              onClick={() => onSelectSurface('tasks')}
            />
            <RailNavItem
              isDark={isDark}
              active={activeSurface === 'contacts'}
              icon={<Contact className="h-4 w-4" />}
              label={t('workspace.leftRail.contacts')}
              detail={`${contacts.length} friends`}
              onClick={() => onSelectSurface('contacts')}
              data-testid="leftrail-contacts-tile"
              data-pending-requests={pendingContactRequests}
              trailing={
                pendingContactRequests > 0 ? (
                  <span
                    data-testid="leftrail-contacts-pending-badge"
                    className="rounded-full bg-rose-500 px-1.5 py-0.5 text-[10px] font-semibold text-white"
                  >
                    {pendingContactRequests > 99 ? '99+' : pendingContactRequests}
                  </span>
                ) : null
              }
            />
            <RailNavItem
              isDark={isDark}
              active={activeSurface === 'library'}
              icon={<Library className="h-4 w-4" />}
              label={t('workspace.leftRail.library')}
              detail={`${assets.length} files`}
              onClick={() => onSelectSurface('library')}
              testId="leftrail-library"
              trailing={
                pendingMemoryProposals > 0 ? (
                  <span
                    data-testid="leftrail-library-proposal-dot"
                    data-pending-proposals={pendingMemoryProposals}
                    title={`${pendingMemoryProposals} memory proposal${pendingMemoryProposals === 1 ? '' : 's'} waiting review`}
                    className="h-2 w-2 shrink-0 rounded-full bg-rose-500"
                  />
                ) : null
              }
            />
            <RailNavItem
              isDark={isDark}
              active={activeSurface === 'runtime'}
              icon={<Smartphone className="h-4 w-4" />}
              label={t('workspace.leftRail.devices')}
              detail={`${devices.length} devices${onlineDeviceCount > 0 ? ` · ${onlineDeviceCount} online` : ''} · ${agents.length} agents`}
              onClick={() => onSelectSurface('runtime')}
              testId="leftrail-runtime"
              trailing={
                devices.length > 0 ? (
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${onlineDeviceCount > 0 ? 'bg-emerald-500' : 'bg-zinc-500'}`}
                  />
                ) : null
              }
            />
          </Section>

          <Section
            title={t('workspace.leftRail.sessions')}
            detail={`${sessions.length}`}
            isDark={isDark}
            collapsed={collapsedSections.sessions}
            onToggleCollapsed={() => toggleSection('sessions')}
            action={
              /*
                §30 B3.7 — collapsed two MiniActions ("New agent" Bot
                icon + "New session" Plus icon) into a single `+`
                shortcut that opens the unified creation modal. Per the
                B0 audit, list "+" shortcuts route to the unified modal
                rather than the previous per-dialog triggers. Users
                pick the entity inside the modal.
              */
              onNewSession ? (
                <span className="flex items-center gap-1">
                  <MiniAction
                    isDark={isDark}
                    title="New session"
                    testId="leftrail-new-session"
                    onClick={onNewSession}
                  />
                </span>
              ) : onOpenCreation ? (
                <span className="flex items-center gap-1">
                  <MiniAction
                    isDark={isDark}
                    title="Create"
                    testId="leftrail-unified-create"
                    onClick={onOpenCreation}
                  />
                </span>
              ) : null
            }
          >
            {sessions.length === 0 ? (
              <EmptyHint isDark={isDark} text={t('workspace.leftRail.noSessions')} />
            ) : (
              sessions.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  isDark={isDark}
                  active={session.id === selectedSessionId}
                  now={now}
                  onClick={() => onSelectSession(session.id)}
                  onRename={onRenameSession ? () => onRenameSession(session) : undefined}
                  onArchive={onArchiveSession ? () => onArchiveSession(session) : undefined}
                  onDelete={onDeleteSession ? () => onDeleteSession(session) : undefined}
                />
              ))
            )}
          </Section>
        </div>

        <div
          className={`relative z-10 shrink-0 px-2 pb-3 pt-2 ${
            isDark
              ? 'border-t border-white/[0.05] bg-zinc-950/75 shadow-[0_-18px_42px_-32px_rgba(0,0,0,0.95)]'
              : 'border-t border-zinc-200/70 bg-white/88 shadow-[0_-18px_42px_-34px_rgba(39,39,42,0.45)]'
          }`}
        >
          <TodayOverview
            isDark={isDark}
            tasksCount={tasksCount}
            inProgressCount={inProgressCount}
            doneCount={doneCount}
          />
        </div>
      </div>
    </aside>
  );
}

function TodayOverview({
  isDark,
  tasksCount,
  inProgressCount,
  doneCount,
}: {
  isDark: boolean;
  tasksCount: number;
  inProgressCount: number;
  doneCount: number;
}) {
  const { t } = useI18n();
  const openCount = Math.max(0, tasksCount - inProgressCount - doneCount);
  const completion = tasksCount > 0 ? Math.round((doneCount / tasksCount) * 100) : 0;
  const segments = [
    { label: t('workspace.leftRail.open'), value: openCount, tone: isDark ? 'bg-violet-400' : 'bg-violet-500' },
    { label: t('workspace.leftRail.working'), value: inProgressCount, tone: isDark ? 'bg-amber-300' : 'bg-amber-400' },
    { label: t('workspace.leftRail.done'), value: doneCount, tone: isDark ? 'bg-emerald-300' : 'bg-emerald-500' },
  ];

  return (
    <div
      className={`rounded-2xl border p-3 ${
        isDark ? 'border-white/[0.06] bg-white/[0.018]' : 'border-zinc-200/80 bg-white/45'
      }`}
    >
      <div className="flex items-center justify-between">
        <p className={`text-xs font-semibold ${isDark ? 'text-zinc-200' : 'text-zinc-900'}`}>
          {t('workspace.leftRail.today')}
        </p>
        <BarChart3 className={`h-3.5 w-3.5 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`} />
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        <OverviewStat isDark={isDark} value={tasksCount} label={t('workspace.leftRail.tasks')} tone="text-violet-500" />
        <OverviewStat
          isDark={isDark}
          value={inProgressCount}
          label={t('workspace.leftRail.inProgress')}
          tone="text-zinc-700"
        />
        <OverviewStat isDark={isDark} value={doneCount} label={t('workspace.leftRail.done')} tone="text-emerald-500" />
      </div>

      <div className="mt-4 min-w-0">
        <div className="mb-1.5 flex items-center justify-between gap-2 text-[10px]">
          <span className={isDark ? 'text-zinc-500' : 'text-zinc-500'}>{t('workspace.leftRail.completion')}</span>
          <span className={`font-semibold tabular-nums ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
            {completion}%
          </span>
        </div>
        <div className={`h-2 overflow-hidden rounded-full ${isDark ? 'bg-white/[0.06]' : 'bg-zinc-200/80'}`}>
          <div
            className="h-full rounded-full bg-gradient-to-r from-violet-500 via-cyan-400 to-emerald-400 transition-[width]"
            style={{ width: `${completion}%` }}
          />
        </div>
      </div>

      <div className="mt-3 grid min-w-0 grid-cols-3 gap-1.5">
        {segments.map((segment) => (
          <div
            key={segment.label}
            className={`min-w-0 rounded-xl border px-2 py-1.5 ${
              isDark ? 'border-white/[0.06] bg-white/[0.025]' : 'border-zinc-200/70 bg-white/60'
            }`}
          >
            <div className="flex min-w-0 items-center gap-1.5">
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${segment.tone}`} />
              <span className={`truncate text-[9px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                {segment.label}
              </span>
            </div>
            <p
              className={`mt-1 truncate text-xs font-semibold tabular-nums ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}
            >
              {segment.value}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function OverviewStat({ isDark, value, label, tone }: { isDark: boolean; value: number; label: string; tone: string }) {
  return (
    <div className="min-w-0">
      <p className={`truncate text-sm font-bold ${tone}`}>{value}</p>
      <p className={`truncate text-[9px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>{label}</p>
    </div>
  );
}

function RailNavItem({
  isDark,
  active,
  icon,
  label,
  detail,
  onClick,
  trailing,
  testId,
  ...dataAttrs
}: {
  isDark: boolean;
  active: boolean;
  icon: React.ReactNode;
  label: string;
  detail: string;
  onClick: () => void;
  trailing?: React.ReactNode;
  testId?: string;
} & Record<string, unknown>) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId ?? (typeof dataAttrs['data-testid'] === 'string' ? dataAttrs['data-testid'] : undefined)}
      data-pending-requests={
        typeof dataAttrs['data-pending-requests'] === 'number'
          ? (dataAttrs['data-pending-requests'] as number)
          : undefined
      }
      className={`group relative flex w-full items-center gap-2 rounded-2xl px-2.5 py-2 text-left transition-[background-color,color,box-shadow] ${
        active
          ? isDark
            ? 'bg-violet-500/16 text-violet-100 shadow-[0_14px_38px_-26px_rgba(139,92,246,0.9)]'
            : 'bg-violet-100/80 text-violet-950 shadow-[0_14px_38px_-28px_rgba(124,58,237,0.55)]'
          : isDark
            ? 'text-zinc-300 hover:bg-white/[0.045]'
            : 'text-zinc-700 hover:bg-zinc-100/80'
      }`}
    >
      {active ? (
        <span className="absolute left-0 top-1/2 h-7 w-1 -translate-y-1/2 rounded-full bg-gradient-to-b from-violet-400 to-cyan-300" />
      ) : null}
      <span
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl ${
          active
            ? isDark
              ? 'bg-white/[0.08] text-violet-100'
              : 'bg-white/75 text-violet-700'
            : isDark
              ? 'bg-white/[0.04] text-zinc-400 group-hover:text-zinc-200'
              : 'bg-white text-zinc-500 group-hover:text-zinc-800'
        }`}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-semibold">{label}</span>
        <span
          className={`block truncate text-[10px] ${active ? 'opacity-70' : isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
        >
          {detail}
        </span>
      </span>
      {trailing}
    </button>
  );
}

function SessionRow({
  session,
  active,
  isDark,
  now,
  onClick,
  onRename,
  onArchive,
  onDelete,
}: {
  session: ConversationDTO;
  active: boolean;
  isDark: boolean;
  now: number;
  onClick: () => void;
  onRename?: () => void;
  onArchive?: () => void;
  onDelete?: () => void;
}) {
  const isGroup = session.type !== 'direct';
  return (
    <motion.div
      layout
      data-testid={`leftrail-session-${session.id}`}
      data-pinned={session.pinned ? 'true' : undefined}
      data-muted={session.muted ? 'true' : undefined}
      whileTap={{ scale: 0.985 }}
      transition={springSnap}
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
        <motion.span
          layoutId="active-session-rail"
          className="absolute left-0 top-1/2 h-7 w-1 -translate-y-1/2 rounded-full bg-gradient-to-b from-violet-400 to-cyan-300"
          transition={springSoft}
        />
      ) : null}
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <span
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl ${
            active ? (isDark ? 'bg-white/[0.08]' : 'bg-white/70') : isDark ? 'bg-white/[0.04]' : 'bg-white'
          }`}
        >
          {isGroup ? <Users className="h-4 w-4" /> : <MessageSquare className="h-4 w-4" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-semibold">{sessionLabel(session)}</span>
          <span
            className={`block truncate text-[10px] ${active ? 'opacity-75' : isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
          >
            {session.lastMessageAt ? formatRelative(session.lastMessageAt, now) : 'No messages yet'}
          </span>
        </span>
      </button>
      {session.unreadCount && session.unreadCount > 0 ? (
        <span className="rounded-full bg-violet-500 px-1.5 py-0.5 text-[10px] font-semibold text-white">
          {session.unreadCount}
        </span>
      ) : null}
      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        {onRename ? (
          <RailTinyButton isDark={isDark} title="Rename session" onClick={onRename}>
            <Edit3 className="h-3 w-3" />
          </RailTinyButton>
        ) : null}
        {onArchive ? (
          <RailTinyButton isDark={isDark} title="Archive session" onClick={onArchive}>
            <Archive className="h-3 w-3" />
          </RailTinyButton>
        ) : null}
        {onDelete ? (
          <RailTinyButton isDark={isDark} title="Leave session" onClick={onDelete}>
            <LogOut className="h-3 w-3" />
          </RailTinyButton>
        ) : null}
      </span>
    </motion.div>
  );
}

function RailTinyButton({
  isDark,
  title,
  onClick,
  children,
}: {
  isDark: boolean;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
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

function Section({
  title,
  detail,
  children,
  isDark,
  collapsed,
  onToggleCollapsed,
  action,
}: {
  title: string;
  detail?: string;
  children: React.ReactNode;
  isDark: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  action?: React.ReactNode;
}) {
  return (
    <div className="py-2">
      <div className="mb-1 flex items-center px-1">
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-expanded={!collapsed}
          className={`flex min-w-0 flex-1 items-center gap-1 text-left text-[10px] font-bold uppercase tracking-wider ${
            isDark ? 'text-zinc-500 hover:text-zinc-300' : 'text-zinc-500 hover:text-zinc-700'
          }`}
        >
          {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          <span>{title}</span>
          {detail ? <span className="ml-1 opacity-60">{detail}</span> : null}
        </button>
        {action}
      </div>
      <AnimatePresence initial={false}>
        {!collapsed ? (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={springSoft}
            className="overflow-hidden space-y-1"
          >
            {children}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function MiniAction({
  isDark,
  title,
  testId,
  onClick,
  icon,
}: {
  isDark: boolean;
  title: string;
  testId?: string;
  onClick: () => void;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      title={title}
      className={`inline-flex h-6 w-6 items-center justify-center rounded-lg ${
        isDark
          ? 'text-zinc-400 hover:bg-white/[0.05] hover:text-violet-200'
          : 'text-zinc-500 hover:bg-zinc-200 hover:text-violet-700'
      }`}
    >
      {icon ?? <Plus className="h-3.5 w-3.5" />}
    </button>
  );
}

function IconButton({
  isDark,
  title,
  onClick,
  children,
}: {
  isDark: boolean;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`inline-flex h-9 w-9 items-center justify-center rounded-xl ${
        isDark ? 'text-zinc-400 hover:bg-white/[0.05]' : 'text-zinc-500 hover:bg-zinc-100'
      }`}
    >
      {children}
    </button>
  );
}

function EmptyHint({ isDark, text }: { isDark: boolean; text: string }) {
  return (
    <p
      className={`rounded-2xl border border-dashed px-3 py-3 text-xs ${isDark ? 'border-white/[0.06] text-zinc-500' : 'border-zinc-200 text-zinc-500'}`}
    >
      {text}
    </p>
  );
}
