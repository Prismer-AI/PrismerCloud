/**
 * @vitest-environment jsdom
 *
 * release201 v2.0.8 hotfix A4 + X2 — Studio onboarding state sync.
 *
 * A4 bug: 用户进 studio 落在 Skills tab (而非 my-agents) 时, my-agents-view 不
 *      render, 其 `onHasAgentChange` / `onHasInstalledChange` callback 永远不
 *      触发, studio-tab 的 hasAgent / hasInstalled / hasDraft 永远是 false, 切
 *      回 my-agents tab 时 4 步 onboarding panel 错误地继续显示.
 *
 * A4 fix: studio-tab 自己 fetch agent + installed + draft + project 状态, 不依
 *      赖子组件 callback.
 *
 * X2 bug (2026-05-28): A4 fix 用 fetchProfile(null) 拿 caller 自己的 agent
 *      identity, 但 human caller agentId=null → hasAgent 永远 false. 即使
 *      workspace 已经有 3 个 agent 在跑, onboarding 也错误显示.
 *
 * X2 fix: 改用 /api/im/studio/installed (该 BFF 返 workspace 内全部 agents 和
 *      active agent 的 installed skills), hasAgent 从 installed.agents.length
 *      推导, 与 caller identity 解耦.
 *
 * 行为契约:
 *   1. hasAgent=true after fetch when installed.agents 非空 (即使 caller 是
 *      human; profile.identity 可以是 null).
 *   2. hasInstalled=true after fetch when installed.skills 非空.
 *   3. hasProject=true after fetch when /api/im/projects?workspaceId=... 有
 *      active 项目 (total > 0).
 *   4. 全部状态独立于 safeView — 即使 view='skills' (my-agents-view 没 render),
 *      切回 view='my-agents' 时 onboarding panel 已被状态 dismiss.
 */
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Stub studio types module so studio-tab's fetchProfile / fetchInstalled /
// fetchDrafts hit our fakes instead of `fetch('/api/im/...')`.
//
// my-agents-view + skills-view children also import from the same module —
// the fakes below return shapes that are valid for both.
vi.mock('../studio/types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../studio/types')>();
  return {
    ...actual,
    fetchProfile: vi.fn(),
    fetchInstalled: vi.fn(),
    fetchDrafts: vi.fn(),
    fetchOverview: vi.fn(async () => null),
    fetchDraftDetail: vi.fn(async () => null),
    fetchWorkspaceSkillsByStage: vi.fn(async () => []),
    fetchSkillDetail: vi.fn(async () => null),
    fetchEvalRun: vi.fn(async () => null),
    fetchStudioCapsules: vi.fn(async () => null),
    fetchStudioGenes: vi.fn(async () => null),
    fetchMetricAggregate: vi.fn(async () => null),
    // workspace resolver — return a stable id so projects fetch fires.
    readActiveWorkspaceId: vi.fn(() => 'ws-1'),
    resolveWorkspaceIdFromBackend: vi.fn(async () => 'ws-1'),
  };
});

// projects-api → listProjects is the second piece studio-tab fetches.
vi.mock('@/app/workspace/lib/projects-api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    listProjects: vi.fn(),
  };
});

import { StudioTab } from '../studio-tab';
import type { SkillsSubview, StudioView } from '../studio-tab';
import { fetchProfile, fetchInstalled, fetchDrafts } from '../studio/types';
import { listProjects } from '@/app/workspace/lib/projects-api';
import { I18nProvider } from '@/contexts/i18n-context';

const fetchProfileMock = vi.mocked(fetchProfile);
const fetchInstalledMock = vi.mocked(fetchInstalled);
const fetchDraftsMock = vi.mocked(fetchDrafts);
const listProjectsMock = vi.mocked(listProjects);

interface MountResult {
  host: HTMLElement;
  root: Root;
  rerender: (view: StudioView) => Promise<void>;
  cleanup: () => Promise<void>;
}

async function mountStudio(initialView: StudioView): Promise<MountResult> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const noop = () => undefined;
  const render = async (view: StudioView) => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <StudioTab
            isDark={false}
            view={view}
            subview={'authoring' as SkillsSubview}
            agentId={null}
            draftId={null}
            onViewChange={noop}
            onSubviewChange={noop}
            onAgentChange={noop}
            onDraftChange={noop}
          />
        </I18nProvider>,
      );
    });
    // Let queued microtasks (Promise.resolve in mocks) flush. studio-tab
    // chains fetchProfile → fetchInstalled, plus a separate fetchDrafts +
    // listProjects effect — each await + state-set needs its own flush.
    for (let i = 0; i < 10; i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  };
  await render(initialView);
  return {
    host,
    root,
    rerender: render,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

beforeEach(() => {
  // Defaults: no agent, no projects, no installed skills, no drafts.
  // Individual tests override.
  fetchProfileMock.mockResolvedValue(null);
  fetchInstalledMock.mockResolvedValue(null);
  fetchDraftsMock.mockResolvedValue([]);
  // listProjects returns the BFF { ok, data: { items, total } } shape.
  listProjectsMock.mockResolvedValue({
    ok: true,
    status: 200,
    data: { items: [], total: 0 },
    error: null,
    raw: undefined,
  } as Awaited<ReturnType<typeof listProjects>>);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('studio-tab state sync (release201 v2.0.8 hotfix A4 + X2)', () => {
  it('hasAgent=true when workspace has agents (human caller — X2 bug)', async () => {
    // Caller is human → profile.identity=null (this is what tomwinshare
    // returns in prod). Pre-X2 fix this kept hasAgent=false forever.
    fetchProfileMock.mockResolvedValue({
      agentId: null,
      identity: null,
      personality: null,
      credits: null,
      workspaces: [],
    });
    // /studio/installed BFF returns workspace agents regardless of caller
    // identity — this is the source of truth post-X2.
    fetchInstalledMock.mockResolvedValue({
      agentId: null,
      activeAgentId: 'agent-9',
      agents: [
        { agentId: 'agent-9', displayName: 'CEO', agentType: 'agent', status: 'online' },
        { agentId: 'agent-10', displayName: 'Eng', agentType: 'agent', status: 'online' },
        { agentId: 'agent-11', displayName: 'Mkt', agentType: 'agent', status: 'online' },
      ],
      workspaceId: 'ws-1',
      skills: [],
    });
    // Installed (skills) empty → install step still incomplete → onboarding
    // still shows pair=done but install=todo. We check hasAgent here.
    const { host, cleanup } = await mountStudio('my-agents');
    // Onboarding panel should still be visible (install/draft/project not
    // yet done) but the pair step should be marked done.
    const panel = host.querySelector('[data-testid="studio-onboarding"]');
    expect(panel).toBeTruthy();
    // First step row should have the Check icon (done) — done rows omit the
    // CTA link/button per onboarding.tsx StepRow.
    const items = panel!.querySelectorAll('ol > li');
    expect(items.length).toBe(4);
    const pairRow = items[0];
    expect(pairRow.querySelector('a')).toBeNull();
    expect(pairRow.querySelector('button')).toBeNull();
    // fetchInstalled fired with workspaceId (X2 scoping requirement)
    expect(fetchInstalledMock).toHaveBeenCalledWith(null, 'ws-1');
    await cleanup();
  });

  it('hasAgent=false when workspace has 0 agents (even if caller is an agent)', async () => {
    // Edge case: caller is an agent (identity.agentId present) but the
    // active workspace itself has no agents → pair step still TODO.
    fetchProfileMock.mockResolvedValue({
      agentId: 'agent-self',
      identity: {
        agentId: 'agent-self',
        displayName: 'Self',
        agentType: 'human',
        status: 'online',
        capabilities: [],
      },
      personality: null,
      credits: null,
      workspaces: [],
    });
    fetchInstalledMock.mockResolvedValue({
      agentId: null,
      activeAgentId: null,
      agents: [],
      workspaceId: 'ws-1',
      skills: [],
    });
    const { host, cleanup } = await mountStudio('my-agents');
    const panel = host.querySelector('[data-testid="studio-onboarding"]');
    expect(panel).toBeTruthy();
    const items = panel!.querySelectorAll('ol > li');
    const pairRow = items[0];
    // pair step is TODO → CTA link visible (href to /workspace?tab=devices)
    expect(pairRow.querySelector('a')).not.toBeNull();
    await cleanup();
  });

  it('hasProject=true after fetch when active project exists', async () => {
    listProjectsMock.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        items: [
          {
            id: 'proj-1',
            workspaceId: 'ws-1',
            slug: 'p1',
            name: 'P1',
            description: null,
            status: 'active',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          } as never,
        ],
        total: 1,
      },
      error: null,
      raw: undefined,
    } as Awaited<ReturnType<typeof listProjects>>);
    const { host, cleanup } = await mountStudio('my-agents');
    const panel = host.querySelector('[data-testid="studio-onboarding"]');
    expect(panel).toBeTruthy();
    const items = panel!.querySelectorAll('ol > li');
    expect(items.length).toBe(4);
    // Project step is row 2 (pair → PROJECT → install → draft).
    const projectRow = items[1];
    // Done rows have no CTA.
    expect(projectRow.querySelector('a')).toBeNull();
    expect(projectRow.querySelector('button')).toBeNull();
    expect(listProjectsMock).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws-1' }));
    await cleanup();
  });

  it('all four sync independent of safeView (Skills tab path still updates state)', async () => {
    // Caller lands on Skills tab (my-agents-view never renders), but all
    // backing state is "set up" → switching back to my-agents must show the
    // done panel (no 4-step list).
    fetchProfileMock.mockResolvedValue({
      agentId: null,
      identity: null,
      personality: null,
      credits: null,
      workspaces: [],
    });
    fetchInstalledMock.mockResolvedValue({
      agentId: null,
      activeAgentId: 'agent-9',
      agents: [{ agentId: 'agent-9', displayName: 'CEO', agentType: 'agent', status: 'online' }],
      skills: [
        {
          skillId: 'sk-1',
          slug: 'sk-1',
          name: 'Sk 1',
          version: '1.0.0',
          installedAt: new Date().toISOString(),
          lastInvokedAt: null,
          status: 'active',
        },
      ],
      workspaceId: 'ws-1',
    });
    fetchDraftsMock.mockResolvedValue([
      {
        id: 'd-1',
        slug: 'd-1',
        name: 'Draft 1',
        description: '',
        status: 'draft',
      },
    ]);
    listProjectsMock.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        items: [
          {
            id: 'proj-1',
            workspaceId: 'ws-1',
            slug: 'p1',
            name: 'P1',
            description: null,
            status: 'active',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          } as never,
        ],
        total: 1,
      },
      error: null,
      raw: undefined,
    } as Awaited<ReturnType<typeof listProjects>>);

    const { host, rerender, cleanup } = await mountStudio('skills');
    // On Skills tab my-agents-view is NOT in the DOM, so its
    // onHasAgentChange callback never fires — pre-fix this was the bug.
    // The studio-tab's own fetches must still have populated state. X2:
    // studio-tab no longer calls fetchProfile directly — it derives agent
    // presence from fetchInstalled.agents instead.
    expect(fetchInstalledMock).toHaveBeenCalled();
    expect(fetchDraftsMock).toHaveBeenCalled();
    expect(listProjectsMock).toHaveBeenCalled();

    // Now switch to my-agents tab. Onboarding panel must NOT appear (all
    // four state flags are true).
    await rerender('my-agents');
    expect(host.querySelector('[data-testid="studio-onboarding"]')).toBeNull();
    await cleanup();
  });
});
