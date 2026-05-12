'use client';

import { Loader2, RefreshCw, Wifi, WifiOff } from 'lucide-react';
import type { WorkspaceDTO } from '../lib/types';
import type { TaskStreamState } from '../lib/use-task-stream';
import { useI18n } from '@/contexts/i18n-context';

interface TopBarProps {
  isDark: boolean;
  workspace: WorkspaceDTO | null;
  streamState: TaskStreamState;
  onRefresh: () => void;
  refreshing: boolean;
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

export function TopBar({ isDark, workspace, streamState, onRefresh, refreshing }: TopBarProps) {
  const { t } = useI18n();
  const copy = STATE_COPY[streamState];
  const dotColor = copy.tone === 'good' ? 'bg-emerald-500' : copy.tone === 'warn' ? 'bg-amber-500' : 'bg-red-500';

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
          <span className="text-sm font-bold">{(workspace?.name ?? 'W').slice(0, 1).toUpperCase()}</span>
        </div>
        <div className="min-w-0">
          <h1 className={`truncate text-sm font-bold sm:text-base ${isDark ? 'text-white' : 'text-zinc-900'}`}>
            {workspace?.name ?? t('workspace.personal')}
          </h1>
        </div>
      </div>

      {/*
        §30 — `+ Create` button moved to the Device panel right corner
        (RuntimeManager SurfaceHeader actions slot). TopBar is reserved
        for high-frequency global actions only. The previous setup-progress
        region was dead code from before B3.7 and is NOT restored.
      */}

      <div className="flex items-center gap-2 sm:gap-3">
        <div className="hidden sm:block">
          <div
            className={`flex items-center gap-1.5 rounded-xl border px-2.5 py-1 text-xs font-medium ${
              isDark ? 'border-white/5 bg-zinc-900 text-zinc-300' : 'border-zinc-200 bg-zinc-50 text-zinc-700'
            }`}
            title={t(copy.key)}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${dotColor}`} />
            {streamState === 'sse' ? (
              <Wifi className="h-3 w-3" />
            ) : streamState === 'offline' ? (
              <WifiOff className="h-3 w-3" />
            ) : null}
            {t(copy.key)}
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
      </div>
    </header>
  );
}
