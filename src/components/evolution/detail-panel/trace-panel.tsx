'use client';

/**
 * Trace Panel — Evolution event traceability viewer
 *
 * Shows the full pipeline for a single evolution event:
 * 1. Raw Input (error/log/context)
 * 2. Extracted Signals (LLM or regex)
 * 3. Gene Match (Thompson Sampling alternatives)
 * 4. Outcome (success/failed + score)
 *
 * Appears as a floating glass panel on the right side of the Map.
 */

import { X } from 'lucide-react';

interface TraceData {
  capsuleId: string;
  agentName: string;
  timestamp: string;
  // Step 1: Raw Input
  rawContextPreview?: string;
  // Step 2: Extraction
  extractionMethod?: string; // "llm" | "regex" | "cached" | "regex_fallback"
  extractedSignals?: Array<{ type: string; provider?: string; stage?: string; severity?: string }>;
  rootCause?: string;
  // Step 3: Gene Match
  geneId?: string;
  geneTitle?: string;
  geneCategory?: string;
  geneAlternatives?: Array<{ id: string; title?: string; score: number }>;
  matchConfidence?: number;
  // Step 4: Outcome
  outcome: 'success' | 'failed';
  score?: number;
  summary?: string;
}

interface Props {
  trace: TraceData;
  isDark: boolean;
  onClose: () => void;
}

const glass = (isDark: boolean) =>
  isDark
    ? 'backdrop-blur-xl bg-zinc-900/90 border border-white/[0.08]'
    : 'backdrop-blur-xl bg-white/90 border border-zinc-200/60';

const stepGlass = (isDark: boolean) =>
  isDark
    ? 'bg-white/[0.04] border border-white/[0.06] rounded-lg'
    : 'bg-zinc-50/80 border border-zinc-200/40 rounded-lg';

export function TracePanel({ trace, isDark, onClose }: Props) {
  const steps = [
    { label: '1. Raw Input', available: !!trace.rawContextPreview },
    { label: '2. Extracted Signals', available: !!trace.extractedSignals?.length },
    { label: '3. Gene Match', available: !!trace.geneId },
    { label: '4. Outcome', available: true },
  ];

  return (
    <div className={`w-[340px] h-full overflow-y-auto p-4 ${glass(isDark)} rounded-2xl shadow-2xl`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className={`text-sm font-bold ${isDark ? 'text-white' : 'text-zinc-900'}`}>Trace Detail</h3>
          <p className={`text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
            {trace.agentName} &bull; {new Date(trace.timestamp).toLocaleTimeString()}
          </p>
        </div>
        <button
          onClick={onClose}
          className={`p-1 rounded-lg transition-colors ${isDark ? 'text-zinc-500 hover:text-white hover:bg-white/10' : 'text-zinc-400 hover:text-zinc-900 hover:bg-zinc-100'}`}
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Pipeline steps */}
      <div className="space-y-3">
        {/* Step 1: Raw Input */}
        {trace.rawContextPreview && (
          <div className={stepGlass(isDark)}>
            <div
              className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}
            >
              1. Raw Input
            </div>
            <div
              className={`px-3 pb-3 text-[11px] font-mono leading-relaxed break-all ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}
            >
              {trace.rawContextPreview}
            </div>
          </div>
        )}

        {/* Arrow */}
        {trace.rawContextPreview && trace.extractedSignals?.length && (
          <div className="flex items-center justify-center">
            <span className={`text-[10px] ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
              &darr; {trace.extractionMethod || 'extraction'}
              {trace.extractionMethod === 'llm' ? '' : ''}
            </span>
          </div>
        )}

        {/* Step 2: Extracted Signals */}
        {trace.extractedSignals && trace.extractedSignals.length > 0 && (
          <div className={stepGlass(isDark)}>
            <div
              className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider flex items-center justify-between ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}
            >
              <span>2. Extracted Signals</span>
              {trace.extractionMethod && (
                <span
                  className={`text-[9px] px-1.5 py-0.5 rounded ${
                    trace.extractionMethod === 'llm'
                      ? isDark
                        ? 'bg-violet-500/15 text-violet-300'
                        : 'bg-violet-100 text-violet-600'
                      : trace.extractionMethod === 'cached'
                        ? isDark
                          ? 'bg-cyan-500/15 text-cyan-300'
                          : 'bg-cyan-100 text-cyan-600'
                        : isDark
                          ? 'bg-zinc-700 text-zinc-400'
                          : 'bg-zinc-200 text-zinc-500'
                  }`}
                >
                  {trace.extractionMethod}
                </span>
              )}
            </div>
            <div className="px-3 pb-3 space-y-1">
              {trace.extractedSignals.map((s, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span
                    className={`text-[11px] font-mono ${
                      s.type.startsWith('error:')
                        ? 'text-red-400'
                        : s.type.startsWith('task.')
                          ? 'text-blue-400'
                          : s.type.startsWith('infra:')
                            ? 'text-orange-400'
                            : 'text-zinc-400'
                    }`}
                  >
                    {s.type}
                  </span>
                  {s.severity && (
                    <span
                      className={`text-[9px] px-1 py-0.5 rounded ${
                        s.severity === 'critical'
                          ? 'bg-red-500/15 text-red-300'
                          : s.severity === 'high'
                            ? 'bg-orange-500/15 text-orange-300'
                            : 'bg-zinc-700/50 text-zinc-400'
                      }`}
                    >
                      {s.severity}
                    </span>
                  )}
                </div>
              ))}
              {trace.rootCause && (
                <p className={`mt-1.5 text-[10px] italic ${isDark ? 'text-amber-400/80' : 'text-amber-600/80'}`}>
                  Root cause: {trace.rootCause}
                </p>
              )}
            </div>
          </div>
        )}

        {/* Arrow */}
        {trace.extractedSignals?.length && trace.geneId && (
          <div className="flex items-center justify-center">
            <span className={`text-[10px] ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
              &darr; Thompson Sampling
            </span>
          </div>
        )}

        {/* Step 3: Gene Match */}
        {trace.geneId && (
          <div className={stepGlass(isDark)}>
            <div
              className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}
            >
              3. Gene Match
            </div>
            <div className="px-3 pb-3 space-y-1.5">
              {/* Top match */}
              <div className="flex items-center gap-2">
                <span className="text-amber-400 text-[11px]">&#9733;</span>
                <span className={`text-[11px] font-bold ${isDark ? 'text-white' : 'text-zinc-900'}`}>
                  {trace.geneTitle || trace.geneId}
                </span>
                {trace.matchConfidence != null && (
                  <span className={`text-[10px] font-mono ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>
                    {Math.round(trace.matchConfidence * 100)}%
                  </span>
                )}
              </div>
              {/* Alternatives */}
              {trace.geneAlternatives?.slice(1, 4).map((alt, i) => (
                <div key={i} className={`flex items-center gap-2 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                  <span className="text-[11px] w-3">&nbsp;</span>
                  <span className="text-[11px]">{alt.title || alt.id}</span>
                  <span className="text-[10px] font-mono">{Math.round(alt.score * 100)}%</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Arrow */}
        {trace.geneId && (
          <div className="flex items-center justify-center">
            <span className={`text-[10px] ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>&darr; Executed</span>
          </div>
        )}

        {/* Step 4: Outcome */}
        <div className={stepGlass(isDark)}>
          <div
            className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}
          >
            4. Outcome
          </div>
          <div className="px-3 pb-3">
            <div className="flex items-center gap-2">
              <span
                className={`text-sm font-bold ${trace.outcome === 'success' ? 'text-emerald-400' : 'text-red-400'}`}
              >
                {trace.outcome === 'success' ? '\u2705' : '\u274C'} {trace.outcome === 'success' ? 'Success' : 'Failed'}
              </span>
              {trace.score != null && (
                <span className={`text-[11px] font-mono ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>
                  score: {Math.round(trace.score * 100)}%
                </span>
              )}
            </div>
            {trace.summary && (
              <p className={`mt-1 text-[11px] ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>{trace.summary}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
