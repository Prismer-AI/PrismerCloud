/**
 * Evolution Map — Gene Story Embed (v0.3.1)
 *
 * Renders a story card below a gene node at L1 zoom level.
 * Shows the 2 most recent evolution stories with:
 *   - outcome icon + time ago
 *   - agent @ task description
 *   - signal -> action description
 *   - success rate change with delta indicator
 *
 * Uses shared EvolutionStory type from map-types barrel.
 */

import type { GeneNode, EvolutionStory } from '../../map-types';

// Re-export the EvolutionStory type for consumers that imported from here
export type { EvolutionStory };

// Backward-compatible alias for callers using StoryGeneNode
export type StoryGeneNode = Pick<GeneNode, 'x' | 'y' | 'height'>;

export interface StoryEffect {
  actionDescription: string;
  resultSummary: string;
  geneSuccessRateBefore: number;
  geneSuccessRateAfter: number;
  successRateDelta: number;
  isExplorationEvent: boolean;
}

export function drawGeneStoryEmbed(
  ctx: CanvasRenderingContext2D,
  node: StoryGeneNode,
  stories: EvolutionStory[],
  isDark: boolean,
  zoom: number = 1,
) {
  if (stories.length === 0) return;

  const s = 1 / zoom;
  const w = 240 * s,
    padding = 10 * s;
  const lineH = 14 * s;
  const x = node.x - w / 2;
  const baseY = node.y + node.height / 2 + 30 * s; // below gene node

  // Calculate height
  const storyCount = Math.min(stories.length, 2);
  const cardH = padding * 2 + storyCount * (lineH * 4 + 6 * s);

  ctx.save();

  // Card background
  ctx.fillStyle = isDark ? 'rgba(24,24,27,0.92)' : 'rgba(255,255,255,0.95)';
  ctx.shadowColor = isDark ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.1)';
  ctx.shadowBlur = 8 * s;
  ctx.beginPath();
  ctx.roundRect(x, baseY, w, cardH, 6 * s);
  ctx.fill();
  ctx.shadowBlur = 0;

  // Border
  ctx.strokeStyle = isDark ? 'rgba(63,63,70,0.5)' : 'rgba(228,228,231,0.8)';
  ctx.lineWidth = 1 * s;
  ctx.stroke();

  let curY = baseY + padding;

  for (let si = 0; si < storyCount; si++) {
    const story = stories[si];
    const icon = story.outcome === 'success' ? '\u26A1 ' : '\u274C ';
    const timeAgo = formatTimeAgo(story.timestamp);

    // Line 1: icon + time + outcome
    ctx.font = `bold ${10 * s}px ui-monospace, monospace`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = story.outcome === 'success' ? '#22c55e' : '#ef4444';
    ctx.fillText(`${icon}${timeAgo}`, x + padding, curY);
    curY += lineH;

    // Line 2: agent @ task
    ctx.font = `${9 * s}px -apple-system, sans-serif`;
    ctx.fillStyle = isDark ? '#a1a1aa' : '#71717a';
    const agentTask = `${story.agent.name} @ ${story.task.description}`;
    ctx.fillText(truncate(agentTask, 32), x + padding, curY);
    curY += lineH;

    // Line 3: signal -> action
    ctx.fillStyle = isDark ? '#d4d4d8' : '#52525b';
    const action = `${story.signal.key} \u2192 ${truncate(story.effect.actionDescription, 20)}`;
    ctx.fillText(truncate(action, 34), x + padding, curY);
    curY += lineH;

    // Line 4: rate change
    const delta = story.effect.successRateDelta;
    const deltaStr = delta >= 0 ? `\u25B2+${(delta * 100).toFixed(0)}%` : `\u25BC${(delta * 100).toFixed(0)}%`;
    ctx.fillStyle = delta >= 0 ? '#22c55e' : '#ef4444';
    ctx.font = `bold ${9 * s}px ui-monospace, monospace`;
    const rateBefore = `${(story.effect.geneSuccessRateBefore * 100).toFixed(0)}%`;
    const rateAfter = `${(story.effect.geneSuccessRateAfter * 100).toFixed(0)}%`;
    ctx.fillText(`${rateBefore} \u2192 ${rateAfter}  ${deltaStr}`, x + padding, curY);
    curY += lineH + 6 * s;
  }

  ctx.restore();
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '\u2026' : s;
}

export function formatTimeAgo(iso: string): string {
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
