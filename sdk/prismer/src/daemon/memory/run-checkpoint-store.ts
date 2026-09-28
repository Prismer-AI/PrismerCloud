// release201/26 Phase 4 — daemon-side run checkpoint store.
//
// PHASE-LEVEL checkpoints (Cline mode), NOT step-level. One row per phase
// transition. The phase boundary is a low-frequency, I/O-friendly recovery
// point — writing per tool step would thrash SQLite under the reasoning-chunk
// firehose (see step-recorder.ts throttle rationale).
//
// Lifecycle (see store.ts migration v7 comment):
//   - writeCheckpoint() on every phase change (dispatch.ts recordPhaseChange)
//   - deleteCheckpoints() on terminal reply (success / failure)
//   - listUnfinishedRuns() + getCheckpoints() at daemon cold-start → resume
//
// All methods are best-effort: a checkpoint write failure must NEVER abort the
// dispatch main flow (local-first; observability/recovery is secondary to the
// run completing). Errors are logged to stderr and swallowed.

import type { LocalDb } from '../../sync/store.js';

export interface RunCheckpoint {
  runId: string;
  phaseSeq: number;
  phaseName: string;
  /** Minimal state snapshot needed to resume this phase. */
  payload: Record<string, unknown>;
  createdAt: number;
}

export class RunCheckpointStore {
  constructor(private readonly db: LocalDb) {}

  /**
   * Persist a phase-level checkpoint. Idempotent INSERT OR REPLACE on
   * (run_id, phase_seq) — a re-emitted phase at the same seq overwrites.
   * Best-effort: returns true on success, false on failure (never throws).
   */
  writeCheckpoint(
    runId: string,
    phaseSeq: number,
    phaseName: string,
    payload: Record<string, unknown>,
  ): boolean {
    if (!runId) return false;
    try {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO local_run_checkpoints
             (run_id, phase_seq, phase_name, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(runId, phaseSeq, phaseName, JSON.stringify(payload ?? {}), Date.now());
      return true;
    } catch (err) {
      process.stderr.write(
        `[run-checkpoint] write failed runId=${runId} seq=${phaseSeq}: ${(err as Error).message}\n`,
      );
      return false;
    }
  }

  /** All checkpoints for a run, ordered by phase_seq ascending. Empty on miss/error. */
  getCheckpoints(runId: string): RunCheckpoint[] {
    if (!runId) return [];
    try {
      const rows = this.db
        .prepare(
          `SELECT run_id, phase_seq, phase_name, payload_json, created_at
             FROM local_run_checkpoints
             WHERE run_id = ?
             ORDER BY phase_seq ASC`,
        )
        .all(runId) as Array<{
        run_id: string;
        phase_seq: number;
        phase_name: string;
        payload_json: string;
        created_at: number;
      }>;
      return rows.map((row) => ({
        runId: row.run_id,
        phaseSeq: row.phase_seq,
        phaseName: row.phase_name,
        payload: parsePayload(row.payload_json),
        createdAt: row.created_at,
      }));
    } catch (err) {
      process.stderr.write(
        `[run-checkpoint] getCheckpoints failed runId=${runId}: ${(err as Error).message}\n`,
      );
      return [];
    }
  }

  /**
   * Distinct run_ids that still have checkpoints = runs that started but never
   * reached a terminal reply (which would have deleted the rows). These are the
   * resume candidates at daemon cold-start. Returns the latest checkpoint per
   * run so the caller has phase context without a second query.
   */
  listUnfinishedRuns(): RunCheckpoint[] {
    try {
      const rows = this.db
        .prepare(
          `SELECT c.run_id, c.phase_seq, c.phase_name, c.payload_json, c.created_at
             FROM local_run_checkpoints c
             JOIN (
               SELECT run_id, MAX(phase_seq) AS max_seq
               FROM local_run_checkpoints
               GROUP BY run_id
             ) m ON m.run_id = c.run_id AND m.max_seq = c.phase_seq
             ORDER BY c.created_at ASC`,
        )
        .all() as Array<{
        run_id: string;
        phase_seq: number;
        phase_name: string;
        payload_json: string;
        created_at: number;
      }>;
      return rows.map((row) => ({
        runId: row.run_id,
        phaseSeq: row.phase_seq,
        phaseName: row.phase_name,
        payload: parsePayload(row.payload_json),
        createdAt: row.created_at,
      }));
    } catch (err) {
      process.stderr.write(
        `[run-checkpoint] listUnfinishedRuns failed: ${(err as Error).message}\n`,
      );
      return [];
    }
  }

  /** Drop all checkpoints for a run (terminal transition / resume settled). Best-effort. */
  deleteCheckpoints(runId: string): void {
    if (!runId) return;
    try {
      this.db.prepare('DELETE FROM local_run_checkpoints WHERE run_id = ?').run(runId);
    } catch (err) {
      process.stderr.write(
        `[run-checkpoint] deleteCheckpoints failed runId=${runId}: ${(err as Error).message}\n`,
      );
    }
  }
}

function parsePayload(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ---- module-level singleton injection ------------------------------------
//
// dispatch.ts (statically imported, no DI container) reaches the store via a
// module-level setter wired once at boot by runner.ts — mirroring the
// run-session-map.ts pattern.

let SINGLETON: RunCheckpointStore | null = null;

export function setRunCheckpointStore(store: RunCheckpointStore | null): void {
  SINGLETON = store;
}

export function getRunCheckpointStore(): RunCheckpointStore | null {
  return SINGLETON;
}
