'use client';

/**
 * Cold Start Overlay — Semi-transparent card on top of Graph
 *
 * Shows when totalExecutions < 10 and user hasn't dismissed it.
 * Displays featured genes with Install buttons + Get Started CTA.
 * Dismissable via × button, stored in localStorage.
 */

import { useState, useEffect } from 'react';
import { X, ArrowRight, Hexagon, Circle, Diamond } from 'lucide-react';

interface Gene {
  id: string;
  title: string;
  category: string;
  successRate: number;
  totalExecutions: number;
}

interface Props {
  genes: Gene[];
  isDark: boolean;
  onDismiss: () => void;
}

const STORAGE_KEY = 'prismer_map_cold_dismissed';

const CategoryIcon = ({ category, className }: { category: string; className?: string }) => {
  switch (category) {
    case 'repair':
      return <Hexagon className={className} size={14} />;
    case 'innovate':
      return <Diamond className={className} size={14} />;
    default:
      return <Circle className={className} size={14} />;
  }
};

const CATEGORY_COLORS: Record<string, string> = {
  repair: 'text-orange-400 border-orange-500/30',
  optimize: 'text-cyan-400 border-cyan-500/30',
  innovate: 'text-violet-400 border-violet-500/30',
};

export function ColdStartOverlay({ genes, isDark, onDismiss }: Props) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const dismissed = localStorage.getItem(STORAGE_KEY);
    if (!dismissed) setVisible(true);
  }, []);

  const handleDismiss = () => {
    localStorage.setItem(STORAGE_KEY, 'true');
    setVisible(false);
    onDismiss();
  };

  if (!visible) return null;

  // Pick up to 6 featured genes, balanced across categories
  const featured = selectFeatured(genes, 6);

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none">
      <div
        className={`pointer-events-auto max-w-lg w-full mx-4 rounded-2xl p-6 relative
          ${
            isDark
              ? 'bg-zinc-900/85 backdrop-blur-xl border border-white/[0.08] shadow-2xl shadow-black/40'
              : 'bg-white/90 backdrop-blur-xl border border-black/[0.06] shadow-2xl shadow-black/10'
          }`}
      >
        {/* Dismiss button */}
        <button
          onClick={handleDismiss}
          className={`absolute top-3 right-3 p-1 rounded-lg transition-colors
            ${isDark ? 'hover:bg-zinc-800 text-zinc-500' : 'hover:bg-zinc-100 text-zinc-400'}`}
        >
          <X size={16} />
        </button>

        {/* Headline */}
        <div className="text-center mb-5">
          <h3 className={`text-base font-semibold mb-1.5 ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
            Agents learn from success and failure.
          </h3>
          <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>
            Install a gene. Run your agent. Watch this network light up.
          </p>
        </div>

        {/* Featured gene grid */}
        <div className="grid grid-cols-2 gap-2 mb-5">
          {featured.map((gene) => {
            const colors = CATEGORY_COLORS[gene.category] || CATEGORY_COLORS.optimize;
            return (
              <button
                key={gene.id}
                onClick={() => (window.location.href = `/evolution?tab=library&gene=${gene.id}`)}
                className={`flex items-start gap-2 p-3 rounded-xl border text-left transition-all
                  ${
                    isDark
                      ? `bg-zinc-800/50 ${colors.split(' ')[1]} hover:bg-zinc-800`
                      : `bg-zinc-50 ${colors.split(' ')[1]} hover:bg-zinc-100`
                  }`}
              >
                <CategoryIcon category={gene.category} className={colors.split(' ')[0]} />
                <div className="min-w-0 flex-1">
                  <div className={`text-xs font-medium truncate ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
                    {gene.title || gene.id.replace(/^seed_/, '').replace(/_/g, ' ')}
                  </div>
                  <div className={`text-[10px] mt-0.5 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                    {gene.category} · {gene.totalExecutions} runs
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        {/* CTA */}
        <div className="text-center">
          <a
            href="/auth"
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium
              bg-violet-600 text-white hover:bg-violet-500 transition-colors"
          >
            Get Started
            <ArrowRight size={14} />
          </a>
        </div>
      </div>
    </div>
  );
}

function selectFeatured(genes: Gene[], max: number): Gene[] {
  const byCategory = new Map<string, Gene[]>();
  for (const g of genes) {
    const arr = byCategory.get(g.category) || [];
    arr.push(g);
    byCategory.set(g.category, arr);
  }

  // Sort each category by totalExecutions desc, pick top from each round-robin
  for (const [, arr] of byCategory) {
    arr.sort((a, b) => b.totalExecutions - a.totalExecutions);
  }

  const result: Gene[] = [];
  const cats = [...byCategory.keys()];
  let idx = 0;
  while (result.length < max && cats.length > 0) {
    const cat = cats[idx % cats.length];
    const arr = byCategory.get(cat)!;
    if (arr.length > 0) {
      result.push(arr.shift()!);
    } else {
      cats.splice(idx % cats.length, 1);
    }
    idx++;
  }
  return result;
}
