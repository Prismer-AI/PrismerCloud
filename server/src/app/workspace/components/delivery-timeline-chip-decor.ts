/**
 * Shared visual tokens + label formatter for the DeliveryTimelineChip
 * and its expanded popover. Split out so both modules speak the same
 * palette without one importing the other (avoids circular-import).
 */

import type { DeliveryStateKind, MessageDeliveryState } from '../lib/message-delivery-state';
import type { TranslationKey } from '@/lib/i18n';

type DeliveryT = (key: TranslationKey, values?: Record<string, string | number>) => string;

export interface DeliveryStateDecor {
  /** Short uppercase label rendered next to the dot. */
  headline: string;
  /** Tailwind class for the colored dot. */
  dotClass: string;
  /** Tailwind class for the headline text colour. */
  textClass: string;
  /** Whether the dot should pulse (animation hint). */
  pulse: boolean;
}

export const STATE_DECOR: Record<DeliveryStateKind, DeliveryStateDecor> = {
  sent: {
    headline: 'Sent',
    dotClass: 'bg-zinc-400',
    textClass: 'text-zinc-500',
    pulse: false,
  },
  ack: {
    headline: 'Ack',
    dotClass: 'bg-sky-400',
    textClass: 'text-sky-500',
    pulse: false,
  },
  working: {
    headline: 'Working',
    dotClass: 'bg-violet-400',
    textClass: 'text-violet-500',
    pulse: true,
  },
  awaiting: {
    headline: 'Awaiting',
    dotClass: 'bg-amber-400',
    textClass: 'text-amber-500',
    pulse: true,
  },
  stuck: {
    headline: 'Stuck',
    dotClass: 'bg-rose-400',
    textClass: 'text-rose-500',
    pulse: false,
  },
  done: {
    headline: 'Done',
    dotClass: 'bg-emerald-400',
    textClass: 'text-emerald-500',
    pulse: false,
  },
  failed: {
    headline: 'Failed',
    dotClass: 'bg-rose-500',
    textClass: 'text-rose-500',
    pulse: false,
  },
  timeout: {
    headline: 'Timeout',
    dotClass: 'bg-rose-500',
    textClass: 'text-rose-500',
    pulse: false,
  },
};

export function formatStateHeadline(kind: DeliveryStateKind, t: DeliveryT): string {
  switch (kind) {
    case 'ack':
      return t('workspace.delivery.ack');
    case 'working':
      return t('workspace.delivery.working', { duration: '' }).trim();
    case 'awaiting':
      return t('workspace.delivery.awaitingApproval');
    case 'stuck':
      return t('workspace.delivery.stuckNoProgress');
    case 'done':
      return t('workspace.delivery.done');
    case 'failed':
      return t('workspace.delivery.failed');
    case 'timeout':
      return t('workspace.delivery.timeout');
    case 'sent':
    default:
      return t('workspace.delivery.sent');
  }
}

/**
 * Friendly inline string for the chip body. Picks the most useful
 * piece of detail per state — "Working 8s · tool_use", "Done in 12s",
 * "Failed: daemon_local_retry_exhausted", etc.
 */
export function formatStateLabel(state: MessageDeliveryState, t: DeliveryT): string {
  switch (state.kind) {
    case 'sent':
      return t('workspace.delivery.sent');
    case 'ack': {
      const latency = state.ackLatencyMs;
      if (latency != null) return t('workspace.delivery.ackAgo', { duration: formatDuration(latency) });
      return t('workspace.delivery.ack');
    }
    case 'working': {
      const elapsed = state.elapsedMs ?? 0;
      if (state.workingPhase) {
        return t('workspace.delivery.workingPhase', { duration: formatDuration(elapsed), phase: state.workingPhase });
      }
      return t('workspace.delivery.working', { duration: formatDuration(elapsed) });
    }
    case 'awaiting':
      return t('workspace.delivery.awaitingApproval');
    case 'stuck':
      return t('workspace.delivery.stuckNoProgress');
    case 'done': {
      const elapsed = state.elapsedMs;
      if (elapsed != null) return t('workspace.delivery.doneIn', { duration: formatDuration(elapsed) });
      return t('workspace.delivery.done');
    }
    case 'failed': {
      if (state.errorCode) return t('workspace.delivery.failedWithCode', { code: state.errorCode });
      return t('workspace.delivery.failed');
    }
    case 'timeout': {
      const elapsed = state.elapsedMs;
      if (elapsed != null) return t('workspace.delivery.timeoutAfter', { duration: formatDuration(elapsed) });
      return t('workspace.delivery.timeout');
    }
    default:
      return t('workspace.delivery.sent');
  }
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return '<1s';
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}
