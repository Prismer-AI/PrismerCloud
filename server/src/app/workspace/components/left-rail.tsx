'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  BarChart3,
  ChevronDown,
  ChevronRight,
  KanbanSquare,
  LineChart,
  Library,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Smartphone,
} from 'lucide-react';

import { springSoft } from '../lib/design';
import { useI18n } from '@/contexts/i18n-context';
import type {
  AgentDTO,
  AssetDTO,
  ContactFriendDTO,
  ConversationDTO,
  RuntimeDeviceDTO,
  WorkspaceRuntimeDTO,
} from '../lib/types';

/**
 * release201 S12 — `insights` joins chats/tasks/library/runtime as a peer
 * surface. ProjectSwitcher moved to the TopBar (workspace-level scope),
 * so the rail is purely "entries inside the currently active project".
 */
export type WorkspaceSurface = 'chats' | 'insights' | 'tasks' | 'library' | 'runtime';

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
  /** Memory Line B / B7 — pending memory proposal count drives the Assets tile red dot. */
  pendingMemoryProposals?: number;
  /**
   * Wave 3 C2 §4.8.2.3 — contested agent-binding count surfaces the multi-
   * daemon binding race directly on the rail. Drives a red warning badge
   * on the Devices tile when > 0, so users see the §1.5 jasonzhou case
   * (binding race) **before** opening the Devices surface. Sourced from
   * `GET /api/im/workspaces/:wsId/agent-bindings`.
   */
  contestedBindingCount?: number;
  assets: AssetDTO[];
  agents: AgentDTO[];
  runtime: WorkspaceRuntimeDTO | null;
  activeSurface: WorkspaceSurface;
  onSelectSurface: (surface: WorkspaceSurface) => void;
  /**
   * §30 B3.7 — unified creation entry for the nav surface (device/agent
   * creation). Opens `<UnifiedCreationModal>` for the collapsed + the
   * RuntimeManager panel.
   */
  onOpenCreation?: () => void;
}

const DEVICE_ONLINE_WINDOW_MS = 90_000;

function isDeviceOnline(device: RuntimeDeviceDTO, now: number): boolean {
  if (!device.lastSeenAt) return false;
  const ts = Date.parse(device.lastSeenAt);
  if (Number.isNaN(ts)) return false;
  return now - ts <= DEVICE_ONLINE_WINDOW_MS;
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
  contestedBindingCount = 0,
  assets,
  agents,
  runtime,
  activeSurface,
  onSelectSurface,
  onOpenCreation,
}: LeftRailProps) {
  const { t } = useI18n();
  const [now, setNow] = useState(0);
  const [collapsedPreviewOpen, setCollapsedPreviewOpen] = useState(false);
  const devices = useMemo(() => runtime?.devices ?? [], [runtime]);
  const onlineDeviceCount = useMemo(() => devices.filter((d) => isDeviceOnline(d, now)).length, [devices, now]);
  const chatsLabel = t('workspace.shell.chats');
  const workspaceDevicesTitle = t('workspace.shell.workspaceDevicesTitle', {
    devices: t('workspace.leftRail.devices'),
  });
  const sessionsContactsSummary = t('workspace.shell.sessionsContactsSummary', {
    sessions: sessions.length,
    contacts: contacts.length,
  });
  const tasksDoneSummary = t('workspace.shell.tasksDoneSummary', {
    total: tasksCount,
    working: inProgressCount,
    done: doneCount,
  });
  const assetsSummary =
    pendingMemoryProposals > 0
      ? t('workspace.shell.assetsProposalsSummary', { count: assets.length, proposals: pendingMemoryProposals })
      : t('workspace.shell.assetsSummary', { count: assets.length });
  const devicesSummary =
    devices.length === 0
      ? t('workspace.shell.devicesSetup')
      : t('workspace.shell.devicesSummary', {
          devices: devices.length,
          online: onlineDeviceCount,
          agents: agents.length,
        });

  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  if (collapsed) {
    return (
      <aside
        data-testid="leftrail-collapsed"
        data-preview-open={collapsedPreviewOpen ? 'true' : 'false'}
        onMouseEnter={() => setCollapsedPreviewOpen(true)}
        onMouseLeave={() => setCollapsedPreviewOpen(false)}
        onFocus={() => setCollapsedPreviewOpen(true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setCollapsedPreviewOpen(false);
        }}
        className={`relative hidden shrink-0 flex-col overflow-hidden border transition-[width] duration-200 lg:flex ${
          isDark ? 'border-white/[0.06] bg-zinc-950/30' : 'border-zinc-200 bg-zinc-50/70'
        } ${collapsedPreviewOpen ? 'w-[260px]' : 'w-14 items-center gap-2 px-2 py-3'} rounded-2xl`}
      >
        <>
          {collapsedPreviewOpen ? (
            <div data-testid="leftrail-hover-expanded" className="flex h-full min-h-0 w-full flex-col overflow-hidden">
              <div
                className={`flex items-center gap-2 border-b px-3 py-3 ${isDark ? 'border-white/[0.06]' : 'border-zinc-200/80'}`}
              >
                <button
                  type="button"
                  onClick={() => onCollapsedChange?.(false)}
                  title={t('workspace.shell.expandNavigation')}
                  aria-label={t('workspace.shell.expandNavigation')}
                  className={`inline-flex h-8 w-8 items-center justify-center rounded-xl transition-colors ${
                    isDark
                      ? 'text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-100'
                      : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900'
                  }`}
                >
                  <PanelLeftOpen className="h-4 w-4" />
                </button>
                <div className="min-w-0">
                  <p
                    className={`text-[10px] font-bold uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
                  >
                    {t('nav.workspace')}
                  </p>
                  <p className={`truncate text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
                    {workspaceDevicesTitle}
                  </p>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
                <RailNavItem
                  isDark={isDark}
                  active={activeSurface === 'insights'}
                  icon={<LineChart className="h-4 w-4" />}
                  label={t('workspace.leftRail.insights')}
                  detail={t('workspace.leftRail.insightsDetail')}
                  onClick={() => onSelectSurface('insights')}
                  testId="leftrail-flyout-insights"
                />
                <RailNavItem
                  isDark={isDark}
                  active={activeSurface === 'chats'}
                  icon={<MessageSquare className="h-4 w-4" />}
                  label={chatsLabel}
                  detail={sessionsContactsSummary}
                  onClick={() => onSelectSurface('chats')}
                  testId="leftrail-flyout-chats"
                  trailing={
                    pendingContactRequests > 0 ? (
                      <span className="rounded-full bg-rose-500 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                        {pendingContactRequests > 99 ? '99+' : pendingContactRequests}
                      </span>
                    ) : null
                  }
                />
                <RailNavItem
                  isDark={isDark}
                  active={activeSurface === 'tasks'}
                  icon={<KanbanSquare className="h-4 w-4" />}
                  label={t('workspace.taskBoard.title')}
                  detail={t('workspace.shell.tasksSummary', { total: tasksCount, working: inProgressCount })}
                  onClick={() => onSelectSurface('tasks')}
                  testId="leftrail-flyout-tasks"
                />
                <RailNavItem
                  isDark={isDark}
                  active={activeSurface === 'library'}
                  icon={<Library className="h-4 w-4" />}
                  label={t('workspace.leftRail.assets')}
                  detail={assetsSummary}
                  onClick={() => onSelectSurface('library')}
                  testId="leftrail-flyout-library"
                  trailing={
                    pendingMemoryProposals > 0 ? <span className="h-2 w-2 shrink-0 rounded-full bg-rose-500" /> : null
                  }
                />
                <RailNavItem
                  isDark={isDark}
                  active={activeSurface === 'runtime'}
                  icon={<Smartphone className="h-4 w-4" />}
                  label={t('workspace.leftRail.devices')}
                  detail={devicesSummary}
                  onClick={() => onSelectSurface('runtime')}
                  testId="leftrail-flyout-runtime"
                  trailing={
                    contestedBindingCount > 0 ? (
                      <span className="rounded-full bg-rose-500 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                        {contestedBindingCount > 99 ? '99+' : contestedBindingCount}
                      </span>
                    ) : null
                  }
                />
                {onOpenCreation ? (
                  <RailNavItem
                    isDark={isDark}
                    active={false}
                    icon={<Plus className="h-4 w-4" />}
                    label={t('workspace.shell.create')}
                    detail={t('workspace.shell.createDetail')}
                    onClick={onOpenCreation}
                    testId="leftrail-flyout-create"
                  />
                ) : null}
              </div>
              <div
                className={`shrink-0 px-2 pb-2 pt-1 ${
                  isDark ? 'border-t border-white/[0.05] bg-zinc-950/65' : 'border-t border-zinc-200/70 bg-white/85'
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
          ) : (
            <div className="flex flex-col items-center gap-2">
              <div className="relative z-40">
                <IconButton
                  isDark={isDark}
                  title={t('workspace.shell.expandNavigation')}
                  onClick={() => onCollapsedChange?.(false)}
                >
                  <PanelLeftOpen className="h-4 w-4" />
                </IconButton>
              </div>
              <CollapsedRailItem
                isDark={isDark}
                title={t('workspace.leftRail.insights')}
                detail={t('workspace.leftRail.insightsDetail')}
                active={activeSurface === 'insights'}
                onClick={() => onSelectSurface('insights')}
                testId="leftrail-collapsed-insights"
              >
                <LineChart className="h-4 w-4" />
              </CollapsedRailItem>
              <CollapsedRailItem
                isDark={isDark}
                title={chatsLabel}
                detail={sessionsContactsSummary}
                active={activeSurface === 'chats'}
                badge={
                  pendingContactRequests > 0
                    ? pendingContactRequests > 99
                      ? '99+'
                      : String(pendingContactRequests)
                    : null
                }
                onClick={() => onSelectSurface('chats')}
                testId="leftrail-chats"
              >
                <MessageSquare className="h-4 w-4" />
              </CollapsedRailItem>
              <CollapsedRailItem
                isDark={isDark}
                title={t('workspace.leftRail.tasks')}
                detail={tasksDoneSummary}
                active={activeSurface === 'tasks'}
                onClick={() => onSelectSurface('tasks')}
              >
                <KanbanSquare className="h-4 w-4" />
              </CollapsedRailItem>
              <CollapsedRailItem
                isDark={isDark}
                title={t('workspace.leftRail.assets')}
                detail={assetsSummary}
                active={activeSurface === 'library'}
                badge={pendingMemoryProposals > 0 ? '!' : null}
                onClick={() => onSelectSurface('library')}
                testId="leftrail-library"
              >
                <Library className="h-4 w-4" />
              </CollapsedRailItem>
              <CollapsedRailItem
                isDark={isDark}
                title={t('workspace.leftRail.devices')}
                detail={devicesSummary}
                active={activeSurface === 'runtime'}
                badge={
                  contestedBindingCount > 0
                    ? contestedBindingCount > 99
                      ? '99+'
                      : String(contestedBindingCount)
                    : null
                }
                onClick={() => onSelectSurface('runtime')}
                testId="leftrail-runtime"
              >
                <Smartphone className="h-4 w-4" />
              </CollapsedRailItem>
              {onOpenCreation ? (
                <CollapsedRailItem
                  isDark={isDark}
                  title={t('workspace.shell.create')}
                  detail={t('workspace.shell.createDetail')}
                  onClick={onOpenCreation}
                >
                  <Plus className="h-4 w-4" />
                </CollapsedRailItem>
              ) : null}
            </div>
          )}
        </>
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
          title={t('workspace.shell.collapseNavigation')}
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
            {workspaceDevicesTitle}
          </p>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          <Section
            title={t('nav.workspace')}
            detail={
              activeSurface === 'insights'
                ? t('workspace.leftRail.insights')
                : activeSurface === 'chats'
                  ? chatsLabel
                  : activeSurface === 'tasks'
                    ? t('workspace.leftRail.tasks')
                    : activeSurface === 'library'
                      ? t('workspace.leftRail.assets')
                      : t('workspace.leftRail.devices')
            }
            isDark={isDark}
            collapsed={false}
            onToggleCollapsed={() => undefined}
          >
            <RailNavItem
              isDark={isDark}
              active={activeSurface === 'insights'}
              icon={<LineChart className="h-4 w-4" />}
              label={t('workspace.leftRail.insights')}
              detail={t('workspace.leftRail.insightsDetail')}
              onClick={() => onSelectSurface('insights')}
              testId="leftrail-insights"
            />
            <RailNavItem
              isDark={isDark}
              active={activeSurface === 'chats'}
              icon={<MessageSquare className="h-4 w-4" />}
              label={chatsLabel}
              detail={sessionsContactsSummary}
              onClick={() => onSelectSurface('chats')}
              testId="leftrail-chats"
              trailing={
                pendingContactRequests > 0 ? (
                  <span
                    data-testid="leftrail-chats-pending-badge"
                    className="rounded-full bg-rose-500 px-1.5 py-0.5 text-[10px] font-semibold text-white"
                  >
                    {pendingContactRequests > 99 ? '99+' : pendingContactRequests}
                  </span>
                ) : null
              }
            />
            <RailNavItem
              isDark={isDark}
              active={activeSurface === 'tasks'}
              icon={<KanbanSquare className="h-4 w-4" />}
              label={t('workspace.taskBoard.title')}
              detail={t('workspace.leftRail.kanban')}
              onClick={() => onSelectSurface('tasks')}
            />
            <RailNavItem
              isDark={isDark}
              active={activeSurface === 'library'}
              icon={<Library className="h-4 w-4" />}
              label={t('workspace.leftRail.assets')}
              detail={t('workspace.shell.assetsSummary', { count: assets.length })}
              onClick={() => onSelectSurface('library')}
              testId="leftrail-library"
              trailing={
                pendingMemoryProposals > 0 ? (
                  <span
                    data-testid="leftrail-library-proposal-dot"
                    data-pending-proposals={pendingMemoryProposals}
                    title={t('workspace.leftRail.memoryProposalsWaiting', { count: pendingMemoryProposals })}
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
              detail={
                devices.length === 0
                  ? `${t('workspace.shell.devicesSetup')} →`
                  : contestedBindingCount > 0
                    ? t('workspace.shell.devicesContestedSummary', {
                        devices: devices.length,
                        contested: contestedBindingCount,
                        agents: agents.length,
                      })
                    : t('workspace.shell.devicesSummary', {
                        devices: devices.length,
                        online: onlineDeviceCount,
                        agents: agents.length,
                      })
              }
              onClick={() => onSelectSurface('runtime')}
              testId="leftrail-runtime"
              data-contested-bindings={contestedBindingCount}
              trailing={
                contestedBindingCount > 0 ? (
                  <span
                    data-testid="leftrail-runtime-contested-badge"
                    title={t('workspace.shell.devicesContestedSummary', {
                      devices: devices.length,
                      contested: contestedBindingCount,
                      agents: agents.length,
                    })}
                    className="rounded-full bg-rose-500 px-1.5 py-0.5 text-[10px] font-semibold text-white"
                  >
                    {contestedBindingCount > 99 ? '99+' : contestedBindingCount}
                  </span>
                ) : devices.length === 0 ? (
                  <span
                    data-testid="leftrail-runtime-setup-cue"
                    title={t('workspace.shell.devicesSetup')}
                    className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-violet-500 shadow-[0_0_8px_rgba(139,92,246,0.85)]"
                  />
                ) : (
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${onlineDeviceCount > 0 ? 'bg-emerald-500' : 'bg-zinc-500'}`}
                  />
                )
              }
            />
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
      data-contested-bindings={
        typeof dataAttrs['data-contested-bindings'] === 'number'
          ? (dataAttrs['data-contested-bindings'] as number)
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

function CollapsedRailItem({
  isDark,
  title,
  active = false,
  badge = null,
  onClick,
  testId,
  children,
}: {
  isDark: boolean;
  title: string;
  detail: string;
  active?: boolean;
  badge?: string | null;
  onClick: () => void;
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="group relative z-30">
      <IconButton isDark={isDark} title={title} active={active} onClick={onClick} testId={testId}>
        {children}
        {badge ? (
          <span
            className={`absolute -right-1 -top-1 min-w-4 rounded-full px-1 text-[9px] font-bold leading-4 ${
              isDark ? 'bg-rose-400 text-zinc-950' : 'bg-rose-500 text-white'
            }`}
          >
            {badge}
          </span>
        ) : null}
      </IconButton>
    </div>
  );
}

function IconButton({
  isDark,
  title,
  active = false,
  onClick,
  testId,
  children,
}: {
  isDark: boolean;
  title: string;
  active?: boolean;
  onClick: () => void;
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      data-testid={testId}
      className={`relative inline-flex h-9 w-9 items-center justify-center rounded-xl transition-colors ${
        active
          ? isDark
            ? 'bg-violet-500/16 text-violet-100 shadow-[0_14px_34px_-24px_rgba(139,92,246,0.9)]'
            : 'bg-violet-100 text-violet-700 shadow-[0_14px_34px_-26px_rgba(124,58,237,0.45)]'
          : isDark
            ? 'text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-100'
            : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900'
      }`}
    >
      {active ? (
        <span className="absolute left-0 h-5 w-0.5 rounded-full bg-gradient-to-b from-violet-400 to-cyan-300" />
      ) : null}
      {children}
    </button>
  );
}
