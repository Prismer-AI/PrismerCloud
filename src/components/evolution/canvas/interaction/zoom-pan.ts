/**
 * Evolution Map — Continuous Zoom & Pan
 *
 * Zoom is continuous within ±0.5x of each level's base zoom value.
 * When zoom crosses a level boundary, it snaps to the next/prev level.
 *
 * Input mapping:
 * - Two-finger pinch (trackpad) / Ctrl+scroll (mouse) = zoom
 * - Regular scroll = pan
 * - Toolbar buttons / double-click / +/- keys = discrete level change
 *
 * Level diameters are computed adaptively based on actual content span
 * so that the same zoom level shows appropriate detail regardless of
 * how many genes exist.
 */

import type { MapViewState, ZoomLevel } from '../../types/evolution-map.types';

/** Compute zoom level view diameters based on actual content size */
export function computeLevelDiameters(totalSpan: number): Record<1 | 2 | 3, number> {
  return {
    1: Math.max(300, totalSpan * 0.12), // Focus: 1-3 genes
    2: Math.max(600, totalSpan * 0.35), // Cluster: one domain
    3: totalSpan * 1.2, // Full: everything + padding
  };
}

export function getZoomForLevel(level: ZoomLevel, canvasWidth: number, totalSpan: number): number {
  const diameters = computeLevelDiameters(totalSpan);
  const diameter = diameters[level] || diameters[3];
  return canvasWidth / diameter;
}

/**
 * Handle wheel event — pan or zoom depending on modifier keys.
 * - Regular scroll: pan
 * - Ctrl+scroll / pinch: continuous zoom within ±0.5x of level base
 */
export function handleWheel(e: WheelEvent, view: MapViewState, canvasRect: DOMRect, totalSpan: number): MapViewState {
  e.preventDefault();

  // Ctrl+scroll or pinch = zoom
  if (e.ctrlKey || e.metaKey) {
    const zoomSpeed = 0.01;
    const delta = -e.deltaY * zoomSpeed;
    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, view.zoom * (1 + delta)));

    // Zoom centered on mouse position
    const mx = e.clientX - canvasRect.left;
    const my = e.clientY - canvasRect.top;
    const canvasX = (mx - view.panX) / view.zoom;
    const canvasY = (my - view.panY) / view.zoom;

    // Check if we crossed a level boundary
    const levelDiameters = computeLevelDiameters(totalSpan);
    const newDiameter = canvasRect.width / newZoom;
    let newLevel: ZoomLevel = view.zoomLevel as ZoomLevel;

    // Level boundaries with ±0.5x hysteresis
    const l1Base = levelDiameters[1];
    const l2Base = levelDiameters[2];

    if (newDiameter <= l1Base * 1.5) newLevel = 1;
    else if (newDiameter <= l2Base * 1.5) newLevel = 2;
    else newLevel = 3;

    // Clamp zoom within reasonable bounds for current level
    const levelBase = canvasRect.width / levelDiameters[newLevel];
    const minForLevel = levelBase * 0.5;
    const maxForLevel = levelBase * 2.0;
    const clampedZoom = Math.max(minForLevel, Math.min(maxForLevel, newZoom));

    return {
      zoom: clampedZoom,
      panX: mx - canvasX * clampedZoom,
      panY: my - canvasY * clampedZoom,
      zoomLevel: newLevel,
    };
  }

  // Regular scroll = pan
  const panSpeed = 1.0;
  return {
    ...view,
    panX: view.panX - e.deltaX * panSpeed,
    panY: view.panY - e.deltaY * panSpeed,
  };
}

/**
 * Compute zoom + pan to center on a point at a specific level.
 * Used by double-click fly-to and toolbar buttons.
 */
export function zoomToLevel(
  level: ZoomLevel,
  centerX: number,
  centerY: number,
  canvasWidth: number,
  canvasHeight: number,
  totalSpan: number,
): MapViewState {
  const zoom = getZoomForLevel(level, canvasWidth, totalSpan);
  return {
    zoom,
    panX: canvasWidth / 2 - centerX * zoom,
    panY: canvasHeight / 2 - centerY * zoom,
    zoomLevel: level,
  };
}

// Keep these exports for backward compatibility
export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 5;
