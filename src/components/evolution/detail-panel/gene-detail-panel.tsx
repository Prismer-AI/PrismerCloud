'use client';

/**
 * Gene Detail Panel (D3) — HTML panel, NOT Canvas.
 *
 * Desktop: Right side 320px slide-in
 * Tablet: Bottom sheet 50vh
 * Mobile: Full screen modal
 */

import { ArrowLeft, Download, GitFork, Share2, Hexagon, Circle, Diamond } from 'lucide-react';

interface Gene {
  id: string;
  title: string;
  category: string;
  successRate: number;
  totalExecutions: number;
  agentCount: number;
  pqi: number;
}

interface Signal {
  key: string;
  category: string;
  routingWeight?: number;
  frequency?: number;
}

interface Capsule {
  outcome: string;
  agentName: string;
  timestamp: string;
  delta?: number;
}

interface Props {
  gene: Gene;
  signals: Signal[];
  capsules: Capsule[];
  clusterName: string;
  isDark: boolean;
  onClose: () => void;
  onSignalClick?: (signalKey: string) => void;
}

const ShapeIcon = ({ category, size = 16 }: { category: string; size?: number }) => {
  switch (category) {
    case 'repair':
      return <Hexagon size={size} className="text-orange-400" />;
    case 'innovate':
      return <Diamond size={size} className="text-violet-400" />;
    default:
      return <Circle size={size} className="text-cyan-400" />;
  }
};

function betaCredibleInterval(successCount: number, failureCount: number): string {
  const alpha = successCount + 1;
  const beta = failureCount + 1;
  const mean = alpha / (alpha + beta);
  const variance = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1));
  const std = Math.sqrt(variance);
  const z = 1.96;
  const lower = Math.max(0, mean - z * std);
  const upper = Math.min(1, mean + z * std);
  const total = successCount + failureCount;

  if (total < 5) return `Too few runs (${total}) for a confident estimate.`;
  return `Based on ${total} runs, we're 95% confident the true success rate is between ${(lower * 100).toFixed(1)}% and ${(upper * 100).toFixed(1)}%.`;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function GeneDetailPanel({ gene, signals, capsules, clusterName, isDark, onClose, onSignalClick }: Props) {
  const failureCount = gene.totalExecutions - Math.round(gene.successRate * gene.totalExecutions);
  const successCount = gene.totalExecutions - failureCount;

  // Responsive: desktop=right panel, tablet=bottom sheet, mobile=full modal
  const bg = isDark ? 'bg-zinc-900 border-l border-white/[0.06]' : 'bg-white border-l border-black/[0.06]';
  // The container in evolution-map.tsx handles positioning; this component just fills its container
  const textPrimary = isDark ? 'text-zinc-100' : 'text-zinc-900';
  const textSecondary = isDark ? 'text-zinc-400' : 'text-zinc-500';
  const cardBg = isDark ? 'bg-zinc-800/60' : 'bg-zinc-50';

  return (
    <div className={`h-full w-full overflow-y-auto ${bg} p-4 space-y-4`}>
      {/* Back button */}
      <button
        onClick={onClose}
        className={`flex items-center gap-1 text-xs ${textSecondary} hover:${textPrimary} transition-colors`}
      >
        <ArrowLeft size={14} />
        Back to {clusterName}
      </button>

      {/* Gene header */}
      <div className="flex items-start gap-3">
        <ShapeIcon category={gene.category} size={24} />
        <div>
          <h3 className={`text-sm font-semibold ${textPrimary}`}>{gene.title || gene.id}</h3>
          <span className={`text-[10px] px-1.5 py-0.5 rounded ${cardBg} ${textSecondary}`}>{gene.category}</span>
        </div>
      </div>

      {/* Success rate bar */}
      <div>
        <div className="flex justify-between text-xs mb-1">
          <span className={textSecondary}>Success Rate</span>
          <span className={textPrimary}>{(gene.successRate * 100).toFixed(1)}%</span>
        </div>
        <div className={`h-2 rounded-full ${isDark ? 'bg-zinc-800' : 'bg-zinc-200'}`}>
          <div
            className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-emerald-400"
            style={{ width: `${gene.successRate * 100}%` }}
          />
        </div>
        <p className={`text-[10px] mt-1.5 ${textSecondary} italic`}>
          {betaCredibleInterval(successCount, failureCount)}
        </p>
      </div>

      {/* Stats row */}
      <div className={`flex gap-2 text-[10px] ${textSecondary}`}>
        <span>{gene.agentCount} agents</span>
        <span>·</span>
        <span>PQI {gene.pqi}</span>
        <span>·</span>
        <span>{gene.totalExecutions} runs</span>
      </div>

      {/* Signals */}
      {signals.length > 0 && (
        <div>
          <h4 className={`text-xs font-medium mb-2 ${textSecondary}`}>Signals ({signals.length})</h4>
          <div className="space-y-1">
            {signals.map((sig) => (
              <button
                key={sig.key}
                onClick={() => onSignalClick?.(sig.key)}
                className={`w-full flex items-center justify-between p-2 rounded-lg text-left transition-colors
                  ${isDark ? 'hover:bg-zinc-800' : 'hover:bg-zinc-50'}`}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      sig.category === 'error'
                        ? 'bg-orange-400'
                        : sig.category === 'task'
                          ? 'bg-cyan-400'
                          : 'bg-zinc-400'
                    }`}
                  />
                  <span className={`text-xs font-mono ${textPrimary}`}>{sig.key}</span>
                </div>
                {sig.routingWeight != null && (
                  <span className={`text-[10px] ${textSecondary}`}>{(sig.routingWeight * 100).toFixed(0)}%</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Recent Capsules */}
      {capsules.length > 0 && (
        <div>
          <h4 className={`text-xs font-medium mb-2 ${textSecondary}`}>Recent ({capsules.length})</h4>
          <div className="space-y-1">
            {capsules.map((cap, i) => (
              <div key={i} className={`flex items-center gap-2 text-[10px] py-1 ${textSecondary}`}>
                <span>{cap.outcome === 'success' ? '✅' : '❌'}</span>
                <span>{timeAgo(cap.timestamp)}</span>
                <span className="truncate">{cap.agentName}</span>
                {cap.delta != null && cap.delta !== 0 && (
                  <span className={cap.delta > 0 ? 'text-emerald-400' : 'text-red-400'}>
                    {cap.delta > 0 ? '+' : ''}
                    {(cap.delta * 100).toFixed(0)}%
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2 pt-2">
        <button className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-violet-600 text-white hover:bg-violet-500 transition-colors">
          <Download size={12} />
          Install
        </button>
        <button
          className={`px-3 py-2 rounded-lg text-xs ${isDark ? 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700' : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200'} transition-colors`}
        >
          <GitFork size={12} />
        </button>
        <button
          className={`px-3 py-2 rounded-lg text-xs ${isDark ? 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700' : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200'} transition-colors`}
        >
          <Share2 size={12} />
        </button>
      </div>
    </div>
  );
}
