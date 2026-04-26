'use client';

import { useMemo } from 'react';
import { motion } from 'framer-motion';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { CAT_COLORS } from '../helpers';
import { spring } from './shared';
import type { WorkspaceGene } from '@/types/workspace';

interface ProgressChartProps {
  genes: WorkspaceGene[];
  isDark: boolean;
}

interface DayPoint {
  date: string;
  label: string;
  repair: number;
  optimize: number;
  innovate: number;
}

export function ProgressChart({ genes, isDark }: ProgressChartProps) {
  const data = useMemo(() => {
    // Aggregate trendData by category per day
    const dayMap = new Map<string, { repair: number[]; optimize: number[]; innovate: number[] }>();

    for (const s of genes) {
      const cat = (s.gene.category || 'repair') as 'repair' | 'optimize' | 'innovate';
      for (const point of s.trendData || []) {
        if (!dayMap.has(point.date)) {
          dayMap.set(point.date, { repair: [], optimize: [], innovate: [] });
        }
        const day = dayMap.get(point.date)!;
        if (cat in day) day[cat].push(point.score);
      }
    }

    const sorted = Array.from(dayMap.entries()).sort(([a], [b]) => a.localeCompare(b));
    return sorted.map(([date, cats]): DayPoint => {
      const avg = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
      const d = new Date(date);
      return {
        date,
        label: `${d.getMonth() + 1}/${d.getDate()}`,
        repair: Math.round(avg(cats.repair) * 100),
        optimize: Math.round(avg(cats.optimize) * 100),
        innovate: Math.round(avg(cats.innovate) * 100),
      };
    });
  }, [genes]);

  if (data.length === 0) return null;

  const tooltipStyle = {
    backgroundColor: isDark ? 'rgba(24,24,27,0.95)' : 'rgba(255,255,255,0.95)',
    border: isDark ? '1px solid rgba(255,255,255,0.1)' : '1px solid rgba(0,0,0,0.08)',
    borderRadius: '8px',
    color: isDark ? '#fff' : '#18181b',
    fontSize: '12px',
    backdropFilter: 'blur(12px)',
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ ...spring, delay: 0.15 }}
      className="w-full h-[200px] mt-4"
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
          <defs>
            {(['repair', 'optimize', 'innovate'] as const).map((cat) => (
              <linearGradient key={cat} id={`grad-${cat}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={CAT_COLORS[cat].hex} stopOpacity={0.3} />
                <stop offset="100%" stopColor={CAT_COLORS[cat].hex} stopOpacity={0.02} />
              </linearGradient>
            ))}
          </defs>
          <XAxis
            dataKey="label"
            axisLine={false}
            tickLine={false}
            tick={{ fontSize: 11, fill: isDark ? '#71717a' : '#a1a1aa' }}
          />
          <YAxis
            axisLine={false}
            tickLine={false}
            tick={{ fontSize: 11, fill: isDark ? '#71717a' : '#a1a1aa' }}
            domain={[0, 100]}
            tickFormatter={(v: number) => `${v}%`}
          />
          <Tooltip contentStyle={tooltipStyle} formatter={(v: any) => [`${v}%`]} />
          {(['innovate', 'optimize', 'repair'] as const).map((cat) => (
            <Area
              key={cat}
              type="monotone"
              dataKey={cat}
              stroke={CAT_COLORS[cat].hex}
              strokeWidth={2}
              fill={`url(#grad-${cat})`}
              animationDuration={800}
              animationEasing="ease-out"
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </motion.div>
  );
}
