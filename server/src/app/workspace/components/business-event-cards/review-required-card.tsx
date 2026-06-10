'use client';

/**
 * Review required card (release201/12 §8c row 4).
 *
 * Fires on `task.acceptance.changed` when acceptanceStatus becomes
 * 'partial' or 'pending'. Shows criteria pass count + "Open task"
 * deep link.
 */

import { ClipboardCheck, ArrowUpRight } from 'lucide-react';
import type { TaskAcceptancePayload } from '../../lib/business-event-bus';

export interface ReviewRequiredCardProps {
  isDark: boolean;
  payload: TaskAcceptancePayload;
  onOpenTask?: (taskId: string) => void;
}

export function ReviewRequiredCard({ isDark, payload, onOpenTask }: ReviewRequiredCardProps) {
  const summary = (() => {
    if (typeof payload.passedCount === 'number' && typeof payload.totalCount === 'number') {
      return `${payload.passedCount}/${payload.totalCount} criteria passed`;
    }
    return `acceptance: ${payload.acceptanceStatus}`;
  })();

  return (
    <div
      data-testid="biz-card-review-required"
      className={`flex flex-col gap-2 rounded-2xl border p-3 text-xs ${
        isDark ? 'border-amber-500/25 bg-amber-500/10' : 'border-amber-200 bg-amber-50'
      }`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <ClipboardCheck className={`h-3.5 w-3.5 ${isDark ? 'text-amber-200' : 'text-amber-700'}`} />
        <span className={`min-w-0 truncate font-semibold ${isDark ? 'text-amber-100' : 'text-amber-900'}`}>
          Review required: {payload.taskId}
        </span>
      </div>
      <p className={`text-[11px] ${isDark ? 'text-amber-200' : 'text-amber-800'}`}>{summary}</p>
      <button
        type="button"
        onClick={() => onOpenTask?.(payload.taskId)}
        className={`inline-flex items-center gap-1 self-end rounded-md px-2 py-1 text-[11px] font-medium ${
          isDark ? 'text-amber-200 hover:bg-amber-500/15' : 'text-amber-800 hover:bg-amber-100'
        }`}
      >
        Open task <ArrowUpRight className="h-3 w-3" />
      </button>
    </div>
  );
}
