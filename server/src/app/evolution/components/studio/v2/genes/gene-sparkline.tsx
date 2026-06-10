'use client';

/**
 * Genes → GeneSparkline (release201/28 §4.4 + 13 §3.6.3).
 *
 * Hand-written SVG sparkline (NOT recharts — 13 §3.6.4 anti-pattern: recharts
 * is reserved for the Metrics view). Capsule-velocity trace drawn with
 * framer-motion `pathLength` 0 → 1 (trace-draw), gated by `reduce`.
 */

import { motion } from 'framer-motion';
import { useMemo } from 'react';

import { grammarAccentClasses } from '@/app/workspace/lib/design';
import type { GrammarAccent } from '@/app/workspace/lib/design';
import { springLiquid } from '@/app/workspace/lib/design';

export interface GeneSparklineProps {
  /** Capsule velocity series (one value per bucket). */
  series: number[];
  accent: GrammarAccent;
  reduce: boolean;
  className?: string;
}

const W = 220;
const H = 40;

export function GeneSparkline({ series, accent, reduce, className }: GeneSparklineProps) {
  const a = grammarAccentClasses[accent];

  const path = useMemo(() => {
    if (series.length === 0) return '';
    const max = Math.max(...series, 1);
    const step = series.length > 1 ? W / (series.length - 1) : W;
    return series
      .map((v, i) => {
        const x = i * step;
        const y = H - (v / max) * (H - 4) - 2;
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  }, [series]);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width={W}
      height={H}
      className={className}
      preserveAspectRatio="none"
      aria-hidden
    >
      <motion.path
        d={path}
        fill="none"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={a.text}
        stroke="currentColor"
        initial={reduce ? false : { pathLength: 0, opacity: 0 }}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={springLiquid}
      />
    </svg>
  );
}
