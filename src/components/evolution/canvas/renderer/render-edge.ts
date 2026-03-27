/**
 * Evolution Map — Edge Drawing (v0.7 Luminous Flows)
 *
 * Multi-layered energy flow aesthetic:
 * - Wide outer bloom (soft glow aura around the path)
 * - Gradient core stroke (source→target color)
 * - Bright inner highlight (thin white center line for depth)
 * - Animated flow dot traveling along the curve
 * - Bimodality warning: pulsing amber/red overlay
 */

import type { EdgePath } from '../../types/evolution-map.types';
import { SIGNAL_CATEGORY_COLORS, GENE_CATEGORY_COLORS } from './colors';

const DEFAULT_SOURCE_COLOR = '#8b5cf6';
const DEFAULT_TARGET_COLOR = '#06b6d4';

function signalKeyToCategory(key: string): string {
  const idx = key.indexOf(':');
  return idx >= 0 ? key.slice(0, idx) : key;
}

export function drawEdge(
  ctx: CanvasRenderingContext2D,
  edge: EdgePath,
  opacity: number,
  isDark: boolean,
  time: number = 0,
) {
  if (opacity < 0.02) return;
  ctx.save();

  const signalCat = signalKeyToCategory(edge.signalKey);
  const sourceColor = SIGNAL_CATEGORY_COLORS[signalCat] || DEFAULT_SOURCE_COLOR;
  const targetColor = GENE_CATEGORY_COLORS[edge.geneId] || edge.color || DEFAULT_TARGET_COLOR;

  // ─── Exploring edges: soft dotted line ─────────────────────
  if (edge.isExploring) {
    ctx.lineCap = 'round';
    ctx.setLineDash([2, 4]);
    ctx.globalAlpha = opacity * 0.35;
    ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.12)';
    ctx.lineWidth = 1;

    ctx.beginPath();
    ctx.moveTo(edge.sx, edge.sy);
    ctx.bezierCurveTo(edge.cp1x, edge.cp1y, edge.cp2x, edge.cp2y, edge.gx, edge.gy);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.restore();
    return;
  }

  // ─── Established edges: 3-layer luminous flow ──────────────

  const gradient = ctx.createLinearGradient(edge.sx, edge.sy, edge.gx, edge.gy);
  gradient.addColorStop(0, sourceColor);
  gradient.addColorStop(1, targetColor);

  // Layer 1: Wide outer bloom (aura)
  if (opacity > 0.08) {
    ctx.globalAlpha = opacity * 0.25;
    ctx.strokeStyle = sourceColor;
    ctx.lineWidth = edge.lineWidth + 6;
    ctx.shadowColor = sourceColor;
    ctx.shadowBlur = 10;
    ctx.lineCap = 'round';

    ctx.beginPath();
    ctx.moveTo(edge.sx, edge.sy);
    ctx.bezierCurveTo(edge.cp1x, edge.cp1y, edge.cp2x, edge.cp2y, edge.gx, edge.gy);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  // Layer 2: Core gradient stroke
  ctx.lineCap = 'round';
  ctx.setLineDash([]);
  ctx.globalAlpha = opacity;
  ctx.strokeStyle = gradient;
  ctx.lineWidth = edge.lineWidth;

  ctx.beginPath();
  ctx.moveTo(edge.sx, edge.sy);
  ctx.bezierCurveTo(edge.cp1x, edge.cp1y, edge.cp2x, edge.cp2y, edge.gx, edge.gy);
  ctx.stroke();

  // Layer 3: Bright center highlight (adds glass/depth feel)
  if (edge.lineWidth > 1.2) {
    ctx.globalAlpha = opacity * 0.4;
    ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.5)';
    ctx.lineWidth = Math.max(0.5, edge.lineWidth * 0.3);

    ctx.beginPath();
    ctx.moveTo(edge.sx, edge.sy);
    ctx.bezierCurveTo(edge.cp1x, edge.cp1y, edge.cp2x, edge.cp2y, edge.gx, edge.gy);
    ctx.stroke();
  }

  // ─── Animated flow dot (traveling along the curve) ─────────
  if (opacity > 0.2 && edge.lineWidth > 1) {
    // Position cycles from 0→1 over 3 seconds, offset by edge hash
    const hash = (edge.signalKey.length + edge.geneId.length) * 0.1;
    const t = (time * 0.33 + hash) % 1;
    const pos = bezierPoint(edge, t);

    const dotR = Math.min(edge.lineWidth * 0.8, 2.5);
    ctx.globalAlpha = opacity * (0.5 + 0.3 * Math.sin(t * Math.PI)); // brighter at midpoint
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = sourceColor;
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, dotR, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  // ─── Bimodality warning glow (overdispersion) ──────────────
  const bimodality = edge.bimodalityIndex ?? 0;
  if (bimodality > 0.3) {
    const pulse = 0.5 + 0.5 * Math.sin(time * Math.PI);
    const glowIntensity = Math.min(1, (bimodality - 0.3) / 0.4);
    const glowColor = bimodality > 0.6 ? '#ef4444' : '#f59e0b';

    ctx.globalAlpha = opacity * glowIntensity * 0.3 * (0.7 + 0.3 * pulse);
    ctx.strokeStyle = glowColor;
    ctx.lineWidth = edge.lineWidth + 6 + pulse * 3;
    ctx.shadowColor = glowColor;
    ctx.shadowBlur = 14 + pulse * 10;

    ctx.beginPath();
    ctx.moveTo(edge.sx, edge.sy);
    ctx.bezierCurveTo(edge.cp1x, edge.cp1y, edge.cp2x, edge.cp2y, edge.gx, edge.gy);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  ctx.restore();
}

/** Evaluate cubic bezier at parameter t */
function bezierPoint(edge: EdgePath, t: number): { x: number; y: number } {
  const u = 1 - t;
  return {
    x: u * u * u * edge.sx + 3 * u * u * t * edge.cp1x + 3 * u * t * t * edge.cp2x + t * t * t * edge.gx,
    y: u * u * u * edge.sy + 3 * u * u * t * edge.cp1y + 3 * u * t * t * edge.cp2y + t * t * t * edge.gy,
  };
}
