'use client';

/**
 * Evolution Studio v2 — shared "coming soon" section placeholder.
 *
 * Each surface stub renders this until its owning agent fills it in (doc 28
 * §0.2.1 P0 — shell + nav skeleton). Paints the section's spatial-grammar accent
 * so the chromatic "you are in X" signal already works end-to-end (12 §8.8.6.5).
 *
 * Honours dark/light via useTheme() + design.ts surface tokens, useReducedMotion
 * for the breathing ring, and is fully i18n-driven (no bare strings).
 */

import { motion, useReducedMotion } from 'framer-motion';
import type { LucideIcon } from 'lucide-react';

import { grammarAccentClasses, radius, s, springSoft } from '@/app/workspace/lib/design';
import { useI18n } from '@/contexts/i18n-context';
import { useTheme } from '@/contexts/theme-context';
import { cn } from '@/lib/utils';

import { SECTION_GRAMMAR, type StudioSection } from './types';

export interface SectionPlaceholderProps {
  section: StudioSection;
  icon: LucideIcon;
  /** i18n key for the section title (e.g. `evolution.studio.v2.roster.title`). */
  titleKey: `evolution.${string}`;
  /** i18n key for the descriptive hint line. */
  hintKey: `evolution.${string}`;
}

export function SectionPlaceholder({ section, icon: Icon, titleKey, hintKey }: SectionPlaceholderProps) {
  const { t } = useI18n();
  const { resolvedTheme } = useTheme();
  const reduce = useReducedMotion();
  const isDark = resolvedTheme === 'dark';
  const theme = isDark ? 'dark' : 'light';
  const { grammar, accent } = SECTION_GRAMMAR[section];
  const a = grammarAccentClasses[accent];

  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 px-6 py-16 text-center">
      <motion.div
        initial={reduce ? false : { scale: 0.92, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={springSoft}
        className={cn(
          'flex size-20 items-center justify-center border',
          radius.card,
          s(theme, 'card'),
          a.ring,
          'ring-1',
        )}
      >
        <Icon className={cn('size-9', a.text)} aria-hidden />
      </motion.div>
      <div className="space-y-2">
        <h2 className={cn('text-lg font-semibold', isDark ? 'text-zinc-100' : 'text-zinc-900')}>{t(titleKey)}</h2>
        <p className={cn('max-w-md text-sm', isDark ? 'text-zinc-400' : 'text-zinc-600')}>{t(hintKey)}</p>
      </div>
      <span
        className={cn('inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium', a.bg, a.text)}
      >
        <span className={cn('size-1.5 rounded-full', a.dot)} aria-hidden />
        {grammar}
      </span>
    </div>
  );
}
