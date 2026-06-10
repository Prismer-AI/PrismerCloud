/**
 * Prismer IM — Metric emit helpers (v2.0.7 release201/11)
 *
 * Thin typed wrappers around `metricEmit()` for the v2.0.7 core registry.
 * Service layer call sites should prefer these helpers over hand-rolled
 * emit objects so that dim names stay aligned with the registry schema.
 *
 * Phase 1 covers 5 core metrics required by S2:
 *   - task.created            (wired in task.service.createTask)
 *   - task.completed          (wired in task.service.completeTask)
 *   - task.failed             (wired in task.service.failTask)
 *   - task.acceptance.status_changed  (stub — release201/10 owns wiring)
 *   - approval.decided        (wired in approval.service.decideApproval)
 *
 * The other 11 registered metrics land in Phase 2 (release201/11 §11).
 */

import { metricEmit } from './metric.service';

export type AcceptanceStatus = 'passed' | 'failed' | 'partial' | 'none';

/**
 * release201/11 §4 #5 — emit task.acceptance.status_changed.
 *
 * STUB for S2: release201/10 (task-acceptance) is not yet implemented, so
 * no production call sites exist. This helper is the planned integration
 * point — the acceptance service should call it after `recomputeAcceptance`
 * lands. Until then it is dead code but typed against the registry so the
 * future wiring is a 1-line change.
 */
export function emitTaskAcceptanceStatusChanged(args: {
  workspaceId: string;
  taskId: string;
  capability: string;
  status: AcceptanceStatus;
  projectId?: string;
}): void {
  metricEmit({
    namespace: 'task.acceptance',
    name: 'status_changed',
    value: args.status,
    dims: {
      workspaceId: args.workspaceId,
      taskId: args.taskId,
      capability: args.capability,
      projectId: args.projectId,
    },
  });
}
