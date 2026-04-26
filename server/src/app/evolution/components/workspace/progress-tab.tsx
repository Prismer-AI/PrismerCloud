'use client';

import { useMemo } from 'react';
import { motion } from 'framer-motion';
import { spring } from './shared';
import { HeroKpi } from './hero-kpi';
import { ProgressChart } from './progress-chart';
import { GeneRow } from './gene-row';
import type { WorkspaceView } from '@/types/workspace';

interface ProgressTabProps {
  view: WorkspaceView;
  isDark: boolean;
}

export function ProgressTab({ view, isDark }: ProgressTabProps) {
  const genes = view.genes || [];
  const memoryFiles = view.memory || [];
  const credits = view.credits;

  const stats = useMemo(() => {
    const total = genes.length;
    const avgSuccess = total > 0 ? genes.reduce((sum, s) => sum + s.successRate, 0) / total : 0;

    // Compute 7d delta: compare avg of last day vs first day of trendData
    let delta7d = 0;
    const withTrend = genes.filter((s) => s.trendData?.length >= 2);
    if (withTrend.length > 0) {
      const firstAvg = withTrend.reduce((sum, s) => sum + s.trendData[0].score, 0) / withTrend.length;
      const lastAvg =
        withTrend.reduce((sum, s) => sum + s.trendData[s.trendData.length - 1].score, 0) / withTrend.length;
      delta7d = (lastAvg - firstAvg) * 100;
    }

    // Count new genes (created in last 7 days via trendData length as proxy)
    const newCount = genes.filter((s) => s.executions <= 5).length;
    const staleCount = memoryFiles.filter((m) => m.stale).length;
    const breakerOpenCount = genes.filter((s) => s.breakerState === 'open').length;

    return { total, avgSuccess, delta7d, newCount, staleCount, breakerOpenCount };
  }, [genes, memoryFiles]);

  // Sort: breaker-open first, then by success rate descending
  const sortedGenes = useMemo(() => {
    return [...genes].sort((a, b) => {
      if (a.breakerState === 'open' && b.breakerState !== 'open') return -1;
      if (b.breakerState === 'open' && a.breakerState !== 'open') return 1;
      return b.successRate - a.successRate;
    });
  }, [genes]);

  const successTrend = stats.delta7d >= 0.5 ? 'up' : stats.delta7d <= -0.5 ? 'down' : 'stable';
  const deltaPct = `${stats.delta7d >= 0 ? '+' : ''}${stats.delta7d.toFixed(1)}%`;

  return (
    <motion.div
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 20 }}
      transition={spring}
    >
      {/* Hero KPIs */}
      <div className="flex gap-6 items-start">
        <HeroKpi
          label="Success Rate"
          value={stats.avgSuccess * 100}
          format="percent"
          decimals={1}
          delta={deltaPct}
          trend={successTrend}
          hero
          isDark={isDark}
        />
        <div className={`w-px self-stretch ${isDark ? 'bg-white/[0.06]' : 'bg-zinc-200'}`} />
        <HeroKpi
          label="Genes"
          value={stats.total}
          delta={stats.newCount > 0 ? `${stats.newCount} new` : undefined}
          trend={stats.newCount > 0 ? 'up' : 'stable'}
          isDark={isDark}
        />
        <HeroKpi
          label="Memories"
          value={memoryFiles.length}
          delta={stats.staleCount > 0 ? `${stats.staleCount} stale` : undefined}
          trend={stats.staleCount > 0 ? 'down' : 'stable'}
          isDark={isDark}
        />
        <HeroKpi label="Credits" value={credits?.balance ?? 0} format="currency" isDark={isDark} />
      </div>

      {/* Area Chart */}
      <ProgressChart genes={genes} isDark={isDark} />

      {/* Gene List */}
      {sortedGenes.length > 0 ? (
        <div className="mt-4 space-y-1">
          <div className={`flex items-center justify-between px-4 mb-2`}>
            <h3
              className={`text-xs font-semibold uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}
            >
              Genes
              {stats.breakerOpenCount > 0 && (
                <span className="ml-2 text-red-400">{stats.breakerOpenCount} need attention</span>
              )}
            </h3>
          </div>
          {sortedGenes.map((s) => (
            <GeneRow key={s.gene.id} entry={s} isDark={isDark} />
          ))}
        </div>
      ) : (
        <EmptyProgress isDark={isDark} />
      )}
    </motion.div>
  );
}

function EmptyProgress({ isDark }: { isDark: boolean }) {
  return (
    <div className="text-center py-16">
      <p className={`text-sm ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
        No genes yet. Install skills or record outcomes to start building your knowledge.
      </p>
    </div>
  );
}
