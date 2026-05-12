'use client';

/**
 * §30 B3.5 — Shared parts for Pro mode sub-panels.
 *
 * Three sub-panel files (Device / Agent / Conversation / Profile) each
 * carry the same header + footer + input/label styling. Co-locating
 * those primitives here keeps each ProTile*.tsx under the 250-line
 * budget without splitting their state logic into separate files.
 */

import type { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';

import { radius } from '../../../lib/design';

// ───────────────────────── Style strings ─────────────────────────

export function inputClass(isDark: boolean): string {
  return `w-full border px-3 py-1.5 text-sm outline-none focus:ring-2 ${radius.button} ${
    isDark
      ? 'bg-zinc-950/50 border-white/[0.08] text-zinc-100 placeholder:text-zinc-500 focus:ring-violet-500/35'
      : 'bg-white/75 border-zinc-200 text-zinc-900 placeholder:text-zinc-400 focus:ring-violet-400/40'
  }`;
}

export function labelClass(isDark: boolean): string {
  return `text-xs font-medium ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`;
}

// ───────────────────────── PanelHeader ─────────────────────────

export function PanelHeader({ isDark, title, subtitle }: { isDark: boolean; title: string; subtitle?: ReactNode }) {
  return (
    <header>
      <h3 className={`text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>{title}</h3>
      {subtitle ? <p className={`mt-0.5 text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>{subtitle}</p> : null}
    </header>
  );
}

// ───────────────────────── PanelFooter ─────────────────────────

export interface PanelFooterProps {
  isDark: boolean;
  submitting: boolean;
  canSubmit: boolean;
  onBack: () => void;
  onSubmit: () => void;
  backLabel?: string;
  submitLabel: string;
  testIdBack?: string;
  testIdSubmit?: string;
}

export function PanelFooter({
  isDark,
  submitting,
  canSubmit,
  onBack,
  onSubmit,
  backLabel = 'Cancel',
  submitLabel,
  testIdBack,
  testIdSubmit,
}: PanelFooterProps) {
  return (
    <footer className="mt-1 flex items-center justify-between gap-2">
      <button
        type="button"
        onClick={onBack}
        disabled={submitting}
        data-testid={testIdBack}
        className={`inline-flex items-center px-3 py-1.5 text-xs font-medium ${radius.button} ${
          isDark ? 'text-zinc-300 hover:bg-white/[0.06]' : 'text-zinc-600 hover:bg-zinc-100'
        } disabled:cursor-not-allowed disabled:opacity-50`}
      >
        {backLabel}
      </button>
      <button
        type="button"
        onClick={onSubmit}
        disabled={!canSubmit}
        data-testid={testIdSubmit}
        className={`inline-flex items-center px-4 py-1.5 text-xs font-semibold ${radius.button} ${
          isDark ? 'bg-violet-500/90 text-white hover:bg-violet-400' : 'bg-violet-600 text-white hover:bg-violet-500'
        } disabled:cursor-not-allowed disabled:opacity-50`}
      >
        {submitting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
        {submitLabel}
      </button>
    </footer>
  );
}
