/**
 * `DeliveryTimelineChip` — inline pill rendered in the bottom-right of
 * the user's own message bubble, replacing the static "Sent" label.
 * When the message triggered ≥1 task (chat @-mention), the chip shows
 * the live lifecycle ("Working 8s", "Failed: <code>", "Done in 12s")
 * and opens a popover with the full trace on click.
 *
 * Spec: docs/release200/CLAUDE.md §Debug Pipeline (2026-05-24) — P1 of
 * the workspace dispatch-reliability overhaul. Gives the user visibility
 * into the dispatch lifecycle so silent stalls / hangs / timeouts are
 * surfaced inline instead of vanishing.
 *
 * Graceful fallback: when `state === null` the chip renders the legacy
 * "Sent" / "Sending" text — non-@-mention messages stay clean.
 */

'use client';

import { useCallback, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { RotateCcw } from 'lucide-react';

import type { AgentPhaseRow } from '../lib/agent-phase-store';
import type { MessageDeliveryState } from '../lib/message-delivery-state';
import { STATE_DECOR, formatStateLabel } from './delivery-timeline-chip-decor';
import { DeliveryTimelinePopover } from './delivery-timeline-popover';
import { useI18n } from '@/contexts/i18n-context';

export interface DeliveryTimelineChipProps {
  /** null → fall back to legacy "Sent" text. */
  state: MessageDeliveryState | null;
  isDark: boolean;
  /** Whether the message is still optimistic-pending (no server echo yet). */
  pending?: boolean;
  /** Workspace-wide phase rows; forwarded to popover for recent-activity tail. */
  taskPhases?: Map<string, AgentPhaseRow>;
  onOpenTask?: (taskId: string) => void;
  onRetry?: () => void;
}

export function DeliveryTimelineChip({
  state,
  isDark,
  pending = false,
  taskPhases,
  onOpenTask,
  onRetry,
}: DeliveryTimelineChipProps) {
  const { t } = useI18n();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);

  const openPopover = useCallback(() => {
    const el = buttonRef.current;
    if (el) setAnchorRect(el.getBoundingClientRect());
    setPopoverOpen(true);
  }, []);

  const closePopover = useCallback(() => setPopoverOpen(false), []);

  // Legacy fallback — render the plain "Sent" / "Sending" label so
  // non-@ messages keep their current look.
  if (!state) {
    return (
      <span
        data-testid="delivery-timeline-chip-fallback"
        className={`text-[10px] ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}
      >
        {pending ? t('workspace.delivery.sending') : t('workspace.delivery.sent')}
      </span>
    );
  }

  const decor = STATE_DECOR[state.kind];
  const label = formatStateLabel(state, t);
  const showRetry = state.kind === 'failed' || state.kind === 'timeout';

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={openPopover}
        data-testid="delivery-timeline-chip"
        data-state-kind={state.kind}
        title={label}
        className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-[1px] text-[10px] font-medium transition-colors ${
          isDark
            ? 'border-white/[0.08] bg-white/[0.04] hover:bg-white/[0.08]'
            : 'border-zinc-200/80 bg-white/70 hover:bg-zinc-50'
        }`}
      >
        <DotIndicator className={decor.dotClass} pulse={decor.pulse} />
        <span className={decor.textClass}>{label}</span>
        {showRetry ? (
          <span
            role="presentation"
            onClick={(event) => {
              event.stopPropagation();
              onRetry?.();
            }}
            data-testid="delivery-timeline-inline-retry"
            className={`-mr-0.5 ml-0.5 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full transition-colors ${
              isDark ? 'hover:bg-rose-500/20' : 'hover:bg-rose-100'
            }`}
            aria-label={t('workspace.delivery.retry')}
          >
            <RotateCcw className={`h-2.5 w-2.5 ${decor.textClass}`} />
          </span>
        ) : null}
      </button>
      <DeliveryTimelinePopover
        open={popoverOpen}
        anchorRect={anchorRect}
        state={state}
        isDark={isDark}
        taskPhases={taskPhases}
        onClose={closePopover}
        onOpenTask={onOpenTask}
        onRetry={onRetry}
      />
    </>
  );
}

function DotIndicator({ className, pulse }: { className: string; pulse: boolean }) {
  if (!pulse) {
    return <span aria-hidden className={`inline-block h-1.5 w-1.5 rounded-full ${className}`} />;
  }
  return (
    <motion.span
      aria-hidden
      className={`inline-block h-1.5 w-1.5 rounded-full ${className}`}
      animate={{ opacity: [1, 0.35, 1], scale: [1, 1.18, 1] }}
      transition={{ duration: 1.5, ease: 'easeInOut', repeat: Infinity }}
    />
  );
}
