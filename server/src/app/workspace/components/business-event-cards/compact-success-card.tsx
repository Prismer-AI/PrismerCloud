'use client';

/**
 * Compact success card (release201/12 §8c row 3).
 *
 * Fires on `skill.authoring.smoke_completed` with passed=true.
 */

import { CheckCircle2 } from 'lucide-react';
import type { SkillSmokePayload } from '../../lib/business-event-bus';

export interface CompactSuccessCardProps {
  isDark: boolean;
  payload: SkillSmokePayload;
}

export function CompactSuccessCard({ isDark, payload }: CompactSuccessCardProps) {
  return (
    <div
      data-testid="biz-card-compact-success"
      className={`flex items-center gap-2 rounded-2xl border px-3 py-2 text-xs ${
        isDark ? 'border-emerald-500/25 bg-emerald-500/10' : 'border-emerald-200 bg-emerald-50'
      }`}
    >
      <CheckCircle2 className={`h-3.5 w-3.5 shrink-0 ${isDark ? 'text-emerald-300' : 'text-emerald-700'}`} />
      <span className={`min-w-0 flex-1 truncate font-medium ${isDark ? 'text-emerald-100' : 'text-emerald-900'}`}>
        Skill ‘{payload.skillId}’ passed smoke
      </span>
      {payload.evidenceUri ? (
        <a
          href={payload.evidenceUri}
          target="_blank"
          rel="noreferrer"
          className={`text-[11px] underline ${isDark ? 'text-emerald-200' : 'text-emerald-800'}`}
        >
          evidence
        </a>
      ) : null}
    </div>
  );
}
