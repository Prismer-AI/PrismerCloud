'use client';

import { useEffect, useRef } from 'react';
import { motion, useSpring, useTransform } from 'framer-motion';
import { counterSpring } from './shared';

interface AnimatedCounterProps {
  value: number;
  /** Format: 'number' (default), 'percent', 'currency' */
  format?: 'number' | 'percent' | 'currency';
  decimals?: number;
  className?: string;
}

export function AnimatedCounter({ value, format = 'number', decimals = 0, className }: AnimatedCounterProps) {
  const springValue = useSpring(0, counterSpring);
  const display = useTransform(springValue, (v) => {
    const n = Math.abs(v);
    let formatted: string;
    if (format === 'percent') {
      formatted = `${n.toFixed(decimals)}%`;
    } else if (format === 'currency') {
      formatted = n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n.toFixed(0);
      formatted = `\u20A1 ${formatted}`;
    } else {
      formatted = n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n.toFixed(decimals);
    }
    return formatted;
  });

  const initialized = useRef(false);
  useEffect(() => {
    if (!initialized.current) {
      springValue.jump(value);
      initialized.current = true;
    } else {
      springValue.set(value);
    }
  }, [value, springValue]);

  return <motion.span className={className}>{display}</motion.span>;
}
