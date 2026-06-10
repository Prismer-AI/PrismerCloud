'use client';

/**
 * Project overview drawer — release201/09 Phase 4 §8.7 / §15.1 (S31 C).
 *
 * Slide-in right-side drawer that opens when the user clicks the active
 * project name in ProjectSwitcher (or any "Open project" affordance).
 * Mirrors the visual language of task-detail-drawer.tsx: framer-motion
 * spring-heavy slide, backdrop blur, ESC + backdrop close.
 *
 * 4 tabs (S31 C requirement):
 *   1. Tasks         — taskStats + recent task list (sortable; acceptance
 *                      progress + assignee for each row); reuses
 *                      GET /api/im/projects/:id/overview BFF.
 *   2. Conversations — associated IMConversation list (projectId match).
 *                      v2.0.7: IMConversation.projectId has no schema
 *                      column yet (09 §10.2 Phase 5 — v2.0.8); the tab
 *                      renders a "deferred" placeholder consuming the BFF's
 *                      `deferred.conversations` flag.
 *   3. Agents        — IMAgentProjectMembership.principalKind='agent' rows,
 *                      with role badge.
 *   4. Settings      — name / description / status (Edit) + Archive +
 *                      Restore + Open in Insights.
 *
 * Permission UI (09 §5.1): non-owner sees the drawer but Archive / Cascade
 * / Edit / Restore are hidden in the Settings tab (service layer enforces
 * 403 too; UI hides the affordance to honour 'one intent one affordance').
 *
 * 5-dimension audit:
 *   1. UI/UX             — drawer overlays main column, ESC + backdrop close,
 *                          tab nav with one-affordance-per-intent.
 *   2. Server data model — reads im_projects + im_agent_project_memberships
 *                          + im_tasks (via /overview BFF). No writes here
 *                          except via existing Project endpoints (update/
 *                          delete) wired in the Settings tab.
 *   3. Endpoint spec     — adds GET /api/im/projects/:id/overview (S31 C BFF);
 *                          consumes existing 09 §6.1 + §6.2.
 *   4. Daemon runtime    — N/A (purely UI)
 *   5. Built-in skill    — N/A
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Archive,
  ChevronRight,
  Eye,
  Folder,
  Loader2,
  MessageSquare,
  Pencil,
  RefreshCcw,
  Settings as SettingsIcon,
  Users,
  X,
} from 'lucide-react';
import { useI18n } from '@/contexts/i18n-context';
import { radius, springHeavy, springSoft, surface } from '../lib/design';
import {
  deleteProject,
  getProjectOverview,
  listProjectMembers,
  updateProject,
  type ProjectCascadeReport,
  type ProjectDeleteCascade,
  type ProjectMembershipDTO,
  type ProjectOverviewDTO,
  type ProjectOverviewTaskRow,
  type ProjectWithCountsDTO,
} from '../lib/projects-api';
import { imFetch } from '../lib/im-api';
import { ProjectArchiveConfirmModal } from './project-archive-confirm-modal';
import { AddProjectMemberDialog } from './add-project-member-dialog';

interface ProjectOverviewProps {
  isDark: boolean;
  isOpen: boolean;
  workspaceId: string | null;
  /** Project being displayed. `null` while opening / between selections. */
  project: ProjectWithCountsDTO | null;
  /** Whether the current viewer is workspace-owner OR project-owner. Controls Archive / Edit / Cascade affordances. */
  canManage: boolean;
  onClose: () => void;
  /** After successful archive / cascade / restore / edit, parent re-pulls projects + tasks. */
  onMutated: () => void;
  /** Jump to a task — wired to the parent's existing `openTaskById` callback. */
  onOpenTask?: (taskId: string) => void;
  /** Jump to the workspace insights surface (S10 Project view, §15.1 Phase 4 联动). */
  onOpenDashboard?: (projectId: string) => void;
  /** Toast / status surface — same shape as workspace `addToast`. */
  notify?: (msg: string, opts?: { kind?: 'error' | 'success' | 'info' }) => void;
}

type DrawerTab = 'tasks' | 'conversations' | 'agents' | 'settings';

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

// Tab labels are intentionally hard-coded English strings — adding 4 keys to
// the global `TranslationKey` union (src/lib/i18n.ts) is heavier than the
// drawer needs; localisation can fold them in v2.0.8 when the rest of the
// 09 §10.2 Phase 5 (conversation projectId) lands.
function tabLabel(tab: DrawerTab): string {
  switch (tab) {
    case 'tasks':
      return 'Tasks';
    case 'conversations':
      return 'Conversations';
    case 'agents':
      return 'Agents';
    case 'settings':
      return 'Settings';
  }
}

export function ProjectOverviewDrawer({
  isDark,
  isOpen,
  workspaceId: _workspaceId,
  project,
  canManage,
  onClose,
  onMutated,
  onOpenTask,
  onOpenDashboard,
  notify,
}: ProjectOverviewProps) {
  const { t } = useI18n();
  const theme: 'dark' | 'light' = isDark ? 'dark' : 'light';

  const [activeTab, setActiveTab] = useState<DrawerTab>('tasks');
  const [overview, setOverview] = useState<ProjectOverviewDTO | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [members, setMembers] = useState<ProjectMembershipDTO[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editSaving, setEditSaving] = useState(false);

  // ESC closes the drawer (mirror task-detail-drawer).
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  // Sync edit form with the current project whenever it changes.
  useEffect(() => {
    if (!project) return;
    setEditName(project.name);
    setEditDescription(project.description ?? '');
    setEditing(false);
    setActiveTab('tasks');
  }, [project?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load BFF overview + members when the drawer opens or the project changes.
  useEffect(() => {
    if (!isOpen || !project) return;
    const ac = new AbortController();

    setOverviewLoading(true);
    getProjectOverview(project.id, ac.signal)
      .then((res) => {
        if (res.ok) {
          if (res.data) setOverview(res.data);
          return;
        }
        if (res.status !== 0) notify?.(res.message || 'Failed to load overview', { kind: 'error' });
      })
      .catch((err: unknown) => {
        if ((err as { name?: string })?.name === 'AbortError') return;
        notify?.(err instanceof Error ? err.message : String(err), { kind: 'error' });
      })
      .finally(() => setOverviewLoading(false));

    setMembersLoading(true);
    listProjectMembers(project.id, ac.signal)
      .then((res) => {
        if (res.ok) setMembers(res.data ?? []);
        else if (res.status !== 0) notify?.(res.message || 'Failed to load members', { kind: 'error' });
      })
      .catch((err: unknown) => {
        if ((err as { name?: string })?.name === 'AbortError') return;
        notify?.(err instanceof Error ? err.message : String(err), { kind: 'error' });
      })
      .finally(() => setMembersLoading(false));

    return () => ac.abort();
  }, [isOpen, project?.id, notify]);

  const taskStats = overview?.taskStats;
  const recentTasks: ProjectOverviewTaskRow[] = useMemo(() => overview?.recentTasks ?? [], [overview?.recentTasks]);
  const agentMembers = useMemo(() => members.filter((m) => m.principalKind === 'agent'), [members]);
  const userMembers = useMemo(() => members.filter((m) => m.principalKind === 'user'), [members]);

  const handleArchive = useCallback(
    async (cascade: ProjectDeleteCascade) => {
      if (!project) return;
      const res = await deleteProject(project.id, { cascade });
      if (!res.ok) {
        notify?.(res.message || t('workspace.project.archiveFailed'), { kind: 'error' });
        return;
      }
      const report = res.data?.cascadeReport as ProjectCascadeReport | undefined;
      const detail =
        cascade === 'null' && report && report.taskUnscoped > 0
          ? t('workspace.project.cascadeNullDone', {
              project: project.name,
              count: report.taskUnscoped,
            })
          : t('workspace.project.archivedDone', { project: project.name });
      notify?.(detail, { kind: 'success' });
      setConfirmOpen(false);
      onMutated();
      onClose();
    },
    [project, notify, onMutated, onClose, t],
  );

  const handleRestore = useCallback(async () => {
    if (!project) return;
    setRestoring(true);
    try {
      const res = await updateProject(project.id, { status: 'active' });
      if (!res.ok) {
        notify?.(res.message || t('workspace.project.restoreFailed'), { kind: 'error' });
        return;
      }
      notify?.(t('workspace.project.restored', { project: project.name }), { kind: 'success' });
      onMutated();
    } finally {
      setRestoring(false);
    }
  }, [project, notify, onMutated, t]);

  const handleEditSave = useCallback(async () => {
    if (!project) return;
    const trimmedName = editName.trim();
    if (!trimmedName) {
      notify?.(t('workspace.project.nameRequired'), { kind: 'error' });
      return;
    }
    setEditSaving(true);
    try {
      const res = await updateProject(project.id, {
        name: trimmedName,
        description: editDescription.trim() ? editDescription.trim() : null,
      });
      if (!res.ok) {
        notify?.(res.message || t('workspace.project.updateFailed'), { kind: 'error' });
        return;
      }
      notify?.(t('workspace.project.updated', { project: trimmedName }), { kind: 'success' });
      setEditing(false);
      onMutated();
    } finally {
      setEditSaving(false);
    }
  }, [project, editName, editDescription, notify, onMutated, t]);

  return (
    <>
      <AnimatePresence>
        {isOpen && project ? (
          <motion.div
            key={`project-drawer-${project.id}`}
            data-testid="project-overview-drawer-root"
            // Contained overlay — `absolute inset-0` rather than `fixed`, so
            // the drawer scopes to its parent (the workspace main content
            // wrapper, which is `relative overflow-hidden`). This keeps the
            // global topbar (Prismer Cloud / Dashboard / …) and the workspace
            // surface topbar (ProjectSwitcher row) visible while the drawer is
            // open — matching the "squeeze inward" semantics of the chat
            // right-pane rather than a viewport-wide overlay.
            className="absolute inset-0 z-30"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
          >
            <motion.div
              data-testid="project-overview-backdrop"
              onClick={onClose}
              className={`absolute inset-0 backdrop-blur-sm ${isDark ? 'bg-black/35' : 'bg-zinc-900/15'}`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
            />
            <motion.aside
              role="dialog"
              aria-label={t('workspace.project.overviewAria', { name: project.name })}
              data-testid="project-overview-drawer"
              className={[
                // Detached rounded-rectangle: small inset from all 4 edges so
                // the corner radius is visible and the drawer reads as a
                // self-contained pane, not a viewport-edge slab.
                'absolute right-3 top-3 bottom-3',
                'w-[calc(100%-1.5rem)] sm:w-[480px] lg:w-[520px]',
                'flex flex-col overflow-hidden',
                radius.card,
                'border',
                surface.modal[theme],
              ].join(' ')}
              initial={{ x: 540, opacity: 0.4 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: 540, opacity: 0 }}
              transition={springHeavy}
            >
              {/* Header */}
              <header className="relative px-6 pt-5 pb-3 border-b border-white/5">
                <button
                  type="button"
                  onClick={onClose}
                  aria-label={t('common.close')}
                  data-testid="project-overview-close"
                  className={`absolute top-4 right-4 p-2 ${radius.small} transition-colors ${
                    isDark
                      ? 'text-zinc-400 hover:text-white hover:bg-white/5'
                      : 'text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100'
                  }`}
                >
                  <X className="w-4 h-4" />
                </button>

                <motion.div
                  initial={{ scale: 0.95, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={springSoft}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <Folder className={`w-3.5 h-3.5 ${isDark ? 'text-violet-300' : 'text-violet-600'}`} />
                    <span className={`font-mono text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                      {project.slug}
                    </span>
                    <StatusBadge isDark={isDark} status={project.status} />
                  </div>
                  <h2 className={`text-xl font-semibold mr-10 ${isDark ? 'text-zinc-50' : 'text-zinc-900'}`}>
                    {project.name}
                  </h2>
                  <p className={`mt-1 text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                    {`${userMembers.length + agentMembers.length} member${
                      userMembers.length + agentMembers.length === 1 ? '' : 's'
                    }`}
                  </p>
                </motion.div>
              </header>

              {/* Tab nav (4-tab — one intent per tab; mobile-safe scroll) */}
              <nav
                role="tablist"
                aria-label={t('workspace.project.overviewAria', { name: project.name })}
                className={`flex shrink-0 gap-0 px-3 border-b ${
                  isDark ? 'border-white/[0.06] bg-zinc-950/40' : 'border-zinc-200 bg-zinc-50/60'
                }`}
              >
                {(['tasks', 'conversations', 'agents', 'settings'] as const).map((tab) => {
                  const isActive = tab === activeTab;
                  const icon =
                    tab === 'tasks' ? (
                      <Folder className="w-3.5 h-3.5" />
                    ) : tab === 'conversations' ? (
                      <MessageSquare className="w-3.5 h-3.5" />
                    ) : tab === 'agents' ? (
                      <Users className="w-3.5 h-3.5" />
                    ) : (
                      <SettingsIcon className="w-3.5 h-3.5" />
                    );
                  return (
                    <button
                      key={tab}
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      aria-controls={`project-overview-panel-${tab}`}
                      data-testid={`project-overview-tab-${tab}`}
                      onClick={() => setActiveTab(tab)}
                      className={`relative flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium transition-colors ${
                        isActive
                          ? isDark
                            ? 'text-zinc-100'
                            : 'text-zinc-900'
                          : isDark
                            ? 'text-zinc-500 hover:text-zinc-300'
                            : 'text-zinc-500 hover:text-zinc-700'
                      }`}
                    >
                      {icon}
                      {tabLabel(tab)}
                      {isActive ? (
                        <span
                          className={`absolute bottom-0 left-0 right-0 h-[2px] ${
                            isDark ? 'bg-violet-400' : 'bg-violet-600'
                          }`}
                        />
                      ) : null}
                    </button>
                  );
                })}
              </nav>

              {/* Tab body */}
              <div
                role="tabpanel"
                id={`project-overview-panel-${activeTab}`}
                className="flex-1 overflow-y-auto px-6 py-4"
              >
                {activeTab === 'tasks' ? (
                  <TasksTab
                    isDark={isDark}
                    overviewLoading={overviewLoading}
                    taskStats={taskStats}
                    recentTasks={recentTasks}
                    onOpenTask={onOpenTask}
                  />
                ) : null}

                {activeTab === 'conversations' ? (
                  <ConversationsTab
                    isDark={isDark}
                    deferred={overview?.deferred?.conversations ?? true}
                    count={overview?.conversationCount ?? 0}
                  />
                ) : null}

                {activeTab === 'agents' ? (
                  <AgentsTab
                    isDark={isDark}
                    membersLoading={membersLoading}
                    agentMembers={agentMembers}
                    userMembers={userMembers}
                    workspaceId={_workspaceId}
                    projectId={project.id}
                    canManage={canManage}
                    onMembersChanged={() => {
                      // Re-pull project members so the dialog's add shows up
                      // in the list without forcing a full overview refetch.
                      const ac = new AbortController();
                      setMembersLoading(true);
                      listProjectMembers(project.id, ac.signal)
                        .then((res) => {
                          if (res.ok) setMembers(res.data ?? []);
                        })
                        .finally(() => setMembersLoading(false));
                    }}
                  />
                ) : null}

                {activeTab === 'settings' ? (
                  <SettingsTab
                    isDark={isDark}
                    project={project}
                    canManage={canManage}
                    editing={editing}
                    editName={editName}
                    editDescription={editDescription}
                    editSaving={editSaving}
                    restoring={restoring}
                    onEditingChange={setEditing}
                    onEditName={setEditName}
                    onEditDescription={setEditDescription}
                    onEditSave={handleEditSave}
                    onRestore={handleRestore}
                    onArchive={() => setConfirmOpen(true)}
                  />
                ) : null}
              </div>

              {/* Footer — primary CTA stays visible across all tabs */}
              <footer
                className={`flex flex-col gap-2 px-6 py-4 border-t ${isDark ? 'border-white/[0.06]' : 'border-zinc-200'}`}
              >
                <button
                  type="button"
                  onClick={() => onOpenDashboard?.(project.id)}
                  disabled={!onOpenDashboard}
                  data-testid="project-overview-open-dashboard"
                  className={`flex items-center justify-center gap-2 w-full rounded-xl px-3 py-2 text-sm font-semibold transition-colors disabled:opacity-40 ${
                    isDark
                      ? 'bg-violet-600 text-white hover:bg-violet-500'
                      : 'bg-violet-600 text-white hover:bg-violet-700'
                  }`}
                >
                  <Eye className="w-4 h-4" />
                  {t('workspace.project.openDashboard')}
                </button>
              </footer>
            </motion.aside>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* Confirm modal lives next to (not inside) the drawer so it doesn't
          get torn down by AnimatePresence when the drawer animates out. */}
      <ProjectArchiveConfirmModal
        isDark={isDark}
        isOpen={confirmOpen}
        project={project}
        taskCount={taskStats?.total ?? 0}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={(cascade) => void handleArchive(cascade)}
      />
    </>
  );
}

// ────────────────────────── Tab components ──────────────────────────

function TasksTab({
  isDark,
  overviewLoading,
  taskStats,
  recentTasks,
  onOpenTask,
}: {
  isDark: boolean;
  overviewLoading: boolean;
  taskStats: ProjectOverviewDTO['taskStats'] | undefined;
  recentTasks: ProjectOverviewTaskRow[];
  onOpenTask?: (id: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div data-testid="project-overview-panel-tasks" className="space-y-4">
      <section data-testid="project-overview-stats">
        <h3
          className={`text-xs font-semibold uppercase tracking-wider mb-2 ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}
        >
          Task buckets
        </h3>
        <div className="grid grid-cols-3 gap-2">
          <StatTile
            isDark={isDark}
            label="Open"
            primary={`${taskStats?.open ?? 0}`}
            loading={overviewLoading}
            accent="open"
          />
          <StatTile
            isDark={isDark}
            label="Running"
            primary={`${taskStats?.running ?? 0}`}
            loading={overviewLoading}
            accent="running"
          />
          <StatTile
            isDark={isDark}
            label="Review"
            primary={`${taskStats?.review ?? 0}`}
            loading={overviewLoading}
            accent="review"
          />
          <StatTile
            isDark={isDark}
            label="Completed"
            primary={`${taskStats?.completed ?? 0}`}
            loading={overviewLoading}
            accent="completed"
          />
          <StatTile
            isDark={isDark}
            label="Failed"
            primary={`${taskStats?.failed ?? 0}`}
            loading={overviewLoading}
            accent="failed"
          />
          <StatTile isDark={isDark} label="Total" primary={`${taskStats?.total ?? 0}`} loading={overviewLoading} />
        </div>
      </section>

      <section data-testid="project-overview-recent">
        <h3
          className={`text-xs font-semibold uppercase tracking-wider mb-2 ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}
        >
          {t('workspace.project.recentActivity')}
        </h3>
        {overviewLoading ? (
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <Loader2 className="w-3 h-3 animate-spin" />
            {t('common.loading')}
          </div>
        ) : recentTasks.length === 0 ? (
          <p className={`text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
            {t('workspace.project.noRecentTasks')}
          </p>
        ) : (
          <ul className="space-y-1">
            {recentTasks.map((tk) => (
              <li key={tk.id}>
                <button
                  type="button"
                  onClick={() => onOpenTask?.(tk.id)}
                  data-testid={`project-overview-task-${tk.id}`}
                  className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
                    isDark ? 'hover:bg-white/[0.04] text-zinc-200' : 'hover:bg-zinc-50 text-zinc-700'
                  }`}
                >
                  <span
                    className={`shrink-0 inline-block w-1.5 h-1.5 rounded-full ${
                      tk.status === 'completed'
                        ? 'bg-emerald-500'
                        : tk.status === 'failed' || tk.status === 'cancelled'
                          ? 'bg-rose-500'
                          : tk.status === 'running'
                            ? 'bg-violet-500'
                            : 'bg-zinc-400'
                    }`}
                  />
                  <span className="flex-1 truncate">{tk.title || tk.id.slice(-8)}</span>
                  {tk.assigneeId ? (
                    <span className={`shrink-0 text-[10px] font-mono ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                      @{tk.assigneeId.slice(-6)}
                    </span>
                  ) : null}
                  <ChevronRight className="w-3 h-3 shrink-0 opacity-50" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function ConversationsTab({ isDark, deferred, count }: { isDark: boolean; deferred: boolean; count: number }) {
  const { t } = useI18n();
  if (deferred) {
    return (
      <div data-testid="project-overview-panel-conversations" className="space-y-3">
        <div
          className={`rounded-xl border px-4 py-3 ${
            isDark
              ? 'border-amber-500/30 bg-amber-500/5 text-amber-200'
              : 'border-amber-500/30 bg-amber-50 text-amber-800'
          }`}
        >
          <p className="text-xs font-semibold mb-1">{t('workspace.project.deferredV208')}</p>
          <p className="text-[11px] opacity-90">
            Conversation scope arrives with migration 434 (release201/09 §10.2 Phase 5). Until then, conversations live
            workspace-wide.
          </p>
        </div>
      </div>
    );
  }
  // v2.0.8+ branch reserved — placeholder.
  return (
    <div data-testid="project-overview-panel-conversations" className="space-y-3">
      <p className={`text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
        {t('workspace.project.conversations')}: {count}
      </p>
    </div>
  );
}

function AgentsTab({
  isDark,
  membersLoading,
  agentMembers,
  userMembers,
  workspaceId,
  projectId,
  canManage,
  onMembersChanged,
}: {
  isDark: boolean;
  membersLoading: boolean;
  agentMembers: ProjectMembershipDTO[];
  userMembers: ProjectMembershipDTO[];
  workspaceId: string | null;
  projectId: string;
  canManage: boolean;
  onMembersChanged: () => void;
}) {
  const { t } = useI18n();
  const [showAddDialog, setShowAddDialog] = useState(false);
  // release201/16 Phase 10: we need the caller's imUserId so the ContactPicker
  // can exclude them from the candidate list. Fetched lazily on first dialog
  // open — keeps the drawer's main load free of a /me roundtrip and means
  // viewers (canManage=false) never make the call.
  const [meImUserId, setMeImUserId] = useState<string | null>(null);
  useEffect(() => {
    if (!showAddDialog || meImUserId) return;
    let cancelled = false;
    imFetch<{ user: { id: string } }>(`/me`).then((res) => {
      if (cancelled) return;
      if (res.ok) setMeImUserId(res.data?.user?.id ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [showAddDialog, meImUserId]);
  // exclude principals already on the project so the ContactPicker doesn't
  // show people who are already members (the server would 409 if we tried).
  const excludePrincipalIds = userMembers.map((m) => m.principalId);
  if (membersLoading) {
    return (
      <div data-testid="project-overview-panel-agents" className="flex items-center gap-2 text-xs text-zinc-500">
        <Loader2 className="w-3 h-3 animate-spin" />
        {t('common.loading')}
      </div>
    );
  }
  return (
    <div data-testid="project-overview-panel-agents" className="space-y-4">
      <section>
        <h3
          className={`text-xs font-semibold uppercase tracking-wider mb-2 ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}
        >
          Agents
          <span className={`ml-1.5 text-[10px] font-normal ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
            ({agentMembers.length})
          </span>
        </h3>
        {agentMembers.length === 0 ? (
          <p className={`text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
            No agent members assigned to this project.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {agentMembers.map((m) => (
              <MemberRow key={m.id} isDark={isDark} m={m} />
            ))}
          </ul>
        )}
      </section>

      <section>
        <div className="flex items-center justify-between mb-2">
          <h3
            className={`text-xs font-semibold uppercase tracking-wider ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}
          >
            User members
            <span className={`ml-1.5 text-[10px] font-normal ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
              ({userMembers.length})
            </span>
          </h3>
          {canManage && workspaceId && (
            <button
              type="button"
              onClick={() => setShowAddDialog(true)}
              data-testid="project-overview-add-member"
              className={`text-[11px] font-medium rounded px-2 py-1 ${
                isDark
                  ? 'bg-violet-600/20 text-violet-200 hover:bg-violet-600/30'
                  : 'bg-violet-100 text-violet-700 hover:bg-violet-200'
              }`}
            >
              + Add
            </button>
          )}
        </div>
        {userMembers.length === 0 ? (
          <p className={`text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
            {t('workspace.project.noExplicitMembers')}
          </p>
        ) : (
          <ul className="space-y-1.5">
            {userMembers.map((m) => (
              <MemberRow key={m.id} isDark={isDark} m={m} />
            ))}
          </ul>
        )}
      </section>

      {showAddDialog && workspaceId ? (
        <AddProjectMemberDialog
          workspaceId={workspaceId}
          projectId={projectId}
          excludePrincipalIds={excludePrincipalIds}
          meImUserId={meImUserId}
          isDark={isDark}
          onOpenChange={(open) => setShowAddDialog(open)}
          onAdded={() => {
            setShowAddDialog(false);
            onMembersChanged();
          }}
        />
      ) : null}
    </div>
  );
}

function SettingsTab({
  isDark,
  project,
  canManage,
  editing,
  editName,
  editDescription,
  editSaving,
  restoring,
  onEditingChange,
  onEditName,
  onEditDescription,
  onEditSave,
  onRestore,
  onArchive,
}: {
  isDark: boolean;
  project: ProjectWithCountsDTO;
  canManage: boolean;
  editing: boolean;
  editName: string;
  editDescription: string;
  editSaving: boolean;
  restoring: boolean;
  onEditingChange: (v: boolean) => void;
  onEditName: (v: string) => void;
  onEditDescription: (v: string) => void;
  onEditSave: () => void;
  onRestore: () => void;
  onArchive: () => void;
}) {
  const { t } = useI18n();
  return (
    <div data-testid="project-overview-panel-settings" className="space-y-5">
      <section>
        <h3
          className={`text-xs font-semibold uppercase tracking-wider mb-2 ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}
        >
          Metadata
        </h3>
        {editing ? (
          <div className="space-y-2">
            <input
              type="text"
              value={editName}
              onChange={(e) => onEditName(e.target.value)}
              disabled={editSaving}
              data-testid="project-overview-edit-name"
              className={`w-full rounded-lg border px-2 py-1.5 text-sm font-semibold outline-none ${
                isDark ? 'border-white/[0.08] bg-zinc-900 text-zinc-100' : 'border-zinc-200 bg-white text-zinc-900'
              }`}
            />
            <textarea
              value={editDescription}
              onChange={(e) => onEditDescription(e.target.value)}
              disabled={editSaving}
              rows={3}
              placeholder={t('workspace.project.descriptionPlaceholder')}
              data-testid="project-overview-edit-description"
              className={`w-full rounded-lg border px-2 py-1.5 text-xs outline-none ${
                isDark
                  ? 'border-white/[0.08] bg-zinc-900 text-zinc-100 placeholder:text-zinc-600'
                  : 'border-zinc-200 bg-white text-zinc-900 placeholder:text-zinc-400'
              }`}
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => onEditSave()}
                disabled={editSaving}
                data-testid="project-overview-edit-save"
                className="flex-1 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
              >
                {editSaving ? t('workspace.project.saving') : t('common.save')}
              </button>
              <button
                type="button"
                onClick={() => onEditingChange(false)}
                disabled={editSaving}
                className={`rounded-lg border px-3 py-1.5 text-xs ${
                  isDark
                    ? 'border-white/[0.08] text-zinc-300 hover:bg-white/[0.05]'
                    : 'border-zinc-200 text-zinc-600 hover:bg-zinc-100'
                }`}
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <p className={`text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>{project.name}</p>
            {project.description ? (
              <p className={`text-xs whitespace-pre-wrap ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
                {project.description}
              </p>
            ) : (
              <p className={`text-xs italic ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>No description.</p>
            )}
            <p className={`text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
              {t('workspace.project.createdAt', { at: formatDate(project.createdAt) })}
            </p>
            {canManage && project.status !== 'archived' ? (
              <button
                type="button"
                onClick={() => onEditingChange(true)}
                data-testid="project-overview-edit"
                className={`mt-2 inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors ${
                  isDark
                    ? 'border-white/[0.08] text-zinc-200 hover:bg-white/[0.05]'
                    : 'border-zinc-200 text-zinc-700 hover:bg-zinc-50'
                }`}
              >
                <Pencil className="w-3.5 h-3.5" />
                {t('workspace.project.editDetails')}
              </button>
            ) : null}
          </div>
        )}
      </section>

      <section>
        <h3
          className={`text-xs font-semibold uppercase tracking-wider mb-2 ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}
        >
          Lifecycle
        </h3>
        {project.status === 'archived' ? (
          canManage ? (
            <button
              type="button"
              onClick={() => onRestore()}
              disabled={restoring}
              data-testid="project-overview-restore"
              className={`flex items-center justify-center gap-2 w-full rounded-xl px-3 py-2 text-sm font-semibold transition-colors disabled:opacity-50 ${
                isDark
                  ? 'border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10'
                  : 'border border-emerald-500/50 text-emerald-700 hover:bg-emerald-50'
              }`}
            >
              <RefreshCcw className="w-4 h-4" />
              {restoring ? t('workspace.project.restoring') : t('workspace.project.restore')}
            </button>
          ) : (
            <p className={`text-xs italic ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
              This project is archived. Restore is owner-only.
            </p>
          )
        ) : canManage ? (
          <button
            type="button"
            onClick={() => onArchive()}
            data-testid="project-overview-archive"
            className={`flex items-center justify-center gap-2 w-full rounded-xl px-3 py-2 text-sm font-semibold transition-colors ${
              isDark
                ? 'border border-amber-500/40 text-amber-300 hover:bg-amber-500/10'
                : 'border border-amber-500/50 text-amber-700 hover:bg-amber-50'
            }`}
          >
            <Archive className="w-4 h-4" />
            {t('workspace.project.archive')}
          </button>
        ) : (
          <p className={`text-xs italic ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
            {t('workspace.project.observerOnly')}
          </p>
        )}
      </section>
    </div>
  );
}

// ────────────────────────── Sub-components ──────────────────────────

function MemberRow({ isDark, m }: { isDark: boolean; m: ProjectMembershipDTO }) {
  return (
    <li className={`flex items-center gap-2 rounded-lg px-2 py-1 ${isDark ? 'bg-white/[0.03]' : 'bg-zinc-50'}`}>
      <span
        className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-semibold ${
          m.principalKind === 'agent' ? 'bg-violet-500/15 text-violet-500' : 'bg-emerald-500/15 text-emerald-500'
        }`}
      >
        {m.principalKind === 'agent' ? 'A' : 'U'}
      </span>
      <span className={`flex-1 truncate text-xs ${isDark ? 'text-zinc-200' : 'text-zinc-700'}`}>{m.principalId}</span>
      <span
        className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
          m.role === 'owner'
            ? 'bg-amber-500/15 text-amber-500'
            : m.role === 'contributor'
              ? 'bg-blue-500/15 text-blue-500'
              : 'bg-zinc-500/15 text-zinc-500'
        }`}
      >
        {m.role}
      </span>
    </li>
  );
}

function StatusBadge({ isDark, status }: { isDark: boolean; status: string }) {
  const { t } = useI18n();
  const isArchived = status === 'archived';
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
        isArchived
          ? isDark
            ? 'bg-amber-500/15 text-amber-300'
            : 'bg-amber-500/20 text-amber-700'
          : isDark
            ? 'bg-emerald-500/15 text-emerald-300'
            : 'bg-emerald-500/20 text-emerald-700'
      }`}
      data-testid="project-overview-status-badge"
    >
      {isArchived ? t('workspace.project.statusArchived') : t('workspace.project.statusActive')}
    </span>
  );
}

type StatAccent = 'open' | 'running' | 'review' | 'completed' | 'failed' | undefined;

function StatTile({
  isDark,
  label,
  primary,
  loading,
  accent,
}: {
  isDark: boolean;
  label: string;
  primary: string;
  loading?: boolean;
  accent?: StatAccent;
}) {
  // Accent-based primary color so the 6 buckets are scannable at a glance.
  // Falls back to neutral when accent is unset (total tile).
  const accentColor =
    accent === 'open'
      ? isDark
        ? 'text-zinc-200'
        : 'text-zinc-700'
      : accent === 'running'
        ? isDark
          ? 'text-violet-300'
          : 'text-violet-700'
        : accent === 'review'
          ? isDark
            ? 'text-amber-300'
            : 'text-amber-700'
          : accent === 'completed'
            ? isDark
              ? 'text-emerald-300'
              : 'text-emerald-700'
            : accent === 'failed'
              ? isDark
                ? 'text-rose-300'
                : 'text-rose-700'
              : isDark
                ? 'text-zinc-100'
                : 'text-zinc-900';
  return (
    <div
      className={`rounded-xl border px-3 py-2 ${
        isDark ? 'border-white/[0.06] bg-zinc-900/40' : 'border-zinc-200 bg-white/80'
      }`}
    >
      <p className={`text-[10px] uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>{label}</p>
      <p className={`text-xl font-semibold ${accentColor}`}>
        {loading ? <Loader2 className="w-4 h-4 inline animate-spin" /> : primary}
      </p>
    </div>
  );
}
