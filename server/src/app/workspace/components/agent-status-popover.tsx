/**
 * `AgentStatusPopover` — small floating panel that hangs off an agent
 * avatar (or its name) and surfaces the agent's live state: current task,
 * parallel tasks, recent steps, last heartbeat, hosting daemon.
 *
 * Rendering: portal'd to document.body so transform / overflow ancestors
 * (chat row clipping, kanban column overflow-y-auto, drawer flex stacks)
 * never crop the popover. The trigger only supplies positioning hints
 * via getBoundingClientRect.
 *
 * Lifecycle: 200ms open delay so brief avatar hovers (mouse passing
 * over a chat row) don't flash the popover. Closes immediately on
 * mouseleave / blur / Escape.
 */

'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { CircleDot, Clock, Cpu, type LucideIcon } from 'lucide-react';

import { useI18n } from '@/contexts/i18n-context';
import type { AgentLiveStatus, AgentStatusKind } from '../lib/agent-status';
import { getAgentRoleIcon } from '../lib/agent-role-icon';

const OPEN_DELAY_MS = 200;
const POPOVER_WIDTH = 304;

const STATUS_DECOR: Record<AgentStatusKind, { label: string; tint: string; dot: string }> = {
  working: {
    label: 'Working',
    tint: 'text-emerald-300',
    dot: 'bg-emerald-400',
  },
  waiting: {
    label: 'Waiting',
    tint: 'text-amber-300',
    dot: 'bg-amber-400',
  },
  stuck: {
    label: 'Stuck',
    tint: 'text-rose-300',
    dot: 'bg-rose-400',
  },
  idle: {
    label: 'Idle',
    tint: 'text-zinc-400',
    dot: 'bg-zinc-400',
  },
  offline: {
    label: 'Offline',
    tint: 'text-zinc-500',
    dot: 'bg-zinc-500',
  },
};

export interface AgentStatusPopoverProps {
  agentName: string;
  roleSlug?: string | null;
  status: AgentLiveStatus;
  isDark: boolean;
  /** Trigger element — the popover anchors to its bounding box. */
  children: ReactNode;
}

interface Coords {
  top: number;
  left: number;
}

export function AgentStatusPopover({ agentName, roleSlug, status, isDark, children }: AgentStatusPopoverProps) {
  const { t } = useI18n();
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<Coords | null>(null);
  const [clockNow, setClockNow] = useState(() => Date.now());

  const computeCoords = useCallback((): Coords | null => {
    const el = triggerRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    // Position below-right of the avatar by default; if it would clip the
    // viewport, flip to above. Horizontal clamp keeps the popover within
    // 8px of the viewport edges.
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const proposedTop = rect.bottom + 8;
    const flipTop = proposedTop + 220 > vh ? rect.top - 8 - 220 : proposedTop;
    const left = Math.max(margin, Math.min(rect.left, vw - POPOVER_WIDTH - margin));
    return { top: Math.max(margin, flipTop), left };
  }, []);

  const scheduleOpen = useCallback(() => {
    if (openTimerRef.current) return;
    openTimerRef.current = setTimeout(() => {
      openTimerRef.current = null;
      const next = computeCoords();
      if (!next) return;
      setClockNow(Date.now());
      setCoords(next);
      setOpen(true);
    }, OPEN_DELAY_MS);
  }, [computeCoords]);

  const cancelOpen = useCallback(() => {
    if (openTimerRef.current) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
  }, []);

  const close = useCallback(() => {
    cancelOpen();
    setOpen(false);
  }, [cancelOpen]);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') close();
    }
    function onScroll() {
      // Re-anchor on scroll so the popover stays glued to the trigger.
      const next = computeCoords();
      if (next) setCoords(next);
    }
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open, close, computeCoords]);

  useEffect(() => () => cancelOpen(), [cancelOpen]);

  const decor = STATUS_DECOR[status.kind];
  const statusLabel = agentStatusLabel(status.kind, t);
  // 2026-05-24 — same multi-candidate lookup as AgentAvatar. roleSlug
  // alone misses when `agentType` is the generic literal "agent" or null
  // — fall through to the display name (e.g. "CEO") so the icon matches
  // the avatar shown by the trigger element.
  const RoleIcon: LucideIcon = getAgentRoleIcon([roleSlug, agentName]);

  return (
    <>
      <span
        ref={triggerRef}
        onMouseEnter={scheduleOpen}
        onMouseLeave={close}
        onFocus={scheduleOpen}
        onBlur={close}
        className="inline-flex"
        data-testid={`agent-status-popover-trigger`}
      >
        {children}
      </span>
      {typeof document !== 'undefined' && coords
        ? createPortal(
            <AnimatePresence>
              {open ? (
                <motion.div
                  key="popover"
                  initial={{ opacity: 0, y: -4, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -4, scale: 0.98 }}
                  transition={{ duration: 0.14, ease: 'easeOut' }}
                  style={{
                    position: 'fixed',
                    top: coords.top,
                    left: coords.left,
                    width: POPOVER_WIDTH,
                    zIndex: 1000,
                    pointerEvents: 'none',
                  }}
                  data-testid="agent-status-popover"
                  data-status-kind={status.kind}
                  className={`rounded-2xl border px-3.5 py-3 shadow-[0_20px_50px_-20px_rgba(0,0,0,0.55)] backdrop-blur-xl ${
                    isDark
                      ? 'border-white/[0.08] bg-zinc-950/90 text-zinc-200'
                      : 'border-zinc-200/80 bg-white/95 text-zinc-800'
                  }`}
                >
                  {/* Header */}
                  <div className="flex items-center gap-2">
                    <span
                      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-xl ${
                        isDark ? 'bg-violet-500/15 text-violet-200' : 'bg-violet-100 text-violet-700'
                      }`}
                    >
                      <RoleIcon className="h-3.5 w-3.5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold">{agentName}</p>
                      {/* A2 (release201 v2.0.8 UX hotfix) — split the prior
                          single-row status strip into 2 rows. The 304px
                          popover width couldn't hold {dot + statusLabel +
                          daemonId(uuid) + clock + ago} on one flex row, so
                          long daemon IDs forced the inline label to wrap
                          and ended up rendering vertically. Row 1 is now
                          the prominent status pill (whitespace-nowrap),
                          Row 2 is secondary meta with truncation. */}
                      <div
                        className="mt-0.5 flex items-center gap-1.5 text-[10px]"
                        data-testid="agent-status-popover-status-row"
                      >
                        <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${decor.dot}`} aria-hidden />
                        <span
                          className={`whitespace-nowrap font-medium uppercase tracking-wider ${decor.tint}`}
                          data-testid="agent-status-popover-status-label"
                        >
                          {statusLabel}
                        </span>
                      </div>
                      {status.daemonLabel || status.lastHeartbeatAt ? (
                        <div
                          className={`mt-1 flex min-w-0 items-center gap-1 text-[10px] ${
                            isDark ? 'text-zinc-500' : 'text-zinc-500'
                          }`}
                          data-testid="agent-status-popover-meta-row"
                        >
                          {status.daemonLabel ? (
                            <>
                              <Cpu className="h-2.5 w-2.5 shrink-0 opacity-60" />
                              <span className="min-w-0 truncate" data-testid="agent-status-popover-daemon-label">
                                {status.daemonLabel}
                              </span>
                            </>
                          ) : null}
                          {status.daemonLabel && status.lastHeartbeatAt ? (
                            <span className={`shrink-0 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>·</span>
                          ) : null}
                          {status.lastHeartbeatAt ? (
                            <>
                              <Clock className="h-2.5 w-2.5 shrink-0 opacity-60" />
                              <span className="shrink-0 whitespace-nowrap">
                                {formatAgo(status.lastHeartbeatAt, t, clockNow)}
                              </span>
                            </>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </div>

                  {/* Current task */}
                  {status.currentTask ? (
                    <Section title={t('workspace.agentStatus.currentTask')} isDark={isDark}>
                      <p className="truncate text-[12px] font-medium">{status.currentTask.title}</p>
                      <p className={`mt-0.5 text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                        {formatElapsed(status.currentTask.startedAt, t, clockNow)}
                        {status.currentTask.lastStepLabel
                          ? ` · ${status.currentTask.lastStepLabel}`
                          : status.currentTask.phase
                            ? ` · ${status.currentTask.phase}`
                            : null}
                      </p>
                    </Section>
                  ) : null}

                  {/* Parallel tasks */}
                  {status.parallelTasks.length > 0 ? (
                    <Section
                      title={t('workspace.agentStatus.parallelTasks', { count: status.parallelTasks.length })}
                      isDark={isDark}
                    >
                      <ul className="space-y-0.5 text-[11px]">
                        {status.parallelTasks.map((task) => (
                          <li key={task.taskId} className="flex items-center gap-1.5">
                            <CircleDot className="h-2 w-2 shrink-0 opacity-60" />
                            <span className="truncate">{task.title}</span>
                          </li>
                        ))}
                      </ul>
                    </Section>
                  ) : null}

                  {/* Recently completed */}
                  {status.recentCompletedTasks.length > 0 ? (
                    <Section title={t('workspace.agentStatus.recentlyCompleted')} isDark={isDark}>
                      <ul className={`space-y-0.5 text-[11px] ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
                        {status.recentCompletedTasks.map((task) => (
                          <li key={task.taskId} className="flex min-w-0 items-center gap-1.5">
                            <span className={`${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                              {formatAgo(task.updatedAt, t, clockNow)}
                            </span>
                            <span className="truncate">{task.title}</span>
                            <span
                              className={`shrink-0 ${task.status === 'failed' ? 'text-rose-400' : 'text-emerald-400'}`}
                            >
                              {task.status}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </Section>
                  ) : null}

                  {/* Recent steps */}
                  {status.recentSteps.length > 0 ? (
                    <Section title={t('workspace.agentStatus.recentActivity')} isDark={isDark}>
                      <ul className={`space-y-0.5 text-[11px] ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
                        {status.recentSteps.map((step) => (
                          <li key={`${step.at}-${step.label}`} className="flex items-center gap-1.5">
                            <span className={`${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                              {formatAgo(step.at, t, clockNow)}
                            </span>
                            <span className="truncate">{step.label}</span>
                          </li>
                        ))}
                      </ul>
                    </Section>
                  ) : null}

                  {/* Empty fallback — soften when the agent just finished
                      something. Without this, hovering immediately after a
                      reply lands snaps from "working" to "no active work
                      right now", which reads like the agent did nothing. */}
                  {!status.currentTask &&
                  status.parallelTasks.length === 0 &&
                  status.recentCompletedTasks.length === 0 &&
                  status.recentSteps.length === 0 ? (
                    <p className={`mt-2 text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                      {status.kind === 'offline'
                        ? t('workspace.agentStatus.noDaemonHeartbeat')
                        : status.lastActivityAt && clockNow - status.lastActivityAt < 60_000
                          ? t('workspace.agentStatus.justFinished', {
                              time: formatRelative(status.lastActivityAt, t, clockNow),
                            })
                          : t('workspace.agentStatus.noActiveWork')}
                    </p>
                  ) : null}
                </motion.div>
              ) : null}
            </AnimatePresence>,
            document.body,
          )
        : null}
    </>
  );
}

function Section({ title, isDark, children }: { title: string; isDark: boolean; children: ReactNode }) {
  return (
    <div className={`mt-2.5 border-t pt-2 ${isDark ? 'border-white/[0.06]' : 'border-zinc-200/80'}`}>
      <p className={`mb-1 text-[9px] font-bold uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
        {title}
      </p>
      {children}
    </div>
  );
}

function agentStatusLabel(kind: AgentStatusKind, t: ReturnType<typeof useI18n>['t']): string {
  if (kind === 'working') return t('workspace.session.agentStatusWorking');
  if (kind === 'waiting') return t('workspace.session.agentStatusWaiting');
  if (kind === 'stuck') return t('workspace.session.agentStatusBlocked');
  if (kind === 'offline') return t('workspace.session.agentStatusOffline');
  return t('workspace.session.agentStatusIdle');
}

function formatAgo(iso: string, t: ReturnType<typeof useI18n>['t'], now: number): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return t('workspace.session.agentStatusUnknown');
  const diff = Math.max(0, now - ts);
  if (diff < 5_000) return t('workspace.sessionDirectory.justNow');
  if (diff < 60_000) return t('workspace.sessionDirectory.secondsAgo', { count: Math.round(diff / 1_000) });
  if (diff < 3_600_000) return t('workspace.sessionDirectory.minutesAgo', { count: Math.round(diff / 60_000) });
  if (diff < 86_400_000) return t('workspace.sessionDirectory.hoursAgo', { count: Math.round(diff / 3_600_000) });
  return t('workspace.sessionDirectory.daysAgo', { count: Math.round(diff / 86_400_000) });
}

function formatElapsed(iso: string, t: ReturnType<typeof useI18n>['t'], now: number): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '';
  const diff = Math.max(0, now - ts);
  if (diff < 60_000) return t('workspace.agentStatus.elapsedSeconds', { count: Math.round(diff / 1_000) });
  if (diff < 3_600_000) return t('workspace.agentStatus.elapsedMinutes', { count: Math.round(diff / 60_000) });
  return t('workspace.agentStatus.elapsedHours', { count: Math.round(diff / 3_600_000) });
}

function formatRelative(ts: number, t: ReturnType<typeof useI18n>['t'], now: number): string {
  const diff = Math.max(0, now - ts);
  if (diff < 5_000) return t('workspace.sessionDirectory.justNow');
  if (diff < 60_000) return t('workspace.sessionDirectory.secondsAgo', { count: Math.round(diff / 1_000) });
  if (diff < 3_600_000) return t('workspace.sessionDirectory.minutesAgo', { count: Math.round(diff / 60_000) });
  return t('workspace.sessionDirectory.hoursAgo', { count: Math.round(diff / 3_600_000) });
}
