'use client';

/**
 * Lifecycle pipeline rail — release201/08 §2 + §9, release201/13 §3.3 (S22).
 *
 * Horizontal rail of the 11 sub-stages mapped onto the 5 main lifecycle
 * states. The active sub-stage is derived from
 * `IMSkill.metadata.lifecycleSubStage` (set by SkillLifecycleService each
 * time a stage advances). The rail also reflects an `error` flag so a
 * `skill.authoring.failed` SSE event can highlight the failing node.
 */

import { Check, CircleDot, Loader2 } from 'lucide-react';
import { useI18n } from '@/contexts/i18n-context';
import { LIFECYCLE_PIPELINE_STAGES, type LifecycleSubStage } from '../types';

interface PipelineRailProps {
  isDark: boolean;
  active: LifecycleSubStage;
  /** Sub-stages already completed; defaults to "everything before active". */
  completed?: Set<LifecycleSubStage>;
  /** `failed` flag highlights the active node in error tone. */
  failed?: boolean;
}

export function PipelineRail({ isDark, active, completed, failed }: PipelineRailProps) {
  const { t } = useI18n();
  const activeIdx = LIFECYCLE_PIPELINE_STAGES.findIndex((s) => s.key === active);

  return (
    <div
      className={`rounded-2xl border p-4 ${
        isDark ? 'border-white/[0.06] bg-white/[0.02]' : 'border-zinc-200 bg-white'
      }`}
      data-testid="lifecycle-pipeline-rail"
    >
      <div className="flex items-center justify-between gap-2 overflow-x-auto pb-1">
        {LIFECYCLE_PIPELINE_STAGES.map((stage, idx) => {
          const isActive = stage.key === active;
          const isDone = completed?.has(stage.key) ?? (activeIdx >= 0 && idx < activeIdx);
          const isFailed = failed && isActive;
          return (
            <div
              key={stage.key}
              data-stage-key={stage.key}
              data-stage-state={isFailed ? 'failed' : isActive ? 'active' : isDone ? 'done' : 'pending'}
              className="flex min-w-[64px] flex-1 flex-col items-center gap-1"
            >
              <div
                className={`flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-semibold ${
                  isFailed
                    ? isDark
                      ? 'bg-rose-500/25 text-rose-200 ring-2 ring-rose-400/60'
                      : 'bg-rose-50 text-rose-700 ring-2 ring-rose-400'
                    : isActive
                      ? isDark
                        ? 'bg-violet-500/30 text-violet-100 ring-2 ring-violet-400/70'
                        : 'bg-violet-100 text-violet-900 ring-2 ring-violet-400'
                      : isDone
                        ? isDark
                          ? 'bg-emerald-500/20 text-emerald-300'
                          : 'bg-emerald-50 text-emerald-700'
                        : isDark
                          ? 'bg-white/[0.04] text-zinc-500'
                          : 'bg-zinc-100 text-zinc-400'
                }`}
              >
                {isDone ? (
                  <Check className="h-3.5 w-3.5" />
                ) : isActive && !isFailed ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <CircleDot className="h-3.5 w-3.5" />
                )}
              </div>
              <span
                className={`text-center text-[10px] uppercase tracking-wider ${
                  isActive
                    ? isDark
                      ? 'text-violet-200'
                      : 'text-violet-700'
                    : isDark
                      ? 'text-zinc-500'
                      : 'text-zinc-500'
                }`}
              >
                {t(stageLabelKey(stage.key))}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function stageLabelKey(stage: LifecycleSubStage): `evolution.${string}` {
  const keys: Record<LifecycleSubStage, `evolution.${string}`> = {
    intake: 'evolution.studio.lifecycle.stages.intake',
    source_review: 'evolution.studio.lifecycle.stages.sourceReview',
    design: 'evolution.studio.lifecycle.stages.design',
    scaffold: 'evolution.studio.lifecycle.stages.scaffold',
    implement: 'evolution.studio.lifecycle.stages.implement',
    static_validate: 'evolution.studio.lifecycle.stages.staticValidate',
    sandbox_smoke: 'evolution.studio.lifecycle.stages.sandboxSmoke',
    sample_task: 'evolution.studio.lifecycle.stages.sampleTask',
    human_review: 'evolution.studio.lifecycle.stages.humanReview',
    publish_ready: 'evolution.studio.lifecycle.stages.publishReady',
    published: 'evolution.studio.lifecycle.stages.published',
  };
  return keys[stage];
}
