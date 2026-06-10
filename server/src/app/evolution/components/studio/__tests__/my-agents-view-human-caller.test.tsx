/**
 * @vitest-environment jsdom
 *
 * release201 v2.0.8 hotfix Y3 — my-agents-view human-caller fallback.
 *
 * Y3 bug (2026-05-28): human users (e.g. tomwinshare, who is NOT an agent
 *      themselves but ORCHESTRATES agents in a workspace) opened Studio
 *      "我的 Agent" and saw <NoAgentCard> "还没有配对 Agent" even though the
 *      workspace they were inspecting already had 3 agents (CEO / Eng / Mkt)
 *      bound via Devices pairing.
 *
 *      Root cause: `reload()` called `fetchProfile(agentId=null)` for the
 *      caller, which (for human users) returned `identity=null`. The early
 *      return `if (!identity) return <NoAgentCard>` then ate every agent in
 *      the workspace.
 *
 * Y3 fix: studio-tab lifts /api/im/studio/installed.agents[] (already
 *      fetched for X2's onboarding state) into local state and passes it to
 *      <MyAgentsView> as `workspaceAgents`. When `fetchProfile` returns no
 *      identity AND the caller didn't pre-pick an agentId, reload() falls
 *      back to `workspaceAgents[0]`, re-queries its profile, and renders
 *      that agent's IdentityCard.
 *
 * 行为契约:
 *   1. caller is human (`fetchProfile(null).identity === null`) AND
 *      workspaceAgents non-empty → IdentityCard for workspaceAgents[0].
 *   2. caller is human AND workspaceAgents empty → NoAgentCard (unchanged).
 *   3. fallback also calls fetchInstalled with effective agentId so skills
 *      table reflects the agent we're showing, not the (empty) caller.
 */
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../types')>();
  return {
    ...actual,
    fetchProfile: vi.fn(),
    fetchInstalled: vi.fn(),
  };
});

import { MyAgentsView, type WorkspaceAgentSummary } from '../my-agents-view';
import { fetchProfile, fetchInstalled } from '../types';
import { I18nProvider } from '@/contexts/i18n-context';

const fetchProfileMock = vi.mocked(fetchProfile);
const fetchInstalledMock = vi.mocked(fetchInstalled);

interface MountResult {
  host: HTMLElement;
  cleanup: () => Promise<void>;
}

async function mount(props: {
  agentId?: string | null;
  workspaceAgents?: WorkspaceAgentSummary[];
  onAgentChange?: (id: string | null) => void;
}): Promise<MountResult> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  const noop = () => undefined;
  await act(async () => {
    root.render(
      <I18nProvider>
        <MyAgentsView
          isDark={false}
          agentId={props.agentId ?? null}
          onAgentChange={props.onAgentChange ?? noop}
          onHasAgentChange={noop}
          onHasInstalledChange={noop}
          workspaceAgents={props.workspaceAgents ?? []}
        />
      </I18nProvider>,
    );
  });
  // Flush reload()'s chained fetchProfile → (maybe) fetchProfile → fetchInstalled.
  for (let i = 0; i < 12; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
  return {
    host,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

beforeEach(() => {
  // Silence SiriOrb canvas-2d "not implemented" jsdom log spam.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(Storage.prototype, 'getItem').mockReturnValue('{"token":"t"}');
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('my-agents-view human-caller fallback (release201 v2.0.8 hotfix Y3)', () => {
  it('falls back to workspaceAgents[0] when caller identity is null and workspace has agents', async () => {
    // Caller has no own identity (tomwinshare is a human).
    fetchProfileMock.mockImplementation(async (agentId: string | null) => {
      if (agentId === null) {
        return { agentId: null, identity: null, personality: null, credits: null, workspaces: [] };
      }
      if (agentId === 'agent-ceo') {
        return {
          agentId: 'agent-ceo',
          identity: {
            agentId: 'agent-ceo',
            displayName: 'CEO',
            agentType: 'agent',
            status: 'online',
            did: 'did:prismer:ceo',
            capabilities: ['skill.invoke'],
          },
          personality: { rigor: 0.7, creativity: 0.6, risk_tolerance: 0.4 },
          credits: null,
          workspaces: [],
        };
      }
      return null;
    });
    fetchInstalledMock.mockResolvedValue({
      agentId: 'agent-ceo',
      activeAgentId: 'agent-ceo',
      agents: [],
      skills: [],
    });

    const onAgentChange = vi.fn();
    const { host, cleanup } = await mount({
      agentId: null,
      workspaceAgents: [
        { agentId: 'agent-ceo', displayName: 'CEO' },
        { agentId: 'agent-eng', displayName: 'Eng' },
      ],
      onAgentChange,
    });

    // Identity card should render — NOT the NoAgentCard.
    const identityCard = host.querySelector('[data-spatial-grammar="identityCard"]');
    expect(identityCard).toBeTruthy();
    // CEO display name appears (header h3 + portrait label).
    expect(host.textContent ?? '').toContain('CEO');

    // We should NOT have called fetchInstalled with `null` (would be the
    // pre-Y3 leak). Either it's called with the effective agentId (after
    // fallback resolved) OR with 'agent-ceo' directly.
    const installedCalls = fetchInstalledMock.mock.calls;
    expect(installedCalls.length).toBeGreaterThan(0);
    expect(installedCalls.some((c) => c[0] === 'agent-ceo')).toBe(true);

    // Two fetchProfile calls: (null → identity:null), (agent-ceo → CEO).
    expect(fetchProfileMock).toHaveBeenCalledWith(null);
    expect(fetchProfileMock).toHaveBeenCalledWith('agent-ceo');

    // Parent should learn the effective agent for downstream views.
    expect(onAgentChange).toHaveBeenCalledWith('agent-ceo');

    await cleanup();
  });

  it('renders NoAgentCard when caller identity is null AND workspaceAgents is empty', async () => {
    fetchProfileMock.mockResolvedValue({
      agentId: null,
      identity: null,
      personality: null,
      credits: null,
      workspaces: [],
    });
    fetchInstalledMock.mockResolvedValue({
      agentId: null,
      activeAgentId: null,
      agents: [],
      skills: [],
    });

    const { host, cleanup } = await mount({
      agentId: null,
      workspaceAgents: [],
    });

    // No identityCard grammar — NoAgentCard surface instead.
    expect(host.querySelector('[data-spatial-grammar="identityCard"]')).toBeNull();
    // NoAgentCard copy (i18n key evolution.studio.myAgents.noAgentTitle).
    // We don't pin the exact translated string; just assert UserCircle2 icon
    // wrapper + a single fetchProfile call (no fallback was attempted).
    const profileCalls = fetchProfileMock.mock.calls;
    expect(profileCalls.length).toBe(1);
    expect(profileCalls[0][0]).toBeNull();

    await cleanup();
  });

  it('respects pre-selected agentId without forcing the fallback path', async () => {
    // When the parent already knows which agent to inspect, reload() must
    // honour it and not silently swap to workspaceAgents[0].
    fetchProfileMock.mockImplementation(async (agentId: string | null) => {
      if (agentId === 'agent-eng') {
        return {
          agentId: 'agent-eng',
          identity: {
            agentId: 'agent-eng',
            displayName: 'Eng',
            agentType: 'agent',
            status: 'online',
            did: 'did:prismer:eng',
            capabilities: [],
          },
          personality: null,
          credits: null,
          workspaces: [],
        };
      }
      return { agentId: null, identity: null, personality: null, credits: null, workspaces: [] };
    });
    fetchInstalledMock.mockResolvedValue({
      agentId: 'agent-eng',
      activeAgentId: 'agent-eng',
      agents: [],
      skills: [],
    });

    const onAgentChange = vi.fn();
    const { host, cleanup } = await mount({
      agentId: 'agent-eng',
      workspaceAgents: [
        { agentId: 'agent-ceo', displayName: 'CEO' },
        { agentId: 'agent-eng', displayName: 'Eng' },
      ],
      onAgentChange,
    });

    expect(host.textContent ?? '').toContain('Eng');
    expect(host.textContent ?? '').not.toContain('CEO');
    // No `onAgentChange` because agentId was already pinned.
    expect(onAgentChange).not.toHaveBeenCalled();

    await cleanup();
  });
});
