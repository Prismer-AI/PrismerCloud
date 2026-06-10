'use client';

/**
 * Templates surface — the public-browse / private-library system (atelier, indigo).
 *
 * ─── The system (user ruling: old cards were empty + the abstraction was wrong) ─
 * Two scopes, switched by a top segmented control:
 *
 *  • 公共模板 (public)  — the platform's ~225 curated role blueprints. READ-ONLY.
 *    Browse (grid/list + search + tier/type filters), open a detail Sheet for the
 *    FULL blueprint, then either 收藏到私有库 or 应用到 @agent (real apply path).
 *
 *  • 私有模板 (private) — your favourited copies. EDITABLE. Open the editor Sheet
 *    to rename / re-skill / re-MCP / re-principle, or remove. Lives in
 *    localStorage (mock-first), namespaced by workspaceId.
 *
 * ─── Honesty (verified against the backend) ──────────────────────────────────
 *  • Public list/detail: real `GET /role_templates` (full DTO carries category /
 *    description / operatingPrinciples — no separate detail endpoint needed).
 *  • Public apply: real `POST /role_templates/:slug/apply` (403 surfaced honestly).
 *  • Private library / favourite / edit: ZERO backend support today (IMRoleTemplate
 *    is a global curated table). Implemented in localStorage; the scope shows a
 *    "本地 · 后端持久化待接入" banner and PRIVATE APPLY IS GATED (no fake apply).
 */

import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  HardDrive,
  LayoutGrid,
  LayoutTemplate,
  List,
  Search,
  Stamp,
} from 'lucide-react';

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
import { grammarAccentClasses, s, springSplat } from '@/app/workspace/lib/design';
import { useApp } from '@/contexts/app-context';
import { useI18n } from '@/contexts/i18n-context';
import { useTheme } from '@/contexts/theme-context';
import { cn } from '@/lib/utils';

import { STUDIO_MOCK_ENABLED } from '../flags';
import { SectionPlaceholder } from '../section-placeholder';
import { useStudioContext } from '../data/use-studio-context';
import { authHeader } from '../../types';
import type { CuratedQuality } from '../types';
import { BlueprintCard, type BlueprintCardModel } from './blueprint-card';
import { TemplateDetail } from './template-detail';
import { PrivateEditor } from './private-editor';
import {
  fetchEnrichedRoleTemplates,
  type EnrichedTemplate,
} from './enriched-template';
import {
  countPrivateTemplates,
  favoriteTemplate,
  isFavorited,
  listPrivateTemplates,
  removePrivateTemplate,
  updatePrivateTemplate,
  type PrivateTemplate,
  type PrivateTemplatePatch,
} from './private-store';

const ACCENT = grammarAccentClasses.indigo;

export interface TemplatesSurfaceProps {
  agentId: string | null;
}

type Scope = 'public' | 'private';
type ApplyState = 'idle' | 'applying';

export function TemplatesSurface({ agentId }: TemplatesSurfaceProps) {
  const { t } = useI18n();
  const { addToast } = useApp();
  const { resolvedTheme } = useTheme();
  const { workspaceId, agents } = useStudioContext();
  const reduce = useReducedMotion();
  const isDark = resolvedTheme === 'dark';
  const theme = isDark ? 'dark' : 'light';

  // ── Public catalogue (real-first; mock fallback inside the fetcher) ──
  const [templates, setTemplates] = useState<EnrichedTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchEnrichedRoleTemplates()
      .then((rows) => {
        if (cancelled) return;
        setTemplates(rows);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setError(true);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Scope ──
  const [scope, setScope] = useState<Scope>('public');

  // ── Private library (localStorage; re-read on a bumpable token) ──
  const [privateVersion, setPrivateVersion] = useState(0);
  const privateTemplates = useMemo(
    () => listPrivateTemplates(workspaceId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspaceId, privateVersion],
  );
  const privateCount = useMemo(
    () => countPrivateTemplates(workspaceId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspaceId, privateVersion],
  );
  const bumpPrivate = () => setPrivateVersion((v) => v + 1);

  // ── Active stamp target: the URL agent, else the orchestrator, else first. ──
  const targetAgent = useMemo(() => {
    if (agentId) return agents.find((a) => a.id === agentId) ?? null;
    return agents.find((a) => a.isOrchestrator) ?? agents[0] ?? null;
  }, [agentId, agents]);
  const targetId = targetAgent?.id ?? null;

  // ── Client-side search + filters (public only) ──
  const [query, setQuery] = useState('');
  const [tierFilter, setTierFilter] = useState<CuratedQuality | 'all'>('all');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');

  // ── Panels ──
  const [detail, setDetail] = useState<EnrichedTemplate | null>(null);
  const [editing, setEditing] = useState<PrivateTemplate | null>(null);

  // ── Apply flow (public) ──
  const [pending, setPending] = useState<EnrichedTemplate | null>(null);
  const [applyState, setApplyState] = useState<ApplyState>('idle');
  const [stamped, setStamped] = useState<string | null>(null);

  const agentTypes = useMemo(() => {
    const set = new Set(templates.map((tpl) => tpl.agentType).filter(Boolean));
    return ['all', ...Array.from(set).sort()];
  }, [templates]);

  const visiblePublic = useMemo(() => {
    const q = query.trim().toLowerCase();
    return templates.filter((tpl) => {
      if (tierFilter !== 'all' && tpl.curatedQuality !== tierFilter) return false;
      if (typeFilter !== 'all' && tpl.agentType !== typeFilter) return false;
      if (q && !`${tpl.name} ${tpl.slug} ${tpl.category}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [templates, query, tierFilter, typeFilter]);

  // ── Favourite a public template into the private library ──
  const onFavorite = (tpl: EnrichedTemplate) => {
    if (isFavorited(workspaceId, tpl.slug)) return;
    favoriteTemplate(workspaceId, {
      slug: tpl.slug,
      name: tpl.name,
      agentType: tpl.agentType,
      category: tpl.category,
      curatedQuality: tpl.curatedQuality,
      description: tpl.description,
      requiredSkills: tpl.requiredSkills,
      mcpServers: tpl.mcpServers,
      operatingPrinciples: tpl.operatingPrinciples,
    });
    bumpPrivate();
    addToast(t('evolution.studio.v2.templates.favoritedToast', { template: tpl.name }), 'success');
  };

  const onSavePrivate = (id: string, patch: PrivateTemplatePatch) => {
    const next = updatePrivateTemplate(workspaceId, id, patch);
    bumpPrivate();
    setEditing(next);
    addToast(t('evolution.studio.v2.templates.savedToast'), 'success');
  };

  const onRemovePrivate = (id: string) => {
    removePrivateTemplate(workspaceId, id);
    bumpPrivate();
    setEditing(null);
    addToast(t('evolution.studio.v2.templates.removedToast'), 'success');
  };

  // ── Real apply (public only) ──
  const confirmApply = async () => {
    if (!pending || !targetId) {
      setPending(null);
      return;
    }
    const tpl = pending;
    setPending(null);

    if (STUDIO_MOCK_ENABLED && agents.length > 0 && !workspaceId) {
      setStamped(tpl.slug);
      return;
    }

    setApplyState('applying');
    try {
      const res = await fetch(`/api/im/role_templates/${encodeURIComponent(tpl.slug)}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ agentId: targetId, workspaceId: workspaceId ?? undefined }),
      });
      const data = await res.json().catch(() => null);
      if (res.status === 403) {
        setApplyState('idle');
        addToast(t('evolution.studio.v2.templates.applyForbidden'), 'error');
        return;
      }
      if (!res.ok || !data?.ok) {
        setApplyState('idle');
        addToast(t('evolution.studio.v2.states.error'), 'error');
        return;
      }
      setApplyState('idle');
      setStamped(tpl.slug);
      addToast(
        t('evolution.studio.v2.templates.applied', {
          agent: targetAgent?.handle ?? t('evolution.common.agent'),
        }),
        'success',
      );
    } catch {
      setApplyState('idle');
      addToast(t('evolution.studio.v2.states.error'), 'error');
    }
  };

  // ── Loading / error / hard-empty states (public read drives these) ──
  if (loading) {
    return (
      <SectionPlaceholder
        section="templates"
        icon={LayoutTemplate}
        titleKey="evolution.studio.v2.templates.title"
        hintKey="evolution.studio.v2.templates.loading"
      />
    );
  }
  if (error) {
    return (
      <SectionPlaceholder
        section="templates"
        icon={LayoutTemplate}
        titleKey="evolution.studio.v2.templates.title"
        hintKey="evolution.studio.v2.templates.error"
      />
    );
  }

  const TIERS: (CuratedQuality | 'all')[] = ['all', 'gold', 'silver', 'bronze'];
  const skillsLabel = t('evolution.common.skills').toLowerCase();
  const applyDisabled = !targetId || applyState === 'applying';

  // View-models for the card.
  const publicModel = (tpl: EnrichedTemplate): BlueprintCardModel => ({
    key: tpl.slug,
    name: tpl.name,
    agentType: tpl.agentType,
    category: tpl.category,
    curatedQuality: tpl.curatedQuality,
    description: tpl.description,
    summary: tpl.operatingPrinciplesSummary,
    skillCount: tpl.requiredSkills.length,
    mcpCount: tpl.mcpServers.length,
    mcpTitle: tpl.mcpServers.join(' · '),
  });
  const privateModel = (tpl: PrivateTemplate): BlueprintCardModel => ({
    key: tpl.id,
    name: tpl.name,
    agentType: tpl.agentType,
    category: tpl.category,
    curatedQuality: tpl.curatedQuality,
    description: tpl.description,
    summary: tpl.operatingPrinciples.join(' · '),
    skillCount: tpl.requiredSkills.length,
    mcpCount: tpl.mcpServers.length,
    mcpTitle: tpl.mcpServers.join(' · '),
  });

  return (
    <div className="flex h-full flex-col gap-4 px-6 py-6">
      {/* Tagline — the whole system in one line. */}
      <p className={cn('text-xs leading-snug', isDark ? 'text-zinc-400' : 'text-zinc-500')}>
        {t('evolution.studio.v2.templates.systemTagline')}
      </p>

      {/* Scope toggle + (public) apply target */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div
            className={cn('flex items-center gap-1 rounded-full border p-1', s(theme, 'inset'))}
            role="group"
            aria-label={t('evolution.studio.v2.templates.scope')}
          >
            {([
              { id: 'public' as const, label: t('evolution.studio.v2.templates.scopePublic') },
              { id: 'private' as const, label: t('evolution.studio.v2.templates.scopePrivate') },
            ]).map(({ id, label }) => (
              <button
                key={id}
                type="button"
                onClick={() => setScope(id)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors',
                  scope === id
                    ? cn(ACCENT.bg, ACCENT.text)
                    : isDark
                      ? 'text-zinc-400 hover:text-zinc-100'
                      : 'text-zinc-500 hover:text-zinc-900',
                )}
                aria-pressed={scope === id}
              >
                {label}
                {id === 'private' && privateCount > 0 ? (
                  <span
                    className={cn(
                      'inline-flex min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold',
                      scope === id
                        ? 'bg-white/25'
                        : isDark
                          ? 'bg-zinc-700 text-zinc-200'
                          : 'bg-zinc-200 text-zinc-700',
                    )}
                  >
                    {privateCount}
                  </span>
                ) : null}
              </button>
            ))}
          </div>

          {/* Apply target chip (public scope only) */}
          {scope === 'public' ? (
            <span className="flex items-center gap-2">
              <span className={cn('text-xs font-medium', isDark ? 'text-zinc-400' : 'text-zinc-500')}>
                {t('evolution.studio.v2.templates.apply')} →
              </span>
              <span
                className={cn(
                  'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold',
                  ACCENT.bg,
                  ACCENT.text,
                )}
              >
                <Stamp className="size-3.5" aria-hidden />
                {targetAgent ? targetAgent.handle : t('evolution.common.agent')}
              </span>
            </span>
          ) : null}
        </div>

        {/* Search + filters + view toggle (public only) */}
        {scope === 'public' ? (
          <div className="flex flex-wrap items-center gap-2">
            <label
              className={cn('flex items-center gap-1.5 rounded-full border px-3 py-1.5', s(theme, 'inset'))}
            >
              <Search className={cn('size-3.5', isDark ? 'text-zinc-500' : 'text-zinc-400')} aria-hidden />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('evolution.studio.v2.templates.searchPlaceholder')}
                aria-label={t('evolution.studio.v2.templates.searchPlaceholder')}
                className={cn(
                  'w-36 bg-transparent text-xs outline-none placeholder:text-zinc-500',
                  isDark ? 'text-zinc-100' : 'text-zinc-900',
                )}
              />
            </label>

            {agentTypes.length > 2 ? (
              <select
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
                aria-label={t('evolution.studio.v2.templates.filterType')}
                className={cn(
                  'rounded-full border px-3 py-1.5 text-xs outline-none',
                  s(theme, 'inset'),
                  isDark ? 'text-zinc-200' : 'text-zinc-700',
                )}
              >
                {agentTypes.map((type) => (
                  <option key={type} value={type}>
                    {type === 'all' ? t('evolution.studio.v2.templates.tiers.all') : type}
                  </option>
                ))}
              </select>
            ) : null}

            <div
              className={cn('flex items-center gap-1 rounded-full border p-1', s(theme, 'inset'))}
              role="group"
              aria-label={t('evolution.studio.v2.templates.filterTier')}
            >
              {TIERS.map((tier) => (
                <button
                  key={tier}
                  type="button"
                  onClick={() => setTierFilter(tier)}
                  className={cn(
                    'rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
                    tierFilter === tier
                      ? cn(ACCENT.bg, ACCENT.text)
                      : isDark
                        ? 'text-zinc-400 hover:text-zinc-100'
                        : 'text-zinc-500 hover:text-zinc-900',
                  )}
                  aria-pressed={tierFilter === tier}
                >
                  {t(`evolution.studio.v2.templates.tiers.${tier}` as `evolution.${string}`)}
                </button>
              ))}
            </div>

            <div
              className={cn('flex items-center gap-1 rounded-full border p-1', s(theme, 'inset'))}
              role="group"
              aria-label={t('evolution.studio.v2.templates.title')}
            >
              {([
                { mode: 'grid' as const, Icon: LayoutGrid },
                { mode: 'list' as const, Icon: List },
              ]).map(({ mode, Icon }) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setViewMode(mode)}
                  className={cn(
                    'inline-flex items-center justify-center rounded-full p-1.5 transition-colors',
                    viewMode === mode
                      ? cn(ACCENT.bg, ACCENT.text)
                      : isDark
                        ? 'text-zinc-400 hover:text-zinc-100'
                        : 'text-zinc-500 hover:text-zinc-900',
                  )}
                  aria-pressed={viewMode === mode}
                  aria-label={mode}
                >
                  <Icon className="size-3.5" aria-hidden />
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {/* Scope-specific provenance line */}
      {scope === 'public' ? (
        <p className={cn('text-[11px]', isDark ? 'text-zinc-500' : 'text-zinc-400')}>
          {t('evolution.studio.v2.templates.publicHint')}
        </p>
      ) : (
        <div className={cn('flex items-center gap-1.5 text-[11px]', isDark ? 'text-zinc-500' : 'text-zinc-400')}>
          <HardDrive className="size-3" aria-hidden />
          <span>{t('evolution.studio.v2.templates.privateLocalNote')}</span>
        </div>
      )}

      {/* ── Wall ── */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {scope === 'public' ? (
          visiblePublic.length === 0 ? (
            <div className={cn('flex h-full items-center justify-center text-sm', isDark ? 'text-zinc-500' : 'text-zinc-400')}>
              {t('evolution.studio.v2.states.empty')}
            </div>
          ) : (
            <motion.div
              layout
              className={cn(
                viewMode === 'grid'
                  ? 'grid items-stretch gap-4 sm:grid-cols-2 xl:grid-cols-3'
                  : 'flex flex-col gap-3',
              )}
            >
              <AnimatePresence mode="popLayout">
                {visiblePublic.map((tpl) => (
                  <div key={tpl.slug} className="relative">
                    <BlueprintCard
                      model={publicModel(tpl)}
                      isDark={isDark}
                      theme={theme}
                      variant="public"
                      layout={viewMode}
                      favorited={isFavorited(workspaceId, tpl.slug)}
                      skillsLabel={skillsLabel}
                      actionDisabled={applyDisabled}
                      onOpenDetail={() => setDetail(tpl)}
                      onPrimaryAction={() => setPending(tpl)}
                      onDragApply={() => setPending(tpl)}
                    />
                    {stamped === tpl.slug ? (
                      <motion.span
                        initial={reduce ? { opacity: 1 } : { scale: 0, opacity: 0, rotate: -20 }}
                        animate={{ scale: 1, opacity: 1, rotate: -12 }}
                        transition={reduce ? { duration: 0 } : springSplat}
                        onAnimationComplete={() => window.setTimeout(() => setStamped(null), 700)}
                        className={cn(
                          'pointer-events-none absolute right-3 top-3 inline-flex items-center gap-1 rounded-md border-2 px-2 py-0.5 text-[11px] font-bold uppercase',
                          ACCENT.text,
                        )}
                        style={{ borderColor: 'currentColor' }}
                      >
                        <Stamp className="size-3" aria-hidden />
                        {t('evolution.studio.v2.templates.apply')}
                      </motion.span>
                    ) : null}
                  </div>
                ))}
              </AnimatePresence>
            </motion.div>
          )
        ) : privateTemplates.length === 0 ? (
          <div className={cn('flex h-full flex-col items-center justify-center gap-2 text-center', isDark ? 'text-zinc-500' : 'text-zinc-400')}>
            <LayoutTemplate className="size-8 opacity-50" aria-hidden />
            <p className="max-w-xs text-sm">{t('evolution.studio.v2.templates.privateEmpty')}</p>
          </div>
        ) : (
          <motion.div
            layout
            className={cn(
              viewMode === 'grid'
                ? 'grid items-stretch gap-4 sm:grid-cols-2 xl:grid-cols-3'
                : 'flex flex-col gap-3',
            )}
          >
            <AnimatePresence mode="popLayout">
              {privateTemplates.map((tpl) => (
                <BlueprintCard
                  key={tpl.id}
                  model={privateModel(tpl)}
                  isDark={isDark}
                  theme={theme}
                  variant="private"
                  layout={viewMode}
                  skillsLabel={skillsLabel}
                  onOpenDetail={() => setEditing(tpl)}
                  onPrimaryAction={() => setEditing(tpl)}
                />
              ))}
            </AnimatePresence>
          </motion.div>
        )}
      </div>

      {/* Public detail Sheet */}
      <TemplateDetail
        template={detail}
        isDark={isDark}
        theme={theme}
        favorited={detail ? isFavorited(workspaceId, detail.slug) : false}
        agentHandle={targetAgent?.handle ?? null}
        applyDisabled={applyDisabled}
        onOpenChange={(open) => !open && setDetail(null)}
        onFavorite={() => {
          if (detail) onFavorite(detail);
        }}
        onApply={() => {
          if (detail) {
            setPending(detail);
            setDetail(null);
          }
        }}
      />

      {/* Private editor Sheet */}
      <PrivateEditor
        template={editing}
        isDark={isDark}
        theme={theme}
        onOpenChange={(open) => !open && setEditing(null)}
        onSave={onSavePrivate}
        onRemove={onRemovePrivate}
      />

      {/* Apply confirmation (public) */}
      <AlertDialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('evolution.studio.v2.templates.applyConfirmTitle', {
                template: pending?.name ?? '',
                agent: targetAgent?.handle ?? t('evolution.common.agent'),
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('evolution.studio.v2.templates.applyConfirmBody')}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {pending && pending.requiredSkills.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {pending.requiredSkills.map((sk) => (
                <span key={sk} className={cn('rounded-full border px-2 py-0.5 text-xs', ACCENT.bg, ACCENT.text)}>
                  {sk}
                </span>
              ))}
            </div>
          ) : null}

          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmApply}>
              <Stamp className="size-4" aria-hidden />
              {t('evolution.studio.v2.templates.apply')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
