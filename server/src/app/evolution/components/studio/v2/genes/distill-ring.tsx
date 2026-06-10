'use client';

/**
 * Genes → DistillRing (release201/28 §4.4 + 13 §3.6.2 帧 4 / §3.6.3).
 *
 * Progress ring wrapping the agent's distillation %. Fills via strokeDashoffset
 * (springSoft). At 100% the ring is clickable / `d`-keyable → splat into a new
 * gene (springSplat particle burst). Below 100% it shows "next gene at 100%".
 *
 * The actual gene-creation side-effect is the parent's; this component owns the
 * visual ring + splat affordance + keyboard back-path.
 */

import { AnimatePresence, motion } from 'framer-motion';
import { Sparkles } from 'lucide-react';
import { useEffect } from 'react';

import { grammarAccentClasses, springSoft, springSplat } from '@/app/workspace/lib/design';
import type { GrammarAccent } from '@/app/workspace/lib/design';
import { useI18n } from '@/contexts/i18n-context';
import { cn } from '@/lib/utils';

const SIZE = 96;
const STROKE = 7;
const R = (SIZE - STROKE) / 2;
const CIRC = 2 * Math.PI * R;

export interface DistillRingProps {
  /** 0..1 distillation progress. */
  progress: number;
  accent: GrammarAccent;
  isDark: boolean;
  reduce: boolean;
  splatting: boolean;
  /** Fire when the ring is full and the user clicks / presses `d`. */
  onDistill: () => void;
}

export function DistillRing({ progress, accent, isDark, reduce, splatting, onDistill }: DistillRingProps) {
  const { t } = useI18n();
  const a = grammarAccentClasses[accent];
  const pct = Math.round(progress * 100);
  const ready = progress >= 1;

  // Keyboard back-path: `d` triggers distill when ready (13 §3.6.3).
  useEffect(() => {
    if (!ready) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'd' || e.key === 'D') onDistill();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ready, onDistill]);

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={ready ? onDistill : undefined}
        disabled={!ready}
        aria-label={t('evolution.studio.v2.genes.distillNow')}
        className={cn('relative flex items-center justify-center outline-none', ready && 'cursor-pointer focus-visible:opacity-90')}
        style={{ width: SIZE, height: SIZE }}
      >
        <svg width={SIZE} height={SIZE} className="-rotate-90" aria-hidden>
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={R}
            fill="none"
            strokeWidth={STROKE}
            className={isDark ? 'stroke-white/10' : 'stroke-zinc-200'}
          />
          <motion.circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={R}
            fill="none"
            strokeWidth={STROKE}
            strokeLinecap="round"
            className={a.text}
            stroke="currentColor"
            strokeDasharray={CIRC}
            initial={reduce ? false : { strokeDashoffset: CIRC }}
            animate={{ strokeDashoffset: CIRC * (1 - Math.min(progress, 1)) }}
            transition={springSoft}
          />
        </svg>
        <span className={cn('absolute text-sm font-semibold', a.text)}>{pct}%</span>

        {/* splat particles on distill */}
        <AnimatePresence>
          {splatting && !reduce && (
            <>
              {Array.from({ length: 8 }).map((_, i) => {
                const ang = (i / 8) * Math.PI * 2;
                return (
                  <motion.span
                    key={i}
                    className={cn('absolute size-1.5 rounded-full', a.dot)}
                    initial={{ x: 0, y: 0, opacity: 1, scale: 1 }}
                    animate={{ x: Math.cos(ang) * 46, y: Math.sin(ang) * 46, opacity: 0, scale: 0.4 }}
                    exit={{ opacity: 0 }}
                    transition={springSplat}
                  />
                );
              })}
            </>
          )}
        </AnimatePresence>
      </button>

      <div className="space-y-1">
        <div className={cn('flex items-center gap-1.5 text-xs font-medium', a.text)}>
          <Sparkles className="size-3.5" aria-hidden />
          {t('evolution.studio.v2.genes.distillNow')}
        </div>
        <p className={cn('text-[11px]', isDark ? 'text-zinc-500' : 'text-zinc-500')}>
          {ready
            ? t('evolution.studio.v2.genes.distillNow')
            : t('evolution.studio.v2.genes.distillNextAt', { pct: `${pct}%` })}
        </p>
      </div>
    </div>
  );
}
