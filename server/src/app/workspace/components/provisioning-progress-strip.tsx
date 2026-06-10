'use client';

/**
 * Provisioning progress strip — rendered inside a device card while the
 * container is mid-provisioning. Polls /api/sandboxes/:id/progress at 1s
 * cadence and renders the 7-step lifecycle.
 *
 * Migration 322 added the underlying DB columns; src/lib/provisioning-progress.ts
 * is the cloud-side emitter that writes step transitions inside
 * k8sSandbox.provisionContainer.
 *
 * Lifecycle:
 *   - poll while `progress.step` is non-null (in flight) and the installation
 *     itself reports a non-terminal phase
 *   - stop polling once `progress.step` is null (terminal), surface the
 *     final history entry (ok or error)
 */

import * as React from 'react';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { getWorkspaceToken } from '@/app/workspace/lib/im-api';
import type { ProvisioningStep, ProvisioningHistoryEntry } from '@/app/workspace/lib/types';

interface Progress {
  step: ProvisioningStep | null;
  history: ProvisioningHistoryEntry[];
  status: string;
}

const STEP_LABELS: Array<{ step: ProvisioningStep; label: string }> = [
  { step: 'container_create', label: '准备计算机' },
  { step: 'container_running', label: '计算机启动' },
  { step: 'daemon_healthy', label: '设备就绪' },
  { step: 'ws_connected', label: '连接云端' },
  { step: 'host_declared', label: '注册设备' },
  { step: 'adapter_installed', label: '安装运行环境' },
  { step: 'ready', label: '完成' },
];

export function ProvisioningProgressStrip({
  installationId,
  isDark,
  initialProgress,
}: {
  installationId: string;
  isDark: boolean;
  initialProgress?: Progress;
}): React.JSX.Element | null {
  const [progress, setProgress] = useState<Progress | null>(initialProgress ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function tick(): Promise<void> {
      try {
        // `/api/sandboxes/:id/progress` is session-bound (authorizeContainer
        // → requireAuthIdentity). Without Authorization Bearer the server
        // returns 401 and progress never updates. Match the auth pattern used
        // by sibling workspace fetches (runtime-manager.tsx line 188 etc.).
        const token = getWorkspaceToken();
        const res = await fetch(`/api/sandboxes/${encodeURIComponent(installationId)}/progress`, {
          cache: 'no-store',
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as Progress;
        if (cancelled) return;
        setProgress(data);
        setError(null);
        // Stop polling once terminal (step is null).
        if (data.step !== null) {
          timer = setTimeout(tick, 1000);
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        // Retry slower on error.
        timer = setTimeout(tick, 2000);
      }
    }

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [installationId]);

  if (!progress) return null;

  // Hide entirely once terminal AND no error — the card already reflects the
  // ready state. We still show the strip on error so the user sees what broke.
  const terminalOk = progress.step === null && !progress.history.some((h) => h.status === 'error');
  if (terminalOk) return null;

  return (
    <div
      data-testid="provisioning-progress-strip"
      className={cn(
        'mt-2 space-y-2 rounded-lg border px-3 py-2 text-[11px]',
        isDark ? 'border-white/10 bg-zinc-900/70' : 'border-zinc-200 bg-zinc-50',
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {STEP_LABELS.map((s, i) => {
          const entry = lastEntryFor(progress.history, s.step);
          const state: 'pending' | 'in_progress' | 'ok' | 'error' =
            entry?.status === 'error'
              ? 'error'
              : entry?.status === 'ok'
                ? 'ok'
                : entry?.status === 'in_progress'
                  ? 'in_progress'
                  : 'pending';
          return (
            <div
              key={s.step}
              className={cn('flex items-center gap-1', i > 0 && 'pl-2')}
              data-step={s.step}
              data-state={state}
            >
              <StateGlyph state={state} isDark={isDark} />
              <span
                className={cn(
                  state === 'in_progress'
                    ? isDark
                      ? 'text-cyan-300'
                      : 'text-cyan-700'
                    : state === 'ok'
                      ? isDark
                        ? 'text-emerald-400'
                        : 'text-emerald-700'
                      : state === 'error'
                        ? isDark
                          ? 'text-rose-400'
                          : 'text-rose-700'
                        : isDark
                          ? 'text-zinc-500'
                          : 'text-zinc-500',
                )}
              >
                {s.label}
              </span>
              {entry?.durationMs !== undefined && state === 'ok' && (
                <span className={cn('font-mono text-[10px]', isDark ? 'text-zinc-600' : 'text-zinc-400')}>
                  {entry.durationMs}ms
                </span>
              )}
            </div>
          );
        })}
      </div>
      {error && (
        <div className={cn('text-[10px]', isDark ? 'text-rose-400' : 'text-rose-600')}>poll error: {error}</div>
      )}
      {(() => {
        const lastErr = [...progress.history].reverse().find((h) => h.status === 'error');
        return lastErr ? (
          <div className={cn('text-[10px]', isDark ? 'text-rose-300' : 'text-rose-700')}>
            <span className="font-semibold">{lastErr.step}:</span> {lastErr.error || 'failed'}
          </div>
        ) : null;
      })()}
    </div>
  );
}

function lastEntryFor(
  history: ProvisioningHistoryEntry[],
  step: ProvisioningStep,
): ProvisioningHistoryEntry | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].step === step) return history[i];
  }
  return undefined;
}

function StateGlyph({
  state,
  isDark,
}: {
  state: 'pending' | 'in_progress' | 'ok' | 'error';
  isDark: boolean;
}): React.JSX.Element {
  const base = 'inline-block size-2 rounded-full';
  if (state === 'pending') {
    return <span className={cn(base, isDark ? 'bg-zinc-700' : 'bg-zinc-300')} />;
  }
  if (state === 'in_progress') {
    return <span className={cn(base, 'animate-pulse', isDark ? 'bg-cyan-400' : 'bg-cyan-500')} />;
  }
  if (state === 'ok') {
    return <span className={cn(base, isDark ? 'bg-emerald-400' : 'bg-emerald-500')} />;
  }
  return <span className={cn(base, isDark ? 'bg-rose-400' : 'bg-rose-500')} />;
}
