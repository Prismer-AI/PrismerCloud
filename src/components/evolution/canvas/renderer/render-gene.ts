/**
 * Evolution Map — Gene Node Rendering (v0.7 Siri-Orb Aesthetic)
 *
 * Inspired by Apple's Siri orb: multi-layered concentric glow,
 * bright plasma core, frosted glass outer shell, ambient halo.
 *
 * Shape encoding by category:
 *   repair   -> hexagon  (orange)
 *   optimize -> circle   (cyan)
 *   innovate -> diamond  (violet)
 *   diagnostic -> triangle (rose)
 *
 * 3-level zoom:
 *   L1 (Focus):   r=28 — full orb with glass shell + name + stats
 *   L2 (Cluster): r=16 — medium orb + name pill
 *   L3 (Full):    r=9  — small glowing dot + hover tooltip
 */

import type { GeneNode, GeneShape, ZoomLevel } from '../../map-types';
import { categoryToShape } from '../../map-types';
import { GENE_CATEGORY_COLORS, confidenceToColor } from './colors';
import { shapePath, breathingPulse } from './shapes';

/** Secondary color per category for dual-tone gradient */
const CATEGORY_ACCENT: Record<string, string> = {
  repair: '#fbbf24', // amber
  optimize: '#22d3ee', // cyan-400
  innovate: '#a78bfa', // violet-400
  diagnostic: '#fb7185', // rose-400
};

export function drawGeneNode(
  ctx: CanvasRenderingContext2D,
  node: GeneNode,
  zoom: number,
  zoomLevel: ZoomLevel,
  opacity: number,
  isHovered: boolean,
  isDark: boolean,
  time: number,
  flashColor?: string | null,
) {
  ctx.save();

  const effectiveOpacity = node.totalExecutions === 0 ? (opacity * breathingPulse(time)) / 0.35 : opacity;
  ctx.globalAlpha = effectiveOpacity;

  const catColor = GENE_CATEGORY_COLORS[node.category] || '#71717a';
  const accentColor = CATEGORY_ACCENT[node.category] || catColor;
  const shape: GeneShape = node.shape || categoryToShape(node.category);
  const cx = node.x;
  const cy = node.y;

  // ─── Size by zoom level ─────────────────────────────────────
  const baseR = zoomLevel === 1 ? 18 : zoomLevel === 2 ? 12 : 7;
  const r = isHovered ? baseR * 1.12 : baseR;

  // ─── Layer 1: Ambient halo (outermost glow ring) ────────────
  const haloR = r * 2.2;
  const halo = ctx.createRadialGradient(cx, cy, r * 0.6, cx, cy, haloR);
  halo.addColorStop(0, catColor + (isHovered ? '25' : '12'));
  halo.addColorStop(0.5, catColor + '08');
  halo.addColorStop(1, catColor + '00');
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(cx, cy, haloR, 0, Math.PI * 2);
  ctx.fill();

  // ─── Layer 2: Outer glow ring (soft bloom) ──────────────────
  ctx.shadowColor = catColor;
  ctx.shadowBlur = isHovered ? 30 : zoomLevel === 3 ? 8 : 14;

  const outerGrad = ctx.createRadialGradient(cx, cy, r * 0.2, cx, cy, r * 1.1);
  outerGrad.addColorStop(0, catColor + '50');
  outerGrad.addColorStop(0.6, catColor + '20');
  outerGrad.addColorStop(1, catColor + '05');
  shapePath(ctx, shape, cx, cy, r * 1.1);
  ctx.fillStyle = outerGrad;
  ctx.fill();
  ctx.shadowBlur = 0;

  // ─── Layer 3: Glass shell (frosted border) ──────────────────
  shapePath(ctx, shape, cx, cy, r);
  const shellGrad = ctx.createRadialGradient(cx, cy - r * 0.3, r * 0.1, cx, cy, r);
  shellGrad.addColorStop(0, isDark ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.5)');
  shellGrad.addColorStop(0.4, isDark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.2)');
  shellGrad.addColorStop(1, isDark ? 'rgba(255,255,255,0.02)' : 'rgba(255,255,255,0.08)');
  ctx.fillStyle = shellGrad;
  ctx.fill();

  // Glass border
  shapePath(ctx, shape, cx, cy, r);
  ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.4)';
  ctx.lineWidth = zoomLevel === 1 ? 1.5 : 1;
  ctx.stroke();

  // ─── Layer 4: Plasma core (bright inner orb) ────────────────
  const coreR = r * 0.5;
  const coreGrad = ctx.createRadialGradient(cx, cy - coreR * 0.2, 0, cx, cy, coreR);
  coreGrad.addColorStop(0, '#ffffff' + (isHovered ? 'a0' : '70'));
  coreGrad.addColorStop(0.3, accentColor + (isHovered ? '80' : '50'));
  coreGrad.addColorStop(0.7, catColor + '40');
  coreGrad.addColorStop(1, catColor + '00');
  ctx.beginPath();
  ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
  ctx.fillStyle = coreGrad;
  ctx.fill();

  // ─── Layer 5: Specular highlight (top-left reflection) ──────
  if (zoomLevel <= 2) {
    const specX = cx - r * 0.25;
    const specY = cy - r * 0.3;
    const specR = r * 0.35;
    const spec = ctx.createRadialGradient(specX, specY, 0, specX, specY, specR);
    spec.addColorStop(0, 'rgba(255,255,255,' + (isHovered ? '0.35' : '0.2') + ')');
    spec.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.beginPath();
    ctx.arc(specX, specY, specR, 0, Math.PI * 2);
    ctx.fillStyle = spec;
    ctx.fill();
  }

  // ─── Flash overlay (SSE event highlight) ────────────────────
  if (flashColor) {
    ctx.globalAlpha = effectiveOpacity * 0.2;
    shapePath(ctx, shape, cx, cy, r);
    ctx.fillStyle = flashColor;
    ctx.fill();
    ctx.globalAlpha = effectiveOpacity;
  }

  // ─── Labels (name pill + stats) ─────────────────────────────
  ctx.globalAlpha = effectiveOpacity;

  // Screen-fixed label scale: divide by zoom so labels stay constant on screen
  const s = 1 / zoom;

  if (zoomLevel <= 2) {
    // Name pill
    const fontSize = (zoomLevel === 1 ? 10 : 8) * s;
    const maxChars = isHovered ? 30 : zoomLevel === 1 ? 20 : 14;
    const title = node.title.length > maxChars ? node.title.slice(0, maxChars - 1) + '\u2026' : node.title;
    ctx.font = `600 ${fontSize}px -apple-system, "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const metrics = ctx.measureText(title);
    const pillW = metrics.width + 12 * s;
    const pillH = fontSize + 6 * s;
    const pillY = cy + r + 6 * s;

    // Pill background — glassmorphic
    ctx.globalAlpha = effectiveOpacity * 0.85;
    ctx.fillStyle = isDark ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.75)';
    ctx.beginPath();
    ctx.roundRect(cx - pillW / 2, pillY, pillW, pillH, pillH / 2);
    ctx.fill();
    // Pill border
    ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
    ctx.lineWidth = 0.5 * s;
    ctx.stroke();

    ctx.globalAlpha = effectiveOpacity;
    ctx.fillStyle = isDark ? '#e4e4e7' : '#27272a';
    ctx.fillText(title, cx, pillY + pillH / 2);

    // Hover info card (glassmorphic)
    if (isHovered && zoomLevel === 1) {
      const cardW = 160 * s;
      const cardH = 72 * s;
      const cardX = cx - cardW / 2;
      const cardY = pillY + pillH + 6 * s;
      const cardR = 10 * s;

      // Card background
      ctx.globalAlpha = effectiveOpacity * 0.92;
      ctx.fillStyle = isDark ? 'rgba(9,9,11,0.80)' : 'rgba(255,255,255,0.88)';
      ctx.beginPath();
      ctx.roundRect(cardX, cardY, cardW, cardH, cardR);
      ctx.fill();
      // Card border
      ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
      ctx.lineWidth = 0.5 * s;
      ctx.stroke();

      ctx.globalAlpha = effectiveOpacity;
      ctx.textAlign = 'left';
      const padL = cardX + 10 * s;
      let yy = cardY + 14 * s;

      // Success rate bar
      const pctVal = node.successRate;
      const barW = cardW - 20 * s;
      const barH = 4 * s;
      ctx.fillStyle = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
      ctx.beginPath();
      ctx.roundRect(padL, yy, barW, barH, 2 * s);
      ctx.fill();
      ctx.fillStyle = pctVal >= 0.7 ? '#22c55e' : pctVal >= 0.4 ? '#f59e0b' : '#ef4444';
      ctx.beginPath();
      ctx.roundRect(padL, yy, barW * Math.max(pctVal, 0.02), barH, 2 * s);
      ctx.fill();
      yy += barH + 8 * s;

      // Stats row 1
      ctx.font = `600 ${10 * s}px -apple-system, sans-serif`;
      ctx.fillStyle = isDark ? '#e4e4e7' : '#18181b';
      ctx.fillText(`${Math.round(pctVal * 100)}% success`, padL, yy);
      ctx.textAlign = 'right';
      ctx.fillStyle = isDark ? '#a1a1aa' : '#71717a';
      ctx.font = `${10 * s}px -apple-system, sans-serif`;
      ctx.fillText(`PQI ${node.pqi}`, cardX + cardW - 10 * s, yy);
      yy += 14 * s;

      // Stats row 2
      ctx.textAlign = 'left';
      ctx.fillStyle = isDark ? '#71717a' : '#a1a1aa';
      ctx.font = `${9 * s}px -apple-system, sans-serif`;
      ctx.fillText(`${node.totalExecutions} runs · ${node.agentCount} agents`, padL, yy);
      yy += 13 * s;

      // Category badge
      ctx.font = `600 ${8 * s}px -apple-system, sans-serif`;
      ctx.fillStyle = catColor + '20';
      ctx.beginPath();
      ctx.roundRect(padL, yy - 2 * s, ctx.measureText(node.category).width + 10 * s, 14 * s, 7 * s);
      ctx.fill();
      ctx.fillStyle = catColor;
      ctx.fillText(node.category, padL + 5 * s, yy + 7 * s);
    } else if (isHovered && zoomLevel === 2) {
      // L2: compact stats tooltip (keep simple)
      const pct = `${Math.round(node.successRate * 100)}% success`;
      const detail = `${node.totalExecutions} runs \u00B7 ${node.agentCount} agents \u00B7 PQI ${node.pqi}`;
      const detailFont = 8 * s;
      ctx.font = `${detailFont}px -apple-system, sans-serif`;
      const detailW = Math.max(ctx.measureText(pct).width, ctx.measureText(detail).width) + 14 * s;
      const detailH = detailFont * 2 + 10 * s;
      const detailY = pillY + pillH + 4 * s;

      ctx.globalAlpha = effectiveOpacity * 0.9;
      ctx.fillStyle = isDark ? 'rgba(0,0,0,0.70)' : 'rgba(255,255,255,0.88)';
      ctx.beginPath();
      ctx.roundRect(cx - detailW / 2, detailY, detailW, detailH, 6 * s);
      ctx.fill();
      ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
      ctx.lineWidth = 0.5 * s;
      ctx.stroke();

      ctx.globalAlpha = effectiveOpacity;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = confidenceToColor(node.successRate);
      ctx.fillText(pct, cx, detailY + 3 * s);
      ctx.fillStyle = isDark ? '#a1a1aa' : '#71717a';
      ctx.fillText(detail, cx, detailY + detailFont + 5 * s);
    }
  } else if (zoomLevel === 3 && isHovered) {
    // L3: hover tooltip only
    ctx.globalAlpha = effectiveOpacity;
    const maxChars = 18;
    const title = node.title.length > maxChars ? node.title.slice(0, maxChars - 1) + '\u2026' : node.title;
    const pct = `${Math.round(node.successRate * 100)}%`;
    const label = `${title}  ${pct}`;
    const l3Font = 9 * s;
    ctx.font = `${l3Font}px -apple-system, "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    const metrics = ctx.measureText(label);
    const pillW = metrics.width + 12 * s;
    const pillH = 16 * s;
    const pillY = cy + r + 5 * s;
    ctx.globalAlpha = effectiveOpacity * 0.9;
    ctx.fillStyle = isDark ? 'rgba(0,0,0,0.60)' : 'rgba(255,255,255,0.80)';
    ctx.beginPath();
    ctx.roundRect(cx - pillW / 2, pillY, pillW, pillH, pillH / 2);
    ctx.fill();

    ctx.globalAlpha = effectiveOpacity;
    ctx.fillStyle = isDark ? '#e4e4e7' : '#27272a';
    ctx.fillText(label, cx, pillY + 3 * s);
  }

  ctx.restore();
}
