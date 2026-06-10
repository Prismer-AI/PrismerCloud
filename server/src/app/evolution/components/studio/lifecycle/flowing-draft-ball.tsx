'use client';

/**
 * Flowing Draft Ball — release201/13 §3.3 + doc 20 §9.2 V1.
 *
 * Visually anchors the pipeline grammar: a cyan ball that flows along the
 * 11 sub-stage rail with a liquid spring transition. The ball position is
 * driven by `activeSubStage` (0-10 index inside `subStages`). A faded SVG
 * trail follows the ball from `stage 0` to the active capsule so users
 * see "how far the draft has flowed".
 *
 * Anti-同质化 anchor: this is the *only* place that renders the moving ball;
 * the pipeline rail itself stays static (`pipeline-rail.tsx`). Removing
 * this component reduces the pipeline view to a 1px gradient strip — which
 * is exactly the regression user reported on 2026-05-28 ("evolution studio
 * 点来点去没有任何分别的界面").
 *
 * `prefers-reduced-motion` fallback: ball collapses to an opacity fade-in
 * pinned to the active capsule (no `cx` animation, no trail).
 */

import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import type { LifecycleSubStage } from '../types';
import { springLiquid } from '@/app/workspace/lib/design';

interface SubStageDescriptor {
  key: LifecycleSubStage;
  label: string;
}

interface FlowingDraftBallProps {
  isDark: boolean;
  /** Active stage drives the ball x-position (0..N-1 / (N-1)). */
  activeSubStage: LifecycleSubStage | null;
  /** Ordered list of 11 sub-stages (LIFECYCLE_PIPELINE_STAGES). */
  subStages: ReadonlyArray<SubStageDescriptor>;
  /**
   * When true, ball position is set instantly and trail is hidden. Drives
   * the `prefers-reduced-motion` fallback. Parent should compute this from
   * `useReducedMotion()` to keep ssr-safe.
   */
  reducedMotion?: boolean;
}

const SVG_HEIGHT = 28;
const BALL_RADIUS = 7;

export function FlowingDraftBall({ isDark, activeSubStage, subStages, reducedMotion }: FlowingDraftBallProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState<number>(0);

  // Track container width so the ball aligns with the underlying capsule
  // positions (PipelineRail uses `flex-1` capsules, so each capsule occupies
  // 1/N of the rail width). We resize on mount + on window resize.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  const n = subStages.length;
  const activeIdx = activeSubStage ? subStages.findIndex((s) => s.key === activeSubStage) : 0;
  const safeIdx = activeIdx < 0 ? 0 : activeIdx;
  // Each capsule centre = (i + 0.5) / N * width — matches the `flex-1` rail.
  const cx = n > 0 ? ((safeIdx + 0.5) / n) * width : 0;
  const cy = SVG_HEIGHT / 2;

  // Trail starts at the first capsule centre (matches ball start position).
  const trailStartX = n > 0 ? (0.5 / n) * width : 0;

  const ballFill = isDark ? '#22d3ee' : '#0891b2'; // cyan-400 / cyan-600
  const trailStroke = isDark ? 'rgba(34,211,238,0.55)' : 'rgba(8,145,178,0.6)';
  const glowFill = isDark ? 'rgba(34,211,238,0.35)' : 'rgba(8,145,178,0.25)';

  return (
    <div
      ref={containerRef}
      data-testid="flowing-draft-ball"
      data-active-stage={activeSubStage ?? 'intake'}
      data-active-index={String(safeIdx)}
      data-reduced-motion={reducedMotion ? 'true' : 'false'}
      className="pointer-events-none relative w-full"
      style={{ height: SVG_HEIGHT }}
      aria-hidden
    >
      {width > 0 && (
        <svg width={width} height={SVG_HEIGHT} className="absolute inset-0 overflow-visible">
          {/* Liquid trail — hidden under reduced-motion. */}
          {!reducedMotion && safeIdx > 0 && (
            <motion.line
              data-testid="flowing-draft-ball-trail"
              x1={trailStartX}
              y1={cy}
              y2={cy}
              stroke={trailStroke}
              strokeWidth={3}
              strokeLinecap="round"
              initial={false}
              animate={{ x2: cx }}
              transition={springLiquid}
              style={{ filter: 'blur(0.5px)' }}
            />
          )}
          {/* Ball glow — wider, softer circle behind the ball. */}
          <motion.circle
            r={BALL_RADIUS * 2.2}
            cy={cy}
            fill={glowFill}
            initial={false}
            animate={reducedMotion ? { cx, opacity: 1 } : { cx, opacity: [0.4, 0.85, 0.4] }}
            transition={
              reducedMotion
                ? { duration: 0 }
                : {
                    cx: springLiquid,
                    opacity: { duration: 1.6, repeat: Infinity, ease: 'easeInOut' },
                  }
            }
            style={{ filter: 'blur(3px)' }}
          />
          {/* Ball core — the actual draft marker. */}
          <motion.circle
            data-testid="flowing-draft-ball-core"
            r={BALL_RADIUS}
            cy={cy}
            fill={ballFill}
            initial={false}
            animate={{ cx }}
            transition={reducedMotion ? { duration: 0 } : springLiquid}
          />
        </svg>
      )}
    </div>
  );
}
