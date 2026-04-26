/**
 * Evolution Map — Cluster Rendering (v0.8 Visible Territories)
 *
 * Full-map (L3) clusters must be clearly visible as distinct territories:
 * - Strong tinted fill with visible boundary
 * - Large readable label with pill background
 * - Gene count badge
 * - Boundary ring clearly visible (not barely-there dashed line)
 */

import { CLUSTER_HALO_COLORS } from './colors';

export interface ClusterInfo {
  id: string;
  label: string;
  geneIds: string[];
  center: { x: number; y: number };
  color?: string;
}

export function drawClusterHalo(
  ctx: CanvasRenderingContext2D,
  cluster: ClusterInfo,
  colorIndex: number,
  isDark: boolean,
  _isL4: boolean = false,
  time: number = 0,
) {
  const baseColor = cluster.color || CLUSTER_HALO_COLORS[colorIndex % CLUSTER_HALO_COLORS.length];
  const cx = cluster.center.x;
  const cy = cluster.center.y;
  const r = 100 + cluster.geneIds.length * 25;
  const rgb = hexToRgb(baseColor);

  ctx.save();

  const breathe = 1 + 0.03 * Math.sin(time * 0.6 + colorIndex * 1.5);

  // ─── Layer 1: Territory fill (visible, not invisible) ────────
  const outerR = r * 1.4 * breathe;
  const grad1 = ctx.createRadialGradient(cx, cy, 0, cx, cy, outerR);
  grad1.addColorStop(0, `rgba(${rgb.r},${rgb.g},${rgb.b},${isDark ? 0.2 : 0.12})`);
  grad1.addColorStop(0.4, `rgba(${rgb.r},${rgb.g},${rgb.b},${isDark ? 0.12 : 0.08})`);
  grad1.addColorStop(0.75, `rgba(${rgb.r},${rgb.g},${rgb.b},${isDark ? 0.05 : 0.03})`);
  grad1.addColorStop(1, `rgba(${rgb.r},${rgb.g},${rgb.b},0)`);

  ctx.fillStyle = grad1;
  ctx.beginPath();
  ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
  ctx.fill();

  // ─── Layer 2: Boundary ring (clearly visible) ────────────────
  ctx.globalAlpha = isDark ? 0.25 : 0.3;
  ctx.strokeStyle = baseColor;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.arc(cx, cy, r * 1.1, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  ctx.restore();
}

/**
 * Collision-aware cluster labels.
 *
 * Maintains a list of already-drawn label rects per frame.
 * Call `resetLabelCollisions()` at the start of each frame,
 * then `drawClusterLabel()` for each cluster — labels that would
 * overlap a previously drawn label are silently skipped.
 */
const drawnLabelRects: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];

export function resetLabelCollisions() {
  drawnLabelRects.length = 0;
}

function rectsOverlap(
  a: { x1: number; y1: number; x2: number; y2: number },
  b: { x1: number; y1: number; x2: number; y2: number },
  pad = 8,
): boolean {
  return a.x1 - pad < b.x2 && a.x2 + pad > b.x1 && a.y1 - pad < b.y2 && a.y2 + pad > b.y1;
}

export function drawClusterLabel(
  ctx: CanvasRenderingContext2D,
  cluster: ClusterInfo,
  isDark: boolean,
  zoom: number = 1,
) {
  // Suppress labels for clusters with < 2 genes — visual noise at L3
  if (cluster.geneIds.length < 2) return;

  ctx.save();

  const cx = cluster.center.x;
  const cy = cluster.center.y;
  const label = cluster.label.toUpperCase();
  const count = `${cluster.geneIds.length} genes`;

  // Screen-space scaling — labels stay constant size on screen
  const s = 1 / zoom;
  const fontSize = 13 * s;
  const countFontSize = 9 * s;
  const padX = 12 * s;
  const padY = 6 * s;

  ctx.font = `700 ${fontSize}px -apple-system, "Segoe UI", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const metrics = ctx.measureText(label);
  const pillW = metrics.width + padX * 2;
  const pillH = fontSize + padY * 2;
  const pillY = cy;

  // Collision check: skip if overlapping any previously drawn label
  const rect = {
    x1: cx - pillW / 2,
    y1: pillY - pillH / 2,
    x2: cx + pillW / 2,
    y2: pillY + pillH / 2 + (countFontSize + 8 * s),
  };

  for (const existing of drawnLabelRects) {
    if (rectsOverlap(rect, existing, 4 * s)) {
      ctx.restore();
      return; // skip this label — would overlap
    }
  }
  drawnLabelRects.push(rect);

  // Pill background — frosted glass
  ctx.globalAlpha = isDark ? 0.7 : 0.8;
  ctx.fillStyle = isDark ? 'rgba(9,9,11,0.6)' : 'rgba(255,255,255,0.7)';
  ctx.beginPath();
  ctx.roundRect(cx - pillW / 2, pillY - pillH / 2, pillW, pillH, pillH / 2);
  ctx.fill();

  // Pill border with cluster color
  const baseColor = cluster.color || CLUSTER_HALO_COLORS[0];
  ctx.strokeStyle = baseColor + '40';
  ctx.lineWidth = 0.5 * s;
  ctx.stroke();

  // Label text — high contrast
  ctx.globalAlpha = isDark ? 0.9 : 0.85;
  ctx.fillStyle = isDark ? '#e4e4e7' : '#27272a';
  ctx.fillText(label, cx, pillY);

  // Gene count below label
  ctx.globalAlpha = isDark ? 0.5 : 0.5;
  ctx.font = `${countFontSize}px -apple-system, sans-serif`;
  ctx.fillStyle = isDark ? '#a1a1aa' : '#71717a';
  ctx.fillText(count, cx, pillY + pillH / 2 + 8 * s);

  ctx.restore();
}

// ─── Helpers ────────────────────────────────────────────

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h[0] + h[0] + h[1] + h[1] + h[2] + h[2] : h;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}
