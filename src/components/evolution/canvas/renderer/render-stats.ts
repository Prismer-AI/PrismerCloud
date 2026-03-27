/**
 * Evolution Map — Stats Bar & Dot Grid Rendering
 */

export function drawStatsBar(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, width: number,
  stats: { totalExecutions: number; systemSuccessRate: number; activeAgents: number; explorationRate: number },
  isDark: boolean,
) {
  ctx.save();
  ctx.fillStyle = isDark ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.7)';
  ctx.fillRect(x, y - 12, width, 28);

  ctx.globalAlpha = 0.7;
  ctx.fillStyle = isDark ? '#a1a1aa' : '#71717a';
  ctx.font = '10px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const items = [
    `Executions: ${stats.totalExecutions.toLocaleString()}`,
    `Success: ${Math.round(stats.systemSuccessRate * 100)}%`,
    `Agents: ${stats.activeAgents}`,
    `Exploring: ${Math.round(stats.explorationRate * 100)}%`,
  ];

  const spacing = width / (items.length + 1);
  items.forEach((text, i) => {
    ctx.fillText(text, x + spacing * (i + 1), y);
  });
  ctx.restore();
}

export function drawDotGrid(
  ctx: CanvasRenderingContext2D,
  width: number, height: number,
  zoom: number, isDark: boolean,
) {
  const spacing = 50;
  ctx.save();
  ctx.fillStyle = isDark ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0.03)';
  for (let x = 0; x < width; x += spacing) {
    for (let y = 0; y < height; y += spacing) {
      ctx.beginPath();
      ctx.arc(x, y, 0.8, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}
