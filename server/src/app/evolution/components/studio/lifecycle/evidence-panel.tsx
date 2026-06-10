'use client';

/**
 * Evidence Panel — release201/08 §9.2.1 nine-section Review contract,
 * release201/13 §3.3 (S22 implementation).
 *
 * Nine independently-collapsible sections rendered from a single
 * SkillDetail payload (no per-section fetch — keeps the Lifecycle sub-tab
 * to a single round-trip). Sections:
 *
 *   1. Capability summary
 *   2. Source facts
 *   3. Package diff (manifest revision list)
 *   4. Runtime deps
 *   5. Security
 *   6. Validation gates
 *   7. Smoke (eval run results)
 *   8. Sample task
 *   9. Publish plan
 *
 * Each section is its own React component so a reviewer can read sections
 * in order while the others stay open. Six reviewer actions live in the
 * top bar (Request changes / Re-run validation / Re-run smoke / Edit
 * publish scope / Cancel / Approve & Publish) — the parent
 * `lifecycle-view.tsx` wires them via the `onAction` prop.
 */

import { useState } from 'react';
import {
  AlertTriangle,
  Box,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileCode,
  GitBranch,
  ListChecks,
  PlayCircle,
  Rocket,
  ShieldAlert,
  Sparkles,
  XCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { useI18n } from '@/contexts/i18n-context';
import type { EvalRunStatus, SkillDetail } from '../types';

export type ReviewerAction =
  | 'request-changes'
  | 'rerun-validation'
  | 'rerun-smoke'
  | 'edit-publish-scope'
  | 'cancel'
  | 'approve-publish';

interface EvidencePanelProps {
  isDark: boolean;
  skill: SkillDetail | null;
  evalRun?: EvalRunStatus | null;
  loading?: boolean;
  /** When true, reviewer toolbar is shown; read-only fall-back hides it. */
  showReviewerActions?: boolean;
  onAction?: (action: ReviewerAction) => void;
  actionBusy?: ReviewerAction | null;
}

export function EvidencePanel({
  isDark,
  skill,
  evalRun,
  loading,
  showReviewerActions = true,
  onAction,
  actionBusy,
}: EvidencePanelProps) {
  const { t } = useI18n();
  if (loading) {
    return (
      <div
        className={`rounded-2xl border p-6 text-center text-xs ${
          isDark ? 'border-white/[0.06] bg-white/[0.02] text-zinc-500' : 'border-zinc-200 bg-white text-zinc-500'
        }`}
      >
        {t('evolution.studio.lifecycle.evidence.loading')}
      </div>
    );
  }
  if (!skill) {
    return (
      <div
        className={`rounded-2xl border p-6 text-center text-xs ${
          isDark ? 'border-white/[0.06] bg-white/[0.02] text-zinc-500' : 'border-zinc-200 bg-white text-zinc-500'
        }`}
      >
        {t('evolution.studio.lifecycle.evidence.pickSkill')}
      </div>
    );
  }

  return (
    <div data-testid="evidence-panel" className="space-y-3">
      {showReviewerActions && <ReviewerToolbar isDark={isDark} onAction={onAction} actionBusy={actionBusy} />}

      <CapabilitySummarySection isDark={isDark} skill={skill} />
      <SourceFactsSection isDark={isDark} skill={skill} />
      <PackageDiffSection isDark={isDark} skill={skill} />
      <RuntimeDepsSection isDark={isDark} skill={skill} />
      <SecuritySection isDark={isDark} skill={skill} />
      <ValidationSection isDark={isDark} skill={skill} />
      <SmokeSection isDark={isDark} skill={skill} evalRun={evalRun ?? null} />
      <SampleTaskSection isDark={isDark} skill={skill} />
      <PublishPlanSection isDark={isDark} skill={skill} />
    </div>
  );
}

// ─── Toolbar ────────────────────────────────────────────────────────

function ReviewerToolbar({
  isDark,
  onAction,
  actionBusy,
}: {
  isDark: boolean;
  onAction?: (action: ReviewerAction) => void;
  actionBusy?: ReviewerAction | null;
}) {
  const { t } = useI18n();
  const baseBtn = isDark
    ? 'border border-white/[0.06] bg-white/[0.03] text-zinc-200 hover:bg-white/[0.06]'
    : 'border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50';
  const primary = isDark
    ? 'bg-emerald-500/90 text-white hover:bg-emerald-500'
    : 'bg-emerald-600 text-white hover:bg-emerald-700';
  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-2 rounded-2xl border p-3 ${
        isDark ? 'border-white/[0.06] bg-white/[0.02]' : 'border-zinc-200 bg-white'
      }`}
      data-testid="evidence-reviewer-toolbar"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <ToolbarButton
          label={t('evolution.studio.lifecycle.evidence.requestChanges')}
          onClick={() => onAction?.('request-changes')}
          busy={actionBusy === 'request-changes'}
          className={baseBtn}
        />
        <ToolbarButton
          label={t('evolution.studio.lifecycle.evidence.rerunValidation')}
          onClick={() => onAction?.('rerun-validation')}
          busy={actionBusy === 'rerun-validation'}
          className={baseBtn}
        />
        <ToolbarButton
          label={t('evolution.studio.lifecycle.evidence.rerunSmoke')}
          onClick={() => onAction?.('rerun-smoke')}
          busy={actionBusy === 'rerun-smoke'}
          className={baseBtn}
        />
        <ToolbarButton
          label={t('evolution.studio.lifecycle.evidence.editPublishScope')}
          onClick={() => onAction?.('edit-publish-scope')}
          busy={actionBusy === 'edit-publish-scope'}
          className={baseBtn}
        />
        <ToolbarButton
          label={t('common.cancel')}
          onClick={() => onAction?.('cancel')}
          busy={actionBusy === 'cancel'}
          className={baseBtn}
        />
      </div>
      <ToolbarButton
        label={t('evolution.studio.lifecycle.evidence.approvePublish')}
        onClick={() => onAction?.('approve-publish')}
        busy={actionBusy === 'approve-publish'}
        className={primary}
        testId="evidence-approve-publish"
      />
    </div>
  );
}

function ToolbarButton({
  label,
  onClick,
  busy,
  className,
  testId,
}: {
  label: string;
  onClick: () => void;
  busy?: boolean;
  className: string;
  testId?: string;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      data-testid={testId}
      className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${className}`}
    >
      {busy ? t('evolution.studio.lifecycle.evidence.working') : label}
    </button>
  );
}

// ─── Section shell ──────────────────────────────────────────────────

function Section({
  isDark,
  testId,
  icon,
  title,
  badge,
  children,
  defaultOpen = true,
}: {
  isDark: boolean;
  testId: string;
  icon: React.ReactNode;
  title: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section
      data-testid={testId}
      className={`rounded-2xl border ${isDark ? 'border-white/[0.06] bg-white/[0.02]' : 'border-zinc-200 bg-white'}`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex w-full items-center justify-between gap-3 px-4 py-3 text-left ${
          isDark ? 'hover:bg-white/[0.02]' : 'hover:bg-zinc-50'
        }`}
        aria-expanded={open}
      >
        <span className="flex items-center gap-2">
          <span className={isDark ? 'text-violet-300' : 'text-violet-600'}>{icon}</span>
          <span className={`text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>{title}</span>
          {badge}
        </span>
        {open ? <ChevronDown className="h-4 w-4 opacity-60" /> : <ChevronRight className="h-4 w-4 opacity-60" />}
      </button>
      {open && <div className={`px-4 pb-4 text-xs ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>{children}</div>}
    </section>
  );
}

// ─── 1. Capability summary ──────────────────────────────────────────

function CapabilitySummarySection({ isDark, skill }: { isDark: boolean; skill: SkillDetail }) {
  const { t } = useI18n();
  const summary = skill.metadata?.skillJson?.description ?? skill.description;
  const intent = (skill.metadata as any)?.skillJson?.category ?? '—';
  const provenanceKind = skill.metadata?.skillJson?.provenance?.sourceKind ?? '—';
  return (
    <Section
      isDark={isDark}
      testId="evidence-section-capability"
      icon={<Sparkles className="h-3.5 w-3.5" />}
      title={t('evolution.studio.lifecycle.evidence.capabilitySummary')}
    >
      <p className="leading-relaxed">{summary || t('evolution.studio.lifecycle.evidence.noDescription')}</p>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
        <div>
          <dt className={`uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
            {t('evolution.studio.lifecycle.evidence.intent')}
          </dt>
          <dd className="font-mono">{intent}</dd>
        </div>
        <div>
          <dt className={`uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
            {t('evolution.studio.lifecycle.evidence.sourceKind')}
          </dt>
          <dd className="font-mono">{provenanceKind}</dd>
        </div>
      </dl>
    </Section>
  );
}

// ─── 2. Source facts ────────────────────────────────────────────────

function SourceFactsSection({ isDark, skill }: { isDark: boolean; skill: SkillDetail }) {
  const { t } = useI18n();
  const refs = skill.metadata?.skillJson?.provenance?.sourceRefs ?? [];
  return (
    <Section
      isDark={isDark}
      testId="evidence-section-source"
      icon={<FileCode className="h-3.5 w-3.5" />}
      title={t('evolution.studio.lifecycle.evidence.sourceFacts')}
      badge={
        <Badge variant="outline" className="text-[10px]">
          {t('evolution.studio.lifecycle.evidence.refCount', {
            count: refs.length,
            suffix: refs.length === 1 ? '' : 's',
          })}
        </Badge>
      }
    >
      {refs.length === 0 ? (
        <p className="italic opacity-70">{t('evolution.studio.lifecycle.evidence.noSourceRefs')}</p>
      ) : (
        <ul className="space-y-1.5">
          {refs.map((ref, i) => (
            <li
              key={i}
              className={`rounded-md border px-2 py-1.5 ${isDark ? 'border-white/[0.04]' : 'border-zinc-100'}`}
            >
              <div className="font-mono text-[11px]">{ref.url ?? ref.path ?? ref.label ?? `ref-${i}`}</div>
              {ref.kind && <div className="opacity-60">{ref.kind}</div>}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// ─── 3. Package diff ────────────────────────────────────────────────

function PackageDiffSection({ isDark, skill }: { isDark: boolean; skill: SkillDetail }) {
  const { t } = useI18n();
  const files: Array<{ path: string; size?: number }> = (() => {
    if (skill.files && skill.files.length > 0) return skill.files;
    if (typeof skill.contentManifest === 'string') {
      try {
        const parsed = JSON.parse(skill.contentManifest);
        if (Array.isArray(parsed)) return parsed;
        if (Array.isArray(parsed.files)) return parsed.files;
      } catch {
        /* swallow */
      }
    }
    return [];
  })();
  return (
    <Section
      isDark={isDark}
      testId="evidence-section-diff"
      icon={<GitBranch className="h-3.5 w-3.5" />}
      title={t('evolution.studio.lifecycle.evidence.packageDiff')}
      badge={
        <Badge variant="outline" className="text-[10px] font-mono">
          {skill.contentManifestRevision?.slice(0, 7) ?? t('evolution.studio.lifecycle.evidence.noRevision')}
        </Badge>
      }
    >
      {files.length === 0 ? (
        <p className="italic opacity-70">{t('evolution.studio.lifecycle.evidence.noFiles')}</p>
      ) : (
        <ul className="space-y-1">
          {files.slice(0, 20).map((f) => (
            <li key={f.path} className="flex items-center gap-2 font-mono text-[11px]">
              <span className="truncate">{f.path}</span>
              {typeof f.size === 'number' && (
                <span className={isDark ? 'text-zinc-600' : 'text-zinc-400'}>{Math.round(f.size / 102.4) / 10} KB</span>
              )}
            </li>
          ))}
          {files.length > 20 && (
            <li className={`italic ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
              {t('evolution.studio.lifecycle.evidence.moreFiles', { count: files.length - 20 })}
            </li>
          )}
        </ul>
      )}
    </Section>
  );
}

// ─── 4. Runtime deps ────────────────────────────────────────────────

function RuntimeDepsSection({ isDark, skill }: { isDark: boolean; skill: SkillDetail }) {
  const { t } = useI18n();
  const requires = skill.metadata?.skillJson?.runtime?.requires ?? skill.requires ?? {};
  const rows: Array<{ label: string; values: string[] }> = [
    { label: 'env', values: requires.env ?? [] },
    { label: 'bins', values: requires.bins ?? [] },
    { label: 'python', values: requires.python ? [requires.python] : [] },
    { label: 'node', values: requires.node ? [requires.node] : [] },
    { label: 'capabilities', values: requires.capabilities ?? [] },
  ].filter((r) => r.values.length > 0);
  return (
    <Section
      isDark={isDark}
      testId="evidence-section-runtime"
      icon={<Box className="h-3.5 w-3.5" />}
      title={t('evolution.studio.lifecycle.evidence.runtimeDeps')}
      badge={
        <Badge variant="outline" className="text-[10px]">
          {t('evolution.studio.lifecycle.evidence.blockCount', {
            count: rows.length,
            suffix: rows.length === 1 ? '' : 's',
          })}
        </Badge>
      }
    >
      {rows.length === 0 ? (
        <p className="italic opacity-70">{t('evolution.studio.lifecycle.evidence.noRuntime')}</p>
      ) : (
        <dl className="space-y-1.5">
          {rows.map((row) => (
            <div key={row.label}>
              <dt className={`text-[10px] uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                {row.label}
              </dt>
              <dd className="flex flex-wrap gap-1">
                {row.values.map((v) => (
                  <Badge key={v} variant="secondary" className="font-mono text-[10px]">
                    {v}
                  </Badge>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </Section>
  );
}

// ─── 5. Security ────────────────────────────────────────────────────

function SecuritySection({ isDark, skill }: { isDark: boolean; skill: SkillDetail }) {
  const { t } = useI18n();
  const security = skill.metadata?.skillJson?.security ?? {};
  const risk = (security.riskLevel ?? 'low').toLowerCase();
  const riskTone =
    risk === 'high'
      ? isDark
        ? 'bg-rose-500/15 text-rose-200 border-rose-500/30'
        : 'bg-rose-50 text-rose-700 border-rose-200'
      : risk === 'medium'
        ? isDark
          ? 'bg-amber-500/15 text-amber-200 border-amber-500/30'
          : 'bg-amber-50 text-amber-700 border-amber-200'
        : isDark
          ? 'bg-emerald-500/15 text-emerald-200 border-emerald-500/30'
          : 'bg-emerald-50 text-emerald-700 border-emerald-200';
  return (
    <Section
      isDark={isDark}
      testId="evidence-section-security"
      icon={<ShieldAlert className="h-3.5 w-3.5" />}
      title={t('evolution.studio.lifecycle.evidence.security')}
      badge={
        <Badge className={`text-[10px] uppercase tracking-wider ${riskTone}`}>
          {t('evolution.studio.lifecycle.evidence.risk', { risk })}
        </Badge>
      }
    >
      <div className="space-y-2">
        <div>
          <p className={`mb-1 text-[10px] uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
            {t('evolution.studio.lifecycle.evidence.dataAccess')}
          </p>
          {(security.dataAccess ?? []).length === 0 ? (
            <p className="italic opacity-70">{t('evolution.studio.lifecycle.evidence.noneDeclared')}</p>
          ) : (
            <ul className="flex flex-wrap gap-1">
              {(security.dataAccess ?? []).map((v) => (
                <Badge key={v} variant="secondary" className="font-mono text-[10px]">
                  {v}
                </Badge>
              ))}
            </ul>
          )}
        </div>
        <div>
          <p className={`mb-1 text-[10px] uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
            {t('evolution.studio.lifecycle.evidence.requiresApproval')}
          </p>
          {(security.humanApprovalRequiredFor ?? []).length === 0 ? (
            <p className="italic opacity-70">{t('evolution.studio.lifecycle.evidence.none')}</p>
          ) : (
            <ul className="flex flex-wrap gap-1">
              {(security.humanApprovalRequiredFor ?? []).map((v) => (
                <Badge key={v} variant="outline" className="font-mono text-[10px]">
                  {v}
                </Badge>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Section>
  );
}

// ─── 6. Validation ──────────────────────────────────────────────────

function ValidationSection({ isDark, skill }: { isDark: boolean; skill: SkillDetail }) {
  const { t } = useI18n();
  const warnings = skill.metadata?.validationWarnings ?? [];
  // 7 validation gates per release201/07 §2.7 — we display each with status.
  const GATES = [
    'skill-json',
    'duplicate',
    'forbidden-pattern',
    'security-budget',
    'runtime-resolve',
    'sample-task',
    'reviewer-distinct',
  ];
  const warningByGate = new Map<string, { severity?: string; message: string }>();
  for (const w of warnings) warningByGate.set(w.gate, w);

  return (
    <Section
      isDark={isDark}
      testId="evidence-section-validation"
      icon={<ListChecks className="h-3.5 w-3.5" />}
      title={t('evolution.studio.lifecycle.evidence.validation')}
      badge={
        <Badge variant="outline" className="text-[10px]">
          {t('evolution.studio.lifecycle.evidence.cleanCount', {
            clean: GATES.length - warnings.length,
            total: GATES.length,
          })}
        </Badge>
      }
    >
      <ul className="space-y-1">
        {GATES.map((gate) => {
          const w = warningByGate.get(gate);
          const passed = !w;
          const sev = w?.severity ?? (passed ? 'pass' : 'warning');
          return (
            <li
              key={gate}
              className="flex items-center gap-2 rounded-md px-1 py-1 font-mono text-[11px]"
              data-gate-key={gate}
              data-gate-status={passed ? 'pass' : sev}
            >
              {passed ? (
                <CheckCircle2 className={`h-3.5 w-3.5 ${isDark ? 'text-emerald-300' : 'text-emerald-600'}`} />
              ) : sev === 'error' ? (
                <XCircle className={`h-3.5 w-3.5 ${isDark ? 'text-rose-300' : 'text-rose-600'}`} />
              ) : (
                <AlertTriangle className={`h-3.5 w-3.5 ${isDark ? 'text-amber-300' : 'text-amber-600'}`} />
              )}
              <span className="truncate">{gate}</span>
              {!passed && <span className={`truncate text-[10px] opacity-70`}>{w?.message}</span>}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

// ─── 7. Smoke (eval run) ────────────────────────────────────────────

function SmokeSection({
  isDark,
  skill,
  evalRun,
}: {
  isDark: boolean;
  skill: SkillDetail;
  evalRun: EvalRunStatus | null;
}) {
  const { t } = useI18n();
  void skill;
  const passed = evalRun?.passCount ?? 0;
  const failed = evalRun?.failCount ?? 0;
  const total = passed + failed;
  return (
    <Section
      isDark={isDark}
      testId="evidence-section-smoke"
      icon={<PlayCircle className="h-3.5 w-3.5" />}
      title={t('evolution.studio.lifecycle.evidence.smoke')}
      badge={
        <Badge variant="outline" className="text-[10px]">
          {evalRun
            ? t('evolution.studio.lifecycle.evidence.passedCount', { passed, total })
            : t('evolution.studio.lifecycle.evidence.noRun')}
        </Badge>
      }
    >
      {!evalRun ? (
        <p className="italic opacity-70">{t('evolution.studio.lifecycle.evidence.noEvalRun')}</p>
      ) : (
        <>
          <p className="text-[11px] opacity-70">
            {t('evolution.studio.lifecycle.evidence.runStatus', {
              runId: evalRun.runId.slice(0, 12),
              status: evalRun.status,
            })}
            {evalRun.agentTraceUrl && (
              <>
                {' · '}
                <a
                  href={evalRun.agentTraceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className={`underline ${isDark ? 'text-violet-300' : 'text-violet-700'}`}
                >
                  {t('evolution.studio.lifecycle.evidence.agentTrace')}
                </a>
              </>
            )}
          </p>
          {evalRun.results && evalRun.results.length > 0 && (
            <ul className="mt-2 space-y-1">
              {evalRun.results.map((r) => (
                <li key={r.id} className="flex items-start gap-2 font-mono text-[11px]">
                  {r.passed ? (
                    <CheckCircle2
                      className={`h-3.5 w-3.5 shrink-0 ${isDark ? 'text-emerald-300' : 'text-emerald-600'}`}
                    />
                  ) : (
                    <XCircle className={`h-3.5 w-3.5 shrink-0 ${isDark ? 'text-rose-300' : 'text-rose-600'}`} />
                  )}
                  <span className="truncate">{r.id}</span>
                  {r.durationMs != null && <span className="opacity-60">{r.durationMs}ms</span>}
                  {r.error && <span className="truncate opacity-70">{r.error}</span>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Section>
  );
}

// ─── 8. Sample task ─────────────────────────────────────────────────

function SampleTaskSection({ isDark, skill }: { isDark: boolean; skill: SkillDetail }) {
  const { t } = useI18n();
  const sample = skill.metadata?.skillJson?.sampleTasks ?? [];
  const sampleTaskId = skill.metadata?.sampleTaskId;
  return (
    <Section
      isDark={isDark}
      testId="evidence-section-sample"
      icon={<Sparkles className="h-3.5 w-3.5" />}
      title={t('evolution.studio.lifecycle.evidence.sampleTask')}
      badge={
        <Badge variant="outline" className="text-[10px]">
          {t('evolution.studio.lifecycle.evidence.templateCount', {
            count: sample.length,
            suffix: sample.length === 1 ? '' : 's',
          })}
        </Badge>
      }
    >
      {sample.length === 0 ? (
        <p className="italic opacity-70">{t('evolution.studio.lifecycle.evidence.noSampleTasks')}</p>
      ) : (
        <ul className="space-y-1.5">
          {sample.map((s, i) => (
            <li
              key={i}
              className={`rounded-md border px-2 py-1.5 ${isDark ? 'border-white/[0.04]' : 'border-zinc-100'}`}
            >
              <div className="text-[11px] font-semibold">{s.title}</div>
              {s.description && <div className="opacity-70">{s.description}</div>}
            </li>
          ))}
        </ul>
      )}
      {sampleTaskId && (
        <p className={`mt-2 text-[10px] font-mono ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
          {t('evolution.studio.lifecycle.evidence.linkedTask', { taskId: sampleTaskId.slice(0, 16) })}
        </p>
      )}
    </Section>
  );
}

// ─── 9. Publish plan ────────────────────────────────────────────────

function PublishPlanSection({ isDark, skill }: { isDark: boolean; skill: SkillDetail }) {
  const { t } = useI18n();
  const plan = skill.metadata?.publishPlan ?? {};
  return (
    <Section
      isDark={isDark}
      testId="evidence-section-publish-plan"
      icon={<Rocket className="h-3.5 w-3.5" />}
      title={t('evolution.studio.lifecycle.evidence.publishPlan')}
    >
      <dl className="grid grid-cols-2 gap-2 text-[11px]">
        <div>
          <dt className={`uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
            {t('evolution.studio.lifecycle.evidence.scope')}
          </dt>
          <dd className="font-mono">{plan.scope ?? skill.publishScope ?? '—'}</dd>
        </div>
        <div>
          <dt className={`uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
            {t('evolution.studio.lifecycle.evidence.version')}
          </dt>
          <dd className="font-mono">{plan.version ?? '—'}</dd>
        </div>
        <div className="col-span-2">
          <dt className={`uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
            {t('evolution.studio.lifecycle.evidence.changelog')}
          </dt>
          <dd className="whitespace-pre-wrap text-[11px] leading-relaxed">{plan.changelog ?? '—'}</dd>
        </div>
        <div className="col-span-2">
          <dt className={`uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
            {t('evolution.studio.lifecycle.evidence.installTargets')}
          </dt>
          <dd className="flex flex-wrap gap-1">
            {(plan.installTargets ?? []).length === 0 ? (
              <span className="italic opacity-70">—</span>
            ) : (
              (plan.installTargets ?? []).map((t) => (
                <Badge key={t} variant="secondary" className="font-mono text-[10px]">
                  {t}
                </Badge>
              ))
            )}
          </dd>
        </div>
      </dl>
    </Section>
  );
}
