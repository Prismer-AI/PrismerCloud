// release201/26 Phase 4 — daemon cold-start checkpoint resume scan.
//
// On boot, the daemon has TWO independent recovery layers:
//
//   1. cloud-side sweep (runner.resumeInFlightTasks) — pulls IMTaskRun rows
//      still `running` for this daemon and re-dispatches from cloud truth.
//   2. THIS daemon-local scan — looks at local_run_checkpoints (phase-level,
//      Cline mode). A run with checkpoints but no terminal reply (dispatch.ts
//      deletes them on terminal) means the daemon died mid-run.
//
// This scan decides per unfinished run:
//   - adapter still registered AND health().available → RESUMABLE. We hand the
//     run back to the cloud-side resume path (re-dispatch) so it continues from
//     cloud truth; the local checkpoint is then cleared. result=resumed.
//   - adapter missing / unhealthy → NOT resumable. Emit wire event
//     `task.dispatch.resume_failed` { runId, taskId, reason } so cloud can mark
//     IMTaskRun.status='resume_failed' + surface a "task interrupted, retry"
//     strip. Clear the checkpoint. result=failed.
//
// PHASE-LEVEL, not step-level: the checkpoint payload carries the last phase +
// adapter + identity, which is all the scan needs to route the decision.
//
// Metrics: daemon_run_resume_total{result=resumed|failed} +
// task_dispatch_resume_failed_total (the latter mirrors the cloud-side counter
// so daemon-emitted resume failures are countable before cloud ingests them).

import type { RunCheckpoint, RunCheckpointStore } from './memory/run-checkpoint-store.js';

/** Minimal adapter surface the resume scan needs (subset of AdapterDef). */
export interface ResumeAdapterProbe {
  name: string;
  health(): Promise<{ available: boolean; reason?: string }>;
}

/** Minimal registry surface (subset of AdapterRegistry). */
export interface ResumeAdapterLookup {
  get(name: string): ResumeAdapterProbe | undefined;
}

/** Wire-event emitter — runner passes a closure over its WsClient.send. */
export type ResumeFailedEmitter = (payload: {
  runId: string;
  taskId: string;
  reason: string;
}) => void;

/** Resume-success callback — runner re-dispatches the run from cloud truth. */
export type ResumeRunHandler = (checkpoint: RunCheckpoint) => Promise<void> | void;

/** Per-result metric sink. */
export type ResumeMetricSink = (result: 'resumed' | 'failed') => void;

export interface ResumeScanDeps {
  store: RunCheckpointStore;
  registry: ResumeAdapterLookup;
  /** Re-dispatch a resumable run (typically runner.reconstruct + onTaskDispatch). */
  onResume: ResumeRunHandler;
  /** Emit task.dispatch.resume_failed on the wire. */
  emitResumeFailed: ResumeFailedEmitter;
  /** Record daemon_run_resume_total{result}. */
  onMetric?: ResumeMetricSink;
  /** Test/log hook. */
  log?: (line: string) => void;
}

export interface ResumeScanResult {
  scanned: number;
  resumed: number;
  failed: number;
}

/**
 * Scan unfinished runs (checkpoint rows without a terminal reply) and route
 * each to resume or resume_failed. Idempotent: clears each run's checkpoints
 * after settling so a re-run (e.g. double boot) is a no-op.
 */
export async function runCheckpointResumeScan(deps: ResumeScanDeps): Promise<ResumeScanResult> {
  const log = deps.log ?? (() => {});
  const unfinished = deps.store.listUnfinishedRuns();
  const result: ResumeScanResult = { scanned: unfinished.length, resumed: 0, failed: 0 };
  if (unfinished.length === 0) {
    log('[run-resume] 0 unfinished runs with checkpoints');
    return result;
  }
  log(`[run-resume] scanning ${unfinished.length} unfinished run(s)`);

  for (const cp of unfinished) {
    const adapterName =
      typeof cp.payload.adapterName === 'string' ? cp.payload.adapterName : '';
    const taskId = cp.runId; // run id == taskId on the daemon side (dispatch.ts)

    let resumable = false;
    let reason = '';
    const adapter = adapterName ? deps.registry.get(adapterName) : undefined;
    if (!adapter) {
      reason = adapterName
        ? `adapter ${adapterName} not registered`
        : 'no adapter recorded in checkpoint';
    } else {
      try {
        const health = await adapter.health();
        if (health.available) {
          resumable = true;
        } else {
          reason = `adapter ${adapterName} unhealthy: ${health.reason ?? 'unavailable'}`;
        }
      } catch (err) {
        reason = `adapter ${adapterName} health probe threw: ${(err as Error).message}`;
      }
    }

    if (resumable) {
      try {
        await deps.onResume(cp);
        result.resumed++;
        deps.onMetric?.('resumed');
        log(`[run-resume] resumed run=${cp.runId} adapter=${adapterName} fromPhase=${cp.phaseName}`);
      } catch (err) {
        // Re-dispatch itself failed → treat as resume_failed so the user is not
        // left with a silently-stuck task.
        resumable = false;
        reason = `resume re-dispatch failed: ${(err as Error).message}`;
      }
    }

    if (!resumable) {
      try {
        deps.emitResumeFailed({ runId: cp.runId, taskId, reason });
      } catch (err) {
        log(`[run-resume] emit resume_failed failed run=${cp.runId}: ${(err as Error).message}`);
      }
      result.failed++;
      deps.onMetric?.('failed');
      log(`[run-resume] resume_failed run=${cp.runId} reason=${reason}`);
    }

    // Settle: clear this run's checkpoints regardless of outcome so a later
    // boot doesn't re-process it. Resumed runs continue from cloud truth (fresh
    // dispatch writes its own new checkpoints); failed runs are done.
    deps.store.deleteCheckpoints(cp.runId);
  }

  log(`[run-resume] done resumed=${result.resumed} failed=${result.failed}`);
  return result;
}
