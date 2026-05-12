'use client';

/**
 * Graph Section — Canvas-based evolution network visualization
 *
 * Part of the Evolution Map snap-scroll layout (Section 3).
 * Wraps MapCanvas + zoom controls + search + detail panel + fullscreen.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { EvolutionMapData, DetailTarget, EvolutionStory } from '../types/evolution-map.types';
import { MapCanvas } from '../map-canvas';
import { MapDetailPanel } from '../map-detail-panel';
import { StoryBanner } from '../overlays/story-banner';
import { MeshGradient } from '@paper-design/shaders-react';
import { ZoomIn, ZoomOut, Maximize2, Minimize2, Search, X } from 'lucide-react';

interface Props {
  data: EvolutionMapData;
  stories?: EvolutionStory[];
  isDark: boolean;
  externalFocusGeneId?: string;
  externalFocusSeq?: number;
  fullscreenContainerRef?: React.RefObject<HTMLDivElement | null>;
}

const ZOOM_LEVEL_LABELS: Record<number, string> = {
  1: 'Focus',
  2: 'Cluster',
  3: 'Full Map',
};

const SPRING_EASING = 'cubic-bezier(0.175, 0.885, 0.32, 1.275)';

export function GraphSection({
  data,
  stories,
  isDark,
  externalFocusGeneId,
  externalFocusSeq,
  fullscreenContainerRef,
}: Props) {
  const [detailTarget, setDetailTarget] = useState<DetailTarget>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [zoomLevel, setZoomLevel] = useState<number>(1);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [skillResults, setSkillResults] = useState<Array<{ slug: string; name: string; category: string }>>([]);
  const [clusters, setClusters] = useState<Array<{ id: string; label: string; center: { x: number; y: number } }>>([]);
  const [currentClusterIdx, setCurrentClusterIdx] = useState(-1);
  const [clusterNavSeq, setClusterNavSeq] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const adjacentIdxRef = useRef(0);

  // Story banner: latest event from SSE or stories prop
  const [latestStory, setLatestStory] = useState<EvolutionStory | null>(null);

  // Zoom level control: parent -> canvas
  const [zoomCmd, setZoomCmd] = useState(0);
  const [zoomCmdLevel, setZoomCmdLevel] = useState(0);

  // Focus node command: search → zoom to specific node
  const [focusNodeCmd, setFocusNodeCmd] = useState<{ id: string; type: 'gene' | 'signal'; seq: number } | undefined>();

  // Init latest story from props
  useEffect(() => {
    if (stories && stories.length > 0 && !latestStory) {
      setLatestStory(stories[0]);
    }
  }, [stories, latestStory]);

  // ══ Fullscreen API ══
  useEffect(() => {
    function onFullscreenChange() {
      setIsFullscreen(!!document.fullscreenElement);
    }
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = fullscreenContainerRef?.current || containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      el.requestFullscreen().catch(() => {});
    }
  }, [fullscreenContainerRef]);

  const onSelect = useCallback((target: DetailTarget) => {
    setDetailTarget(target);
  }, []);

  const onZoomToLevel = useCallback((level: number) => {
    setZoomLevel(level);
    setZoomCmdLevel(level);
    setZoomCmd((c) => c + 1);
  }, []);

  const onZoomLevelChange = useCallback((level: number) => {
    setZoomLevel(level);
  }, []);

  const onClustersReady = useCallback((c: Array<{ id: string; label: string; center: { x: number; y: number } }>) => {
    setClusters(c);
  }, []);

  const _navigateCluster = useCallback(
    (direction: 1 | -1) => {
      if (clusters.length === 0) return;
      const next = (currentClusterIdx + direction + clusters.length) % clusters.length;
      setCurrentClusterIdx(next);
      setClusterNavSeq((s) => s + 1);
    },
    [clusters, currentClusterIdx],
  );

  // External focus (from sidebar Top 5 click)
  const prevExtSeq = useRef(externalFocusSeq);
  useEffect(() => {
    if (externalFocusGeneId && externalFocusSeq !== prevExtSeq.current) {
      prevExtSeq.current = externalFocusSeq;
      onZoomToLevel(1);
      setFocusNodeCmd({ id: externalFocusGeneId, type: 'gene', seq: Date.now() });
    }
  }, [externalFocusGeneId, externalFocusSeq, onZoomToLevel]);

  // Search: fly to a gene or signal node (detail panel opens on canvas click)
  const onSearchSelect = useCallback(
    (id: string, type: 'gene' | 'signal') => {
      onZoomToLevel(1);
      setFocusNodeCmd({ id, type, seq: Date.now() });
    },
    [onZoomToLevel],
  );

  // Story click: zoom to that gene
  const onStoryClick = useCallback(
    (geneId: string) => {
      onZoomToLevel(1);
      setFocusNodeCmd({ id: geneId, type: 'gene', seq: Date.now() });
    },
    [onZoomToLevel],
  );

  // Skill search (debounced)
  useEffect(() => {
    if (!searchQuery || searchQuery.length < 2) {
      setSkillResults([]);
      return;
    }
    const timer = setTimeout(() => {
      fetch(`/api/im/skills/search?query=${encodeURIComponent(searchQuery)}&limit=3`)
        .then((r) => r.json())
        .then((j) => {
          if (j.ok && Array.isArray(j.data))
            setSkillResults(
              j.data.map((s: { slug: string; name: string; category: string }) => ({
                slug: s.slug,
                name: s.name,
                category: s.category,
              })),
            );
        })
        .catch(() => setSkillResults([]));
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Cmd+K / Ctrl+K shortcut
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSearchOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 100);
      }
      if (e.key === 'Escape') {
        if (detailTarget) {
          setDetailTarget(null);
        } else if (zoomLevel < 3) {
          // D2→D1: Esc zooms back to full map
          onZoomToLevel(3);
        }
      }
      // +/- zoom in/out (lower level number = more zoomed in)
      if (!searchOpen) {
        if (e.key === '=' || e.key === '+') {
          e.preventDefault();
          onZoomToLevel(Math.max(1, zoomLevel - 1));
        }
        if (e.key === '-' || e.key === '_') {
          e.preventDefault();
          onZoomToLevel(Math.min(3, zoomLevel + 1));
        }
      }
      // ← → adjacent node navigation (only when a node is selected)
      // Fly to adjacent connected node — the canvas click handler will set detail target
      if (!searchOpen && detailTarget && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        const direction = e.key === 'ArrowRight' ? 1 : -1;

        // Collect adjacent node IDs from the selected node's connections
        let adjacentIds: { id: string; type: 'gene' | 'signal' }[] = [];

        if (detailTarget.type === 'gene' && detailTarget.connectedSignals) {
          adjacentIds = detailTarget.connectedSignals.map((s) => ({ id: s.key, type: 'signal' as const }));
        } else if (detailTarget.type === 'signal' && detailTarget.connectedGenes) {
          adjacentIds = detailTarget.connectedGenes.map((g) => ({ id: g.id, type: 'gene' as const }));
        }

        if (adjacentIds.length > 0) {
          const currentIdx = adjacentIdxRef.current;
          const nextIdx = (((currentIdx + direction) % adjacentIds.length) + adjacentIds.length) % adjacentIds.length;
          adjacentIdxRef.current = nextIdx;
          const target = adjacentIds[nextIdx];
          // Fly to node at L1 + select on arrival (focusNodeCmd triggers onSelect)
          setFocusNodeCmd({ id: target.id, type: target.type, seq: Date.now() });
        }
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [searchOpen, detailTarget, data, onSearchSelect, onZoomToLevel, zoomLevel]);

  const panelOpen = detailTarget !== null;

  // Reset adjacent index when selection changes
  useEffect(() => {
    adjacentIdxRef.current = 0;
  }, [detailTarget]);

  return (
    <div
      ref={containerRef}
      className={`relative w-full h-full overflow-hidden ${
        isFullscreen ? 'bg-zinc-950' : 'rounded-2xl border shadow-2xl'
      } ${isDark ? 'border-white/[0.06] shadow-black/40' : 'border-black/[0.06] shadow-black/10'}`}
      style={isFullscreen ? { height: '100vh' } : undefined}
    >
      {/* ══ MeshGradient Background ══ */}
      <div className="absolute inset-0 z-0">
        <MeshGradient
          colors={isDark ? ['#0a0a0a', '#41086D', '#123391', '#1a1a2e'] : ['#FFFFFF', '#E7D3F9', '#F4FAFE', '#F3E9FF']}
          speed={0.15}
          style={{ width: '100%', height: '100%' }}
        />
        {/* Overlay to soften gradient */}
        <div className={`absolute inset-0 ${isDark ? 'bg-zinc-950/60' : 'bg-white/40'}`} />
        {/* Ambient orbs */}
        <div
          className="absolute top-1/4 left-1/3 w-64 h-64 rounded-full opacity-20 animate-pulse"
          style={{
            background: isDark
              ? 'radial-gradient(circle, rgba(139,92,246,0.3) 0%, transparent 70%)'
              : 'radial-gradient(circle, rgba(139,92,246,0.15) 0%, transparent 70%)',
            filter: 'blur(120px)',
          }}
        />
        <div
          className="absolute bottom-1/3 right-1/4 w-52 h-52 rounded-full opacity-20 animate-pulse"
          style={{
            background: isDark
              ? 'radial-gradient(circle, rgba(59,130,246,0.3) 0%, transparent 70%)'
              : 'radial-gradient(circle, rgba(59,130,246,0.15) 0%, transparent 70%)',
            filter: 'blur(120px)',
            animationDelay: '2s',
          }}
        />
      </div>

      {/* ══ Canvas area ══ */}
      <div className="absolute inset-0 z-10">
        {/* Story Banner — PRD §5.4 */}
        <StoryBanner story={latestStory} isDark={isDark} onStoryClick={onStoryClick} />

        <MapCanvas
          data={data}
          stories={stories}
          isDark={isDark}
          panelOpen={panelOpen}
          onSelect={onSelect}
          onZoomLevelChange={onZoomLevelChange}
          onClustersReady={onClustersReady}
          zoomToLevelCmd={zoomCmd > 0 ? zoomCmdLevel : undefined}
          focusClusterCmd={
            currentClusterIdx >= 0 && clusters[currentClusterIdx]
              ? { id: clusters[currentClusterIdx].id, seq: clusterNavSeq }
              : undefined
          }
          focusNodeCmd={focusNodeCmd}
          onNewEvent={(evt) => {
            // Update story banner from SSE events
            setLatestStory({
              id: `sse-${Date.now()}`,
              timestamp: new Date().toISOString(),
              agent: { id: '', name: evt.agentName },
              task: { description: '' },
              signal: { key: evt.signalKey, category: evt.signalKey.split(':')[0] || 'unknown', label: evt.signalKey },
              gene: { id: evt.geneId, name: evt.geneId, category: '', strategyPreview: '' },
              outcome: evt.outcome as 'success' | 'failed',
              effect: {
                actionDescription: '',
                resultSummary: '',
                geneSuccessRateBefore: 0,
                geneSuccessRateAfter: 0,
                successRateDelta: 0,
                isExplorationEvent: false,
              },
            });
          }}
        />

        {/* Cold-start: no overlay — the graph with seed genes IS the content.
            Stats sidebar already shows KPIs; search button guides interaction. */}
      </div>

      {/* ══ Search Command Palette (⌘K) ══ */}
      <div
        className={`absolute inset-0 z-30 flex items-start justify-center pt-4 transition-all duration-500
          ${searchOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}
        style={{ transitionTimingFunction: SPRING_EASING }}
        onClick={(e) => {
          if (e.target === e.currentTarget) {
            setSearchOpen(false);
            setSearchQuery('');
          }
        }}
      >
        {/* Backdrop */}
        <div
          className={`absolute inset-0 transition-opacity duration-500 ${
            searchOpen ? (isDark ? 'bg-black/50' : 'bg-black/20') + ' backdrop-blur-sm' : 'bg-transparent'
          }`}
        />

        {/* Palette — expands from trigger button shape */}
        <div
          className={`relative rounded-2xl border shadow-2xl overflow-hidden
            transition-all duration-500
            ${isDark ? 'bg-zinc-900 border-white/[0.1]' : 'bg-white border-zinc-200'}
            ${searchOpen ? 'w-[480px] max-w-[90vw] scale-100 translate-y-0' : 'w-[160px] scale-95 -translate-y-1'}`}
          style={{ transitionTimingFunction: SPRING_EASING }}
        >
          {/* Input */}
          <div
            className={`flex items-center gap-3 px-4 py-3 border-b ${isDark ? 'border-white/[0.06]' : 'border-zinc-200'}`}
          >
            <Search size={18} className={isDark ? 'text-zinc-500' : 'text-zinc-400'} />
            <input
              ref={searchInputRef}
              type="text"
              placeholder="Search genes, signals, skills..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className={`flex-1 bg-transparent outline-none text-sm ${
                isDark ? 'text-zinc-100 placeholder:text-zinc-500' : 'text-zinc-900 placeholder:text-zinc-400'
              }`}
              autoFocus
            />
            <button
              onClick={() => {
                setSearchOpen(false);
                setSearchQuery('');
              }}
              className={`p-1 rounded-md transition-colors ${
                isDark
                  ? 'hover:bg-white/10 text-zinc-500 hover:text-zinc-300'
                  : 'hover:bg-zinc-100 text-zinc-400 hover:text-zinc-600'
              }`}
            >
              <X size={16} />
            </button>
          </div>

          {/* Results */}
          <div className="max-h-[50vh] overflow-y-auto">
            {searchQuery.length === 0 ? (
              <div className={`px-4 py-8 text-center text-sm ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                Type to search {data.genes.length} genes and {data.signals.length} signals
              </div>
            ) : (
              <>
                {/* Gene results — word-split matching + relevance scoring */}
                {(() => {
                  const words = searchQuery.toLowerCase().split(/\s+/).filter(Boolean);
                  const geneResults = data.genes
                    .filter((g) => {
                      const t = g.title.toLowerCase();
                      const cat = g.category.toLowerCase();
                      return words.every((w) => t.includes(w) || cat.includes(w) || g.id.toLowerCase().includes(w));
                    })
                    .map((g) => {
                      let score = 0;
                      const t = g.title.toLowerCase();
                      for (const w of words) {
                        if (t.includes(w)) score += 10;
                        if (t === w) score += 20;
                        if (g.category.toLowerCase() === w) score += 5;
                      }
                      score += Math.log10(Math.max(g.totalExecutions, 1)) * 0.5;
                      return { gene: g, score };
                    })
                    .sort((a, b) => b.score - a.score)
                    .slice(0, 8)
                    .map((r) => r.gene);
                  if (geneResults.length === 0) return null;
                  return (
                    <div className="py-2">
                      <div
                        className={`px-4 py-1.5 text-[10px] font-medium uppercase tracking-wider ${
                          isDark ? 'text-zinc-600' : 'text-zinc-400'
                        }`}
                      >
                        Genes
                      </div>
                      {geneResults.map((g) => (
                        <button
                          key={g.id}
                          onClick={() => {
                            onSearchSelect(g.id, 'gene');
                            setSearchOpen(false);
                            setSearchQuery('');
                          }}
                          className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                            isDark ? 'hover:bg-white/[0.06]' : 'hover:bg-zinc-50'
                          }`}
                        >
                          <span
                            className={`w-2.5 h-2.5 rounded-sm shrink-0 ${
                              g.category === 'repair'
                                ? 'bg-orange-500'
                                : g.category === 'innovate'
                                  ? 'bg-violet-500'
                                  : g.category === 'diagnostic'
                                    ? 'bg-rose-500'
                                    : 'bg-cyan-500'
                            }`}
                          />
                          <span className={`flex-1 text-sm truncate ${isDark ? 'text-zinc-200' : 'text-zinc-700'}`}>
                            {g.title}
                          </span>
                          <span className={`text-xs tabular-nums ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                            {g.totalExecutions > 0 ? `${Math.round(g.successRate * 100)}%` : 'new'}
                          </span>
                          <span className={`text-[10px] ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                            {g.category}
                          </span>
                        </button>
                      ))}
                    </div>
                  );
                })()}

                {/* Signal results — word-split matching + relevance */}
                {(() => {
                  const words = searchQuery.toLowerCase().split(/\s+/).filter(Boolean);
                  const signalResults = data.signals
                    .filter((s) => {
                      const k = s.key.toLowerCase();
                      return words.every((w) => k.includes(w) || s.category.toLowerCase().includes(w));
                    })
                    .sort((a, b) => b.frequency - a.frequency)
                    .slice(0, 5);
                  if (signalResults.length === 0) return null;
                  return (
                    <div className="py-2">
                      <div
                        className={`px-4 py-1.5 text-[10px] font-medium uppercase tracking-wider ${
                          isDark ? 'text-zinc-600' : 'text-zinc-400'
                        }`}
                      >
                        Signals
                      </div>
                      {signalResults.map((s) => (
                        <button
                          key={s.key}
                          onClick={() => {
                            onSearchSelect(s.key, 'signal');
                            setSearchOpen(false);
                            setSearchQuery('');
                          }}
                          className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                            isDark ? 'hover:bg-white/[0.06]' : 'hover:bg-zinc-50'
                          }`}
                        >
                          <span
                            className={`w-2.5 h-2.5 rounded-full shrink-0 ${isDark ? 'bg-zinc-600' : 'bg-zinc-400'}`}
                          />
                          <span
                            className={`flex-1 text-sm font-mono truncate ${isDark ? 'text-zinc-300' : 'text-zinc-600'}`}
                          >
                            {s.key}
                          </span>
                          <span className={`text-xs tabular-nums ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                            {s.frequency} hits
                          </span>
                        </button>
                      ))}
                    </div>
                  );
                })()}

                {/* Skill results (API search) — navigate to library tab, NOT canvas fly-to */}
                {skillResults.length > 0 && (
                  <div className="py-2">
                    <div
                      className={`px-4 py-1.5 text-[10px] font-medium uppercase tracking-wider ${
                        isDark ? 'text-zinc-600' : 'text-zinc-400'
                      }`}
                    >
                      Skills
                    </div>
                    {skillResults.map((sk) => (
                      <a
                        key={sk.slug}
                        href={`/evolution?tab=library&skill=${encodeURIComponent(sk.slug)}`}
                        onClick={() => {
                          setSearchOpen(false);
                          setSearchQuery('');
                        }}
                        className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                          isDark ? 'hover:bg-white/[0.06]' : 'hover:bg-zinc-50'
                        }`}
                      >
                        <span className="w-2.5 h-2.5 rounded-sm shrink-0 bg-emerald-500" />
                        <span className={`flex-1 text-sm truncate ${isDark ? 'text-zinc-200' : 'text-zinc-700'}`}>
                          {sk.name}
                        </span>
                        <span className={`text-[10px] ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                          {sk.category}
                        </span>
                      </a>
                    ))}
                  </div>
                )}

                {/* No results */}
                {data.genes.filter((g) => g.title.toLowerCase().includes(searchQuery.toLowerCase())).length === 0 &&
                  data.signals.filter((s) => s.key.toLowerCase().includes(searchQuery.toLowerCase())).length === 0 &&
                  skillResults.length === 0 && (
                    <div className={`px-4 py-8 text-center text-sm ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                      No results for &ldquo;{searchQuery}&rdquo;
                    </div>
                  )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* ⌘K trigger button */}
      <button
        onClick={() => {
          setSearchOpen(true);
          setTimeout(() => searchInputRef.current?.focus(), 50);
        }}
        className={`absolute top-4 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 px-4 py-2 rounded-2xl backdrop-blur-xl border shadow-lg
          transition-all duration-500
          ${searchOpen ? 'opacity-0 scale-90 pointer-events-none' : 'opacity-100 scale-100 pointer-events-auto'}
          ${
            isDark
              ? 'bg-white/[0.06] border-white/[0.08] text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.1]'
              : 'bg-black/[0.04] border-black/[0.08] text-zinc-500 hover:text-zinc-700 hover:bg-black/[0.06]'
          }`}
        style={{ transitionTimingFunction: SPRING_EASING }}
      >
        <Search size={14} />
        <span className="text-xs">Search</span>
        <kbd
          className={`ml-1 px-1.5 py-0.5 rounded text-[10px] font-mono ${
            isDark ? 'bg-zinc-800 text-zinc-500' : 'bg-zinc-200 text-zinc-400'
          }`}
        >
          ⌘K
        </kbd>
      </button>

      {/* ══ Left-Side Zoom Control Bar ══ */}
      <div
        className={`absolute bottom-4 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1 p-1.5 rounded-2xl backdrop-blur-xl border ${
          isDark ? 'bg-white/[0.06] border-white/[0.08]' : 'bg-black/[0.04] border-black/[0.08]'
        }`}
      >
        <button
          onClick={() => onZoomToLevel(Math.max(1, zoomLevel - 1))}
          className={`w-8 h-8 flex items-center justify-center rounded-xl transition-all duration-300 ${
            isDark
              ? 'text-zinc-400 hover:text-white hover:bg-white/[0.08]'
              : 'text-zinc-500 hover:text-zinc-900 hover:bg-black/[0.06]'
          }`}
          title="Zoom In"
        >
          <ZoomIn size={15} />
        </button>

        {([1, 2, 3] as const).map((level) => (
          <button
            key={level}
            onClick={() => onZoomToLevel(level)}
            className="w-8 h-8 flex items-center justify-center group relative"
            title={ZOOM_LEVEL_LABELS[level]}
          >
            <span
              className="block w-2 h-2 rounded-full transition-all duration-500"
              style={{
                transitionTimingFunction: SPRING_EASING,
                ...(zoomLevel === level
                  ? { backgroundColor: '#8b5cf6', transform: 'scale(1.3)', boxShadow: '0 0 8px rgba(139,92,246,0.5)' }
                  : { backgroundColor: 'transparent', border: `1.5px solid ${isDark ? '#52525b' : '#a1a1aa'}` }),
              }}
            />
            <span
              className={`absolute bottom-full mb-2 px-2 py-1 rounded-lg text-[10px] whitespace-nowrap
                opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-200 ${
                  isDark
                    ? 'bg-zinc-800 text-zinc-300 border border-white/[0.08]'
                    : 'bg-white text-zinc-600 border border-black/[0.08] shadow-sm'
                }`}
            >
              {ZOOM_LEVEL_LABELS[level]}
            </span>
          </button>
        ))}

        <button
          onClick={() => onZoomToLevel(Math.min(3, zoomLevel + 1))}
          className={`w-8 h-8 flex items-center justify-center rounded-xl transition-all duration-300 ${
            isDark
              ? 'text-zinc-400 hover:text-white hover:bg-white/[0.08]'
              : 'text-zinc-500 hover:text-zinc-900 hover:bg-black/[0.06]'
          }`}
          title="Zoom Out"
        >
          <ZoomOut size={15} />
        </button>
      </div>

      {/* ══ Fullscreen Button (bottom-right) ══ */}
      <button
        onClick={toggleFullscreen}
        className={`absolute bottom-4 right-4 z-20 p-2 rounded-xl backdrop-blur-xl border transition-all duration-500 ${
          isDark
            ? 'bg-white/[0.06] border-white/[0.08] text-zinc-400 hover:text-white hover:bg-white/[0.1]'
            : 'bg-black/[0.04] border-black/[0.08] text-zinc-500 hover:text-zinc-900 hover:bg-black/[0.08]'
        }`}
        style={{ transitionTimingFunction: SPRING_EASING }}
        title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
      >
        {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
      </button>

      {/* ══ Detail Panel — floating glassmorphic drawer ══ */}
      <div
        className={`absolute top-14 right-3 w-[340px] max-h-[calc(100%-4.5rem)] z-20 rounded-2xl overflow-hidden
          transition-all duration-500 shadow-2xl
          ${isDark ? 'shadow-black/40' : 'shadow-black/10'}
          ${
            panelOpen
              ? 'opacity-100 translate-x-0 scale-100'
              : 'opacity-0 translate-x-8 scale-[0.97] pointer-events-none'
          }`}
        style={{ transitionTimingFunction: SPRING_EASING }}
      >
        <MapDetailPanel target={detailTarget} onClose={() => setDetailTarget(null)} isDark={isDark} />
      </div>
    </div>
  );
}
