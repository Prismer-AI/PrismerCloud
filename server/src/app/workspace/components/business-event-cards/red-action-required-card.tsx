'use client';

/**
 * Red action-required card (release201/12 §8c row 2).
 *
 * Fires on `skill.authoring.failed` with severity=error. Shows the failed
 * stage + reason + "Resume in Dev session" deep link.
 */

import { AlertOctagon, ArrowUpRight } from 'lucide-react';
import Link from 'next/link';
import type { SkillAuthoringFailurePayload } from '../../lib/business-event-bus';

export interface RedActionRequiredCardProps {
  isDark: boolean;
  payload: SkillAuthoringFailurePayload;
}

export function RedActionRequiredCard({ isDark, payload }: RedActionRequiredCardProps) {
  return (
    <div
      data-testid="biz-card-red-action-required"
      className={`flex flex-col gap-2 rounded-2xl border p-3 text-xs ${
        isDark ? 'border-rose-500/30 bg-rose-500/10' : 'border-rose-200 bg-rose-50'
      }`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <AlertOctagon className={`h-3.5 w-3.5 ${isDark ? 'text-rose-300' : 'text-rose-700'}`} />
        <span className={`min-w-0 truncate font-semibold ${isDark ? 'text-rose-100' : 'text-rose-900'}`}>
          Skill authoring failed at {payload.stage}
        </span>
      </div>
      <p className={`text-[11px] ${isDark ? 'text-rose-200' : 'text-rose-800'}`}>{payload.reason}</p>
      <Link
        href={`/evolution?tab=studio&skillId=${encodeURIComponent(payload.skillId)}&draftId=${encodeURIComponent(payload.draftId ?? '')}`}
        className={`inline-flex items-center gap-1 self-end rounded-md px-2 py-1 text-[11px] font-medium ${
          isDark ? 'text-rose-200 hover:bg-rose-500/15' : 'text-rose-800 hover:bg-rose-100'
        }`}
      >
        Resume in Dev session <ArrowUpRight className="h-3 w-3" />
      </Link>
    </div>
  );
}
