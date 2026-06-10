'use client';

/**
 * SkillSuccessRateCurve — release201/24 §Phase4.
 *
 * Plots per-revision eval pass-rate so the user can watch a skill improve
 * across regenerate / auto-optimize iterations. Data source:
 * `SkillDetail.metadata.authoring.draftRevisionHistory[]` (written by
 * SkillLifecycleService.recordRevisionPassRate). Pure + presentational so it
 * is trivially unit-testable; SSE-driven refresh is owned by the parent
 * lifecycle-view (which refetches SkillDetail on `skill.eval.*` events).
 */

import { useI18n } from '@/contexts/i18n-context';

export interface RevisionPassRate {
  revision?: string | null;
  passRate?: number;
  evalRunId?: string;
  evaluatedAt?: string;
}

interface SkillSuccessRateCurveProps {
  isDark: boolean;
  history?: RevisionPassRate[] | null;
}

/** Filter to the entries that actually carry an eval pass-rate, in order. */
export function evaluatedRevisions(history?: RevisionPassRate[] | null): Array<Required<Pick<RevisionPassRate, 'passRate'>> & RevisionPassRate> {
  if (!Array.isArray(history)) return [];
  return history.filter((h): h is RevisionPassRate & { passRate: number } => typeof h?.passRate === 'number');
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function barColor(rate: number): string {
  if (rate >= 0.8) return 'bg-emerald-500/70';
  if (rate >= 0.5) return 'bg-amber-500/70';
  return 'bg-rose-500/70';
}

export function SkillSuccessRateCurve({ isDark, history }: SkillSuccessRateCurveProps) {
  const { t } = useI18n();
  const points = evaluatedRevisions(history);

  const headerText = isDark ? 'text-zinc-200' : 'text-zinc-800';
  const subText = isDark ? 'text-zinc-500' : 'text-zinc-500';
  const cardBg = isDark ? 'bg-white/[0.02] border-white/5' : 'bg-zinc-50 border-zinc-200';

  if (points.length === 0) {
    return (
      <div className={`rounded-xl border p-3 ${cardBg}`} data-testid="skill-success-rate-curve-empty">
        <h4 className={`text-[11px] font-semibold uppercase tracking-wider ${headerText}`}>
          {t('evolution.studio.skills.successRate.title')}
        </h4>
        <p className={`mt-1 text-[11px] ${subText}`}>{t('evolution.studio.skills.successRate.empty')}</p>
      </div>
    );
  }

  const latest = points[points.length - 1];

  return (
    <div className={`rounded-xl border p-3 ${cardBg}`} data-testid="skill-success-rate-curve">
      <div className="flex items-center justify-between">
        <h4 className={`text-[11px] font-semibold uppercase tracking-wider ${headerText}`}>
          {t('evolution.studio.skills.successRate.title')}
        </h4>
        <span className={`text-[11px] font-mono ${headerText}`} data-testid="skill-success-rate-latest">
          {t('evolution.studio.skills.successRate.latest', { rate: pct(latest.passRate) })}
        </span>
      </div>
      {/* per-revision bars (revision N → passRate). The latest is full-opacity. */}
      <div className="mt-2 flex items-end gap-1.5" style={{ height: 56 }} data-testid="skill-success-rate-bars">
        {points.map((p, i) => {
          const h = Math.max(4, Math.round(p.passRate * 52));
          const isLatest = i === points.length - 1;
          return (
            <div key={`${p.revision ?? i}-${p.evalRunId ?? i}`} className="flex flex-1 flex-col items-center gap-1">
              <div
                className={`w-full rounded-sm ${barColor(p.passRate)} ${isLatest ? '' : 'opacity-60'}`}
                style={{ height: h }}
                title={pct(p.passRate)}
                data-testid="skill-success-rate-bar"
                data-rate={p.passRate}
              />
              <span className={`text-[8px] font-mono ${subText}`}>{i + 1}</span>
            </div>
          );
        })}
      </div>
      <p className={`mt-1.5 text-[10px] ${subText}`}>
        {t('evolution.studio.skills.successRate.iterations', { n: points.length })}
      </p>
    </div>
  );
}
