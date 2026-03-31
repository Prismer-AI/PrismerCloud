/**
 * Evolution Map — Signal Node Rendering (v0.5 fixed screen sizes)
 *
 * 3-level zoom with FIXED canvas-coord radii per level:
 *   L1 (Focus):   radius = 7px — glass fill + full label + frequency + lastSeen
 *   L2 (Cluster): radius = 4px — small circle, label only on hover
 *   L3 (Full):    radius = 2.5px — tiny dot, category color, no label
 *   Hover: glass pill label + glow
 */

import type { SignalNode, ZoomLevel } from '../../map-types';
import { SIGNAL_CATEGORY_COLORS } from './colors';
import { breathingPulse } from './shapes';

export function drawSignalNode(
  ctx: CanvasRenderingContext2D,
  node: SignalNode,
  zoom: number,
  zoomLevel: ZoomLevel,
  opacity: number,
  isHovered: boolean,
  isDark: boolean,
  time: number,
) {
  ctx.save();
  ctx.globalAlpha = opacity;

  const catColor = SIGNAL_CATEGORY_COLORS[node.category] || '#71717a';
  const cx = node.x;
  const cy = node.y;

  // Screen-fixed label scale: divide by zoom so labels stay constant on screen
  const s = 1 / zoom;

  // Breathing for cold-start
  const breathing = node.frequency === 0 ? breathingPulse(time) : 1;

  // ─── L3 (Full Map): 2.5px tiny dot, category color, no label ──────
  if (zoomLevel === 3) {
    const r = 2.5 * breathing;

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = catColor;
    ctx.globalAlpha = opacity * (isHovered ? 0.85 : 0.55);
    ctx.fill();

    // Hover: glow + glass pill label
    if (isHovered) {
      ctx.shadowColor = catColor;
      ctx.shadowBlur = 12;
      ctx.globalAlpha = opacity * 0.35;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      drawGlassPillLabel(ctx, node.key, cx, cy + r + 3 * s, isDark, opacity, s);
    }

    ctx.restore();
    return;
  }

  // ─── L2 (Cluster): 4px small circle, label on hover ───────────────
  if (zoomLevel === 2) {
    const r = 4 * breathing;
    const fr = isHovered ? r * 1.15 : r;

    // Glass fill
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, fr);
    grad.addColorStop(0, catColor + '25');
    grad.addColorStop(1, catColor + '08');
    ctx.beginPath();
    ctx.arc(cx, cy, fr, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();

    // Thin border
    ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)';
    ctx.lineWidth = 1;
    ctx.globalAlpha = opacity * 0.8;
    ctx.stroke();

    // Hover: glow + glass pill label
    if (isHovered) {
      ctx.shadowColor = catColor;
      ctx.shadowBlur = 15;
      ctx.globalAlpha = opacity * 0.4;
      ctx.beginPath();
      ctx.arc(cx, cy, fr, 0, Math.PI * 2);
      ctx.strokeStyle = catColor;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.shadowBlur = 0;

      drawGlassPillLabel(ctx, node.key, cx, cy + fr + 3 * s, isDark, opacity, s);
    }

    ctx.restore();
    return;
  }

  // ─── L1 (Focus): 7px circle, glass fill, label + frequency ────────
  {
    const r = 7 * breathing;
    const fr = isHovered ? r * 1.15 : r;

    // Glass fill
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, fr);
    grad.addColorStop(0, catColor + '25');
    grad.addColorStop(1, catColor + '08');
    ctx.beginPath();
    ctx.arc(cx, cy, fr, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();

    // Thin border
    ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)';
    ctx.lineWidth = 1;
    ctx.globalAlpha = opacity * 0.8;
    ctx.stroke();

    // Hover glow
    if (isHovered) {
      ctx.shadowColor = catColor;
      ctx.shadowBlur = 20;
      ctx.globalAlpha = opacity * 0.4;
      ctx.beginPath();
      ctx.arc(cx, cy, fr, 0, Math.PI * 2);
      ctx.strokeStyle = catColor;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // Label — abbreviated key, full on hover
    ctx.globalAlpha = opacity * 0.9;
    const maxLen = isHovered ? 28 : 16;
    const rawLabel = node.key;
    const label = rawLabel.length > maxLen ? rawLabel.slice(0, maxLen - 1) + '\u2026' : rawLabel;
    const fontSize = (isHovered ? 9 : 8) * s;
    ctx.font = `${fontSize}px ui-monospace, "SF Mono", monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    // Background pill (capsule shape)
    const metrics = ctx.measureText(label);
    const tw = metrics.width + 10 * s;
    const th = fontSize + 6 * s;
    const labelY = cy + fr + 3 * s;
    ctx.fillStyle = isDark ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.75)';
    ctx.beginPath();
    ctx.roundRect(cx - tw / 2, labelY, tw, th, th / 2);
    ctx.fill();
    // Pill border
    ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)';
    ctx.lineWidth = 0.5 * s;
    ctx.stroke();
    ctx.fillStyle = isDark ? '#d4d4d8' : '#3f3f46';
    ctx.fillText(label, cx, labelY + 3 * s);

    // Frequency count
    if (node.frequency > 0) {
      let infoY = labelY + th + 3 * s;
      ctx.globalAlpha = opacity * 0.6;
      ctx.fillStyle = isDark ? '#a1a1aa' : '#71717a';
      ctx.font = `${8 * s}px ui-monospace, monospace`;
      ctx.fillText(`\u00D7${node.frequency}`, cx, infoY);
      infoY += 12 * s;

      // Last seen (L1 or hover)
      if (node.lastSeen && (zoomLevel === 1 || isHovered)) {
        ctx.globalAlpha = opacity * 0.45;
        ctx.fillStyle = isDark ? '#71717a' : '#a1a1aa';
        ctx.font = `${7 * s}px -apple-system, sans-serif`;
        ctx.fillText(formatLastSeen(node.lastSeen), cx, infoY);
      }
    }
  }

  ctx.restore();
}

/** Draw a glass-style pill label (used for hover labels on L2/L3) */
function drawGlassPillLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  topY: number,
  isDark: boolean,
  opacity: number,
  s: number = 1,
) {
  ctx.globalAlpha = opacity * 0.9;
  ctx.font = `${9 * s}px ui-monospace, "SF Mono", monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  const metrics = ctx.measureText(text);
  const tw = metrics.width + 8 * s;
  const th = 13 * s;

  // Glass pill background
  ctx.fillStyle = isDark ? 'rgba(0,0,0,0.7)' : 'rgba(255,255,255,0.85)';
  ctx.beginPath();
  ctx.roundRect(cx - tw / 2, topY, tw, th, 3 * s);
  ctx.fill();

  ctx.fillStyle = isDark ? '#e4e4e7' : '#27272a';
  ctx.fillText(text, cx, topY + 2 * s);
}

export function abbreviateSignal(key: string): string {
  // "error:connection_refused" -> "conn_refused"
  // "error:timeout" -> "timeout"
  // "capability:search" -> "search"
  const parts = key.split(':');
  if (parts.length >= 2) {
    const val = parts.slice(1).join(':');
    if (val.length > 14) return val.slice(0, 12) + '\u2026';
    return val;
  }
  if (key.length > 14) return key.slice(0, 12) + '\u2026';
  return key;
}

function formatLastSeen(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
