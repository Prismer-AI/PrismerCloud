/**
 * ⚠️ REGRESSION GUARD — DO NOT DELETE WITHOUT READING docs/release201/21
 *
 * This module was originally shipped in commit `7f0a24e9` (Wave 4) and
 * deleted by commit `e1a3a402` (2026-05-25 snapshot) without an audit —
 * the deleter's own commit message admits "not investigated". The
 * deletion broke the chat panel's "agent is doing X" visibility for 3
 * days (2026-05-25 → 2026-05-28) and surfaced as 3 critical user
 * complaints:
 *   - "agent reaction is painfully slow"
 *   - "I can't tell whether the agent received my message"
 *   - "agent claims to have generated a PDF but no file appears"
 *
 * Before touching this file, read `docs/release201/21-dispatch-activity-
 * stream-revival.md` §1.1 and confirm with a maintainer.
 *
 * ─────────────────────────────────────────────────────────────────
 *
 * Cross-component pub/sub for `task.step.appended` SSE events.
 *
 * im-channel.tsx already owns a single `EventSource('/api/im/sync/stream')`
 * connection that fans incoming `IMSyncEvent` rows out to its reconcile loop.
 * InlineActivityStrip needs the same `task.step.appended` events but lives
 * in a sibling subtree without prop drilling. Re-opening a second
 * EventSource per mounted card would be wasteful (chat panels show many
 * concurrent tasks); instead, im-channel emits into this bus whenever it
 * sees a `task.step.appended` envelope, and each InlineActivityStrip mount
 * subscribes by `taskRunId` (+ `conversationId` scope).
 *
 * Why a module singleton (not a React context)?
 *   - The publisher (im-channel's SSE handler) and subscribers (one per
 *     InlineActivityStrip) sit in different parts of the tree; threading a
 *     context through the whole workspace shell to reach both would force
 *     unnecessary re-renders. The bus is a thin EventEmitter — subscribe
 *     returns an unsubscribe function the React effect uses for cleanup.
 *   - SSR-safe (no global side effects until first emit/subscribe).
 *
 * Contract:
 *   - `emitTaskStep({ taskRunId, taskId, step, conversationId })` from
 *     im-channel's sync handler when it observes `event.type ===
 *     'task.step.appended'`.
 *   - `subscribeTaskStep(taskRunId, conversationId, cb)` in
 *     InlineActivityStrip — cb is invoked for events that match the
 *     (taskRunId, conversationId) pair. A `null` conversationId on the
 *     subscriber side means "match any conversation" (back-compat). An
 *     emitted event with `null` conversationId matches any subscriber.
 *     Returns `() => unsubscribe`.
 *   - `subscribeAllTaskSteps(cb)` debug / future use; matches any taskRunId.
 *
 * Scoping rationale (2026-05-22, preserved):
 *   The bus keys by both taskRunId AND conversationId. Without conversation
 *   scoping, switching IM conversations could leave a still-mounted Strip
 *   from the prior conversation absorbing events meant for the new
 *   conversation, or sticky stale activity would never get flushed.
 */

import type { ActivityTimelineStep } from './sync-api';

export interface TaskStepBusEvent {
  taskRunId: string;
  taskId: string;
  step: ActivityTimelineStep;
  /** Optional — preserved from the envelope for filtering when set. */
  conversationId?: string | null;
}

type Listener = (event: TaskStepBusEvent) => void;

interface ListenerEntry {
  conversationId: string | null;
  cb: Listener;
}

const listeners = new Map<string /* taskRunId */, Set<ListenerEntry>>();
const globalListeners = new Set<Listener>();

export function emitTaskStep(event: TaskStepBusEvent): void {
  if (!event.taskRunId) return;
  const set = listeners.get(event.taskRunId);
  if (set) {
    const eventConv = event.conversationId ?? null;
    for (const entry of set) {
      // Match rule (event-driven): an event with no conversationId matches
      // any subscriber; an event with a conversationId matches only
      // subscribers that either share that conversationId or scoped null
      // ("any conversation"). This keeps prior-conversation activity from
      // bleeding into the active one after a switch.
      if (eventConv !== null && entry.conversationId !== null && entry.conversationId !== eventConv) continue;
      try {
        entry.cb(event);
      } catch {
        /* listener threw — never let one bad subscriber break others */
      }
    }
  }
  for (const cb of globalListeners) {
    try {
      cb(event);
    } catch {
      /* ignore */
    }
  }
}

/**
 * @param taskRunId — the run to subscribe to.
 * @param conversationId — when non-null, only events tagged with the same
 *   conversationId (or no conversationId at all) reach this listener.
 *   Pass `null` for "any conversation" (back-compat / tests).
 * @param cb — the listener.
 */
export function subscribeTaskStep(taskRunId: string, conversationId: string | null, cb: Listener): () => void {
  let set = listeners.get(taskRunId);
  if (!set) {
    set = new Set();
    listeners.set(taskRunId, set);
  }
  const entry: ListenerEntry = { conversationId, cb };
  set.add(entry);
  return () => {
    const cur = listeners.get(taskRunId);
    if (!cur) return;
    cur.delete(entry);
    if (cur.size === 0) listeners.delete(taskRunId);
  };
}

export function subscribeAllTaskSteps(cb: Listener): () => void {
  globalListeners.add(cb);
  return () => {
    globalListeners.delete(cb);
  };
}

/** Test-only — clear all listeners between specs to avoid bleed-over. */
export function __resetTaskStepBus(): void {
  listeners.clear();
  globalListeners.clear();
}
