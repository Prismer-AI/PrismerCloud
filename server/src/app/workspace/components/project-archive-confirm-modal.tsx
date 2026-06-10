'use client';

/**
 * Project archive confirm modal — release201/09 Phase 4 §15.1.
 *
 * Two-step confirmation overlay for project deletion. Forces the user to
 * pick the cascade mode (default = archive) and then click a final Confirm
 * to commit.
 *
 * Cascade modes (09 §4.4 + §15.1 Phase 4):
 *   - 'archive' (default, recommended) : soft archive only. Linked tasks /
 *     conversation / asset / memory keep their projectId for history.
 *   - 'null'                            : unscope linked im_tasks first
 *     (set projectId = NULL), then soft archive the project. Other linked
 *     resource types are deferred to v2.0.8+ (no column yet).
 *   - 'hard'                            : DISABLED — reserved for v2.1+
 *     evaluation. Disabled button + tooltip explaining the deferral so the
 *     UI matches the server-side 405 + 'hard_cascade_not_implemented'.
 *
 * "One intent = one affordance" — each radio is the user-facing intent; the
 * tooltip carries enough context that no modifier-key / hidden state is
 * needed.
 */

import { useState, useEffect } from 'react';
import { AlertTriangle, Archive, FolderMinus, Lock, X } from 'lucide-react';
import { useI18n } from '@/contexts/i18n-context';
import { radius, surface } from '../lib/design';
import type { ProjectDeleteCascade, ProjectWithCountsDTO } from '../lib/projects-api';

type Selectable = Exclude<ProjectDeleteCascade, 'hard'>;

interface ProjectArchiveConfirmModalProps {
  isDark: boolean;
  isOpen: boolean;
  project: ProjectWithCountsDTO | null;
  /** Number of tasks currently bound to the project (for cascade=null preview). */
  taskCount: number;
  onCancel: () => void;
  onConfirm: (cascade: ProjectDeleteCascade) => void;
}

export function ProjectArchiveConfirmModal({
  isDark,
  isOpen,
  project,
  taskCount,
  onCancel,
  onConfirm,
}: ProjectArchiveConfirmModalProps) {
  const { t } = useI18n();
  const theme: 'dark' | 'light' = isDark ? 'dark' : 'light';
  const [cascade, setCascade] = useState<Selectable>('archive');
  // Two-step confirm: user must press the action button twice for cascade=null
  // (since it mutates linked tasks). cascade=archive is one-click.
  const [pendingConfirm, setPendingConfirm] = useState(false);

  // Reset state every time the modal opens (cascade choice + confirm step).
  useEffect(() => {
    if (isOpen) {
      setCascade('archive');
      setPendingConfirm(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onCancel]);

  if (!isOpen || !project) return null;

  const requiresDoubleConfirm = cascade === 'null';
  const buttonLabel =
    cascade === 'null'
      ? pendingConfirm
        ? t('workspace.project.confirmCascadeNull', { count: taskCount })
        : t('workspace.project.archiveCascadeNullButton')
      : t('workspace.project.confirmArchive');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      <div
        data-testid="project-archive-modal-backdrop"
        className={`absolute inset-0 backdrop-blur-sm ${isDark ? 'bg-black/55' : 'bg-zinc-900/30'}`}
        onClick={onCancel}
      />
      <div
        role="dialog"
        aria-label={t('workspace.project.archiveTitle')}
        data-testid="project-archive-modal"
        className={['relative w-full max-w-md', radius.card, 'border', surface.modal[theme]].join(' ')}
      >
        <div className="flex items-start gap-3 px-5 pt-5 pb-3">
          <span
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
              isDark ? 'bg-amber-500/15 text-amber-300' : 'bg-amber-500/15 text-amber-600'
            }`}
          >
            <AlertTriangle className="w-4 h-4" />
          </span>
          <div className="flex-1">
            <h3 className={`text-base font-semibold ${isDark ? 'text-zinc-50' : 'text-zinc-900'}`}>
              {t('workspace.project.archiveTitle')}
            </h3>
            <p className={`mt-1 text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
              {t('workspace.project.archiveSubtitle', { project: project.name, count: taskCount })}
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label={t('common.close')}
            className={`-mr-1 p-1 ${radius.small} transition-colors ${
              isDark ? 'text-zinc-500 hover:text-zinc-200' : 'text-zinc-400 hover:text-zinc-700'
            }`}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <fieldset className="px-5 py-2 space-y-2" data-testid="project-archive-cascade-choices">
          <RadioRow
            isDark={isDark}
            checked={cascade === 'archive'}
            onSelect={() => {
              setCascade('archive');
              setPendingConfirm(false);
            }}
            icon={<Archive className="w-4 h-4" />}
            title={t('workspace.project.cascadeArchiveTitle')}
            detail={t('workspace.project.cascadeArchiveDetail')}
            badge={t('workspace.project.cascadeRecommended')}
            testId="project-archive-radio-archive"
          />
          <RadioRow
            isDark={isDark}
            checked={cascade === 'null'}
            onSelect={() => {
              setCascade('null');
              setPendingConfirm(false);
            }}
            icon={<FolderMinus className="w-4 h-4" />}
            title={t('workspace.project.cascadeNullTitle')}
            detail={t('workspace.project.cascadeNullDetail', { count: taskCount })}
            testId="project-archive-radio-null"
          />
          {/* hard is disabled — explicit "v2.1+ 评估" lock-out (Forbidden in §15.1 Phase 4). */}
          <RadioRow
            isDark={isDark}
            checked={false}
            onSelect={() => {
              /* disabled — no-op */
            }}
            disabled
            icon={<Lock className="w-4 h-4" />}
            title={t('workspace.project.cascadeHardTitle')}
            detail={t('workspace.project.cascadeHardDetail')}
            testId="project-archive-radio-hard"
          />
        </fieldset>

        <div className="flex items-center justify-end gap-2 px-5 pb-5 pt-3">
          <button
            type="button"
            onClick={onCancel}
            data-testid="project-archive-cancel"
            className={`rounded-xl border px-3 py-1.5 text-xs font-semibold transition-colors ${
              isDark
                ? 'border-white/[0.08] text-zinc-200 hover:bg-white/[0.05]'
                : 'border-zinc-200 text-zinc-700 hover:bg-zinc-50'
            }`}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => {
              if (requiresDoubleConfirm && !pendingConfirm) {
                setPendingConfirm(true);
                return;
              }
              onConfirm(cascade);
            }}
            data-testid={pendingConfirm ? 'project-archive-confirm-final' : 'project-archive-confirm'}
            className={`rounded-xl px-3 py-1.5 text-xs font-semibold transition-colors ${
              cascade === 'null' && pendingConfirm
                ? 'bg-rose-600 text-white hover:bg-rose-500'
                : isDark
                  ? 'bg-amber-500 text-zinc-900 hover:bg-amber-400'
                  : 'bg-amber-500 text-white hover:bg-amber-600'
            }`}
          >
            {buttonLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function RadioRow({
  isDark,
  checked,
  onSelect,
  icon,
  title,
  detail,
  badge,
  disabled,
  testId,
}: {
  isDark: boolean;
  checked: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  title: string;
  detail: string;
  badge?: string;
  disabled?: boolean;
  testId?: string;
}) {
  const base = `flex items-start gap-2.5 rounded-lg border px-3 py-2 text-left text-xs transition-colors w-full`;
  const tone = disabled
    ? isDark
      ? 'border-white/[0.04] bg-white/[0.02] text-zinc-500 cursor-not-allowed opacity-60'
      : 'border-zinc-200/60 bg-zinc-50 text-zinc-400 cursor-not-allowed opacity-60'
    : checked
      ? isDark
        ? 'border-violet-500/50 bg-violet-500/10 text-zinc-100'
        : 'border-violet-300 bg-violet-50 text-zinc-900'
      : isDark
        ? 'border-white/[0.06] bg-zinc-900/40 text-zinc-300 hover:bg-white/[0.05]'
        : 'border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50';
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      aria-disabled={disabled}
      onClick={() => {
        if (!disabled) onSelect();
      }}
      data-testid={testId}
      className={`${base} ${tone}`}
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span className="flex-1 min-w-0">
        <span className="flex items-center gap-1.5">
          <span className="font-semibold">{title}</span>
          {badge ? (
            <span
              className={`rounded-full px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider ${
                isDark ? 'bg-violet-500/20 text-violet-300' : 'bg-violet-500/15 text-violet-700'
              }`}
            >
              {badge}
            </span>
          ) : null}
        </span>
        <span className="mt-0.5 block opacity-80">{detail}</span>
      </span>
    </button>
  );
}
