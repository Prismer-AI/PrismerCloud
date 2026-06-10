/**
 * @vitest-environment jsdom
 *
 * release201/09 Phase 4 §15.1 DoD — Project overview drawer.
 *
 * Coverage:
 *   1. Drawer renders header / status badge / description / created stamp
 *      / member count / resource tiles / actions footer for the active
 *      project when isOpen=true.
 *   2. Active project (status='active') exposes Archive + Edit details +
 *      Open dashboard.
 *   3. Archived project (status='archived') exposes Restore + Open dashboard,
 *      hides Archive / Edit (one intent = one affordance — restore is the
 *      only available state transition).
 *   4. Closing the confirm modal does not commit the cascade.
 *   5. Selecting cascade=null double-confirms (button label changes before
 *      firing onConfirm).
 *   6. cascade=hard option is rendered disabled (§15.1 Phase 4 forbidden).
 *
 * The component tree pulls fetch helpers via projects-api + im-api; we mock
 * those so the test stays in-process.
 */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stand-in for I18nProvider: useI18n returns a translator that just echoes
// the key + interpolates {key} placeholders. Tests assert on raw text shown
// in the DOM, but we still want plural / placeholder substitutions to work
// in a deterministic way.
vi.mock('@/contexts/i18n-context', () => ({
  useI18n: () => ({
    locale: 'en',
    setLocale: () => {},
    t: (key: string, values?: Record<string, string | number>) => {
      // Special-case the labels the assertions check on so they read naturally.
      const map: Record<string, string> = {
        'workspace.project.statusActive': 'Active',
        'workspace.project.statusArchived': 'Archived',
        'workspace.project.tasksCompleted': `${values?.count ?? 0} completed`,
      };
      if (map[key]) return map[key];
      // Default: return key (helps diagnose missing translations).
      return values ? `${key}:${JSON.stringify(values)}` : key;
    },
  }),
}));

vi.mock('../../lib/projects-api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    listProjectMembers: vi.fn(),
    deleteProject: vi.fn(),
    updateProject: vi.fn(),
    // S31 C — drawer now consumes GET /api/im/projects/:id/overview.
    getProjectOverview: vi.fn(),
  };
});

vi.mock('../../lib/im-api', () => ({
  imFetch: vi.fn(),
  getWorkspaceToken: vi.fn(() => 'tok'),
}));

import { ProjectOverviewDrawer } from '../project-overview';
import { ProjectArchiveConfirmModal } from '../project-archive-confirm-modal';
import { deleteProject, getProjectOverview, listProjectMembers, updateProject } from '../../lib/projects-api';
import { imFetch } from '../../lib/im-api';
import type { ProjectOverviewDTO, ProjectWithCountsDTO } from '../../lib/projects-api';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function activeProject(overrides: Partial<ProjectWithCountsDTO> = {}): ProjectWithCountsDTO {
  return {
    id: 'proj_q2',
    workspaceId: 'ws_1',
    slug: 'q2-launch',
    name: 'Q2 Launch',
    description: 'Quarterly push',
    status: 'active',
    ownerUserId: 'usr_owner',
    metadata: {},
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-20T00:00:00.000Z',
    archivedAt: null,
    memberCount: 0,
    ...overrides,
  };
}

async function mountDrawer(
  project: ProjectWithCountsDTO,
  props: Partial<React.ComponentProps<typeof ProjectOverviewDrawer>> = {},
) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const onMutated = vi.fn();
  const onClose = vi.fn();
  const notify = vi.fn();
  await act(async () => {
    root.render(
      <ProjectOverviewDrawer
        isDark={false}
        isOpen
        workspaceId="ws_1"
        project={project}
        canManage
        onClose={onClose}
        onMutated={onMutated}
        notify={notify}
        {...props}
      />,
    );
  });
  // Let pending awaits flush.
  await act(async () => {
    await Promise.resolve();
  });
  return {
    host,
    notify,
    onClose,
    onMutated,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

function makeOverviewDTO(project: ProjectWithCountsDTO): ProjectOverviewDTO {
  return {
    project,
    taskStats: { open: 0, running: 1, review: 0, completed: 1, failed: 0, total: 2 },
    recentTasks: [
      {
        id: 't2',
        title: 'Design',
        status: 'running',
        assigneeId: null,
        currentPhase: null,
        updatedAt: '2026-05-20T00:00:00Z',
        createdAt: '2026-05-20T00:00:00Z',
        completedAt: null,
      },
      {
        id: 't1',
        title: 'Spec',
        status: 'completed',
        assigneeId: null,
        currentPhase: null,
        updatedAt: '2026-05-19T00:00:00Z',
        createdAt: '2026-05-19T00:00:00Z',
        completedAt: '2026-05-19T01:00:00Z',
      },
    ],
    memberCount: project.memberCount,
    agentCount: 0,
    conversationCount: 0,
    deferred: { conversations: true, assets: true, memory: true },
  };
}

beforeEach(() => {
  vi.mocked(listProjectMembers).mockResolvedValue({ ok: true, status: 200, data: [] } as Awaited<
    ReturnType<typeof listProjectMembers>
  >);
  // Default mock returns active-project overview; per-test overrides allowed.
  vi.mocked(getProjectOverview).mockImplementation(
    async () =>
      ({
        ok: true,
        status: 200,
        data: makeOverviewDTO(activeProject()),
      }) as Awaited<ReturnType<typeof getProjectOverview>>,
  );
  // Some legacy assertions referenced imFetch — keep it stubbed harmlessly.
  vi.mocked(imFetch).mockResolvedValue({ ok: true, status: 200, data: [] } as Awaited<ReturnType<typeof imFetch>>);
});

afterEach(() => {
  vi.clearAllMocks();
});

async function clickSettingsTab(host: HTMLElement) {
  const tab = host.querySelector('[data-testid="project-overview-tab-settings"]') as HTMLButtonElement;
  expect(tab).toBeTruthy();
  await act(async () => {
    tab.click();
  });
}

describe('ProjectOverviewDrawer — active project', () => {
  it('renders header, 4-tab nav, stats on default Tasks tab, and Open dashboard footer', async () => {
    const { host, cleanup } = await mountDrawer(activeProject());
    const drawer = host.querySelector('[data-testid="project-overview-drawer"]');
    expect(drawer).toBeTruthy();
    expect(host.textContent).toContain('Q2 Launch');
    expect(host.textContent).toContain('q2-launch');
    expect(host.textContent).toContain('Active');

    // 4 tabs all rendered (S31 C DoD: 4-tab drawer required).
    expect(host.querySelector('[data-testid="project-overview-tab-tasks"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="project-overview-tab-conversations"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="project-overview-tab-agents"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="project-overview-tab-settings"]')).toBeTruthy();

    // Tasks tab is default: stats grid + recent activity surfaced.
    expect(host.querySelector('[data-testid="project-overview-stats"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="project-overview-recent"]')).toBeTruthy();

    // Footer's Open dashboard CTA is tab-agnostic.
    expect(host.querySelector('[data-testid="project-overview-open-dashboard"]')).toBeTruthy();

    // Archive / Edit / Restore live inside Settings tab — not in default body.
    expect(host.querySelector('[data-testid="project-overview-archive"]')).toBeNull();
    expect(host.querySelector('[data-testid="project-overview-edit"]')).toBeNull();
    expect(host.querySelector('[data-testid="project-overview-restore"]')).toBeNull();

    // Settings tab exposes Archive + Edit for an active project owner.
    await clickSettingsTab(host);
    expect(host.querySelector('[data-testid="project-overview-archive"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="project-overview-edit"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="project-overview-restore"]')).toBeNull();

    await cleanup();
  });
});

describe('ProjectOverviewDrawer — archived project', () => {
  it('shows Restore in Settings tab + Open dashboard footer; hides Archive / Edit', async () => {
    const { host, cleanup } = await mountDrawer(
      activeProject({ status: 'archived', archivedAt: '2026-05-22T00:00:00.000Z' }),
    );
    expect(host.textContent).toContain('Archived');
    await clickSettingsTab(host);
    expect(host.querySelector('[data-testid="project-overview-restore"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="project-overview-archive"]')).toBeNull();
    expect(host.querySelector('[data-testid="project-overview-edit"]')).toBeNull();
    await cleanup();
  });

  it('Restore button calls updateProject with status=active', async () => {
    vi.mocked(updateProject).mockResolvedValue({ ok: true, status: 200, data: activeProject() } as Awaited<
      ReturnType<typeof updateProject>
    >);
    const { host, onMutated, cleanup } = await mountDrawer(
      activeProject({ status: 'archived', archivedAt: '2026-05-22T00:00:00.000Z' }),
    );
    await clickSettingsTab(host);
    const restoreBtn = host.querySelector('[data-testid="project-overview-restore"]') as HTMLButtonElement;
    expect(restoreBtn).toBeTruthy();
    await act(async () => {
      restoreBtn.click();
    });
    expect(updateProject).toHaveBeenCalledWith('proj_q2', { status: 'active' });
    expect(onMutated).toHaveBeenCalledTimes(1);
    await cleanup();
  });
});

describe('ProjectOverviewDrawer — observer (canManage=false)', () => {
  it('hides Archive / Edit / Restore (read-only) even on Settings tab', async () => {
    const { host, cleanup } = await mountDrawer(activeProject(), { canManage: false });
    await clickSettingsTab(host);
    expect(host.querySelector('[data-testid="project-overview-archive"]')).toBeNull();
    expect(host.querySelector('[data-testid="project-overview-edit"]')).toBeNull();
    expect(host.querySelector('[data-testid="project-overview-restore"]')).toBeNull();
    // Open dashboard is still available — it's a navigation intent, not a
    // mutation, so observers should still be able to use it.
    expect(host.querySelector('[data-testid="project-overview-open-dashboard"]')).toBeTruthy();
    await cleanup();
  });
});

describe('ProjectArchiveConfirmModal', () => {
  it('renders 3 cascade choices with cascade=hard disabled (§15.1 Phase 4 forbidden)', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <ProjectArchiveConfirmModal
          isDark={false}
          isOpen
          project={activeProject()}
          taskCount={5}
          onCancel={() => {}}
          onConfirm={() => {}}
        />,
      );
    });
    const archive = host.querySelector('[data-testid="project-archive-radio-archive"]');
    const nul = host.querySelector('[data-testid="project-archive-radio-null"]');
    const hard = host.querySelector('[data-testid="project-archive-radio-hard"]');
    expect(archive).toBeTruthy();
    expect(nul).toBeTruthy();
    expect(hard).toBeTruthy();
    expect(hard?.getAttribute('aria-disabled')).toBe('true');
    // Default selected = archive (recommended).
    expect(archive?.getAttribute('aria-checked')).toBe('true');
    expect(nul?.getAttribute('aria-checked')).toBe('false');
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  it('cascade=archive confirms in one click', async () => {
    const onConfirm = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <ProjectArchiveConfirmModal
          isDark={false}
          isOpen
          project={activeProject()}
          taskCount={2}
          onCancel={() => {}}
          onConfirm={onConfirm}
        />,
      );
    });
    const confirm = host.querySelector('[data-testid="project-archive-confirm"]') as HTMLButtonElement;
    await act(async () => {
      confirm.click();
    });
    expect(onConfirm).toHaveBeenCalledWith('archive');
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  it('cascade=null requires two clicks before firing onConfirm', async () => {
    const onConfirm = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <ProjectArchiveConfirmModal
          isDark={false}
          isOpen
          project={activeProject()}
          taskCount={3}
          onCancel={() => {}}
          onConfirm={onConfirm}
        />,
      );
    });
    // Select cascade=null.
    const nullChoice = host.querySelector('[data-testid="project-archive-radio-null"]') as HTMLButtonElement;
    await act(async () => {
      nullChoice.click();
    });
    // First click — should NOT fire onConfirm; instead surfaces the
    // "confirm-final" testid.
    const firstClick = host.querySelector('[data-testid="project-archive-confirm"]') as HTMLButtonElement;
    expect(firstClick).toBeTruthy();
    await act(async () => {
      firstClick.click();
    });
    expect(onConfirm).not.toHaveBeenCalled();
    // Second click on the now-promoted final confirm button fires.
    const finalConfirm = host.querySelector('[data-testid="project-archive-confirm-final"]') as HTMLButtonElement;
    expect(finalConfirm).toBeTruthy();
    await act(async () => {
      finalConfirm.click();
    });
    expect(onConfirm).toHaveBeenCalledWith('null');
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
});

describe('ProjectOverviewDrawer — archive flow integration', () => {
  it('opens confirm modal then calls deleteProject with cascade=archive', async () => {
    vi.mocked(deleteProject).mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        project: { ...activeProject(), status: 'archived', archivedAt: '2026-05-26T00:00:00.000Z' },
        cascade: 'archive',
        cascadeReport: { taskUnscoped: 0, conversationUnscoped: 0, assetUnscoped: 0, memoryUnscoped: 0 },
      },
    } as Awaited<ReturnType<typeof deleteProject>>);
    const { host, onMutated, onClose, cleanup } = await mountDrawer(activeProject());

    // Switch to Settings tab where Archive lives now (S31 C).
    await clickSettingsTab(host);
    const archiveBtn = host.querySelector('[data-testid="project-overview-archive"]') as HTMLButtonElement;
    expect(archiveBtn).toBeTruthy();
    await act(async () => {
      archiveBtn.click();
    });

    // Modal is rendered into document.body via fixed-positioned root.
    const confirm = document.body.querySelector('[data-testid="project-archive-confirm"]') as HTMLButtonElement;
    expect(confirm).toBeTruthy();
    await act(async () => {
      confirm.click();
    });

    expect(deleteProject).toHaveBeenCalledWith('proj_q2', { cascade: 'archive' });
    expect(onMutated).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);

    await cleanup();
  });
});
