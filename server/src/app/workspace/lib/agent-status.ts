/**
 * `agent-status` — pure derivation: collapse {agent, tasks, runtime, phases}
 * into a single `AgentLiveStatus` per agent so avatars can render a status
 * ring + hover popover without re-implementing the rules at every callsite.
 *
 * No React. No fetch. No globals. The page is responsible for assembling
 * the inputs (it already owns `agents` / `tasks` / `runtime`); each
 * component receives a pre-derived `AgentLiveStatus | null` via prop.
 *
 * Status rules — single source of truth so the kanban/contacts/chat/runtime
 * surfaces all agree on what "working" vs "stuck" means:
 *
 *   offline  → runtime row missing OR no heartbeat seen in OFFLINE_WINDOW_MS
 *   stuck    → any active task in 'stuck' phase OR phase heartbeat
 *              older than STUCK_WINDOW_MS
 *   waiting  → any active task in 'waiting_user' or 'waiting_dep' phase
 *   working  → any active task in {assigned, running, review} OR runtime
 *              status === 'busy'
 *   idle     → everything else (registered, heartbeating, no in-flight task)
 */

import type { AgentPhaseRow } from './agent-phase-store';
import type { AgentDTO, RuntimeAgentDTO, TaskDTO } from './types';

export type AgentStatusKind = 'idle' | 'working' | 'waiting' | 'stuck' | 'offline';

export interface AgentLiveStatus {
  kind: AgentStatusKind;
  currentTask: {
    taskId: string;
    title: string;
    startedAt: string;
    phase?: string | null;
    lastStepLabel?: string | null;
  } | null;
  parallelTasks: Array<{ taskId: string; title: string; status: string }>;
  recentCompletedTasks: Array<{ taskId: string; title: string; status: string; updatedAt: string }>;
  recentSteps: Array<{ at: string; label: string }>;
  lastHeartbeatAt: string | null;
  daemonLabel: string | null;
  /**
   * ms epoch — latest signal that this agent did something (any task
   * updatedAt, any phase event, any recently-completed run). Drives a
   * "just finished, now idle" softer popover label so the avatar doesn't
   * snap from "working" to "no active work" the millisecond the reply
   * lands. Null when we have no evidence of activity at all.
   */
  lastActivityAt: number | null;
}

const OFFLINE_WINDOW_MS = 90_000;
const STUCK_HEARTBEAT_MS = 45_000;

const WAITING_PHASES = new Set(['waiting_user', 'waiting_dep']);
const ACTIVE_STATUSES = new Set(['assigned', 'running', 'in_progress', 'review', 'dispatched']);
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export interface DeriveAgentStatusInput {
  agent: AgentDTO;
  runtimeAgent?: RuntimeAgentDTO | null;
  /** All tasks where assigneeId === agent.userId (caller pre-filters). */
  tasksOwned: TaskDTO[];
  /** Phase map keyed by taskId; pass `undefined` if no phase data available. */
  taskPhases?: Map<string, AgentPhaseRow>;
  /** Human-readable label for the daemon hosting this agent (e.g. device name). */
  daemonLabel?: string | null;
  /**
   * v2.0.8 P0-3 (doc 21 §5.2) — number of in-flight dispatches for this
   * agent, derived from `dispatch.lifecycle` SSE events the page
   * accumulates. > 0 forces 'working' classification so the
   * AgentStateStrip ring lights up the instant the cloud pushes the
   * dispatch frame to the daemon — without waiting for the first
   * phase_change step (which on cold pods can take ~1s) or a kanban
   * IMTask row (which chat-mention dispatches never create). Defaults
   * to 0 so the field is fully backwards-compatible.
   */
  dispatchInFlight?: number;
  /** Now (ms) — injected for testability. */
  now: number;
}

export function deriveAgentStatus(input: DeriveAgentStatusInput): AgentLiveStatus {
  const { agent, runtimeAgent, tasksOwned, taskPhases, daemonLabel = null, dispatchInFlight = 0, now } = input;

  // Heartbeat resolution — prefer the runtime row (daemon-reported), fall
  // back to the legacy presence.lastSeen the agent registry exposes.
  const heartbeatIso = runtimeAgent?.lastHeartbeat ?? null;
  const heartbeatMs = heartbeatIso ? Date.parse(heartbeatIso) : null;
  const presenceMs = agent.presence?.lastSeen ?? null;
  const lastSignalMs = heartbeatMs ?? (typeof presenceMs === 'number' ? presenceMs : null);

  // Active tasks (drop terminal rows). Sorted newest-first so the
  // "current task" is the most recently updated one.
  const activeTasks = tasksOwned
    .filter((t) => !TERMINAL_STATUSES.has(t.status))
    .sort((a, b) => Date.parse(b.updatedAt || b.createdAt) - Date.parse(a.updatedAt || a.createdAt));

  // Find the most-recently-updated active task that has a fresh phase row
  // (preferred as "current"). Otherwise the newest active task wins.
  let currentRaw: TaskDTO | null = null;
  let bestPhaseTs = -Infinity;
  for (const t of activeTasks) {
    const phase = taskPhases?.get(t.id);
    const ts = phase?.updatedAt ?? Date.parse(t.updatedAt || t.createdAt);
    if (Number.isFinite(ts) && ts > bestPhaseTs) {
      currentRaw = t;
      bestPhaseTs = ts;
    }
  }
  if (!currentRaw && activeTasks.length > 0) currentRaw = activeTasks[0];

  const currentPhase = currentRaw ? (taskPhases?.get(currentRaw.id) ?? null) : null;
  let currentTask = currentRaw
    ? {
        taskId: currentRaw.id,
        title: currentRaw.title || `T-${currentRaw.id.slice(-4).toUpperCase()}`,
        startedAt: currentRaw.updatedAt || currentRaw.createdAt,
        phase: currentPhase?.phase ?? null,
        lastStepLabel: currentPhase?.lastStepLabel ?? null,
      }
    : null;
  // 2026-05-24 — when daemon reports a currentTaskId for an ad-hoc chat
  // dispatch (no IMTask row → no entry in tasksOwned), synthesize a stub so
  // the popover at least shows "is processing" instead of "No active work".
  if (!currentTask && runtimeAgent?.currentTaskId) {
    const phaseRow = taskPhases?.get(runtimeAgent.currentTaskId) ?? null;
    currentTask = {
      taskId: runtimeAgent.currentTaskId,
      title: '处理中…',
      startedAt: heartbeatIso ?? new Date(now).toISOString(),
      phase: phaseRow?.phase ?? null,
      lastStepLabel: phaseRow?.lastStepLabel ?? null,
    };
  }

  const parallelTasks = activeTasks
    .filter((t) => !currentRaw || t.id !== currentRaw.id)
    .slice(0, 5)
    .map((t) => ({
      taskId: t.id,
      title: t.title || `T-${t.id.slice(-4).toUpperCase()}`,
      status: t.status,
    }));

  const recentCompletedTasks = tasksOwned
    .filter((t) => TERMINAL_STATUSES.has(t.status))
    .sort((a, b) => Date.parse(b.updatedAt || b.createdAt) - Date.parse(a.updatedAt || a.createdAt))
    .slice(0, 3)
    .map((t) => ({
      taskId: t.id,
      title: t.title || `T-${t.id.slice(-4).toUpperCase()}`,
      status: t.status,
      updatedAt: t.updatedAt || t.createdAt,
    }));

  // Recent steps — last 3 phase signals across all active tasks for this
  // agent, sorted newest-first. Phase events without a step label fall
  // back to "phase: <name>" so the popover always has something to show.
  const recentSteps: Array<{ at: string; label: string }> = [];
  if (taskPhases) {
    const rows: Array<{ updatedAt: number; label: string }> = [];
    for (const t of activeTasks) {
      const row = taskPhases.get(t.id);
      if (!row) continue;
      const label = row.lastStepLabel ?? (row.phase ? `phase: ${row.phase}` : null);
      if (!label) continue;
      rows.push({ updatedAt: row.updatedAt, label });
    }
    rows.sort((a, b) => b.updatedAt - a.updatedAt);
    for (const r of rows.slice(0, 3)) {
      recentSteps.push({ at: new Date(r.updatedAt).toISOString(), label: r.label });
    }
  }

  // Status classification — single pass.
  const kind: AgentStatusKind = classify({
    runtimePresent: !!runtimeAgent,
    runtimeStatus: runtimeAgent?.status ?? null,
    runtimeAgent: runtimeAgent ?? null,
    lastSignalMs,
    now,
    activeTasks,
    taskPhases,
    currentPhase,
    dispatchInFlight,
  });

  // lastActivityAt — newest of: any task updatedAt (incl terminal),
  // any phase event for owned tasks, heartbeat. Lets the popover render
  // "just finished" softness for ~60s after the agent goes idle.
  let lastActivityAt: number | null = null;
  for (const t of tasksOwned) {
    const ts = Date.parse(t.updatedAt || t.createdAt);
    if (Number.isFinite(ts) && (lastActivityAt == null || ts > lastActivityAt)) lastActivityAt = ts;
  }
  if (taskPhases) {
    for (const t of tasksOwned) {
      const row = taskPhases.get(t.id);
      if (row && (lastActivityAt == null || row.updatedAt > lastActivityAt)) lastActivityAt = row.updatedAt;
    }
  }
  if (heartbeatMs != null && (lastActivityAt == null || heartbeatMs > lastActivityAt)) {
    lastActivityAt = heartbeatMs;
  }

  return {
    kind,
    currentTask,
    parallelTasks,
    recentCompletedTasks,
    recentSteps,
    lastHeartbeatAt: heartbeatIso,
    daemonLabel,
    lastActivityAt,
  };
}

function classify(args: {
  runtimePresent: boolean;
  runtimeStatus: string | null;
  runtimeAgent: RuntimeAgentDTO | null;
  lastSignalMs: number | null;
  now: number;
  activeTasks: TaskDTO[];
  taskPhases?: Map<string, AgentPhaseRow>;
  currentPhase: AgentPhaseRow | null;
  dispatchInFlight: number;
}): AgentStatusKind {
  const { runtimePresent, runtimeStatus, lastSignalMs, now, activeTasks, taskPhases, currentPhase, dispatchInFlight } =
    args;

  // Offline — daemon never reported the agent OR heartbeat is stale.
  //
  // 2026-05-30 fix: the previous rule was
  //   `now - lastSignalMs > OFFLINE_WINDOW_MS && runtimeStatus !== 'busy'`
  // i.e. "even if heartbeat is stale, don't mark offline if daemon last
  // reported status=busy." Intent: keep the avatar lit while a dispatch is
  // in flight so we don't snap to gray for a few hundred ms during the gap
  // between a step finish and the next heartbeat. Actual failure mode:
  // when the daemon dies mid-dispatch (pod OOM kill, image-cache eviction,
  // kubelet evict, host process kill), the last DB write before death is
  // `IMAgentCard.status='busy' + lastHeartbeat=now-ε`. Heartbeats stop
  // immediately. 90s later `lastSignalMs` is stale, but `runtimeStatus`
  // sticks at 'busy' in DB forever — the exception above keeps the offline
  // branch from firing, the next clause (line ~267) returns 'working', so
  // the chat header shows "1 活跃 / N" and a green ring sits on the
  // avatar of an agent whose pod has been gone for hours. The device card
  // (which reads daemon heartbeat directly, not the agent classification
  // here) correctly shows Offline, so the two surfaces disagree.
  //
  // The daemon is the authority for "I'm busy"; once it goes silent past
  // OFFLINE_WINDOW_MS we cannot trust its last self-report. Drop the busy
  // exception. If you actually need to mask brief gaps mid-dispatch use
  // `dispatchInFlight` (the cloud-side in-flight counter — line ~266) —
  // that signal lives in cloud memory and dies with the daemon, so it
  // can't go stale.
  if (!runtimePresent && !lastSignalMs) return 'offline';
  if (lastSignalMs != null && now - lastSignalMs > OFFLINE_WINDOW_MS) {
    return 'offline';
  }

  // Stuck — any phase explicitly stuck OR any phase heartbeat that's old.
  if (taskPhases) {
    for (const t of activeTasks) {
      const row = taskPhases.get(t.id);
      if (!row) continue;
      if (row.phase === 'stuck') return 'stuck';
      const hbMs = row.lastHeartbeatAt ? Date.parse(row.lastHeartbeatAt) : null;
      if (hbMs && now - hbMs > STUCK_HEARTBEAT_MS) return 'stuck';
    }
  }

  // Waiting — current task or any task is pending user/dep input.
  if (currentPhase?.phase && WAITING_PHASES.has(currentPhase.phase)) return 'waiting';
  if (taskPhases) {
    for (const t of activeTasks) {
      const row = taskPhases.get(t.id);
      if (row?.phase && WAITING_PHASES.has(row.phase)) return 'waiting';
    }
  }

  // Working — any active task OR runtime says busy OR daemon reports a
  // currentTaskId OR cloud just pushed a dispatch frame to the daemon
  // (v2.0.8 dispatchInFlight signal, doc 21 §5.2). The currentTaskId
  // branch (2026-05-24) catches ad-hoc chat-mention dispatches that mint
  // an IMTaskRun but never enqueue a matching IMTask row into the kanban;
  // the dispatchInFlight branch closes the remaining gap by lighting the
  // strip the instant the WS frame lands — before the daemon emits its
  // first phase_change (cold pods can take ~1s).
  if (dispatchInFlight > 0) return 'working';
  if (runtimeStatus === 'busy') return 'working';
  if (args.runtimeAgent?.currentTaskId) return 'working';
  if (activeTasks.some((t) => ACTIVE_STATUSES.has(t.status))) return 'working';

  return 'idle';
}

/**
 * Build a `imUserId → AgentLiveStatus` map for the whole workspace.
 * Page-level helper — components consume a single entry by lookup.
 */
export function deriveWorkspaceAgentStatuses(input: {
  agents: AgentDTO[];
  tasks: TaskDTO[];
  runtime?: { devices: Array<{ name: string; agents: RuntimeAgentDTO[] }> } | null;
  taskPhases?: Map<string, AgentPhaseRow>;
  /**
   * v2.0.8 P0-3 (doc 21 §5.2) — number of in-flight chat dispatches per
   * agent imUserId, derived from the page's `dispatch.lifecycle` SSE
   * accumulator. Optional; absent map = nobody in-flight.
   */
  dispatchInFlightByAgent?: Map<string, number>;
  now: number;
}): Map<string, AgentLiveStatus> {
  const { agents, tasks, runtime, taskPhases, dispatchInFlightByAgent, now } = input;

  // Index runtime agents + daemon labels by imUserId.
  const runtimeByUser = new Map<string, { row: RuntimeAgentDTO; deviceName: string }>();
  if (runtime?.devices) {
    for (const dev of runtime.devices) {
      for (const a of dev.agents) {
        runtimeByUser.set(a.id, { row: a, deviceName: dev.name });
      }
    }
  }

  // Index tasks by assignee so we don't scan all tasks per agent.
  const tasksByAssignee = new Map<string, TaskDTO[]>();
  for (const task of tasks) {
    if (!task.assigneeId) continue;
    const arr = tasksByAssignee.get(task.assigneeId);
    if (arr) arr.push(task);
    else tasksByAssignee.set(task.assigneeId, [task]);
  }

  const out = new Map<string, AgentLiveStatus>();
  for (const agent of agents) {
    const runtimeEntry = runtimeByUser.get(agent.userId);
    out.set(
      agent.userId,
      deriveAgentStatus({
        agent,
        runtimeAgent: runtimeEntry?.row ?? null,
        tasksOwned: tasksByAssignee.get(agent.userId) ?? [],
        taskPhases,
        daemonLabel: runtimeEntry?.deviceName ?? null,
        dispatchInFlight: dispatchInFlightByAgent?.get(agent.userId) ?? 0,
        now,
      }),
    );
  }
  return out;
}
