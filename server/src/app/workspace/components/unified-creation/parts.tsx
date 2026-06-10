'use client';

/**
 * §30 B3.1 — UnifiedCreationModal internal parts.
 *
 * Co-located leaf components (mode toggle, step dots, footer button,
 * placeholder slots) split out of UnifiedCreationModal.tsx to keep the
 * main shell file focused on layout + state plumbing.
 *
 * None of these are exported from the package barrel — they're internal
 * to the unified-creation directory. B3.2-B3.5 may import them directly
 * if they need to render variants (e.g. SimpleModeFlow rendering the
 * step indicator inline for offline preview).
 */

import { useMemo, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { motion, type Transition } from 'framer-motion';

import { radius } from '../../lib/design';
import type { CreationMode } from '../../lib/mutations';

// ───────────────────────── Mode toggle ─────────────────────────

export function ModeToggle({
  mode,
  onChange,
  isDark,
  transition,
}: {
  mode: CreationMode;
  onChange: (next: CreationMode) => void;
  isDark: boolean;
  transition: Transition;
}) {
  const items = useMemo<Array<{ key: CreationMode; label: string }>>(
    () => [
      { key: 'simple', label: 'Simple' },
      { key: 'pro', label: 'Pro' },
    ],
    [],
  );

  return (
    <div
      role="tablist"
      aria-label="Creation mode"
      data-testid="unified-creation-mode-toggle"
      className={`relative inline-flex items-center gap-1 ${radius.chip} border p-1 ${
        isDark ? 'border-white/[0.06] bg-zinc-950/40' : 'border-zinc-200 bg-zinc-50'
      }`}
    >
      {items.map((item) => {
        const active = mode === item.key;
        return (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={active}
            data-testid={`unified-creation-mode-${item.key}`}
            onClick={() => onChange(item.key)}
            className={`relative z-10 inline-flex items-center px-3 py-1 text-xs font-semibold transition-colors ${
              active
                ? isDark
                  ? 'text-zinc-100'
                  : 'text-zinc-900'
                : isDark
                  ? 'text-zinc-400 hover:text-zinc-200'
                  : 'text-zinc-500 hover:text-zinc-700'
            }`}
          >
            {active ? (
              <motion.span
                layoutId="mode-indicator"
                transition={transition}
                className={`absolute inset-0 ${radius.chip} ${isDark ? 'bg-white/[0.08]' : 'bg-white shadow-sm'}`}
                aria-hidden
              />
            ) : null}
            <span className="relative">{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ───────────────────────── Step indicator dots ─────────────────────────

export const STEP_LABELS: readonly string[] = ['Industry', 'Team', 'Upload', 'Launch'];

export function StepDots({
  active,
  isDark,
  transition,
}: {
  active: 0 | 1 | 2 | 3;
  isDark: boolean;
  transition: Transition;
}) {
  return (
    <ol role="list" className="flex items-center gap-2">
      {STEP_LABELS.map((label, idx) => {
        const isActive = idx === active;
        return (
          <li key={label} aria-current={isActive ? 'step' : undefined} className="flex items-center gap-2">
            <motion.span
              animate={{ scale: isActive ? 1 : 0.7 }}
              transition={transition}
              className={`inline-block h-2 w-2 rounded-full border ${
                isActive
                  ? isDark
                    ? 'bg-violet-400 border-violet-300'
                    : 'bg-violet-500 border-violet-400'
                  : isDark
                    ? 'bg-transparent border-zinc-600'
                    : 'bg-transparent border-zinc-400'
              }`}
              aria-hidden
            />
            <span className={isActive ? (isDark ? 'font-semibold text-zinc-200' : 'font-semibold text-zinc-800') : ''}>
              {label}
            </span>
            {idx < STEP_LABELS.length - 1 ? (
              <span aria-hidden className="opacity-40">
                ·
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

// ───────────────────────── Footer button ─────────────────────────

export function FooterButton({
  isDark,
  variant,
  onClick,
  children,
  ...rest
}: {
  isDark: boolean;
  variant: 'primary' | 'ghost';
  onClick: () => void;
  children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  if (variant === 'primary') {
    return (
      <button
        type="button"
        onClick={onClick}
        className={`inline-flex items-center px-4 py-2 text-sm font-semibold transition-colors ${radius.button} ${
          isDark ? 'bg-violet-500/90 text-white hover:bg-violet-400' : 'bg-violet-600 text-white hover:bg-violet-500'
        }`}
        {...rest}
      >
        {children}
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center px-3 py-2 text-sm font-medium transition-colors ${radius.button} ${
        isDark ? 'text-zinc-300 hover:bg-white/[0.06]' : 'text-zinc-600 hover:bg-zinc-100'
      }`}
      {...rest}
    >
      {children}
    </button>
  );
}

// ───────────────────────── Placeholder slots ─────────────────────────
// These exist ONLY so the shell renders visibly before B3.2-B3.5 fill in
// the real flow content. Delete or replace when the real components land.

export function SimplePlaceholder({
  isDark,
  step,
  workspaceId,
}: {
  isDark: boolean;
  step: 0 | 1 | 2 | 3;
  workspaceId: string;
}) {
  return (
    <div
      className={`flex h-full min-h-[300px] flex-col items-center justify-center text-center text-sm ${
        isDark ? 'text-zinc-400' : 'text-zinc-500'
      }`}
      data-testid="unified-creation-simple-placeholder"
    >
      <p className="mb-2 text-base font-semibold">
        Simple mode · Step {step + 1} of {STEP_LABELS.length} — {STEP_LABELS[step]}
      </p>
      <p className="max-w-md text-xs opacity-80">
        Placeholder for B3.2 (industry/size picker) → B3.3 (team review) → B3.4 (provisioning loader). Workspace{' '}
        <span className="font-mono">{workspaceId.slice(0, 8)}…</span> wired via props.
      </p>
    </div>
  );
}

export function ProPlaceholder({
  isDark,
  workspaceId,
  agentsCount,
  profilesCount,
}: {
  isDark: boolean;
  workspaceId: string;
  agentsCount: number;
  profilesCount: number;
}) {
  return (
    <div
      className={`flex h-full min-h-[300px] flex-col items-center justify-center text-center text-sm ${
        isDark ? 'text-zinc-400' : 'text-zinc-500'
      }`}
      data-testid="unified-creation-pro-placeholder"
    >
      <p className="mb-2 text-base font-semibold">Pro mode — coming in B3.5</p>
      <p className="max-w-md text-xs opacity-80">
        Placeholder for the 5-tile picker (Workspace / Device / Agent / Conversation / Task). Workspace{' '}
        <span className="font-mono">{workspaceId.slice(0, 8)}…</span>, {agentsCount} agents, {profilesCount} profiles
        wired via props.
      </p>
    </div>
  );
}
