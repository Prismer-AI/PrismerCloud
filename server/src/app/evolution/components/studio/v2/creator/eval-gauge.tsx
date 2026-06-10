'use client';

/**
 * Skill Creator — Confidence layer (release201/28 §3.3, info-layer 4).
 *
 * Ring gauge animating the eval pass-rate + a per-case list. The arc % is driven
 * by framer-motion `useSpring` (NOT recharts — contract §5 "gauge → self-rendered
 * SVG + useSpring"), mirroring the prototype's stroke-dashoffset sweep. Honours
 * `useReducedMotion()` by snapping straight to the target.
 */

import { motion, useMotionValueEvent, useReducedMotion, useSpring } from 'framer-motion';
import { Check, CircleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';

import { grammarAccentClasses, radius, s, springSnap, springSplat } from '@/app/workspace/lib/design';
import { useI18n } from '@/contexts/i18n-context';
import { useTheme } from '@/contexts/theme-context';
import { cn } from '@/lib/utils';

import type { EvalCase } from '../types';

const R = 50;
const CIRC = 2 * Math.PI * R; // ≈ 314

export interface EvalGaugeProps {
  /** 0..100; null while no run has finished (cases may still stream in). */
  passRate: number | null;
  cases: EvalCase[];
}

export function EvalGauge({ passRate, cases }: EvalGaugeProps) {
  const { t } = useI18n();
  const { resolvedTheme } = useTheme();
  const reduce = useReducedMotion();
  const isDark = resolvedTheme === 'dark';
  const theme = isDark ? 'dark' : 'light';
  const a = grammarAccentClasses.violet;

  const target = passRate ?? 0;
  const spring = useSpring(0, reduce ? { duration: 0 } : { stiffness: 90, damping: 22, mass: 1 });
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    spring.set(target);
  }, [spring, target]);

  useMotionValueEvent(spring, 'change', (v) => setDisplay(Math.round(v)));

  const offset = CIRC - (CIRC * display) / 100;

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-6">
      <div className="relative size-[120px] flex-none">
        <svg viewBox="0 0 120 120" width="120" height="120" aria-hidden>
          <defs>
            <linearGradient id="studio-gauge-grad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="var(--grad-from, #7c5cff)" />
              <stop offset="1" stopColor="var(--grad-to, #d28bff)" />
            </linearGradient>
          </defs>
          <circle
            cx="60"
            cy="60"
            r={R}
            fill="none"
            strokeWidth="9"
            className={isDark ? 'stroke-white/10' : 'stroke-zinc-200'}
          />
          <circle
            cx="60"
            cy="60"
            r={R}
            fill="none"
            stroke="url(#studio-gauge-grad)"
            strokeWidth="9"
            strokeLinecap="round"
            strokeDasharray={CIRC}
            strokeDashoffset={offset}
            transform="rotate(-90 60 60)"
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
          <b className={cn('text-2xl font-bold tracking-tight', isDark ? 'text-zinc-50' : 'text-zinc-900')}>
            {display}%
          </b>
          <span className={cn('px-1 text-[9px] uppercase leading-tight tracking-wide', isDark ? 'text-zinc-500' : 'text-zinc-500')}>
            {t('evolution.studio.v2.creator.status.passRate', { rate: '' }).trim()}
          </span>
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {cases.map((c, i) => {
          const Icon = c.passed ? Check : CircleAlert;
          const tone = c.passed ? grammarAccentClasses.emerald : grammarAccentClasses.rose;
          return (
            <motion.div
              key={`${c.name}-${i}`}
              initial={reduce ? false : { opacity: 0, x: 8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={c.passed ? springSnap : springSplat}
              className={cn(
                'flex items-center gap-2 border px-2.5 py-1.5 text-xs',
                radius.small,
                s(theme, 'inset'),
                c.passed ? tone.ring : tone.ring,
                'ring-1',
              )}
            >
              <Icon className={cn('size-3.5 flex-none', tone.text)} aria-hidden />
              <span className={cn('min-w-0 flex-1 truncate', isDark ? 'text-zinc-300' : 'text-zinc-700')}>
                {c.name}
              </span>
              <span className={cn('flex-none font-mono text-[11px]', isDark ? 'text-zinc-500' : 'text-zinc-500')}>
                {(c.ms / 1000).toFixed(1)}s
              </span>
            </motion.div>
          );
        })}
        {cases.length === 0 ? (
          <span className={cn('text-xs', a.text)}>{t('evolution.studio.v2.creator.evaluating')}</span>
        ) : null}
      </div>
    </div>
  );
}
