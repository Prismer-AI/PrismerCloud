'use client';

import { useState, useCallback } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Dna, Loader2, Radio, Globe2 } from 'lucide-react';
import { CAT_COLORS, glass } from './helpers';

/* ─── Types ──────────────────────────────────────────── */

interface GeneInfo {
  id: string;
  title?: string;
  category: string;
  success_count: number;
  failure_count: number;
  signals_match?: Array<string | { type: string; provider?: string; stage?: string }>;
}

interface GenePublishDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  gene: GeneInfo | null;
  isDark: boolean;
  onPublished?: () => void;
}

/* ─── Helpers ────────────────────────────────────────── */

function getToken(): string | null {
  try {
    return JSON.parse(localStorage.getItem('prismer_auth') || '{}')?.token ?? null;
  } catch {
    return null;
  }
}

function getSignalStrings(signals?: Array<string | { type: string; provider?: string; stage?: string }>): string[] {
  if (!signals) return [];
  return signals.map((s) => (typeof s === 'string' ? s : s?.type || '')).filter(Boolean);
}

/* ─── Component ──────────────────────────────────────── */

export function GenePublishDialog({ open, onOpenChange, gene, isDark, onPublished }: GenePublishDialogProps) {
  const [visibility, setVisibility] = useState<'canary' | 'published'>('published');
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handlePublish = useCallback(async () => {
    if (!gene) return;
    setPublishing(true);
    setError(null);

    try {
      const token = getToken();
      const res = await fetch(`/api/im/evolution/genes/${gene.id}/publish`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          skipCanary: visibility === 'published',
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || data?.message || `Failed to publish (${res.status})`);
      }

      onPublished?.();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Publish failed');
    } finally {
      setPublishing(false);
    }
  }, [gene, visibility, onPublished, onOpenChange]);

  if (!gene) return null;

  const totalRuns = gene.success_count + gene.failure_count;
  const successRate = totalRuns > 0 ? Math.round((gene.success_count / totalRuns) * 100) : 0;
  const cat = CAT_COLORS[gene.category] || CAT_COLORS.repair;
  const signals = getSignalStrings(gene.signals_match);

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        className={isDark ? 'bg-zinc-950 border-zinc-800 text-white' : 'bg-white border-zinc-200 text-zinc-900'}
      >
        <AlertDialogHeader>
          <AlertDialogTitle className={`flex items-center gap-2 ${isDark ? 'text-white' : 'text-zinc-900'}`}>
            <Dna className={`w-5 h-5 ${cat.text}`} />
            Publish &ldquo;{gene.title || 'Untitled Gene'}&rdquo;
          </AlertDialogTitle>
          <AlertDialogDescription className={isDark ? 'text-zinc-400' : 'text-zinc-600'}>
            This gene will be visible to all agents on the Prismer network.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {/* Gene stats */}
        <div className={`rounded-lg p-3 space-y-2 ${glass(isDark)}`}>
          <div className="flex items-center justify-between text-sm">
            <span className={isDark ? 'text-zinc-400' : 'text-zinc-500'}>Executions</span>
            <span className={`font-bold tabular-nums ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>{totalRuns}</span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className={isDark ? 'text-zinc-400' : 'text-zinc-500'}>Success Rate</span>
            <span
              className={`font-bold tabular-nums ${
                successRate >= 70 ? 'text-emerald-400' : successRate >= 40 ? 'text-amber-400' : 'text-red-400'
              }`}
            >
              {successRate}%
            </span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className={isDark ? 'text-zinc-400' : 'text-zinc-500'}>Category</span>
            <Badge className={`text-[10px] ${cat.bg} ${cat.text} border ${cat.border}`} variant="outline">
              {gene.category}
            </Badge>
          </div>
          {signals.length > 0 && (
            <div className="flex items-start justify-between text-sm gap-2">
              <span className={`shrink-0 mt-0.5 ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>Signals</span>
              <div className="flex flex-wrap justify-end gap-1">
                {signals.slice(0, 4).map((s) => (
                  <Badge
                    key={s}
                    variant="outline"
                    className={`text-[10px] ${
                      isDark
                        ? 'bg-zinc-800/60 text-zinc-300 border-zinc-700'
                        : 'bg-zinc-100 text-zinc-700 border-zinc-200'
                    }`}
                  >
                    {s}
                  </Badge>
                ))}
                {signals.length > 4 && (
                  <span className={`text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                    +{signals.length - 4} more
                  </span>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Visibility selection */}
        <div className="space-y-2">
          <p className={`text-xs font-semibold uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
            Visibility
          </p>
          <div className="space-y-2">
            <label
              className={`flex items-center gap-3 rounded-lg p-3 cursor-pointer transition-all ${
                visibility === 'canary'
                  ? isDark
                    ? 'bg-violet-500/10 border border-violet-500/20'
                    : 'bg-violet-50 border border-violet-200'
                  : isDark
                    ? 'bg-zinc-900/40 border border-zinc-800 hover:border-zinc-700'
                    : 'bg-zinc-50 border border-zinc-200 hover:border-zinc-300'
              }`}
            >
              <input
                type="radio"
                name="publish-visibility"
                checked={visibility === 'canary'}
                onChange={() => setVisibility('canary')}
                className="sr-only"
              />
              <div
                className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
                  visibility === 'canary' ? 'border-violet-500' : isDark ? 'border-zinc-600' : 'border-zinc-300'
                }`}
              >
                {visibility === 'canary' && <div className="w-2 h-2 rounded-full bg-violet-500" />}
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-1.5">
                  <Radio
                    className={`w-3.5 h-3.5 ${
                      visibility === 'canary' ? 'text-violet-400' : isDark ? 'text-zinc-500' : 'text-zinc-400'
                    }`}
                  />
                  <span className={`text-sm font-medium ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>Canary</span>
                </div>
                <p className={`text-xs mt-0.5 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                  Limited rollout first, then automatic promotion
                </p>
              </div>
            </label>

            <label
              className={`flex items-center gap-3 rounded-lg p-3 cursor-pointer transition-all ${
                visibility === 'published'
                  ? isDark
                    ? 'bg-violet-500/10 border border-violet-500/20'
                    : 'bg-violet-50 border border-violet-200'
                  : isDark
                    ? 'bg-zinc-900/40 border border-zinc-800 hover:border-zinc-700'
                    : 'bg-zinc-50 border border-zinc-200 hover:border-zinc-300'
              }`}
            >
              <input
                type="radio"
                name="publish-visibility"
                checked={visibility === 'published'}
                onChange={() => setVisibility('published')}
                className="sr-only"
              />
              <div
                className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
                  visibility === 'published' ? 'border-violet-500' : isDark ? 'border-zinc-600' : 'border-zinc-300'
                }`}
              >
                {visibility === 'published' && <div className="w-2 h-2 rounded-full bg-violet-500" />}
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-1.5">
                  <Globe2
                    className={`w-3.5 h-3.5 ${
                      visibility === 'published' ? 'text-violet-400' : isDark ? 'text-zinc-500' : 'text-zinc-400'
                    }`}
                  />
                  <span className={`text-sm font-medium ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>Published</span>
                </div>
                <p className={`text-xs mt-0.5 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                  Visible to all agents immediately
                </p>
              </div>
            </label>
          </div>
        </div>

        {/* Error */}
        {error && <p className="text-sm text-red-400 bg-red-500/10 rounded-lg px-3 py-2">{error}</p>}

        <AlertDialogFooter>
          <AlertDialogCancel
            className={isDark ? 'border-zinc-700 text-zinc-300 hover:bg-zinc-800' : ''}
            disabled={publishing}
          >
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            className="bg-violet-600 hover:bg-violet-700 text-white"
            disabled={publishing}
            onClick={(e) => {
              e.preventDefault();
              handlePublish();
            }}
          >
            {publishing ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />
                Publishing...
              </>
            ) : (
              'Publish'
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
