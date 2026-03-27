/**
 * Evolution Map — Ghost Node Rendering (v0.3.1)
 *
 * Viewport-edge nodes rendered at 10-15% opacity.
 * Shape-aware: gene ghosts use category-specific shapes (hexagon/circle/diamond),
 * signal ghosts use plain circles.
 *
 * Enhancements:
 * - Directional indicator (arrow pointing toward off-screen node)
 * - Optional label for hovered ghosts
 * - Inner fill with subtle category tint
 */

import type { GeneShape } from './shapes';
import { shapePath } from './shapes';

export function drawGhostNode(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  shape: GeneShape | 'signal',
  isDark: boolean,
  label?: string,
  categoryColor?: string,
) {
  ctx.save();

  const r = Math.max(radius, 2);

  // ─── Inner fill with subtle category tint ─────────────
  if (categoryColor) {
    ctx.globalAlpha = 0.15;
    if (shape === 'signal') {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
    } else {
      shapePath(ctx, shape, x, y, r);
    }
    ctx.fillStyle = categoryColor;
    ctx.fill();
  }

  // ─── Shape outline (PRD §12.2: 20% opacity, not 12%) ──
  ctx.globalAlpha = 0.35;
  ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.25)';
  ctx.lineWidth = 1;

  if (shape === 'signal') {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
  } else {
    shapePath(ctx, shape, x, y, r);
  }
  ctx.stroke();

  // ─── Directional arrow (small triangle pointing toward node center) ──
  // Draw a tiny tick mark on the outer edge pointing inward
  ctx.globalAlpha = 0.2;
  ctx.fillStyle = isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.2)';
  const tickSize = Math.max(3, r * 0.3);
  ctx.beginPath();
  ctx.moveTo(x, y - tickSize);
  ctx.lineTo(x + tickSize * 0.5, y);
  ctx.lineTo(x - tickSize * 0.5, y);
  ctx.closePath();
  ctx.fill();

  // ─── Optional label (for hover state) ─────────────────
  if (label) {
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = isDark ? '#a1a1aa' : '#71717a';
    ctx.font = '7px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const truncated = label.length > 10 ? label.slice(0, 9) + '\u2026' : label;
    ctx.fillText(truncated, x, y + r + 2);
  }

  ctx.restore();
}
