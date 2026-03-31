'use client';

import { useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { CheckCircle2, XCircle, Clock, ChevronDown, ChevronRight, Dna, Coins } from 'lucide-react';
import { glass, timeAgo } from './helpers';

/* ─── Types ──────────────────────────────────────────── */

interface CapsuleDetailDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  capsule: Record<string, unknown> | null;
  isDark: boolean;
}

/* ─── Component ──────────────────────────────────────── */

export function CapsuleDetailDrawer({ open, onOpenChange, capsule, isDark }: CapsuleDetailDrawerProps) {
  const [showMetadata, setShowMetadata] = useState(false);

  if (!capsule) return null;

  const outcome = String(capsule.outcome || '');
  const isSuccess = outcome === 'success';
  const score = capsule.score != null ? Number(capsule.score) : null;
  const geneId = String(capsule.geneId || capsule.gene_id || '');
  const geneTitle = String(capsule.geneTitle || capsule.gene_title || geneId || 'Unknown Gene');
  const summary = String(capsule.summary || '');
  const ts = String(capsule.created_at || capsule.createdAt || capsule.timestamp || '');
  const costCredits = capsule.cost_credits != null ? Number(capsule.cost_credits) : null;

  // Extract signals from various possible shapes
  const rawSignals: unknown[] = (capsule.signals as unknown[]) || (capsule.signal ? [capsule.signal] : []);
  const signals: string[] = rawSignals
    .map((s) => (typeof s === 'string' ? s : ((s as Record<string, unknown>)?.type as string) || ''))
    .filter(Boolean);

  // Build metadata object (everything else)
  const metadataKeys = new Set([
    'outcome',
    'score',
    'geneId',
    'gene_id',
    'geneTitle',
    'gene_title',
    'summary',
    'created_at',
    'createdAt',
    'timestamp',
    'cost_credits',
    'signals',
    'signal',
    'id',
  ]);
  const metadata: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(capsule)) {
    if (!metadataKeys.has(k) && v != null) {
      metadata[k] = v;
    }
  }
  const hasMetadata = Object.keys(metadata).length > 0;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className={`w-full sm:max-w-md flex flex-col ${
          isDark ? 'bg-zinc-950 border-zinc-800 text-white' : 'bg-white border-zinc-200 text-zinc-900'
        }`}
      >
        {/* Header */}
        <SheetHeader className="px-6 pt-6 pb-0">
          <SheetTitle className={`text-lg font-bold ${isDark ? 'text-white' : 'text-zinc-900'}`}>
            Execution Detail
          </SheetTitle>
          <SheetDescription className="sr-only">Detailed view of a capsule execution result</SheetDescription>
        </SheetHeader>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 pb-6 space-y-4">
          {/* Outcome Badge + Score + Time */}
          <div className={`rounded-xl p-4 ${glass(isDark)}`}>
            <div className="flex items-center gap-3">
              <span
                className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${
                  isSuccess ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'
                }`}
              >
                {isSuccess ? <CheckCircle2 className="w-5 h-5" /> : <XCircle className="w-5 h-5" />}
              </span>
              <div className="flex-1 min-w-0">
                <Badge
                  variant="outline"
                  className={`text-xs ${
                    isSuccess
                      ? isDark
                        ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                        : 'bg-emerald-50 text-emerald-600 border-emerald-200'
                      : isDark
                        ? 'bg-red-500/10 text-red-400 border-red-500/20'
                        : 'bg-red-50 text-red-600 border-red-200'
                  }`}
                >
                  {isSuccess ? 'Success' : 'Failed'}
                </Badge>
                {ts && (
                  <p className={`text-xs mt-1 flex items-center gap-1 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                    <Clock className="w-3 h-3" />
                    {timeAgo(ts)}
                  </p>
                )}
              </div>
              {score != null && (
                <div className="text-right">
                  <p className={`text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>Score</p>
                  <p
                    className={`text-lg font-bold tabular-nums ${
                      score >= 0.7 ? 'text-emerald-400' : score >= 0.4 ? 'text-amber-400' : 'text-red-400'
                    }`}
                  >
                    {Math.round(score * 100)}%
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Gene Reference */}
          <div className={`rounded-xl p-4 ${glass(isDark)}`}>
            <h4
              className={`text-xs font-semibold uppercase tracking-wider mb-2 ${
                isDark ? 'text-zinc-500' : 'text-zinc-400'
              }`}
            >
              Gene
            </h4>
            <div className="flex items-center gap-2">
              <Dna className={`w-4 h-4 shrink-0 text-violet-400`} />
              <div className="flex-1 min-w-0">
                <p className={`text-sm font-medium truncate ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
                  {geneTitle}
                </p>
                {geneId && geneId !== geneTitle && (
                  <p className={`text-[10px] font-mono truncate ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                    {geneId}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Signals */}
          {signals.length > 0 && (
            <div className={`rounded-xl p-4 ${glass(isDark)}`}>
              <h4
                className={`text-xs font-semibold uppercase tracking-wider mb-2 ${
                  isDark ? 'text-zinc-500' : 'text-zinc-400'
                }`}
              >
                Signals
              </h4>
              <div className="flex flex-wrap gap-1.5">
                {signals.map((s) => (
                  <Badge
                    key={s}
                    variant="outline"
                    className={`text-[11px] ${
                      isDark
                        ? 'bg-zinc-800/60 text-zinc-300 border-zinc-700'
                        : 'bg-zinc-100 text-zinc-700 border-zinc-200'
                    }`}
                  >
                    {s}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Summary */}
          {summary && (
            <div className={`rounded-xl p-4 ${glass(isDark)}`}>
              <h4
                className={`text-xs font-semibold uppercase tracking-wider mb-2 ${
                  isDark ? 'text-zinc-500' : 'text-zinc-400'
                }`}
              >
                Summary
              </h4>
              <p className={`text-sm leading-relaxed ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>{summary}</p>
            </div>
          )}

          {/* Cost Credits */}
          {costCredits != null && (
            <div className={`rounded-xl p-4 ${glass(isDark)}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Coins className={`w-4 h-4 ${isDark ? 'text-amber-400' : 'text-amber-500'}`} />
                  <span
                    className={`text-xs font-semibold uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}
                  >
                    Cost
                  </span>
                </div>
                <span className={`text-sm font-bold tabular-nums ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>
                  {costCredits} credits
                </span>
              </div>
            </div>
          )}

          {/* Metadata (collapsible) */}
          {hasMetadata && (
            <div className={`rounded-xl overflow-hidden ${glass(isDark)}`}>
              <button
                type="button"
                onClick={() => setShowMetadata((prev) => !prev)}
                className={`w-full flex items-center justify-between px-4 py-3 text-left transition-colors ${
                  isDark ? 'hover:bg-white/[0.02]' : 'hover:bg-black/[0.02]'
                }`}
              >
                <span
                  className={`text-xs font-semibold uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}
                >
                  Metadata
                </span>
                {showMetadata ? (
                  <ChevronDown className={`w-4 h-4 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`} />
                ) : (
                  <ChevronRight className={`w-4 h-4 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`} />
                )}
              </button>
              {showMetadata && (
                <div className={`px-4 pb-4 border-t ${isDark ? 'border-white/5' : 'border-zinc-200/50'}`}>
                  <pre
                    className={`text-xs font-mono mt-3 overflow-x-auto whitespace-pre-wrap break-all leading-relaxed ${
                      isDark ? 'text-zinc-400' : 'text-zinc-600'
                    }`}
                  >
                    {JSON.stringify(metadata, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
