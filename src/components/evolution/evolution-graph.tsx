'use client';

/**
 * Signal Resolution Matrix — "I have a problem. What works?"
 *
 * A heatmap visualization answering the core agent question:
 * given a signal (error/perf issue), which genes resolve it and how well?
 *
 * - X axis: Top signals (grouped by frequency)
 * - Y axis: Genes that handle them
 * - Cell: success rate (green=high, red=low, gray=no data)
 * - Hover: shows exact numbers
 *
 * Also includes a signal bubble chart for ecosystem health at a glance.
 */

import { useState, useMemo } from 'react';
import { useTheme } from '@/contexts/theme-context';

interface Gene {
  id: string;
  category: string;
  title?: string;
  signals_match: string[];
  success_count: number;
  failure_count: number;
}

interface EvolutionGraphProps {
  genes: Gene[];
  width?: number;
  height?: number;
  className?: string;
}

const CAT_COLORS: Record<string, string> = {
  repair: '#fb923c',
  optimize: '#22d3ee',
  innovate: '#a78bfa',
};

function successColor(rate: number, isDark: boolean): string {
  if (rate >= 0.8) return isDark ? '#34d399' : '#059669';
  if (rate >= 0.6) return isDark ? '#fbbf24' : '#d97706';
  if (rate >= 0.3) return isDark ? '#fb923c' : '#ea580c';
  return isDark ? '#f87171' : '#dc2626';
}

export function EvolutionGraph({ genes, className = '' }: EvolutionGraphProps) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const [hoveredCell, setHoveredCell] = useState<{ signal: string; gene: string } | null>(null);
  const [viewMode, setViewMode] = useState<'matrix' | 'bubbles'>('matrix');

  // Build signal→gene resolution matrix
  const { signals, geneList, matrix, signalStats } = useMemo(() => {
    // Count signal frequency across all genes
    const sigFreq = new Map<string, { total: number; resolved: number; genes: string[] }>();

    genes.forEach(gene => {
      const total = gene.success_count + gene.failure_count;
      const rate = total > 0 ? gene.success_count / total : 0;

      gene.signals_match.forEach(sig => {
        const existing = sigFreq.get(sig) || { total: 0, resolved: 0, genes: [] };
        existing.total += total;
        existing.resolved += gene.success_count;
        existing.genes.push(gene.id);
        sigFreq.set(sig, existing);
      });
    });

    // Top signals by coverage (how many genes handle them)
    const sortedSignals = [...sigFreq.entries()]
      .sort((a, b) => b[1].genes.length - a[1].genes.length)
      .slice(0, 12)
      .map(([sig]) => sig);

    // Genes that appear in at least one top signal
    const relevantGeneIds = new Set<string>();
    sortedSignals.forEach(sig => {
      sigFreq.get(sig)?.genes.forEach(id => relevantGeneIds.add(id));
    });
    const filteredGenes = genes
      .filter(g => relevantGeneIds.has(g.id))
      .sort((a, b) => {
        // Sort by category, then by total uses
        if (a.category !== b.category) return a.category.localeCompare(b.category);
        return (b.success_count + b.failure_count) - (a.success_count + a.failure_count);
      })
      .slice(0, 15);

    // Build matrix
    const mat = new Map<string, Map<string, { successRate: number; total: number }>>();
    filteredGenes.forEach(gene => {
      const geneMap = new Map<string, { successRate: number; total: number }>();
      const total = gene.success_count + gene.failure_count;
      const rate = total > 0 ? gene.success_count / total : 0;

      gene.signals_match.forEach(sig => {
        if (sortedSignals.includes(sig)) {
          geneMap.set(sig, { successRate: rate, total });
        }
      });
      mat.set(gene.id, geneMap);
    });

    // Signal stats for bubble view
    const stats = sortedSignals.map(sig => {
      const data = sigFreq.get(sig)!;
      return {
        signal: sig,
        geneCount: data.genes.length,
        totalUses: data.total,
        resolveRate: data.total > 0 ? data.resolved / data.total : 0,
      };
    });

    return { signals: sortedSignals, geneList: filteredGenes, matrix: mat, signalStats: stats };
  }, [genes]);

  if (genes.length === 0) {
    return (
      <div className={`flex items-center justify-center py-8 ${className}`}>
        <p className={`text-sm ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>No data yet</p>
      </div>
    );
  }

  const cellSize = 32;
  const labelWidth = 140;
  const signalLabelHeight = 80;
  const svgWidth = labelWidth + signals.length * cellSize + 20;
  const svgHeight = signalLabelHeight + geneList.length * cellSize + 20;

  return (
    <div className={className}>
      {/* View toggle */}
      <div className="flex items-center gap-2 mb-3">
        <button
          onClick={() => setViewMode('matrix')}
          className={`text-xs px-2.5 py-1 rounded-md transition-colors ${
            viewMode === 'matrix'
              ? (isDark ? 'bg-zinc-800 text-white' : 'bg-zinc-200 text-zinc-900')
              : (isDark ? 'text-zinc-500 hover:text-zinc-300' : 'text-zinc-500 hover:text-zinc-700')
          }`}
        >
          Resolution Matrix
        </button>
        <button
          onClick={() => setViewMode('bubbles')}
          className={`text-xs px-2.5 py-1 rounded-md transition-colors ${
            viewMode === 'bubbles'
              ? (isDark ? 'bg-zinc-800 text-white' : 'bg-zinc-200 text-zinc-900')
              : (isDark ? 'text-zinc-500 hover:text-zinc-300' : 'text-zinc-500 hover:text-zinc-700')
          }`}
        >
          Signal Landscape
        </button>
      </div>

      {viewMode === 'matrix' ? (
        /* ── Signal Resolution Matrix ── */
        <div className="overflow-x-auto">
          <svg
            width={svgWidth}
            height={svgHeight}
            viewBox={`0 0 ${svgWidth} ${svgHeight}`}
            className="max-w-full"
          >
            {/* Signal labels (top, rotated) */}
            {signals.map((sig, i) => (
              <text
                key={sig}
                x={labelWidth + i * cellSize + cellSize / 2}
                y={signalLabelHeight - 4}
                textAnchor="end"
                fill={isDark ? '#a1a1aa' : '#71717a'}
                fontSize={9}
                fontFamily="var(--font-mono)"
                transform={`rotate(-45, ${labelWidth + i * cellSize + cellSize / 2}, ${signalLabelHeight - 4})`}
              >
                {sig.replace(/^(error:|perf:|status:)/, '').slice(0, 18)}
              </text>
            ))}

            {/* Gene rows */}
            {geneList.map((gene, gi) => {
              const y = signalLabelHeight + gi * cellSize;
              const catColor = CAT_COLORS[gene.category] || CAT_COLORS.repair;

              return (
                <g key={gene.id}>
                  {/* Category dot */}
                  <circle
                    cx={8}
                    cy={y + cellSize / 2}
                    r={3}
                    fill={catColor}
                  />
                  {/* Gene label */}
                  <text
                    x={16}
                    y={y + cellSize / 2 + 3}
                    fill={isDark ? '#d4d4d8' : '#3f3f46'}
                    fontSize={9}
                    fontFamily="var(--font-mono)"
                  >
                    {(gene.title || gene.id).slice(0, 18)}
                  </text>

                  {/* Matrix cells */}
                  {signals.map((sig, si) => {
                    const x = labelWidth + si * cellSize;
                    const cellData = matrix.get(gene.id)?.get(sig);
                    const isHovered = hoveredCell?.signal === sig && hoveredCell?.gene === gene.id;

                    return (
                      <g key={sig}>
                        <rect
                          x={x + 1}
                          y={y + 1}
                          width={cellSize - 2}
                          height={cellSize - 2}
                          rx={4}
                          fill={cellData
                            ? successColor(cellData.successRate, isDark) + (isDark ? '30' : '25')
                            : isDark ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.02)'
                          }
                          stroke={isHovered
                            ? (isDark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.3)')
                            : cellData
                              ? successColor(cellData.successRate, isDark) + '40'
                              : 'transparent'
                          }
                          strokeWidth={isHovered ? 1.5 : 0.5}
                          style={{ transition: 'all 0.15s ease' }}
                          onMouseEnter={() => setHoveredCell({ signal: sig, gene: gene.id })}
                          onMouseLeave={() => setHoveredCell(null)}
                        />
                        {/* Success rate text in cell */}
                        {cellData && (
                          <text
                            x={x + cellSize / 2}
                            y={y + cellSize / 2 + 3}
                            textAnchor="middle"
                            fill={successColor(cellData.successRate, isDark)}
                            fontSize={8}
                            fontWeight={600}
                            fontFamily="var(--font-mono)"
                            style={{ pointerEvents: 'none' }}
                          >
                            {Math.round(cellData.successRate * 100)}
                          </text>
                        )}
                      </g>
                    );
                  })}
                </g>
              );
            })}

            {/* Hover tooltip */}
            {hoveredCell && (() => {
              const gene = geneList.find(g => g.id === hoveredCell.gene);
              const cellData = matrix.get(hoveredCell.gene)?.get(hoveredCell.signal);
              const si = signals.indexOf(hoveredCell.signal);
              const gi = geneList.findIndex(g => g.id === hoveredCell.gene);
              if (!gene || si < 0 || gi < 0) return null;

              const tx = labelWidth + si * cellSize + cellSize / 2;
              const ty = signalLabelHeight + gi * cellSize - 8;

              return (
                <g>
                  <rect
                    x={tx - 70}
                    y={ty - 32}
                    width={140}
                    height={28}
                    rx={6}
                    fill={isDark ? '#27272a' : '#ffffff'}
                    stroke={isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)'}
                    strokeWidth={1}
                    filter="url(#tooltip-shadow)"
                  />
                  <text
                    x={tx}
                    y={ty - 15}
                    textAnchor="middle"
                    fill={isDark ? '#e4e4e7' : '#3f3f46'}
                    fontSize={9}
                    fontFamily="var(--font-mono)"
                  >
                    {cellData
                      ? `${Math.round(cellData.successRate * 100)}% success · ${cellData.total} uses`
                      : 'No data for this combination'
                    }
                  </text>
                </g>
              );
            })()}

            <defs>
              <filter id="tooltip-shadow">
                <feDropShadow dx="0" dy="2" stdDeviation="4" floodOpacity="0.15" />
              </filter>
            </defs>
          </svg>
        </div>
      ) : (
        /* ── Signal Bubble Landscape ── */
        <div className="relative" style={{ height: 300 }}>
          <svg width="100%" height="100%" viewBox="0 0 600 300" preserveAspectRatio="xMidYMid meet">
            <defs>
              <filter id="bubble-glow">
                <feGaussianBlur stdDeviation="4" result="coloredBlur" />
                <feMerge>
                  <feMergeNode in="coloredBlur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>

            {signalStats.map((stat, i) => {
              // Position in a packed layout
              const cols = Math.ceil(Math.sqrt(signalStats.length));
              const row = Math.floor(i / cols);
              const col = i % cols;
              const cx = 60 + col * (520 / cols);
              const cy = 40 + row * (220 / Math.ceil(signalStats.length / cols));
              const r = Math.max(15, Math.min(50, 15 + stat.geneCount * 6));
              const color = successColor(stat.resolveRate, isDark);
              const isHovered = hoveredCell?.signal === stat.signal;

              return (
                <g
                  key={stat.signal}
                  onMouseEnter={() => setHoveredCell({ signal: stat.signal, gene: '' })}
                  onMouseLeave={() => setHoveredCell(null)}
                  style={{ cursor: 'pointer' }}
                >
                  {/* Outer glow */}
                  {isHovered && (
                    <circle cx={cx} cy={cy} r={r + 8} fill={`${color}15`} filter="url(#bubble-glow)" />
                  )}
                  {/* Resolve rate ring */}
                  <circle cx={cx} cy={cy} r={r} fill="none" stroke={`${color}30`} strokeWidth={r * 2} />
                  <circle
                    cx={cx} cy={cy} r={r}
                    fill="none"
                    stroke={color}
                    strokeWidth={3}
                    strokeDasharray={`${stat.resolveRate * 2 * Math.PI * r} ${2 * Math.PI * r}`}
                    strokeDashoffset={Math.PI * r / 2}
                    transform={`rotate(-90, ${cx}, ${cy})`}
                    opacity={0.7}
                  />
                  {/* Inner fill */}
                  <circle
                    cx={cx} cy={cy} r={r - 3}
                    fill={isDark ? `${color}10` : `${color}08`}
                    stroke={`${color}40`}
                    strokeWidth={1}
                  />
                  {/* Signal name */}
                  <text
                    x={cx} y={cy - 2}
                    textAnchor="middle"
                    fill={isDark ? '#d4d4d8' : '#3f3f46'}
                    fontSize={Math.min(10, r * 0.5)}
                    fontFamily="var(--font-mono)"
                    fontWeight={600}
                  >
                    {stat.signal.replace(/^(error:|perf:|status:)/, '').slice(0, 12)}
                  </text>
                  {/* Gene count */}
                  <text
                    x={cx} y={cy + 10}
                    textAnchor="middle"
                    fill={isDark ? '#71717a' : '#a1a1aa'}
                    fontSize={8}
                    fontFamily="var(--font-mono)"
                  >
                    {stat.geneCount} genes · {Math.round(stat.resolveRate * 100)}%
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      )}

      {/* Legend */}
      <div className={`flex items-center gap-4 mt-3 text-[10px] font-mono ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
        <span className="flex items-center gap-1">
          <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: successColor(0.9, isDark) + '40' }} />
          {'>'}80%
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: successColor(0.7, isDark) + '40' }} />
          60-80%
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: successColor(0.4, isDark) + '40' }} />
          30-60%
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: successColor(0.1, isDark) + '40' }} />
          {'<'}30%
        </span>
      </div>
    </div>
  );
}
