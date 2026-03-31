'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetFooter, SheetDescription } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { GitFork, Loader2, Plus, X, AlertTriangle } from 'lucide-react';
import { CAT_COLORS, glass } from './helpers';

/* ─── Types ──────────────────────────────────────────── */

interface ParentGene {
  id: string;
  title?: string;
  category: string;
  signals_match?: Array<string | { type: string; provider?: string; stage?: string }>;
  strategy?: { steps?: string[] } | string[];
}

interface GeneForkSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  parentGene: ParentGene | null;
  isDark: boolean;
  onForked?: (gene: Record<string, unknown>) => void;
}

/* ─── Helpers ────────────────────────────────────────── */

function getToken(): string | null {
  try {
    return JSON.parse(localStorage.getItem('prismer_auth') || '{}')?.token ?? null;
  } catch {
    return null;
  }
}

function extractSignals(raw?: Array<string | { type: string; provider?: string; stage?: string }>): string[] {
  if (!raw) return [];
  return raw.map((s) => (typeof s === 'string' ? s : s?.type || '')).filter(Boolean);
}

function extractSteps(strategy?: { steps?: string[] } | string[]): string[] {
  if (Array.isArray(strategy)) return strategy as string[];
  if (strategy && typeof strategy === 'object' && Array.isArray(strategy.steps)) return strategy.steps;
  return [];
}

/* ─── Component ──────────────────────────────────────── */

export function GeneForkSheet({ open, onOpenChange, parentGene, isDark, onForked }: GeneForkSheetProps) {
  const [title, setTitle] = useState('');
  const [signals, setSignals] = useState<string[]>([]);
  const [steps, setSteps] = useState<string[]>([]);
  const [newSignal, setNewSignal] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track original values for diff highlighting
  const origTitleRef = useRef('');
  const origSignalsRef = useRef<string[]>([]);
  const origStepsRef = useRef<string[]>([]);

  // Reset form when parent gene changes
  useEffect(() => {
    if (!open || !parentGene) {
      setTitle('');
      setSignals([]);
      setSteps([]);
      setNewSignal('');
      setError(null);
      return;
    }

    const t = `${parentGene.title || 'Untitled Gene'} (fork)`;
    const s = extractSignals(parentGene.signals_match);
    const st = extractSteps(parentGene.strategy);

    setTitle(t);
    setSignals([...s]);
    setSteps([...st]);

    origTitleRef.current = t;
    origSignalsRef.current = s;
    origStepsRef.current = st;
  }, [open, parentGene]);

  const addSignal = useCallback(() => {
    const tag = newSignal.trim();
    if (!tag || signals.includes(tag)) return;
    setSignals((prev) => [...prev, tag]);
    setNewSignal('');
  }, [newSignal, signals]);

  const removeSignal = useCallback((idx: number) => {
    setSignals((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const updateStep = useCallback((idx: number, value: string) => {
    setSteps((prev) => prev.map((s, i) => (i === idx ? value : s)));
  }, []);

  const addStep = useCallback(() => {
    setSteps((prev) => [...prev, '']);
  }, []);

  const removeStep = useCallback((idx: number) => {
    setSteps((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!parentGene) return;
    if (!title.trim()) {
      setError('Title is required');
      return;
    }
    if (signals.length === 0) {
      setError('At least one signal is required');
      return;
    }
    const filteredSteps = steps.filter((s) => s.trim());
    if (filteredSteps.length === 0) {
      setError('At least one strategy step is required');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const token = getToken();
      const res = await fetch('/api/im/evolution/genes/fork', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          gene_id: parentGene.id,
          modifications: {
            title: title.trim(),
            signals_match: signals.map((s) => ({ type: s })),
            strategy: { steps: filteredSteps },
          },
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || data?.message || `Fork failed (${res.status})`);
      }

      const data = await res.json();
      onForked?.(data.data || data);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Fork failed');
    } finally {
      setSubmitting(false);
    }
  }, [parentGene, title, signals, steps, onForked, onOpenChange]);

  if (!parentGene) return null;

  const cat = CAT_COLORS[parentGene.category] || CAT_COLORS.repair;
  const titleChanged = title !== origTitleRef.current;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className={`w-full sm:max-w-lg flex flex-col ${
          isDark ? 'bg-zinc-950 border-zinc-800 text-white' : 'bg-white border-zinc-200 text-zinc-900'
        }`}
      >
        {/* Header */}
        <SheetHeader className="px-6 pt-6 pb-0">
          <SheetTitle
            className={`text-lg font-bold flex items-center gap-2 ${isDark ? 'text-white' : 'text-zinc-900'}`}
          >
            <GitFork className="w-5 h-5 text-violet-400" />
            Fork Gene
          </SheetTitle>
          <SheetDescription className={isDark ? 'text-zinc-400' : 'text-zinc-500'}>
            Forking from: &ldquo;{parentGene.title || 'Untitled Gene'}&rdquo;
            <Badge className={`ml-2 text-[10px] ${cat.bg} ${cat.text} border ${cat.border}`} variant="outline">
              {parentGene.category}
            </Badge>
          </SheetDescription>
        </SheetHeader>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 pb-4 space-y-5 mt-4">
          {/* Title */}
          <div>
            <label
              className={`text-xs font-semibold uppercase tracking-wider block mb-2 ${
                isDark ? 'text-zinc-500' : 'text-zinc-400'
              }`}
            >
              Title *
            </label>
            <div
              className={`rounded-lg transition-all ${
                titleChanged ? (isDark ? 'bg-violet-500/10' : 'bg-violet-50') : ''
              }`}
            >
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className={`w-full px-3 py-2 rounded-lg border text-sm outline-none transition-colors ${
                  isDark
                    ? 'bg-zinc-900/60 border-zinc-700 text-white placeholder-zinc-600 focus:border-violet-500'
                    : 'bg-white border-zinc-200 text-zinc-900 placeholder-zinc-400 focus:border-violet-400'
                }`}
                placeholder="Gene title"
              />
            </div>
          </div>

          {/* Signals */}
          <div>
            <label
              className={`text-xs font-semibold uppercase tracking-wider block mb-2 ${
                isDark ? 'text-zinc-500' : 'text-zinc-400'
              }`}
            >
              Signals (inherited, editable)
            </label>
            <div className="space-y-2">
              <div className="flex flex-wrap gap-1.5">
                {signals.map((signal, idx) => {
                  const isNew = !origSignalsRef.current.includes(signal);
                  return (
                    <Badge
                      key={`${signal}-${idx}`}
                      variant="outline"
                      className={`text-[11px] pr-1 flex items-center gap-1 transition-all ${
                        isNew
                          ? isDark
                            ? 'bg-violet-500/10 text-violet-300 border-violet-500/30'
                            : 'bg-violet-50 text-violet-600 border-violet-200'
                          : isDark
                            ? 'bg-zinc-800/60 text-zinc-300 border-zinc-700'
                            : 'bg-zinc-100 text-zinc-700 border-zinc-200'
                      }`}
                    >
                      {signal}
                      <button
                        type="button"
                        onClick={() => removeSignal(idx)}
                        className={`ml-0.5 p-0.5 rounded-full hover:bg-red-500/20 transition-colors ${
                          isDark ? 'text-zinc-500 hover:text-red-400' : 'text-zinc-400 hover:text-red-500'
                        }`}
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </Badge>
                  );
                })}
              </div>

              {/* Add signal input */}
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newSignal}
                  onChange={(e) => setNewSignal(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addSignal();
                    }
                  }}
                  placeholder="Add signal (e.g. error:timeout)"
                  className={`flex-1 px-3 py-1.5 rounded-lg border text-sm outline-none transition-colors ${
                    isDark
                      ? 'bg-zinc-900/60 border-zinc-700 text-white placeholder-zinc-600 focus:border-violet-500'
                      : 'bg-white border-zinc-200 text-zinc-900 placeholder-zinc-400 focus:border-violet-400'
                  }`}
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={addSignal}
                  disabled={!newSignal.trim()}
                  className={isDark ? 'border-zinc-700 text-zinc-300 hover:bg-zinc-800' : ''}
                >
                  <Plus className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          </div>

          {/* Strategy Steps */}
          <div>
            <label
              className={`text-xs font-semibold uppercase tracking-wider block mb-2 ${
                isDark ? 'text-zinc-500' : 'text-zinc-400'
              }`}
            >
              Strategy Steps (inherited, editable)
            </label>
            <div className="space-y-2">
              {steps.map((step, idx) => {
                const isChanged = idx >= origStepsRef.current.length || step !== origStepsRef.current[idx];
                return (
                  <div
                    key={idx}
                    className={`flex items-start gap-2 rounded-lg transition-all ${
                      isChanged ? (isDark ? 'bg-violet-500/10' : 'bg-violet-50') : ''
                    }`}
                  >
                    <span
                      className={`shrink-0 w-5 h-5 mt-2 rounded-full flex items-center justify-center text-[10px] font-bold ${
                        isDark ? 'bg-violet-500/15 text-violet-400' : 'bg-violet-100 text-violet-600'
                      }`}
                    >
                      {idx + 1}
                    </span>
                    <input
                      type="text"
                      value={step}
                      onChange={(e) => updateStep(idx, e.target.value)}
                      className={`flex-1 px-3 py-1.5 rounded-lg border text-sm outline-none transition-colors ${
                        isDark
                          ? 'bg-zinc-900/60 border-zinc-700 text-white placeholder-zinc-600 focus:border-violet-500'
                          : 'bg-white border-zinc-200 text-zinc-900 placeholder-zinc-400 focus:border-violet-400'
                      }`}
                      placeholder={`Step ${idx + 1}`}
                    />
                    <button
                      type="button"
                      onClick={() => removeStep(idx)}
                      className={`shrink-0 mt-2 p-1 rounded transition-colors ${
                        isDark
                          ? 'text-zinc-600 hover:text-red-400 hover:bg-red-500/10'
                          : 'text-zinc-400 hover:text-red-500 hover:bg-red-50'
                      }`}
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              })}
              <Button
                variant="outline"
                size="sm"
                onClick={addStep}
                className={`w-full ${
                  isDark
                    ? 'border-zinc-700 text-zinc-400 hover:bg-zinc-800 border-dashed'
                    : 'border-zinc-200 text-zinc-500 hover:bg-zinc-50 border-dashed'
                }`}
              >
                <Plus className="w-3.5 h-3.5 mr-1" />
                Add Step
              </Button>
            </div>
          </div>

          {/* Error */}
          {error && (
            <div className="flex items-start gap-2 text-sm text-red-400 bg-red-500/10 rounded-lg px-3 py-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <SheetFooter className={`px-6 py-4 border-t ${isDark ? 'border-white/5' : 'border-zinc-200/50'}`}>
          <div className="flex items-center gap-2 w-full">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
              className={isDark ? 'border-zinc-700 text-zinc-300 hover:bg-zinc-800' : ''}
            >
              Cancel
            </Button>
            <div className="flex-1" />
            <Button
              size="sm"
              className="bg-violet-600 hover:bg-violet-700 text-white"
              onClick={handleSubmit}
              disabled={submitting}
            >
              {submitting ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />
                  Forking...
                </>
              ) : (
                'Create Fork'
              )}
            </Button>
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
