/**
 * `useAgentBusyState` — surfaces which agents currently have an in-flight task
 * so avatars can pulse while the agent is thinking/executing.
 *
 * Why polling (not SSE-only)?
 *   The existing `/api/im/tasks/events` SSE stream carries `assigneeId` *only*
 *   on `task.assigned` (see `buildTaskSSEPayload` in `src/im/api/tasks.ts`).
 *   Other events (`task.progress`, `task.completed`, …) carry just `taskId`,
 *   so a pure SSE driver would need its own `taskId → assigneeId` map and
 *   stay correct across cold mount / reconnect. Polling
 *   `GET /api/im/tasks?status=running` + `?status=assigned` is far simpler and
 *   matches what the chat surface already does (10s cadence is acceptable for
 *   a pulse animation — the indicator is "soft signal", not a guard).
 *
 * Scope: returns busy state for the **current user's view** of tasks (creator
 * OR assignee — same default `/api/im/tasks` returns). That's sufficient for
 * the three callsites (chat sender avatar, devices runtime agent card,
 * member-list avatar) because the user always has visibility on those agents.
 *
 * Singleton store: avoids one fetch per mounted indicator. Mounts share the
 * same poller; the poller pauses when no subscribers are active.
 */

import { useEffect, useState } from 'react';

import { imFetch } from './im-api';

interface BusyTaskRow {
  assigneeId?: string | null;
  status?: string | null;
}

const BUSY_STATUSES = new Set(['assigned', 'running', 'dispatched']);

let busySet = new Set<string>();
const listeners = new Set<(set: Set<string>) => void>();
let pollHandle: ReturnType<typeof setInterval> | null = null;
let inflight: Promise<void> | null = null;
const POLL_INTERVAL_MS = 10_000;

function notify(): void {
  for (const cb of listeners) {
    try {
      cb(busySet);
    } catch {
      /* listener threw — keep others alive */
    }
  }
}

async function refreshOnce(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      // Two calls because the list endpoint accepts a single `status` value.
      // `dispatched` is a daemon-side phase that the cloud projects to
      // `running` in IMTask.status, so we only need {assigned, running}.
      //
      // 2026-05-22 — `limit=200` (server default is 20, max is 500 — see
      // `task.service.ts::listTasks`). Without the explicit limit, workspaces
      // running 50+ concurrent tasks would silently miss the older tasks in
      // the page and the indicator pulse for those agents would never light
      // up. 200 covers the realistic worst case for a single workspace's
      // in-flight set; if a workspace ever hits that ceiling we'd want a
      // dedicated `/tasks/busy-assignees?workspaceId=…` endpoint (deferred
      // to backlog — see code review §5).
      const [assignedRes, runningRes] = await Promise.all([
        imFetch<BusyTaskRow[]>('/tasks?status=assigned&limit=200'),
        imFetch<BusyTaskRow[]>('/tasks?status=running&limit=200'),
      ]);
      const rows: BusyTaskRow[] = [];
      if (assignedRes.ok && Array.isArray(assignedRes.data)) rows.push(...assignedRes.data);
      if (runningRes.ok && Array.isArray(runningRes.data)) rows.push(...runningRes.data);

      const next = new Set<string>();
      for (const row of rows) {
        if (!row.assigneeId) continue;
        const status = (row.status ?? '').toLowerCase();
        if (BUSY_STATUSES.has(status)) next.add(row.assigneeId);
      }
      // Only swap + notify when the membership changed — keeps React from
      // re-rendering all indicator wrappers on every tick when nothing moved.
      if (!setsEqual(busySet, next)) {
        busySet = next;
        notify();
      }
    } catch {
      /* network blip — keep prior state; next tick retries */
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function startPolling(): void {
  if (pollHandle != null) return;
  // Immediate first tick so newly-mounted indicators reflect current state
  // without waiting a full interval. Subsequent ticks are time-driven.
  void refreshOnce();
  pollHandle = setInterval(() => {
    void refreshOnce();
  }, POLL_INTERVAL_MS);
}

function stopPolling(): void {
  if (pollHandle != null) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
}

/**
 * Subscribe to busy-state updates for a single agent. Returns `true` while
 * the agent has at least one non-terminal task assigned to them.
 *
 * Pass `null`/`undefined` for `agentImUserId` to short-circuit (the hook
 * returns `false` without registering a subscription) — convenient for
 * callsites whose `imUserId` is conditionally available.
 */
export function useAgentBusyState(agentImUserId: string | null | undefined): boolean {
  const [busy, setBusy] = useState<boolean>(() => (agentImUserId ? busySet.has(agentImUserId) : false));

  useEffect(() => {
    if (!agentImUserId) {
      setBusy(false);
      return;
    }
    // Sync against current snapshot on (re)subscribe — avoids a stale `false`
    // when the singleton was already populated by a sibling mount.
    setBusy(busySet.has(agentImUserId));

    const listener = (set: Set<string>) => {
      setBusy(set.has(agentImUserId));
    };
    listeners.add(listener);
    if (listeners.size === 1) startPolling();

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) stopPolling();
    };
  }, [agentImUserId]);

  return busy;
}

/** Test-only — reset singleton between specs to avoid bleed-over. */
export function __resetAgentBusyState(): void {
  busySet = new Set();
  listeners.clear();
  stopPolling();
  inflight = null;
}
