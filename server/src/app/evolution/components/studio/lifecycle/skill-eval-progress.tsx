'use client';

/**
 * Skill eval progress — release201/08 §3 + §9.4, release201/13 §3.3 (S22).
 *
 * Lightweight progress strip rendered while `lifecycleStage === 'eval'` and
 * an active eval run exists. Updates via polling (no SSE channel here —
 * the parent Lifecycle view subscribes to skill.authoring.smoke_completed
 * and re-fetches the skill detail; this component only renders the latest
 * run snapshot).
 */

import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { useI18n } from '@/contexts/i18n-context';
import type { EvalRunStatus } from '../types';

interface SkillEvalProgressProps {
  isDark: boolean;
  run: EvalRunStatus | null;
}

export function SkillEvalProgress({ isDark, run }: SkillEvalProgressProps) {
  const { t } = useI18n();
  if (!run) return null;
  const total = run.passCount + run.failCount;
  const totalCases = run.testCases?.length ?? total;
  const pct = totalCases > 0 ? Math.round((total / totalCases) * 100) : 0;
  const passed = run.failCount === 0 && run.status === 'finished';
  return (
    <section
      data-testid="lifecycle-eval-progress"
      data-eval-status={run.status}
      className={`rounded-2xl border p-3 ${
        isDark ? 'border-white/[0.06] bg-white/[0.02]' : 'border-zinc-200 bg-white'
      }`}
    >
      <div className="flex items-center gap-3">
        {run.status === 'finished' ? (
          passed ? (
            <CheckCircle2 className={`h-4 w-4 ${isDark ? 'text-emerald-300' : 'text-emerald-600'}`} />
          ) : (
            <XCircle className={`h-4 w-4 ${isDark ? 'text-rose-300' : 'text-rose-600'}`} />
          )
        ) : (
          <Loader2 className={`h-4 w-4 animate-spin ${isDark ? 'text-violet-300' : 'text-violet-600'}`} />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className={`text-xs font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
              {t('evolution.studio.lifecycle.evalProgress.title', { status: run.status })}
            </span>
            <span className={`font-mono text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
              {run.runId.slice(0, 12)}
            </span>
          </div>
          <div
            className={`mt-1 h-1.5 w-full overflow-hidden rounded-full ${isDark ? 'bg-white/[0.06]' : 'bg-zinc-100'}`}
          >
            <div
              className={`h-full ${run.failCount > 0 ? 'bg-rose-500' : 'bg-emerald-500'}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className={`mt-1 text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
            {t('evolution.studio.lifecycle.evalProgress.summary', {
              pass: run.passCount,
              fail: run.failCount,
              total: totalCases,
            })}
          </p>
        </div>
      </div>
    </section>
  );
}
