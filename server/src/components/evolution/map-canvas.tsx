'use client';

/**
 * Evolution Map — Canvas Component (Phase 2+3+4)
 *
 * Full-featured bipartite graph renderer:
 * - 60fps RAF animation loop with particle trails
 * - Smooth hover opacity transitions (200ms lerp)
 * - Breathing pulse for cold-start nodes
 * - SSE real-time event integration (ripples + highlight particles + gene flash)
 * - Touch gesture support (pinch zoom, pan, tap, double-tap)
 * - Background dot grid
 * - Performance: offscreen static layer cache, requestIdleCallback layout
 * - 3-level semantic zoom (L1–L3) with ghost/dim rendering
 * - Story embedding at L1
 * - Cluster halos (L4) and labels (L3+)
 */

import { useRef, useEffect, useCallback } from 'react';
import type {
  EvolutionMapData,
  MapLayout,
  Particle,
  Ripple,
  HoverState,
  MapViewState,
  DetailTarget,
  MapEvent,
  EvolutionStory,
  CommunityInfo,
} from './types/evolution-map.types';
import { categoryToShape } from './types/evolution-map.types';
import { computeLayout, getPointOnBezier } from './canvas/layout';
import {
  drawEdge,
  drawSignalNode,
  drawGeneNode,
  drawParticle,
  drawRipple,
  drawGhostNode,
  drawClusterHalo,
  drawClusterLabel,
  resetLabelCollisions,
  drawHyperedge,
  drawCausalLink,
  drawGeneStoryEmbed,
  drawBackgroundGrid,
} from './canvas/renderer';
import {
  getZoomLevel,
  getNodeRenderMode,
  computeEntryViewport,
  autoFit,
  screenToCanvas,
} from './canvas/interaction/viewport';
import { handleWheel, getZoomForLevel } from './canvas/interaction/zoom-pan';
import { hitTest, computeHoverState } from './canvas/interaction/hit-test';

interface Props {
  data: EvolutionMapData;
  stories?: EvolutionStory[];
  isDark: boolean;
  panelOpen: boolean;
  onSelect: (target: DetailTarget) => void;
  onZoomLevelChange?: (level: number) => void;
  onClustersReady?: (clusters: Array<{ id: string; label: string; center: { x: number; y: number } }>) => void;
  zoomToLevelCmd?: number;
  focusClusterCmd?: { id: string; seq: number }; // seq changes → fly to cluster center
  focusNodeCmd?: { id: string; type: 'gene' | 'signal'; seq: number }; // search → fly to node
  onNewEvent?: (event: { signalKey: string; geneId: string; outcome: string; agentName: string }) => void;
}

const MAX_PARTICLES = 80;
const MAX_RIPPLES = 8;
const TRAIL_LENGTH = 3;
const OPACITY_LERP_SPEED = 0.12; // per frame, ~200ms to 95%

export function MapCanvas({
  data,
  stories,
  isDark,
  panelOpen,
  onSelect,
  onZoomLevelChange,
  onClustersReady,
  zoomToLevelCmd,
  focusClusterCmd,
  focusNodeCmd,
  onNewEvent,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);

  // Mutable state refs
  const layoutRef = useRef<MapLayout | null>(null);
  const viewRef = useRef<MapViewState>({ zoom: 1, panX: 0, panY: 0, zoomLevel: 1 });
  const hoverRef = useRef<HoverState>({
    active: false,
    hit: null,
    connectedSignals: new Set(),
    connectedGenes: new Set(),
    connectedEdges: new Set(),
  });
  const particlesRef = useRef<Particle[]>([]);
  const ripplesRef = useRef<Ripple[]>([]);
  const isPanningRef = useRef(false);
  // D1→D2 transition: active cluster dims all other nodes
  const activeClusterRef = useRef<string | null>(null);
  const lastMouseRef = useRef({ x: 0, y: 0 });
  // Mouse glow — lerped canvas coordinates
  const mouseGlowRef = useRef({ x: 0, y: 0, targetX: 0, targetY: 0, active: false });
  const dataRef = useRef(data);
  const isDarkRef = useRef(isDark);
  const storiesRef = useRef(stories);
  const needsInitRef = useRef(true);
  const startTimeRef = useRef(performance.now());
  const originalPosRef = useRef<Map<string, { x: number; y: number }> | null>(null);

  // Smooth opacity maps: key → current opacity (0..1)
  const signalOpacityRef = useRef(new Map<string, number>());
  const geneOpacityRef = useRef(new Map<string, number>());
  const edgeOpacityRef = useRef(new Map<string, number>());

  // Gene flash state: geneId → { color, opacity }
  const geneFlashRef = useRef(new Map<string, { color: string; opacity: number }>());

  // Touch state
  const touchStateRef = useRef<{
    lastPinchDist: number;
    lastTouchCenter: { x: number; y: number };
    isTouching: boolean;
    touchCount: number;
    lastTapTime: number;
    lastTapPos: { x: number; y: number };
  }>({
    lastPinchDist: 0,
    lastTouchCenter: { x: 0, y: 0 },
    isTouching: false,
    touchCount: 0,
    lastTapTime: 0,
    lastTapPos: { x: 0, y: 0 },
  });

  dataRef.current = data;
  isDarkRef.current = isDark;
  storiesRef.current = stories;

  // ═══ Parent-driven zoom level change ═══
  const prevZoomCmd = useRef(zoomToLevelCmd);
  useEffect(() => {
    if (zoomToLevelCmd && zoomToLevelCmd !== prevZoomCmd.current) {
      prevZoomCmd.current = zoomToLevelCmd;
      const layout = layoutRef.current;
      const canvas = canvasRef.current;
      if (!layout || !canvas) return;
      const rect = canvas.getBoundingClientRect();
      const level = Math.max(1, Math.min(3, zoomToLevelCmd)) as 1 | 2 | 3;
      const totalSpan = layoutRef.current?.totalSpan ?? rect.width;
      const newZoom = getZoomForLevel(level, rect.width, totalSpan);
      // Keep current view center
      const view = viewRef.current;
      const centerX = (rect.width / 2 - view.panX) / view.zoom;
      const centerY = (rect.height / 2 - view.panY) / view.zoom;
      viewRef.current = {
        zoom: newZoom,
        panX: rect.width / 2 - centerX * newZoom,
        panY: rect.height / 2 - centerY * newZoom,
        zoomLevel: level,
      };
      // Clear active cluster when zooming out to full map
      if (level >= 3) activeClusterRef.current = null;
      onZoomLevelChange?.(level);
    }
  }, [zoomToLevelCmd, onZoomLevelChange]);

  // ═══ Parent-driven cluster focus (D2 navigation) ═══
  const prevClusterCmd = useRef(focusClusterCmd?.seq);
  useEffect(() => {
    if (!focusClusterCmd || focusClusterCmd.seq === prevClusterCmd.current) return;
    prevClusterCmd.current = focusClusterCmd.seq;
    const layout = layoutRef.current;
    const canvas = canvasRef.current;
    if (!layout?.clusters || !canvas) return;

    const cluster = layout.clusters.find((c) => String(c.communityId) === focusClusterCmd.id);
    if (!cluster) return;

    const rect = canvas.getBoundingClientRect();
    // Fly to cluster center at D2 zoom level
    const totalSpan = layout.totalSpan ?? rect.width;
    const d2Zoom = getZoomForLevel(2, rect.width, totalSpan);
    const targetView = {
      zoom: d2Zoom,
      panX: rect.width / 2 - cluster.center.x * d2Zoom,
      panY: rect.height / 2 - cluster.center.y * d2Zoom,
      zoomLevel: 2 as const,
    };
    // Animate (400ms ease-out)
    const from = { ...viewRef.current };
    const start = performance.now();
    function tick() {
      const t = Math.min(1, (performance.now() - start) / 400);
      const ease = 1 - Math.pow(1 - t, 3);
      viewRef.current = {
        zoom: from.zoom + (targetView.zoom - from.zoom) * ease,
        panX: from.panX + (targetView.panX - from.panX) * ease,
        panY: from.panY + (targetView.panY - from.panY) * ease,
        zoomLevel: t > 0.5 ? 2 : viewRef.current.zoomLevel,
      };
      if (t < 1) requestAnimationFrame(tick);
      else onZoomLevelChange?.(2);
    }
    requestAnimationFrame(tick);
  }, [focusClusterCmd, onZoomLevelChange]);

  // ═══ Parent-driven node focus (search → zoom to gene/signal) ═══
  const prevNodeCmd = useRef(focusNodeCmd?.seq);
  useEffect(() => {
    if (!focusNodeCmd || focusNodeCmd.seq === prevNodeCmd.current) return;
    prevNodeCmd.current = focusNodeCmd.seq;
    const layout = layoutRef.current;
    const canvas = canvasRef.current;
    if (!layout || !canvas) return;

    // Find target node and its position
    let targetX: number | undefined, targetY: number | undefined;
    let selectPayload: Parameters<typeof onSelect>[0] = null;

    if (focusNodeCmd.type === 'gene') {
      const node = layout.geneNodes.find((n) => n.id === focusNodeCmd.id);
      if (node) {
        targetX = node.x;
        targetY = node.y;
        // Build selection payload (same as click handler)
        const connectedEdges = layout.edges.filter((e) => e.geneId === node.id);
        const connectedSigKeys = new Set(connectedEdges.map((e) => e.signalKey));
        const connectedSignals = layout.signalNodes.filter((s) => connectedSigKeys.has(s.key));
        selectPayload = { type: 'gene', data: node, connectedSignals, connectedEdges };
      }
    } else {
      const node = layout.signalNodes.find((n) => n.key === focusNodeCmd.id);
      if (node) {
        targetX = node.x;
        targetY = node.y;
        const connectedEdges = layout.edges.filter((e) => e.signalKey === node.key);
        const connectedGeneIds = new Set(connectedEdges.map((e) => e.geneId));
        const connectedGenes = layout.geneNodes.filter((g) => connectedGeneIds.has(g.id));
        selectPayload = { type: 'signal', data: node, connectedGenes, connectedEdges };
      }
    }
    if (targetX === undefined || targetY === undefined) return;

    const rect = canvas.getBoundingClientRect();
    const totalSpan = layout.totalSpan ?? rect.width;
    const l1Zoom = getZoomForLevel(1, rect.width, totalSpan);
    const targetView = {
      zoom: l1Zoom,
      panX: rect.width / 2 - targetX * l1Zoom,
      panY: rect.height / 2 - targetY * l1Zoom,
    };
    const from = { ...viewRef.current };
    const start = performance.now();
    const duration = 500;
    const doSelect = selectPayload;
    function tick() {
      const t = Math.min(1, (performance.now() - start) / duration);
      const ease = 1 - Math.pow(1 - t, 3);
      viewRef.current = {
        zoom: from.zoom + (targetView.zoom - from.zoom) * ease,
        panX: from.panX + (targetView.panX - from.panX) * ease,
        panY: from.panY + (targetView.panY - from.panY) * ease,
        zoomLevel: t > 0.5 ? 1 : viewRef.current.zoomLevel,
      };
      if (t < 1) {
        requestAnimationFrame(tick);
      } else {
        onZoomLevelChange?.(1);
        if (doSelect) {
          onSelect(doSelect);
          // Also set hover state so canvas highlights the node + 2-hop neighbors
          const fakeHit =
            doSelect.type === 'gene'
              ? { type: 'gene' as const, geneId: doSelect.data.id }
              : { type: 'signal' as const, signalKey: (doSelect.data as { key: string }).key };
          if (layoutRef.current) {
            hoverRef.current = computeHoverState(fakeHit, layoutRef.current);
          }
        }
      }
    }
    requestAnimationFrame(tick);
  }, [focusNodeCmd, onZoomLevelChange, onSelect]);

  // ═══ Compute layout (requestIdleCallback if available) ═══
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    function doLayout() {
      const rect = canvas!.getBoundingClientRect();
      const layoutWidth = rect.width / (panelOpen ? 0.7 : 1);
      const layout = computeLayout(data, { width: layoutWidth, height: rect.height });
      layoutRef.current = layout;
      originalPosRef.current = null; // will be re-captured on next frame

      // Notify parent about available clusters (for D2 navigation)
      if (layout.clusters && onClustersReady) {
        onClustersReady(
          layout.clusters.map((c) => ({
            id: String(c.communityId),
            label: c.label,
            center: c.center,
          })),
        );
      }

      if (needsInitRef.current) {
        // Determine entry anchor: most recent event's gene, or null
        const anchorGeneId = data.recentEvents?.[0]?.geneId ?? null;
        viewRef.current = computeEntryViewport(layout, anchorGeneId, rect.width, rect.height);
        needsInitRef.current = false;
      }

      initParticles(layout);
    }

    // Use requestIdleCallback if available for non-blocking layout
    if ('requestIdleCallback' in window) {
      const id = (window as any).requestIdleCallback(doLayout, { timeout: 100 });
      return () => (window as any).cancelIdleCallback(id);
    } else {
      doLayout();
    }
  }, [data, panelOpen]);

  // ═══ Initialize particles from edges ═══
  function initParticles(layout: MapLayout) {
    const particles: Particle[] = [];
    for (let i = 0; i < layout.edges.length; i++) {
      const edge = layout.edges[i];
      const count = Math.min(Math.ceil(edge.totalObs / 50), 3);
      // Exploring edges: 0 or 1 slow dim particle
      // Established edges: 1-3 particles based on traffic
      const isExploring = edge.isExploring;
      const n = isExploring ? (edge.totalObs > 0 ? 1 : 0) : Math.max(1, count);
      for (let j = 0; j < n; j++) {
        particles.push({
          edgeIdx: i,
          progress: Math.random(),
          speed: isExploring
            ? 0.001 + Math.random() * 0.001 // slow for exploring
            : 0.002 + Math.random() * 0.003 * edge.confidence, // faster for confident
          color: edge.color,
          radius: isExploring ? 1.5 : 2,
          opacity: isExploring ? 0.4 : 0.8,
          isHighlight: false,
          trail: [],
        });
      }
      if (particles.length >= MAX_PARTICLES) break;
    }
    particlesRef.current = particles;
  }

  // ═══ Add ripple + highlight particle + gene flash from SSE event ═══
  const addEventEffects = useCallback((event: MapEvent) => {
    const layout = layoutRef.current;
    if (!layout) return;

    // 1. Ripple on signal node
    const sn = layout.signalNodes.find((n) => n.key === event.signalKey);
    if (sn) {
      const ripples = ripplesRef.current;
      if (ripples.length >= MAX_RIPPLES) ripples.shift();
      ripples.push({
        x: sn.x + sn.width / 2,
        y: sn.y + sn.height / 2,
        radius: 0,
        maxRadius: 35,
        opacity: 0.9,
        color: event.outcome === 'success' ? '#22c55e' : '#ef4444',
      });
    }

    // 2. Highlight particle on edge
    const edgeIdx = layout.edges.findIndex((e) => e.signalKey === event.signalKey && e.geneId === event.geneId);
    if (edgeIdx >= 0) {
      const particles = particlesRef.current;
      if (particles.length < MAX_PARTICLES) {
        particles.push({
          edgeIdx,
          progress: 0,
          speed: 0.008,
          color: event.outcome === 'success' ? '#22c55e' : '#ef4444',
          radius: 3.5,
          opacity: 1,
          isHighlight: true,
          trail: [],
        });
      }
    }

    // 3. Gene flash
    geneFlashRef.current.set(event.geneId, {
      color: event.outcome === 'success' ? '#22c55e' : '#ef4444',
      opacity: 0.8,
    });
  }, []);

  // ═══ SSE Event Stream ═══
  useEffect(() => {
    // Connect to SSE stream for real-time evolution events
    let es: EventSource | null = null;

    try {
      es = new EventSource('/api/im/sync/stream');
      es.addEventListener('sync', (e: MessageEvent) => {
        try {
          const event = JSON.parse(e.data);
          if (event.type === 'evolution:capsule' && event.data) {
            const evt = {
              signalKey: event.data.signalKey || event.data.signal_key || '',
              geneId: event.data.geneId || event.data.gene_id || '',
              outcome: event.data.outcome === 'success' ? 'success' : 'failed',
              agentName: event.data.agentName || 'Agent',
            };
            onNewEvent?.(evt);
            addEventEffects({
              signalKey: evt.signalKey,
              geneId: evt.geneId,
              outcome: evt.outcome as 'success' | 'failed',
              agentName: evt.agentName,
              timestamp: new Date().toISOString(),
            });
          }
        } catch {
          /* ignore parse errors */
        }
      });
      es.onerror = () => {
        // SSE failed (likely no auth or server not available) — silent fallback
        es?.close();
        es = null;
      };
    } catch {
      // EventSource not available or blocked
    }

    return () => {
      es?.close();
    };
  }, [addEventEffects]);

  // ═══ Canvas resize ═══
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas!.getBoundingClientRect();
      canvas!.width = rect.width * dpr;
      canvas!.height = rect.height * dpr;
      const ctx = canvas!.getContext('2d');
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  // ═══ Native wheel handler (passive:false to allow preventDefault) ═══
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    function onWheel(e: WheelEvent) {
      const rect = canvas!.getBoundingClientRect();
      const totalSpan = layoutRef.current?.totalSpan ?? rect.width;
      const prev = viewRef.current.zoomLevel;
      viewRef.current = handleWheel(e, viewRef.current, rect, totalSpan);
      if (viewRef.current.zoomLevel !== prev) {
        if (viewRef.current.zoomLevel >= 3) {
          activeClusterRef.current = null;
        }
        onZoomLevelChange?.(viewRef.current.zoomLevel);
      }
    }

    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [onZoomLevelChange]);

  // ═══ Animation loop ═══
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const stableCtx = ctx;
    // Accessibility: respect reduced motion preference
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function render() {
      const layout = layoutRef.current;
      if (!layout) {
        rafRef.current = requestAnimationFrame(render);
        return;
      }

      const view = viewRef.current;
      const hover = hoverRef.current;
      const particles = particlesRef.current;
      const ripples = ripplesRef.current;
      const dark = isDarkRef.current;
      const currentStories = storiesRef.current;
      const rect = canvas!.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      const time = (performance.now() - startTimeRef.current) / 1000;
      const zoomLevel = view.zoomLevel;

      // Compute viewport center in canvas space for render mode
      const viewCenterX = (w / 2 - view.panX) / view.zoom;
      const viewCenterY = (h / 2 - view.panY) / view.zoom;
      const visibleRadius = w / (2 * view.zoom);

      stableCtx.clearRect(0, 0, w, h);
      // Background dot grid — subtle spatial reference (PRD §9.2)
      drawBackgroundGrid(stableCtx, view, w, h, dark);
      // Transparent background — MeshGradient shows through from parent
      stableCtx.save();

      // Apply zoom + pan
      stableCtx.translate(view.panX, view.panY);
      stableCtx.scale(view.zoom, view.zoom);

      // 0. Mouse-following glow (in canvas coordinates)
      const mg = mouseGlowRef.current;
      if (mg.active) {
        mg.x += (mg.targetX - mg.x) * 0.08; // lerp
        mg.y += (mg.targetY - mg.y) * 0.08;
        const glowR = 180 / view.zoom; // constant screen radius regardless of zoom
        const nearNode = hover.active;
        const glowAlpha = nearNode ? 0.07 : 0.035;
        const grad = stableCtx.createRadialGradient(mg.x, mg.y, 0, mg.x, mg.y, glowR);
        grad.addColorStop(0, dark ? `rgba(139,92,246,${glowAlpha})` : `rgba(124,58,237,${glowAlpha * 0.6})`);
        grad.addColorStop(1, 'transparent');
        stableCtx.fillStyle = grad;
        stableCtx.fillRect(mg.x - glowR, mg.y - glowR, glowR * 2, glowR * 2);
      }

      // (Column labels removed — replaced by cluster labels at L3+)

      // ─── Smooth opacity lerp ───
      const signalOpMap = signalOpacityRef.current;
      const geneOpMap = geneOpacityRef.current;
      const edgeOpMap = edgeOpacityRef.current;

      // Compute opacity targets (hover + active cluster)
      const activeCluster = activeClusterRef.current;
      const activeGeneIds = activeCluster
        ? new Set(layout.clusters?.find((c) => String(c.communityId) === activeCluster)?.geneIds ?? [])
        : null;

      for (const node of layout.signalNodes) {
        let target = 1;
        if (hover.active && hover.connectedSignals.has(node.key)) target = 1.0;
        else if (hover.active) target = 0.08;
        // Dim signals not connected to active cluster's genes
        if (activeGeneIds) {
          const connectedToCluster = layout.edges.some((e) => e.signalKey === node.key && activeGeneIds.has(e.geneId));
          if (!connectedToCluster) target = 0.08;
        }
        const current = signalOpMap.get(node.key) ?? 1;
        signalOpMap.set(node.key, current + (target - current) * OPACITY_LERP_SPEED);
      }
      for (const node of layout.geneNodes) {
        let target = 1;
        if (hover.active && hover.connectedGenes.has(node.id)) target = 1.0;
        else if (hover.active) target = 0.08;
        // Dim genes outside active cluster
        if (activeGeneIds && !activeGeneIds.has(node.id)) target = 0.08;
        const current = geneOpMap.get(node.id) ?? 1;
        geneOpMap.set(node.id, current + (target - current) * OPACITY_LERP_SPEED);
      }
      for (const edge of layout.edges) {
        const edgeKey = `${edge.signalKey}\u2192${edge.geneId}`;
        const isHighlighted = hover.active && hover.connectedEdges.has(edgeKey);
        const isDimmed = hover.active && !hover.connectedEdges.has(edgeKey);
        const target = isDimmed ? 0.08 : isHighlighted ? 1.0 : edge.opacity;
        const current = edgeOpMap.get(edgeKey) ?? edge.opacity;
        edgeOpMap.set(edgeKey, current + (target - current) * OPACITY_LERP_SPEED);
      }

      // ─── Dynamic force step (prevent node overlap) ───
      // Runs every frame — strong enough repulsion to visibly push apart,
      // weak spring to maintain general structure
      const MIN_DIST_GENE = 120; // visual diameter of L1 gene orb + label
      const MIN_DIST_SIGNAL = 80; // signal node + label pill width
      const SPRING_K = 0.008; // very gentle pull back (was 0.05 — too strong)

      // Store original positions on first frame
      if (!originalPosRef.current && layout.geneNodes.length > 0) {
        const map = new Map<string, { x: number; y: number }>();
        for (const n of layout.geneNodes) map.set(n.id, { x: n.x, y: n.y });
        for (const n of layout.signalNodes) map.set(n.key, { x: n.x, y: n.y });
        originalPosRef.current = map;
      }
      const origPos = originalPosRef.current;

      if (origPos) {
        // Gene-gene repulsion — direct displacement (not velocity-based)
        for (let i = 0; i < layout.geneNodes.length; i++) {
          for (let j = i + 1; j < layout.geneNodes.length; j++) {
            const a = layout.geneNodes[i],
              b = layout.geneNodes[j];
            const dx = a.x - b.x,
              dy = a.y - b.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            if (dist < MIN_DIST_GENE) {
              // Push apart so they reach MIN_DIST_GENE over ~10 frames
              const overlap = MIN_DIST_GENE - dist;
              const push = overlap * 0.1; // 10% of overlap per frame
              const nx = dx / dist,
                ny = dy / dist;
              a.x += nx * push;
              a.y += ny * push;
              b.x -= nx * push;
              b.y -= ny * push;
            }
          }
        }

        // Signal-signal repulsion
        for (let i = 0; i < layout.signalNodes.length; i++) {
          for (let j = i + 1; j < layout.signalNodes.length; j++) {
            const a = layout.signalNodes[i],
              b = layout.signalNodes[j];
            const dx = a.x - b.x,
              dy = a.y - b.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            if (dist < MIN_DIST_SIGNAL) {
              const overlap = MIN_DIST_SIGNAL - dist;
              const push = overlap * 0.1;
              const nx = dx / dist,
                ny = dy / dist;
              a.x += nx * push;
              a.y += ny * push;
              b.x -= nx * push;
              b.y -= ny * push;
            }
          }
        }

        // Gene-signal repulsion (prevent gene orbs overlapping signal labels)
        for (const gn of layout.geneNodes) {
          for (const sn of layout.signalNodes) {
            const dx = gn.x - sn.x,
              dy = gn.y - sn.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            if (dist < 80) {
              const overlap = 80 - dist;
              const push = overlap * 0.06;
              const nx = dx / dist,
                ny = dy / dist;
              // Push signal away more than gene (signal is lighter)
              sn.x -= nx * push * 0.7;
              sn.y -= ny * push * 0.7;
              gn.x += nx * push * 0.3;
              gn.y += ny * push * 0.3;
            }
          }
        }

        // Very gentle spring pull back to original positions
        for (const n of layout.geneNodes) {
          const orig = origPos.get(n.id);
          if (orig) {
            n.x += (orig.x - n.x) * SPRING_K;
            n.y += (orig.y - n.y) * SPRING_K;
          }
        }
        for (const n of layout.signalNodes) {
          const orig = origPos.get(n.key);
          if (orig) {
            n.x += (orig.x - n.x) * SPRING_K;
            n.y += (orig.y - n.y) * SPRING_K;
          }
        }

        // Update edge endpoints to match moved nodes
        const genePosLookup = new Map(layout.geneNodes.map((n) => [n.id, n]));
        const signalPosLookup = new Map(layout.signalNodes.map((n) => [n.key, n]));
        for (const edge of layout.edges) {
          const sn = signalPosLookup.get(edge.signalKey);
          const gn = genePosLookup.get(edge.geneId);
          if (sn) {
            edge.sx = sn.x;
            edge.sy = sn.y;
          }
          if (gn) {
            edge.gx = gn.x;
            edge.gy = gn.y;
          }
        }
      }

      // ─── L3: Cluster halos (draw before edges so they sit behind) ───
      if (zoomLevel >= 3 && layout.clusters) {
        for (let ci = 0; ci < layout.clusters.length; ci++) {
          const cluster = layout.clusters[ci];
          const clusterAdapter = {
            id: String(cluster.communityId),
            label: cluster.label,
            geneIds: cluster.geneIds,
            center: cluster.center,
            color: cluster.color,
          };
          drawClusterHalo(stableCtx, clusterAdapter, ci, dark, true, time);
        }
      }

      // 1.5. Hyperedges (N-ary execution hulls — drawn behind binary edges)
      if (data.hyperedges && data.hyperedges.length > 0) {
        // Build position lookup: atom value → node position
        const atomPosMap = new Map<string, { x: number; y: number }>();
        for (const sn of layout.signalNodes) atomPosMap.set(sn.key, { x: sn.x, y: sn.y });
        for (const gn of layout.geneNodes) atomPosMap.set(gn.id, { x: gn.x, y: gn.y });

        for (const he of data.hyperedges) {
          const positions: { x: number; y: number }[] = [];
          let outcome: 'success' | 'failed' | undefined;
          for (const atom of he.atoms) {
            if (atom.kind === 'outcome') {
              outcome = atom.value as 'success' | 'failed';
              continue;
            }
            const pos = atomPosMap.get(atom.value);
            if (pos) positions.push(pos);
          }
          if (positions.length >= 2) {
            drawHyperedge(stableCtx, he, positions, 0.6, dark, time, outcome);
          }
        }

        // Causal links between hyperedges
        if (data.causalLinks && data.causalLinks.length > 0) {
          // Compute hyperedge centroids
          const heCentroids = new Map<string, { x: number; y: number }>();
          for (const he of data.hyperedges) {
            const positions: { x: number; y: number }[] = [];
            for (const atom of he.atoms) {
              if (atom.kind === 'outcome') continue;
              const pos = atomPosMap.get(atom.value);
              if (pos) positions.push(pos);
            }
            if (positions.length > 0) {
              const cx = positions.reduce((s, p) => s + p.x, 0) / positions.length;
              const cy = positions.reduce((s, p) => s + p.y, 0) / positions.length;
              heCentroids.set(he.id, { x: cx, y: cy });
            }
          }

          for (const cl of data.causalLinks) {
            const from = heCentroids.get(cl.causeId);
            const to = heCentroids.get(cl.effectId);
            if (from && to) {
              drawCausalLink(stableCtx, from, to, cl.strength, 0.5, dark);
            }
          }
        }
      }

      // 2. Edges (with lerped opacity + hover highlight)
      for (const edge of layout.edges) {
        const edgeKey = `${edge.signalKey}\u2192${edge.geneId}`;
        const isConnected = hover.active && hover.connectedEdges.has(edgeKey);
        const baseOp = edgeOpMap.get(edgeKey) ?? edge.opacity;

        if (isConnected) {
          // Highlighted edge: brighter + thicker + glow
          stableCtx.save();
          const highlightEdge = { ...edge, lineWidth: Math.max(edge.lineWidth * 2, 3) };
          drawEdge(stableCtx, highlightEdge, 1.0, dark, time);
          stableCtx.restore();
        } else {
          drawEdge(stableCtx, edge, baseOp, dark, time);
        }
      }

      // ─── L3+: Cluster labels (drawn after edges, before nodes) ───
      if (zoomLevel >= 3 && layout.clusters) {
        // Sort by gene count descending — larger clusters get label priority
        const sortedClusters = [...layout.clusters].sort((a, b) => b.geneIds.length - a.geneIds.length);
        resetLabelCollisions();
        for (const cluster of sortedClusters) {
          const clusterAdapter = {
            id: String(cluster.communityId),
            label: cluster.label,
            geneIds: cluster.geneIds,
            center: cluster.center,
            color: cluster.color,
          };
          drawClusterLabel(stableCtx, clusterAdapter, dark, view.zoom);
        }
      }

      // 3. Particles (with trails) — skip if prefers-reduced-motion
      if (prefersReducedMotion) {
        /* no particles */
      } else
        for (let i = particles.length - 1; i >= 0; i--) {
          const p = particles[i];
          const edge = layout.edges[p.edgeIdx];
          if (!edge) {
            particles.splice(i, 1);
            continue;
          }

          const pos = getPointOnBezier(
            edge.sx,
            edge.sy,
            edge.cp1x,
            edge.cp1y,
            edge.cp2x,
            edge.cp2y,
            edge.gx,
            edge.gy,
            p.progress,
          );

          // Update trail
          p.trail.push({ x: pos.x, y: pos.y, opacity: p.opacity });
          if (p.trail.length > TRAIL_LENGTH) p.trail.shift();
          // Fade trail entries
          for (let t = 0; t < p.trail.length; t++) {
            p.trail[t].opacity *= 0.7;
          }

          drawParticle(stableCtx, pos.x, pos.y, p, dark);

          p.progress += p.speed;
          if (p.isHighlight) {
            p.opacity -= 0.006;
            if (p.progress > 1 || p.opacity <= 0) {
              particles.splice(i, 1);
            }
          } else if (p.progress > 1) {
            p.progress = 0;
            p.trail = [];
          }
        }

      // 4. Signal nodes (with lerped opacity + render mode + hover highlight)
      for (const node of layout.signalNodes) {
        const nodeCenterX = node.x + node.width / 2;
        const nodeCenterY = node.y + node.height / 2;
        let renderMode = getNodeRenderMode(nodeCenterX, nodeCenterY, viewCenterX, viewCenterY, visibleRadius);

        // Force-promote connected signals during hover (even if ghost/hidden)
        const isConnected = hover.active && hover.connectedSignals.has(node.key);
        const isDirectHit = hover.hit?.type === 'signal' && hover.hit.signalKey === node.key;
        if (isConnected && (renderMode === 'ghost' || renderMode === 'hidden')) {
          renderMode = 'dim';
        }

        if (renderMode === 'hidden') continue;

        if (renderMode === 'ghost' && !isConnected) {
          drawGhostNode(stableCtx, nodeCenterX, nodeCenterY, node.radius || 6, 'signal', dark, node.key);
          continue;
        }

        const baseOpacity = signalOpMap.get(node.key) ?? 1;
        const opacity = isConnected ? 1 : renderMode === 'dim' ? baseOpacity * 0.4 : baseOpacity;

        stableCtx.save();
        drawSignalNode(stableCtx, node, view.zoom, zoomLevel, opacity, isDirectHit, dark, time);
        stableCtx.restore();
      }

      // 5. Gene nodes (with lerped opacity + breathing + flash + render mode)
      // Decay gene flashes
      const geneFlashes = geneFlashRef.current;
      for (const [gid, flash] of geneFlashes) {
        flash.opacity -= 0.008;
        if (flash.opacity <= 0) geneFlashes.delete(gid);
      }

      // Build gene-to-stories lookup for L1 story embedding
      const geneStoryMap = new Map<string, EvolutionStory[]>();
      if (zoomLevel === 1 && currentStories && currentStories.length > 0) {
        for (const story of currentStories) {
          const arr = geneStoryMap.get(story.gene.id) || [];
          arr.push(story);
          geneStoryMap.set(story.gene.id, arr);
        }
      }

      for (const node of layout.geneNodes) {
        const nodeCenterX = node.x + node.width / 2;
        const nodeCenterY = node.y + node.height / 2;
        let renderMode = getNodeRenderMode(nodeCenterX, nodeCenterY, viewCenterX, viewCenterY, visibleRadius);

        // Force-promote connected genes during hover
        const isConnected = hover.active && hover.connectedGenes.has(node.id);
        const isDirectHit = hover.hit?.type === 'gene' && hover.hit.geneId === node.id;
        if (isConnected && (renderMode === 'ghost' || renderMode === 'hidden')) {
          renderMode = 'dim';
        }

        if (renderMode === 'hidden') continue;

        if (renderMode === 'ghost' && !isConnected) {
          const shape = categoryToShape(node.category);
          const categoryColor =
            node.category === 'repair' ? '#f59e0b' : node.category === 'innovate' ? '#8b5cf6' : '#22d3ee';
          drawGhostNode(
            stableCtx,
            nodeCenterX,
            nodeCenterY,
            node.width / 2 || 8,
            shape,
            dark,
            node.title,
            categoryColor,
          );
          continue;
        }

        const baseOpacity = geneOpMap.get(node.id) ?? 1;
        const opacity = isConnected ? 1 : renderMode === 'dim' ? baseOpacity * 0.4 : baseOpacity;
        const flash = geneFlashes.get(node.id);

        stableCtx.save();
        drawGeneNode(
          stableCtx,
          node,
          view.zoom,
          zoomLevel,
          opacity,
          isDirectHit, // only direct hover shows info card; connected nodes just brighten
          dark,
          time,
          flash?.color ?? null,
        );
        stableCtx.restore();

        // L1: Story embed below gene node (hover only)
        if (zoomLevel === 1 && isDirectHit) {
          const geneStories = geneStoryMap.get(node.id);
          if (geneStories && geneStories.length > 0) {
            drawGeneStoryEmbed(stableCtx, node, geneStories, dark, view.zoom);
          }
        }
      }

      // 6. Ripples — skip if prefers-reduced-motion
      if (prefersReducedMotion) ripples.length = 0;
      for (let i = ripples.length - 1; i >= 0; i--) {
        const r = ripples[i];
        drawRipple(stableCtx, r);
        r.radius += 0.8;
        r.opacity -= 0.012;
        if (r.opacity <= 0) ripples.splice(i, 1);
      }

      stableCtx.restore();

      // (Stats bar removed — context badge in evolution-map.tsx now)

      rafRef.current = requestAnimationFrame(render);
    }

    rafRef.current = requestAnimationFrame(render);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  // ═══ Mouse handlers ═══
  const onMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || !layoutRef.current) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    // Update mouse glow position (canvas coordinates)
    const view = viewRef.current;
    mouseGlowRef.current.targetX = (mx - view.panX) / view.zoom;
    mouseGlowRef.current.targetY = (my - view.panY) / view.zoom;
    mouseGlowRef.current.active = true;

    if (isPanningRef.current) {
      const dx = mx - lastMouseRef.current.x;
      const dy = my - lastMouseRef.current.y;
      viewRef.current = {
        ...viewRef.current,
        panX: viewRef.current.panX + dx,
        panY: viewRef.current.panY + dy,
      };
      lastMouseRef.current = { x: mx, y: my };
      canvas.style.cursor = 'grabbing';
      return;
    }

    const hit = hitTest(mx, my, layoutRef.current, viewRef.current);
    hoverRef.current = computeHoverState(hit, layoutRef.current);
    canvas.style.cursor = hit ? 'pointer' : 'default';
  }, []);

  const onMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    lastMouseRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };

    const hit = layoutRef.current
      ? hitTest(e.clientX - rect.left, e.clientY - rect.top, layoutRef.current, viewRef.current)
      : null;
    if (!hit) {
      isPanningRef.current = true;
      canvas.style.cursor = 'grabbing';
    }
  }, []);

  const onMouseUp = useCallback(() => {
    isPanningRef.current = false;
    const canvas = canvasRef.current;
    if (canvas) canvas.style.cursor = 'default';
  }, []);

  const onClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas || !layoutRef.current) return;
      if (isPanningRef.current) return;

      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const hit = hitTest(mx, my, layoutRef.current, viewRef.current);

      if (!hit) {
        onSelect(null);
        return;
      }

      const layout = layoutRef.current;

      if (hit.type === 'signal') {
        const sn = layout.signalNodes.find((n) => n.key === hit.signalKey)!;
        const connectedEdges = layout.edges.filter((e) => e.signalKey === hit.signalKey);
        const connectedGeneIds = new Set(connectedEdges.map((e) => e.geneId));
        const connectedGenes = layout.geneNodes.filter((g) => connectedGeneIds.has(g.id));
        onSelect({ type: 'signal', data: sn, connectedGenes, connectedEdges });
      } else if (hit.type === 'gene') {
        const gn = layout.geneNodes.find((n) => n.id === hit.geneId)!;
        const connectedEdges = layout.edges.filter((e) => e.geneId === hit.geneId);
        const connectedSigKeys = new Set(connectedEdges.map((e) => e.signalKey));
        const connectedSignals = layout.signalNodes.filter((s) => connectedSigKeys.has(s.key));
        onSelect({ type: 'gene', data: gn, connectedSignals, connectedEdges });
      } else if (hit.type === 'edge') {
        const edge = hit.edge!;
        const signal = layout.signalNodes.find((n) => n.key === edge.signalKey)!;
        const gene = layout.geneNodes.find((n) => n.id === edge.geneId)!;
        onSelect({ type: 'edge', data: edge, signal, gene });
      } else if (hit.type === 'cluster' && hit.clusterId) {
        // D1→D2: cluster click — fly into cluster, dim others
        activeClusterRef.current = hit.clusterId;
        const cluster = layout.clusters?.find((c) => String(c.communityId) === hit.clusterId);
        if (cluster && canvas) {
          const rect = canvas.getBoundingClientRect();
          const totalSpan = layout.totalSpan ?? rect.width;
          const d2Zoom = getZoomForLevel(2, rect.width, totalSpan);
          const targetView = {
            zoom: d2Zoom,
            panX: rect.width / 2 - cluster.center.x * d2Zoom,
            panY: rect.height / 2 - cluster.center.y * d2Zoom,
          };
          const from = { ...viewRef.current };
          const start = performance.now();
          const dur = 500;
          function tick() {
            const t = Math.min(1, (performance.now() - start) / dur);
            const ease = 1 - Math.pow(1 - t, 3);
            viewRef.current = {
              zoom: from.zoom + (targetView.zoom - from.zoom) * ease,
              panX: from.panX + (targetView.panX - from.panX) * ease,
              panY: from.panY + (targetView.panY - from.panY) * ease,
              zoomLevel: t > 0.3 ? 2 : viewRef.current.zoomLevel,
            };
            if (t < 1) requestAnimationFrame(tick);
            else onZoomLevelChange?.(2);
          }
          requestAnimationFrame(tick);
        }
      }
    },
    [onSelect, onZoomLevelChange],
  );

  // ═══ Double-click → zoom into next level, centered on click point ═══
  const onDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas || !layoutRef.current) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const view = viewRef.current;
      const totalSpan = layoutRef.current.totalSpan ?? rect.width;

      // Zoom in one level (L3→L2→L1), or zoom out if already at L1
      const currentLevel = (view.zoomLevel as number) || 3;
      const nextLevel = currentLevel > 1 ? currentLevel - 1 : 3;

      // Center on click point
      const canvasX = (mx - view.panX) / view.zoom;
      const canvasY = (my - view.panY) / view.zoom;
      const newZoom = getZoomForLevel(nextLevel as 1 | 2 | 3, rect.width, totalSpan);

      const targetView = {
        zoom: newZoom,
        panX: mx - canvasX * newZoom,
        panY: my - canvasY * newZoom,
        zoomLevel: nextLevel as 1 | 2 | 3,
      };

      // Animated fly-to with spring easing
      const from = { ...viewRef.current };
      const start = performance.now();
      const dur = 400;
      function tick() {
        const t = Math.min(1, (performance.now() - start) / dur);
        const ease = 1 - Math.pow(1 - t, 3);
        viewRef.current = {
          zoom: from.zoom + (targetView.zoom - from.zoom) * ease,
          panX: from.panX + (targetView.panX - from.panX) * ease,
          panY: from.panY + (targetView.panY - from.panY) * ease,
          zoomLevel: t > 0.5 ? targetView.zoomLevel : from.zoomLevel,
        };
        if (t < 1) requestAnimationFrame(tick);
        else onZoomLevelChange?.(targetView.zoomLevel);
      }
      requestAnimationFrame(tick);
    },
    [onZoomLevelChange],
  );

  // ═══ Touch handlers (mobile) ═══
  const onTouchStart = useCallback((e: React.TouchEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const ts = touchStateRef.current;
    const touches = e.touches;
    ts.touchCount = touches.length;
    ts.isTouching = true;

    if (touches.length === 1) {
      const rect = canvasRef.current!.getBoundingClientRect();
      lastMouseRef.current = { x: touches[0].clientX - rect.left, y: touches[0].clientY - rect.top };
    } else if (touches.length === 2) {
      // Pinch start
      const dx = touches[1].clientX - touches[0].clientX;
      const dy = touches[1].clientY - touches[0].clientY;
      ts.lastPinchDist = Math.sqrt(dx * dx + dy * dy);
      ts.lastTouchCenter = {
        x: (touches[0].clientX + touches[1].clientX) / 2,
        y: (touches[0].clientY + touches[1].clientY) / 2,
      };
    }
  }, []);

  const onTouchMove = useCallback((e: React.TouchEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const ts = touchStateRef.current;
    const touches = e.touches;

    if (touches.length === 1) {
      // Single finger pan
      const mx = touches[0].clientX - rect.left;
      const my = touches[0].clientY - rect.top;
      const dx = mx - lastMouseRef.current.x;
      const dy = my - lastMouseRef.current.y;
      viewRef.current = {
        ...viewRef.current,
        panX: viewRef.current.panX + dx,
        panY: viewRef.current.panY + dy,
      };
      lastMouseRef.current = { x: mx, y: my };
    } else if (touches.length === 2) {
      // Pinch zoom — discrete level stepping
      const dx = touches[1].clientX - touches[0].clientX;
      const dy = touches[1].clientY - touches[0].clientY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const center = {
        x: (touches[0].clientX + touches[1].clientX) / 2 - rect.left,
        y: (touches[0].clientY + touches[1].clientY) / 2 - rect.top,
      };

      if (ts.lastPinchDist > 0) {
        const scale = dist / ts.lastPinchDist;
        // Step level when pinch ratio exceeds threshold
        if (scale > 1.3 || scale < 0.7) {
          const view = viewRef.current;
          const direction = scale > 1.3 ? -1 : 1; // pinch out = zoom in = -1
          const newLevel = Math.max(1, Math.min(3, (view.zoomLevel as number) + direction)) as 1 | 2 | 3;
          if (newLevel !== view.zoomLevel) {
            const totalSpan = layoutRef.current?.totalSpan ?? rect.width;
            const newZoom = getZoomForLevel(newLevel, rect.width, totalSpan);
            // Center on pinch midpoint
            const canvasCx = (center.x - view.panX) / view.zoom;
            const canvasCy = (center.y - view.panY) / view.zoom;
            viewRef.current = {
              zoom: newZoom,
              panX: center.x - canvasCx * newZoom,
              panY: center.y - canvasCy * newZoom,
              zoomLevel: newLevel,
            };
          }
          ts.lastPinchDist = dist; // reset baseline after level change
        }
      } else {
        ts.lastPinchDist = dist;
      }
      ts.lastTouchCenter = center;
    }
  }, []);

  const onTouchEnd = useCallback(
    (e: React.TouchEvent<HTMLCanvasElement>) => {
      const ts = touchStateRef.current;
      const canvas = canvasRef.current;

      // Tap detection (single finger, quick)
      if (ts.touchCount === 1 && canvas && layoutRef.current) {
        const now = Date.now();
        const rect = canvas.getBoundingClientRect();
        const touch = e.changedTouches[0];
        const mx = touch.clientX - rect.left;
        const my = touch.clientY - rect.top;

        // Double-tap: zoom to L1 on node
        if (now - ts.lastTapTime < 300 && Math.abs(mx - ts.lastTapPos.x) < 20 && Math.abs(my - ts.lastTapPos.y) < 20) {
          const hit = hitTest(mx, my, layoutRef.current, viewRef.current);
          if (hit && hit.node) {
            const node = hit.node;
            const totalSpan = layoutRef.current?.totalSpan ?? rect.width;
            const targetZoom = getZoomForLevel(1, rect.width, totalSpan);
            const cx = node.x + node.width / 2;
            const cy = node.y + node.height / 2;
            viewRef.current = {
              zoom: targetZoom,
              panX: rect.width / 2 - cx * targetZoom,
              panY: rect.height / 2 - cy * targetZoom,
              zoomLevel: 1,
            };
          }
          ts.lastTapTime = 0;
        } else {
          ts.lastTapTime = now;
          ts.lastTapPos = { x: mx, y: my };

          // Single tap → trigger click (select node)
          const hit = hitTest(mx, my, layoutRef.current, viewRef.current);
          if (hit) {
            // Reuse click logic
            const layout = layoutRef.current;
            if (hit.type === 'signal') {
              const sn = layout.signalNodes.find((n) => n.key === hit.signalKey)!;
              const connectedEdges = layout.edges.filter((e) => e.signalKey === hit.signalKey);
              const connectedGeneIds = new Set(connectedEdges.map((e) => e.geneId));
              const connectedGenes = layout.geneNodes.filter((g) => connectedGeneIds.has(g.id));
              onSelect({ type: 'signal', data: sn, connectedGenes, connectedEdges });
            } else if (hit.type === 'gene') {
              const gn = layout.geneNodes.find((n) => n.id === hit.geneId)!;
              const connectedEdges = layout.edges.filter((e) => e.geneId === hit.geneId);
              const connectedSigKeys = new Set(connectedEdges.map((e) => e.signalKey));
              const connectedSignals = layout.signalNodes.filter((s) => connectedSigKeys.has(s.key));
              onSelect({ type: 'gene', data: gn, connectedSignals, connectedEdges });
            } else if (hit.type === 'edge') {
              const edge = hit.edge!;
              const signal = layout.signalNodes.find((n) => n.key === edge.signalKey)!;
              const gene = layout.geneNodes.find((n) => n.id === edge.geneId)!;
              onSelect({ type: 'edge', data: edge, signal, gene });
            }
            // Show hover state on tap (mobile hover substitute)
            hoverRef.current = computeHoverState(hit, layoutRef.current);
          } else {
            onSelect(null);
            hoverRef.current = {
              active: false,
              hit: null,
              connectedSignals: new Set(),
              connectedGenes: new Set(),
              connectedEdges: new Set(),
            };
          }
        }
      }

      ts.isTouching = false;
      ts.touchCount = 0;
      ts.lastPinchDist = 0;
    },
    [onSelect],
  );

  return (
    <>
      <canvas
        ref={canvasRef}
        className="w-full h-full block touch-none"
        role="img"
        aria-label={`Evolution network: ${data.genes.length} strategies, ${data.edges.length} connections, ${Math.round((data.stats?.systemSuccessRate ?? 0) * 100)}% success rate`}
        onMouseMove={onMouseMove}
        onMouseDown={onMouseDown}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      />
      {/* Screen reader fallback: hidden table of top genes */}
      <table className="sr-only" aria-label="Evolution strategies summary">
        <thead>
          <tr>
            <th>Strategy</th>
            <th>Category</th>
            <th>Success Rate</th>
            <th>Runs</th>
          </tr>
        </thead>
        <tbody>
          {data.genes.slice(0, 20).map((g) => (
            <tr key={g.id}>
              <td>{g.title}</td>
              <td>{g.category}</td>
              <td>{Math.round(g.successRate * 100)}%</td>
              <td>{g.totalExecutions}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
