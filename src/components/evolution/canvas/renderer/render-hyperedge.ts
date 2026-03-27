/**
 * Evolution Map — Hyperedge Rendering (v0.7)
 *
 * Hyperedges connect N atoms (signal + gene + agent + outcome) from a single
 * execution — fundamentally different from binary signal→gene edges.
 *
 * Visual language:
 * - Convex hull with frosted glass fill (connects all member nodes)
 * - Soft pulsing boundary glow
 * - Interior gradient tinted by outcome (green=success, red=failed)
 * - Causal links rendered as curved dashed arrows between hyperedges
 */

import type { MapHyperedge, MapCausalLink } from '../../types/evolution-map.types';

interface NodePosition {
  x: number;
  y: number;
}

/**
 * Draw a hyperedge as a convex hull connecting its member atoms' positions.
 * The caller resolves atom positions from the layout.
 */
export function drawHyperedge(
  ctx: CanvasRenderingContext2D,
  _hyperedge: MapHyperedge,
  memberPositions: NodePosition[],
  opacity: number,
  isDark: boolean,
  time: number,
  outcome?: 'success' | 'failed',
) {
  if (memberPositions.length < 2 || opacity < 0.03) return;

  ctx.save();
  ctx.globalAlpha = opacity;

  // Compute convex hull
  const hull = convexHull(memberPositions);
  if (hull.length < 2) {
    ctx.restore();
    return;
  }

  // Compute centroid for gradient origin
  let cx = 0,
    cy = 0;
  for (const p of hull) {
    cx += p.x;
    cy += p.y;
  }
  cx /= hull.length;
  cy /= hull.length;

  // Max radius for gradient
  let maxR = 0;
  for (const p of hull) {
    const d = Math.sqrt((p.x - cx) ** 2 + (p.y - cy) ** 2);
    if (d > maxR) maxR = d;
  }
  maxR = Math.max(maxR, 20);

  // Expand hull outward by padding for visual breathing room
  const padding = 12;
  const expanded = hull.map((p) => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    return { x: p.x + (dx / d) * padding, y: p.y + (dy / d) * padding };
  });

  // Build smooth path (rounded hull via quadratic curves through midpoints)
  ctx.beginPath();
  for (let i = 0; i < expanded.length; i++) {
    const curr = expanded[i];
    const next = expanded[(i + 1) % expanded.length];
    const midX = (curr.x + next.x) / 2;
    const midY = (curr.y + next.y) / 2;
    if (i === 0) {
      const prev = expanded[expanded.length - 1];
      ctx.moveTo((prev.x + curr.x) / 2, (prev.y + curr.y) / 2);
    }
    ctx.quadraticCurveTo(curr.x, curr.y, midX, midY);
  }
  ctx.closePath();

  // ─── Layer 1: Frosted glass fill ───────────────────────
  const tint =
    outcome === 'success'
      ? isDark
        ? 'rgba(34,197,94,'
        : 'rgba(22,163,74,'
      : outcome === 'failed'
        ? isDark
          ? 'rgba(239,68,68,'
          : 'rgba(220,38,38,'
        : isDark
          ? 'rgba(139,92,246,'
          : 'rgba(124,58,237,';

  const fillGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxR + padding);
  fillGrad.addColorStop(0, tint + (isDark ? '0.08)' : '0.06)'));
  fillGrad.addColorStop(0.6, tint + (isDark ? '0.04)' : '0.03)'));
  fillGrad.addColorStop(1, tint + '0.01)');
  ctx.fillStyle = fillGrad;
  ctx.fill();

  // ─── Layer 2: Pulsing boundary ─────────────────────────
  const pulse = 0.7 + 0.3 * Math.sin(time * 1.5);
  ctx.globalAlpha = opacity * 0.15 * pulse;
  ctx.strokeStyle = tint + (isDark ? '0.4)' : '0.3)');
  ctx.lineWidth = 1.5;
  ctx.setLineDash([3, 5]);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.restore();
}

/**
 * Draw a causal link between two hyperedges as a curved dashed arrow.
 */
export function drawCausalLink(
  ctx: CanvasRenderingContext2D,
  from: NodePosition,
  to: NodePosition,
  strength: number,
  opacity: number,
  isDark: boolean,
) {
  if (opacity < 0.03) return;
  ctx.save();

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 10) {
    ctx.restore();
    return;
  }

  // Curved path (offset control point perpendicular to the line)
  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;
  const nx = -dy / dist;
  const ny = dx / dist;
  const curve = dist * 0.15;
  const cpx = midX + nx * curve;
  const cpy = midY + ny * curve;

  // Dashed stroke
  ctx.globalAlpha = opacity * Math.min(strength, 1) * 0.4;
  ctx.strokeStyle = isDark ? 'rgba(168,85,247,0.5)' : 'rgba(124,58,237,0.4)';
  ctx.lineWidth = 1 + strength * 0.5;
  ctx.setLineDash([4, 4]);
  ctx.lineCap = 'round';

  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.quadraticCurveTo(cpx, cpy, to.x, to.y);
  ctx.stroke();
  ctx.setLineDash([]);

  // Arrow tip
  const t = 0.85;
  const u = 1 - t;
  const ax = u * u * from.x + 2 * u * t * cpx + t * t * to.x;
  const ay = u * u * from.y + 2 * u * t * cpy + t * t * to.y;
  const angle = Math.atan2(to.y - ay, to.x - ax);
  const arrowSize = 4 + strength;

  ctx.globalAlpha = opacity * Math.min(strength, 1) * 0.5;
  ctx.fillStyle = isDark ? 'rgba(168,85,247,0.6)' : 'rgba(124,58,237,0.5)';
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - arrowSize * Math.cos(angle - 0.35), to.y - arrowSize * Math.sin(angle - 0.35));
  ctx.lineTo(to.x - arrowSize * Math.cos(angle + 0.35), to.y - arrowSize * Math.sin(angle + 0.35));
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}

// ─── Convex Hull (Andrew's monotone chain) ───────────────

function convexHull(points: NodePosition[]): NodePosition[] {
  if (points.length <= 2) return [...points];

  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const lower: NodePosition[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }

  const upper: NodePosition[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }

  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function cross(o: NodePosition, a: NodePosition, b: NodePosition): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}
