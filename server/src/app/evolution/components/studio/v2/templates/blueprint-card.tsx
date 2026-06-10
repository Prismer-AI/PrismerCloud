'use client';

/**
 * Templates — a single role-blueprint card (atelier grammar, indigo).
 *
 * ─── Card content fix (feedback: cards had no effective content) ─────────────
 * The old card leaned on `description`, which the live catalogue mostly returns
 * empty → every card showed a bare "—" placeholder. The card now leads with the
 * REAL signal a blueprint carries:
 *   • category (domain) chip — what field this role is for
 *   • `N skills · M MCP` — the concrete bundle size
 *   • tier medal
 *   • description / principles summary ONLY when present (line-clamp); never an
 *     empty "—" placeholder.
 *
 * Two surfaces share this card:
 *   • public  — click the card opens the read-only detail Sheet; a quick
 *     "Apply to @agent" stamps it onto the active agent (real apply path).
 *   • private — click opens the editor Sheet; quick "Edit" does the same.
 *
 * Two layouts (grid portrait / list row), switched by the surface toggle.
 * Draggable onto the top agent chip (public only). Hover lift = springSnap.
 */

import { motion, useReducedMotion } from 'framer-motion';
import { Bookmark, Medal, Pencil, Server, Sparkles, Stamp, Tag } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { grammarAccentClasses, radius, s, springSnap } from '@/app/workspace/lib/design';
import { useI18n } from '@/contexts/i18n-context';
import { cn } from '@/lib/utils';

import type { CuratedQuality } from '../types';

const ACCENT = grammarAccentClasses.indigo;

const TIER_CLASS: Record<CuratedQuality, string> = {
  gold: 'text-yellow-400',
  silver: 'text-zinc-400',
  bronze: 'text-amber-600',
};

/** The minimal card view-model — works for both public + private templates. */
export interface BlueprintCardModel {
  key: string;
  name: string;
  agentType: string;
  category: string;
  curatedQuality: CuratedQuality | null;
  description: string;
  summary: string;
  skillCount: number;
  mcpCount: number;
  mcpTitle: string;
}

interface BlueprintCardProps {
  model: BlueprintCardModel;
  isDark: boolean;
  theme: 'dark' | 'light';
  variant: 'public' | 'private';
  layout?: 'grid' | 'list';
  /** Whether this public template is already in the private library. */
  favorited?: boolean;
  skillsLabel: string;
  /** Whether the quick action is disabled (e.g. no apply target). */
  actionDisabled?: boolean;
  /** Open the detail / editor panel. */
  onOpenDetail: () => void;
  /** Public: apply to @agent. Private: open editor. */
  onPrimaryAction: () => void;
  /** Public only: drop on the agent chip = apply. */
  onDragApply?: () => void;
}

export function BlueprintCard({
  model,
  isDark,
  theme,
  variant,
  layout = 'grid',
  favorited = false,
  skillsLabel,
  actionDisabled,
  onOpenDetail,
  onPrimaryAction,
  onDragApply,
}: BlueprintCardProps) {
  const { t } = useI18n();
  const reduce = useReducedMotion();
  const isPublic = variant === 'public';

  // Shared pieces ─────────────────────────────────────────────────────────
  const avatar = (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center font-bold text-white',
        layout === 'list' ? 'size-9 text-xs' : 'size-10 text-sm',
        radius.small,
        'bg-gradient-to-br from-[var(--grad-from)] to-[var(--grad-to)] shadow-md',
      )}
      aria-hidden
    >
      {model.name.slice(0, 2).toUpperCase()}
    </span>
  );

  const tierBadge = model.curatedQuality ? (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase',
        s(theme, 'inset'),
      )}
      title={model.curatedQuality}
    >
      <Medal className={cn('size-3', TIER_CLASS[model.curatedQuality])} aria-hidden />
      <span className={TIER_CLASS[model.curatedQuality]}>{model.curatedQuality}</span>
    </span>
  ) : null;

  const categoryChip = model.category ? (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px]',
        s(theme, 'inset'),
        isDark ? 'text-zinc-300' : 'text-zinc-600',
      )}
      title={t('evolution.studio.v2.templates.category')}
    >
      <Tag className="size-2.5" aria-hidden />
      {model.category}
    </span>
  ) : null;

  const skillsCount = (
    <span className="inline-flex items-center gap-1.5" title={t('evolution.studio.v2.templates.skillset')}>
      <Sparkles className={cn('size-3.5', ACCENT.text)} aria-hidden />
      <b className={isDark ? 'text-zinc-200' : 'text-zinc-900'}>{model.skillCount}</b> {skillsLabel}
    </span>
  );

  const mcpCount =
    model.mcpCount > 0 ? (
      <span className="inline-flex items-center gap-1.5" title={model.mcpTitle}>
        <Server className={cn('size-3.5', ACCENT.text)} aria-hidden />
        <b className={isDark ? 'text-zinc-200' : 'text-zinc-900'}>{model.mcpCount}</b>{' '}
        {t('evolution.studio.v2.templates.mcp')}
      </span>
    ) : null;

  // The action button (varies by variant).
  const actionButton = isPublic ? (
    <Button
      size="sm"
      variant="outline"
      className={layout === 'list' ? 'shrink-0' : 'w-full'}
      onClick={(e) => {
        e.stopPropagation();
        onPrimaryAction();
      }}
      disabled={actionDisabled}
    >
      <Stamp className="size-4" aria-hidden />
      {t('evolution.studio.v2.templates.apply')}
    </Button>
  ) : (
    <Button
      size="sm"
      variant="outline"
      className={layout === 'list' ? 'shrink-0' : 'w-full'}
      onClick={(e) => {
        e.stopPropagation();
        onPrimaryAction();
      }}
    >
      <Pencil className="size-4" aria-hidden />
      {t('common.edit')}
    </Button>
  );

  // Only public grid cards drag onto the agent chip.
  const dragProps =
    isPublic && !reduce && !actionDisabled
      ? {
          drag: true as const,
          dragSnapToOrigin: true,
          whileDrag: { scale: layout === 'list' ? 1.02 : 1.04, zIndex: 30 },
          onDragEnd: (_e: unknown, info: { point: { y: number } }) => {
            if (info.point.y < 160) onDragApply?.();
          },
        }
      : {};

  // ── List layout: one compact, high-density row ──────────────────────────
  if (layout === 'list') {
    return (
      <motion.div
        layout
        {...dragProps}
        transition={springSnap}
        onClick={onOpenDetail}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpenDetail();
          }
        }}
        className={cn(
          'flex w-full items-center gap-3 border p-3',
          isPublic ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer',
          radius.card,
          s(theme, 'card'),
        )}
      >
        {avatar}

        {/* Name + meta — full width, never truncated */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className={cn('text-sm font-semibold leading-tight', isDark ? 'text-zinc-50' : 'text-zinc-900')}>
              {model.name}
            </h3>
            {tierBadge}
            {!isPublic && favorited ? null : null}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
            <span className={cn('shrink-0 text-[11px]', isDark ? 'text-zinc-500' : 'text-zinc-500')}>
              {model.agentType}
            </span>
            {categoryChip}
            {model.summary ? (
              <span className={cn('truncate text-[11px]', isDark ? 'text-zinc-600' : 'text-zinc-400')}>
                · {model.summary}
              </span>
            ) : null}
          </div>
        </div>

        {/* Counts */}
        <div
          className={cn(
            'hidden shrink-0 items-center gap-4 text-[11px] sm:flex',
            isDark ? 'text-zinc-400' : 'text-zinc-600',
          )}
        >
          {skillsCount}
          {mcpCount}
        </div>

        {isPublic && favorited ? (
          <Bookmark className={cn('size-4 shrink-0', ACCENT.text)} aria-hidden />
        ) : null}
        {actionButton}
      </motion.div>
    );
  }

  // ── Grid layout: portrait card for a 2–3 column wall ────────────────────
  return (
    <motion.div
      layout
      {...dragProps}
      whileHover={reduce ? undefined : { y: -4 }}
      transition={springSnap}
      onClick={onOpenDetail}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpenDetail();
        }
      }}
      className={cn(
        'flex h-full flex-col gap-3 border p-4',
        isPublic ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer',
        radius.card,
        s(theme, 'card'),
      )}
    >
      {/* Portrait row — gradient avatar + name + agentType */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          {avatar}
          <div className="min-w-0">
            <h3
              className={cn(
                'line-clamp-2 text-sm font-semibold leading-tight',
                isDark ? 'text-zinc-50' : 'text-zinc-900',
              )}
            >
              {model.name}
            </h3>
            <p className={cn('truncate text-[11px]', isDark ? 'text-zinc-500' : 'text-zinc-500')}>
              {model.agentType}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {isPublic && favorited ? (
            <Bookmark className={cn('size-3.5', ACCENT.text)} aria-hidden />
          ) : null}
          {tierBadge}
        </div>
      </div>

      {/* Category chip — the domain this role is for (real signal). */}
      <div className="flex flex-wrap items-center gap-1.5">{categoryChip}</div>

      {/* Description / principles summary — ONLY when present (no empty "—"). */}
      {model.summary || model.description ? (
        <p className={cn('line-clamp-2 text-xs leading-snug', isDark ? 'text-zinc-400' : 'text-zinc-600')}>
          {model.summary || model.description}
        </p>
      ) : null}

      {/* Uniform meta row — counts (keeps cards aligned). */}
      <div className={cn('mt-auto flex items-center gap-4 text-[11px]', isDark ? 'text-zinc-400' : 'text-zinc-600')}>
        {skillsCount}
        {mcpCount}
      </div>

      {actionButton}
    </motion.div>
  );
}
