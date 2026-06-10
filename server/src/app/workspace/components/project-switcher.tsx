'use client';

/**
 * ProjectSwitcher — release201/09 Phase 1.
 *
 * Lives in left-rail above the workspace surface navigation. Lists active
 * projects + the two sentinel options ("All" and "Unscoped"), supports
 * creating a new project inline.
 *
 * Phase 1 不接入资源 filter (no projectId column 已在任何资源表上). 当前
 * 仅维护 active project state + 持久化; Phase 2 起 task-board / library /
 * chats 会消费该 active filter.
 */

import React, { useState } from 'react';
import {
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  EyeOff,
  Eye,
  FolderPlus,
  Loader2,
  Plus,
  Globe2,
  FolderClosed,
} from 'lucide-react';
import { useI18n } from '@/contexts/i18n-context';
import {
  createProject,
  PROJECT_FILTER_ALL,
  PROJECT_FILTER_UNSCOPED,
  type ProjectFilter,
  type ProjectWithCountsDTO,
} from '../lib/projects-api';

interface ProjectSwitcherProps {
  isDark: boolean;
  workspaceId: string | null;
  projects: ProjectWithCountsDTO[];
  loading: boolean;
  activeFilter: ProjectFilter;
  onChange: (filter: ProjectFilter) => void;
  onReload: () => void;
  /** Inline-create surface error sink (matches workspace toast handler). */
  notify?: (message: string, opts?: { kind?: 'error' | 'success' | 'info' }) => void;
  /**
   * Phase 4 §15.1 — clicking the active project's name opens the
   * Project overview drawer. Parent owns the drawer state; switcher only
   * fires the intent. Optional so legacy callers don't break.
   */
  onOpenOverview?: (projectId: string) => void;
  /**
   * Phase 4 §15.1 — "Show archived" toggle. Parent owns the toggle state so
   * it can also drive the underlying project list query (refetch with
   * `status=archived` once the user expands the archived bucket).
   * If undefined, archived projects are always hidden (default behavior).
   */
  showArchived?: boolean;
  onToggleShowArchived?: (next: boolean) => void;
  /** Archived project list (only consumed when `showArchived === true`). */
  archivedProjects?: ProjectWithCountsDTO[];
  archivedLoading?: boolean;
}

function deriveSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-')
    .slice(0, 64);
}

export function ProjectSwitcher({
  isDark,
  workspaceId,
  projects,
  loading,
  activeFilter,
  onChange,
  onReload,
  notify,
  onOpenOverview,
  showArchived = false,
  onToggleShowArchived,
  archivedProjects = [],
  archivedLoading = false,
}: ProjectSwitcherProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Phase 4 §15.1 — never include archived projects in the "active project"
  // pool. The active filter can technically point at an archived id (e.g.
  // user archived the current project in another tab); we resolve the name
  // by checking both lists, but the switcher itself only offers active rows
  // as selectable until "Show archived" is on.
  const archivedFallback = archivedProjects.find((p) => p.id === activeFilter);
  const active = projects.find((p) => p.id === activeFilter) ?? archivedFallback;
  const activeLabel =
    activeFilter === PROJECT_FILTER_ALL
      ? t('workspace.project.allProjects')
      : activeFilter === PROJECT_FILTER_UNSCOPED
        ? t('workspace.project.unscopedOnly')
        : (active?.name ?? t('workspace.project.unknownProject'));
  // The active project name is itself a click target — it opens the
  // Project overview drawer (09 §15.1 Phase 4). Only meaningful when the
  // active filter is a specific project id (not "All" / "Unscoped").
  const canOpenOverview =
    !!onOpenOverview && activeFilter !== PROJECT_FILTER_ALL && activeFilter !== PROJECT_FILTER_UNSCOPED && !!active;

  async function handleCreate() {
    if (!workspaceId) return;
    const name = newName.trim();
    if (!name) {
      notify?.(t('workspace.project.nameRequired'), { kind: 'error' });
      return;
    }
    const slug = deriveSlug(name);
    if (!slug) {
      notify?.(t('workspace.project.nameNeedsLetter'), { kind: 'error' });
      return;
    }
    setSubmitting(true);
    try {
      const res = await createProject({ workspaceId, slug, name });
      if (res.ok && res.data) {
        notify?.(t('workspace.project.created', { name: res.data.name }), { kind: 'success' });
        setCreating(false);
        setNewName('');
        onReload();
        onChange(res.data.id);
      } else if (!res.ok) {
        notify?.(res.message || t('workspace.project.createFailed'), { kind: 'error' });
      }
    } catch (err) {
      notify?.(err instanceof Error ? err.message : String(err), { kind: 'error' });
    } finally {
      setSubmitting(false);
    }
  }

  const triggerClasses = isDark
    ? 'border-white/[0.06] bg-zinc-900/40 text-zinc-200 hover:bg-zinc-800/60'
    : 'border-zinc-200 bg-white/85 text-zinc-700 hover:bg-zinc-50';
  const panelClasses = isDark
    ? 'border-white/[0.08] bg-zinc-950/95 text-zinc-100 shadow-[0_18px_48px_-32px_rgba(0,0,0,0.85)]'
    : 'border-zinc-200 bg-white text-zinc-800 shadow-[0_18px_48px_-32px_rgba(0,0,0,0.18)]';

  return (
    <div data-testid="project-switcher" className="relative px-2 pt-2">
      {/*
        Two-affordance trigger row (one intent = one affordance, per memory
        feedback_one_intent_one_affordance.md):
          • Clicking the project name → opens overview drawer
          • Clicking the chevron / icon → toggles the dropdown
        Both controls are visibly distinct so users don't guess.
      */}
      <div className={`group flex w-full items-stretch gap-1 rounded-xl border text-xs font-medium ${triggerClasses}`}>
        <button
          type="button"
          data-testid="project-switcher-active-label"
          onClick={() => {
            if (canOpenOverview && active) onOpenOverview!(active.id);
            else setOpen((v) => !v);
          }}
          className="flex flex-1 min-w-0 items-center gap-2 rounded-l-xl px-2.5 py-1.5 text-left transition-colors"
          aria-label={
            canOpenOverview
              ? t('workspace.project.openOverviewAria', { name: active?.name ?? '' })
              : t('workspace.project.activeScope', { label: activeLabel })
          }
        >
          <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-violet-500/15 text-violet-500">
            {activeFilter === PROJECT_FILTER_ALL ? (
              <Globe2 className="h-3.5 w-3.5" />
            ) : activeFilter === PROJECT_FILTER_UNSCOPED ? (
              <FolderClosed className="h-3.5 w-3.5" />
            ) : (
              <FolderPlus className="h-3.5 w-3.5" />
            )}
          </span>
          <span className="flex-1 min-w-0">
            <span
              className={`block text-[10px] uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}
            >
              {t('workspace.project.label')}
            </span>
            <span className="block truncate text-sm font-semibold">{activeLabel}</span>
          </span>
        </button>
        <button
          type="button"
          data-testid="project-switcher-trigger"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={t('workspace.project.filter')}
          className={`flex shrink-0 items-center justify-center rounded-r-xl px-2 transition-colors ${
            isDark ? 'hover:bg-white/[0.06]' : 'hover:bg-zinc-100'
          }`}
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin opacity-60" />
          ) : (
            <ChevronDown className={`h-3.5 w-3.5 opacity-60 transition-transform ${open ? 'rotate-180' : ''}`} />
          )}
        </button>
      </div>

      {open ? (
        <div
          role="listbox"
          aria-label={t('workspace.project.filter')}
          className={`absolute left-2 right-2 top-full z-30 mt-1 max-h-80 overflow-y-auto rounded-xl border ${panelClasses}`}
        >
          <SwitcherOption
            isDark={isDark}
            active={activeFilter === PROJECT_FILTER_ALL}
            icon={<Globe2 className="h-3.5 w-3.5" />}
            label={t('workspace.project.allProjects')}
            detail={t('workspace.project.allProjectsDetail')}
            onSelect={() => {
              onChange(PROJECT_FILTER_ALL);
              setOpen(false);
            }}
            testId="project-switcher-option-all"
          />
          <SwitcherOption
            isDark={isDark}
            active={activeFilter === PROJECT_FILTER_UNSCOPED}
            icon={<FolderClosed className="h-3.5 w-3.5" />}
            label={t('workspace.project.unscopedOnly')}
            detail={t('workspace.project.unscopedDetail')}
            onSelect={() => {
              onChange(PROJECT_FILTER_UNSCOPED);
              setOpen(false);
            }}
            testId="project-switcher-option-unscoped"
          />
          {projects.length > 0 ? (
            <div className={`my-1 border-t ${isDark ? 'border-white/[0.06]' : 'border-zinc-200/70'}`} />
          ) : null}
          {projects.map((p) => (
            <SwitcherOption
              key={p.id}
              isDark={isDark}
              active={activeFilter === p.id}
              icon={<FolderPlus className="h-3.5 w-3.5" />}
              label={p.name}
              detail={t('workspace.project.memberCount', { count: p.memberCount })}
              onSelect={() => {
                onChange(p.id);
                setOpen(false);
              }}
              onOpenOverview={
                onOpenOverview
                  ? () => {
                      onOpenOverview(p.id);
                      setOpen(false);
                    }
                  : undefined
              }
              testId={`project-switcher-option-${p.slug}`}
            />
          ))}

          {/*
            Phase 4 §15.1 — "Show archived" toggle.
            • OFF (default): archived rows are not listed; toggle row is collapsed.
            • ON           : reveal the archived sub-section below; each row is
                             greyed out + carries an "Archived" badge.
            • Archived row is read-only here — selecting it just opens the
              overview drawer (where the user can Restore from). It is NOT
              eligible to be set as the active project filter (Forbidden in
              §15.1 Phase 4 DoD); the row's main click target opens the drawer.
          */}
          {onToggleShowArchived ? (
            <>
              <div className={`my-1 border-t ${isDark ? 'border-white/[0.06]' : 'border-zinc-200/70'}`} />
              <button
                type="button"
                data-testid="project-switcher-toggle-archived"
                onClick={() => onToggleShowArchived(!showArchived)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                  isDark ? 'hover:bg-white/[0.04] text-zinc-300' : 'hover:bg-zinc-50 text-zinc-600'
                }`}
              >
                {showArchived ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                <span className="flex-1">{t('workspace.project.showArchived')}</span>
                <ChevronRight
                  className={`h-3 w-3 opacity-60 transition-transform ${showArchived ? 'rotate-90' : ''}`}
                />
              </button>
              {showArchived ? (
                <div className="pb-1">
                  {archivedLoading ? (
                    <div className={`px-3 py-1.5 text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                      <Loader2 className="inline w-3 h-3 mr-1.5 animate-spin" />
                      {t('common.loading')}
                    </div>
                  ) : archivedProjects.length === 0 ? (
                    <div className={`px-3 py-1.5 text-xs italic ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                      {t('workspace.project.noArchived')}
                    </div>
                  ) : (
                    archivedProjects.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        role="option"
                        aria-selected={false}
                        data-testid={`project-switcher-archived-${p.slug}`}
                        onClick={() => {
                          if (onOpenOverview) {
                            onOpenOverview(p.id);
                            setOpen(false);
                          }
                        }}
                        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors opacity-60 hover:opacity-100 ${
                          isDark ? 'text-zinc-400 hover:bg-white/[0.04]' : 'text-zinc-500 hover:bg-zinc-50'
                        }`}
                      >
                        <Archive className="h-3.5 w-3.5 shrink-0" />
                        <span className="flex-1 min-w-0 truncate">{p.name}</span>
                        <span
                          className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider ${
                            isDark ? 'bg-amber-500/15 text-amber-300' : 'bg-amber-500/15 text-amber-700'
                          }`}
                        >
                          {t('workspace.project.statusArchived')}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              ) : null}
            </>
          ) : null}

          <div className={`my-1 border-t ${isDark ? 'border-white/[0.06]' : 'border-zinc-200/70'}`} />
          {creating ? (
            <div className="px-2 py-2">
              <input
                autoFocus
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={t('workspace.project.name')}
                disabled={submitting}
                className={`mb-1.5 w-full rounded-lg border px-2 py-1 text-xs outline-none ${
                  isDark
                    ? 'border-white/[0.08] bg-zinc-900 text-zinc-100 placeholder:text-zinc-600'
                    : 'border-zinc-200 bg-white text-zinc-900 placeholder:text-zinc-400'
                }`}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleCreate();
                  if (e.key === 'Escape') {
                    setCreating(false);
                    setNewName('');
                  }
                }}
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void handleCreate()}
                  disabled={submitting || !newName.trim()}
                  className="flex-1 rounded-lg bg-violet-600 px-2 py-1 text-xs font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
                >
                  {submitting ? t('workspace.project.creating') : t('workspace.project.create')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCreating(false);
                    setNewName('');
                  }}
                  className={`rounded-lg border px-2 py-1 text-xs ${
                    isDark
                      ? 'border-white/[0.06] text-zinc-300 hover:bg-white/[0.05]'
                      : 'border-zinc-200 text-zinc-600 hover:bg-zinc-100'
                  }`}
                >
                  {t('common.cancel')}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              data-testid="project-switcher-new"
              onClick={() => setCreating(true)}
              disabled={!workspaceId}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-medium transition-colors disabled:opacity-50 ${
                isDark ? 'hover:bg-white/[0.04] text-zinc-200' : 'hover:bg-zinc-50 text-zinc-700'
              }`}
            >
              <Plus className="h-3.5 w-3.5" />
              {t('workspace.project.newProject')}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Compact project chip for surface headers (release201/09 §8.2).
 *
 * Shows the current project (or "All" / "Unscoped" sentinel) as a small chip
 * that opens the same switcher dropdown. Phase 1 是纯指示器:用户可见当前
 * scope, 但 surface 数据 list 还没接 projectId filter (Phase 2 起接入).
 */
export function ProjectChip({
  isDark,
  projects,
  activeFilter,
  onChange,
}: {
  isDark: boolean;
  projects: ProjectWithCountsDTO[];
  activeFilter: ProjectFilter;
  onChange: (filter: ProjectFilter) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const active = projects.find((p) => p.id === activeFilter);
  const label =
    activeFilter === PROJECT_FILTER_ALL
      ? t('workspace.project.allProjects')
      : activeFilter === PROJECT_FILTER_UNSCOPED
        ? t('workspace.project.unscoped')
        : (active?.name ?? t('workspace.project.unknownProject'));

  const chipClasses = isDark
    ? 'border-violet-500/30 bg-violet-500/10 text-violet-200 hover:bg-violet-500/15'
    : 'border-violet-300/60 bg-violet-50 text-violet-700 hover:bg-violet-100';
  const panelClasses = isDark
    ? 'border-white/[0.08] bg-zinc-950/95 text-zinc-100 shadow-[0_18px_48px_-32px_rgba(0,0,0,0.85)]'
    : 'border-zinc-200 bg-white text-zinc-800 shadow-[0_18px_48px_-32px_rgba(0,0,0,0.18)]';

  return (
    <div className="relative">
      <button
        type="button"
        data-testid="surface-project-chip"
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors ${chipClasses}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={t('workspace.project.activeScope', { label })}
      >
        {activeFilter === PROJECT_FILTER_ALL ? (
          <Globe2 className="h-3 w-3" />
        ) : activeFilter === PROJECT_FILTER_UNSCOPED ? (
          <FolderClosed className="h-3 w-3" />
        ) : (
          <FolderPlus className="h-3 w-3" />
        )}
        <span className="max-w-[140px] truncate">{label}</span>
        <ChevronDown className={`h-3 w-3 opacity-70 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open ? (
        <div
          role="listbox"
          aria-label={t('workspace.project.scope')}
          className={`absolute left-0 top-full z-30 mt-1 w-[220px] overflow-hidden rounded-xl border ${panelClasses}`}
        >
          <SwitcherOption
            isDark={isDark}
            active={activeFilter === PROJECT_FILTER_ALL}
            icon={<Globe2 className="h-3.5 w-3.5" />}
            label={t('workspace.project.allProjects')}
            detail={t('workspace.project.allProjectsDetail')}
            onSelect={() => {
              onChange(PROJECT_FILTER_ALL);
              setOpen(false);
            }}
            testId="surface-project-chip-option-all"
          />
          <SwitcherOption
            isDark={isDark}
            active={activeFilter === PROJECT_FILTER_UNSCOPED}
            icon={<FolderClosed className="h-3.5 w-3.5" />}
            label={t('workspace.project.unscopedOnly')}
            detail={t('workspace.project.unscopedDetail')}
            onSelect={() => {
              onChange(PROJECT_FILTER_UNSCOPED);
              setOpen(false);
            }}
            testId="surface-project-chip-option-unscoped"
          />
          {projects.length > 0 ? (
            <div className={`my-1 border-t ${isDark ? 'border-white/[0.06]' : 'border-zinc-200/70'}`} />
          ) : null}
          {projects.map((p) => (
            <SwitcherOption
              key={p.id}
              isDark={isDark}
              active={activeFilter === p.id}
              icon={<FolderPlus className="h-3.5 w-3.5" />}
              label={p.name}
              detail={t('workspace.project.memberCount', { count: p.memberCount })}
              onSelect={() => {
                onChange(p.id);
                setOpen(false);
              }}
              testId={`surface-project-chip-option-${p.slug}`}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SwitcherOption({
  isDark,
  active,
  icon,
  label,
  detail,
  onSelect,
  onOpenOverview,
  testId,
}: {
  isDark: boolean;
  active: boolean;
  icon: React.ReactNode;
  label: string;
  detail?: string;
  onSelect: () => void;
  /** Optional secondary affordance — opens the project overview drawer. */
  onOpenOverview?: () => void;
  testId?: string;
}) {
  // Container-level wrapper so both intents (filter select + open overview)
  // are visible side-by-side without overloading a single click target.
  return (
    <div
      className={`flex w-full items-stretch ${
        active
          ? isDark
            ? 'bg-white/[0.06] text-zinc-100'
            : 'bg-violet-50 text-violet-900'
          : isDark
            ? 'text-zinc-300 hover:bg-white/[0.04]'
            : 'text-zinc-700 hover:bg-zinc-50'
      }`}
    >
      <button
        type="button"
        role="option"
        aria-selected={active}
        data-testid={testId}
        onClick={onSelect}
        className="flex flex-1 min-w-0 items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors"
      >
        <span className={`shrink-0 ${active ? 'text-violet-500' : 'opacity-70'}`}>{icon}</span>
        <span className="flex-1 min-w-0">
          <span className="block truncate text-sm font-semibold">{label}</span>
          {detail ? (
            <span className={`block truncate text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>{detail}</span>
          ) : null}
        </span>
        {active ? <Check className="h-3.5 w-3.5 shrink-0 text-violet-500" /> : null}
      </button>
      {onOpenOverview ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpenOverview();
          }}
          data-testid={testId ? `${testId}-overview` : undefined}
          aria-label="Open project overview"
          className={`shrink-0 px-2 transition-colors ${
            isDark ? 'text-zinc-500 hover:text-zinc-200' : 'text-zinc-400 hover:text-zinc-700'
          }`}
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}
