/**
 * Evolution Map — Viewport utilities (zoom level, render mode, coordinate transform, auto-fit)
 */

import type { MapLayout, MapViewState, ZoomLevel, RenderMode } from '../../types/evolution-map.types';

// ─── Coordinate Transform ────────────────────────────────

export function screenToCanvas(mouseX: number, mouseY: number, view: MapViewState): { cx: number; cy: number } {
  return {
    cx: (mouseX - view.panX) / view.zoom,
    cy: (mouseY - view.panY) / view.zoom,
  };
}

// ─── Zoom ────────────────────────────────────────────────

/** 3-level semantic zoom based on logical viewport diameter */
export function getZoomLevel(zoom: number, canvasWidth: number = 800): ZoomLevel {
  const viewDiameter = canvasWidth / zoom;
  if (viewDiameter <= 800) return 1; // L1: Focus (~600px, 1-3 genes)
  if (viewDiameter <= 3000) return 2; // L2: Cluster (~2500px, one domain)
  return 3; // L3: Full map (everything)
}

// ─── Render Mode (viewport-aware) ───────────────────────

export function getNodeRenderMode(
  nodeX: number,
  nodeY: number,
  viewCenterX: number,
  viewCenterY: number,
  visibleRadius: number,
): RenderMode {
  const dx = nodeX - viewCenterX;
  const dy = nodeY - viewCenterY;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < visibleRadius * 0.7) return 'full';
  if (dist < visibleRadius * 1.0) return 'dim';
  if (dist < visibleRadius * 1.6) return 'ghost';
  return 'hidden';
}

// ─── Entry Viewport (center on a gene at L1) ───────────

/**
 * Entry viewport — center on the content gravity center at L2 (Cluster) level.
 * Shows labels while keeping most nodes visible for orientation.
 */
export function computeEntryViewport(
  layout: MapLayout,
  _anchorGeneId: string | null,
  canvasWidth: number,
  canvasHeight: number,
): MapViewState {
  if (layout.geneNodes.length === 0) {
    return { zoom: 0.5, panX: canvasWidth / 2, panY: canvasHeight / 2, zoomLevel: 2 };
  }

  // Find the center of mass of gene nodes, weighted by edge count
  const edgeCount = new Map<string, number>();
  for (const e of layout.edges) edgeCount.set(e.geneId, (edgeCount.get(e.geneId) || 0) + 1);

  let totalWeight = 0;
  let cx = 0,
    cy = 0;
  for (const g of layout.geneNodes) {
    const w = (edgeCount.get(g.id) || 0) + 1;
    cx += g.x * w;
    cy += g.y * w;
    totalWeight += w;
  }
  cx /= totalWeight;
  cy /= totalWeight;

  // L2 zoom: viewDiameter ~1500px to show a good chunk of the graph with labels
  const viewDiameter = 1500;
  const zoom = Math.max(canvasWidth / viewDiameter, 0.4);

  return {
    zoom,
    panX: canvasWidth / 2 - cx * zoom,
    panY: canvasHeight / 2 - cy * zoom,
    zoomLevel: getZoomLevel(zoom, canvasWidth),
  };
}

// ─── Auto-fit ────────────────────────────────────────────

export function autoFit(
  canvasWidth: number,
  canvasHeight: number,
  contentHeight: number,
  layoutWidth: number,
  bounds?: { minX: number; maxX: number; minY: number; maxY: number },
): MapViewState {
  const padding = 80;

  // Use bounds if available (new layout uses [-5000, 5000] space)
  const bw = bounds ? bounds.maxX - bounds.minX : layoutWidth;
  const bh = bounds ? bounds.maxY - bounds.minY : contentHeight;
  const bx = bounds ? bounds.minX : 0;
  const by = bounds ? bounds.minY : 0;

  const zoomX = (canvasWidth - padding * 2) / Math.max(bw, 1);
  const zoomY = (canvasHeight - padding * 2) / Math.max(bh, 1);
  const zoom = Math.max(Math.min(zoomX, zoomY, 0.8), 0.02);

  // Center the content bounds in the canvas
  const centerX = bx + bw / 2;
  const centerY = by + bh / 2;
  const panX = canvasWidth / 2 - centerX * zoom;
  const panY = canvasHeight / 2 - centerY * zoom;

  return { zoom, panX, panY, zoomLevel: getZoomLevel(zoom, canvasWidth) };
}
