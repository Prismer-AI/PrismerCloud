/**
 * Evolution Map — Shape Path Helpers
 *
 * Used by extended renderer modules (gene shapes: hexagon, circle, diamond).
 * The simplified force-directed renderer uses circles only.
 */

export type GeneShape = 'hexagon' | 'circle' | 'diamond';

export function hexagonPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i - Math.PI / 6;
    const x = cx + r * Math.cos(angle);
    const y = cy + r * Math.sin(angle);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

export function diamondPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx + r * 0.8, cy);
  ctx.lineTo(cx, cy + r);
  ctx.lineTo(cx - r * 0.8, cy);
  ctx.closePath();
}

export function shapePath(ctx: CanvasRenderingContext2D, _shape: GeneShape, cx: number, cy: number, r: number) {
  // v0.7: All nodes render as circles (Siri-orb aesthetic).
  // Category is differentiated by color, not geometry.
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
}

/**
 * Breathing pulse for cold-start nodes.
 * PRD §12.2: stroke opacity 0.2↔0.35, 4s cycle. No size change.
 * Returns OPACITY value [0.2, 0.35], not a size multiplier.
 */
export function breathingPulse(time: number): number {
  return 0.275 + 0.075 * Math.sin(time * ((2 * Math.PI) / 4));
}
