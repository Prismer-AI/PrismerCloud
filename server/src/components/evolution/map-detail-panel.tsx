'use client';

/**
 * Evolution Map — Detail Panel (v0.6 Glassmorphic Drawer)
 *
 * Right-side drawer showing human-readable information about
 * signals, genes, and edges. Uses glassmorphism styling with
 * useful, non-raw-data presentation.
 */

import { useState } from 'react';
import Link from 'next/link';
import type { DetailTarget } from './types/evolution-map.types';
import { SIGNAL_CATEGORY_COLORS, GENE_CATEGORY_COLORS, confidenceToColor } from './canvas/renderer/colors';
import { X, ArrowRight, AlertTriangle, Download, GitFork, Check, Loader2 } from 'lucide-react';

interface Props {
  target: DetailTarget;
  onClose: () => void;
  isDark: boolean;
}

export function MapDetailPanel({ target, onClose, isDark }: Props) {
  if (!target) return null;

  const glass = isDark
    ? 'backdrop-blur-2xl bg-zinc-950/60 border border-white/[0.08]'
    : 'backdrop-blur-2xl bg-white/60 border border-white/40';

  return (
    <div
      className={`w-80 max-h-full overflow-y-auto rounded-2xl ${glass} shadow-2xl`}
      style={{ scrollbarWidth: 'none' }}
    >
      {/* Close button */}
      <button
        onClick={onClose}
        className={`absolute top-3 right-3 z-10 p-1.5 rounded-lg transition-colors ${
          isDark ? 'hover:bg-white/10 text-zinc-400' : 'hover:bg-black/10 text-zinc-500'
        }`}
      >
        <X size={16} />
      </button>

      <div className="p-5 space-y-5">
        {target.type === 'signal' && <SignalDetail target={target} isDark={isDark} />}
        {target.type === 'gene' && <GeneDetail target={target} isDark={isDark} />}
        {target.type === 'edge' && <EdgeDetail target={target} isDark={isDark} />}
      </div>
    </div>
  );
}

// ─── Gene Detail ────────────────────────────────────────────────────

function GeneDetail({
  target,
  isDark,
}: {
  target: Extract<NonNullable<DetailTarget>, { type: 'gene' }>;
  isDark: boolean;
}) {
  const { data, connectedSignals, connectedEdges } = target;
  const catColor = GENE_CATEGORY_COLORS[data.category] || '#71717a';
  const textPrimary = isDark ? 'text-zinc-100' : 'text-zinc-900';
  const textMuted = isDark ? 'text-zinc-500' : 'text-zinc-400';
  const cardBg = isDark ? 'bg-white/[0.04] border border-white/[0.06]' : 'bg-black/[0.03] border border-black/[0.04]';

  return (
    <>
      {/* Header: colored dot + title + category label */}
      <div className="pr-8">
        <div className="flex items-center gap-2.5 mb-1">
          <div
            className="w-3 h-3 rounded-full shrink-0"
            style={{ backgroundColor: catColor, boxShadow: `0 0 8px ${catColor}60` }}
          />
          <h3 className={`text-base font-bold leading-tight ${textPrimary}`}>{data.title}</h3>
        </div>
        <span className={`text-[11px] uppercase tracking-wider ${textMuted}`}>{data.category}</span>
      </div>

      {/* Success rate: full-width progress bar */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <span className={`text-xs font-medium ${isDark ? 'text-zinc-300' : 'text-zinc-600'}`}>Success Rate</span>
          <span className={`text-sm font-mono font-bold ${textPrimary}`}>{Math.round(data.successRate * 100)}%</span>
        </div>
        <div className={`h-1.5 rounded-full ${isDark ? 'bg-white/[0.08]' : 'bg-black/[0.06]'}`}>
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{
              width: `${data.successRate * 100}%`,
              background: `linear-gradient(90deg, ${confidenceToColor(data.successRate)}cc, ${confidenceToColor(data.successRate)})`,
            }}
          />
        </div>
      </div>

      {/* Stats grid: 2x2 glassmorphic cards */}
      <div className="grid grid-cols-2 gap-2">
        <div className={`p-3 rounded-lg ${cardBg}`}>
          <div className={`text-sm font-bold font-mono ${textPrimary}`}>{data.totalExecutions}</div>
          <div className={`text-[10px] mt-0.5 ${textMuted}`}>Executions</div>
        </div>
        <div className={`p-3 rounded-lg ${cardBg}`}>
          <div className={`text-sm font-bold font-mono ${textPrimary}`}>{data.agentCount}</div>
          <div className={`text-[10px] mt-0.5 ${textMuted}`}>Agents</div>
        </div>
        <div className={`p-3 rounded-lg ${cardBg}`}>
          <div className={`text-sm font-bold font-mono ${textPrimary}`}>{data.pqi}</div>
          <div className={`text-[10px] mt-0.5 ${textMuted}`}>PQI Score</div>
        </div>
        <div className={`p-3 rounded-lg ${cardBg}`}>
          <div className={`text-sm font-bold ${textPrimary}`} style={{ color: catColor }}>
            {data.category}
          </div>
          <div className={`text-[10px] mt-0.5 ${textMuted}`}>Category</div>
        </div>
      </div>

      {/* Beta Confidence Interval — PRD §7.2 natural language narrative */}
      {data.totalExecutions >= 5 && (
        <div className={`p-3 rounded-lg text-xs leading-relaxed ${cardBg} ${textMuted}`}>
          {(() => {
            const n = data.totalExecutions;
            const p = data.successRate;
            const se = Math.sqrt((p * (1 - p)) / Math.max(n, 1));
            const lo = Math.max(0, p - 1.96 * se);
            const hi = Math.min(1, p + 1.96 * se);
            return `Based on ${n} runs, the true success rate is likely between ${Math.round(lo * 100)}% and ${Math.round(hi * 100)}% (95% confidence).`;
          })()}
        </div>
      )}

      {/* Strategy section — render actual steps if available */}
      <div>
        <h4
          className={`text-[11px] font-semibold uppercase tracking-wide mb-2 ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}
        >
          Strategy
        </h4>
        <div className={`p-3 rounded-lg ${cardBg}`}>
          {data.strategySteps && data.strategySteps.length > 0 ? (
            <ol className="space-y-1.5 list-decimal list-inside">
              {data.strategySteps.map((step, i) => (
                <li key={i} className={`text-xs leading-relaxed ${isDark ? 'text-zinc-300' : 'text-zinc-600'}`}>
                  {step}
                </li>
              ))}
            </ol>
          ) : (
            <p className={`text-xs leading-relaxed ${textMuted}`}>No strategy steps available yet</p>
          )}
        </div>
      </div>

      {/* Recent Activity: connected edges as signal -> outcome */}
      <div>
        <h4
          className={`text-[11px] font-semibold uppercase tracking-wide mb-2 ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}
        >
          Recent Activity
        </h4>
        {connectedEdges.length > 0 ? (
          <div className="space-y-1.5">
            {connectedEdges.slice(0, 5).map((edge) => {
              const signal = connectedSignals.find((s) => s.key === edge.signalKey);
              const signalLabel = signal ? signal.key : edge.signalKey;
              const status = edge.isExploring ? 'exploring' : 'established';
              return (
                <div
                  key={`${edge.signalKey}-${edge.geneId}`}
                  className={`flex items-center gap-2 p-2 rounded-md ${cardBg}`}
                >
                  <span
                    className={`text-[10px] font-mono truncate flex-1 ${isDark ? 'text-zinc-300' : 'text-zinc-600'}`}
                  >
                    {signalLabel}
                  </span>
                  <span
                    className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium ${
                      status === 'established' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-amber-500/10 text-amber-400'
                    }`}
                  >
                    {status}
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <p className={`text-xs ${textMuted}`}>No activity recorded yet</p>
        )}
      </div>

      {/* Action buttons — connected to real API */}
      <GeneActions geneId={data.id} isDark={isDark} />
    </>
  );
}

function GeneActions({ geneId, isDark }: { geneId: string; isDark: boolean }) {
  const [importState, setImportState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [forkState, setForkState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const getToken = (): string | null => {
    try {
      return JSON.parse(localStorage.getItem('prismer_auth') || '{}')?.token;
    } catch {
      return null;
    }
  };

  const callApi = async (endpoint: string, body: Record<string, unknown>) => {
    const token = getToken();
    if (!token) throw new Error('Please sign in first');
    const res = await fetch(`/api/im/evolution/genes/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || 'Failed');
    return json.data;
  };

  const [showAuthPrompt, setShowAuthPrompt] = useState(false);

  const requireAuth = (): boolean => {
    if (getToken()) return true;
    setShowAuthPrompt(true);
    return false;
  };

  const handleImport = async () => {
    if (importState !== 'idle') return;
    if (!requireAuth()) return;
    setImportState('loading');
    try {
      await callApi('import', { gene_id: geneId });
      setImportState('done');
    } catch (err: unknown) {
      setErrorMsg((err as Error).message || 'Failed');
      setImportState('error');
      setTimeout(() => {
        setImportState('idle');
        setErrorMsg('');
      }, 3000);
    }
  };

  const handleFork = async () => {
    if (forkState !== 'idle') return;
    if (!requireAuth()) return;
    setForkState('loading');
    try {
      await callApi('fork', { gene_id: geneId });
      setForkState('done');
    } catch (err: unknown) {
      setErrorMsg((err as Error).message || 'Failed');
      setForkState('error');
      setTimeout(() => {
        setForkState('idle');
        setErrorMsg('');
      }, 3000);
    }
  };

  const btnBase =
    'flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors';

  if (showAuthPrompt) {
    return (
      <div
        className={`flex flex-col items-center gap-2 pt-1 pb-1 px-2 rounded-lg text-center ${isDark ? 'bg-white/[0.04]' : 'bg-black/[0.02]'}`}
      >
        <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>Sign in to install or fork genes</p>
        <div className="flex gap-2">
          <Link
            href="/auth"
            className="px-4 py-1.5 rounded-lg text-xs font-medium bg-violet-600 text-white hover:bg-violet-500 transition-colors"
          >
            Sign In
          </Link>
          <button
            onClick={() => setShowAuthPrompt(false)}
            className={`px-3 py-1.5 rounded-lg text-xs ${isDark ? 'text-zinc-500 hover:text-zinc-300' : 'text-zinc-400 hover:text-zinc-600'} transition-colors`}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-2 pt-1">
      <button
        onClick={handleImport}
        className={`${btnBase} ${
          importState === 'done'
            ? 'bg-emerald-600 text-white'
            : importState === 'error'
              ? 'bg-red-600/80 text-white'
              : 'bg-violet-600 text-white hover:bg-violet-500'
        }`}
      >
        {importState === 'loading' ? (
          <Loader2 size={12} className="animate-spin" />
        ) : importState === 'done' ? (
          <Check size={12} />
        ) : (
          <Download size={12} />
        )}
        {importState === 'done' ? 'Installed' : importState === 'error' ? 'Failed' : 'Install'}
      </button>
      <button
        onClick={handleFork}
        className={`${btnBase} ${
          forkState === 'done'
            ? 'bg-emerald-600 text-white'
            : forkState === 'error'
              ? 'bg-red-600/80 text-white'
              : isDark
                ? 'border border-white/[0.1] text-zinc-300 hover:bg-white/[0.08]'
                : 'border border-black/[0.1] text-zinc-600 hover:bg-black/[0.04]'
        }`}
      >
        {forkState === 'loading' ? (
          <Loader2 size={12} className="animate-spin" />
        ) : forkState === 'done' ? (
          <Check size={12} />
        ) : (
          <GitFork size={12} />
        )}
        {forkState === 'done' ? 'Forked' : forkState === 'error' ? 'Failed' : 'Fork'}
      </button>
      {errorMsg && <p className="w-full text-[10px] text-red-400 text-center">{errorMsg}</p>}
    </div>
  );
}

// ─── Signal Detail ──────────────────────────────────────────────────

function SignalDetail({
  target,
  isDark,
}: {
  target: Extract<NonNullable<DetailTarget>, { type: 'signal' }>;
  isDark: boolean;
}) {
  const { data, connectedGenes, connectedEdges } = target;
  const catColor = SIGNAL_CATEGORY_COLORS[data.category] || '#71717a';
  const textPrimary = isDark ? 'text-zinc-100' : 'text-zinc-900';
  const textMuted = isDark ? 'text-zinc-500' : 'text-zinc-400';
  const cardBg = isDark ? 'bg-white/[0.04] border border-white/[0.06]' : 'bg-black/[0.03] border border-black/[0.04]';

  return (
    <>
      {/* Header: colored dot + signal key (monospace) */}
      <div className="flex items-center gap-2.5 pr-8">
        <div
          className="w-3 h-3 rounded-full shrink-0"
          style={{ backgroundColor: catColor, boxShadow: `0 0 8px ${catColor}60` }}
        />
        <span className={`text-sm font-mono font-semibold ${textPrimary}`}>{data.key}</span>
      </div>

      {/* Stats line */}
      <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>
        Triggered <span className={`font-mono font-bold ${textPrimary}`}>{data.frequency}</span> times
        {data.lastSeen && <> &middot; Last seen: {timeSince(data.lastSeen)}</>}
      </p>

      {/* Connected Strategies */}
      <div>
        <h4
          className={`text-[11px] font-semibold uppercase tracking-wide mb-2 ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}
        >
          Connected Strategies
        </h4>
        {connectedGenes.length > 0 ? (
          <div className="space-y-2">
            {connectedGenes.map((g) => {
              const edge = connectedEdges.find((e) => e.geneId === g.id);
              const sr = Math.round(g.successRate * 100);
              return (
                <div key={g.id} className={`p-2.5 rounded-lg ${cardBg}`}>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className={`text-xs font-medium truncate ${textPrimary}`}>{g.title}</span>
                    {edge && (
                      <span
                        className="text-[10px] font-mono font-bold"
                        style={{ color: confidenceToColor(edge.confidence) }}
                      >
                        {Math.round(edge.confidence * 100)}%
                      </span>
                    )}
                  </div>
                  {/* Mini success bar */}
                  <div className={`h-1 rounded-full ${isDark ? 'bg-white/[0.08]' : 'bg-black/[0.06]'}`}>
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${sr}%`,
                        backgroundColor: confidenceToColor(g.successRate),
                      }}
                    />
                  </div>
                  <div className={`text-[10px] mt-1 ${textMuted}`}>
                    {g.totalExecutions} runs &middot; {sr}% success
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className={`text-xs ${textMuted}`}>No strategies connected yet</p>
        )}
      </div>
    </>
  );
}

// ─── Edge Detail ────────────────────────────────────────────────────

function EdgeDetail({
  target,
  isDark,
}: {
  target: Extract<NonNullable<DetailTarget>, { type: 'edge' }>;
  isDark: boolean;
}) {
  const { data, signal: _signal, gene } = target;
  const color = confidenceToColor(data.confidence);
  const textPrimary = isDark ? 'text-zinc-100' : 'text-zinc-900';
  const textMuted = isDark ? 'text-zinc-500' : 'text-zinc-400';
  const cardBg = isDark ? 'bg-white/[0.04] border border-white/[0.06]' : 'bg-black/[0.03] border border-black/[0.04]';
  const bimodality = data.bimodalityIndex ?? 0;

  return (
    <>
      {/* Header: signal -> gene */}
      <div className="flex items-center gap-2 pr-8 flex-wrap">
        <span className={`text-xs font-mono font-semibold ${textPrimary}`}>{data.signalKey}</span>
        <ArrowRight size={12} className={textMuted} />
        <span className={`text-xs font-medium ${textPrimary}`}>{gene.title || data.geneId}</span>
      </div>

      {/* Path Confidence */}
      <div className={`p-4 rounded-lg text-center ${cardBg}`}>
        <div className="text-2xl font-bold font-mono" style={{ color }}>
          {Math.round(data.confidence * 100)}%
        </div>
        <div className={`text-[11px] mt-1 ${textMuted}`}>Path Confidence</div>
      </div>

      {/* Tested count */}
      <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>
        Tested <span className={`font-mono font-bold ${textPrimary}`}>{data.totalObs}</span> times
      </p>

      {/* Bimodality warning */}
      {bimodality > 0.3 && (
        <div
          className={`flex items-start gap-2 p-3 rounded-lg ${
            isDark ? 'bg-amber-500/[0.08] border border-amber-500/[0.15]' : 'bg-amber-50 border border-amber-200'
          }`}
        >
          <AlertTriangle size={14} className="text-amber-500 shrink-0 mt-0.5" />
          <p className={`text-xs leading-relaxed ${isDark ? 'text-amber-300' : 'text-amber-700'}`}>
            High variance — results on this path vary significantly
          </p>
        </div>
      )}

      {/* Status badge */}
      <div className="flex items-center gap-2">
        <span
          className={`text-[11px] px-2.5 py-1 rounded-full font-medium ${
            data.isExploring
              ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
              : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
          }`}
        >
          {data.isExploring ? 'Exploring' : 'Established'}
        </span>
        <span className={`text-[10px] ${textMuted}`}>
          {data.isExploring ? '< 10 observations' : `${data.totalObs} observations`}
        </span>
      </div>
    </>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────

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
