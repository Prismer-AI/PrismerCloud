'use client';

/**
 * Publish controls — release201/08 §9.5, release201/13 §3.3 (S22).
 *
 * Phase-specific transitions:
 *   - draft → eval         "Promote to Eval"
 *   - eval  → review       "Promote to Review"
 *   - review → published   "Publish" (via publish-template endpoint)
 *   - any   → archived     "Archive" (revoke)
 *
 * Publish form lets the reviewer choose scope (private/workspace/org/community)
 * + license + changelog before firing publish-template. Snapshot share button
 * surfaces below the action row once status='published'.
 */

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/contexts/i18n-context';
import { type SkillDetail, promoteSkill, publishSkill, startEvalRun } from '../types';

interface PublishControlsProps {
  isDark: boolean;
  skill: SkillDetail | null;
  onChanged?: () => void;
  onOpenSnapshotShare?: () => void;
}

export function PublishControls({ isDark, skill, onChanged, onOpenSnapshotShare }: PublishControlsProps) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<'workspace' | 'org' | 'community'>('workspace');
  const [license, setLicense] = useState('MIT');
  const [changelog, setChangelog] = useState('Initial release.');

  if (!skill) return null;

  const stage = (skill.lifecycleStage ?? skill.status ?? 'draft').toLowerCase();
  const run = async (label: string, fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(label);
    setError(null);
    const result = await fn();
    setBusy(null);
    if (!result.ok) setError(result.error ?? t('evolution.studio.lifecycle.publishControls.operationFailed'));
    else onChanged?.();
  };

  return (
    <section
      data-testid="lifecycle-publish-controls"
      className={`rounded-2xl border p-4 ${
        isDark ? 'border-white/[0.06] bg-white/[0.02]' : 'border-zinc-200 bg-white'
      }`}
    >
      <h4
        className={`mb-3 text-xs font-semibold uppercase tracking-wider ${isDark ? 'text-zinc-300' : 'text-zinc-600'}`}
      >
        {t('evolution.studio.lifecycle.publishControls.title')}
      </h4>

      {stage === 'draft' && (
        <Button
          size="sm"
          onClick={() => run('eval', () => promoteSkill(skill.id, 'eval'))}
          disabled={busy !== null}
          data-testid="publish-control-promote-eval"
        >
          {busy === 'eval'
            ? t('evolution.studio.lifecycle.publishControls.promoting')
            : t('evolution.studio.lifecycle.publishControls.promoteToEval')}
        </Button>
      )}

      {stage === 'eval' && (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            onClick={() => run('start-eval', () => startEvalRun(skill.id, []))}
            disabled={busy !== null}
            data-testid="publish-control-start-eval"
          >
            {busy === 'start-eval'
              ? t('evolution.studio.lifecycle.publishControls.starting')
              : t('evolution.studio.lifecycle.publishControls.startEvalRun')}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => run('review', () => promoteSkill(skill.id, 'review'))}
            disabled={busy !== null}
            data-testid="publish-control-promote-review"
          >
            {busy === 'review'
              ? t('evolution.studio.lifecycle.publishControls.promoting')
              : t('evolution.studio.lifecycle.publishControls.promoteToReview')}
          </Button>
        </div>
      )}

      {stage === 'review' && (
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <label className="text-[11px]">
              <span className={`mb-1 block uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                {t('evolution.studio.lifecycle.publishControls.scope')}
              </span>
              <select
                value={scope}
                onChange={(e) => setScope(e.target.value as typeof scope)}
                className={`w-full rounded-md border px-2 py-1 text-xs ${
                  isDark
                    ? 'border-white/[0.06] bg-white/[0.04] text-zinc-100'
                    : 'border-zinc-200 bg-white text-zinc-900'
                }`}
              >
                <option value="workspace">{t('evolution.studio.lifecycle.publishControls.scopeWorkspace')}</option>
                <option value="org">{t('evolution.studio.lifecycle.publishControls.scopeOrg')}</option>
                <option value="community">{t('evolution.studio.lifecycle.publishControls.scopeCommunity')}</option>
              </select>
            </label>
            <label className="text-[11px]">
              <span className={`mb-1 block uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                {t('evolution.studio.lifecycle.publishControls.license')}
              </span>
              <input
                type="text"
                value={license}
                onChange={(e) => setLicense(e.target.value)}
                className={`w-full rounded-md border px-2 py-1 text-xs ${
                  isDark
                    ? 'border-white/[0.06] bg-white/[0.04] text-zinc-100'
                    : 'border-zinc-200 bg-white text-zinc-900'
                }`}
              />
            </label>
            <label className="text-[11px] sm:col-span-1">
              <span className={`mb-1 block uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                {t('evolution.studio.lifecycle.publishControls.boilerplateTask')}
              </span>
              <select
                defaultValue="true"
                className={`w-full rounded-md border px-2 py-1 text-xs ${
                  isDark
                    ? 'border-white/[0.06] bg-white/[0.04] text-zinc-100'
                    : 'border-zinc-200 bg-white text-zinc-900'
                }`}
              >
                <option value="true">{t('evolution.studio.lifecycle.publishControls.autoCreateSampleTask')}</option>
                <option value="false">{t('evolution.studio.lifecycle.publishControls.skip')}</option>
              </select>
            </label>
          </div>
          <label className="block text-[11px]">
            <span className={`mb-1 block uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
              {t('evolution.studio.lifecycle.publishControls.changelog')}
            </span>
            <textarea
              value={changelog}
              onChange={(e) => setChangelog(e.target.value)}
              rows={3}
              className={`w-full rounded-md border px-2 py-1.5 text-xs ${
                isDark ? 'border-white/[0.06] bg-white/[0.04] text-zinc-100' : 'border-zinc-200 bg-white text-zinc-900'
              }`}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() =>
                run('publish', () =>
                  publishSkill(skill.id, { scope, license, changelog, includeBoilerplateTask: true }),
                )
              }
              disabled={busy !== null}
              data-testid="publish-control-publish"
            >
              {busy === 'publish'
                ? t('evolution.studio.lifecycle.publishControls.publishing')
                : t('evolution.studio.lifecycle.evidence.approvePublish')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => run('rollback', () => promoteSkill(skill.id, 'draft', 'reviewer requested changes'))}
              disabled={busy !== null}
              data-testid="publish-control-rollback"
            >
              {busy === 'rollback'
                ? t('evolution.studio.lifecycle.publishControls.rollingBack')
                : t('evolution.studio.lifecycle.publishControls.rollbackToDraft')}
            </Button>
          </div>
        </div>
      )}

      {stage === 'published' && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => onOpenSnapshotShare?.()} data-testid="publish-control-snapshot">
            {t('evolution.studio.lifecycle.publishControls.createSnapshot')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => run('archive', () => promoteSkill(skill.id, 'archived', 'reviewer archived'))}
            disabled={busy !== null}
            data-testid="publish-control-archive"
          >
            {busy === 'archive'
              ? t('evolution.studio.lifecycle.publishControls.archiving')
              : t('evolution.studio.lifecycle.publishControls.archive')}
          </Button>
        </div>
      )}

      {error && <p className={`mt-2 text-[11px] ${isDark ? 'text-rose-300' : 'text-rose-600'}`}>{error}</p>}
    </section>
  );
}
