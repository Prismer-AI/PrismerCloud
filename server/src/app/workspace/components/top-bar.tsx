'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { Cloud, CloudOff, Cpu, Loader2, RefreshCw, Settings, Wifi, WifiOff } from 'lucide-react';
import type { WorkspaceDTO, WorkspaceRuntimeDTO } from '../lib/types';
import type { TaskStreamState } from '../lib/use-task-stream';
import { useI18n } from '@/contexts/i18n-context';

type WorkspaceT = ReturnType<typeof useI18n>['t'];

interface TopBarProps {
  isDark: boolean;
  workspace: WorkspaceDTO | null;
  streamState: TaskStreamState;
  /**
   * Workspace runtime topology (devices + agent heartbeats). Powers the
   * "local device online" rows in the connectivity hover popover.
   */
  runtime: WorkspaceRuntimeDTO | null;
  onRefresh: () => void;
  refreshing: boolean;
  /**
   * release201 S12 — workspace-level ProjectSwitcher. Rendered in the
   * top bar (immediately right of the workspace identity badge) because
   * switching projects affects *every* surface (chats / tasks / library /
   * insights). LeftRail entries are scoped *inside* the active project,
   * so they cannot host the switcher.
   */
  projectSwitcher?: ReactNode;
  /**
   * §30 — `+ Create` button was previously here, then relocated to the
   * Device (RuntimeManager) panel's right corner where team creation
   * actually belongs. TopBar is reserved for high-frequency global
   * actions (notifications, refresh, theme). No prop is needed here
   * anymore — `setUnifiedOpen` lives in page.tsx and is wired through
   * RuntimeManager and LeftRail.
   */
}

const STATE_COPY: Record<
  TaskStreamState,
  {
    key:
      | 'workspace.stream.connecting'
      | 'workspace.stream.live'
      | 'workspace.stream.polling'
      | 'workspace.stream.offline';
    tone: 'good' | 'warn' | 'bad';
  }
> = {
  connecting: { key: 'workspace.stream.connecting', tone: 'warn' },
  sse: { key: 'workspace.stream.live', tone: 'good' },
  polling: { key: 'workspace.stream.polling', tone: 'warn' },
  offline: { key: 'workspace.stream.offline', tone: 'bad' },
};

/** Tone for a single connectivity channel — drives the dot color. */
type ChannelTone = 'good' | 'warn' | 'bad' | 'idle';

function toneDotClass(tone: ChannelTone): string {
  switch (tone) {
    case 'good':
      return 'bg-emerald-500';
    case 'warn':
      return 'bg-amber-500';
    case 'bad':
      return 'bg-red-500';
    default:
      return 'bg-zinc-400';
  }
}

function formatRelative(iso: string | null | undefined, t: WorkspaceT): string | null {
  if (!iso) return null;
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return null;
  const diff = Date.now() - time;
  if (diff < 0) return t('workspace.topbar.justNow');
  const s = Math.floor(diff / 1000);
  if (s < 60) return t('workspace.topbar.secondsAgo', { count: s });
  const m = Math.floor(s / 60);
  if (m < 60) return t('workspace.topbar.minutesAgo', { count: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t('workspace.topbar.hoursAgo', { count: h });
  const d = Math.floor(h / 24);
  return t('workspace.topbar.daysAgo', { count: d });
}

export function TopBar({
  isDark,
  workspace,
  streamState,
  runtime,
  onRefresh,
  refreshing,
  projectSwitcher,
}: TopBarProps) {
  const { t } = useI18n();
  const copy = STATE_COPY[streamState];

  const organizationName =
    typeof workspace?.metadata?.organizationName === 'string' && workspace.metadata.organizationName.trim()
      ? workspace.metadata.organizationName.trim()
      : null;
  const displayName = organizationName ?? workspace?.name ?? t('workspace.personal');

  // ── Channel aggregation ────────────────────────────────────────────────
  // Cloud channel is driven by the task SSE stream.
  const cloudTone: ChannelTone =
    streamState === 'sse' ? 'good' : streamState === 'polling' || streamState === 'connecting' ? 'warn' : 'bad';
  const cloudLabel =
    streamState === 'sse'
      ? t('workspace.topbar.connectivity.cloud.live')
      : streamState === 'polling'
        ? t('workspace.topbar.connectivity.cloud.polling')
        : streamState === 'connecting'
          ? t('workspace.topbar.connectivity.cloud.connecting')
          : t('workspace.topbar.connectivity.cloud.offline');

  // Local devices come from the workspace runtime snapshot. Each daemon
  // reports a `daemonStatus` (connected | stale | offline) derived from
  // heartbeat freshness server-side.
  const devices = runtime?.devices ?? [];
  const connectedDevices = devices.filter((d) => d.daemonStatus === 'connected');
  const localTone: ChannelTone =
    devices.length === 0
      ? 'idle'
      : connectedDevices.length > 0
        ? 'good'
        : devices.some((d) => d.daemonStatus === 'stale')
          ? 'warn'
          : 'bad';
  const localLabel =
    devices.length === 0
      ? t('workspace.topbar.connectivity.local.empty')
      : t('workspace.topbar.connectivity.local.online', {
          online: connectedDevices.length,
          total: devices.length,
        });

  // NOTE: Mobile/Lumin channel intentionally not rendered yet — there is no
  // presence feed wired into the workspace runtime, and a permanently-idle
  // "Not paired" row reads as a broken feature. When the mobile presence
  // signal lands, add a `mobileTone`/`mobileLabel` derivation here and a
  // `<ChannelRow icon={<Smartphone />} ... />` below the local-device row.
  // Keep this seam co-located with the other channel derivations.

  // Roll-up tone for the pill itself: red if anything is bad, amber if any
  // warn, green if cloud + at least one device are good.
  const rollupTone: ChannelTone =
    cloudTone === 'bad' ? 'bad' : cloudTone === 'warn' || localTone === 'warn' ? 'warn' : 'good';

  return (
    <header
      className={`relative mx-4 mt-3 flex min-h-[58px] shrink-0 items-center justify-between gap-4 rounded-2xl border px-4 py-2 sm:px-5 ${
        isDark
          ? 'border-white/[0.06] bg-zinc-950/35 shadow-[0_18px_60px_-44px_rgba(139,92,246,0.8)]'
          : 'border-zinc-200/80 bg-white/80 shadow-[0_18px_60px_-42px_rgba(76,29,149,0.35)]'
      }`}
    >
      <div className="min-w-0 flex items-center gap-3" data-tour-anchor="workspace-badge">
        <div
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${
            isDark ? 'bg-violet-500/20 text-violet-300' : 'bg-violet-100 text-violet-700'
          }`}
        >
          <span className="text-sm font-bold">{displayName.slice(0, 1).toUpperCase()}</span>
        </div>
        <div className="min-w-0">
          <h1 className={`truncate text-sm font-bold sm:text-base ${isDark ? 'text-white' : 'text-zinc-900'}`}>
            {displayName}
          </h1>
        </div>
        {projectSwitcher ? (
          <div
            data-testid="topbar-project-switcher"
            className={`ml-2 hidden min-w-[180px] max-w-[260px] sm:block ${
              isDark ? 'border-l border-white/[0.06]' : 'border-l border-zinc-200/70'
            } pl-2`}
          >
            {projectSwitcher}
          </div>
        ) : null}
      </div>

      {/*
        §30 — `+ Create` button moved to the Device panel right corner
        (RuntimeManager SurfaceHeader actions slot). TopBar is reserved
        for high-frequency global actions only. The previous setup-progress
        region was dead code from before B3.7 and is NOT restored.
      */}

      <div className="flex items-center gap-2 sm:gap-3">
        {/*
          Connectivity pill — hover/focus reveals a per-channel breakdown
          (cloud SSE, local daemon devices; mobile row is reserved for the
          upcoming presence feed). The pill itself shows the rollup tone so
          a glance is enough to spot any degradation.
        */}
        <div className="relative hidden sm:block group">
          <button
            type="button"
            data-testid="topbar-connectivity"
            className={`flex items-center gap-1.5 rounded-xl border px-2.5 py-1 text-xs font-medium transition-colors ${
              isDark
                ? 'border-white/5 bg-zinc-900 text-zinc-300 hover:bg-zinc-800'
                : 'border-zinc-200 bg-zinc-50 text-zinc-700 hover:bg-zinc-100'
            }`}
            aria-label={t(copy.key)}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${toneDotClass(rollupTone)}`} />
            {streamState === 'sse' ? (
              <Wifi className="h-3 w-3" />
            ) : streamState === 'offline' ? (
              <WifiOff className="h-3 w-3" />
            ) : null}
            {t(copy.key)}
          </button>

          <div
            role="dialog"
            className={`pointer-events-none absolute right-0 top-full z-40 mt-2 w-72 origin-top-right scale-95 rounded-2xl border p-3 text-xs opacity-0 shadow-xl transition group-hover:pointer-events-auto group-hover:scale-100 group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:scale-100 group-focus-within:opacity-100 ${
              isDark ? 'border-white/[0.08] bg-zinc-950/95 text-zinc-300' : 'border-zinc-200 bg-white/95 text-zinc-700'
            }`}
          >
            <p
              className={`mb-2 text-[10px] font-bold uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
            >
              {t('workspace.topbar.connectivity.title')}
            </p>

            <ChannelRow
              isDark={isDark}
              icon={cloudTone === 'bad' ? <CloudOff className="h-3.5 w-3.5" /> : <Cloud className="h-3.5 w-3.5" />}
              title={t('workspace.topbar.connectivity.cloud.label')}
              status={cloudLabel}
              tone={cloudTone}
              hint={
                streamState === 'sse'
                  ? t('workspace.topbar.connectivity.cloud.hint.sse')
                  : streamState === 'polling'
                    ? t('workspace.topbar.connectivity.cloud.hint.polling')
                    : streamState === 'connecting'
                      ? t('workspace.topbar.connectivity.cloud.hint.connecting')
                      : t('workspace.topbar.connectivity.cloud.hint.offline')
              }
            />

            <ChannelRow
              isDark={isDark}
              icon={<Cpu className="h-3.5 w-3.5" />}
              title={t('workspace.topbar.connectivity.local.label')}
              status={localLabel}
              tone={localTone}
              hint={devices.length === 0 ? t('workspace.topbar.connectivity.local.hintEmpty') : undefined}
            >
              {devices.length > 0 ? (
                <ul className="mt-1.5 space-y-1">
                  {devices.slice(0, 4).map((device) => {
                    const tone: ChannelTone =
                      device.daemonStatus === 'connected' ? 'good' : device.daemonStatus === 'stale' ? 'warn' : 'bad';
                    const seen = formatRelative(device.lastSeenAt, t);
                    return (
                      <li key={device.deviceId} className="flex items-center justify-between gap-2 text-[11px]">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${toneDotClass(tone)}`} />
                          <span className="truncate">{device.name || device.deviceId}</span>
                        </span>
                        <span className={`shrink-0 ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                          {device.daemonStatus === 'connected'
                            ? t('workspace.topbar.connectivity.local.device.online')
                            : device.daemonStatus === 'stale'
                              ? t('workspace.topbar.connectivity.local.device.stale', { time: seen ?? '—' })
                              : (seen ?? t('workspace.topbar.connectivity.local.device.offline'))}
                        </span>
                      </li>
                    );
                  })}
                  {devices.length > 4 ? (
                    <li className={`text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                      {t('workspace.topbar.connectivity.local.more', { count: devices.length - 4 })}
                    </li>
                  ) : null}
                </ul>
              ) : null}
            </ChannelRow>
          </div>
        </div>

        <button
          onClick={onRefresh}
          disabled={refreshing}
          data-testid="topbar-refresh"
          className={`flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-xs font-medium transition-colors ${
            isDark
              ? 'bg-zinc-800 hover:bg-zinc-700 text-zinc-200 disabled:opacity-50'
              : 'bg-zinc-50 hover:bg-zinc-100 text-zinc-700 disabled:opacity-50'
          }`}
        >
          {refreshing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          {t('common.refresh')}
        </button>

        {/* Settings entry — release 200 P4 Chief of Staff lives behind this link */}
        {workspace ? (
          <Link
            href={`/workspace/${encodeURIComponent(workspace.id)}/settings`}
            data-testid="topbar-settings"
            aria-label={t('workspace.topbar.workspaceSettings')}
            title={t('workspace.topbar.workspaceSettings')}
            className={`flex items-center rounded-xl px-2.5 py-1.5 text-xs font-medium transition-colors ${
              isDark ? 'bg-zinc-800 hover:bg-zinc-700 text-zinc-200' : 'bg-zinc-50 hover:bg-zinc-100 text-zinc-700'
            }`}
          >
            <Settings className="w-3.5 h-3.5" />
          </Link>
        ) : null}
      </div>
    </header>
  );
}

function ChannelRow({
  isDark,
  icon,
  title,
  status,
  tone,
  hint,
  children,
}: {
  isDark: boolean;
  icon: React.ReactNode;
  title: string;
  status: string;
  tone: ChannelTone;
  hint?: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-xl border px-2.5 py-2 ${
        isDark ? 'border-white/[0.04] bg-zinc-900/40' : 'border-zinc-100 bg-zinc-50/70'
      } mb-1.5 last:mb-0`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5">
          <span className={isDark ? 'text-zinc-400' : 'text-zinc-500'}>{icon}</span>
          <span className={`text-[11px] font-semibold ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>{title}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className={`h-1.5 w-1.5 rounded-full ${toneDotClass(tone)}`} />
          <span className={`text-[11px] ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>{status}</span>
        </span>
      </div>
      {hint ? <p className={`mt-1 text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>{hint}</p> : null}
      {children}
    </div>
  );
}
