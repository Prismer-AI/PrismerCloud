'use client';

/**
 * Skills · Lifecycle sub-tab — release201/13 §3.3 (S22).
 *
 * Compose:
 *   - SkillSelector (workspace skills in draft|eval|review|published)
 *   - PipelineRail (11 sub-stages, derived from metadata.lifecycleSubStage)
 *   - EvidencePanel (9 sections + reviewer toolbar)
 *   - SkillEvalProgress (only while lifecycleStage === 'eval' with active run)
 *   - SessionLinks (business / dev / test / review IMConversations)
 *   - PublishControls (stage-aware action row)
 *   - SnapshotShareModal (lazy)
 *
 * SSE: subscribes to /api/im/sync/stream and re-fetches the active skill
 * detail when skill.authoring.state_changed / validation_completed /
 * smoke_completed fires for the current skillId. We avoid a separate
 * polling loop because the channel already keeps the UI fresh.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Loader2, RefreshCw } from 'lucide-react';
import { useI18n } from '@/contexts/i18n-context';
import { glass } from '../../helpers';
import { PipelineRail } from '../lifecycle/pipeline-rail';
import { EvidencePanel, type ReviewerAction } from '../lifecycle/evidence-panel';
import { FlowingDraftBall } from '../lifecycle/flowing-draft-ball';
import { PublishControls } from '../lifecycle/publish-controls';
import { SessionLinks } from '../lifecycle/session-links';
import { SkillEvalProgress } from '../lifecycle/skill-eval-progress';
import { SkillSuccessRateCurve } from '../lifecycle/skill-success-rate-curve';
import { SnapshotShareModal } from '../lifecycle/snapshot-share-modal';
import {
  grammarAccentClasses,
  motionPreset,
  motionReduced,
  spatialGrammar,
  springLiquid,
} from '@/app/workspace/lib/design';
import {
  type EvalRunStatus,
  type SkillDetail,
  type SkillRow,
  LIFECYCLE_PIPELINE_STAGES,
  deriveLifecycleSubStage,
  fetchEvalRun,
  fetchSkillDetail,
  fetchWorkspaceSkillsByStage,
  promoteSkill,
  startEvalRun,
} from '../types';

interface LifecycleViewProps {
  isDark: boolean;
  workspaceId: string | null;
  draftId: string | null;
  onDraftChange: (id: string | null) => void;
}

export function LifecycleView({ isDark, workspaceId, draftId, onDraftChange }: LifecycleViewProps) {
  const { t } = useI18n();
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [skill, setSkill] = useState<SkillDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [evalRun, setEvalRun] = useState<EvalRunStatus | null>(null);
  const [snapshotOpen, setSnapshotOpen] = useState(false);
  const [actionBusy, setActionBusy] = useState<ReviewerAction | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reloadList = useCallback(async () => {
    setLoadingList(true);
    setError(null);
    try {
      const rows = await fetchWorkspaceSkillsByStage(workspaceId);
      setSkills(rows);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingList(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void reloadList();
  }, [reloadList]);

  // Detail fetch on skill change.
  useEffect(() => {
    if (!draftId) {
      setSkill(null);
      setEvalRun(null);
      return;
    }
    let cancelled = false;
    setLoadingDetail(true);
    void fetchSkillDetail(draftId).then((d) => {
      if (cancelled) return;
      setSkill(d);
      setLoadingDetail(false);
      const runId = d?.metadata?.activeEvalRunId;
      if (runId && d?.id) {
        void fetchEvalRun(d.id, runId).then((r) => {
          if (!cancelled) setEvalRun(r);
        });
      } else {
        setEvalRun(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [draftId]);

  // SSE subscription — re-fetch on skill.authoring.* events for the active skill.
  const skillRef = useRef<string | null>(null);
  skillRef.current = draftId;
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const token = (() => {
      try {
        const auth = JSON.parse(localStorage.getItem('prismer_auth') ?? '{}');
        if (auth?.token) return auth.token as string;
      } catch {
        /* swallow */
      }
      return localStorage.getItem('prismer_active_api_key');
    })();
    if (!token) return;
    let es: EventSource | null = null;
    try {
      es = new EventSource(`/api/im/sync/stream?token=${encodeURIComponent(token)}`);
    } catch {
      return;
    }
    const onMessage = (ev: MessageEvent) => {
      try {
        const payload = JSON.parse(ev.data);
        const type: string | undefined = payload?.type ?? payload?.event;
        if (!type || !type.startsWith('skill.authoring.')) return;
        const skillId = payload?.data?.skillId ?? payload?.skillId;
        if (skillId && skillId !== skillRef.current) return;
        // Re-fetch detail + eval run snapshot.
        if (skillRef.current) {
          void fetchSkillDetail(skillRef.current).then((d) => {
            setSkill(d);
            const runId = d?.metadata?.activeEvalRunId;
            if (runId && d?.id) {
              void fetchEvalRun(d.id, runId).then((r) => setEvalRun(r));
            }
          });
        }
      } catch {
        /* swallow */
      }
    };
    es.addEventListener('message', onMessage);
    return () => {
      es?.removeEventListener('message', onMessage);
      es?.close();
    };
  }, []);

  const activeSubStage = useMemo(() => deriveLifecycleSubStage(skill), [skill]);

  const handleReviewerAction = useCallback(
    async (action: ReviewerAction) => {
      if (!skill) return;
      setActionBusy(action);
      setReviewError(null);
      let result: { ok: boolean; error?: string } | null = null;
      switch (action) {
        case 'request-changes':
          result = await promoteSkill(skill.id, 'draft', 'reviewer requested changes');
          break;
        case 'rerun-validation':
          // Re-trigger the validation gates by bouncing through eval.
          result = await promoteSkill(skill.id, 'eval', 'reviewer requested re-validation');
          break;
        case 'rerun-smoke':
          result = await startEvalRun(skill.id, []);
          if (result?.ok) result = { ok: true };
          break;
        case 'edit-publish-scope':
          // No-op here — the PublishControls section owns the scope form.
          result = { ok: true };
          break;
        case 'cancel':
          result = await promoteSkill(skill.id, 'archived', 'reviewer cancelled');
          break;
        case 'approve-publish':
          // No-op here — handled in PublishControls form so reviewer can see
          // scope/changelog before committing.
          result = { ok: true };
          break;
      }
      setActionBusy(null);
      if (result && !result.ok) {
        setReviewError(result.error ?? t('evolution.studio.skills.lifecycle.actionFailed'));
        return;
      }
      void fetchSkillDetail(skill.id).then((d) => setSkill(d));
      void reloadList();
    },
    [skill, reloadList, t],
  );

  // ── Pipeline grammar (doc 13 §3.3 — flowing-draft-ball) ──
  const grammar = spatialGrammar.pipeline;
  const accent = grammarAccentClasses[grammar.accentColor];
  const prefersReducedMotion = useReducedMotion();
  const flowMotion = prefersReducedMotion ? motionReduced : motionPreset.flowDownPipeline;

  return (
    <div data-spatial-grammar="pipeline" data-grammar-accent={grammar.accentColor} className={grammar.layout}>
      <div className={`flex flex-wrap items-center justify-between gap-2 rounded-2xl border px-4 py-3 ${accent.bg}`}>
        <div className="flex min-w-0 items-center gap-3">
          <p className={`text-[10px] font-semibold uppercase tracking-wider ${accent.text}`}>
            {t('evolution.studio.skills.lifecycle.pipelineLabel')}
          </p>
          <SkillSelector isDark={isDark} skills={skills} selectedId={draftId} onChange={onDraftChange} />
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => void reloadList()}
          aria-label={t('evolution.studio.skills.lifecycle.reloadSkills')}
          disabled={loadingList}
        >
          <RefreshCw className={loadingList ? 'animate-spin' : undefined} />
        </Button>
      </div>

      {error && (
        <div
          className={`rounded-2xl px-4 py-3 text-xs ${isDark ? 'border border-rose-500/20 bg-rose-500/[0.06] text-rose-300' : 'border border-rose-200 bg-rose-50 text-rose-700'}`}
        >
          {error}
        </div>
      )}

      {!draftId ? (
        <EmptyState isDark={isDark} hasSkills={skills.length > 0} />
      ) : (
        <>
          {/* Pipeline rail — static capsule row from PipelineRail, with a real
              `FlowingDraftBall` SVG overlay (doc 13 §3.3 / doc 20 §9.2 V1).
              The outer motion.div uses `flowDownPipeline` so the whole rail
              flows in on first paint; the ball itself drives stage transitions
              via `springLiquid` inside FlowingDraftBall. */}
          <motion.div
            data-pane="pipeline-rail"
            initial={flowMotion.initial}
            animate={flowMotion.animate}
            transition={flowMotion.transition}
            className="relative"
          >
            <PipelineRail isDark={isDark} active={activeSubStage} />
            {/* The flowing draft ball — anchored to active capsule (1/N width
                math mirrors PipelineRail's `flex-1` capsules). */}
            <div className="pointer-events-none absolute inset-x-4 top-4 px-1">
              <FlowingDraftBall
                isDark={isDark}
                activeSubStage={activeSubStage}
                subStages={LIFECYCLE_PIPELINE_STAGES}
                reducedMotion={prefersReducedMotion ?? false}
              />
            </div>
            {/* Faint rail tint underlay — keeps the chromatic cyan signal even
                while the ball is mid-transit. */}
            <div
              className={`pointer-events-none absolute inset-x-6 bottom-4 h-px rounded-full opacity-40 ${accent.bg}`}
              style={{ ['--prismer-glow' as string]: accent.glow }}
              aria-hidden
            />
          </motion.div>

          {evalRun && <SkillEvalProgress isDark={isDark} run={evalRun} />}

          <div className="grid gap-4 lg:grid-cols-3">
            <motion.div
              className="lg:col-span-2"
              key={`evidence-${activeSubStage}`}
              initial={prefersReducedMotion ? { opacity: 1 } : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={prefersReducedMotion ? { duration: 0 } : springLiquid}
            >
              <EvidencePanel
                isDark={isDark}
                skill={skill}
                evalRun={evalRun}
                loading={loadingDetail}
                onAction={(a) => void handleReviewerAction(a)}
                actionBusy={actionBusy}
              />
              {reviewError && (
                <p className={`mt-2 text-[11px] ${isDark ? 'text-rose-300' : 'text-rose-600'}`}>{reviewError}</p>
              )}
            </motion.div>
            <div className="space-y-4">
              <PublishControls
                isDark={isDark}
                skill={skill}
                onChanged={() => {
                  if (skill?.id) {
                    void fetchSkillDetail(skill.id).then((d) => setSkill(d));
                  }
                  void reloadList();
                }}
                onOpenSnapshotShare={() => setSnapshotOpen(true)}
              />
              {/* release201/24 §Phase4 — per-revision eval success-rate curve.
                  SSE-refreshed via the same skill detail refetch as the rest
                  of the view (skill.eval.* events trigger fetchSkillDetail). */}
              <SkillSuccessRateCurve isDark={isDark} history={skill?.metadata?.authoring?.draftRevisionHistory} />
              <SessionLinks isDark={isDark} skill={skill} />
            </div>
          </div>
        </>
      )}

      <SnapshotShareModal
        isDark={isDark}
        open={snapshotOpen}
        onOpenChange={setSnapshotOpen}
        skillId={skill?.id ?? null}
      />
    </div>
  );
}

// ─── Skill selector ─────────────────────────────────────────────────

function SkillSelector({
  isDark,
  skills,
  selectedId,
  onChange,
}: {
  isDark: boolean;
  skills: SkillRow[];
  selectedId: string | null;
  onChange: (id: string | null) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <span className={`text-xs font-semibold uppercase tracking-wider ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>
        {t('evolution.studio.skills.lifecycle.skill')}
      </span>
      <select
        value={selectedId ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        data-testid="lifecycle-skill-selector"
        className={`min-w-0 flex-1 rounded-md border px-2 py-1.5 text-xs ${
          isDark ? 'border-white/[0.06] bg-white/[0.04] text-zinc-100' : 'border-zinc-200 bg-white text-zinc-900'
        }`}
      >
        <option value="">{t('evolution.studio.skills.lifecycle.pickSkill')}</option>
        {skills.map((s) => {
          const stage = (s.lifecycleStage ?? s.status ?? '').toLowerCase();
          return (
            <option key={s.id} value={s.id}>
              {s.slug} · {stage || t('evolution.studio.skills.lifecycle.draft')}
            </option>
          );
        })}
      </select>
      {selectedId && (
        <Badge variant="outline" className="text-[10px] font-mono">
          {selectedId.slice(0, 8)}
        </Badge>
      )}
    </div>
  );
}

function EmptyState({ isDark, hasSkills }: { isDark: boolean; hasSkills: boolean }) {
  const { t } = useI18n();
  return (
    <div className={`rounded-2xl px-6 py-12 text-center ${glass(isDark, 'base')}`}>
      <Loader2 className="hidden" />
      <p className={`text-sm font-medium ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
        {hasSkills
          ? t('evolution.studio.skills.lifecycle.emptyPick')
          : t('evolution.studio.skills.lifecycle.emptyNone')}
      </p>
      <p className={`mt-1 text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
        {t('evolution.studio.skills.lifecycle.emptyBody')}
      </p>
    </div>
  );
}
