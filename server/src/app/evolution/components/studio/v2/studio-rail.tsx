'use client';

/**
 * Evolution Studio v2 — left rail (release201/28 §2.2).
 *
 * 8-section nav split into Workspace / Per-agent groups + a violet-gradient
 * "Create skill" CTA + theme toggle. Mirrors the prototype rail and the
 * workspace `left-rail.tsx` grid rhythm. Fully i18n-driven (no bare strings),
 * dark/light via useTheme(), motion via design.ts springs.
 */

import { motion, useReducedMotion } from 'framer-motion';
import {
  Dna,
  History,
  LayoutGrid,
  LayoutTemplate,
  ListOrdered,
  type LucideIcon,
  Moon,
  Plus,
  Sparkles,
  Sun,
  UserCircle,
  Users,
} from 'lucide-react';

import { radius, s, springSnap, springSoft } from '@/app/workspace/lib/design';
import { useI18n } from '@/contexts/i18n-context';
import { useTheme } from '@/contexts/theme-context';
import type { TranslationKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';

import {
  PER_AGENT_SECTIONS,
  WORKSPACE_SECTIONS,
  type StudioSection,
} from './types';

const SECTION_ICON: Record<StudioSection, LucideIcon> = {
  roster: Users,
  create: Sparkles,
  lifecycle: ListOrdered,
  installed: LayoutGrid,
  genes: Dna,
  profiles: UserCircle,
  snapshots: History,
  templates: LayoutTemplate,
};

const SECTION_LABEL_KEY: Record<StudioSection, TranslationKey> = {
  roster: 'evolution.studio.v2.sections.roster',
  create: 'evolution.studio.v2.sections.create',
  lifecycle: 'evolution.studio.v2.sections.lifecycle',
  installed: 'evolution.studio.v2.sections.installed',
  genes: 'evolution.studio.v2.sections.genes',
  profiles: 'evolution.studio.v2.sections.profiles',
  snapshots: 'evolution.studio.v2.sections.snapshots',
  templates: 'evolution.studio.v2.sections.templates',
};

export interface StudioRailProps {
  activeSection: StudioSection;
  onSelect: (section: StudioSection) => void;
  /** Section counts for the badge (skills / drafts / agents …); optional. */
  counts?: Partial<Record<StudioSection, number>>;
  workspaceName?: string;
}

export function StudioRail({ activeSection, onSelect, counts, workspaceName }: StudioRailProps) {
  const { t } = useI18n();
  const { resolvedTheme, toggleTheme } = useTheme();
  const reduce = useReducedMotion();
  const isDark = resolvedTheme === 'dark';
  const theme = isDark ? 'dark' : 'light';

  const renderItem = (section: StudioSection) => {
    const Icon = SECTION_ICON[section];
    const active = section === activeSection;
    const count = counts?.[section];
    return (
      <button
        key={section}
        type="button"
        onClick={() => onSelect(section)}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'relative flex w-full items-center gap-3 px-3 py-2 text-left text-sm font-medium transition-colors',
          radius.small,
          active
            ? cn('text-[var(--prismer-primary)]', isDark ? 'bg-violet-500/15' : 'bg-violet-500/10')
            : isDark
              ? 'text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-100'
              : 'text-zinc-600 hover:bg-zinc-500/5 hover:text-zinc-900',
        )}
      >
        {active && (
          <motion.span
            layoutId="studio-rail-active"
            transition={springSnap}
            className="absolute -left-3 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-[var(--prismer-primary)]"
          />
        )}
        <Icon className="size-[17px] shrink-0 opacity-90" aria-hidden />
        <span className="flex-1 truncate">{t(SECTION_LABEL_KEY[section])}</span>
        {typeof count === 'number' && (
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-[11px] tabular-nums',
              isDark ? 'bg-white/[0.06] text-zinc-400' : 'bg-zinc-500/10 text-zinc-500',
            )}
          >
            {count}
          </span>
        )}
      </button>
    );
  };

  const groupLabel = (key: TranslationKey) => (
    <div
      className={cn(
        'px-3 pb-1.5 pt-3 text-[10.5px] font-semibold uppercase tracking-wider',
        isDark ? 'text-zinc-500' : 'text-zinc-400',
      )}
    >
      {t(key)}
    </div>
  );

  return (
    <aside
      className={cn(
        'flex h-full w-[244px] shrink-0 flex-col gap-1 p-3',
        radius.card,
        s(theme, 'card'),
        'shadow-sm',
      )}
    >
      {/* brand */}
      <div className="flex items-center gap-2.5 px-2 pb-3 pt-1">
        <div
          className="relative size-[30px] shrink-0 rounded-[9px] bg-gradient-to-br from-[var(--grad-from)] to-[var(--grad-to)] shadow-[var(--shadow-glow,0_0_40px_rgba(124,92,255,0.18))]"
          aria-hidden
        />
        <div className="min-w-0">
          <div className={cn('truncate text-[15px] font-bold leading-tight', isDark ? 'text-zinc-100' : 'text-zinc-900')}>
            {t('evolution.studio.v2.title')}
          </div>
          {workspaceName && (
            <div className={cn('truncate text-[11px]', isDark ? 'text-zinc-500' : 'text-zinc-500')}>{workspaceName}</div>
          )}
        </div>
      </div>

      {/* create CTA */}
      <motion.button
        type="button"
        onClick={() => onSelect('create')}
        whileHover={reduce ? undefined : { y: -1, scale: 1.015 }}
        whileTap={reduce ? undefined : { scale: 0.97 }}
        transition={springSnap}
        className={cn(
          'mb-2 flex items-center gap-2.5 px-3.5 py-2.5 text-[13.5px] font-semibold text-white',
          radius.button,
          'bg-gradient-to-br from-[var(--grad-from)] to-[var(--grad-to)] shadow-[0_8px_22px_-8px_rgba(124,92,255,0.7)]',
        )}
      >
        <Plus className="size-4" aria-hidden />
        {t('evolution.studio.v2.createSkill')}
      </motion.button>

      {groupLabel('evolution.studio.v2.groups.workspace')}
      <motion.div initial={false} transition={springSoft} className="flex flex-col gap-0.5">
        {WORKSPACE_SECTIONS.map(renderItem)}
      </motion.div>

      {groupLabel('evolution.studio.v2.groups.perAgent')}
      <div className="flex flex-col gap-0.5">{PER_AGENT_SECTIONS.map(renderItem)}</div>

      {/* theme toggle */}
      <div className="mt-auto pt-2">
        <button
          type="button"
          onClick={toggleTheme}
          className={cn(
            'flex w-full items-center gap-2 px-3 py-2 text-[12.5px] transition-colors',
            radius.small,
            isDark ? 'text-zinc-400 hover:bg-white/[0.04]' : 'text-zinc-600 hover:bg-zinc-500/5',
          )}
        >
          {isDark ? <Sun className="size-[15px]" aria-hidden /> : <Moon className="size-[15px]" aria-hidden />}
          {isDark ? t('evolution.studio.v2.theme.light') : t('evolution.studio.v2.theme.dark')}
        </button>
      </div>
    </aside>
  );
}
