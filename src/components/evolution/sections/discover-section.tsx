'use client';

/**
 * Discover Section — Horizontal card carousel of top strategies
 *
 * Part of the Evolution Map snap-scroll layout.
 * Glassmorphic cards sorted by PQI, with category badges and success rate bars.
 */

import { useMemo } from 'react';

const SPRING_EASING = 'cubic-bezier(0.175, 0.885, 0.32, 1.275)';

const CATEGORY_STYLES: Record<string, { bg: string; text: string; border: string }> = {
  repair:   { bg: 'bg-orange-500/15', text: 'text-orange-400', border: 'border-orange-500/20' },
  optimize: { bg: 'bg-cyan-500/15',   text: 'text-cyan-400',   border: 'border-cyan-500/20' },
  innovate: { bg: 'bg-violet-500/15', text: 'text-violet-400', border: 'border-violet-500/20' },
};

function getCategoryStyle(category: string) {
  return CATEGORY_STYLES[category] ?? CATEGORY_STYLES.optimize;
}

interface Props {
  genes: Array<{
    id: string;
    title: string;
    category: string;
    successRate: number;
    totalExecutions: number;
    agentCount: number;
    pqi: number;
  }>;
  isDark: boolean;
}

export function DiscoverSection({ genes, isDark }: Props) {
  const topGenes = useMemo(
    () => [...genes].sort((a, b) => b.pqi - a.pqi).slice(0, 8),
    [genes],
  );

  return (
    <section
      className="h-[calc(100vh-120px)] snap-start flex flex-col items-center justify-center"
    >
      {/* Title */}
      <div className="text-center mb-6 px-4">
        <h2
          className={`text-2xl font-semibold tracking-tight ${
            isDark ? 'text-white' : 'text-zinc-900'
          }`}
        >
          Discover Strategies
        </h2>
        <p
          className={`mt-1 text-sm ${
            isDark ? 'text-zinc-400' : 'text-zinc-500'
          }`}
        >
          Browse proven strategies your agent can use
        </p>
      </div>

      {/* Horizontal scrolling card carousel */}
      <div
        className="flex gap-4 overflow-x-auto snap-x snap-mandatory px-8 py-6 max-w-full"
        style={{
          scrollbarWidth: 'none',
          msOverflowStyle: 'none',
        }}
      >
        <style>{`
          .discover-carousel::-webkit-scrollbar {
            display: none;
          }
        `}</style>
        <div className="discover-carousel flex gap-4 overflow-x-auto snap-x snap-mandatory px-8 py-6 max-w-full">
          {topGenes.map((gene) => {
            const catStyle = getCategoryStyle(gene.category);
            const successPct = Math.round(gene.successRate * 100);

            return (
              <div
                key={gene.id}
                className={`
                  flex-shrink-0 snap-center rounded-2xl p-5 backdrop-blur-xl border
                  transition-all duration-500
                  ${isDark
                    ? 'bg-white/[0.06] border-white/[0.08] hover:border-white/[0.18]'
                    : 'bg-black/[0.04] border-black/[0.08] hover:border-black/[0.18]'
                  }
                `}
                style={{
                  width: '280px',
                  minWidth: '280px',
                  transitionTimingFunction: SPRING_EASING,
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.transform = 'scale(1.03)';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.transform = 'scale(1)';
                }}
              >
                {/* Category badge */}
                <span
                  className={`
                    inline-block px-2 py-0.5 rounded-full text-[10px] font-medium border
                    ${catStyle.bg} ${catStyle.text} ${catStyle.border}
                  `}
                >
                  {gene.category}
                </span>

                {/* Title */}
                <h3
                  className={`mt-3 text-base font-semibold leading-snug line-clamp-2 ${
                    isDark ? 'text-white' : 'text-zinc-900'
                  }`}
                >
                  {gene.title}
                </h3>

                {/* Success rate bar */}
                <div className="mt-3">
                  <div
                    className={`w-full h-1 rounded-full ${
                      isDark ? 'bg-white/[0.06]' : 'bg-black/[0.06]'
                    }`}
                  >
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${successPct}%`,
                        background: 'linear-gradient(90deg, #22c55e, #4ade80)',
                      }}
                    />
                  </div>
                  <span
                    className={`block mt-1 text-[10px] text-right ${
                      isDark ? 'text-zinc-500' : 'text-zinc-400'
                    }`}
                  >
                    {successPct}% success
                  </span>
                </div>

                {/* Stats line */}
                <p
                  className={`mt-2 text-[11px] ${
                    isDark ? 'text-zinc-500' : 'text-zinc-400'
                  }`}
                >
                  {gene.totalExecutions} runs &middot; {gene.agentCount} agents &middot; PQI {gene.pqi}
                </p>

                {/* Install button */}
                <button
                  className={`
                    mt-4 w-full py-1.5 rounded-lg text-xs font-medium
                    transition-all duration-300
                    bg-violet-600 hover:bg-violet-500 text-white
                  `}
                  style={{ transitionTimingFunction: SPRING_EASING }}
                >
                  Install &rarr;
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Scroll indicator */}
      <div className="mt-6 flex flex-col items-center animate-pulse">
        <span
          className={`text-[11px] ${
            isDark ? 'text-zinc-600' : 'text-zinc-400'
          }`}
        >
          &darr; Activity
        </span>
      </div>
    </section>
  );
}
