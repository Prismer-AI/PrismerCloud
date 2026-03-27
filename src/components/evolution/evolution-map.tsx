'use client';

/**
 * Evolution Map — Graph-first layout
 *
 * Shows the canvas network visualization directly.
 * Data fetching lives here; GraphSection receives data via props.
 */

import { useState, useEffect, useRef } from 'react';
import type { EvolutionMapData, EvolutionStory } from './types/evolution-map.types';
import { GraphSection } from './sections/graph-section';

// Inlined from app/evolution/components/helpers to avoid components→app boundary violation
interface FeedEvent {
  type: 'capsule' | 'distill' | 'publish' | 'milestone' | 'import';
  timestamp: string;
  agentName: string;
  geneTitle: string;
  geneId?: string;
  geneCategory: string;
  outcome?: string;
  score?: number;
  summary?: string;
}
const CAT_COLORS: Record<string, { hex: string }> = {
  repair: { hex: '#f97316' },
  optimize: { hex: '#06b6d4' },
  innovate: { hex: '#8b5cf6' },
};
const FEED_ICONS: Record<string, { color: string }> = {
  capsule: { color: 'text-emerald-400' },
  distill: { color: 'text-violet-400' },
  publish: { color: 'text-amber-400' },
  milestone: { color: 'text-cyan-400' },
  import: { color: 'text-blue-400' },
};
function timeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}
import { MOCK_MAP_DATA, MOCK_STORIES } from './canvas/mock-data';
import {
  Loader2,
  ChevronLeft,
  ChevronRight,
  Dna,
  Activity,
  CircleDot,
  Diamond,
  Star,
  Trophy,
  XCircle,
} from 'lucide-react';

const SPRING_EASING = 'cubic-bezier(0.175, 0.885, 0.32, 1.275)';
const FEED_ICON_MAP: Record<string, typeof CircleDot> = {
  capsule: CircleDot,
  distill: Diamond,
  publish: Star,
  milestone: Trophy,
};

interface Props {
  isDark: boolean;
  fullHeight?: boolean;
}

export function EvolutionMap({ isDark }: Props) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarTab, setSidebarTab] = useState<'genes' | 'activity'>('genes');
  const [feed, setFeed] = useState<FeedEvent[]>([]);
  const [focusGeneId, setFocusGeneId] = useState<string | undefined>();
  const [focusSeq, setFocusSeq] = useState(0);
  const [data, setData] = useState<EvolutionMapData | null>(null);
  const [stories, setStories] = useState<EvolutionStory[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Track feed geneIds for anchored map loading on refresh cycles
  const feedGeneIdsRef = useRef<string[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function fetchAll() {
      try {
        setLoading(true);

        // Step 1: Feed first — extract geneIds to anchor map loading
        let feedGeneIds: string[] = feedGeneIdsRef.current;
        try {
          const feedRes = await fetch('/api/im/evolution/public/feed?limit=30');
          if (!cancelled && feedRes.ok) {
            const feedJson = await feedRes.json();
            if (Array.isArray(feedJson.data)) {
              const filtered = (feedJson.data as FeedEvent[]).filter((e) => e.geneId !== 'unmatched');
              setFeed(filtered);
              feedGeneIds = [...new Set(filtered.map((e) => e.geneId).filter(Boolean))] as string[];
              feedGeneIdsRef.current = feedGeneIds;
            }
          }
        } catch {
          /* feed failure is non-fatal */
        }

        // Step 2: Map (with feed geneIds) + stories in parallel
        const ids = feedGeneIds.slice(0, 20);
        const mapUrl =
          ids.length > 0 ? `/api/im/evolution/map?includeGeneIds=${ids.join(',')}` : '/api/im/evolution/map';

        const [mapRes, storiesRes] = await Promise.all([
          fetch(mapUrl),
          fetch('/api/im/evolution/stories?limit=3&since=30').catch(() => null),
        ]);

        // Process map
        const mapJson = await mapRes.json();
        if (!cancelled && mapJson.ok) {
          setData(mapJson.data?.genes?.length > 0 ? mapJson.data : MOCK_MAP_DATA);
          setError(null);
        } else if (!cancelled) {
          setData(MOCK_MAP_DATA);
          setError(null);
        }

        // Process stories
        if (!cancelled && storiesRes?.ok) {
          try {
            const storiesJson = await storiesRes.json();
            setStories(
              storiesJson.ok && Array.isArray(storiesJson.data) && storiesJson.data.length > 0
                ? storiesJson.data
                : MOCK_STORIES,
            );
          } catch {
            setStories(MOCK_STORIES);
          }
        } else if (!cancelled) {
          setStories(MOCK_STORIES);
        }
      } catch {
        if (!cancelled) {
          setData(MOCK_MAP_DATA);
          setStories(MOCK_STORIES);
          setError(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchAll();

    const interval = setInterval(fetchAll, 30000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // SSE for real-time feed updates
  useEffect(() => {
    let token: string | null = null;
    try {
      token = JSON.parse(localStorage.getItem('prismer_auth') || '{}')?.token;
    } catch {}
    if (!token) return;
    let es: EventSource | null = null;
    try {
      es = new EventSource(`/api/im/sse?token=${token}`);
      es.addEventListener('evolution:capsule', (e: MessageEvent) => {
        try {
          const d = JSON.parse(e.data);
          setFeed((prev) =>
            [
              {
                type: 'capsule' as const,
                timestamp: new Date().toISOString(),
                agentName: d.agentId?.slice(-8) || 'agent',
                geneTitle: d.geneId || 'Unknown',
                geneCategory: 'repair',
                outcome: d.outcome,
                score: d.score,
                summary: d.summary,
              },
              ...prev,
            ].slice(0, 50),
          );
        } catch {}
      });
      es.onerror = () => {};
    } catch {}
    return () => {
      es?.close();
    };
  }, []);

  // Track fullscreen state
  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  if (loading && !data) {
    return (
      <div className="h-[calc(100vh-120px)] flex items-center justify-center">
        <div className={`flex items-center gap-3 ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>
          <Loader2 size={20} className="animate-spin" />
          <span className="text-sm">Loading Evolution Map...</span>
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="h-[calc(100vh-120px)] flex items-center justify-center">
        <div className={`text-center ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>
          <p className="text-sm">{error}</p>
          <button onClick={() => window.location.reload()} className="mt-2 text-xs text-violet-400 hover:underline">
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!data) return null;

  // Client-side title cleanup for genes with raw IDs (e.g. "gene_repair_mmxvkp1p")
  const cleanData = (() => {
    const catCount: Record<string, number> = {};
    const genes = data.genes.map((g) => {
      if (g.title && !/^gene[_ ]/.test(g.title)) return g;
      const cleaned = (g.title || '')
        .replace(/^gene[_ ]/, '')
        .replace(/[_ ][a-z0-9]{6,10}$/, '')
        .trim();
      if (cleaned && cleaned !== g.category) {
        return {
          ...g,
          title: cleaned
            .split(/[_ ]/)
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
            .join(' '),
        };
      }
      // Fallback: "Repair #1", "Repair #2" etc.
      const cat = g.category.charAt(0).toUpperCase() + g.category.slice(1);
      catCount[cat] = (catCount[cat] || 0) + 1;
      return { ...g, title: `${cat} #${catCount[cat]}` };
    });
    return { ...data, genes };
  })();

  // Only pass real stories (not mock) to avoid fake banner
  const realStories = stories === MOCK_STORIES ? undefined : (stories ?? undefined);

  const topGenes = [...cleanData.genes].sort((a, b) => b.totalExecutions - a.totalExecutions).slice(0, 10);

  const zoomToGene = (event: FeedEvent) => {
    const { geneId, geneTitle } = event;

    // 1. Match by geneId (most reliable)
    if (geneId) {
      const byId = cleanData.genes.find((g) => g.id === geneId) || data.genes.find((g) => g.id === geneId);
      if (byId) {
        setFocusGeneId(byId.id);
        setFocusSeq((s) => s + 1);
        return;
      }
    }

    // 2. Match by title (cleaned or raw)
    if (geneTitle) {
      const byTitle =
        cleanData.genes.find((g) => g.title === geneTitle) || data.genes.find((g) => g.title === geneTitle);
      if (byTitle) {
        setFocusGeneId(byTitle.id);
        setFocusSeq((s) => s + 1);
        return;
      }
    }

    // 3. Gene not in current map view — no-op (feed geneIds are preloaded into map)
    console.warn('[EvolutionMap] Gene not found in map data:', geneId || geneTitle);
  };

  return (
    <div className="w-full px-2 pt-2 pb-2">
      {/* 16:9 aspect ratio container — fullscreen target */}
      <div
        ref={mapContainerRef}
        className={`relative w-full overflow-hidden ${isFullscreen ? '' : 'rounded-2xl'}`}
        style={isFullscreen ? { height: '100vh' } : { aspectRatio: '16/9' }}
      >
        {/* ── Graph ── */}
        <div className="absolute inset-0">
          <GraphSection
            data={cleanData}
            stories={realStories}
            isDark={isDark}
            externalFocusGeneId={focusGeneId}
            externalFocusSeq={focusSeq}
            fullscreenContainerRef={mapContainerRef}
          />
        </div>

        {/* ── Left Panel (floating, collapsible) ── */}
        <aside
          className={`absolute top-14 left-3 z-30 w-80 max-h-[calc(100%-4.5rem)] flex flex-col
            rounded-2xl backdrop-blur-xl border shadow-2xl transition-all duration-500
            ${
              sidebarOpen
                ? 'translate-x-0 opacity-100 pointer-events-auto'
                : '-translate-x-[calc(100%+1rem)] opacity-0 pointer-events-none'
            }
            ${
              isDark
                ? 'bg-zinc-950/60 border-white/[0.08] shadow-black/40'
                : 'bg-white/60 border-white/40 shadow-black/10'
            }`}
          style={{ transitionTimingFunction: SPRING_EASING, scrollbarWidth: 'none' }}
        >
          {/* Tab bar */}
          <div
            className={`flex gap-1 px-3 pt-3 pb-2 shrink-0 border-b ${isDark ? 'border-white/[0.06]' : 'border-black/[0.06]'}`}
          >
            <button
              onClick={() => setSidebarTab('genes')}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-colors
                ${
                  sidebarTab === 'genes'
                    ? isDark
                      ? 'bg-white/[0.1] text-zinc-100'
                      : 'bg-black/[0.08] text-zinc-900'
                    : isDark
                      ? 'text-zinc-500 hover:text-zinc-300'
                      : 'text-zinc-400 hover:text-zinc-600'
                }`}
            >
              <Dna size={12} /> Top Genes
            </button>
            <button
              onClick={() => setSidebarTab('activity')}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-colors
                ${
                  sidebarTab === 'activity'
                    ? isDark
                      ? 'bg-white/[0.1] text-zinc-100'
                      : 'bg-black/[0.08] text-zinc-900'
                    : isDark
                      ? 'text-zinc-500 hover:text-zinc-300'
                      : 'text-zinc-400 hover:text-zinc-600'
                }`}
            >
              <Activity size={12} /> Activity
              {feed.length > 0 && (
                <span className="relative flex h-1.5 w-1.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500" />
                </span>
              )}
            </button>
          </div>

          {/* Scrollable content */}
          <div className="flex-1 overflow-y-auto px-3 py-2" style={{ scrollbarWidth: 'none' }}>
            {sidebarTab === 'genes' ? (
              <div className="space-y-1">
                {topGenes.map((g, i) => {
                  const total = g.totalExecutions;
                  const pct = total > 0 ? Math.round(g.successRate * 100) : 0;
                  const catColor =
                    g.category === 'repair'
                      ? 'bg-orange-500'
                      : g.category === 'innovate'
                        ? 'bg-violet-500'
                        : g.category === 'diagnostic'
                          ? 'bg-rose-500'
                          : 'bg-cyan-500';
                  return (
                    <div
                      key={g.id}
                      onClick={() => {
                        setFocusGeneId(g.id);
                        setFocusSeq((s) => s + 1);
                      }}
                      className={`flex items-center gap-2 px-2 py-1.5 rounded-xl transition-colors cursor-pointer ${
                        isDark ? 'hover:bg-white/[0.08]' : 'hover:bg-black/[0.06]'
                      }`}
                    >
                      <span
                        className={`text-[10px] font-bold tabular-nums w-4 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}
                      >
                        {i + 1}
                      </span>
                      <span className={`w-2 h-2 rounded shrink-0 ${catColor}`} />
                      <div className="flex-1 min-w-0">
                        <div className={`text-xs font-medium truncate ${isDark ? 'text-zinc-200' : 'text-zinc-700'}`}>
                          {g.title}
                        </div>
                        {total > 0 ? (
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <div
                              className={`flex-1 h-1 rounded-full overflow-hidden ${isDark ? 'bg-white/[0.06]' : 'bg-black/[0.06]'}`}
                            >
                              <div
                                className={`h-full rounded-full ${pct >= 70 ? 'bg-emerald-500' : pct >= 40 ? 'bg-amber-500' : 'bg-red-500'}`}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <span
                              className={`text-[9px] tabular-nums font-semibold ${pct >= 70 ? 'text-emerald-400' : pct >= 40 ? 'text-amber-400' : 'text-red-400'}`}
                            >
                              {pct}%
                            </span>
                          </div>
                        ) : (
                          <span className={`text-[9px] ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                            awaiting data
                          </span>
                        )}
                      </div>
                      <span
                        className={`text-[9px] tabular-nums shrink-0 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}
                      >
                        {total > 0 ? `${total}` : ''}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="space-y-0.5">
                {feed.length === 0 ? (
                  <div className={`text-center py-8 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                    <Activity size={20} className="mx-auto mb-2 opacity-40" />
                    <p className="text-xs">No activity yet</p>
                  </div>
                ) : (
                  feed.slice(0, 30).map((event, i) => {
                    const Icon = FEED_ICON_MAP[event.type] || CircleDot;
                    const cfg = FEED_ICONS[event.type] || FEED_ICONS.capsule;
                    const catHex = CAT_COLORS[event.geneCategory]?.hex || '#71717a';
                    const isFailure = event.type === 'capsule' && event.outcome === 'failure';
                    return (
                      <div
                        key={i}
                        onClick={() => zoomToGene(event)}
                        className={`flex items-start gap-2.5 px-2 py-2 rounded-xl cursor-pointer transition-colors ${
                          isDark ? 'hover:bg-white/[0.06]' : 'hover:bg-black/[0.04]'
                        }`}
                      >
                        <div
                          className="w-6 h-6 rounded-full flex items-center justify-center shrink-0 mt-0.5"
                          style={{ backgroundColor: (isFailure ? '#ef4444' : catHex) + '15' }}
                        >
                          {isFailure ? (
                            <XCircle size={11} className="text-red-400" />
                          ) : (
                            <Icon size={11} className={cfg.color} />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className={`text-xs leading-snug ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
                            <span className="font-medium" style={{ color: catHex }}>
                              {event.agentName}
                            </span>{' '}
                            <span className={isDark ? 'text-zinc-500' : 'text-zinc-400'}>
                              {event.type === 'capsule'
                                ? 'ran'
                                : event.type === 'publish'
                                  ? 'published'
                                  : event.type === 'distill'
                                    ? 'distilled'
                                    : 'achieved'}
                            </span>{' '}
                            <span className={`font-medium ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
                              {event.geneTitle}
                            </span>
                          </p>
                          <div className="flex items-center gap-2 mt-0.5">
                            {event.type === 'capsule' && (
                              <span
                                className={`text-[10px] font-semibold ${isFailure ? 'text-red-400' : 'text-emerald-400'}`}
                              >
                                {isFailure ? '✗ Failed' : '✓ Success'}
                                {event.score != null && ` ${Math.round(event.score * 100)}%`}
                              </span>
                            )}
                            <span className={`text-[10px] ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                              {timeAgo(event.timestamp)}
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>
        </aside>

        {/* Sidebar toggle */}
        <button
          onClick={() => setSidebarOpen((v) => !v)}
          className={`absolute z-40 w-7 h-7 rounded-full flex items-center justify-center
            backdrop-blur-xl border shadow-lg transition-all duration-500
            ${
              isDark
                ? 'bg-zinc-900/80 border-white/[0.1] text-zinc-400 hover:text-zinc-200'
                : 'bg-white/80 border-white/60 text-zinc-500 hover:text-zinc-700'
            }`}
          style={{
            top: '4rem',
            left: sidebarOpen ? '340px' : '12px',
            transitionTimingFunction: SPRING_EASING,
          }}
        >
          {sidebarOpen ? <ChevronLeft size={12} /> : <ChevronRight size={12} />}
        </button>
      </div>
    </div>
  );
}
