'use client';

/**
 * Evolution Map — Detail Panel (right-side drawer)
 *
 * Shows detailed info when a signal, gene, or edge is clicked.
 */

import type { DetailTarget, EdgePath } from '../map-types';
import { SIGNAL_CATEGORY_COLORS, GENE_CATEGORY_COLORS, confidenceToColor } from '../map-renderer';
import { X, Zap, Dna, ArrowRight, Activity } from 'lucide-react';

interface Props {
  target: DetailTarget;
  onClose: () => void;
  isDark: boolean;
}

export function MapDetailPanel({ target, onClose, isDark }: Props) {
  if (!target) return null;

  const glass = isDark
    ? 'bg-zinc-900/90 backdrop-blur-xl border-l border-white/[0.06]'
    : 'bg-white/90 backdrop-blur-xl border-l border-black/[0.06]';

  const textPrimary = isDark ? 'text-zinc-100' : 'text-zinc-900';
  const textSecondary = isDark ? 'text-zinc-400' : 'text-zinc-500';
  const textMuted = isDark ? 'text-zinc-500' : 'text-zinc-400';
  const cardBg = isDark ? 'bg-white/[0.04]' : 'bg-black/[0.03]';

  return (
    <div className={`w-80 h-full overflow-y-auto ${glass} shadow-2xl`}>
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-white/[0.06]">
        <h3 className={`text-sm font-semibold ${textPrimary}`}>
          {target.type === 'signal' ? 'Signal Detail' : target.type === 'gene' ? 'Gene Detail' : 'Edge Detail'}
        </h3>
        <button
          onClick={onClose}
          className={`p-1 rounded-md hover:bg-white/10 ${textSecondary}`}
        >
          <X size={16} />
        </button>
      </div>

      <div className="p-4 space-y-4">
        {target.type === 'signal' && <SignalDetail target={target} isDark={isDark} textPrimary={textPrimary} textSecondary={textSecondary} textMuted={textMuted} cardBg={cardBg} />}
        {target.type === 'gene' && <GeneDetail target={target} isDark={isDark} textPrimary={textPrimary} textSecondary={textSecondary} textMuted={textMuted} cardBg={cardBg} />}
        {target.type === 'edge' && <EdgeDetail target={target} isDark={isDark} textPrimary={textPrimary} textSecondary={textSecondary} textMuted={textMuted} cardBg={cardBg} />}
      </div>
    </div>
  );
}

function SignalDetail({ target, isDark, textPrimary, textSecondary, textMuted, cardBg }: {
  target: Extract<NonNullable<DetailTarget>, { type: 'signal' }>;
  isDark: boolean;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  cardBg: string;
}) {
  const { data, connectedGenes, connectedEdges } = target;
  const catColor = SIGNAL_CATEGORY_COLORS[data.category] || '#71717a';

  return (
    <>
      {/* Signal name */}
      <div className="flex items-center gap-2">
        <div className="w-3 h-3 rounded-full" style={{ backgroundColor: catColor }} />
        <span className={`text-base font-mono font-semibold ${textPrimary}`}>{data.key}</span>
      </div>

      {/* Stats */}
      <div className={`grid grid-cols-2 gap-2`}>
        <StatCard label="Frequency (30d)" value={data.frequency.toString()} cardBg={cardBg} textPrimary={textPrimary} textMuted={textMuted} />
        <StatCard label="Connected Genes" value={connectedGenes.length.toString()} cardBg={cardBg} textPrimary={textPrimary} textMuted={textMuted} />
        <StatCard label="Category" value={data.category} cardBg={cardBg} textPrimary={textPrimary} textMuted={textMuted} />
        <StatCard label="Last Seen" value={data.lastSeen ? timeSince(data.lastSeen) : 'Never'} cardBg={cardBg} textPrimary={textPrimary} textMuted={textMuted} />
      </div>

      {/* Connected Genes */}
      <div>
        <h4 className={`text-xs font-semibold uppercase tracking-wide mb-2 ${textSecondary}`}>Connected Genes</h4>
        <div className="space-y-2">
          {connectedGenes.map(g => {
            const edge = connectedEdges.find(e => e.geneId === g.id);
            return (
              <div key={g.id} className={`p-2 rounded-md ${cardBg}`}>
                <div className="flex items-center justify-between">
                  <span className={`text-xs font-medium ${textPrimary}`}>🧬 {g.title}</span>
                  {edge && (
                    <span className="text-[10px] font-mono" style={{ color: confidenceToColor(edge.confidence) }}>
                      {Math.round(edge.confidence * 100)}%
                    </span>
                  )}
                </div>
                <div className={`text-[10px] mt-0.5 ${textMuted}`}>
                  {g.totalExecutions} runs · {Math.round(g.successRate * 100)}% success
                </div>
              </div>
            );
          })}
          {connectedGenes.length === 0 && (
            <div className={`text-xs ${textMuted}`}>No genes connected yet</div>
          )}
        </div>
      </div>
    </>
  );
}

function GeneDetail({ target, isDark, textPrimary, textSecondary, textMuted, cardBg }: {
  target: Extract<NonNullable<DetailTarget>, { type: 'gene' }>;
  isDark: boolean;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  cardBg: string;
}) {
  const { data, connectedSignals, connectedEdges } = target;
  const catColor = GENE_CATEGORY_COLORS[data.category] || '#71717a';

  return (
    <>
      {/* Gene name */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <div className="w-3 h-3 rounded-full" style={{ backgroundColor: catColor }} />
          <span className={`text-base font-semibold ${textPrimary}`}>🧬 {data.title}</span>
        </div>
        <span className={`text-[10px] uppercase tracking-wider ${textMuted}`}>{data.category}</span>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-2">
        <StatCard label="Success Rate" value={`${Math.round(data.successRate * 100)}%`} cardBg={cardBg} textPrimary={textPrimary} textMuted={textMuted} />
        <StatCard label="Executions" value={data.totalExecutions.toString()} cardBg={cardBg} textPrimary={textPrimary} textMuted={textMuted} />
        <StatCard label="Agents" value={data.agentCount.toString()} cardBg={cardBg} textPrimary={textPrimary} textMuted={textMuted} />
        <StatCard label="PQI" value={data.pqi.toString()} cardBg={cardBg} textPrimary={textPrimary} textMuted={textMuted} />
      </div>

      {/* Success rate bar */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className={`text-xs ${textSecondary}`}>Success Rate</span>
          <span className={`text-xs font-mono ${textPrimary}`}>{Math.round(data.successRate * 100)}%</span>
        </div>
        <div className={`h-2 rounded-full ${isDark ? 'bg-white/10' : 'bg-black/10'}`}>
          <div
            className="h-full rounded-full transition-all"
            style={{
              width: `${data.successRate * 100}%`,
              backgroundColor: confidenceToColor(data.successRate),
            }}
          />
        </div>
      </div>

      {/* Connected Signals */}
      <div>
        <h4 className={`text-xs font-semibold uppercase tracking-wide mb-2 ${textSecondary}`}>Triggered By</h4>
        <div className="flex flex-wrap gap-1">
          {connectedSignals.map(s => (
            <span
              key={s.key}
              className={`text-[10px] px-2 py-0.5 rounded-full font-mono`}
              style={{
                backgroundColor: (SIGNAL_CATEGORY_COLORS[s.category] || '#71717a') + '20',
                color: SIGNAL_CATEGORY_COLORS[s.category] || '#71717a',
              }}
            >
              {s.key}
            </span>
          ))}
          {connectedSignals.length === 0 && (
            <span className={`text-xs ${textMuted}`}>No signals connected</span>
          )}
        </div>
      </div>
    </>
  );
}

function EdgeDetail({ target, isDark, textPrimary, textSecondary, textMuted, cardBg }: {
  target: Extract<NonNullable<DetailTarget>, { type: 'edge' }>;
  isDark: boolean;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  cardBg: string;
}) {
  const { data, signal, gene } = target;
  const color = confidenceToColor(data.confidence);

  return (
    <>
      {/* Edge overview */}
      <div className="flex items-center gap-2 text-xs">
        <span className={`font-mono ${textPrimary}`}>{data.signalKey}</span>
        <ArrowRight size={12} className={textMuted} />
        <span className={`font-medium ${textPrimary}`}>{gene.title}</span>
      </div>

      {/* Confidence */}
      <div className={`p-3 rounded-lg ${cardBg} text-center`}>
        <div className="text-2xl font-bold font-mono" style={{ color }}>
          {Math.round(data.confidence * 100)}%
        </div>
        <div className={`text-[10px] mt-1 ${textMuted}`}>
          Confidence ({data.isExploring ? 'Exploring' : 'Established'})
        </div>
      </div>

      {/* Beta distribution params */}
      <div className="grid grid-cols-2 gap-2">
        <StatCard label="α (success+1)" value={data.alpha.toFixed(0)} cardBg={cardBg} textPrimary={textPrimary} textMuted={textMuted} />
        <StatCard label="β (failure+1)" value={data.beta.toFixed(0)} cardBg={cardBg} textPrimary={textPrimary} textMuted={textMuted} />
        <StatCard label="Total Observations" value={data.totalObs.toString()} cardBg={cardBg} textPrimary={textPrimary} textMuted={textMuted} />
        <StatCard label="Status" value={data.isExploring ? '🔍 Exploring' : '✅ Established'} cardBg={cardBg} textPrimary={textPrimary} textMuted={textMuted} />
      </div>
    </>
  );
}

function StatCard({ label, value, cardBg, textPrimary, textMuted }: {
  label: string;
  value: string;
  cardBg: string;
  textPrimary: string;
  textMuted: string;
}) {
  return (
    <div className={`p-2 rounded-md ${cardBg}`}>
      <div className={`text-xs font-medium ${textPrimary}`}>{value}</div>
      <div className={`text-[10px] ${textMuted}`}>{label}</div>
    </div>
  );
}

function timeSince(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
