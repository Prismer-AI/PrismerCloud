'use client';

/**
 * Skills · Authoring sub-tab — release201/13 §3.2.
 *
 * Status-filterable list of skills in the workspace (draft / in_eval /
 * review / published). Selected row drops a manifest detail card below.
 * "+ New skill" opens the NewSkillDialog which calls 07's draft endpoint.
 *
 * Originally this file *was* SkillsView.tsx; with the 4 sub-tab split
 * (S22) authoring is now one of four siblings. Lifecycle/Installed/
 * Evolution get their own views; this one stays the broad list.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import {
  ArrowRight,
  ChevronDown,
  ClipboardList,
  FileText,
  GitBranch,
  Globe,
  Loader2,
  Paperclip,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Terminal,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/contexts/i18n-context';
import { glass } from '../../helpers';
import {
  type SkillDraftDetail,
  type SkillRow,
  fetchDraftDetail,
  fetchDrafts,
  fetchWorkspaceSkillsByStage,
  localizedTimeAgo,
} from '../types';
import { NewSkillDialog, type DraftInputMode } from '../new-skill-dialog';
import {
  grammarAccentClasses,
  motionPreset,
  motionReduced,
  spatialGrammar,
  springLiquid,
  springSnap,
} from '@/app/workspace/lib/design';

interface AuthoringViewProps {
  isDark: boolean;
  workspaceId: string | null;
  draftId: string | null;
  onDraftChange: (id: string | null) => void;
  onHasDraftChange: (has: boolean) => void;
}

type StatusFilter = 'all' | 'draft' | 'in_eval' | 'review' | 'published';

const FILTERS: Array<{ key: StatusFilter; labelKey: `evolution.${string}` }> = [
  { key: 'all', labelKey: 'evolution.studio.skills.authoring.filters.all' },
  { key: 'draft', labelKey: 'evolution.studio.skills.authoring.filters.draft' },
  { key: 'in_eval', labelKey: 'evolution.studio.skills.authoring.filters.inEval' },
  { key: 'review', labelKey: 'evolution.studio.skills.authoring.filters.review' },
  { key: 'published', labelKey: 'evolution.studio.skills.authoring.filters.published' },
];

export function AuthoringView({ isDark, workspaceId, draftId, onDraftChange, onHasDraftChange }: AuthoringViewProps) {
  const { t } = useI18n();
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState<DraftInputMode>('plain');
  const [dialogKey, setDialogKey] = useState(0);
  const [detail, setDetail] = useState<SkillDraftDetail | null>(null);
  const [authoringNotice, setAuthoringNotice] = useState<{ taskId: string; agentOnline: boolean } | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await fetchDrafts(workspaceId);
      setSkills(rows);
      onHasDraftChange(rows.length > 0);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [workspaceId, onHasDraftChange]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!draftId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    void fetchDraftDetail(draftId).then((d) => {
      if (!cancelled) setDetail(d);
    });
    return () => {
      cancelled = true;
    };
  }, [draftId]);

  const counts = useMemo(() => countByStatus(skills), [skills]);
  const filtered = useMemo(
    () => (filter === 'all' ? skills : skills.filter((s) => normalizeStatus(s) === filter)),
    [skills, filter],
  );

  // ── Reference panel data (lifted from ReferencePanel so the *parent* can
  // decide whether to render the 3rd column at all). v2.0.8 Y1 bug fix —
  // ReferencePanel's "sources" section was a 1:1 duplicate of SkillDetail's
  // manifest list and the panel itself stayed mounted (occupying the 320px
  // 3rd grid track) even on single-skill workspaces where the other two
  // data sources (`related-published`, `recent-drafts`) were always empty.
  // Compute both upstream; if both are empty, drop the panel + collapse
  // the workshop grid to 2 columns so the centre track gets the breathing
  // room back.
  const [related, setRelated] = useState<SkillRow[]>([]);
  useEffect(() => {
    if (!workspaceId || !detail?.slug) {
      setRelated([]);
      return;
    }
    let cancelled = false;
    const tokens = detail.slug
      .toLowerCase()
      .split(/[-_/]/)
      .filter((s) => s.length >= 3);
    if (tokens.length === 0) {
      setRelated([]);
      return;
    }
    void fetchWorkspaceSkillsByStage(workspaceId, ['published']).then((rows) => {
      if (cancelled) return;
      const matched = rows
        .filter((row) => {
          if (row.id === detail.id) return false;
          const haystack = `${row.slug ?? ''} ${row.name ?? ''}`.toLowerCase();
          return tokens.some((tok) => haystack.includes(tok));
        })
        .slice(0, 5);
      setRelated(matched);
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, detail?.slug, detail?.id]);

  const recentDrafts = useMemo(
    () =>
      [...skills]
        .filter((s) => s.id !== detail?.id)
        .sort((a, b) => {
          const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
          const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
          return tb - ta;
        })
        .slice(0, 3),
    [skills, detail?.id],
  );

  // The reference column only earns its 320px if at least one of the two
  // non-duplicate data sources has content. (Sources are *always* a dup of
  // SkillDetail.files and are no longer rendered inside the panel either.)
  const referenceHasContent = related.length > 0 || recentDrafts.length > 0;

  // release201/24 §UX — the dialog now dispatches an authoring run to an agent
  // (no draftId yet). Show a "next step" notice + reload so the draft appears
  // when the agent finishes.
  const handleSubmitted = (r: { taskId: string; agentId: string; agentOnline: boolean }) => {
    setDialogOpen(false);
    setAuthoringNotice({ taskId: r.taskId, agentOnline: r.agentOnline });
    void reload();
  };

  const openNewSkill = (mode: DraftInputMode = 'plain') => {
    setDialogMode(mode);
    setDialogKey((key) => key + 1);
    setDialogOpen(true);
  };

  // ── Workshop grammar (doc 13 §3.2 — workshop: source-bench / draft / reference) ──
  const grammar = spatialGrammar.workshop;
  const accent = grammarAccentClasses[grammar.accentColor];
  const prefersReducedMotion = useReducedMotion();
  const slideMotion = prefersReducedMotion ? motionReduced : motionPreset.slideFromBench;

  // v2.0.8 Y1: collapse to 2-col when reference panel has no unique content,
  // so the single-skill workspace case (the common new-user state) doesn't
  // waste 320px on an empty placeholder column.
  const workshopLayout = referenceHasContent
    ? grammar.layout
    : 'grid grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)] gap-4';

  return (
    <div data-spatial-grammar="workshop" data-grammar-accent={grammar.accentColor} className="space-y-4">
      {/* Workshop header — chromatic anchor (amber). Frosted (backdrop-blur)
          so it reads as glass, not a flat tint. The redundant "工作室" eyebrow
          (duplicated the Studio title + breadcrumb) is dropped — the accent
          dot + hint carry the chromatic identity. */}
      <div
        className={`flex flex-wrap items-center justify-between gap-3 rounded-2xl border px-4 py-3 backdrop-blur-md ${accent.bg}`}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${accent.dot}`} aria-hidden />
          <p className={`text-xs ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
            {t('evolution.studio.skills.authoring.workshopHint')}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void reload()}
            aria-label={t('evolution.common.reload')}
            disabled={loading}
          >
            <RefreshCw className={loading ? 'animate-spin' : undefined} />
          </Button>
          <Button
            onClick={() => openNewSkill('plain')}
            data-testid="studio-new-skill"
            size="sm"
            aria-keyshortcuts="Meta+N"
            title="⌘N"
          >
            <Plus />
            {t('evolution.studio.skills.authoring.newSkill')}
          </Button>
        </div>
      </div>

      {/* release201/24 §UX — authoring dispatched notice + next-step handoff. */}
      {authoringNotice && (
        <div
          data-testid="authoring-dispatched-notice"
          className={`flex flex-wrap items-center justify-between gap-3 rounded-2xl border p-3 ${
            isDark ? 'border-emerald-400/20 bg-emerald-500/[0.08]' : 'border-emerald-300 bg-emerald-50'
          }`}
        >
          <div className="flex items-center gap-2">
            <Loader2 className={`h-4 w-4 animate-spin ${isDark ? 'text-emerald-300' : 'text-emerald-600'}`} />
            <div>
              <p className={`text-xs font-semibold ${isDark ? 'text-emerald-200' : 'text-emerald-800'}`}>
                {authoringNotice.agentOnline
                  ? t('evolution.studio.skills.authoring.dispatchedTitle')
                  : t('evolution.studio.skills.authoring.queuedTitle')}
              </p>
              <p className={`text-[11px] ${isDark ? 'text-emerald-300/80' : 'text-emerald-700'}`}>
                {t('evolution.studio.skills.authoring.dispatchedBody')}
              </p>
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setAuthoringNotice(null)}>
            {t('common.close')}
          </Button>
        </div>
      )}

      {/* 3-column workshop (workshop spatial grammar); falls back to 2-col
          when the reference panel has nothing unique to show (Y1 fix). */}
      <div
        className={workshopLayout}
        data-testid="authoring-workshop"
        data-reference-visible={referenceHasContent ? 'true' : 'false'}
      >
        {/* Left: source-bench (4 source kinds) */}
        <aside data-pane="source-bench" className={`space-y-2 rounded-2xl border p-3 ${glass(isDark, 'base')}`}>
          <p className={`text-[10px] font-semibold uppercase tracking-wider ${accent.text}`}>
            {t('evolution.studio.skills.authoring.sourceBench')}
          </p>
          <SourceBench isDark={isDark} accentText={accent.text} onPick={openNewSkill} />
          <FilterChips isDark={isDark} value={filter} onChange={setFilter} counts={counts} />
        </aside>

        {/* Centre: active draft — `min-w-0` allows the grid track to shrink
            below its content size (default `min-width: auto` would push the
            yellow accent border + ring past the column edge into the
            reference column; v2.0.8 X1 bug fix). */}
        <motion.section
          key={draftId ?? 'no-draft'}
          data-pane="active-draft"
          initial={slideMotion.initial}
          animate={slideMotion.animate}
          transition={slideMotion.transition}
          className={`min-w-0 overflow-hidden rounded-2xl border ring-1 ${glass(isDark, 'base')} ${accent.ring}`}
        >
          {loading && !skills.length ? (
            <ListPlaceholder
              isDark={isDark}
              icon={<Loader2 className="h-4 w-4 animate-spin" />}
              text={t('evolution.studio.skills.authoring.loading')}
            />
          ) : error ? (
            <ListPlaceholder
              isDark={isDark}
              text={t('evolution.studio.skills.authoring.loadFailed', { error })}
              tone="error"
            />
          ) : skills.length === 0 ? (
            <EmptyState isDark={isDark} onNew={openNewSkill} />
          ) : filtered.length === 0 ? (
            <ListPlaceholder
              isDark={isDark}
              text={t('evolution.studio.skills.authoring.nothingIn', {
                filter: t(
                  FILTERS.find((f) => f.key === filter)?.labelKey ?? 'evolution.studio.skills.authoring.filters.all',
                ),
              })}
            />
          ) : (
            <ul className="overflow-hidden rounded-2xl">
              {filtered.map((skill, i) => (
                <SkillRowItem
                  key={skill.id}
                  isDark={isDark}
                  skill={skill}
                  selected={skill.id === draftId}
                  isLast={i === filtered.length - 1}
                  onSelect={() => onDraftChange(skill.id)}
                />
              ))}
            </ul>
          )}

          {draftId && detail && <SkillDetail isDark={isDark} detail={detail} onClose={() => onDraftChange(null)} />}
        </motion.section>

        {/* Right: reference panel — V6 (doc 13 §3.2 + doc 20 §9.2).
            v2.0.8 Y1: only render when at least one of the two non-duplicate
            data sources (related-published, recent-drafts) is non-empty. The
            "sources" section that used to live here was a 1:1 duplicate of
            SkillDetail's manifest list and has been removed entirely. */}
        {referenceHasContent && (
          <ReferencePanel
            isDark={isDark}
            accentText={accent.text}
            related={related}
            recentDrafts={recentDrafts}
            prefersReducedMotion={prefersReducedMotion ?? false}
          />
        )}
      </div>

      <NewSkillDialog
        key={dialogKey}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        isDark={isDark}
        workspaceId={workspaceId}
        initialMode={dialogMode}
        onSubmitted={handleSubmitted}
      />
    </div>
  );
}

// ─── Reference panel (V6 — doc 13 §3.2 / doc 20 §9.2) ────────────────
//
// 3rd column of the workshop grammar. v2.0.8 Y1 trim — there used to be a
// third data source ("sources of the active draft" = `detail.files`) but it
// was a 1:1 duplicate of SkillDetail's manifest list. It's been deleted; the
// panel now only renders two real-information sources:
//
//   1. Related published skills in the same workspace (heuristic match on
//      slug tokens against `fetchWorkspaceSkillsByStage('published')`).
//   2. Recent drafts by the same creator — fallback "recent context" — pulled
//      straight from the already-loaded `skills` list, sorted by updatedAt.
//
// Both data sources are now computed in the parent (`AuthoringView`) so the
// parent can drop the panel entirely + collapse the workshop grid to 2 cols
// when both are empty. The panel itself only renders when it has content.
//
// Motion: first-render slideFromRight (+x → 0) with springLiquid; reduced
// motion = fade only. On mobile (`lg:hidden`) the whole panel collapses into
// a button-toggled drawer (default closed) so the workshop centre column
// can use the full viewport width.

interface ReferencePanelProps {
  isDark: boolean;
  accentText: string;
  related: SkillRow[];
  recentDrafts: SkillRow[];
  prefersReducedMotion: boolean;
}

function ReferencePanel({ isDark, accentText, related, recentDrafts, prefersReducedMotion }: ReferencePanelProps) {
  const { t } = useI18n();
  const [mobileOpen, setMobileOpen] = useState(false);

  // Motion: first-render slide from right (mirror of slideFromBench).
  const motionProps = prefersReducedMotion
    ? { initial: motionReduced.initial, animate: motionReduced.animate, transition: motionReduced.transition }
    : {
        initial: { x: 40, opacity: 0 },
        animate: { x: 0, opacity: 1 },
        transition: springLiquid,
      };

  const body = (
    <div className="space-y-3">
      {/* Section 1: related published skills */}
      {related.length > 0 && (
        <section data-section="related-published">
          <p className={`mb-1.5 text-[10px] uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
            {t('evolution.studio.skills.authoring.filters.published')}
          </p>
          <ul className="space-y-1">
            {related.map((r) => (
              <li
                key={r.id}
                className={`flex items-center gap-2 truncate text-[11px] ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}
              >
                <Sparkles className={`h-3 w-3 ${accentText} opacity-80`} />
                <span className="truncate font-mono">{r.slug}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Section 2: recent drafts (fallback context) */}
      {recentDrafts.length > 0 && (
        <section data-section="recent-drafts">
          <p className={`mb-1.5 text-[10px] uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
            {t('evolution.studio.skills.authoring.filters.draft')}
          </p>
          <ul className="space-y-1">
            {recentDrafts.map((r) => (
              <li
                key={r.id}
                className={`flex items-center gap-2 truncate text-[11px] ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}
              >
                <FileText className="h-3 w-3 opacity-60" />
                <span className="truncate font-mono">{r.slug}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );

  return (
    <>
      {/* Desktop: 3rd column with slide-from-right entrance. */}
      <motion.aside
        {...motionProps}
        data-pane="reference-panel"
        data-testid="reference-panel"
        className={`hidden space-y-2 rounded-2xl border p-3 lg:block ${glass(isDark, 'base')}`}
      >
        <p className={`text-[10px] font-semibold uppercase tracking-wider ${accentText}`}>
          {t('evolution.studio.skills.authoring.referencePanel')}
        </p>
        {body}
      </motion.aside>

      {/* Mobile: collapsible drawer (default closed). */}
      <div className={`lg:hidden rounded-2xl border ${glass(isDark, 'base')}`} data-testid="reference-panel-mobile">
        <button
          type="button"
          onClick={() => setMobileOpen((v) => !v)}
          aria-expanded={mobileOpen}
          data-testid="reference-panel-mobile-toggle"
          className={`flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left ${
            isDark ? 'text-zinc-200' : 'text-zinc-800'
          }`}
        >
          <span className={`text-[10px] font-semibold uppercase tracking-wider ${accentText}`}>
            {t('evolution.studio.skills.authoring.referencePanel')}
          </span>
          <ChevronDown className={`h-3.5 w-3.5 opacity-70 transition-transform ${mobileOpen ? 'rotate-180' : ''}`} />
        </button>
        {mobileOpen && <div className="border-t border-white/[0.04] px-3 pb-3 pt-2">{body}</div>}
      </div>
    </>
  );
}

// SourceBench — 4 source kind chip picker.
// (workshop §3.2: doc-url / code-source / service-endpoint / inline-spec)
function SourceBench({
  isDark,
  accentText,
  onPick,
}: {
  isDark: boolean;
  accentText: string;
  onPick: (mode: DraftInputMode) => void;
}) {
  const { t } = useI18n();
  const sources: Array<{ kind: DraftInputMode; icon: typeof Globe; label: string }> = [
    { kind: 'doc', icon: Paperclip, label: t('evolution.studio.skills.authoring.sourceKinds.doc') },
    { kind: 'script', icon: Terminal, label: t('evolution.studio.skills.authoring.sourceKinds.script') },
    { kind: 'api', icon: Globe, label: t('evolution.studio.skills.authoring.sourceKinds.api') },
    { kind: 'plain', icon: ClipboardList, label: t('evolution.studio.skills.authoring.sourceKinds.plain') },
  ];
  return (
    <ul className="flex flex-col gap-1" data-source-bench-chips>
      {sources.map(({ kind, icon: Icon, label }) => (
        <li key={kind}>
          <motion.button
            type="button"
            onClick={() => onPick(kind)}
            data-source-kind={kind}
            whileHover={{ x: 3 }}
            whileTap={{ scale: 0.97 }}
            transition={springSnap}
            className={`flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left text-xs transition-colors ${
              isDark
                ? 'border-white/[0.04] bg-white/[0.02] hover:bg-white/[0.06]'
                : 'border-zinc-200 bg-white hover:bg-zinc-50'
            }`}
          >
            <Icon className={`h-3 w-3 ${accentText}`} />
            <span className={isDark ? 'text-zinc-200' : 'text-zinc-800'}>{label}</span>
          </motion.button>
        </li>
      ))}
    </ul>
  );
}

// ─── Subcomponents ────────────────────────────────────────────────────

function FilterChips({
  isDark,
  value,
  onChange,
  counts,
}: {
  isDark: boolean;
  value: StatusFilter;
  onChange: (v: StatusFilter) => void;
  counts: Record<StatusFilter, number>;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-center gap-1">
      {FILTERS.map((f) => {
        const active = f.key === value;
        const count = counts[f.key];
        return (
          <Button
            key={f.key}
            variant={active ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => onChange(f.key)}
            className="h-8"
          >
            {t(f.labelKey)}
            {count > 0 && (
              <span className={`text-[10px] ${active ? 'opacity-80' : isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                {count}
              </span>
            )}
          </Button>
        );
      })}
    </div>
  );
}

function SkillRowItem({
  isDark,
  skill,
  selected,
  isLast,
  onSelect,
}: {
  isDark: boolean;
  skill: SkillRow;
  selected: boolean;
  isLast: boolean;
  onSelect: () => void;
}) {
  const { t } = useI18n();
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        data-testid="studio-skill-row"
        data-skill-id={skill.id}
        className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors ${
          isDark ? 'hover:bg-white/[0.04]' : 'hover:bg-zinc-50'
        } ${selected ? (isDark ? 'bg-white/[0.04]' : 'bg-zinc-50') : ''} ${
          !isLast ? (isDark ? 'border-b border-white/[0.04]' : 'border-b border-zinc-100') : ''
        }`}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className={`truncate font-mono text-sm ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
              {skill.slug}
            </span>
            <SkillStatusBadge status={normalizeStatus(skill)} />
          </div>
          <p className={`mt-0.5 truncate text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
            {skill.name}
            {skill.description ? ` · ${skill.description}` : ''}
          </p>
        </div>
        <div className={`shrink-0 text-right text-[10px] font-mono ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
          {skill.updatedAt ? localizedTimeAgo(skill.updatedAt, t) : null}
          {skill.contentManifestRevision ? (
            <div className={`mt-0.5 ${isDark ? 'text-zinc-700' : 'text-zinc-300'}`}>
              {skill.contentManifestRevision.slice(0, 7)}
            </div>
          ) : null}
        </div>
      </button>
    </li>
  );
}

function SkillStatusBadge({ status }: { status: StatusFilter }) {
  const { t } = useI18n();
  if (status === 'all') return null;
  const variant = {
    draft: 'outline',
    in_eval: 'secondary',
    review: 'default',
    published: 'default',
  } as const;
  const label = {
    draft: t('evolution.studio.skills.authoring.filters.draft'),
    in_eval: t('evolution.studio.skills.authoring.filters.inEval'),
    review: t('evolution.studio.skills.authoring.filters.review'),
    published: t('evolution.studio.skills.authoring.filters.published'),
  } as const;
  const tone =
    status === 'review'
      ? 'bg-violet-500/15 text-violet-300 border-violet-500/20'
      : status === 'published'
        ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/20'
        : '';
  return (
    <Badge variant={variant[status]} className={`text-[10px] uppercase tracking-wider ${tone}`}>
      {label[status]}
    </Badge>
  );
}

function SkillDetail({ isDark, detail, onClose }: { isDark: boolean; detail: SkillDraftDetail; onClose: () => void }) {
  const { t } = useI18n();
  // v2.0.8 Y2: brief row above already shows slug + name + description preview,
  // so the detail card no longer repeats them. Its job is "give me the
  // metadata I can't see at brief level": file manifest (paths + sizes),
  // revision SHA, and timestamps. That is the *increment* a user gets in
  // exchange for the expand → close cycle.
  const totalBytes = (detail.files ?? []).reduce((sum, f) => sum + (f.size ?? 0), 0);
  return (
    <div data-testid="skill-detail" className={`rounded-2xl ${glass(isDark, 'base')}`}>
      <div
        className={`flex items-center justify-between gap-3 border-b px-5 py-3 ${
          isDark ? 'border-white/[0.06]' : 'border-zinc-200'
        }`}
      >
        <div className="min-w-0">
          <p
            className={`text-[10px] font-semibold uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
          >
            {t('evolution.studio.skills.authoring.manifest')}
          </p>
          <p className={`mt-0.5 truncate text-[11px] font-mono ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
            {detail.slug}
            {detail.contentManifestRevision ? ` · ${detail.contentManifestRevision.slice(0, 7)}` : ''}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t('common.close')}
        </Button>
      </div>
      <div className="space-y-3 px-5 py-4">
        <ul className="space-y-1">
          {detail.files.map((f) => (
            <li
              key={f.path}
              className={`flex items-center gap-2 font-mono text-xs ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}
            >
              <FileText className="h-3 w-3 opacity-60" />
              <span className="truncate">{f.path}</span>
              {f.size != null && (
                <span className={isDark ? 'text-zinc-600' : 'text-zinc-400'}>{Math.round(f.size / 102.4) / 10} KB</span>
              )}
            </li>
          ))}
        </ul>
        <div
          className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] ${
            isDark ? 'text-zinc-500' : 'text-zinc-500'
          }`}
        >
          <span>
            {(detail.files ?? []).length} files · {Math.round(totalBytes / 102.4) / 10} KB
          </span>
          {detail.updatedAt && <span>· {localizedTimeAgo(detail.updatedAt, t)}</span>}
        </div>
      </div>
    </div>
  );
}

function EmptyState({ isDark, onNew }: { isDark: boolean; onNew: (mode?: DraftInputMode) => void }) {
  const { t } = useI18n();
  const cards = [
    {
      mode: 'plain' as const,
      icon: ClipboardList,
      title: t('evolution.studio.skills.authoring.guideCards.intentTitle'),
      body: t('evolution.studio.skills.authoring.guideCards.intentBody'),
    },
    {
      mode: 'script' as const,
      icon: Terminal,
      title: t('evolution.studio.skills.authoring.guideCards.scriptTitle'),
      body: t('evolution.studio.skills.authoring.guideCards.scriptBody'),
    },
    {
      mode: 'doc' as const,
      icon: Paperclip,
      title: t('evolution.studio.skills.authoring.guideCards.refsTitle'),
      body: t('evolution.studio.skills.authoring.guideCards.refsBody'),
    },
    {
      mode: 'api' as const,
      icon: ShieldCheck,
      title: t('evolution.studio.skills.authoring.guideCards.reviewTitle'),
      body: t('evolution.studio.skills.authoring.guideCards.reviewBody'),
    },
  ];
  // release201 v2.0.8 F-bug — hero card 内冗余 "+ 新建技能" 按钮已删除。
  // banner 顶部 always-visible 的 [data-testid="studio-new-skill"] 按钮 +
  // 下方 4 张 source kind card (`onClick={() => onNew(card.mode)}`) 已覆盖
  // onNew 入口。重复 Button 是视觉噪音，会让用户怀疑两个按钮含义不同。
  return (
    <div className={`rounded-2xl px-6 py-7 ${glass(isDark, 'base')}`}>
      <div className="mx-auto max-w-4xl">
        <div className="flex flex-col gap-2">
          <div className="max-w-2xl">
            <div
              className={`mb-3 inline-flex h-10 w-10 items-center justify-center rounded-xl ${
                isDark ? 'bg-violet-500/15 text-violet-300' : 'bg-violet-50 text-violet-700'
              }`}
            >
              <GitBranch className="h-5 w-5" />
            </div>
            <p className={`text-base font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
              {t('evolution.studio.skills.authoring.noSkillsTitle')}
            </p>
            <p className={`mt-1 text-sm leading-relaxed ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
              {t('evolution.studio.skills.authoring.noSkillsBody')}
            </p>
          </div>
        </div>

        {/* release201/24 §UX — concept priming: draft → eval → publish journey. */}
        <JourneyLegend isDark={isDark} />

        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {cards.map((card) => {
            const Icon = card.icon;
            return (
              <motion.button
                key={card.title}
                type="button"
                onClick={() => onNew(card.mode)}
                whileHover={{ y: -3 }}
                whileTap={{ scale: 0.98 }}
                transition={springSnap}
                aria-label={`${card.title} — ${t('evolution.studio.skills.authoring.guideCards.startHere')}`}
                className={`group relative rounded-xl border p-3 text-left ${glass(isDark, 'subtle')} ${
                  isDark ? 'hover:bg-white/[0.06]' : 'hover:bg-white'
                }`}
              >
                {/* arrow only on hover — removes the 4× repeated "从这里开始 →" noise */}
                <ArrowRight
                  className={`absolute right-3 top-3 h-3.5 w-3.5 opacity-0 transition-all group-hover:translate-x-0.5 group-hover:opacity-100 ${
                    isDark ? 'text-violet-300' : 'text-violet-600'
                  }`}
                  aria-hidden
                />
                <Icon className={`mb-2 h-4 w-4 ${isDark ? 'text-violet-300' : 'text-violet-600'}`} />
                <p className={`text-sm font-medium ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>{card.title}</p>
                <p className={`mt-1 text-xs leading-relaxed ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                  {card.body}
                </p>
              </motion.button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// release201/24 §UX — draft → eval → publish concept primer. Three captioned
// steps with arrows so a first-time user understands the journey before they
// start.
function JourneyLegend({ isDark }: { isDark: boolean }) {
  const { t } = useI18n();
  const steps = [
    {
      label: t('evolution.studio.skills.authoring.journey.draftLabel'),
      hint: t('evolution.studio.skills.authoring.journey.draftHint'),
    },
    {
      label: t('evolution.studio.skills.authoring.journey.evalLabel'),
      hint: t('evolution.studio.skills.authoring.journey.evalHint'),
    },
    {
      label: t('evolution.studio.skills.authoring.journey.publishLabel'),
      hint: t('evolution.studio.skills.authoring.journey.publishHint'),
    },
  ];
  return (
    <div className={`mt-5 rounded-xl border p-3 ${glass(isDark, 'subtle')}`} data-testid="authoring-journey">
      <p className={`mb-2 text-[10px] font-semibold uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
        {t('evolution.studio.skills.authoring.journey.title')}
      </p>
      <ol className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
        {steps.map((s, i) => (
          <li key={s.label} className="flex flex-1 items-start gap-2">
            <span
              className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                isDark ? 'bg-violet-500/15 text-violet-300' : 'bg-violet-100 text-violet-700'
              }`}
            >
              {i + 1}
            </span>
            <div className="min-w-0">
              <p className={`text-xs font-semibold ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>{s.label}</p>
              <p className={`text-[11px] leading-snug ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>{s.hint}</p>
            </div>
            {i < steps.length - 1 && (
              <ArrowRight className={`mt-1 hidden h-3.5 w-3.5 shrink-0 sm:block ${isDark ? 'text-zinc-700' : 'text-zinc-300'}`} />
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

function ListPlaceholder({
  isDark,
  text,
  icon,
  tone,
}: {
  isDark: boolean;
  text: string;
  icon?: React.ReactNode;
  tone?: 'error';
}) {
  return (
    <div
      className={`flex items-center justify-center gap-2 rounded-2xl px-5 py-8 text-center text-xs ${
        tone === 'error'
          ? isDark
            ? 'border border-red-500/20 bg-red-500/[0.06] text-red-300'
            : 'border border-red-200 bg-red-50 text-red-700'
          : `${glass(isDark, 'base')} ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`
      }`}
    >
      {icon}
      <span>{text}</span>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────

function normalizeStatus(skill: SkillRow): StatusFilter {
  const raw = (skill.status ?? '').toLowerCase();
  if (raw === 'published') return 'published';
  if (raw === 'review') return 'review';
  if (raw === 'in_eval' || raw === 'eval') return 'in_eval';
  return 'draft';
}

function countByStatus(skills: SkillRow[]): Record<StatusFilter, number> {
  const out: Record<StatusFilter, number> = {
    all: skills.length,
    draft: 0,
    in_eval: 0,
    review: 0,
    published: 0,
  };
  for (const s of skills) out[normalizeStatus(s)] += 1;
  return out;
}
