'use client';

import { useState, useCallback } from 'react';
import { Loader2, Plus, Trash2, ChevronDown, ChevronRight, Dna } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { SignalInput } from './signal-input';
import { glass } from './helpers';

const CATEGORIES = [
  { key: 'repair', label: 'Repair', description: 'Fix errors and failures', icon: '\u{1F527}' },
  { key: 'optimize', label: 'Optimize', description: 'Improve performance', icon: '\u26A1' },
  { key: 'innovate', label: 'Innovate', description: 'New approaches', icon: '\u{1F4A1}' },
  { key: 'diagnostic', label: 'Diagnostic', description: 'Detect and analyze', icon: '\u{1F50D}' },
] as const;

// Extend CAT_COLORS for diagnostic (not in helpers.ts)
const CATEGORY_STYLE: Record<string, { text: string; bg: string; border: string; ring: string }> = {
  repair: {
    text: 'text-orange-400',
    bg: 'bg-orange-500/10',
    border: 'border-orange-500/20',
    ring: 'ring-orange-500/40',
  },
  optimize: {
    text: 'text-cyan-400',
    bg: 'bg-cyan-500/10',
    border: 'border-cyan-500/20',
    ring: 'ring-cyan-500/40',
  },
  innovate: {
    text: 'text-violet-400',
    bg: 'bg-violet-500/10',
    border: 'border-violet-500/20',
    ring: 'ring-violet-500/40',
  },
  diagnostic: {
    text: 'text-amber-400',
    bg: 'bg-amber-500/10',
    border: 'border-amber-500/20',
    ring: 'ring-amber-500/40',
  },
};

interface GeneCreateSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isDark: boolean;
  onCreated?: (gene: Record<string, unknown>) => void;
}

export function GeneCreateSheet({ open, onOpenChange, isDark, onCreated }: GeneCreateSheetProps) {
  // Form state
  const [category, setCategory] = useState<string>('repair');
  const [title, setTitle] = useState('');
  const [signals, setSignals] = useState<Array<{ type: string; provider?: string }>>([]);
  const [strategySteps, setStrategySteps] = useState<string[]>(['']);
  const [preconditions, setPreconditions] = useState<string[]>([]);
  const [constraints, setConstraints] = useState<string[]>([]);

  // UI state
  const [showPreconditions, setShowPreconditions] = useState(false);
  const [showConstraints, setShowConstraints] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const resetForm = useCallback(() => {
    setCategory('repair');
    setTitle('');
    setSignals([]);
    setStrategySteps(['']);
    setPreconditions([]);
    setConstraints([]);
    setShowPreconditions(false);
    setShowConstraints(false);
    setError(null);
    setSuccessMessage(null);
  }, []);

  const handleClose = useCallback(
    (openState: boolean) => {
      if (!openState) {
        resetForm();
      }
      onOpenChange(openState);
    },
    [onOpenChange, resetForm],
  );

  // Strategy step handlers
  const updateStep = useCallback((index: number, value: string) => {
    setStrategySteps((prev) => prev.map((s, i) => (i === index ? value : s)));
  }, []);

  const removeStep = useCallback((index: number) => {
    setStrategySteps((prev) => {
      if (prev.length <= 1) return [''];
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const addStep = useCallback(() => {
    setStrategySteps((prev) => [...prev, '']);
  }, []);

  // Precondition handlers
  const updatePrecondition = useCallback((index: number, value: string) => {
    setPreconditions((prev) => prev.map((s, i) => (i === index ? value : s)));
  }, []);

  const removePrecondition = useCallback((index: number) => {
    setPreconditions((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const addPrecondition = useCallback(() => {
    setPreconditions((prev) => [...prev, '']);
  }, []);

  // Constraint handlers
  const updateConstraint = useCallback((index: number, value: string) => {
    setConstraints((prev) => prev.map((s, i) => (i === index ? value : s)));
  }, []);

  const removeConstraint = useCallback((index: number) => {
    setConstraints((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const addConstraint = useCallback(() => {
    setConstraints((prev) => [...prev, '']);
  }, []);

  // Validation
  const isValid = title.trim().length > 0 && signals.length > 0 && strategySteps.some((s) => s.trim().length > 0);

  // Submit
  const handleSubmit = useCallback(async () => {
    if (!isValid || loading) return;
    setLoading(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const token = (() => {
        try {
          return JSON.parse(localStorage.getItem('prismer_auth') || '{}')?.token;
        } catch {
          return null;
        }
      })();

      if (!token) {
        setError('Not authenticated. Please sign in first.');
        setLoading(false);
        return;
      }

      const body: Record<string, unknown> = {
        category,
        title: title.trim(),
        signals_match: signals,
        strategy: strategySteps.filter((s) => s.trim()),
      };

      const filteredPreconditions = preconditions.filter((s) => s.trim());
      if (filteredPreconditions.length > 0) {
        body.preconditions = filteredPreconditions;
      }

      const filteredConstraints = constraints.filter((s) => s.trim());
      if (filteredConstraints.length > 0) {
        body.constraints = filteredConstraints;
      }

      const res = await fetch('/api/im/evolution/genes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });

      const data = await res.json();

      if (!res.ok || data.ok === false) {
        setError(data.error?.message || data.error || data.message || `Failed to create gene (${res.status})`);
        return;
      }

      setSuccessMessage('Gene created successfully!');

      // Notify parent and close after a brief delay
      if (onCreated) {
        onCreated(data.data || data);
      }

      setTimeout(() => {
        handleClose(false);
      }, 600);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [isValid, loading, category, title, signals, strategySteps, preconditions, constraints, onCreated, handleClose]);

  const inputClasses = `w-full bg-transparent outline-none text-sm py-2 px-3 rounded-lg transition-colors ${
    isDark
      ? 'text-zinc-200 placeholder:text-zinc-600 border border-zinc-700 focus:border-violet-500'
      : 'text-zinc-800 placeholder:text-zinc-400 border border-zinc-300 focus:border-violet-500'
  }`;

  const labelClasses = `text-xs font-semibold uppercase tracking-wider mb-2 block ${
    isDark ? 'text-zinc-400' : 'text-zinc-600'
  }`;

  return (
    <Sheet open={open} onOpenChange={handleClose}>
      <SheetContent
        side="right"
        className={`sm:max-w-lg w-full overflow-y-auto ${
          isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-zinc-200'
        }`}
        showCloseButton
      >
        <SheetHeader className="pb-2">
          <SheetTitle className={`flex items-center gap-2 text-lg ${isDark ? 'text-white' : 'text-zinc-900'}`}>
            <Dna className="w-5 h-5 text-violet-400" />
            Create Gene
          </SheetTitle>
          <SheetDescription className={isDark ? 'text-zinc-500' : 'text-zinc-500'}>
            Define a new evolution gene with trigger signals and a repair strategy.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 px-4 space-y-6 pb-4">
          {/* Category Selector */}
          <div>
            <label className={labelClasses}>Category</label>
            <div className="grid grid-cols-2 gap-2">
              {CATEGORIES.map((cat) => {
                const style = CATEGORY_STYLE[cat.key];
                const selected = category === cat.key;
                return (
                  <button
                    key={cat.key}
                    type="button"
                    onClick={() => setCategory(cat.key)}
                    className={`flex items-center gap-2 px-3 py-2.5 rounded-lg text-left text-sm transition-all ${
                      selected
                        ? `${style.bg} ${style.border} border ring-1 ${style.ring}`
                        : isDark
                          ? 'bg-zinc-900/40 border border-zinc-800 hover:border-zinc-700'
                          : 'bg-zinc-50 border border-zinc-200 hover:border-zinc-300'
                    }`}
                  >
                    <span className="text-base">{cat.icon}</span>
                    <div>
                      <div
                        className={`font-medium text-sm ${
                          selected ? style.text : isDark ? 'text-zinc-300' : 'text-zinc-700'
                        }`}
                      >
                        {cat.label}
                      </div>
                      <div className={`text-[10px] ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                        {cat.description}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Title */}
          <div>
            <label className={labelClasses}>Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. HTTP Timeout Recovery"
              className={inputClasses}
              maxLength={120}
            />
            {title.length > 0 && (
              <p className={`text-[10px] mt-1 text-right ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                {title.length}/120
              </p>
            )}
          </div>

          {/* Signals */}
          <div>
            <label className={labelClasses}>
              Signals
              <span className={`font-normal ml-1 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                (what triggers this gene)
              </span>
            </label>
            <SignalInput value={signals} onChange={setSignals} isDark={isDark} />
          </div>

          {/* Strategy Steps */}
          <div>
            <label className={labelClasses}>Strategy Steps</label>
            <div className="space-y-2">
              {strategySteps.map((step, i) => (
                <div key={i} className="flex items-start gap-2">
                  <span
                    className={`shrink-0 w-6 h-8 flex items-center justify-center text-xs font-bold tabular-nums ${
                      isDark ? 'text-zinc-600' : 'text-zinc-400'
                    }`}
                  >
                    {i + 1}.
                  </span>
                  <input
                    type="text"
                    value={step}
                    onChange={(e) => updateStep(i, e.target.value)}
                    placeholder={`Step ${i + 1}...`}
                    className={`flex-1 ${inputClasses}`}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addStep();
                      }
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => removeStep(i)}
                    className={`shrink-0 p-2 rounded-md transition-colors ${
                      isDark
                        ? 'text-zinc-600 hover:text-red-400 hover:bg-red-500/10'
                        : 'text-zinc-400 hover:text-red-500 hover:bg-red-50'
                    }`}
                    aria-label={`Remove step ${i + 1}`}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={addStep}
              className={`flex items-center gap-1.5 mt-2 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                isDark ? 'text-violet-400 hover:bg-violet-500/10' : 'text-violet-600 hover:bg-violet-50'
              }`}
            >
              <Plus className="w-3.5 h-3.5" />
              Add Step
            </button>
          </div>

          {/* Collapsible: Preconditions */}
          <div>
            <button
              type="button"
              onClick={() => {
                setShowPreconditions((prev) => !prev);
                if (!showPreconditions && preconditions.length === 0) {
                  addPrecondition();
                }
              }}
              className={`flex items-center gap-2 text-xs font-semibold uppercase tracking-wider transition-colors ${
                isDark ? 'text-zinc-400 hover:text-zinc-300' : 'text-zinc-600 hover:text-zinc-700'
              }`}
            >
              {showPreconditions ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              Preconditions
              <span className={`font-normal ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>(optional)</span>
            </button>

            {showPreconditions && (
              <div className="mt-2 space-y-2">
                {preconditions.map((pc, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      type="text"
                      value={pc}
                      onChange={(e) => updatePrecondition(i, e.target.value)}
                      placeholder="e.g. Service must be reachable"
                      className={`flex-1 ${inputClasses}`}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          addPrecondition();
                        }
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => removePrecondition(i)}
                      className={`shrink-0 p-2 rounded-md transition-colors ${
                        isDark
                          ? 'text-zinc-600 hover:text-red-400 hover:bg-red-500/10'
                          : 'text-zinc-400 hover:text-red-500 hover:bg-red-50'
                      }`}
                      aria-label={`Remove precondition ${i + 1}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={addPrecondition}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                    isDark ? 'text-violet-400 hover:bg-violet-500/10' : 'text-violet-600 hover:bg-violet-50'
                  }`}
                >
                  <Plus className="w-3.5 h-3.5" />
                  Add Precondition
                </button>
              </div>
            )}
          </div>

          {/* Collapsible: Constraints */}
          <div>
            <button
              type="button"
              onClick={() => {
                setShowConstraints((prev) => !prev);
                if (!showConstraints && constraints.length === 0) {
                  addConstraint();
                }
              }}
              className={`flex items-center gap-2 text-xs font-semibold uppercase tracking-wider transition-colors ${
                isDark ? 'text-zinc-400 hover:text-zinc-300' : 'text-zinc-600 hover:text-zinc-700'
              }`}
            >
              {showConstraints ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              Constraints
              <span className={`font-normal ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>(optional)</span>
            </button>

            {showConstraints && (
              <div className="mt-2 space-y-2">
                {constraints.map((ct, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      type="text"
                      value={ct}
                      onChange={(e) => updateConstraint(i, e.target.value)}
                      placeholder="e.g. Max retry count: 5"
                      className={`flex-1 ${inputClasses}`}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          addConstraint();
                        }
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => removeConstraint(i)}
                      className={`shrink-0 p-2 rounded-md transition-colors ${
                        isDark
                          ? 'text-zinc-600 hover:text-red-400 hover:bg-red-500/10'
                          : 'text-zinc-400 hover:text-red-500 hover:bg-red-50'
                      }`}
                      aria-label={`Remove constraint ${i + 1}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={addConstraint}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                    isDark ? 'text-violet-400 hover:bg-violet-500/10' : 'text-violet-600 hover:bg-violet-50'
                  }`}
                >
                  <Plus className="w-3.5 h-3.5" />
                  Add Constraint
                </button>
              </div>
            )}
          </div>

          {/* Error message */}
          {error && (
            <div className="px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
              {error}
            </div>
          )}

          {/* Success message */}
          {successMessage && (
            <div className="px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-sm">
              {successMessage}
            </div>
          )}
        </div>

        {/* Footer buttons */}
        <SheetFooter className={`flex-row gap-3 border-t ${isDark ? 'border-zinc-800' : 'border-zinc-200'}`}>
          <Button
            variant="ghost"
            onClick={() => handleClose(false)}
            disabled={loading}
            className={`flex-1 ${isDark ? 'text-zinc-400 hover:text-zinc-200' : ''}`}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!isValid || loading}
            className={`flex-1 gap-2 ${isValid && !loading ? 'bg-violet-600 hover:bg-violet-500 text-white' : ''}`}
          >
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Creating...
              </>
            ) : (
              <>
                <Dna className="w-4 h-4" />
                Create Gene
              </>
            )}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
