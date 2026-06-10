'use client';

/**
 * Wave 3 C2 — Workspace Devices panel (R7 §4.8.2.3 in
 * docs/release200/14-messaging-state-machine-reliability.md).
 *
 * 2026-05-22 (single-card refactor) — Previously this panel rendered a
 * **second** per-daemon card grid above the DeviceWorkbench, which showed
 * the same daemons via a binding lens. Users reported the duplicate
 * confusing ("which card is the real one?") — same daemon's status would
 * even disagree across the two views (Idle here vs online there).
 *
 * The panel is now collapsed to a single responsibility: render the
 * **global contested banner** when ≥1 binding is contested. All the
 * per-daemon / per-agent binding metadata that used to live in the
 * BindingsView card has migrated INTO the DeviceWorkbench card grid, via
 * the `BindingChipsRow` subcomponent and `useOrchestratorAppointment`
 * hook exported below. The DeviceAgentCard inside runtime-manager.tsx
 * now embeds these directly so a single card per daemon expresses both
 * presence (heartbeat) and binding (Contested / Pinned / Chief of Staff /
 * last dispatch).
 *
 * Driven by `/api/im/workspaces/:wsId/agent-bindings`. Real-time updates
 * arrive via `agent.binding.contested` / `agent.binding.rebound` SSE
 * events dispatched into `onRefreshBindings` by the parent.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, Check } from 'lucide-react';

import {
  isCurrentlyContested,
  type AgentBindingDTO,
  type DaemonKind,
} from '../lib/agent-bindings-api';
import type { WorkspaceRuntimeDTO, RuntimeDeviceDTO } from '../lib/types';
import { radius, surface } from '../lib/design';
import { imFetch } from '../lib/im-api';
import { useApp } from '@/contexts/app-context';

/**
 * 2026-05-22 — Inline Chief of Staff toggle on each orchestrator-eligible
 * agent row. Previously the "appoint orchestrator" entry was buried inside
 * Workspace Settings → Chief of Staff section, so users never enabled it and
 * had to manually approve every routine task. Surfacing the toggle on the
 * Devices panel (right next to the agent identity) puts authorization at the
 * point of perception.
 *
 * Eligibility is heuristic in the DTO layer (AgentBindingDTO lacks
 * `agentType` / `username`):
 *   1. The agent that is currently appointed orchestrator (authoritative).
 *   2. Any agent whose username === 'ceo' (case-insensitive).
 *
 * The username map is sourced from `/workspaces/:wsId/agents`. The current
 * appointment from `/workspaces/:wsId/orchestrator`. Both are fetched once on
 * mount and refetched after every toggle.
 */
export interface OrchestratorInfo {
  agentImUserId: string;
  agentUsername: string;
  agentDisplayName: string;
  authorizedAt: string;
  authorizedByImUserId: string;
  authorizedByDisplayName: string;
}

interface OrchestratorEnvelope {
  workspace: { id: string; name: string; ownerImUserId: string };
  orchestrator: OrchestratorInfo | null;
}

interface WorkspaceAgentRow {
  agentId: string;
  userId: string;
  username: string;
  displayName: string;
}

interface DevicesPanelProps {
  isDark: boolean;
  workspaceId: string | null;
  bindings: AgentBindingDTO[];
  runtime: WorkspaceRuntimeDTO | null;
  now: number;
  loading?: boolean;
  loadError?: string | null;
  /** Open the rebalance modal — null clears any open modal upstream. */
  onOpenRebalance: (focus: { agentImUserId?: string } | null) => void;
  /** Force-refresh from the parent (e.g. after sync event). */
  onRefreshBindings: () => Promise<void> | void;
}

/**
 * 2026-05-22 — Orchestrator appointment + agent username map, extracted
 * from the legacy DevicesPanel state so DeviceWorkbench (runtime-manager.tsx)
 * can share the same source of truth as the contested banner. Two parallel
 * reads on workspace switch:
 *   1. current Chief of Staff appointment (`/workspaces/:wsId/orchestrator`)
 *   2. workspace agent roster (`/workspaces/:wsId/agents`) — used to resolve
 *      `username === 'ceo'` from the agentImUserId in the binding chip row.
 * Toggling the chip POSTs / DELETEs and re-fetches the orchestrator envelope.
 *
 * Exported so runtime-manager's RuntimeManager can hoist this state to a
 * single instance and pass orchestrator info down to BindingChipsRow.
 */
export function useOrchestratorAppointment(workspaceId: string | null): {
  orchestrator: OrchestratorInfo | null;
  usernameByImUserId: Map<string, string>;
  orchestratorToggleBusy: string | null;
  onToggleChiefOfStaff: (agentImUserId: string, currentlyOn: boolean) => Promise<void>;
} {
  const { addToast } = useApp();
  const [orchestrator, setOrchestrator] = useState<OrchestratorInfo | null>(null);
  const [usernameByImUserId, setUsernameByImUserId] = useState<Map<string, string>>(
    () => new Map(),
  );
  const [orchestratorToggleBusy, setOrchestratorToggleBusy] = useState<string | null>(null);

  const refetchOrchestrator = useCallback(async () => {
    if (!workspaceId) return;
    const res = await imFetch<OrchestratorEnvelope>(
      `/workspaces/${encodeURIComponent(workspaceId)}/orchestrator`,
    );
    if (res.ok) setOrchestrator(res.data.orchestrator);
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId) {
      setOrchestrator(null);
      setUsernameByImUserId(new Map());
      return;
    }
    let cancelled = false;
    void (async () => {
      const [orchRes, agentsRes] = await Promise.all([
        imFetch<OrchestratorEnvelope>(
          `/workspaces/${encodeURIComponent(workspaceId)}/orchestrator`,
        ),
        imFetch<WorkspaceAgentRow[]>(
          `/workspaces/${encodeURIComponent(workspaceId)}/agents`,
        ),
      ]);
      if (cancelled) return;
      if (orchRes.ok) setOrchestrator(orchRes.data.orchestrator);
      if (agentsRes.ok) {
        const map = new Map<string, string>();
        for (const row of agentsRes.data ?? []) {
          // The agents endpoint returns `userId` as the IM user id used in
          // bindings (see ChiefOfStaffSection for the canonical mapping).
          map.set(row.userId, row.username);
        }
        setUsernameByImUserId(map);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const onToggleChiefOfStaff = useCallback(
    async (agentImUserId: string, currentlyOn: boolean) => {
      if (!workspaceId) return;
      setOrchestratorToggleBusy(agentImUserId);
      try {
        // Surface failures explicitly — `imFetch` resolves `{ ok: false }` on
        // HTTP errors; without a toast the user sees the busy spinner clear
        // and has no idea the appointment didn't change.
        const res = currentlyOn
          ? await imFetch(`/workspaces/${encodeURIComponent(workspaceId)}/orchestrator`, {
              method: 'DELETE',
            })
          : await imFetch(`/workspaces/${encodeURIComponent(workspaceId)}/orchestrator`, {
              method: 'POST',
              body: JSON.stringify({ agentImUserId }),
            });
        if (!res.ok) {
          console.error('[useOrchestratorAppointment] toggle failed:', res.message);
          addToast(`无法切换 Chief of Staff:${res.message || '未知错误'}`, 'error');
          return;
        }
        await refetchOrchestrator();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[useOrchestratorAppointment] toggle threw:', err);
        addToast(`无法切换 Chief of Staff:${message}`, 'error');
      } finally {
        setOrchestratorToggleBusy(null);
      }
    },
    [workspaceId, refetchOrchestrator, addToast],
  );

  return { orchestrator, usernameByImUserId, orchestratorToggleBusy, onToggleChiefOfStaff };
}

export function DevicesPanel({
  isDark,
  workspaceId,
  bindings,
  loading,
  loadError,
  onOpenRebalance,
  onRefreshBindings,
}: DevicesPanelProps) {
  const contestedAgents = bindings.filter((b) => isCurrentlyContested(b));

  if (!workspaceId) {
    return (
      <EmptyState
        isDark={isDark}
        title="No workspace selected"
        hint="Pick or create a workspace to see its agent–device bindings."
      />
    );
  }

  if (loadError) {
    return (
      <div
        data-testid="devices-panel-error"
        className={`flex items-center justify-between gap-3 border p-4 ${radius.pane} ${
          isDark ? 'border-red-400/30 bg-red-500/10 text-red-200' : 'border-red-300 bg-red-50 text-red-700'
        }`}
      >
        <span className="text-sm">Couldn&rsquo;t load binding data: {loadError}</span>
        <button
          type="button"
          onClick={() => void onRefreshBindings()}
          className={`shrink-0 rounded-xl border px-3 py-1.5 text-xs font-semibold transition-colors ${
            isDark ? 'border-red-300/40 hover:bg-red-500/20' : 'border-red-300 hover:bg-red-100'
          }`}
        >
          Retry
        </button>
      </div>
    );
  }

  if (loading && bindings.length === 0) {
    return (
      <div
        data-testid="devices-panel-loading"
        className={`flex h-32 items-center justify-center text-sm ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
      >
        Loading agent bindings…
      </div>
    );
  }

  // 2026-05-22 (single-card refactor) — panel body is now just the global
  // contested banner. The per-daemon binding cards moved INTO each
  // DeviceSurfaceCard in runtime-manager.tsx via `BindingChipsRow`. Return
  // null silently when there's nothing contested; the parent already gates
  // rendering on `bindings.some(b => isCurrentlyContested(b))`.
  if (contestedAgents.length === 0) {
    return null;
  }

  return (
    <section data-testid="devices-panel" className="flex flex-col gap-4">
      <ContestedBanner
        isDark={isDark}
        contestedCount={contestedAgents.length}
        onRebalance={() => onOpenRebalance(null)}
      />
    </section>
  );
}

function ContestedBanner({
  isDark,
  contestedCount,
  onRebalance,
}: {
  isDark: boolean;
  contestedCount: number;
  onRebalance: () => void;
}) {
  return (
    <div
      data-testid="devices-panel-contested-banner"
      data-contested-count={contestedCount}
      className={`flex items-center gap-3 border p-3 ${radius.pane} ${
        isDark ? 'border-red-400/30 bg-red-500/10 text-red-100' : 'border-red-300 bg-red-50 text-red-800'
      }`}
    >
      <AlertTriangle className="h-5 w-5 shrink-0" />
      <div className="flex-1 text-sm">
        <strong className="font-semibold">
          {contestedCount} agent{contestedCount === 1 ? '' : 's'} contested
        </strong>
        <span className={`ml-2 ${isDark ? 'text-red-100/85' : 'text-red-700'}`}>
          Two or more daemons tried to host the same agent. Pick the owner explicitly to stop dispatches falling
          into the wrong runtime.
        </span>
      </div>
      <button
        type="button"
        onClick={onRebalance}
        data-testid="devices-panel-rebalance-cta"
        className={`shrink-0 rounded-xl border px-3 py-1.5 text-xs font-semibold transition-colors ${
          isDark
            ? 'border-red-300/40 bg-red-400/10 text-red-50 hover:bg-red-400/20'
            : 'border-red-300 bg-white text-red-700 hover:bg-red-100'
        }`}
      >
        Rebalance
      </button>
    </div>
  );
}

/**
 * 2026-05-22 (single-card refactor) — Renders the binding-aware metadata
 * row INSIDE a DeviceSurfaceCard's agent list. Combines what previously
 * was split between the BindingsView (Contested / Pinned / Chief of Staff
 * chips + "Last dispatch" / "Idle" text) and the device card (status +
 * version). The runtime-manager passes:
 *   - `binding`: the AgentBindingDTO for THIS agent (matched by
 *     agentImUserId). When null, only static presence info from
 *     runtimeAgent is shown.
 *   - `orchestratorAgentImUserId` / `usernameByImUserId` /
 *     `orchestratorToggleBusy` / `onToggleChiefOfStaff` — sourced from
 *     `useOrchestratorAppointment(workspaceId)` hoisted to RuntimeManager.
 */
export function BindingChipsRow({
  isDark,
  binding,
  orchestratorAgentImUserId,
  usernameByImUserId,
  orchestratorToggleBusy,
  onToggleChiefOfStaff,
}: {
  isDark: boolean;
  binding: AgentBindingDTO | null;
  orchestratorAgentImUserId: string | null;
  usernameByImUserId: Map<string, string>;
  orchestratorToggleBusy: string | null;
  onToggleChiefOfStaff: (agentImUserId: string, currentlyOn: boolean) => void | Promise<void>;
}) {
  if (!binding) return null;
  const agentImUserId = binding.agentImUserId;
  const username = usernameByImUserId.get(agentImUserId) ?? null;
  const isCurrentOrchestrator =
    orchestratorAgentImUserId !== null && orchestratorAgentImUserId === agentImUserId;
  const orchestratorEligible =
    isCurrentOrchestrator || (username !== null && username.toLowerCase() === 'ceo');
  const contestedNow = isCurrentlyContested(binding);
  return (
    <span
      data-testid={`binding-chips-row-${agentImUserId}`}
      data-contested={contestedNow ? 'true' : 'false'}
      className="mt-1 flex flex-wrap items-center gap-1.5 gap-y-1"
      onClick={(e) => e.stopPropagation()}
    >
      {contestedNow ? (
        <span
          data-testid={`binding-chips-contested-${agentImUserId}`}
          className={`rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${
            isDark
              ? 'border-red-400/40 bg-red-500/15 text-red-100'
              : 'border-red-300 bg-red-50 text-red-700'
          }`}
          title="Contested by another active device"
        >
          Contested
        </span>
      ) : null}
      {/* PINNED chip removed from inline view — surfaced in detail modal only.
          Most users don't need to see the binding's provenance on the card. */}
      {orchestratorEligible ? (
        <button
          type="button"
          disabled={orchestratorToggleBusy === agentImUserId}
          onClick={(event) => {
            event.stopPropagation();
            void onToggleChiefOfStaff(agentImUserId, isCurrentOrchestrator);
          }}
          data-testid={`binding-chips-chief-of-staff-${agentImUserId}`}
          data-state={isCurrentOrchestrator ? 'on' : 'off'}
          aria-pressed={isCurrentOrchestrator}
          title={
            isCurrentOrchestrator
              ? 'Chief of Staff bypass: auto-dispatch routine tasks without per-task approval. Click to revoke.'
              : 'Chief of Staff bypass: auto-dispatch routine tasks without per-task approval. Click to enable.'
          }
          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold transition-colors disabled:opacity-50 ${
            isCurrentOrchestrator
              ? isDark
                ? 'border-sky-400/40 bg-sky-500/15 text-sky-100 hover:bg-sky-500/25'
                : 'border-sky-400 bg-sky-50 text-sky-700 hover:bg-sky-100'
              : isDark
                ? 'border-zinc-600/60 text-zinc-400 hover:border-sky-400/40 hover:text-sky-200'
                : 'border-zinc-300 text-zinc-500 hover:border-sky-400 hover:text-sky-700'
          }`}
        >
          {isCurrentOrchestrator ? <Check className="h-2.5 w-2.5" /> : null}
          <span>Chief of Staff</span>
        </button>
      ) : null}
      {/* "Idle / Last dispatch" text + Rebalance button removed from inline
          view. Last-dispatch belongs in the detail modal where there's space.
          Rebalance is still surfaced via the global "N contested" banner +
          per-agent detail modal. Keeping the card row scannable. */}
    </span>
  );
}

function EmptyState({ isDark, title, hint }: { isDark: boolean; title: string; hint: ReactNode }) {
  return (
    <div
      data-testid="devices-panel-empty"
      className={`flex flex-col items-center gap-2 border p-8 text-center ${radius.pane} ${
        surface.pane[isDark ? 'dark' : 'light']
      }`}
    >
      <p className={`text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>{title}</p>
      <p className={`max-w-md text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>{hint}</p>
    </div>
  );
}

/**
 * Bindings → daemon groups. We trust `boundDaemonId` as the partition key
 * (the cloud guarantees the binding row IS the authoritative routing
 * source — see Wave 2-B2 evidence). `runtime.devices` is best-effort
 * enrichment for the heartbeat ts; missing entries are treated as
 * "forgotten daemon" and rendered offline.
 *
 * 2026-05-22 — Still exported because the Rebalance modal builds its
 * "Move this binding from daemon A to daemon B" picker by grouping the
 * full binding feed (including forgotten daemons), even though the panel
 * itself no longer renders these groups directly.
 */
export interface DaemonGroup {
  daemonId: string;
  daemonKind: DaemonKind;
  daemonLabel: string;
  device: RuntimeDeviceDTO | null;
  bindings: AgentBindingDTO[];
  contestedCount: number;
}

export function groupBindingsByDaemon(
  bindings: AgentBindingDTO[],
  runtime: WorkspaceRuntimeDTO | null,
): DaemonGroup[] {
  const devicesById = new Map<string, RuntimeDeviceDTO>();
  for (const device of runtime?.devices ?? []) {
    devicesById.set(device.deviceId, device);
  }
  const groups = new Map<string, DaemonGroup>();
  for (const binding of bindings) {
    const existing = groups.get(binding.boundDaemonId);
    if (existing) {
      existing.bindings.push(binding);
      if (isCurrentlyContested(binding)) existing.contestedCount += 1;
      continue;
    }
    const device = devicesById.get(binding.boundDaemonId) ?? null;
    groups.set(binding.boundDaemonId, {
      daemonId: binding.boundDaemonId,
      daemonKind: binding.boundDaemonKind,
      daemonLabel: binding.boundDaemonLabel || device?.name || binding.boundDaemonId,
      device,
      bindings: [binding],
      contestedCount: isCurrentlyContested(binding) ? 1 : 0,
    });
  }
  return [...groups.values()].sort((a, b) => {
    if (a.contestedCount !== b.contestedCount) return b.contestedCount - a.contestedCount;
    return a.daemonLabel.localeCompare(b.daemonLabel);
  });
}

export function formatRelative(iso: string | null, now: number): string {
  if (!iso) return 'never';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return 'never';
  const diff = Math.max(0, now - ts);
  if (diff < 30_000) return 'just now';
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}
