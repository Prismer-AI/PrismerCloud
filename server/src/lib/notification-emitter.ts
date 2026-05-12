/**
 * Notification Emitter — fire-and-forget notification creation
 *
 * All functions are non-blocking. Errors are caught silently.
 * Only emits when FF_NOTIFICATIONS_LOCAL is enabled.
 *
 * Wave-8 W9: this module is the single seam between IM-side events
 * (`task.completed`, `contact.request`, `container.failing`, …) and the
 * cloud-side Bell drawer. Every workspace surface that wants to surface a
 * row in the drawer should call into one of these helpers — they own the
 * IM-user → cloud-user translation, the rate-limit / dedup logic, and the
 * payload encoding so the Bell doesn't have to know about the kind taxonomy.
 */

import { createNotification, type CreateNotificationInput } from './db-notifications';
import { queryOne } from './db';
import { FEATURE_FLAGS } from './feature-flags';
import type { RowDataPacket } from 'mysql2/promise';

/**
 * Emit a notification (fire-and-forget).
 */
export function emitNotification(input: CreateNotificationInput): void {
  if (!FEATURE_FLAGS.NOTIFICATIONS_LOCAL) return;

  createNotification(input).catch((err) => {
    console.error('[NotificationEmitter] Failed to create notification:', err);
  });
}

/**
 * Emit a low-credit alert if balance is below threshold.
 * Deduplicates: skips if one was sent within the last hour.
 */
export function emitLowCreditAlert(userId: number, balance: number): void {
  if (!FEATURE_FLAGS.NOTIFICATIONS_LOCAL) return;

  const threshold = parseFloat(process.env.LOW_CREDIT_THRESHOLD || '10');
  if (balance > threshold) return;

  // Check for recent duplicate
  queryOne<{ id: string } & RowDataPacket>(
    `SELECT id FROM pc_notifications
     WHERE user_id = ? AND reference_type = 'credits' AND type = 'warning'
       AND created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)
     LIMIT 1`,
    [userId],
  )
    .then((existing) => {
      if (existing) return; // Already sent recently

      createNotification({
        userId,
        type: 'warning',
        title: 'Low Credits Alert',
        message: `You have ${balance.toFixed(2)} credits remaining. Consider purchasing more.`,
        referenceType: 'credits',
      }).catch((err) => {
        console.error('[NotificationEmitter] Low credit alert failed:', err);
      });
    })
    .catch(() => {});
}

/**
 * Emit a payment status notification.
 */
export function emitPaymentNotification(
  userId: number,
  status: string,
  amountCents: number,
  creditsPurchased: number,
  paymentId: string,
): void {
  if (status === 'succeeded') {
    emitNotification({
      userId,
      type: 'success',
      title: 'Payment Successful',
      message: `Your purchase of ${creditsPurchased.toLocaleString()} credits ($${(amountCents / 100).toFixed(2)}) has been confirmed.`,
      referenceType: 'payment',
      referenceId: paymentId,
    });
  } else if (status === 'failed') {
    emitNotification({
      userId,
      type: 'error',
      title: 'Payment Failed',
      message: `Your payment of $${(amountCents / 100).toFixed(2)} could not be processed. Please check your payment method.`,
      referenceType: 'payment',
      referenceId: paymentId,
    });
  }
}

/**
 * Emit a task failure notification.
 */
export function emitTaskFailureNotification(
  userId: number,
  taskType: string,
  inputValue: string,
  errorMessage?: string,
): void {
  const truncated = inputValue.length > 80 ? inputValue.substring(0, 80) + '...' : inputValue;
  emitNotification({
    userId,
    type: 'error',
    title: 'Processing Failed',
    message: `Failed to process ${taskType}: ${truncated}. ${errorMessage || ''}`.trim(),
    referenceType: 'usage_record',
  });
}

// ============================================================================
// Wave-8 W9 — workspace Bell helpers (task / contact / runtime)
// ============================================================================

/**
 * Resolve `IMUser.id` (cuid string) → cloud `users.id` (numeric BigInt).
 * `pc_notifications.user_id` is the cloud id, while every IM call site has the
 * IM cuid. Returns `null` when the user has no cloud counterpart (agent-only
 * IMUser rows for example) — callers should silently skip those.
 */
export async function resolveCloudUserIdFromIm(imUserId: string): Promise<number | null> {
  if (!imUserId) return null;
  // Late require so this module stays importable in environments where
  // Prisma isn't initialised (the IM service has its own Prisma client; we
  // talk to the same MySQL via `query()` instead so the cloud module stays
  // boundary-clean — `src/lib/**` cannot import from `src/im/**`).
  const row = await queryOne<{ numeric_id: number | bigint | null } & RowDataPacket>(
    'SELECT numericId AS numeric_id FROM im_users WHERE id = ? LIMIT 1',
    [imUserId],
  );
  if (!row) return null;
  const numeric = row.numeric_id;
  if (numeric == null) return null;
  const asNumber = typeof numeric === 'bigint' ? Number(numeric) : Number(numeric);
  return Number.isFinite(asNumber) && asNumber > 0 ? asNumber : null;
}

/** Truncate a free-form title/error string to a Bell-friendly preview. */
function trim(value: string | null | undefined, max = 120): string {
  const s = (value ?? '').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

interface TaskNotificationContext {
  taskId: string;
  title: string;
  conversationId?: string | null;
  workspaceId?: string | null;
  /** Cloud surface should switch to this and select `selectedTaskId = taskId`. */
  routeTarget?: 'tasks';
}

interface TaskAssignedInput extends TaskNotificationContext {
  /** IM cuid of the assignee — gets the Bell row. */
  assigneeImUserId: string;
  /** IM cuid of the assigner (creator) — used in the message body. */
  creatorImUserId: string;
  creatorLabel?: string;
}

/**
 * Fire `task_assigned` notification on the assignee's Bell.
 *
 * Skipped silently when:
 *   - FF off
 *   - Assignee is an agent-only IMUser without a cloud account (common —
 *     hosted agents don't have a Bell)
 *   - Assignee == creator (no point notifying yourself; the New Task dialog
 *     already gave the visual cue).
 */
export async function emitTaskAssignedNotification(input: TaskAssignedInput): Promise<void> {
  if (!FEATURE_FLAGS.NOTIFICATIONS_LOCAL) return;
  if (!input.assigneeImUserId || input.assigneeImUserId === input.creatorImUserId) return;
  try {
    const cloudId = await resolveCloudUserIdFromIm(input.assigneeImUserId);
    if (!cloudId) return;
    const message = `${input.creatorLabel ?? 'A teammate'} assigned you "${trim(input.title, 80)}".`;
    await createNotification({
      userId: cloudId,
      type: 'info',
      title: 'New task assigned',
      message,
      referenceType: 'task_assigned',
      referenceId: input.taskId,
      payload: {
        taskId: input.taskId,
        title: input.title,
        creatorImUserId: input.creatorImUserId,
        conversationId: input.conversationId ?? null,
        workspaceId: input.workspaceId ?? null,
        routeTarget: 'tasks',
      },
    });
  } catch (err) {
    console.error('[NotificationEmitter] task_assigned failed:', err);
  }
}

interface TaskStatusInput extends TaskNotificationContext {
  /** Cloud user the status belongs to (creator for terminal states). */
  recipientImUserId: string;
  status: 'completed' | 'failed' | 'cancelled';
  error?: string | null;
}

/**
 * Fire a `task_status` notification when a task hits a terminal state. Bell
 * uses this row to render "Task '<title>' completed" / "failed" — clicking
 * routes to the Tasks surface with the taskId selected.
 */
export async function emitTaskStatusNotification(input: TaskStatusInput): Promise<void> {
  if (!FEATURE_FLAGS.NOTIFICATIONS_LOCAL) return;
  if (!input.recipientImUserId) return;
  try {
    const cloudId = await resolveCloudUserIdFromIm(input.recipientImUserId);
    if (!cloudId) return;
    const titleSafe = trim(input.title, 80);
    let title: string;
    let message: string;
    let type: 'info' | 'success' | 'warning' | 'error';
    if (input.status === 'completed') {
      title = 'Task completed';
      message = `"${titleSafe}" finished successfully.`;
      type = 'success';
    } else if (input.status === 'failed') {
      title = 'Task failed';
      message = input.error ? `"${titleSafe}" — ${trim(input.error, 200)}` : `"${titleSafe}" failed.`;
      type = 'error';
    } else {
      title = 'Task cancelled';
      message = `"${titleSafe}" was cancelled.`;
      type = 'info';
    }
    await createNotification({
      userId: cloudId,
      type,
      title,
      message,
      referenceType: 'task_status',
      referenceId: input.taskId,
      payload: {
        taskId: input.taskId,
        title: input.title,
        status: input.status,
        error: input.error ?? null,
        conversationId: input.conversationId ?? null,
        workspaceId: input.workspaceId ?? null,
        routeTarget: 'tasks',
      },
    });
  } catch (err) {
    console.error('[NotificationEmitter] task_status failed:', err);
  }
}

interface TaskApprovalInput extends TaskNotificationContext {
  /** Creator IM cuid — review tasks need creator action. */
  creatorImUserId: string;
  assigneeImUserId?: string | null;
  assigneeLabel?: string;
}

/**
 * Fire `task_approval_requested` notification when an assignee submits work
 * for review (status → `review`). Only the creator gets the Bell row.
 */
export async function emitTaskApprovalRequestedNotification(input: TaskApprovalInput): Promise<void> {
  if (!FEATURE_FLAGS.NOTIFICATIONS_LOCAL) return;
  if (!input.creatorImUserId) return;
  try {
    const cloudId = await resolveCloudUserIdFromIm(input.creatorImUserId);
    if (!cloudId) return;
    const titleSafe = trim(input.title, 80);
    const who = input.assigneeLabel ?? 'The assignee';
    await createNotification({
      userId: cloudId,
      type: 'warning',
      title: 'Approval requested',
      message: `${who} submitted "${titleSafe}" for review.`,
      referenceType: 'task_approval_requested',
      referenceId: input.taskId,
      payload: {
        taskId: input.taskId,
        title: input.title,
        assigneeImUserId: input.assigneeImUserId ?? null,
        conversationId: input.conversationId ?? null,
        workspaceId: input.workspaceId ?? null,
        routeTarget: 'tasks',
      },
    });
  } catch (err) {
    console.error('[NotificationEmitter] task_approval_requested failed:', err);
  }
}

interface RuntimeNotificationInput {
  ownerImUserId: string;
  workspaceId: string;
  runtimeInstallationId: string;
  daemonId?: string | null;
  podName?: string | null;
}

/**
 * Fire `runtime_install_verified` when `installAgent` returns success — gives
 * the operator a "your agent is now hosted" confirmation in the Bell. Click
 * routes to the Runtime panel with the row selected.
 */
export async function emitRuntimeInstallVerifiedNotification(
  input: RuntimeNotificationInput & { agentImUserId: string; agentLabel: string },
): Promise<void> {
  if (!FEATURE_FLAGS.NOTIFICATIONS_LOCAL) return;
  try {
    const cloudId = await resolveCloudUserIdFromIm(input.ownerImUserId);
    if (!cloudId) return;
    await createNotification({
      userId: cloudId,
      type: 'success',
      title: 'Hosted agent online',
      message: `${input.agentLabel} is now running on the runtime.`,
      referenceType: 'runtime_install_verified',
      referenceId: input.runtimeInstallationId,
      payload: {
        runtimeInstallationId: input.runtimeInstallationId,
        daemonId: input.daemonId ?? null,
        agentImUserId: input.agentImUserId,
        workspaceId: input.workspaceId,
        routeTarget: 'runtime',
      },
    });
  } catch (err) {
    console.error('[NotificationEmitter] runtime_install_verified failed:', err);
  }
}

/**
 * Fire `runtime_install_failed` when the in-process K8s sandbox install
 * errors. Click routes to the Runtime panel for log inspection.
 */
export async function emitRuntimeInstallFailedNotification(
  input: RuntimeNotificationInput & { agentLabel: string; reason: string },
): Promise<void> {
  if (!FEATURE_FLAGS.NOTIFICATIONS_LOCAL) return;
  try {
    const cloudId = await resolveCloudUserIdFromIm(input.ownerImUserId);
    if (!cloudId) return;
    await createNotification({
      userId: cloudId,
      type: 'error',
      title: 'Hosted agent install failed',
      message: `${input.agentLabel} could not start — ${trim(input.reason, 200)}`,
      referenceType: 'runtime_install_failed',
      referenceId: input.runtimeInstallationId,
      payload: {
        runtimeInstallationId: input.runtimeInstallationId,
        daemonId: input.daemonId ?? null,
        workspaceId: input.workspaceId,
        reason: trim(input.reason, 500),
        routeTarget: 'runtime',
      },
    });
  } catch (err) {
    console.error('[NotificationEmitter] runtime_install_failed failed:', err);
  }
}

/**
 * Fire `runtime_agent_declared` when a hosted agent first declares itself
 * after install. Used as the readiness "tick" — the Bell row collapses to
 * "agent declared" once the daemon completes the AgentCard upsert.
 */
export async function emitRuntimeAgentDeclaredNotification(
  input: RuntimeNotificationInput & { agentImUserId: string; agentLabel: string },
): Promise<void> {
  if (!FEATURE_FLAGS.NOTIFICATIONS_LOCAL) return;
  try {
    const cloudId = await resolveCloudUserIdFromIm(input.ownerImUserId);
    if (!cloudId) return;
    await createNotification({
      userId: cloudId,
      type: 'info',
      title: 'Hosted agent declared',
      message: `${input.agentLabel} announced its presence and is ready for tasks.`,
      referenceType: 'runtime_agent_declared',
      referenceId: input.runtimeInstallationId,
      payload: {
        runtimeInstallationId: input.runtimeInstallationId,
        daemonId: input.daemonId ?? null,
        agentImUserId: input.agentImUserId,
        workspaceId: input.workspaceId,
        routeTarget: 'runtime',
      },
    });
  } catch (err) {
    console.error('[NotificationEmitter] runtime_agent_declared failed:', err);
  }
}

/**
 * Fire `runtime_degraded` when a runtime container transitions out of a
 * healthy state (failing / stopped). Deduplicated within 10 minutes per
 * `runtimeInstallationId` so the poller doesn't spam the Bell.
 */
export async function emitRuntimeDegradedNotification(
  input: RuntimeNotificationInput & { phase: string; reason?: string | null },
): Promise<void> {
  if (!FEATURE_FLAGS.NOTIFICATIONS_LOCAL) return;
  try {
    const cloudId = await resolveCloudUserIdFromIm(input.ownerImUserId);
    if (!cloudId) return;

    // Per-runtime dedup window — same row triggers at most once / 10min.
    const recent = await queryOne<{ id: string } & RowDataPacket>(
      `SELECT id FROM pc_notifications
        WHERE user_id = ? AND reference_type = 'runtime_degraded' AND reference_id = ?
          AND created_at > DATE_SUB(NOW(), INTERVAL 10 MINUTE)
        LIMIT 1`,
      [cloudId, input.runtimeInstallationId],
    );
    if (recent) return;

    await createNotification({
      userId: cloudId,
      type: 'warning',
      title: 'Runtime degraded',
      message: `${input.podName ?? input.daemonId ?? 'A runtime'} entered ${input.phase}${
        input.reason ? ` — ${trim(input.reason, 160)}` : ''
      }.`,
      referenceType: 'runtime_degraded',
      referenceId: input.runtimeInstallationId,
      payload: {
        runtimeInstallationId: input.runtimeInstallationId,
        daemonId: input.daemonId ?? null,
        workspaceId: input.workspaceId,
        phase: input.phase,
        reason: input.reason ?? null,
        routeTarget: 'runtime',
      },
    });
  } catch (err) {
    console.error('[NotificationEmitter] runtime_degraded failed:', err);
  }
}
