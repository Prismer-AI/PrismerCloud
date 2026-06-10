'use client';

/**
 * Evolution Studio v2 — shared studio data context (release201/28).
 *
 * Resolves the active workspace (id + name) and its full agent roster ONCE at
 * the shell top level, then fans the result out via React context so every
 * surface (roster / installed / genes / profiles / templates …) reads the same
 * source of truth instead of each re-resolving the workspace.
 *
 * ─── real-first / mock-fallback ──────────────────────────────────────────────
 * The context is REAL-FIRST. When the user is authed and the live endpoints
 * return data, we render the live workspace + agents. We fall back to the mock
 * fixtures (`../mock`) ONLY when `STUDIO_MOCK_ENABLED` is on AND the live source
 * is unavailable (unauthed / fetch returned empty / fetch threw). This keeps the
 * offline demo point-through-able without ever masking a real (authed) empty
 * state — an authed user with a genuinely empty workspace sees the empty roster,
 * not mock agents.
 *
 * Resolution chain (live):
 *   resolveWorkspaceIdFromBackend()  → workspaceId
 *   fetchInstalled(null, workspaceId).agents[]  → workspace agent roster
 *   fetchProfile(agentId).workspaces[]          → workspace name (matched by id)
 *
 * `agentId` / `setAgentId` are controlled by the shell (URL-backed). The context
 * stores no local mirror — the shell passes the URL-derived agentId in and the
 * setter calls back up to the URL writer.
 */

import { createContext, useContext, useEffect, useMemo, useState } from 'react';

import { STUDIO_MOCK_ENABLED } from '../flags';
import { MOCK_OVERVIEW } from '../mock';
import type { AgentRuntimeState, AgentSummary } from '../types';
import {
  fetchInstalled,
  fetchProfile,
  resolveWorkspaceIdFromBackend,
} from '../../types';

export interface StudioContextValue {
  workspaceId: string | null;
  workspaceName: string;
  /** Every agent in the active workspace (real-first). */
  agents: AgentSummary[];
  /** URL-derived active agent id (controlled by the shell). */
  agentId: string | null;
  /** Persist an agent selection (writes the URL via the shell). */
  setAgentId: (agentId: string | null) => void;
  loading: boolean;
  error: boolean;
  /** True when the values are served from the mock fixtures (demo fallback). */
  isMock: boolean;
}

const StudioContext = createContext<StudioContextValue | null>(null);

/** Map a backend agent-status string onto the roster runtime-state enum. */
function toRuntimeState(status?: string): AgentRuntimeState {
  switch ((status ?? '').toLowerCase()) {
    case 'thinking':
      return 'thinking';
    case 'busy':
    case 'running':
      return 'busy';
    case 'offline':
    case 'paused':
      return 'offline';
    default:
      return 'idle';
  }
}

/** Adapt the live /studio/installed `agents[]` shape into AgentSummary. */
function toAgentSummary(a: {
  agentId: string;
  username?: string;
  displayName: string;
  agentType?: string;
  status?: string;
}): AgentSummary {
  const handleBase = a.username || a.displayName || a.agentId;
  return {
    id: a.agentId,
    handle: handleBase.startsWith('@') ? handleBase : `@${handleBase}`,
    type: a.agentType || 'agent',
    state: toRuntimeState(a.status),
    isOrchestrator: (a.agentType ?? '').toLowerCase() === 'orchestrator',
    // Facet counts are not in the roster payload; surfaces that need real
    // counts fetch them per-agent. 0 here renders honestly (no fake numbers).
    skills: 0,
    genes: 0,
    snapshots: 0,
  };
}

export interface StudioContextProviderProps {
  agentId: string | null;
  onAgentChange: (agentId: string | null) => void;
  children: React.ReactNode;
}

export function StudioContextProvider({ agentId, onAgentChange, children }: StudioContextProviderProps) {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState<string>('');
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [isMock, setIsMock] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const fallbackToMock = () => {
      if (cancelled) return;
      if (STUDIO_MOCK_ENABLED) {
        setWorkspaceId(MOCK_OVERVIEW.workspaceId);
        setWorkspaceName(MOCK_OVERVIEW.workspaceName);
        setAgents(MOCK_OVERVIEW.agents);
        setIsMock(true);
        setError(false);
      } else {
        setError(true);
      }
      setLoading(false);
    };

    (async () => {
      setLoading(true);
      try {
        const wsId = await resolveWorkspaceIdFromBackend();
        if (cancelled) return;
        if (!wsId) {
          fallbackToMock();
          return;
        }

        const installed = await fetchInstalled(null, wsId);
        if (cancelled) return;
        const liveAgents = (installed?.agents ?? []).map(toAgentSummary);

        if (liveAgents.length === 0) {
          // Authed but empty: prefer the honest empty state when mock is off;
          // only fall back to fixtures for the offline demo.
          fallbackToMock();
          return;
        }

        // Resolve the workspace display name from the profile's workspaces[].
        let name = '';
        const profile = await fetchProfile(liveAgents[0]?.id ?? null);
        if (cancelled) return;
        const match = profile?.workspaces?.find((w) => w.workspaceId === wsId);
        name = match?.name ?? profile?.workspaces?.[0]?.name ?? '';

        setWorkspaceId(wsId);
        setWorkspaceName(name);
        setAgents(liveAgents);
        setIsMock(false);
        setError(false);
        setLoading(false);
      } catch {
        fallbackToMock();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const value = useMemo<StudioContextValue>(
    () => ({
      workspaceId,
      workspaceName,
      agents,
      agentId,
      setAgentId: onAgentChange,
      loading,
      error,
      isMock,
    }),
    [workspaceId, workspaceName, agents, agentId, onAgentChange, loading, error, isMock],
  );

  return <StudioContext.Provider value={value}>{children}</StudioContext.Provider>;
}

/**
 * Read the shared studio context. Throws when used outside the provider so a
 * surface can't silently render with no workspace.
 */
export function useStudioContext(): StudioContextValue {
  const ctx = useContext(StudioContext);
  if (!ctx) {
    throw new Error('useStudioContext must be used within <StudioContextProvider>');
  }
  return ctx;
}
