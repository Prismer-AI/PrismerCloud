// release202/08 Phase 1 — feature flag + dispatch-kind derivation for the
// Hermes task-run path (`POST /v1/runs`).
//
// Background (doc 08 §2): release201/25 §16.4 A3 collapsed *all* dispatch onto
// the stateful Sessions API. Phase 1 reverses that ONLY for one-shot
// **task-runs** (kanban / scheduled fire / programmatic orchestration) — those
// are stateless work items, not conversational turns, and never need a
// server-side transcript. **Chat turns stay on Sessions.**
//
// SHIPPED FLAG-GATED, DEFAULT OFF. When the flag is OFF the derivation always
// resolves to `'turn'`, so `dispatch()` keeps routing 100% of traffic to
// `dispatchViaSessions` — byte-for-byte unchanged behaviour. The flag is only
// flipped ON after the owner's local Hermes live verification (doc 08 §2.3).

import type { TaskInput } from '../contract.js';
import type { ExecutionContextType } from '../../daemon/conversation-context.js';

/**
 * Env flag gating the `/v1/runs` task-run path. Read dynamically (per
 * dispatch) so a daemon restart isn't required to flip it, and so unit tests
 * can toggle it via `process.env` without re-importing the module. Accepts the
 * canonical truthy spellings used elsewhere in the runtime (`'true' | '1'`).
 */
export const HERMES_TASK_RUNS_DISPATCH_ENV = 'HERMES_TASK_RUNS_DISPATCH';

export function isHermesTaskRunsDispatchEnabled(): boolean {
  const raw = (process.env[HERMES_TASK_RUNS_DISPATCH_ENV] ?? '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}

export type HermesDispatchKind = 'run' | 'turn';

/**
 * Decide whether a dispatch is a one-shot **run** or a conversational **turn**.
 *
 * Signals (doc 08 task spec — combine, don't rely on conversationType alone):
 *
 *  1. **executionContextType** — `deriveExecutionContext` already classifies
 *     `group-session` / `dm-session` / `task-run`. A `task-run` type is a
 *     strong run signal.
 *  2. **triggering chat sender** — `task.currentMessageSender ??
 *     metaString(meta, 'triggerSenderUsername')`. A *present* sender means a
 *     human/agent said something in chat → this is a reply **turn**. An
 *     *absent* sender means the dispatch was fired by the scheduler / kanban /
 *     orchestration program with no chat trigger → **run**.
 *
 * A kanban task can carry a `group` conversationId yet have NO triggering
 * sender (pure scheduled fire) — so the sender signal is the tie-breaker: we
 * only return `'run'` when the execution context is `task-run` AND there is no
 * triggering sender. Any chat-rooted dispatch (group/dm with a sender, or even
 * a task-run that somehow carries a live sender) stays a `'turn'` → Sessions.
 *
 * When the flag is OFF this ALWAYS returns `'turn'` so the routing is inert.
 */
export function deriveDispatchKind(
  task: TaskInput,
  executionContextType: ExecutionContextType,
): HermesDispatchKind {
  if (!isHermesTaskRunsDispatchEnabled()) return 'turn';

  const meta = task.metadata ?? {};
  const triggerSender =
    (typeof task.currentMessageSender === 'string' && task.currentMessageSender.length > 0
      ? task.currentMessageSender
      : undefined) ??
    (typeof meta.triggerSenderUsername === 'string' && meta.triggerSenderUsername.length > 0
      ? (meta.triggerSenderUsername as string)
      : undefined);

  // Run iff classified as task-run AND no chat trigger sender.
  if (executionContextType === 'task-run' && !triggerSender) return 'run';
  return 'turn';
}
