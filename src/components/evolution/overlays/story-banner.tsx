'use client';

/**
 * Story Banner — Real-time evolution event notification
 *
 * PRD §5.4: 40px, dark semi-transparent, slides in on new SSE events.
 * Clickable to zoom to the relevant gene.
 */

import { useState, useEffect, useRef } from 'react';
import { X, Zap } from 'lucide-react';
import type { EvolutionStory } from '../types/evolution-map.types';

interface Props {
  story: EvolutionStory | null;
  isDark: boolean;
  onStoryClick?: (geneId: string) => void;
}

function timeAgo(ts: string): string {
  const sec = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

export function StoryBanner({ story, isDark, onStoryClick }: Props) {
  const [visible, setVisible] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const prevStoryRef = useRef<string | null>(null);

  useEffect(() => {
    if (!story || dismissed) return;
    const storyKey = `${story.id}-${story.timestamp}`;
    if (prevStoryRef.current === storyKey) return;
    prevStoryRef.current = storyKey;

    // Slide in
    setVisible(false);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setVisible(true));
    });
  }, [story, dismissed]);

  if (!story || dismissed) return null;

  const outcomeEmoji = story.outcome === 'success' ? '✅' : '❌';
  const delta = story.effect.successRateDelta;
  const deltaStr = delta > 0 ? `+${(delta * 100).toFixed(1)}%` : delta < 0 ? `${(delta * 100).toFixed(1)}%` : '';

  return (
    <div
      className={`absolute top-0 left-0 right-0 z-15 transition-transform duration-300 ease-out ${
        visible ? 'translate-y-0' : '-translate-y-full'
      }`}
    >
      <div
        className={`h-10 flex items-center justify-between px-4 text-[11px] backdrop-blur-xl border-b cursor-pointer ${
          isDark
            ? 'bg-zinc-950/80 border-white/[0.06] text-zinc-300'
            : 'bg-white/80 border-black/[0.06] text-zinc-600 shadow-sm'
        }`}
        onClick={() => onStoryClick?.(story.gene.id)}
      >
        <div className="flex items-center gap-2 min-w-0">
          <Zap size={12} className={isDark ? 'text-violet-400' : 'text-violet-500'} />
          <span className={isDark ? 'text-zinc-500' : 'text-zinc-400'}>{timeAgo(story.timestamp)}</span>
          <span className="truncate">
            <span className="font-medium">{story.agent.name}</span>
            <span className={isDark ? 'text-zinc-600' : 'text-zinc-400'}>{' → '}</span>
            <span className="font-medium">{story.gene.name}</span>
            <span className={isDark ? 'text-zinc-600' : 'text-zinc-400'}>{' → '}</span>
            <span>{outcomeEmoji}</span>
            {deltaStr && <span className={delta > 0 ? 'text-emerald-400 ml-1' : 'text-rose-400 ml-1'}>{deltaStr}</span>}
          </span>
        </div>

        <button
          onClick={(e) => {
            e.stopPropagation();
            setDismissed(true);
          }}
          className={`ml-2 p-0.5 rounded flex-shrink-0 transition-colors ${
            isDark ? 'text-zinc-600 hover:text-zinc-300' : 'text-zinc-400 hover:text-zinc-700'
          }`}
        >
          <X size={12} />
        </button>
      </div>
    </div>
  );
}
