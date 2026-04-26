'use client';

/**
 * Activity Section — Timeline of evolution events
 *
 * Part of the Evolution Map snap-scroll layout.
 * Shows recent agent learning events in a vertical timeline with glassmorphic cards.
 */

import { useMemo } from 'react';

const SIGNAL_CATEGORY_COLORS: Record<string, string> = {
  error: 'text-red-400',
  task: 'text-blue-400',
  capability: 'text-emerald-400',
  tag: 'text-amber-400',
};

function getSignalColor(category: string): string {
  return SIGNAL_CATEGORY_COLORS[category] ?? 'text-zinc-400';
}

function formatTimeAgo(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diffMs = now - then;

  if (Number.isNaN(diffMs) || diffMs < 0) return 'just now';

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

interface StoryItem {
  id: string;
  timestamp: string;
  agent: { id: string; name: string };
  task: { description: string };
  signal: { key: string; category: string; label: string };
  gene: { id: string; name: string; category: string };
  outcome: 'success' | 'failed';
  effect: {
    actionDescription: string;
    geneSuccessRateBefore: number;
    geneSuccessRateAfter: number;
    successRateDelta: number;
  };
  // v0.4.0: extraction traceability
  extractionMethod?: string;
  rootCause?: string;
  rawContextPreview?: string;
  score?: number;
}

interface Props {
  stories: StoryItem[] | null;
  isDark: boolean;
}

export function ActivitySection({ stories, isDark }: Props) {
  const visibleStories = useMemo(() => (stories ?? []).slice(0, 6), [stories]);

  const isEmpty = !stories || stories.length === 0;

  return (
    <section className="h-[calc(100vh-120px)] snap-start flex flex-col items-center">
      {/* Title */}
      <div className="text-center mt-12 mb-6 px-4">
        <h2 className={`text-2xl font-semibold tracking-tight ${isDark ? 'text-white' : 'text-zinc-900'}`}>
          Evolution Activity
        </h2>
        <p className={`mt-1 text-sm ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>Watch agents learn in real-time</p>
      </div>

      {/* Timeline or empty state */}
      {isEmpty ? (
        <div className="flex-1 flex items-center justify-center px-4">
          <div
            className={`max-w-sm text-center p-6 rounded-2xl backdrop-blur-xl border ${
              isDark ? 'bg-white/[0.06] border-white/[0.08]' : 'bg-black/[0.04] border-black/[0.08]'
            }`}
          >
            <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>
              No activity yet. Install a strategy and run your agent to see events here.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex-1 w-full max-w-[600px] overflow-hidden px-6 pb-4">
          <div className="relative border-l-2 border-violet-500/20 ml-3 pl-0">
            {visibleStories.map((story) => {
              const beforePct = Math.round(story.effect.geneSuccessRateBefore * 100);
              const afterPct = Math.round(story.effect.geneSuccessRateAfter * 100);
              const deltaPct = Math.round(story.effect.successRateDelta * 100);
              const isPositive = deltaPct >= 0;

              return (
                <div key={story.id} className="relative mb-4 last:mb-0">
                  {/* Timeline dot */}
                  <div
                    className={`absolute -left-[5px] top-4 w-2 h-2 rounded-full bg-violet-500 ring-2 ${
                      isDark ? 'ring-zinc-900' : 'ring-white'
                    }`}
                  />

                  {/* Time label */}
                  <div className="ml-4 mb-1">
                    <span className={`text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                      {formatTimeAgo(story.timestamp)}
                    </span>
                  </div>

                  {/* Event card */}
                  <div
                    className={`ml-6 rounded-xl p-4 backdrop-blur-xl border ${
                      isDark ? 'bg-white/[0.06] border-white/[0.08]' : 'bg-black/[0.04] border-black/[0.08]'
                    }`}
                  >
                    {/* Line 1: outcome + agent name */}
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs">{story.outcome === 'success' ? '\u2705' : '\u274C'}</span>
                      <span className={`text-xs font-bold ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
                        {story.agent.name}
                      </span>
                    </div>

                    {/* Line 2: task */}
                    <p className={`mt-1 text-[11px] ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>
                      Task: {story.task.description}
                    </p>

                    {/* Line 3: trigger (signal) */}
                    <p className={`mt-0.5 text-[11px] font-mono ${getSignalColor(story.signal.category)}`}>
                      Trigger: {story.signal.key}
                    </p>

                    {/* Line 4: strategy (gene) */}
                    <p className={`mt-0.5 text-[11px] ${isDark ? 'text-zinc-300' : 'text-zinc-600'}`}>
                      Strategy: {story.gene.name}
                    </p>

                    {/* Line 5: action description */}
                    <p className={`mt-1 text-[11px] italic ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                      {story.effect.actionDescription}
                    </p>

                    {/* Line 5b: extraction trace (if available) */}
                    {story.rootCause && (
                      <p className={`mt-0.5 text-[10px] ${isDark ? 'text-amber-400/70' : 'text-amber-600/70'}`}>
                        Root cause: {story.rootCause}
                      </p>
                    )}
                    {story.extractionMethod && (
                      <p className={`mt-0.5 text-[10px] ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                        via {story.extractionMethod}
                        {story.score != null ? ` \u2022 score: ${Math.round(story.score * 100)}%` : ''}
                      </p>
                    )}

                    {/* Line 6: rate change */}
                    <p className="mt-1.5 text-[11px] font-bold">
                      <span className={isDark ? 'text-zinc-300' : 'text-zinc-600'}>{beforePct}%</span>
                      <span className={isDark ? 'text-zinc-500' : 'text-zinc-400'}>{' \u2192 '}</span>
                      <span className={isDark ? 'text-zinc-300' : 'text-zinc-600'}>{afterPct}%</span>{' '}
                      <span className={isPositive ? 'text-emerald-400' : 'text-red-400'}>
                        {isPositive ? '\u25B2' : '\u25BC'}
                        {isPositive ? '+' : ''}
                        {deltaPct}%
                      </span>
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Scroll indicator */}
      <div className="pb-6 flex flex-col items-center animate-pulse">
        <span className={`text-[11px] ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>&darr; Network Graph</span>
      </div>
    </section>
  );
}
