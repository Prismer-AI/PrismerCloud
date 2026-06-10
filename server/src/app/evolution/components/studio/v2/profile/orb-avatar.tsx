'use client';

/**
 * Profile — state-driven siri-orb avatar (release201/28 §4 / doc 13 §3.5.1).
 *
 * Reuses `src/components/ui/siri-orb.tsx`. Runtime state maps onto motion:
 *   idle     → slow breathing ring (4s loop)
 *   thinking → medium ripple
 *   busy     → fast bright pulse
 *   offline  → static, dimmed
 *
 * `useReducedMotion()` collapses the breathing/pulse to a static ring. The orb
 * canvas spin slows for idle / speeds for busy via `animationDuration`.
 */

import { motion, useReducedMotion } from 'framer-motion';

import { grammarAccentClasses } from '@/app/workspace/lib/design';
import { SiriOrb } from '@/components/ui/siri-orb';
import { cn } from '@/lib/utils';

import type { AgentRuntimeState } from '../types';

const ACCENT = grammarAccentClasses.rose;

const SPIN_DURATION: Record<AgentRuntimeState, number> = {
  idle: 26,
  thinking: 14,
  busy: 7,
  offline: 60,
};

// Ring breathing scale + opacity per state (animate target arrays).
const RING_MOTION: Record<AgentRuntimeState, { scale: number[]; opacity: number[]; duration: number }> = {
  idle: { scale: [1, 1.06, 1], opacity: [0.35, 0.55, 0.35], duration: 4 },
  thinking: { scale: [1, 1.12, 1], opacity: [0.4, 0.7, 0.4], duration: 2 },
  busy: { scale: [1, 1.18, 1], opacity: [0.5, 0.9, 0.5], duration: 1 },
  offline: { scale: [1, 1, 1], opacity: [0.15, 0.15, 0.15], duration: 8 },
};

interface OrbAvatarProps {
  state: AgentRuntimeState;
  /** Edge length, px. */
  size?: number;
  /** Two-letter monogram overlaid in the centre. */
  monogram: string;
  isDark: boolean;
}

export function OrbAvatar({ state, size = 192, monogram, isDark }: OrbAvatarProps) {
  const reduce = useReducedMotion();
  const ring = RING_MOTION[state];
  const dimmed = state === 'offline';

  return (
    <div className="relative flex items-center justify-center" style={{ width: size + 48, height: size + 48 }}>
      {/* Breathing / pulse glow ring */}
      <motion.span
        aria-hidden
        className="absolute rounded-full"
        style={{
          width: size,
          height: size,
          boxShadow: `0 0 60px 12px ${ACCENT.glow}`,
        }}
        animate={reduce ? { opacity: ring.opacity[0] } : { scale: ring.scale, opacity: ring.opacity }}
        transition={reduce ? { duration: 0 } : { duration: ring.duration, repeat: Infinity, ease: 'easeInOut' }}
      />
      <div className={cn('relative', dimmed && 'opacity-50 grayscale')}>
        <SiriOrb size={`${size}px`} animationDuration={SPIN_DURATION[state]} />
        <span
          className={cn(
            'pointer-events-none absolute inset-0 flex items-center justify-center text-2xl font-bold tracking-tight',
            isDark ? 'text-white/90' : 'text-white',
          )}
          style={{ textShadow: '0 1px 8px rgba(0,0,0,0.45)' }}
          aria-hidden
        >
          {monogram}
        </span>
      </div>
    </div>
  );
}
