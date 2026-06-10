/**
 * `agent-phase-store` — workspace-wide singleton that tracks the latest
 * `task.phase.*` SSE signal per taskId so EVERY surface (kanban, contacts,
 * left-rail, chat) can light up an agent avatar's status ring without having
 * to subscribe to its own EventSource.
 *
 * Why a singleton (not React state in page.tsx)?
 *   `ImChannel` already owns a per-conversation `taskPhases` map fed by a
 *   `/api/im/tasks/events` EventSource bound to that channel's lifecycle.
 *   Lifting it into page.tsx would force every conversation switch to lose
 *   the in-memory map (hydration races) AND would still leave non-chat
 *   surfaces (contacts panel, runtime-manager, task board) unaware of the
 *   data when no chat is open. Modelling the phase map as a process-global
 *   store with one shared SSE connection is the same pattern
 *   `agent-busy-state.ts` already uses for the simpler boolean indicator —
 *   we just record more fields per row.
 *
 * Scope: covers tasks the current user can see on `/api/im/tasks/events`
 * (creator OR assignee — same default filter as the existing surfaces).
 * That's sufficient for the avatar pulse / hover popover, both of which
 * are workspace-owner views.
 *
 * Subscribers receive a snapshot of the entire `taskId → PhaseRow` map.
 * Consumers are expected to derive their own per-agent slice via
 * `agent-status.ts::deriveAgentStatus`.
 */

import { useEffect, useState } from 'react';

import { getWorkspaceToken } from './im-api';
import { loadCursor, saveCursor } from './sse-cursor';

export interface AgentPhaseRow {
  taskId: string;
  phase: string | null;
  lastStepLabel: string | null;
  lastHeartbeatAt: string | null;
  /** Wall-clock time we last received an event for this task — drives "X ago" in popover. */
  updatedAt: number;
}

let phaseMap: Map<string, AgentPhaseRow> = new Map();
const listeners = new Set<(map: Map<string, AgentPhaseRow>) => void>();
let es: EventSource | null = null;
let activeSubs = 0;

/**
 * P2 (2026-05-25) — SSE cursor stream key. Uses 'tasks-events' to keep
 * separate from the workspace-wide 'sync' stream cursor.
 */
const CURSOR_STREAM = 'tasks-events';

/**
 * Best-effort stable per-user key for the localStorage cursor. The
 * platform JWT/auth blob (prismer_auth) carries `user.id` as a number;
 * we don't have direct access to it from the singleton, so we read it
 * lazily from localStorage. Falls back to '' (anonymous bucket) if
 * unavailable — cursor still functions, just shared across anonymous
 * sessions on the same browser (rare).
 */
function resolveCursorUserKey(): string {
  if (typeof window === 'undefined') return '';
  try {
    const raw = window.localStorage.getItem('prismer_auth');
    if (!raw) return '';
    const parsed = JSON.parse(raw) as { user?: { id?: number | string } };
    const id = parsed?.user?.id;
    return id == null ? '' : String(id);
  } catch {
    return '';
  }
}

function notify(): void {
  // Pass a new Map reference so `useSyncExternalStore`-style consumers
  // detect the change. Cheap — workspaces rarely hold more than a few
  // dozen in-flight tasks at once.
  const snapshot = new Map(phaseMap);
  for (const cb of listeners) {
    try {
      cb(snapshot);
    } catch {
      /* listener threw — keep others alive */
    }
  }
}

function applyEvent(eventName: string, raw: MessageEvent): void {
  // P2 control envelopes ride the same SSE — handle and bail before
  // attempting task-shape parsing.
  if (eventName === 'sync.backfill.done') {
    // Advance the cursor to the replayed high-water seq so the next
    // reconnect resumes here rather than falling back to since=0.
    const uid = resolveCursorUserKey();
    let doneSeq: number | undefined;
    try {
      doneSeq = (JSON.parse(raw.data) as { seq?: number }).seq;
    } catch {
      /* ignore */
    }
    if (uid && typeof doneSeq === 'number' && doneSeq > 0) saveCursor(CURSOR_STREAM, uid, doneSeq);
    return;
  }
  if (eventName === 'sync.backfill.truncated') {
    // Resume from the newest replayed seq — NOT resetCursor(→0), which
    // makes the next reconnect re-replay the full history and re-truncate
    // forever. newestSeq drains the backlog in BACKFILL_CAP chunks.
    console.warn('[agent-phase-store] SSE backfill truncated — resuming from newestSeq');
    const uid = resolveCursorUserKey();
    let newestSeq: number | undefined;
    try {
      newestSeq = (JSON.parse(raw.data) as { newestSeq?: number }).newestSeq;
    } catch {
      /* ignore */
    }
    if (uid && typeof newestSeq === 'number' && newestSeq > 0) saveCursor(CURSOR_STREAM, uid, newestSeq);
    return;
  }

  let payload: {
    taskId?: string;
    currentPhase?: string | null;
    lastHeartbeatAt?: string | null;
    lastStep?: { toolName?: string | null } | null;
    seq?: number;
  };
  try {
    payload = JSON.parse(raw.data);
  } catch {
    return;
  }
  // Persist last-seen seq so reconnects can pick up where we left off.
  if (typeof payload.seq === 'number' && payload.seq > 0) {
    const uid = resolveCursorUserKey();
    if (uid) saveCursor(CURSOR_STREAM, uid, payload.seq);
  }
  const taskId = payload.taskId;
  if (!taskId) return;

  if (eventName === 'task.completed' || eventName === 'task.failed' || eventName === 'task.cancelled') {
    if (phaseMap.has(taskId)) {
      const next = new Map(phaseMap);
      next.delete(taskId);
      phaseMap = next;
      notify();
    }
    return;
  }

  const stepLabel = payload.lastStep?.toolName ? `tool_use: ${payload.lastStep.toolName}` : null;
  const phase: string | null =
    eventName === 'task.phase.stuck' ? 'stuck' : payload.currentPhase ?? null;

  const prev = phaseMap.get(taskId);
  const next: AgentPhaseRow = {
    taskId,
    phase: phase ?? prev?.phase ?? null,
    lastStepLabel: stepLabel ?? prev?.lastStepLabel ?? null,
    lastHeartbeatAt: payload.lastHeartbeatAt ?? prev?.lastHeartbeatAt ?? null,
    updatedAt: Date.now(),
  };
  // Skip notify when nothing meaningfully changed — guards against the
  // SSE replaying identical heartbeats.
  if (
    prev &&
    prev.phase === next.phase &&
    prev.lastStepLabel === next.lastStepLabel &&
    prev.lastHeartbeatAt === next.lastHeartbeatAt
  ) {
    return;
  }
  const out = new Map(phaseMap);
  out.set(taskId, next);
  phaseMap = out;
  notify();
}

const HANDLED_EVENTS = [
  'task.phase.changed',
  'task.phase.stuck',
  'task.phase.recovered',
  'task.completed',
  'task.failed',
  'task.cancelled',
];

const CONTROL_EVENTS = ['sync.backfill.done', 'sync.backfill.truncated'];

function open(): void {
  if (es) return;
  if (typeof window === 'undefined') return;
  const token = getWorkspaceToken();
  if (!token) return;
  // P2 (2026-05-25): pass `since=<lastSeq>` so the cloud replays any
  // task.* events persisted to IMSyncEvent while we were disconnected.
  const userKey = resolveCursorUserKey();
  const since = userKey ? loadCursor(CURSOR_STREAM, userKey) : 0;
  const url = `/api/im/tasks/events?token=${encodeURIComponent(token)}&since=${since}`;
  es = new EventSource(url);
  for (const type of [...HANDLED_EVENTS, ...CONTROL_EVENTS]) {
    const fn = (raw: MessageEvent) => applyEvent(type, raw);
    es.addEventListener(type, fn as EventListener);
  }
}

function close(): void {
  if (!es) return;
  es.close();
  es = null;
}

/**
 * Subscribe to the workspace-wide phase map. Returns a stable snapshot
 * (re-rendered when membership or any row's heartbeat/phase changes).
 *
 * The first subscriber opens the shared EventSource; the last unsubscribe
 * closes it. Subsequent re-mounts re-use the existing connection so we
 * don't thrash the cloud's SSE fan-out.
 */
export function useAgentPhaseMap(): Map<string, AgentPhaseRow> {
  const [snapshot, setSnapshot] = useState<Map<string, AgentPhaseRow>>(phaseMap);

  useEffect(() => {
    activeSubs += 1;
    setSnapshot(phaseMap);
    const listener = (next: Map<string, AgentPhaseRow>) => setSnapshot(next);
    listeners.add(listener);
    if (activeSubs === 1) open();
    return () => {
      listeners.delete(listener);
      activeSubs = Math.max(0, activeSubs - 1);
      if (activeSubs === 0) close();
    };
  }, []);

  return snapshot;
}

/** Test-only — reset singleton between specs. */
export function __resetAgentPhaseStore(): void {
  phaseMap = new Map();
  listeners.clear();
  activeSubs = 0;
  close();
}
