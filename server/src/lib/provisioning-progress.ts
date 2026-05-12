/**
 * Provisioning progress signals — DB-backed step transitions for the
 * sandbox/device creation lifecycle.
 *
 * Why this exists: post-§26 the sandbox provisioning flow runs cloud-side
 * (direct K8s API) and takes 2-3s end-to-end. The workspace UI and
 * /admin/sandbox console previously had no visibility — only "creating…"
 * then "ready". This module gives them a structured per-step signal.
 *
 * Storage: `im_containers.provisioning_step` (current step, NULL when
 * terminal) + `im_containers.provisioning_history` (JSON array of every
 * transition). Migration 322 adds both columns.
 *
 * Transport: just DB writes + frontend polling. SSE/WS were considered
 * but rejected as overengineering for a 3s flow with ≤7 discrete steps —
 * 1s polling is fine and uses zero new infrastructure.
 *
 * Step model (typical order, some skip on local/non-K8s paths):
 *   container_create   — POST createNamespacedPod in flight
 *   container_running  — pod Running + Ready per kubelet
 *   daemon_healthy     — in-cluster /healthz probe ok (best-effort, skipped out-of-cluster)
 *   ws_connected       — daemon connected back to cloud WS (post-create, async)
 *   host_declared      — daemon sent agent.host.declare envelope
 *   adapter_installed  — runtime-installation route called /v1/agents/install
 *   ready              — terminal success (provisioning_step set NULL)
 *
 * Steps 4-6 are emitted from different sites (WS handler, install route)
 * — this module is the single write path; callers just supply rowId.
 */

import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';

export type ProvisioningStep =
  | 'container_create'
  | 'container_running'
  | 'daemon_healthy'
  | 'ws_connected'
  | 'host_declared'
  | 'adapter_installed'
  | 'ready';

export type ProvisioningStepStatus = 'in_progress' | 'ok' | 'error';

export interface ProvisioningHistoryEntry {
  step: ProvisioningStep;
  status: ProvisioningStepStatus;
  startedAt: number;
  durationMs?: number;
  error?: string;
}

/**
 * Append a step transition to the container row.
 *
 * When `status === 'in_progress'`: starts a new step, sets
 *   `provisioningStep` to its name, appends a {status:'in_progress'}
 *   history entry with `startedAt = now`.
 *
 * When `status === 'ok' | 'error'`: closes the most-recent in_progress
 *   entry for this step name by stamping `durationMs` (now - startedAt)
 *   and flipping `status`. If `step === 'ready'`, also clears
 *   `provisioningStep` to NULL — signals "no provisioning in flight".
 *
 * Best-effort: a failure to record progress must NOT abort provisioning.
 * Logs and returns null so the caller continues regardless.
 */
export async function recordProvisioningStep(
  rowId: string,
  step: ProvisioningStep,
  status: ProvisioningStepStatus,
  error?: string,
): Promise<void> {
  try {
    const row = (await prisma.iMContainer.findUnique({
      where: { id: rowId },
      select: { provisioningHistory: true },
    })) as { provisioningHistory: unknown } | null;
    if (!row) {
      logger.warn({ rowId, step, status }, '[provisioning-progress] row not found, skipping');
      return;
    }

    const history = normalizeHistory(row.provisioningHistory);
    const now = Date.now();

    if (status === 'in_progress') {
      history.push({ step, status: 'in_progress', startedAt: now });
      await prisma.iMContainer.update({
        where: { id: rowId },
        data: { provisioningStep: step, provisioningHistory: history },
      });
      return;
    }

    // status === 'ok' | 'error' — close the most-recent in_progress for `step`
    const idx = lastInProgressIndex(history, step);
    if (idx === -1) {
      // No prior in_progress entry; record a synthetic closed entry so the
      // history still reflects the transition (useful for terminal-only
      // emits like recordProvisioningStep(rowId, 'ready', 'ok')).
      history.push({ step, status, startedAt: now, durationMs: 0, ...(error ? { error } : {}) });
    } else {
      const entry = history[idx];
      entry.status = status;
      entry.durationMs = now - entry.startedAt;
      if (error) entry.error = error;
    }

    const stepCleared = step === 'ready' || status === 'error';
    await prisma.iMContainer.update({
      where: { id: rowId },
      data: {
        provisioningHistory: history,
        ...(stepCleared ? { provisioningStep: null } : {}),
      },
    });
  } catch (err) {
    logger.warn(
      { rowId, step, status, err: err instanceof Error ? err.message : String(err) },
      '[provisioning-progress] write failed',
    );
  }
}

/** Callback shape consumed by `k8sSandbox.provisionContainer`. */
export type StepEmitter = (
  step: ProvisioningStep,
  status: ProvisioningStepStatus,
  error?: string,
) => void | Promise<void>;

/** Build a StepEmitter bound to a specific row id. */
export function emitterForRow(rowId: string): StepEmitter {
  return (step, status, error) => recordProvisioningStep(rowId, step, status, error);
}

function normalizeHistory(raw: unknown): ProvisioningHistoryEntry[] {
  if (Array.isArray(raw)) return raw as ProvisioningHistoryEntry[];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as ProvisioningHistoryEntry[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function lastInProgressIndex(history: ProvisioningHistoryEntry[], step: ProvisioningStep): number {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].step === step && history[i].status === 'in_progress') return i;
  }
  return -1;
}
