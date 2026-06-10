/**
 * `message-delivery-state` — pure derivation that maps a user's chat
 * message + the task universe + agent-phase signals into a single
 * lifecycle row the chat bubble can render inline ("Working 5s",
 * "Failed: daemon_local_retry_exhausted", etc.).
 *
 * P1 (CLAUDE.md §Debug Pipeline, 2026-05-24) — replaces the static
 * "Sent" tail label that gave the user zero visibility when their
 * @-mention silently stalled. The derivation is intentionally exported
 * separately from the React chip so it can be unit-tested in isolation
 * and so future surfaces (timeline drawer, retry queue) can reuse the
 * same rules without re-implementing them.
 *
 * No React. No fetch. No globals. The caller assembles the inputs and
 * receives a flat `MessageDeliveryState | null` per message id.
 *
 * Linking rule:
 *   message ↔ task is established via `task.metadata.triggerMessageId`
 *   (stamped by `messageService.dispatchPendingMention` and the agent
 *   dispatcher pipeline — see src/im/services/message.service.ts §1147
 *   and §1055). Messages with no linked task collapse to `null` (the
 *   chip then falls back to the legacy "Sent" label).
 */

import type { AgentPhaseRow } from './agent-phase-store';
import type { TaskDTO, WorkspaceTaskMetadata } from './types';

export type DeliveryStateKind =
  | 'sent'
  | 'ack'
  | 'working'
  | 'awaiting'
  | 'stuck'
  | 'done'
  | 'failed'
  | 'timeout';

export interface MessageDeliveryState {
  kind: DeliveryStateKind;
  linkedTaskIds: string[];
  linkedRunIds: string[];
  /** Latest agent phase (working sub-state) when kind=working. */
  workingPhase?: string | null;
  /** Earliest task createdAt minus message.createdAt — for "Ack Xs ago" display. */
  ackLatencyMs?: number | null;
  /** Sum of elapsed time for the linked tasks (now − message.createdAt). */
  elapsedMs?: number | null;
  /** Last error code when kind=failed/timeout. */
  errorCode?: string | null;
  errorMessage?: string | null;
}

/**
 * Minimal shape of the chat message the derivation needs. We keep this
 * structural so the importer doesn't have to depend on the heavyweight
 * `MessageDTO` definition declared inside im-channel.tsx (which is not
 * exported).
 */
export interface MessageLike {
  id: string;
  createdAt: string;
}

export interface DeriveMessageDeliveryStateInput {
  message: MessageLike;
  /** All tasks the caller can see — derivation filters by triggerMessageId. */
  tasks: TaskDTO[];
  /** Phase map keyed by taskId; pass `undefined` if no phase data available. */
  taskPhases?: Map<string, AgentPhaseRow>;
  /** Now (ms epoch) — injected for testability. */
  now: number;
}

const STUCK_HEARTBEAT_MS = 45_000;
const TIMEOUT_ERROR_CODES = new Set(['daemon_task_timeout', 'daemon_local_retry_exhausted']);
const ACTIVE_STATUSES = new Set(['running', 'in_progress', 'review', 'assigned', 'dispatched']);
const PENDING_STATUSES = new Set(['pending']);

/**
 * Parse `triggerMessageId` out of a task's already-parsed metadata
 * (TaskDTO.metadata is `Record<string, unknown>` straight from the IM
 * router — no JSON.parse needed here).
 */
export function readTriggerMessageId(metadata: TaskDTO['metadata'] | undefined): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const meta = metadata as WorkspaceTaskMetadata;
  const value = meta.triggerMessageId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function extractErrorCode(task: TaskDTO): string | null {
  // Tasks surface failure context in either the top-level `error` column
  // (string, sometimes JSON-encoded) or under metadata.errorCode (Wave-7
  // adapter convention). Prefer the structured field when available.
  if (task.metadata && typeof task.metadata === 'object') {
    const meta = task.metadata as Record<string, unknown>;
    const errorCode = meta.errorCode ?? meta.error_code;
    if (typeof errorCode === 'string' && errorCode.length > 0) return errorCode;
  }
  if (task.terminalReason && typeof task.terminalReason === 'string') return task.terminalReason;
  return null;
}

function extractErrorMessage(task: TaskDTO): string | null {
  if (typeof task.error === 'string' && task.error.length > 0) return task.error;
  if (task.statusMessage && task.statusMessage.length > 0) return task.statusMessage;
  return null;
}

/**
 * Derive a single `MessageDeliveryState` for the given message.
 *
 * Returns `null` when no task is linked to the message — the caller is
 * expected to render the legacy "Sent" / "Sending" label in that case.
 */
export function deriveMessageDeliveryState(
  input: DeriveMessageDeliveryStateInput,
): MessageDeliveryState | null {
  const { message, tasks, taskPhases, now } = input;

  // ─── 1. Link tasks via metadata.triggerMessageId ──────────────────
  const linked = tasks.filter((t) => readTriggerMessageId(t.metadata) === message.id);
  if (linked.length === 0) return null;

  const linkedTaskIds = linked.map((t) => t.id);
  // The chat-mention pipeline (message.service.ts §1131) creates a
  // TaskRun rather than a Task — but the surfaced TaskDTO list already
  // collapses both. We capture run ids when surfaced via metadata for
  // forward-compat with the P2 retry endpoint.
  const linkedRunIds: string[] = [];
  for (const t of linked) {
    if (t.metadata && typeof t.metadata === 'object') {
      const runId = (t.metadata as Record<string, unknown>).runId;
      if (typeof runId === 'string' && runId.length > 0) linkedRunIds.push(runId);
    }
  }

  const messageCreatedMs = Date.parse(message.createdAt);
  const safeMessageMs = Number.isFinite(messageCreatedMs) ? messageCreatedMs : now;
  const elapsedMs = Math.max(0, now - safeMessageMs);

  // Earliest task.createdAt for ack latency. Fall back to message ts.
  let ackLatencyMs: number | null = null;
  for (const t of linked) {
    const ts = Date.parse(t.createdAt);
    if (!Number.isFinite(ts)) continue;
    const latency = Math.max(0, ts - safeMessageMs);
    if (ackLatencyMs == null || latency < ackLatencyMs) ackLatencyMs = latency;
  }

  const base = {
    linkedTaskIds,
    linkedRunIds,
    ackLatencyMs,
    elapsedMs,
  } satisfies Pick<MessageDeliveryState, 'linkedTaskIds' | 'linkedRunIds' | 'ackLatencyMs' | 'elapsedMs'>;

  // ─── 2. Stuck — any task in 'stuck' phase OR heartbeat > 45s ──────
  for (const t of linked) {
    const phase = taskPhases?.get(t.id);
    if (!phase) continue;
    if (phase.phase === 'stuck') {
      return {
        ...base,
        kind: 'stuck',
        workingPhase: phase.phase,
      };
    }
    if (phase.lastHeartbeatAt) {
      const hb = Date.parse(phase.lastHeartbeatAt);
      // Only treat as stuck while the task is still in an active state —
      // a terminal task with a stale heartbeat is not "stuck", it's done.
      if (
        Number.isFinite(hb) &&
        now - hb > STUCK_HEARTBEAT_MS &&
        ACTIVE_STATUSES.has(t.status)
      ) {
        return {
          ...base,
          kind: 'stuck',
          workingPhase: phase.phase ?? null,
        };
      }
    }
  }

  // ─── 3. Awaiting approval ─────────────────────────────────────────
  if (linked.some((t) => t.status === 'awaiting_approval')) {
    return { ...base, kind: 'awaiting' };
  }

  // ─── 4. Failed / Timeout ──────────────────────────────────────────
  //
  // Spec: kind=`timeout` when the errorCode signals a daemon timeout /
  // local-retry exhaustion. Otherwise generic `failed`. Approval-loop
  // failures (status === 'awaiting_approval') are handled above.
  const failedTask = linked.find((t) => t.status === 'failed');
  if (failedTask) {
    const errorCode = extractErrorCode(failedTask);
    const errorMessage = extractErrorMessage(failedTask);
    const kind: DeliveryStateKind =
      errorCode && TIMEOUT_ERROR_CODES.has(errorCode) ? 'timeout' : 'failed';
    return {
      ...base,
      kind,
      errorCode,
      errorMessage,
    };
  }

  // ─── 5. Working — any active task ─────────────────────────────────
  const workingTask = linked.find((t) => ACTIVE_STATUSES.has(t.status));
  if (workingTask) {
    // Pick the latest phase signal (newest updatedAt) across linked tasks.
    let bestPhase: AgentPhaseRow | undefined;
    for (const t of linked) {
      const ph = taskPhases?.get(t.id);
      if (!ph) continue;
      if (!bestPhase || ph.updatedAt > bestPhase.updatedAt) bestPhase = ph;
    }
    return {
      ...base,
      kind: 'working',
      workingPhase: bestPhase?.phase ?? null,
    };
  }

  // ─── 6. Done — every linked task is completed ─────────────────────
  if (linked.every((t) => t.status === 'completed')) {
    return { ...base, kind: 'done' };
  }

  // ─── 7. Ack — every remaining linked task is pending ──────────────
  if (linked.every((t) => PENDING_STATUSES.has(t.status))) {
    return { ...base, kind: 'ack' };
  }

  // Mixed terminal / unknown — fall back to ack so we never silently
  // collapse back to the legacy "Sent" label once a task has been
  // observed.
  return { ...base, kind: 'ack' };
}
