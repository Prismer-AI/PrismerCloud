'use client';

/**
 * SpringCounter — release201/13 §3.7 (Metrics control-tower) + doc 20 §9.2 V3.
 *
 * Counter value animates from 0 → target via framer-motion `useSpring`, using
 * the `springSplat` config from design.ts (also exported as
 * `motionPreset.springCounter.transition`).
 *
 * Reduced-motion fallback:
 *   `useReducedMotion()` → start spring at `value` so no interpolation runs;
 *   subsequent value changes also `.jump()` straight to target.
 *
 * Distinct from `evolution/components/workspace/animated-counter.tsx`:
 *   - that one formats with k/percent/currency for the Insights dashboard;
 *   - this one renders a raw decimal-formatted number with optional suffix
 *     (label like " ms" / "%") so the Metrics view can compose its own units.
 */

import { useEffect, useRef } from 'react';
import { motion, useReducedMotion, useSpring, useTransform } from 'framer-motion';
import { springSplat } from '@/app/workspace/lib/design';

export interface SpringCounterProps {
  value: number;
  decimals?: number;
  suffix?: string;
  className?: string;
}

export function SpringCounter({ value, decimals = 0, suffix, className }: SpringCounterProps) {
  const prefersReducedMotion = useReducedMotion();

  // Spring config — pulled from design.ts so the chromatic + motion contract
  // stays greppable (see motionPreset.springCounter.transition).
  const stiffness = (springSplat as { stiffness?: number }).stiffness ?? 600;
  const damping = (springSplat as { damping?: number }).damping ?? 18;
  const mass = (springSplat as { mass?: number }).mass ?? 0.4;

  // Under reducedMotion, initialise the spring at the target so it never
  // animates from 0 → value. Otherwise start at 0 and spring up on mount.
  const spring = useSpring(prefersReducedMotion ? value : 0, { stiffness, damping, mass });

  const initialized = useRef(false);
  useEffect(() => {
    if (prefersReducedMotion) {
      spring.jump(value);
      return;
    }
    if (!initialized.current) {
      initialized.current = true;
      spring.set(value);
    } else {
      spring.set(value);
    }
  }, [spring, value, prefersReducedMotion]);

  const display = useTransform(spring, (latest) => {
    const formatted = latest.toFixed(decimals);
    return suffix ? `${formatted}${suffix}` : formatted;
  });

  return (
    <motion.span data-testid="spring-counter" className={className}>
      {display}
    </motion.span>
  );
}
