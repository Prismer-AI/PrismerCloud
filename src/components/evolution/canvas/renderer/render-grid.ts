/**
 * Dot grid background — subtle spatial reference for the canvas.
 * PRD §9.2: background dot grid, very low opacity, scales with zoom.
 */

import type { MapViewState } from '../../types/evolution-map.types';

const DOT_SPACING = 40; // px in canvas space
const DOT_RADIUS = 1;

export function drawBackgroundGrid(
  ctx: CanvasRenderingContext2D,
  view: MapViewState,
  width: number,
  height: number,
  isDark: boolean,
): void {
  const opacity = isDark ? 0.04 : 0.035;
  ctx.fillStyle = isDark ? `rgba(255,255,255,${opacity})` : `rgba(0,0,0,${opacity})`;

  // Compute visible range in canvas space
  const spacing = DOT_SPACING;
  const startX = Math.floor(-view.panX / view.zoom / spacing) * spacing;
  const startY = Math.floor(-view.panY / view.zoom / spacing) * spacing;
  const endX = startX + width / view.zoom + spacing;
  const endY = startY + height / view.zoom + spacing;

  // Batch draw all dots in one path
  ctx.beginPath();
  for (let x = startX; x < endX; x += spacing) {
    for (let y = startY; y < endY; y += spacing) {
      const sx = x * view.zoom + view.panX;
      const sy = y * view.zoom + view.panY;
      // Skip if outside viewport
      if (sx < -2 || sx > width + 2 || sy < -2 || sy > height + 2) continue;
      ctx.moveTo(sx + DOT_RADIUS, sy);
      ctx.arc(sx, sy, DOT_RADIUS, 0, Math.PI * 2);
    }
  }
  ctx.fill();
}
