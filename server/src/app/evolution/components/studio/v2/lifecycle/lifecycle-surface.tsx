'use client';

/**
 * Skill Lifecycle surface (release201/28 §4.2 + doc 13 §3.3) —
 * `spatialGrammar.pipeline`, cyan.
 *
 * ─── Why this surface exists (feedback #6 redesign) ──────────────────────────
 * The workspace owner comes here to answer ONE question: "what's in my skill
 * pipeline, and what is waiting on my decision?" So Lifecycle is an APPROVAL /
 * REVIEW board, not an animation showcase. Two levels:
 *
 *   1. PIPELINE OVERVIEW (default) — every workspace skill grouped by lifecycle
 *      stage in 4 columns (draft / eval / review / published). One compact card
 *      per skill; review-stage cards carry a "waiting on you" ring. This is the
 *      global context the old single-draft view lacked: at a glance you see how
 *      many are in each stage, what's stuck, and what needs you.
 *
 *   2. DECISION VIEW (a skill is selected) — a stage rail (occlusion fixed: the
 *      active node is highlighted in-place, NO floating ball over the labels —
 *      labels sit below their node with clear breathing room) + a one-line
 *      decision summary (what it does · is it safe · did eval pass) + the single
 *      action this stage calls for (Promote / Approve & Publish / Reject).
 *      Evidence is demoted to a collapsible "details" drawer — decision first,
 *      proof on demand, never a 9-tile wall in your face.
 *
 * ─── Occlusion fix ───────────────────────────────────────────────────────────
 * The old layout floated a glowing draft ball at `top:[58px]` which physically
 * overlapped the stage labels (the "scaffold" label was covered). Removed
 * entirely. Stage position is now shown by an in-node active highlight + a thin
 * progress fill on the connector line; labels own their own row with no overlay.
 *
 * ─── Data (real-first, mock fallback) ────────────────────────────────────────
 * Overview: `fetchWorkspaceSkillsByStage(workspaceId)` (live IMSkill rows across
 * all stages); workspaceId from `useStudioContext()`. Detail on select:
 * `fetchSkillDetail(id)`. When the workspace is the mock demo (`isMock`), we
 * render `MOCK_DRAFTS` so the offline walkthrough still works. Never fakes data.
 *
 * Gated honesty (doc 28 §4.2): no runner is wired, so eval/review skills cannot
 * be promoted past eval — the action is disabled with an explicit "no runner"
 * note rather than a fake advance. All five states (empty/loading/error/gated/
 * data) render; chrome is i18n-driven; dark/light via useTheme; motion gated by
 * useReducedMotion.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  ArrowLeft,
  Boxes,
  Check,
  ChevronDown,
  CircleDot,
  FlaskConical,
  Inbox,
  Rocket,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  Workflow,
} from 'lucide-react';

import {
  grammarAccentClasses,
  radius,
  s,
  springSnap,
  springSoft,
} from '@/app/workspace/lib/design';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/contexts/i18n-context';
import { useTheme } from '@/contexts/theme-context';
import { cn } from '@/lib/utils';

import { useStudioContext } from '../data/use-studio-context';
import { STUDIO_MOCK_ENABLED } from '../flags';
import { MOCK_DRAFTS } from '../mock';
import { SectionPlaceholder } from '../section-placeholder';
import { SECTION_GRAMMAR } from '../types';
import {
  fetchSkillDetail,
  fetchWorkspaceSkillsByStage,
  type SkillDetail,
  type SkillRow,
} from '../../types';

const { accent, grammar } = SECTION_GRAMMAR.lifecycle;

// ─── Lifecycle stage model ───────────────────────────────────────────────────
// The 4 board columns the owner reasons about (the fine-grained sub-stages —
// scaffold / implement / validate — live inside `draft`/`eval`; the board groups
// them so the question "what's waiting on me" stays answerable at a glance).

type Stage = 'draft' | 'eval' | 'review' | 'published';

const STAGE_ORDER: Stage[] = ['draft', 'eval', 'review', 'published'];

const STAGE_META: Record<Stage, { icon: typeof Boxes }> = {
  draft: { icon: Boxes },
  eval: { icon: FlaskConical },
  review: { icon: ScanSearch },
  published: { icon: Check },
};

/** Runner is not wired yet (doc 28 §4.2): promotion past eval is gated. */
const RUNNER_ATTACHED = false;

/** Normalise a live IMSkill row's stage string into the 4-column model. */
function rowStage(row: { stage?: string; lifecycleStage?: string; status?: string }): Stage {
  const raw = (row.lifecycleStage ?? row.stage ?? row.status ?? '').toLowerCase();
  if (raw === 'published' || raw === 'active') return 'published';
  if (raw === 'review' || raw === 'human_review') return 'review';
  if (raw === 'eval' || raw === 'in_eval') return 'eval';
  return 'draft';
}

/** Unified board item — sourced from either a live SkillRow or a MOCK_DRAFT. */
interface BoardItem {
  id: string;
  name: string;
  slug: string;
  stage: Stage;
  revision: string | null;
  passRate: number | null;
  updatedAt: string | null;
}

function fromSkillRow(r: SkillRow): BoardItem {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    stage: rowStage(r),
    revision: r.contentManifestRevision ?? null,
    passRate: null,
    updatedAt: r.updatedAt ?? null,
  };
}

type Phase = 'loading' | 'error' | 'empty' | 'data';

// ─── Stage rail (occlusion-free) ─────────────────────────────────────────────
// Horizontal node row; the active node is highlighted in place, connectors carry
// a thin progress fill. Labels sit on their own line below — nothing floats over
// them (this is the fix for feedback #6's covered "scaffold" label).

function StageRail({
  stage,
  isDark,
  theme,
  reduce,
  t,
}: {
  stage: Stage;
  isDark: boolean;
  theme: 'dark' | 'light';
  reduce: boolean;
  t: (k: `evolution.${string}`) => string;
}) {
  const a = grammarAccentClasses[accent];
  const activeIndex = STAGE_ORDER.indexOf(stage);

  return (
    <div className="flex items-start">
      {STAGE_ORDER.map((st, i) => {
        const status: 'done' | 'active' | 'todo' =
          i < activeIndex ? 'done' : i === activeIndex ? 'active' : 'todo';
        const Icon = status === 'done' ? Check : STAGE_META[st].icon;
        const isLast = i === STAGE_ORDER.length - 1;
        return (
          <div key={st} className="relative flex flex-1 flex-col items-center gap-2">
            {!isLast && (
              <span
                aria-hidden
                className={cn(
                  'absolute left-[calc(50%+24px)] right-[calc(-50%+24px)] top-[23px] -z-10 h-0.5',
                  i < activeIndex
                    ? 'bg-emerald-500/50'
                    : isDark
                      ? 'bg-white/10'
                      : 'bg-zinc-200',
                )}
              />
            )}
            <motion.div
              initial={reduce ? false : { opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={reduce ? { duration: 0 } : { ...springSoft, delay: i * 0.05 }}
              className={cn(
                'relative flex size-[46px] items-center justify-center border',
                radius.card,
                status === 'active'
                  ? cn(a.bg, a.ring, 'ring-1')
                  : status === 'done'
                    ? 'border-emerald-500/40 bg-emerald-500/10'
                    : s(theme, 'card'),
              )}
            >
              {status === 'active' && !reduce && (
                <motion.span
                  aria-hidden
                  className={cn('absolute inset-0', radius.card, a.bg)}
                  animate={{ opacity: [0.5, 0.15, 0.5] }}
                  transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
                />
              )}
              <Icon
                className={cn(
                  'relative size-[17px]',
                  status === 'active'
                    ? a.text
                    : status === 'done'
                      ? 'text-emerald-400'
                      : isDark
                        ? 'text-zinc-500'
                        : 'text-zinc-400',
                )}
                aria-hidden
              />
            </motion.div>
            {/* label owns its own row — no floating overlay can cover it */}
            <span
              className={cn(
                'text-center font-mono text-[11.5px] font-medium',
                status === 'todo'
                  ? isDark
                    ? 'text-zinc-600'
                    : 'text-zinc-400'
                  : isDark
                    ? 'text-zinc-200'
                    : 'text-zinc-700',
              )}
            >
              {t(`evolution.studio.v2.lifecycle.stages.${st}` as `evolution.${string}`)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Compact board card ──────────────────────────────────────────────────────

function BoardCard({
  item,
  waiting,
  selected,
  onSelect,
  isDark,
  theme,
  reduce,
  t,
  index,
}: {
  item: BoardItem;
  waiting: boolean;
  selected: boolean;
  onSelect: () => void;
  isDark: boolean;
  theme: 'dark' | 'light';
  reduce: boolean;
  t: (k: `evolution.${string}`, vars?: Record<string, string | number>) => string;
  index: number;
}) {
  const a = grammarAccentClasses[accent];
  return (
    <motion.button
      type="button"
      onClick={onSelect}
      initial={reduce ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduce ? { duration: 0 } : { ...springSoft, delay: index * 0.04 }}
      className={cn(
        'w-full border p-3 text-left transition-colors',
        radius.small,
        s(theme, 'card'),
        selected && cn(a.ring, 'ring-1'),
        waiting && !selected && 'border-amber-500/40',
      )}
    >
      <div className="flex items-start gap-2">
        <span
          className={cn('mt-1 size-1.5 shrink-0 rounded-full', waiting ? 'bg-amber-400' : a.dot)}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className={cn('truncate text-[13px] font-semibold', isDark ? 'text-zinc-100' : 'text-zinc-900')}>
            {item.name}
          </div>
          <div className={cn('truncate font-mono text-[11px]', isDark ? 'text-zinc-500' : 'text-zinc-500')}>
            {item.slug}
            {item.revision ? ` · ${item.revision}` : ''}
          </div>
        </div>
        {typeof item.passRate === 'number' && (
          <span
            className={cn(
              'shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[10.5px] font-semibold',
              item.passRate >= 80 ? 'bg-emerald-500/10 text-emerald-400' : 'bg-amber-500/10 text-amber-500',
            )}
          >
            {t('evolution.studio.v2.creator.status.passRate', { rate: item.passRate })}
          </span>
        )}
      </div>
      {waiting && (
        <div className="mt-2 inline-flex items-center gap-1 text-[10.5px] font-medium text-amber-500">
          <CircleDot className="size-3" aria-hidden />
          {t('evolution.studio.v2.lifecycle.waitingOnYou')}
        </div>
      )}
    </motion.button>
  );
}

export interface LifecycleSurfaceProps {
  /** URL-derived pre-selection (shell-controlled); overview is the default. */
  draftId: string | null;
}

export function LifecycleSurface({ draftId }: LifecycleSurfaceProps) {
  const { t } = useI18n();
  const { resolvedTheme } = useTheme();
  const reduce = useReducedMotion();
  const isDark = resolvedTheme === 'dark';
  const theme = isDark ? 'dark' : 'light';
  const a = grammarAccentClasses[accent];

  const { workspaceId, isMock } = useStudioContext();

  const [phase, setPhase] = useState<Phase>('loading');
  const [items, setItems] = useState<BoardItem[]>([]);
  // Selection is local UI state seeded from the URL draftId — the shell passes
  // draftId read-only and owns no setter, so the master→decision drill lives
  // here. `null` = pipeline overview.
  const [selectedId, setSelectedId] = useState<string | null>(draftId);
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [showEvidence, setShowEvidence] = useState(false);

  // ─── Load the board (real-first; mock only for the demo workspace) ──────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setPhase('loading');
      // Mock demo workspace → render fixtures so the offline walkthrough works.
      if (isMock && STUDIO_MOCK_ENABLED) {
        if (cancelled) return;
        setItems(
          MOCK_DRAFTS.map((d) => ({
            id: d.id,
            name: d.name,
            slug: d.slug,
            stage: rowStage({ stage: d.stage }),
            revision: d.revision,
            passRate: d.passRate,
            updatedAt: d.updatedAt,
          })),
        );
        setPhase('data');
        return;
      }
      if (!workspaceId) {
        if (!cancelled) setPhase('empty');
        return;
      }
      try {
        const rows = await fetchWorkspaceSkillsByStage(workspaceId);
        if (cancelled) return;
        const mapped = rows.map(fromSkillRow);
        setItems(mapped);
        setPhase(mapped.length === 0 ? 'empty' : 'data');
      } catch {
        if (!cancelled) setPhase('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, isMock]);

  // ─── Load detail for the selected skill (live only; mock has no detail) ─────
  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setShowEvidence(false);
    if (!selectedId || (isMock && STUDIO_MOCK_ENABLED)) return;
    (async () => {
      setDetailLoading(true);
      try {
        const d = await fetchSkillDetail(selectedId);
        if (!cancelled) setDetail(d);
      } catch {
        if (!cancelled) setDetail(null);
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId, isMock]);

  const selected = useMemo(
    () => items.find((it) => it.id === selectedId) ?? null,
    [items, selectedId],
  );

  const byStage = useMemo(() => {
    const map: Record<Stage, BoardItem[]> = { draft: [], eval: [], review: [], published: [] };
    for (const it of items) map[it.stage].push(it);
    return map;
  }, [items]);

  const waitingCount = byStage.review.length;

  const back = useCallback(() => setSelectedId(null), []);

  // ─── Non-data states ────────────────────────────────────────────────────────
  if (phase === 'loading' || phase === 'error' || phase === 'empty') {
    const key = phase === 'loading' ? 'loading' : phase === 'error' ? 'error' : 'empty';
    return (
      <SectionPlaceholder
        section="lifecycle"
        icon={Workflow}
        titleKey="evolution.studio.v2.lifecycle.title"
        hintKey={`evolution.studio.v2.lifecycle.${key}` as `evolution.${string}`}
      />
    );
  }

  // ─── Header (shared between overview + decision) ────────────────────────────
  const header = (
    <div className="flex items-start gap-3">
      <div className="min-w-0">
        <h2 className={cn('text-lg font-semibold', isDark ? 'text-zinc-100' : 'text-zinc-900')}>
          {t('evolution.studio.v2.lifecycle.title')}
        </h2>
        <p className={cn('mt-0.5 max-w-2xl text-sm', isDark ? 'text-zinc-400' : 'text-zinc-600')}>
          {t('evolution.studio.v2.lifecycle.hint')}
        </p>
      </div>
      <span
        className={cn(
          'ml-auto inline-flex shrink-0 items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium',
          a.bg,
          a.text,
        )}
      >
        <span className={cn('size-1.5 rounded-full', a.dot)} aria-hidden />
        {grammar}
      </span>
    </div>
  );

  // ─── Pipeline overview (default view) ───────────────────────────────────────
  if (!selected) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-5 overflow-hidden px-6 py-6">
        {header}

        {/* "what's waiting on me" banner — the reason the owner is here */}
        {waitingCount > 0 && (
          <div
            className={cn(
              'inline-flex items-center gap-2 self-start rounded-full border px-3 py-1 text-[12px] font-medium',
              'border-amber-500/30 bg-amber-500/10 text-amber-500',
            )}
          >
            <CircleDot className="size-3.5" aria-hidden />
            <span className="font-mono">{waitingCount}</span>
            <span className="opacity-80">· {t('evolution.studio.v2.lifecycle.waitingOnYou')}</span>
          </div>
        )}

        {/* 4-column stage board */}
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-auto sm:grid-cols-2 lg:grid-cols-4">
          {STAGE_ORDER.map((st) => {
            const col = byStage[st];
            const Icon = STAGE_META[st].icon;
            return (
              <div
                key={st}
                className={cn('flex min-h-0 flex-col gap-2 border p-3', radius.card, s(theme, 'inset'))}
              >
                <div className="flex items-center gap-2">
                  <Icon className={cn('size-4', a.text)} aria-hidden />
                  <span className={cn('text-[12.5px] font-semibold', isDark ? 'text-zinc-200' : 'text-zinc-700')}>
                    {t(`evolution.studio.v2.lifecycle.stages.${st}` as `evolution.${string}`)}
                  </span>
                  <span
                    className={cn(
                      'ml-auto rounded-full px-1.5 py-0.5 font-mono text-[11px] font-semibold',
                      isDark ? 'bg-white/5 text-zinc-400' : 'bg-zinc-100 text-zinc-500',
                    )}
                  >
                    {col.length}
                  </span>
                </div>
                <div className="flex flex-col gap-2 overflow-auto">
                  {col.length === 0 ? (
                    <div
                      className={cn(
                        'flex flex-col items-center gap-1.5 py-6 text-center text-[11.5px]',
                        isDark ? 'text-zinc-600' : 'text-zinc-400',
                      )}
                    >
                      <Inbox className="size-4 opacity-60" aria-hidden />
                      {t('evolution.studio.v2.lifecycle.empty')}
                    </div>
                  ) : (
                    col.map((it, i) => (
                      <BoardCard
                        key={it.id}
                        item={it}
                        waiting={st === 'review'}
                        selected={false}
                        onSelect={() => setSelectedId(it.id)}
                        isDark={isDark}
                        theme={theme}
                        reduce={!!reduce}
                        t={t}
                        index={i}
                      />
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ─── Decision view (a skill is selected) ────────────────────────────────────
  const stage = selected.stage;

  // What does it do · is it safe · did eval pass — the 3 facts a decision needs.
  const description =
    detail?.description ||
    detail?.metadata?.skillJson?.description ||
    t('evolution.studio.v2.states.empty');
  const risk = (detail?.metadata?.skillJson?.security?.riskLevel ?? '').toLowerCase();
  const passRate =
    selected.passRate ??
    detail?.metadata?.authoring?.draftRevisionHistory?.slice(-1)[0]?.passRate ??
    null;

  // The single stage-appropriate action.
  const isReview = stage === 'review';
  const isEval = stage === 'eval';
  const isDraft = stage === 'draft';
  // Promotion past eval needs a runner (honest gate).
  const promoteGated = (isDraft || isEval) && !RUNNER_ATTACHED;

  return (
    <div className="flex h-full min-h-0 flex-col gap-5 overflow-hidden px-6 py-6">
      {/* back to the board + the skill name */}
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={back} className="gap-1.5">
          <ArrowLeft className="size-3.5" aria-hidden />
          {t('evolution.studio.v2.lifecycle.backToBoard')}
        </Button>
        <div className="min-w-0">
          <div className={cn('truncate text-[15px] font-semibold', isDark ? 'text-zinc-100' : 'text-zinc-900')}>
            {selected.name}
          </div>
          <div className={cn('truncate font-mono text-[11px]', isDark ? 'text-zinc-500' : 'text-zinc-500')}>
            {selected.slug}
            {selected.revision ? ` · ${selected.revision}` : ''}
          </div>
        </div>
        <span
          className={cn(
            'ml-auto inline-flex shrink-0 items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium',
            a.bg,
            a.text,
          )}
        >
          <span className={cn('size-1.5 rounded-full', a.dot)} aria-hidden />
          {t(`evolution.studio.v2.lifecycle.stages.${stage}` as `evolution.${string}`)}
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto">
        {/* occlusion-free stage rail */}
        <div className={cn('border p-4', radius.card, s(theme, 'card'))}>
          <StageRail stage={stage} isDark={isDark} theme={theme} reduce={!!reduce} t={t} />
        </div>

        {/* decision summary — what it does · safety · eval (one screen, no wall) */}
        <div className={cn('border p-4', radius.card, s(theme, 'card'))}>
          <div className={cn('mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide', isDark ? 'text-zinc-500' : 'text-zinc-500')}>
            <Sparkles className="size-3.5 opacity-70" aria-hidden />
            {t('evolution.studio.v2.lifecycle.decisionSummary')}
          </div>
          <p className={cn('text-[13.5px] leading-relaxed', isDark ? 'text-zinc-200' : 'text-zinc-700')}>
            {detailLoading ? t('evolution.studio.v2.lifecycle.loading') : description}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-medium',
                risk === 'high'
                  ? 'border-rose-500/30 bg-rose-500/10 text-rose-400'
                  : risk === 'medium'
                    ? 'border-amber-500/30 bg-amber-500/10 text-amber-500'
                    : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
              )}
            >
              <ShieldCheck className="size-3.5" aria-hidden />
              {t('evolution.studio.v2.lifecycle.riskLevel', {
                level: risk || t('evolution.studio.v2.lifecycle.evidence.security'),
              })}
            </span>
            <span
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-medium',
                typeof passRate === 'number'
                  ? passRate >= 80
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                    : 'border-amber-500/30 bg-amber-500/10 text-amber-500'
                  : s(theme, 'inset'),
                typeof passRate !== 'number' && (isDark ? 'text-zinc-400' : 'text-zinc-500'),
              )}
            >
              <FlaskConical className="size-3.5" aria-hidden />
              {typeof passRate === 'number'
                ? t('evolution.studio.v2.creator.status.passRate', { rate: passRate })
                : t('evolution.studio.v2.lifecycle.noRunnerQueued')}
            </span>
          </div>
        </div>

        {/* the single action this stage calls for + honest gate */}
        <div className={cn('flex flex-wrap items-center gap-3 border p-4', radius.card, s(theme, 'card'))}>
          {isReview ? (
            <>
              <Button size="sm" className="gap-1.5">
                <Rocket className="size-3.5" aria-hidden />
                {t('evolution.studio.v2.lifecycle.approvePublish')}
              </Button>
              <Button variant="outline" size="sm" className="gap-1.5">
                {t('evolution.studio.v2.lifecycle.requestChanges')}
              </Button>
            </>
          ) : stage === 'published' ? (
            <span
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] font-medium',
                'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
              )}
            >
              <Check className="size-3.5" aria-hidden />
              {t('evolution.studio.v2.lifecycle.stages.published')}
            </span>
          ) : (
            <>
              <Button size="sm" disabled={promoteGated} className="gap-1.5">
                <Rocket className="size-3.5" aria-hidden />
                {t('evolution.studio.v2.lifecycle.promote')}
              </Button>
              <Button variant="outline" size="sm" className="gap-1.5">
                {t('evolution.studio.v2.lifecycle.requestChanges')}
              </Button>
            </>
          )}

          {/* gated honesty — no runner ⇒ can't advance past eval */}
          {promoteGated && (
            <span
              className={cn(
                'ml-auto inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] font-medium',
                'border-amber-500/30 bg-amber-500/10 text-amber-500',
              )}
            >
              <CircleDot className="size-3.5" aria-hidden />
              {t('evolution.studio.v2.lifecycle.gated')}
            </span>
          )}
        </div>

        {/* evidence — demoted to a collapsible drawer; decision first, proof on demand */}
        <div className={cn('border', radius.card, s(theme, 'card'))}>
          <button
            type="button"
            onClick={() => setShowEvidence((v) => !v)}
            className="flex w-full items-center gap-2 p-4 text-left"
          >
            <ScanSearch className={cn('size-4', a.text)} aria-hidden />
            <span className={cn('text-[12.5px] font-semibold', isDark ? 'text-zinc-200' : 'text-zinc-700')}>
              {showEvidence
                ? t('evolution.studio.v2.lifecycle.hideEvidence')
                : t('evolution.studio.v2.lifecycle.showEvidence')}
            </span>
            <motion.span
              className="ml-auto"
              animate={{ rotate: showEvidence ? 180 : 0 }}
              transition={reduce ? { duration: 0 } : springSnap}
            >
              <ChevronDown className={cn('size-4', isDark ? 'text-zinc-500' : 'text-zinc-400')} aria-hidden />
            </motion.span>
          </button>
          <AnimatePresence initial={false}>
            {showEvidence && (
              <motion.div
                initial={reduce ? false : { opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
                transition={reduce ? { duration: 0 } : springSoft}
                className="overflow-hidden"
              >
                <div className="grid gap-3 px-4 pb-4 sm:grid-cols-2 lg:grid-cols-3">
                  {(['capability', 'sourceFacts', 'packageDiff', 'runtimeDeps', 'security', 'validation'] as const).map(
                    (cat) => (
                      <div key={cat} className={cn('border p-3', radius.small, s(theme, 'inset'))}>
                        <div className={cn('mb-1 text-[10.5px] font-semibold uppercase tracking-wide', isDark ? 'text-zinc-500' : 'text-zinc-500')}>
                          {t(`evolution.studio.v2.lifecycle.evidence.${cat}` as `evolution.${string}`)}
                        </div>
                        <div className={cn('text-[12px]', isDark ? 'text-zinc-300' : 'text-zinc-600')}>
                          {evidenceValue(cat, detail, selected)}
                        </div>
                      </div>
                    ),
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

/** Pull a concise value for an evidence tile from live detail (honest fallback). */
function evidenceValue(
  cat: 'capability' | 'sourceFacts' | 'packageDiff' | 'runtimeDeps' | 'security' | 'validation',
  detail: SkillDetail | null,
  item: BoardItem,
): string {
  switch (cat) {
    case 'capability':
      return detail?.description || detail?.metadata?.skillJson?.description || '—';
    case 'sourceFacts': {
      const refs = detail?.metadata?.skillJson?.provenance?.sourceRefs;
      return refs && refs.length ? `${refs.length}` : '—';
    }
    case 'packageDiff':
      return item.revision ?? '—';
    case 'runtimeDeps': {
      const reqs = detail?.requires;
      const parts = [
        ...(reqs?.bins ?? []),
        ...(reqs?.env ?? []),
        reqs?.node ? `node ${reqs.node}` : '',
        reqs?.python ? `python ${reqs.python}` : '',
      ].filter(Boolean);
      return parts.length ? parts.join(', ') : '—';
    }
    case 'security': {
      const sec = detail?.metadata?.skillJson?.security;
      return sec?.riskLevel ? String(sec.riskLevel) : '—';
    }
    case 'validation': {
      const warns = detail?.metadata?.validationWarnings;
      return warns && warns.length ? `${warns.length}` : '—';
    }
    default:
      return '—';
  }
}
