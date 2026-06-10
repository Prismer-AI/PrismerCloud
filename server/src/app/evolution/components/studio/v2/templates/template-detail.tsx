'use client';

/**
 * Templates — public-template detail panel (right Sheet, read-only).
 *
 * Shows the **full** blueprint of a curated public template: name / agentType /
 * tier / category / complete description / ALL required skills / ALL MCP servers
 * / the full operating-principles list. Public templates are platform-curated
 * and read-only here (editing is admin-only + server-gated), so there is no
 * editor — only two honest actions:
 *
 *  • 收藏到私有库 — deep-copies the blueprint into the localStorage private
 *    library (favoriteTemplate). Once forked, the action shows "已收藏".
 *  • 应用到 @agent — the real `POST /role_templates/:slug/apply` path (403 is
 *    surfaced honestly by the surface, never swallowed).
 *
 * Indigo atelier accent. Reuses ui/sheet (0 direct @radix). Dark/light tokens.
 */

import { motion, useReducedMotion } from 'framer-motion';
import { BookmarkCheck, BookmarkPlus, Medal, Server, Sparkles, Stamp, Tag } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { grammarAccentClasses, radius, s, springSnap } from '@/app/workspace/lib/design';
import { useI18n } from '@/contexts/i18n-context';
import { cn } from '@/lib/utils';

import type { CuratedQuality } from '../types';
import type { EnrichedTemplate } from './enriched-template';

const ACCENT = grammarAccentClasses.indigo;

const TIER_CLASS: Record<CuratedQuality, string> = {
  gold: 'text-yellow-400',
  silver: 'text-zinc-400',
  bronze: 'text-amber-600',
};

interface TemplateDetailProps {
  template: EnrichedTemplate | null;
  isDark: boolean;
  theme: 'dark' | 'light';
  /** Whether this public template is already forked into the private library. */
  favorited: boolean;
  /** Apply target agent handle (null → no resolvable target). */
  agentHandle: string | null;
  applyDisabled: boolean;
  onOpenChange: (open: boolean) => void;
  onFavorite: () => void;
  onApply: () => void;
}

/** A labelled section with chips or a bullet list. */
function Section({
  label,
  isDark,
  children,
}: {
  label: string;
  isDark: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <p
        className={cn(
          'text-[11px] font-semibold uppercase tracking-wider',
          isDark ? 'text-zinc-400' : 'text-zinc-500',
        )}
      >
        {label}
      </p>
      {children}
    </div>
  );
}

export function TemplateDetail({
  template,
  isDark,
  theme,
  favorited,
  agentHandle,
  applyDisabled,
  onOpenChange,
  onFavorite,
  onApply,
}: TemplateDetailProps) {
  const { t } = useI18n();
  const reduce = useReducedMotion();

  return (
    <Sheet open={template !== null} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full gap-0 sm:max-w-md"
        aria-describedby={undefined}
      >
        {template ? (
          <>
            <SheetHeader className="gap-3 border-b pb-4">
              <div className="flex items-start gap-3">
                <motion.span
                  initial={reduce ? false : { scale: 0.9, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={springSnap}
                  className={cn(
                    'flex size-12 shrink-0 items-center justify-center text-base font-bold text-white',
                    radius.small,
                    'bg-gradient-to-br from-[var(--grad-from)] to-[var(--grad-to)] shadow-md',
                  )}
                  aria-hidden
                >
                  {template.name.slice(0, 2).toUpperCase()}
                </motion.span>
                <div className="min-w-0 flex-1">
                  <SheetTitle className="text-base leading-tight">{template.name}</SheetTitle>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
                    <span className={isDark ? 'text-zinc-400' : 'text-zinc-500'}>
                      {template.agentType}
                    </span>
                    <span
                      className={cn(
                        'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5',
                        s(theme, 'inset'),
                        isDark ? 'text-zinc-300' : 'text-zinc-600',
                      )}
                    >
                      <Tag className="size-3" aria-hidden />
                      {template.category}
                    </span>
                    {template.curatedQuality ? (
                      <span
                        className={cn(
                          'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 font-semibold uppercase',
                          s(theme, 'inset'),
                        )}
                      >
                        <Medal
                          className={cn('size-3', TIER_CLASS[template.curatedQuality])}
                          aria-hidden
                        />
                        <span className={TIER_CLASS[template.curatedQuality]}>
                          {template.curatedQuality}
                        </span>
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>
              {template.description ? (
                <SheetDescription className="leading-relaxed">
                  {template.description}
                </SheetDescription>
              ) : null}
            </SheetHeader>

            {/* Scrollable full detail */}
            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
              <Section
                label={`${t('evolution.studio.v2.templates.skillset')} (${template.requiredSkills.length})`}
                isDark={isDark}
              >
                {template.requiredSkills.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {template.requiredSkills.map((sk) => (
                      <span
                        key={sk}
                        className={cn(
                          'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs',
                          ACCENT.bg,
                          ACCENT.text,
                        )}
                      >
                        <Sparkles className="size-3" aria-hidden />
                        {sk}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className={cn('text-xs', isDark ? 'text-zinc-500' : 'text-zinc-400')}>
                    {t('evolution.studio.v2.states.empty')}
                  </p>
                )}
              </Section>

              <Section
                label={`${t('evolution.studio.v2.templates.mcp')} (${template.mcpServers.length})`}
                isDark={isDark}
              >
                {template.mcpServers.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {template.mcpServers.map((m) => (
                      <span
                        key={m}
                        className={cn(
                          'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs',
                          s(theme, 'inset'),
                          isDark ? 'text-zinc-300' : 'text-zinc-600',
                        )}
                      >
                        <Server className="size-3" aria-hidden />
                        {m}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className={cn('text-xs', isDark ? 'text-zinc-500' : 'text-zinc-400')}>
                    {t('evolution.studio.v2.states.empty')}
                  </p>
                )}
              </Section>

              <Section label={t('evolution.studio.v2.templates.principles')} isDark={isDark}>
                {template.operatingPrinciples.length > 0 ? (
                  <ul className="space-y-1.5">
                    {template.operatingPrinciples.map((p, i) => (
                      <li
                        key={i}
                        className={cn(
                          'flex gap-2 text-xs leading-relaxed',
                          isDark ? 'text-zinc-300' : 'text-zinc-700',
                        )}
                      >
                        <span className={cn('mt-1.5 size-1 shrink-0 rounded-full', ACCENT.bg)} aria-hidden />
                        <span>{p}</span>
                      </li>
                    ))}
                  </ul>
                ) : template.operatingPrinciplesSummary ? (
                  <p className={cn('text-xs leading-relaxed', isDark ? 'text-zinc-300' : 'text-zinc-700')}>
                    {template.operatingPrinciplesSummary}
                  </p>
                ) : (
                  <p className={cn('text-xs', isDark ? 'text-zinc-500' : 'text-zinc-400')}>
                    {t('evolution.studio.v2.states.empty')}
                  </p>
                )}
              </Section>
            </div>

            <SheetFooter className="flex-row gap-2 border-t">
              <Button
                variant={favorited ? 'secondary' : 'outline'}
                className="flex-1"
                onClick={onFavorite}
                disabled={favorited}
              >
                {favorited ? (
                  <>
                    <BookmarkCheck className="size-4" aria-hidden />
                    {t('evolution.studio.v2.templates.favorited')}
                  </>
                ) : (
                  <>
                    <BookmarkPlus className="size-4" aria-hidden />
                    {t('evolution.studio.v2.templates.favorite')}
                  </>
                )}
              </Button>
              <Button className="flex-1" onClick={onApply} disabled={applyDisabled}>
                <Stamp className="size-4" aria-hidden />
                {agentHandle
                  ? t('evolution.studio.v2.templates.applyTo', { agent: agentHandle })
                  : t('evolution.studio.v2.templates.apply')}
              </Button>
            </SheetFooter>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
