/**
 * Wave 3 C2 — agent-bindings + daemon-health frontend API wrapper.
 *
 * Consumes the Wave 2-B2 endpoints that solve the R7 multi-daemon binding race
 * documented in `docs/release200/14-messaging-state-machine-reliability.md`
 * §4.8.2 + §1.5 jasonzhou case.
 *
 * Three endpoints (all in-process under `/api/im`):
 *   - GET  /workspaces/:wsId/agent-bindings  — list bindings + contested flag
 *   - POST /agent-bindings/:agentImUserId/rebind — user-explicit owner switch
 *   - GET  /daemons/:daemonId/health  — heartbeat + dispatch + queue probe
 *
 * SSE events arrive via /api/im/sync/stream:
 *   - agent.binding.contested
 *   - agent.binding.rebound
 *   - agent.binding.contestCleared
 *
 * Wire shape mirrors evidence/14-p10-server-wave2-b2.md §5.
 */

import { imFetch, type FetchResult } from './im-api';

/** boundBy provenance — server distinguishes 3 paths */
export type AgentBindingBoundBy = 'auto-first-declare' | 'user-explicit' | 'cloud-rebalance';
/** daemon device kind — UI uses this for icon + colour */
export type DaemonKind = 'local' | 'k8s' | 'edge';

/**
 * GET /workspaces/:wsId/agent-bindings row.
 *
 * `contested` is the derived boolean (contestedSince != null) the cloud
 * surfaces to spare the UI from re-implementing the rule.
 */
export interface AgentBindingDTO {
  agentImUserId: string;
  agentName: string;
  boundDaemonId: string;
  boundDaemonKind: DaemonKind;
  boundDaemonLabel: string;
  boundAt: string;
  boundBy: AgentBindingBoundBy;
  lastHostDeclareAt: string;
  lastDispatchAt: string | null;
  contested: boolean;
  contestedSince: string | null;
  contestCount: number;
}

export interface AgentBindingsResponse {
  bindings: AgentBindingDTO[];
}

/**
 * Window during which a `contestedSince` timestamp counts as a *current* (not
 * historical) conflict. Mirrors the server-side `CONTEST_FRESH_WINDOW_MS` in
 * `src/im/services/agent-binding.service.ts`. Duplicated here so client
 * components don't reach into server-only modules.
 *
 * 2026-05-22 — see CHANGELOG entry "fix(workspace): contest count not
 * decaying causes permanent CONTESTED chip".
 */
export const CONTEST_FRESH_WINDOW_MS = 5 * 60 * 1000;

/**
 * Pure derivation matching the server: a binding is *currently* contested if
 * `contestedSince` is set AND within `CONTEST_FRESH_WINDOW_MS` of `nowMs`.
 *
 * Note: the server already pre-computes `binding.contested` with the same
 * rule, but the client recomputes against its own `now` tick so the chip
 * decays naturally between SSE refreshes (instead of remaining red until the
 * next /agent-bindings poll). `contestCount` is intentionally NOT consulted
 * — it's a monotonic historical counter and does not represent active state.
 */
export function isCurrentlyContested(
  binding: Pick<AgentBindingDTO, 'contestedSince'>,
  nowMs: number = Date.now(),
): boolean {
  if (!binding.contestedSince) return false;
  const ts = Date.parse(binding.contestedSince);
  if (!Number.isFinite(ts)) return false;
  return nowMs - ts < CONTEST_FRESH_WINDOW_MS;
}

export interface RebindRequest {
  targetDaemonId: string;
  reason?: string;
  /** Optional — server auto-resolves from im_containers when omitted. */
  targetDaemonKind?: DaemonKind;
  targetDaemonLabel?: string;
}

export interface RebindResponse {
  binding: {
    agentImUserId: string;
    boundDaemonId: string;
    boundDaemonKind: DaemonKind;
    boundDaemonLabel: string;
    boundBy: AgentBindingBoundBy;
    boundAt: string;
  };
  /**
   * Count of tasks (pending / running / dispatching) still on the previous
   * owner. They complete on the old owner; new tasks route to the new
   * daemon immediately.
   */
  inFlightTaskCount: number;
  previousDaemonId: string;
}

export interface DaemonHealthAgentSummary {
  agentImUserId: string;
  name: string;
  lastDispatchAt: string | null;
  contested: boolean;
}

export interface DaemonHealthDTO {
  daemonId: string;
  workspaceId: string;
  deviceType: DaemonKind | string;
  runtimeKind: string;
  containerStatus: string;
  startedAt: string | null;
  stoppedAt: string | null;
  lastHeartbeatAt: string | null;
  /** Server-side flag: lastHeartbeatAt within 90s. */
  heartbeatFresh: boolean;
  /** Shadow client present in cloud RoomManager. */
  wsConnected: boolean;
  lastSuccessfulDispatch: string | null;
  /** pending + running + dispatching tasks for agents bound to this daemon. */
  taskQueueSize: number;
  agents: DaemonHealthAgentSummary[];
}

/**
 * Fetch all agent bindings for a workspace.
 *
 * Empty `bindings` array is normal — workspace with no daemons attached yet
 * (e.g. Web base subscription before first daemon pair) returns 200 + [].
 */
export async function listAgentBindings(workspaceId: string): Promise<FetchResult<AgentBindingsResponse>> {
  return imFetch<AgentBindingsResponse>(`/workspaces/${encodeURIComponent(workspaceId)}/agent-bindings`);
}

/**
 * Explicit user-driven rebind. POST /agent-bindings/:agentImUserId/rebind.
 *
 * Cloud writes IMAuditLog (boundBy='user-explicit') and emits
 * `agent.binding.rebound` so all the user's clients refresh the panel.
 */
export async function rebindAgent(
  agentImUserId: string,
  payload: RebindRequest,
): Promise<FetchResult<RebindResponse>> {
  return imFetch<RebindResponse>(`/agent-bindings/${encodeURIComponent(agentImUserId)}/rebind`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/**
 * Daemon liveness + dispatch history.
 *
 * The Health dashboard polls this on a 10s cadence per visible daemon —
 * `heartbeatFresh` is the canonical "is this daemon actually alive" signal
 * (Redis presence key, not just the DB row).
 */
export async function getDaemonHealth(daemonId: string): Promise<FetchResult<DaemonHealthDTO>> {
  return imFetch<DaemonHealthDTO>(`/daemons/${encodeURIComponent(daemonId)}/health`);
}

/**
 * Sync event payload shapes — mirrors the contract documented in
 * evidence/14-p10-server-wave2-b2.md §5 ("New SyncEvent types").
 *
 * The UI subscribes to /api/im/sync/stream (already wired in page.tsx) and
 * forwards these events to the Devices panel state.
 */
export interface BindingContestedEvent {
  agentImUserId: string;
  currentOwner: { daemonId: string; kind: DaemonKind | string; label: string };
  contender: { daemonId: string; kind: DaemonKind | string; label: string };
  contestCount: number;
  since: string;
}

export interface BindingReboundEvent {
  agentImUserId: string;
  previousDaemonId: string;
  newDaemonId: string;
  reason: string | null;
  actorImUserId: string;
  inFlightTaskCount: number;
}

export interface BindingContestClearedEvent {
  agentImUserId: string;
  reason: string;
  clearedAt: string;
}
