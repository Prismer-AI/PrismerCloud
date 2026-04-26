'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronRight, GitFork, Ban, Trash2, AlertTriangle } from 'lucide-react';
import { Sparkline } from '../sparkline';
import { glass, timeAgo } from '../helpers';
import { spring, ORIGIN_STYLES, BREAKER_STYLES } from './shared';
import type { WorkspaceGene } from '@/types/workspace';

interface GeneRowProps {
  entry: WorkspaceGene;
  isDark: boolean;
}

export function GeneRow({ entry, isDark }: GeneRowProps) {
  const [expanded, setExpanded] = useState(false);
  const { gene, origin, successRate, executions, breakerState, recentTrend, trendData, edgeCount, linkCount } = entry;

  const isBroken = breakerState === 'open';
  const originStyle = ORIGIN_STYLES[origin] || ORIGIN_STYLES.evolved;
  const breakerStyle = BREAKER_STYLES[breakerState] || BREAKER_STYLES.closed;
  const pct = Math.round(successRate * 100);

  const trendColor =
    recentTrend === 'up'
      ? 'text-emerald-500'
      : recentTrend === 'down'
        ? 'text-red-400'
        : isDark
          ? 'text-zinc-500'
          : 'text-zinc-400';
  const trendArrow = recentTrend === 'up' ? '\u2191' : recentTrend === 'down' ? '\u2193' : '\u2192';

  return (
    <motion.div layout transition={spring} className="overflow-hidden">
      {/* Row */}
      <motion.button
        onClick={() => setExpanded(!expanded)}
        className={`w-full text-left px-4 py-3 rounded-xl transition-colors flex items-center gap-3 group ${
          isBroken ? (isDark ? 'border-l-2 border-red-500/60' : 'border-l-2 border-red-400') : ''
        } ${isDark ? 'hover:bg-white/[0.03]' : 'hover:bg-zinc-50'}`}
      >
        {/* Breaker dot */}
        <span className={`w-2 h-2 rounded-full shrink-0 ${breakerStyle.dot}`} />

        {/* Title + origin */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`text-sm font-medium truncate ${isDark ? 'text-white' : 'text-zinc-900'}`}>
              {gene.title || gene.id}
            </span>
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${isDark ? originStyle.dark : originStyle.light}`}
            >
              {originStyle.label}
            </span>
          </div>
          {gene.description && (
            <p className={`text-[11px] truncate mt-0.5 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
              {gene.description}
            </p>
          )}
        </div>

        {/* Sparkline */}
        <div className="w-16 h-5 shrink-0 hidden sm:block">
          <Sparkline data={trendData.map((d) => d.score * 100)} />
        </div>

        {/* Success rate */}
        <div className={`text-right shrink-0 w-16 ${trendColor}`}>
          <span className="text-sm font-bold tabular-nums">{pct}%</span>
          <span className="text-xs ml-0.5">{trendArrow}</span>
        </div>

        {/* Executions */}
        <span
          className={`text-xs tabular-nums shrink-0 w-16 text-right hidden sm:block ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}
        >
          {executions} runs
        </span>

        {/* Expand chevron */}
        <motion.span
          animate={{ rotate: expanded ? 90 : 0 }}
          transition={spring}
          className={`shrink-0 ${isDark ? 'text-zinc-600' : 'text-zinc-300'}`}
        >
          <ChevronRight className="w-4 h-4" />
        </motion.span>
      </motion.button>

      {/* Expanded detail */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={spring}
            className="overflow-hidden"
          >
            <div className={`mx-4 mb-3 mt-1 p-4 rounded-lg ${glass(isDark, 'subtle')}`}>
              {/* Stats row */}
              <div className={`flex gap-6 text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>
                <span>{edgeCount} edges</span>
                <span>{linkCount} links</span>
                <span>Breaker: {breakerStyle.label}</span>
                {entry.skillSlug && <span>From: {entry.skillSlug}</span>}
                {gene.qualityScore != null && <span>Quality: {gene.qualityScore}</span>}
              </div>

              {/* Actions */}
              <div className="flex gap-2 mt-3">
                {isBroken && <ActionButton icon={AlertTriangle} label="Fix" variant="danger" isDark={isDark} />}
                <ActionButton icon={GitFork} label="Fork" isDark={isDark} />
                <ActionButton icon={Ban} label="Disable" isDark={isDark} />
                <ActionButton icon={Trash2} label="Delete" variant="danger" isDark={isDark} />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ── Inline action button ──────────────────────────────────

function ActionButton({
  icon: Icon,
  label,
  variant,
  isDark,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  variant?: 'danger';
  isDark: boolean;
}) {
  const base =
    variant === 'danger'
      ? isDark
        ? 'text-red-400 hover:bg-red-500/10'
        : 'text-red-500 hover:bg-red-50'
      : isDark
        ? 'text-zinc-400 hover:bg-white/5'
        : 'text-zinc-500 hover:bg-zinc-100';

  return (
    <button
      className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${base}`}
    >
      <Icon className="w-3.5 h-3.5" />
      {label}
    </button>
  );
}
