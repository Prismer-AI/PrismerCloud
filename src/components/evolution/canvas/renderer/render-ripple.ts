/**
 * Evolution Map — Ripple Rendering
 */

import type { Ripple } from '../../map-types';

export function drawRipple(ctx: CanvasRenderingContext2D, ripple: Ripple) {
  ctx.save();
  ctx.globalAlpha = ripple.opacity;
  ctx.strokeStyle = ripple.color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(ripple.x, ripple.y, ripple.radius, 0, Math.PI * 2);
  ctx.stroke();

  if (ripple.radius > 10) {
    ctx.globalAlpha = ripple.opacity * 0.25;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(ripple.x, ripple.y, ripple.radius * 1.5, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}
