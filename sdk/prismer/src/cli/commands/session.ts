// `prismer session checkpoint save|restore <runId>` — release201/26 Phase 4
// (decision H: capability via skill + CLI, NEVER MCP).
//
// Session checkpoints are daemon-LOCAL state living in `local_run_checkpoints`
// (phase-level, Cline mode — one row per phase transition, not per tool step).
// This command is the agent/ops-facing handle on that table, modelled on the
// existing `cloud <noun> <verb>` shape (`cloud task`, `cloud memory`):
//
//   prismer session checkpoint save <runId>     → snapshot the run's current
//       phase-level checkpoints to a sidecar JSON file under the runs dir, so
//       they survive a `prismer reset` / table wipe and can be re-applied.
//   prismer session checkpoint restore <runId>  → re-insert a previously-saved
//       snapshot back into local_run_checkpoints (idempotent INSERT OR REPLACE).
//
// This is deliberately filesystem-native (snapshot file on disk) — agents run
// on the file system; a save/restore pair that round-trips through a JSON file
// is the natural primitive, and keeps the command useful even when the daemon
// process is down (we open the SQLite file directly, no running daemon needed).

import { Command } from 'commander';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolvePaths } from '../../config.js';
import { openLocalDb, type LocalDb } from '../../sync/store.js';
import { RunCheckpointStore, type RunCheckpoint } from '../../daemon/memory/run-checkpoint-store.js';
import { exitWithError, printJson, runAction } from '../util.js';

interface CheckpointSnapshotFile {
  version: 1;
  runId: string;
  savedAt: string;
  checkpoints: Array<{
    phaseSeq: number;
    phaseName: string;
    payload: Record<string, unknown>;
    createdAt: number;
  }>;
}

function snapshotPath(runId: string): string {
  const paths = resolvePaths();
  // Sidecar under the daemon root so it lives next to local.db. Sanitise runId
  // for fs safety (run ids are uuids/cuid but be defensive).
  const safe = runId.replace(/[^A-Za-z0-9._-]/g, '_');
  return join(paths.root, 'checkpoints', `${safe}.json`);
}

function openStore(): { db: LocalDb; store: RunCheckpointStore } {
  const paths = resolvePaths();
  const db = openLocalDb(paths.localDb);
  return { db, store: new RunCheckpointStore(db) };
}

export function buildSessionCommand(): Command {
  const cmd = new Command('session').description(
    'Daemon-local agent session operations (checkpoints)',
  );

  const checkpoint = new Command('checkpoint').description(
    'Save / restore phase-level run checkpoints (local_run_checkpoints)',
  );

  checkpoint
    .command('save <runId>')
    .description('Snapshot a run\'s phase-level checkpoints to a sidecar JSON file')
    .action(
      runAction<[string]>(
        async (runId) => {
          const { db, store } = openStore();
          try {
            const checkpoints = store.getCheckpoints(runId);
            if (checkpoints.length === 0) {
              exitWithError(`no checkpoints found for run ${runId}`, {
                code: 'session_checkpoint_empty',
              });
            }
            const file: CheckpointSnapshotFile = {
              version: 1,
              runId,
              savedAt: new Date().toISOString(),
              checkpoints: checkpoints.map((c) => ({
                phaseSeq: c.phaseSeq,
                phaseName: c.phaseName,
                payload: c.payload,
                createdAt: c.createdAt,
              })),
            };
            const out = snapshotPath(runId);
            mkdirSync(dirname(out), { recursive: true });
            writeFileSync(out, JSON.stringify(file, null, 2), 'utf8');
            printJson({
              runId,
              savedTo: out,
              phaseCount: checkpoints.length,
              lastPhase: checkpoints[checkpoints.length - 1]?.phaseName ?? null,
            });
          } finally {
            db.close();
          }
        },
        { code: 'session_checkpoint_save_failed' },
      ),
    );

  checkpoint
    .command('restore <runId>')
    .description('Re-insert a saved checkpoint snapshot into local_run_checkpoints')
    .action(
      runAction<[string]>(
        async (runId) => {
          const file = snapshotPath(runId);
          let parsed: CheckpointSnapshotFile;
          try {
            parsed = JSON.parse(readFileSync(file, 'utf8')) as CheckpointSnapshotFile;
          } catch (err) {
            exitWithError(
              `no saved snapshot for run ${runId} (${(err as Error).message})`,
              { code: 'session_checkpoint_no_snapshot' },
            );
            return;
          }
          if (parsed.version !== 1 || parsed.runId !== runId) {
            exitWithError('snapshot file malformed or runId mismatch', {
              code: 'session_checkpoint_bad_snapshot',
            });
          }
          const { db, store } = openStore();
          try {
            let restored = 0;
            for (const c of parsed.checkpoints) {
              if (store.writeCheckpoint(runId, c.phaseSeq, c.phaseName, c.payload)) {
                restored++;
              }
            }
            printJson({
              runId,
              restoredFrom: file,
              phaseCount: parsed.checkpoints.length,
              restored,
            });
          } finally {
            db.close();
          }
        },
        { code: 'session_checkpoint_restore_failed' },
      ),
    );

  checkpoint
    .command('list <runId>')
    .description('Show the live phase-level checkpoints for a run')
    .action(
      runAction<[string]>(
        async (runId) => {
          const { db, store } = openStore();
          try {
            const checkpoints: RunCheckpoint[] = store.getCheckpoints(runId);
            printJson({
              runId,
              phaseCount: checkpoints.length,
              checkpoints: checkpoints.map((c) => ({
                phaseSeq: c.phaseSeq,
                phaseName: c.phaseName,
                createdAt: c.createdAt,
              })),
            });
          } finally {
            db.close();
          }
        },
        { code: 'session_checkpoint_list_failed' },
      ),
    );

  cmd.addCommand(checkpoint);
  return cmd;
}
