// release203/15 WS-E4 §7.3 "B" — shared `task wait` command-builder (PoC).
//
// `task wait <id>` exists in BOTH CLIs — `prismer` (bin, @prismer/runtime,
// CloudClient + JSON output) and `cloud` (bin, @prismer/sdk, PrismerClient.im +
// text output). The poll/settle LOGIC was duplicated verbatim, so a change to
// the settle contract had to be ported twice (the exact drift WS-E4 fights).
//
// This module is the single source of that logic. It is **transport- and
// output-agnostic**: it knows nothing about CloudClient / PrismerClient,
// JSON-vs-text, or which auth a binary uses. Each binary injects a
// `TaskWaitAdapter` that bridges to its own client + output convention, so the
// settle semantics (poll GET task until status ∈ settle-set; review included by
// default; --terminal-only for strict; non-zero exit on failed/cancelled) live
// here once. Add a flag / change the settle set here → both binaries get it.
//
// Why a self-contained module (not a cross-package import edge): @prismer/sdk
// and @prismer/runtime are independently packed/published with no dependency
// edge between them (see WS-E4 §7.3 owner table + the cli-ui.ts mirror note).
// This file therefore imports nothing but `commander`; each binary references
// it through its own bundler (tsup inlines it), keeping both tarballs
// standalone. See docs/release203/15b-shared-builder-plan.md for the rollout
// of the remaining overlapping namespaces.

import { Command } from 'commander';

/**
 * Minimal task shape the settle loop needs: just a `status` to test against the
 * settle set. Adapters return their OWN richer record type (`R`), so each binary
 * renders with its full task payload — the builder only reads `status`.
 */
export interface TaskWaitRecord {
  status: string;
}

/**
 * The seam each binary fills, generic over the binary's concrete record type
 * `R`. Keeps the builder ignorant of transport (which HTTP client), output
 * (JSON vs text), and auth (api_key vs im_token).
 */
export interface TaskWaitAdapter<R extends TaskWaitRecord = TaskWaitRecord> {
  /**
   * Fetch the task by id. Return the record on success, or `null` for a
   * transient failure (the loop keeps polling until timeout). Throw to abort
   * immediately (e.g. 404 / auth failure the caller deems fatal).
   */
  getTask(id: string): Promise<R | null>;
  /** Render the settled record using the binary's output convention. */
  emit(payload: R, opts: { json: boolean }): void;
  /** Print an error in the binary's convention and exit non-zero. */
  fail(msg: string): never;
}

const DEFAULT_SETTLE = ['completed', 'failed', 'cancelled', 'review'];
const TERMINAL_ONLY = ['completed', 'failed', 'cancelled'];
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Build the `wait <taskId>` command. Returns a configured commander `Command`
 * the binary attaches under its own `task` parent. Behaviour is identical
 * across binaries; only the injected adapter differs.
 *
 * Semantics (shared contract):
 *  - default settle set: review/completed/failed/cancelled. `review` is
 *    included because for a delegated task it means "assignee finished, awaiting
 *    YOUR approval" — blocking until `completed` would deadlock the very
 *    orchestrator that must approve.
 *  - --terminal-only → strict completed/failed/cancelled (drop review).
 *  - exits non-zero on failed/cancelled; non-zero on timeout.
 */
export function buildTaskWaitCommand<R extends TaskWaitRecord>(adapter: TaskWaitAdapter<R>): Command {
  return new Command('wait')
    .argument('<taskId>', 'task id to wait on')
    .description('Block until a task settles (review/completed/failed/cancelled) and print it')
    .option('--timeout-ms <ms>', 'max wait before giving up', (v) => parseInt(v, 10))
    .option('--terminal-only', 'settle only on completed/failed/cancelled (not review)')
    .option('--json', 'output JSON')
    .action(async (taskId: string, opts: { timeoutMs?: number; terminalOnly?: boolean; json?: boolean }) => {
      const settle = new Set(opts.terminalOnly ? TERMINAL_ONLY : DEFAULT_SETTLE);
      const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      while (Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS);
        let rec: R | null;
        try {
          rec = await adapter.getTask(taskId);
        } catch (err) {
          adapter.fail(err instanceof Error ? err.message : String(err));
        }
        if (!rec) continue; // transient — keep polling until timeout
        if (settle.has(rec.status)) {
          adapter.emit(rec, { json: Boolean(opts.json) });
          process.exit(rec.status === 'failed' || rec.status === 'cancelled' ? 1 : 0);
        }
      }
      adapter.fail(`task ${taskId} did not settle within timeout`);
    });
}
