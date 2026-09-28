// B-P1a — metric-outbox replay worker: the FIRST reader of metrics.jsonl.
//
// Write side (exists since release201/11 §7.0): `daemonMetricEmit`
// (metric-emit.ts) falls back to `appendAgentMetricOutbox` (agent-outbox.ts)
// whenever cloud is unreachable, appending `{kind:'metric.event', ts,
// eventType, workspaceId, projectId, taskId, payload}` lines to the per-agent
// `devices/<did>/agents/<aid>/artifacts/metrics.jsonl`. Until now nothing ever
// read those lines back — offline telemetry died on disk (the v2.0.8
// "metric-pump" comment on the write side was a promissory note). This worker
// is the pump: it drains the JSONL into `POST /api/im/metrics/batch`, the same
// endpoint the online path POSTs, with the same per-event field shape.
//
// Delivery contract — **at-least-once**:
//   * a file is unlinked only AFTER every batch chunk of that file came back
//     HTTP-ok, so a crash anywhere before that replays the whole file (duplicates
//     possible). Additive metrics (count / sum) tolerate the duplication.
//   * events the cloud rejected *per-event* (207 body `rejected`/`errors`) are
//     counted + logged and dropped with the file: re-POSTing identical rows
//     rejects identically, so retrying them would loop forever. HTTP-level
//     failure is the only thing that retries.
//
// File-swap discipline — **freeze-then-read** (rename BEFORE read, unlink
// AFTER ack). Never `truncate` in place:
//
//   truncate   : read → POST → truncate  → any line appended between read and
//                truncate is silently destroyed.
//   rename-last: read → POST → rename → unlink → a line appended between read
//                and rename still rides inside the renamed file and dies with
//                the unlink.
//   rename-first (this file): rename → read frozen copy → POST → unlink. The
//                writer's `appendFileSync` always opens by *path*, so an append
//                that lands after the rename creates a FRESH metrics.jsonl and
//                is picked up on the next tick. Combined with the leftover
//                `.replayed` pickup below, no line is ever lost.
//
//   (agent-outbox.ts:22-24 reserved this point: "flush 成功后 truncate" was the
//   sketch; the append-race window above is why the sketch is not what ships.)
//
// Concurrency discipline mirrors MemoryOutboxWorker (memory/outbox-worker.ts):
// single-flight busy flag, stop() clears the timer, consecutive-failure
// escalation after 5 failed ticks. Unlike that worker there is NO local SQLite
// queue — the file IS the queue.

import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { CloudClient } from '../auth.js';
import type { ConfigPaths } from '../config.js';
import { createLogger } from '../lib/logger.js';
import { resolveAgentDirPaths } from './agent-dir.js';

const log = createLogger('MetricReplay');

/** Frozen-copy suffix, appended to metricsOutboxFile. */
const FROZEN_SUFFIX = '.replayed';
/** Same per-request budget as the online `daemonMetricEmit` path. */
const BATCH_TIMEOUT_MS = 5_000;
/** Cloud hard cap — /api/im/metrics/batch rejects > 500 events per request. */
const CLOUD_MAX_BATCH = 500;
/** Default drain cadence. Metrics are additive and latency-insensitive; a
 *  minute of replay lag after reconnect is not worth a notify hook. */
const DEFAULT_INTERVAL_MS = 60_000;
/** Escalation line, copied from outbox-worker's maxConsecutiveFailures. */
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 600_000;

/** Event shape POSTed to /api/im/metrics/batch — field-for-field what
 *  `daemonMetricEmit` sends on the online path (source/sourceId are injected
 *  cloud-side from the caller's identity; the daemon never sends them). */
interface ReplayBatchEvent {
  namespace: string;
  name: string;
  value?: number | string;
  dims: Record<string, string | number | boolean | null>;
  ts?: string;
}

interface MetricsBatchResponseBody {
  ok?: boolean;
  data?: {
    accepted?: number;
    rejected?: number;
    errors?: Array<{ index: number; error: string }>;
  };
}

export interface MetricOutboxReplayOptions {
  cloud: CloudClient;
  paths: ConfigPaths;
  daemonId: string;
  /** Tick interval. Default 60_000ms. */
  intervalMs?: number;
  /** Events per POST. Default 500 (the cloud's own MAX_BATCH). */
  batchSize?: number;
  /** Failed ticks before warn escalates to error. Default 5. */
  maxConsecutiveFailures?: number;
  /** Log override (tests). Defaults to the module logger. */
  log?: { info(m: string): void; warn(m: string): void; error(m: string): void };
}

export interface ReplayOutcome {
  /** Agent dirs inspected this tick. */
  agents: number;
  /** Outbox files fully drained (POSTed + unlinked). */
  filesDrained: number;
  /** Files kept on disk because the cloud POST failed — retried next tick. */
  filesRetained: number;
  /** Events actually POSTed (accepted + rejected). */
  posted: number;
  /** Events the cloud accepted. */
  accepted: number;
  /** Events the cloud refused per-event — logged, then dropped with the file. */
  rejected: number;
  /** Lines that were not replayable (bad JSON / non `metric.event` kind /
   *  eventType without a `namespace.name` split). */
  skippedLines: number;
}

function emptyOutcome(): ReplayOutcome {
  return { agents: 0, filesDrained: 0, filesRetained: 0, posted: 0, accepted: 0, rejected: 0, skippedLines: 0 };
}

export class MetricOutboxReplayWorker {
  private timer?: NodeJS.Timeout;
  private busy = false;
  private consecutiveFailures = 0;
  /** Wall clock before which the next tick is suppressed (failure backoff). */
  private nextAttemptAt = 0;

  constructor(private readonly opts: MetricOutboxReplayOptions) {}

  start(): void {
    if (this.timer) return;
    const interval = this.opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    // Startup trigger: drain what accumulated while the daemon was offline.
    // Fire-and-forget — boot must never block on cloud I/O.
    void this.tickIfDue().catch((err) => {
      this.out('error', `startup tick threw: ${(err as Error).message}`);
    });
    this.timer = setInterval(() => {
      void this.tickIfDue().catch((err) => {
        this.out('error', `tick threw: ${(err as Error).message}`);
      });
    }, interval);
    // Observability plumbing must never hold the process open.
    this.timer.unref();
    this.out('info', `started: interval=${interval}ms batchSize=${this.batchSize()}`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Drain once, synchronised against the busy flag (same shape as
   * MemoryOutboxWorker.flushNow). Used by tests; production relies on
   * start()'s startup tick + interval. Deliberately ignores the failure
   * backoff — an explicit drain request is not throttled.
   */
  async replayOnce(): Promise<ReplayOutcome> {
    while (this.busy) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return this.tick();
  }

  private batchSize(): number {
    return this.opts.batchSize ?? CLOUD_MAX_BATCH;
  }

  /** Timer entry point: respects the failure backoff window. */
  private async tickIfDue(): Promise<ReplayOutcome> {
    if (Date.now() < this.nextAttemptAt) return emptyOutcome();
    return this.tick();
  }

  private async tick(): Promise<ReplayOutcome> {
    const outcome = emptyOutcome();
    if (this.busy) return outcome;
    this.busy = true;
    let failed = false;
    try {
      for (const agentImUserId of this.agentIds()) {
        outcome.agents += 1;
        const metricsOutboxFile = resolveAgentDirPaths(
          this.opts.paths,
          this.opts.daemonId,
          agentImUserId,
        ).metricsOutboxFile;
        const frozen = metricsOutboxFile + FROZEN_SUFFIX;
        // Frozen copy first (older events), then the live file. A frozen file
        // that still exists means the previous POST never came back clean.
        for (const target of [frozen, metricsOutboxFile]) {
          if (!existsSync(target)) continue;
          if (target === metricsOutboxFile) {
            if (existsSync(frozen)) {
              // renameSync clobbers on POSIX — never freeze over an unacked
              // copy. The fresh lines stay put and drain on a later tick.
              break;
            }
            try {
              // FREEZE BEFORE READ — see the header comment. From here on the
              // frozen copy is immutable and any concurrent append starts a
              // fresh live file.
              renameSync(target, frozen);
            } catch (err) {
              this.out('warn', `freeze failed, skipping agent=${agentImUserId}: ${(err as Error).message}`);
              break;
            }
          }
          const r = await this.flushFrozen(frozen);
          outcome.posted += r.posted;
          outcome.accepted += r.accepted;
          outcome.rejected += r.rejected;
          outcome.skippedLines += r.skipped;
          if (r.ok) {
            outcome.filesDrained += 1;
          } else {
            outcome.filesRetained += 1;
            failed = true;
            break; // stop draining this agent — the older file stays pending
          }
        }
      }
    } finally {
      this.busy = false;
    }

    if (failed) {
      this.consecutiveFailures += 1;
      this.nextAttemptAt = Date.now() + this.backoffDelay();
      const max = this.opts.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
      this.out(
        this.consecutiveFailures >= max ? 'error' : 'warn',
        `metrics outbox flush failed #${this.consecutiveFailures} — file(s) retained, retrying ` +
          `(posted=${outcome.posted} accepted=${outcome.accepted} rejected=${outcome.rejected})`,
      );
    } else {
      // Success (or nothing to do) clears the backoff and the escalation
      // counter — a long-idle daemon must not carry stale failure context.
      this.consecutiveFailures = 0;
      this.nextAttemptAt = 0;
    }
    return outcome;
  }

  /** Exponential backoff after a failed tick: 5s doubling to a 10min ceiling. */
  private backoffDelay(): number {
    return Math.min(BACKOFF_BASE_MS * 2 ** Math.min(this.consecutiveFailures, 8), BACKOFF_MAX_MS);
  }

  /**
   * POST every replayable line of one frozen file, then unlink it. Any
   * HTTP-level failure retains the whole file (at-least-once; chunks of the
   * same file already accepted are re-sent on the retry — additive metrics
   * tolerate that).
   */
  private async flushFrozen(frozen: string): Promise<{
    ok: boolean;
    posted: number;
    accepted: number;
    rejected: number;
    skipped: number;
  }> {
    let raw: string;
    try {
      raw = readFileSync(frozen, 'utf8');
    } catch (err) {
      // Lost a race with a concurrent drain / manual cleanup — nothing to send.
      this.out('warn', `read failed (skipping): ${(err as Error).message}`);
      return { ok: true, posted: 0, accepted: 0, rejected: 0, skipped: 0 };
    }

    const { events, skipped } = parseLines(raw);
    if (events.length === 0) {
      if (skipped > 0) {
        this.out(
          'warn',
          `dropping ${skipped} non-replayable line(s) from ${basename(frozen)} ` +
            `(bad JSON / kind !== 'metric.event' / eventType without a namespace.name split)`,
        );
      }
      try {
        unlinkSync(frozen);
      } catch {
        /* best-effort */
      }
      return { ok: true, posted: 0, accepted: 0, rejected: 0, skipped };
    }

    const batchSize = this.batchSize();
    let posted = 0;
    let accepted = 0;
    let rejected = 0;
    for (let i = 0; i < events.length; i += batchSize) {
      const chunk = events.slice(i, i + batchSize);
      const res = await this.opts.cloud.request<MetricsBatchResponseBody>(
        'POST',
        '/api/im/metrics/batch',
        { body: { events: chunk }, timeoutMs: BATCH_TIMEOUT_MS },
      );
      if (!res.ok) {
        // Transport / 4xx / 5xx — whole file retained, retried after backoff.
        this.out(
          'warn',
          `POST /api/im/metrics/batch failed (status=${res.status} code=${res.error?.code ?? 'unknown'}) ` +
            `— retaining ${basename(frozen)} (${chunk.length} event(s) pending)`,
        );
        return { ok: false, posted, accepted, rejected, skipped };
      }
      posted += chunk.length;
      accepted += res.data?.data?.accepted ?? 0;
      rejected += res.data?.data?.rejected ?? 0;
      const errors = res.data?.data?.errors ?? [];
      if (errors.length > 0) {
        this.out(
          'warn',
          `${errors.length} event(s) rejected cloud-side in ${basename(frozen)} — e.g. ` +
            `${errors.slice(0, 3).map((e) => e.error).join('; ')} (dropped, not retried)`,
        );
      }
    }

    try {
      unlinkSync(frozen);
    } catch (err) {
      // Unlink failure means the file replays next tick (duplicate rows) —
      // that is the contract, so log and move on.
      this.out('warn', `unlink failed (file will replay): ${(err as Error).message}`);
    }
    return { ok: true, posted, accepted, rejected, skipped };
  }

  /**
   * Agent ids that own a device dir on this daemon. Derived through the
   * write-side resolver (`resolveAgentDirPaths`) so this reader can never
   * drift from the writer's layout; `_layout_probe` only names the parent.
   */
  private agentIds(): string[] {
    let entries: Dirent[];
    try {
      const agentsDir = dirname(
        resolveAgentDirPaths(this.opts.paths, this.opts.daemonId, '_layout_probe').root,
      );
      entries = readdirSync(agentsDir, { withFileTypes: true });
    } catch {
      // Fresh daemon / no devices dir yet — nothing to drain.
      return [];
    }
    return entries.filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name);
  }

  private out(level: 'info' | 'warn' | 'error', msg: string): void {
    if (this.opts.log) {
      this.opts.log[level](msg);
      return;
    }
    log[level](msg);
  }
}

function parseLines(raw: string): { events: ReplayBatchEvent[]; skipped: number } {
  const events: ReplayBatchEvent[] = [];
  let skipped = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue; // blank / trailing-newline segment
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      skipped += 1;
      continue;
    }
    const event = toBatchEvent(entry);
    if (event) events.push(event);
    else skipped += 1;
  }
  return { events, skipped };
}

/**
 * Rebuild one cloud batch event from an outbox entry. Field semantics are the
 * online path's (`metric-emit.ts`): namespace/name split at the FIRST dot of
 * eventType (the registry convention — namespaces never contain dots),
 * value/dims/ts passed through as the writer serialised them.
 */
function toBatchEvent(entry: unknown): ReplayBatchEvent | null {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;
  if (e.kind !== 'metric.event') return null;
  if (typeof e.eventType !== 'string') return null;
  const dot = e.eventType.indexOf('.');
  if (dot <= 0 || dot === e.eventType.length - 1) return null; // needs both halves

  const payload = (e.payload && typeof e.payload === 'object' ? e.payload : {}) as Record<string, unknown>;
  const dims: Record<string, string | number | boolean | null> = {};
  const rawDims = payload.dims;
  if (rawDims && typeof rawDims === 'object') {
    for (const [k, v] of Object.entries(rawDims as Record<string, unknown>)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null) {
        dims[k] = v;
      }
    }
  }
  // The entry's top-level workspaceId/projectId/taskId are the writer's own
  // mirror of dims.* (agent-outbox.ts:118-123). Restore any that the payload
  // dims lost so the cloud's hard `dims.workspaceId` gate can still pass.
  for (const key of ['workspaceId', 'projectId', 'taskId'] as const) {
    const mirror = e[key];
    if (typeof mirror === 'string' && mirror.length > 0 && dims[key] === undefined) {
      dims[key] = mirror;
    }
  }

  const value = payload.value;
  return {
    namespace: e.eventType.slice(0, dot),
    name: e.eventType.slice(dot + 1),
    ...(value === null || value === undefined ? {} : { value: value as number | string }),
    dims,
    ...(typeof e.ts === 'string' ? { ts: e.ts } : {}),
  };
}
