'use client';

/**
 * Evolution Map — Detail Panel (v0.7 Enhanced Drawer)
 *
 * Right-side drawer with collapsible sections, richer metadata,
 * and glassmorphism styling. Each entity type (gene/signal/edge)
 * shows an overview at the top and expandable detail sections below.
 */

import { useState } from 'react';
import Link from 'next/link';
import type { DetailTarget, EdgePath, GeneNode, SignalNode } from './types/evolution-map.types';
import { SIGNAL_CATEGORY_COLORS, GENE_CATEGORY_COLORS, confidenceToColor } from './canvas/renderer/colors';
import {
  X,
  ArrowRight,
  AlertTriangle,
  Download,
  GitFork,
  Check,
  Loader2,
  ChevronDown,
  Zap,
  BarChart3,
  Layers,
  Info,
  Link2,
} from 'lucide-react';

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
    <div className={`w-full h-full flex flex-col rounded-2xl ${glass}`}>
      {/* Fixed header with close button */}
      <div className="flex justify-end shrink-0 px-3 pt-3 pb-1">
        <button
          onClick={onClose}
          className={`p-1.5 rounded-lg transition-colors ${
            isDark ? 'hover:bg-white/10 text-zinc-400' : 'hover:bg-black/10 text-zinc-500'
          }`}
        >
          <X size={16} />
        </button>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto px-5 pb-5 space-y-4" style={{ scrollbarWidth: 'thin' }}>
        {target.type === 'signal' && <SignalDetail target={target} isDark={isDark} />}
        {target.type === 'gene' && <GeneDetail target={target} isDark={isDark} />}
        {target.type === 'edge' && <EdgeDetail target={target} isDark={isDark} />}
      </div>
    </div>
  );
}

// ─── Collapsible Section ─────────────────────────────────────────────

function Section({
  title,
  icon,
  isDark,
  defaultOpen = false,
  badge,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  isDark: boolean;
  defaultOpen?: boolean;
  badge?: string | number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className={`w-full flex items-center gap-2 py-1.5 text-left transition-colors ${
          isDark ? 'hover:bg-white/[0.04]' : 'hover:bg-black/[0.02]'
        } rounded-md -mx-1 px-1`}
      >
        <span className={isDark ? 'text-zinc-500' : 'text-zinc-400'}>{icon}</span>
        <span
          className={`text-[11px] font-semibold uppercase tracking-wide flex-1 ${
            isDark ? 'text-zinc-400' : 'text-zinc-500'
          }`}
        >
          {title}
        </span>
        {badge !== undefined && (
          <span
            className={`text-[9px] font-mono px-1.5 py-0.5 rounded-full ${
              isDark ? 'bg-white/[0.08] text-zinc-400' : 'bg-black/[0.06] text-zinc-500'
            }`}
          >
            {badge}
          </span>
        )}
        <ChevronDown
          size={12}
          className={`transition-transform duration-200 ${open ? 'rotate-180' : ''} ${
            isDark ? 'text-zinc-600' : 'text-zinc-400'
          }`}
        />
      </button>
      {open && <div className="mt-2 space-y-2">{children}</div>}
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

  // Compute derived metrics
  const successCount = Math.round(data.totalExecutions * data.successRate);
  const failCount = data.totalExecutions - successCount;
  const establishedEdges = connectedEdges.filter((e) => !e.isExploring);
  const exploringEdges = connectedEdges.filter((e) => e.isExploring);

  return (
    <>
      {/* Header: colored dot + title + category label */}
      <div>
        <div className="flex items-center gap-2.5 mb-1">
          <div
            className="w-3 h-3 rounded-full shrink-0"
            style={{ backgroundColor: catColor, boxShadow: `0 0 8px ${catColor}60` }}
          />
          <h3 className={`text-base font-bold leading-tight ${textPrimary}`}>{data.title}</h3>
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className={`text-[11px] uppercase tracking-wider ${textMuted}`}>{data.category}</span>
          <span
            className={`text-[9px] px-1.5 py-0.5 rounded-full font-mono ${
              isDark ? 'bg-white/[0.06] text-zinc-500' : 'bg-black/[0.04] text-zinc-400'
            }`}
          >
            {data.id.slice(0, 8)}
          </span>
        </div>
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
        <div className={`flex justify-between mt-1 text-[10px] ${textMuted}`}>
          <span>{successCount} passed</span>
          <span>{failCount} failed</span>
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

      {/* Beta Confidence Interval */}
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

      {/* ─── Expandable: Strategy ─── */}
      <Section
        title="Strategy"
        icon={<Layers size={12} />}
        isDark={isDark}
        defaultOpen={!!(data.strategySteps && data.strategySteps.length > 0)}
        badge={data.strategySteps?.length ?? 0}
      >
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
      </Section>

      {/* ─── Expandable: Signal Connections ─── */}
      <Section
        title="Signal Connections"
        icon={<Link2 size={12} />}
        isDark={isDark}
        defaultOpen={connectedEdges.length > 0 && connectedEdges.length <= 8}
        badge={connectedEdges.length}
      >
        {connectedEdges.length > 0 ? (
          <div className="space-y-1.5">
            {/* Established paths */}
            {establishedEdges.length > 0 && (
              <div>
                <div className={`text-[9px] uppercase tracking-wider mb-1 ${textMuted}`}>
                  Established ({establishedEdges.length})
                </div>
                {establishedEdges.map((edge) => (
                  <EdgeRow
                    key={`${edge.signalKey}-${edge.geneId}`}
                    edge={edge}
                    connectedSignals={connectedSignals}
                    isDark={isDark}
                    cardBg={cardBg}
                  />
                ))}
              </div>
            )}
            {/* Exploring paths */}
            {exploringEdges.length > 0 && (
              <div>
                <div className={`text-[9px] uppercase tracking-wider mb-1 mt-2 ${textMuted}`}>
                  Exploring ({exploringEdges.length})
                </div>
                {exploringEdges.map((edge) => (
                  <EdgeRow
                    key={`${edge.signalKey}-${edge.geneId}`}
                    edge={edge}
                    connectedSignals={connectedSignals}
                    isDark={isDark}
                    cardBg={cardBg}
                  />
                ))}
              </div>
            )}
          </div>
        ) : (
          <p className={`text-xs ${textMuted}`}>No signal connections yet</p>
        )}
      </Section>

      {/* ─── Expandable: Advanced Stats ─── */}
      <Section title="Advanced" icon={<BarChart3 size={12} />} isDark={isDark}>
        <div className={`p-3 rounded-lg space-y-2 ${cardBg}`}>
          <StatRow label="Gene ID" value={data.id} mono isDark={isDark} />
          {data.communityId !== undefined && (
            <StatRow label="Community" value={`#${data.communityId}`} isDark={isDark} />
          )}
          {data.communityMembership !== undefined && (
            <StatRow label="Membership" value={`${Math.round(data.communityMembership * 100)}%`} isDark={isDark} />
          )}
          <StatRow
            label="Established Paths"
            value={`${establishedEdges.length} / ${connectedEdges.length}`}
            isDark={isDark}
          />
          {connectedEdges.length > 0 && (
            <StatRow
              label="Avg Confidence"
              value={`${Math.round(
                (connectedEdges.reduce((sum, e) => sum + e.confidence, 0) / connectedEdges.length) * 100,
              )}%`}
              isDark={isDark}
            />
          )}
          {connectedEdges.some((e) => (e.bimodalityIndex ?? 0) > 0.3) && (
            <StatRow
              label="Bimodal Paths"
              value={`${connectedEdges.filter((e) => (e.bimodalityIndex ?? 0) > 0.3).length}`}
              warn
              isDark={isDark}
            />
          )}
        </div>
      </Section>

      {/* Action buttons */}
      <GeneActions geneId={data.id} isDark={isDark} />
    </>
  );
}

/** Single edge row for gene detail */
function EdgeRow({
  edge,
  connectedSignals,
  isDark,
  cardBg,
}: {
  edge: EdgePath;
  connectedSignals: SignalNode[];
  isDark: boolean;
  cardBg: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const signal = connectedSignals.find((s) => s.key === edge.signalKey);
  const signalLabel = signal ? signal.key : edge.signalKey;

  return (
    <div className={`rounded-md ${cardBg} overflow-hidden`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className={`w-full flex items-center gap-2 p-2 text-left ${
          isDark ? 'hover:bg-white/[0.03]' : 'hover:bg-black/[0.02]'
        }`}
      >
        <span className={`text-[10px] font-mono truncate flex-1 ${isDark ? 'text-zinc-300' : 'text-zinc-600'}`}>
          {signalLabel}
        </span>
        <span className="text-[9px] font-mono font-bold" style={{ color: confidenceToColor(edge.confidence) }}>
          {Math.round(edge.confidence * 100)}%
        </span>
        <ChevronDown
          size={10}
          className={`transition-transform duration-200 ${expanded ? 'rotate-180' : ''} ${
            isDark ? 'text-zinc-600' : 'text-zinc-400'
          }`}
        />
      </button>
      {expanded && (
        <div className={`px-2 pb-2 space-y-1 text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
          <div className="flex justify-between">
            <span>Observations</span>
            <span className="font-mono">{edge.totalObs}</span>
          </div>
          <div className="flex justify-between">
            <span>Alpha / Beta</span>
            <span className="font-mono">
              {edge.alpha.toFixed(1)} / {edge.beta.toFixed(1)}
            </span>
          </div>
          {edge.routingWeight !== undefined && (
            <div className="flex justify-between">
              <span>Routing Weight</span>
              <span className="font-mono">{(edge.routingWeight * 100).toFixed(1)}%</span>
            </div>
          )}
          {edge.coverageLevel !== undefined && (
            <div className="flex justify-between">
              <span>Coverage</span>
              <span className="font-mono">
                {['Coarse', 'Medium', 'Fine'][edge.coverageLevel] ?? edge.coverageLevel}
              </span>
            </div>
          )}
          {(edge.bimodalityIndex ?? 0) > 0 && (
            <div className="flex justify-between">
              <span>Bimodality</span>
              <span className={`font-mono ${(edge.bimodalityIndex ?? 0) > 0.3 ? 'text-amber-400' : ''}`}>
                {((edge.bimodalityIndex ?? 0) * 100).toFixed(0)}%
              </span>
            </div>
          )}
          {edge.taskSuccessRate !== undefined && (
            <div className="flex justify-between">
              <span>Task Success</span>
              <span className="font-mono">{Math.round(edge.taskSuccessRate * 100)}%</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Stat row for advanced section */
function StatRow({
  label,
  value,
  mono,
  warn,
  isDark,
}: {
  label: string;
  value: string;
  mono?: boolean;
  warn?: boolean;
  isDark: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className={`text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>{label}</span>
      <span
        className={`text-[10px] ${mono ? 'font-mono' : ''} ${
          warn ? 'text-amber-400' : isDark ? 'text-zinc-300' : 'text-zinc-600'
        }`}
      >
        {value}
      </span>
    </div>
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

  // Compute derived metrics
  const avgConfidence =
    connectedEdges.length > 0 ? connectedEdges.reduce((s, e) => s + e.confidence, 0) / connectedEdges.length : 0;

  return (
    <>
      {/* Header: colored dot + signal key (monospace) */}
      <div>
        <div className="flex items-center gap-2.5 mb-1">
          <div
            className="w-3 h-3 rounded-full shrink-0"
            style={{ backgroundColor: catColor, boxShadow: `0 0 8px ${catColor}60` }}
          />
          <span className={`text-sm font-mono font-semibold break-all ${textPrimary}`}>{data.key}</span>
        </div>
        <span className={`text-[11px] uppercase tracking-wider ${textMuted}`}>{data.category}</span>
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-3 gap-2">
        <div className={`p-2.5 rounded-lg text-center ${cardBg}`}>
          <div className={`text-sm font-bold font-mono ${textPrimary}`}>{data.frequency}</div>
          <div className={`text-[9px] mt-0.5 ${textMuted}`}>Triggers</div>
        </div>
        <div className={`p-2.5 rounded-lg text-center ${cardBg}`}>
          <div className={`text-sm font-bold font-mono ${textPrimary}`}>{connectedGenes.length}</div>
          <div className={`text-[9px] mt-0.5 ${textMuted}`}>Genes</div>
        </div>
        <div className={`p-2.5 rounded-lg text-center ${cardBg}`}>
          <div className={`text-sm font-bold font-mono ${textPrimary}`}>{Math.round(avgConfidence * 100)}%</div>
          <div className={`text-[9px] mt-0.5 ${textMuted}`}>Avg Conf</div>
        </div>
      </div>

      {data.lastSeen && <p className={`text-[10px] ${textMuted}`}>Last seen: {timeSince(data.lastSeen)}</p>}

      {/* Connected Strategies — expandable */}
      <Section
        title="Connected Strategies"
        icon={<Zap size={12} />}
        isDark={isDark}
        defaultOpen={connectedGenes.length > 0 && connectedGenes.length <= 6}
        badge={connectedGenes.length}
      >
        {connectedGenes.length > 0 ? (
          <div className="space-y-2">
            {connectedGenes.map((g) => (
              <GeneCard
                key={g.id}
                gene={g}
                edge={connectedEdges.find((e) => e.geneId === g.id)}
                isDark={isDark}
                cardBg={cardBg}
                textPrimary={textPrimary}
                textMuted={textMuted}
              />
            ))}
          </div>
        ) : (
          <p className={`text-xs ${textMuted}`}>No strategies connected yet</p>
        )}
      </Section>

      {/* Advanced */}
      <Section title="Advanced" icon={<BarChart3 size={12} />} isDark={isDark}>
        <div className={`p-3 rounded-lg space-y-2 ${cardBg}`}>
          <StatRow label="Signal Key" value={data.key} mono isDark={isDark} />
          <StatRow label="Category" value={data.category} isDark={isDark} />
          <StatRow label="Frequency (30d)" value={String(data.frequency)} mono isDark={isDark} />
          {data.lastSeen && (
            <StatRow label="Last Seen" value={new Date(data.lastSeen).toLocaleString()} isDark={isDark} />
          )}
          <StatRow label="Connected Genes" value={String(connectedGenes.length)} mono isDark={isDark} />
          <StatRow
            label="Established Paths"
            value={String(connectedEdges.filter((e) => !e.isExploring).length)}
            mono
            isDark={isDark}
          />
          <StatRow
            label="Exploring Paths"
            value={String(connectedEdges.filter((e) => e.isExploring).length)}
            mono
            isDark={isDark}
          />
        </div>
      </Section>
    </>
  );
}

/** Gene mini-card for signal detail */
function GeneCard({
  gene,
  edge,
  isDark,
  cardBg,
  textPrimary,
  textMuted,
}: {
  gene: GeneNode;
  edge?: EdgePath;
  isDark: boolean;
  cardBg: string;
  textPrimary: string;
  textMuted: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const sr = Math.round(gene.successRate * 100);
  const catColor = GENE_CATEGORY_COLORS[gene.category] || '#71717a';

  return (
    <div className={`rounded-lg overflow-hidden ${cardBg}`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className={`w-full p-2.5 text-left ${isDark ? 'hover:bg-white/[0.03]' : 'hover:bg-black/[0.02]'}`}
      >
        <div className="flex items-center justify-between mb-1.5">
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: catColor }} />
            <span className={`text-xs font-medium truncate ${textPrimary}`}>{gene.title}</span>
          </div>
          <div className="flex items-center gap-1.5">
            {edge && (
              <span className="text-[10px] font-mono font-bold" style={{ color: confidenceToColor(edge.confidence) }}>
                {Math.round(edge.confidence * 100)}%
              </span>
            )}
            <ChevronDown
              size={10}
              className={`transition-transform duration-200 ${expanded ? 'rotate-180' : ''} ${
                isDark ? 'text-zinc-600' : 'text-zinc-400'
              }`}
            />
          </div>
        </div>
        {/* Mini success bar */}
        <div className={`h-1 rounded-full ${isDark ? 'bg-white/[0.08]' : 'bg-black/[0.06]'}`}>
          <div
            className="h-full rounded-full"
            style={{ width: `${sr}%`, backgroundColor: confidenceToColor(gene.successRate) }}
          />
        </div>
        <div className={`text-[10px] mt-1 ${textMuted}`}>
          {gene.totalExecutions} runs &middot; {sr}% success
        </div>
      </button>
      {expanded && (
        <div
          className={`px-2.5 pb-2.5 space-y-1.5 text-[10px] border-t ${isDark ? 'border-white/[0.04]' : 'border-black/[0.04]'}`}
        >
          <div className="pt-1.5" />
          <div className={`flex justify-between ${textMuted}`}>
            <span>PQI Score</span>
            <span className="font-mono">{gene.pqi}</span>
          </div>
          <div className={`flex justify-between ${textMuted}`}>
            <span>Agents</span>
            <span className="font-mono">{gene.agentCount}</span>
          </div>
          <div className={`flex justify-between ${textMuted}`}>
            <span>Category</span>
            <span style={{ color: catColor }}>{gene.category}</span>
          </div>
          {edge && (
            <>
              <div className={`flex justify-between ${textMuted}`}>
                <span>Observations</span>
                <span className="font-mono">{edge.totalObs}</span>
              </div>
              <div className={`flex justify-between ${textMuted}`}>
                <span>Alpha / Beta</span>
                <span className="font-mono">
                  {edge.alpha.toFixed(1)} / {edge.beta.toFixed(1)}
                </span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
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
      <div className="flex items-center gap-2 flex-wrap">
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

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-2">
        <div className={`p-2.5 rounded-lg text-center ${cardBg}`}>
          <div className={`text-sm font-bold font-mono ${textPrimary}`}>{data.totalObs}</div>
          <div className={`text-[9px] mt-0.5 ${textMuted}`}>Observations</div>
        </div>
        <div className={`p-2.5 rounded-lg text-center ${cardBg}`}>
          <div className={`text-sm font-bold font-mono ${textPrimary}`}>
            {data.alpha.toFixed(1)} / {data.beta.toFixed(1)}
          </div>
          <div className={`text-[9px] mt-0.5 ${textMuted}`}>Alpha / Beta</div>
        </div>
      </div>

      {/* Bimodality warning */}
      {bimodality > 0.3 && (
        <div
          className={`flex items-start gap-2 p-3 rounded-lg ${
            isDark ? 'bg-amber-500/[0.08] border border-amber-500/[0.15]' : 'bg-amber-50 border border-amber-200'
          }`}
        >
          <AlertTriangle size={14} className="text-amber-500 shrink-0 mt-0.5" />
          <div>
            <p className={`text-xs leading-relaxed ${isDark ? 'text-amber-300' : 'text-amber-700'}`}>
              High variance — results on this path vary significantly
            </p>
            <p className={`text-[10px] mt-0.5 ${isDark ? 'text-amber-400/60' : 'text-amber-600/60'}`}>
              Bimodality index: {(bimodality * 100).toFixed(0)}%
            </p>
          </div>
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

      {/* Expandable: Advanced */}
      <Section title="Advanced" icon={<Info size={12} />} isDark={isDark}>
        <div className={`p-3 rounded-lg space-y-2 ${cardBg}`}>
          <StatRow label="Signal" value={data.signalKey} mono isDark={isDark} />
          <StatRow label="Gene" value={gene.title || data.geneId} isDark={isDark} />
          <StatRow label="Confidence" value={`${Math.round(data.confidence * 100)}%`} isDark={isDark} />
          <StatRow label="Alpha" value={data.alpha.toFixed(2)} mono isDark={isDark} />
          <StatRow label="Beta" value={data.beta.toFixed(2)} mono isDark={isDark} />
          <StatRow label="Observations" value={String(data.totalObs)} mono isDark={isDark} />
          {data.routingWeight !== undefined && (
            <StatRow label="Routing Weight" value={`${(data.routingWeight * 100).toFixed(1)}%`} mono isDark={isDark} />
          )}
          {data.taskSuccessRate !== undefined && (
            <StatRow label="Task Success" value={`${Math.round(data.taskSuccessRate * 100)}%`} mono isDark={isDark} />
          )}
          {data.coverageLevel !== undefined && (
            <StatRow
              label="Coverage"
              value={['Coarse', 'Medium', 'Fine'][data.coverageLevel] ?? String(data.coverageLevel)}
              isDark={isDark}
            />
          )}
          {bimodality > 0 && (
            <StatRow
              label="Bimodality Index"
              value={`${(bimodality * 100).toFixed(0)}%`}
              warn={bimodality > 0.3}
              isDark={isDark}
            />
          )}
        </div>
      </Section>
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
