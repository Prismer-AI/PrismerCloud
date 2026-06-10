'use client';

/**
 * Skill authoring pipeline mini-card (release201/12 §8c row 1).
 *
 * Compact rail of pipeline stages + "Open Studio" deep link. Rendered
 * inline in the channel timeline when `skill.authoring.state_changed`
 * fires for the active conversation.
 */

import Link from 'next/link';
import { ArrowUpRight, Sparkles } from 'lucide-react';
import type { SkillAuthoringEventPayload } from '../../lib/business-event-bus';

const STAGES = ['draft', 'review', 'eval', 'publish'] as const;

export interface SkillPipelineMiniCardProps {
  isDark: boolean;
  payload: SkillAuthoringEventPayload;
}

export function SkillPipelineMiniCard({ isDark, payload }: SkillPipelineMiniCardProps) {
  const activeIdx = Math.max(0, STAGES.indexOf(payload.stage as (typeof STAGES)[number]));
  return (
    <div
      data-testid="biz-card-skill-pipeline-mini"
      className={`flex flex-col gap-2 rounded-2xl border p-3 text-xs ${
        isDark ? 'border-white/[0.06] bg-zinc-950/50' : 'border-zinc-200 bg-white/85'
      }`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Sparkles className={`h-3.5 w-3.5 ${isDark ? 'text-violet-300' : 'text-violet-600'}`} />
        <span className={`min-w-0 truncate font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
          Skill authoring: {payload.skillId}
        </span>
      </div>
      <div className="flex items-center gap-1">
        {STAGES.map((stage, idx) => {
          const reached = idx <= activeIdx;
          const current = idx === activeIdx;
          return (
            <div
              key={stage}
              className={`flex flex-1 items-center gap-1 truncate rounded-md px-1.5 py-0.5 text-[10px] ${
                current
                  ? isDark
                    ? 'bg-violet-500/20 text-violet-100'
                    : 'bg-violet-100 text-violet-800'
                  : reached
                    ? isDark
                      ? 'bg-white/[0.06] text-zinc-300'
                      : 'bg-zinc-100 text-zinc-700'
                    : isDark
                      ? 'text-zinc-600'
                      : 'text-zinc-400'
              }`}
            >
              <span className="truncate">{stage}</span>
            </div>
          );
        })}
      </div>
      <Link
        href={`/evolution?tab=studio&skillId=${encodeURIComponent(payload.skillId)}`}
        className={`inline-flex items-center gap-1 self-end rounded-md px-2 py-1 text-[11px] font-medium ${
          isDark ? 'text-violet-300 hover:bg-white/[0.06]' : 'text-violet-700 hover:bg-violet-50'
        }`}
      >
        Open Studio <ArrowUpRight className="h-3 w-3" />
      </Link>
    </div>
  );
}
