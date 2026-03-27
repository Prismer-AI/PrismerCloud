/**
 * Evolution Map — Particle Rendering (with trail)
 */

import type { Particle } from '../../map-types';

export function drawParticle(
  ctx: CanvasRenderingContext2D,
  x: number, y: number,
  particle: Particle,
  isDark: boolean,
) {
  ctx.save();

  // Trail
  for (let i = 0; i < particle.trail.length; i++) {
    const t = particle.trail[i];
    ctx.globalAlpha = t.opacity * 0.4;
    ctx.beginPath();
    ctx.arc(t.x, t.y, particle.radius * (0.3 + 0.3 * (i / particle.trail.length)), 0, Math.PI * 2);
    ctx.fillStyle = particle.color;
    ctx.fill();
  }

  // Main particle
  ctx.globalAlpha = particle.opacity;
  ctx.shadowColor = particle.color;
  ctx.shadowBlur = particle.isHighlight ? 10 : 5;
  ctx.beginPath();
  ctx.arc(x, y, particle.radius, 0, Math.PI * 2);
  ctx.fillStyle = particle.color;
  ctx.fill();

  if (particle.isHighlight) {
    ctx.shadowBlur = 0;
    ctx.globalAlpha = particle.opacity * 0.7;
    ctx.beginPath();
    ctx.arc(x, y, particle.radius * 0.4, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
  }

  ctx.shadowBlur = 0;
  ctx.restore();
}
