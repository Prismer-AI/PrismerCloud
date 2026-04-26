'use client';

import { motion } from 'framer-motion';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { spring } from './shared';
import { AnimatedCounter } from './animated-counter';

interface HeroKpiProps {
  label: string;
  value: number;
  format?: 'number' | 'percent' | 'currency';
  decimals?: number;
  /** Optional delta text like "+3 new" or "3 stale" */
  delta?: string;
  /** Trend direction for delta coloring */
  trend?: 'up' | 'down' | 'stable';
  /** Make this the hero (larger) vs supporting (smaller) */
  hero?: boolean;
  isDark: boolean;
}

export function HeroKpi({ label, value, format = 'number', decimals = 0, delta, trend, hero, isDark }: HeroKpiProps) {
  const trendColor = {
    up: 'text-emerald-500',
    down: 'text-red-400',
    stable: isDark ? 'text-zinc-500' : 'text-zinc-400',
  }[trend || 'stable'];

  const TrendIcon = trend === 'up' ? TrendingUp : trend === 'down' ? TrendingDown : Minus;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={spring}
      className={hero ? 'flex-[2]' : 'flex-1'}
    >
      <p className={`text-[11px] font-medium uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
        {label}
      </p>
      <AnimatedCounter
        value={value}
        format={format}
        decimals={decimals}
        className={`font-bold tabular-nums ${hero ? 'text-3xl' : 'text-xl'} ${isDark ? 'text-white' : 'text-zinc-900'}`}
      />
      {delta && (
        <div className={`flex items-center gap-1 mt-0.5 ${trendColor}`}>
          <TrendIcon className="w-3 h-3" />
          <span className="text-[11px] font-medium">{delta}</span>
        </div>
      )}
    </motion.div>
  );
}
