import { randomUUID } from 'node:crypto';
import type { ExtractedPage } from '../../../../daemon/memory/extract.js';
import type { PostTurnJob, PostTurnJobsHealth, PostTurnPageReceipt, PostTurnStore } from './post-turn-store.js';
import { terminalRoutingEvidenceError } from './post-turn-context.js';

export interface PostTurnExtractionResult {
  pages: ExtractedPage[];
  /**
   * memory211/08 A4-① — additive extractor diagnostics. Ledger rows written by
   * older daemons omit them (isExtractionResult only checks `pages`); the
   * extract.done observability event degrades gracefully when absent.
   */
  skipReason?: string;
  gatedOut?: number;
  truncated?: boolean;
  latencyMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  errorStatus?: number;
}

export interface PostTurnWorkerDependencies {
  store: PostTurnStore;
  extract: (job: PostTurnJob, signal?: AbortSignal) => Promise<PostTurnExtractionResult>;
  apply: (
    job: PostTurnJob,
    result: PostTurnExtractionResult,
    resultHash: string,
  ) => Promise<unknown[] | void> | unknown[] | void;
  /**
   * memory211/08 A4-① — best-effort observability side-channel (the daemon
   * runner wires it to `slot.outbox.enqueue`). Absent = no-op; throwing must
   * never change the processing outcome.
   */
  emitObservability?: (event: Record<string, unknown>) => void;
}

export interface PostTurnWorkerOptions {
  pollIntervalMs?: number;
  retentionMs?: number;
  now?: () => number;
  /**
   * memory211/08 A4-① — provenance for extract.done envelopes (schema
   * requires a non-empty deviceId). The daemon runner passes the real
   * daemon_id; the fallback keeps ad-hoc constructions schema-valid without
   * pretending to be a specific device.
   */
  deviceId?: string;
}

export type PostTurnProcessOutcome =
  | { state: 'persisted'; job: PostTurnJob; receipts: PostTurnPageReceipt[] }
  | { state: 'skipped_not_durable'; job: PostTurnJob; receipts: [] }
  | { state: 'retryable_failure' | 'terminal_failure'; job: PostTurnJob; error: string }
  | { state: 'processing' | 'not_found'; job?: PostTurnJob };

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1_000;

function emptyHealth(sampledAt: number): PostTurnJobsHealth {
  return { pending: 0, processing: 0, deadLetter: 0, oldestPendingAgeMs: 0, sampledAt };
}

export class PostTurnWorker {
  private readonly now: () => number;
  private readonly pollIntervalMs: number;
  private readonly retentionMs: number;
  private readonly deviceId: string;
  private timer: NodeJS.Timeout | null = null;
  private backgroundDraining = false;
  private readonly inFlightByKey = new Map<string, Promise<PostTurnProcessOutcome>>();
  private lastRetentionSweepAt: number | null = null;
  private healthSnapshot: PostTurnJobsHealth;

  constructor(
    private readonly deps: PostTurnWorkerDependencies,
    opts: PostTurnWorkerOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.retentionMs = opts.retentionMs ?? DEFAULT_RETENTION_MS;
    this.deviceId = opts.deviceId ?? 'unattributed-device';
    this.healthSnapshot = emptyHealth(this.now());
  }

  start(): void {
    if (this.timer) return;
    const now = this.now();
    const processingRecovered = this.deps.store.recoverProcessing(now);
    const gatewayDeadLettersRecovered = this.deps.store.recoverGatewayDeadLetters(now);
    if (processingRecovered > 0 || gatewayDeadLettersRecovered > 0) {
      console.log(
        `[PostTurnWorker] restart recovery: processing=${processingRecovered} gatewayDeadLetter=${gatewayDeadLettersRecovered}`,
      );
    }
    this.maybeCompact(now);
    this.refreshHealth();
    this.timer = setInterval(() => this.scheduleDrain(), this.pollIntervalMs);
    this.timer.unref?.();
    this.scheduleDrain();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Cached only: /healthz must never perform SQLite I/O. */
  snapshotHealth(): PostTurnJobsHealth {
    return { ...this.healthSnapshot };
  }

  async drainOnce(): Promise<boolean> {
    if (this.backgroundDraining) return false;
    this.backgroundDraining = true;
    try {
      const now = this.now();
      this.maybeCompact(now);
      const job = this.deps.store.claimNext(now);
      if (!job) {
        this.refreshHealth();
        return false;
      }

      await this.trackClaimed(job);
      this.refreshHealth();
      return true;
    } finally {
      this.backgroundDraining = false;
    }
  }

  /** Process one canonical turn for the bounded pre-reply barrier. */
  async processKey(
    key: string,
    opts: { signal?: AbortSignal; ignoreSchedule?: boolean } = {},
  ): Promise<PostTurnProcessOutcome> {
    const existing = this.inFlightByKey.get(key);
    if (existing) return existing;
    const claimed = this.deps.store.claimByKey(key, this.now(), opts.ignoreSchedule ?? false);
    if (!claimed) return this.outcomeForStoredJob(this.deps.store.get(key));
    return this.trackClaimed(claimed, opts.signal);
  }

  /** Register both background and pre-reply claims in one keyed in-flight map. */
  private trackClaimed(job: PostTurnJob, signal?: AbortSignal): Promise<PostTurnProcessOutcome> {
    const key = job.idempotencyKey;
    const existing = this.inFlightByKey.get(key);
    if (existing) return existing;
    const tracked = this.processClaimed(job, signal).finally(() => {
      if (this.inFlightByKey.get(key) === tracked) this.inFlightByKey.delete(key);
      this.refreshHealth();
    });
    this.inFlightByKey.set(key, tracked);
    return tracked;
  }

  private async processClaimed(job: PostTurnJob, signal?: AbortSignal): Promise<PostTurnProcessOutcome> {
    if (!job.conversationId) {
      const error = 'non_extractable:no_conversation_id';
      this.deps.store.terminalFailure(job.idempotencyKey, error, this.now());
      this.emitExtractDone(job, 'failed_terminal', { error });
      return { state: 'terminal_failure', job: this.deps.store.get(job.idempotencyKey) ?? job, error };
    }
    const routingError = terminalRoutingEvidenceError(job.payload.executionContext);
    if (routingError) {
      this.deps.store.terminalFailure(job.idempotencyKey, routingError, this.now());
      this.emitExtractDone(job, 'failed_terminal', { error: routingError });
      return {
        state: 'terminal_failure',
        job: this.deps.store.get(job.idempotencyKey) ?? job,
        error: routingError,
      };
    }
    try {
      if (job.applyResult) {
        // Replay path — the original attempt already emitted; never double-count.
        this.deps.store.complete(job.idempotencyKey, this.now());
        return this.outcomeForStoredJob(this.deps.store.get(job.idempotencyKey));
      }
      if (job.payload.explicitMemoryReceipts?.length) {
        const receipts = this.deps.store.saveApplyResult(job.idempotencyKey, job.payload.explicitMemoryReceipts);
        this.deps.store.complete(job.idempotencyKey, this.now());
        this.emitExtractDone(job, 'applied', { pages: receipts.length });
        return { state: 'persisted', job: this.deps.store.get(job.idempotencyKey) ?? job, receipts };
      }

      let result: PostTurnExtractionResult;
      let resultHash: string;
      if (job.resultHash && isExtractionResult(job.result)) {
        result = job.result;
        resultHash = job.resultHash;
      } else {
        result = await this.deps.extract(job, signal);
        throwIfAborted(signal);
        const saved = this.deps.store.saveExtractionResult(job.idempotencyKey, result, this.now());
        if (!isExtractionResult(saved.result)) {
          throw new Error('post-turn extraction ledger has an invalid result shape');
        }
        result = saved.result;
        resultHash = saved.hash;
      }
      // A native memory_write may complete while the extractor is in flight.
      // Re-read the durable row before applying model output: the explicit
      // receipt is authoritative and must suppress a duplicate Page revision.
      const refreshed = this.deps.store.get(job.idempotencyKey);
      const explicitReceipts = refreshed?.applyResult?.length
        ? refreshed.applyResult
        : (refreshed?.payload.explicitMemoryReceipts ?? []);
      if (explicitReceipts.length > 0) {
        const receipts = this.deps.store.saveApplyResult(job.idempotencyKey, explicitReceipts);
        this.deps.store.complete(job.idempotencyKey, this.now());
        this.emitExtractDone(job, 'applied', { pages: receipts.length });
        return { state: 'persisted', job: this.deps.store.get(job.idempotencyKey) ?? job, receipts };
      }
      if (result.pages.length === 0) {
        this.deps.store.saveApplyResult(job.idempotencyKey, []);
        this.deps.store.complete(job.idempotencyKey, this.now());
        // diag rides along: a precheck skip (no LLM call) and "the LLM ran but
        // the deliverable gate refused every page" both land here with zero
        // pages — metricsJson.gatedOut is what tells them apart (review fix).
        this.emitExtractDone(job, 'skipped', { skipReason: result.skipReason, diag: result });
        return { state: 'skipped_not_durable', job: this.deps.store.get(job.idempotencyKey) ?? job, receipts: [] };
      }
      throwIfAborted(signal);
      const applied = await this.deps.apply(job, result, resultHash);
      throwIfAborted(signal);
      const receipts = this.deps.store.saveApplyResult(job.idempotencyKey, toPageReceipts(applied));
      this.deps.store.complete(job.idempotencyKey, this.now());
      this.emitExtractDone(job, 'applied', { pages: receipts.length, diag: result });
      return { state: 'persisted', job: this.deps.store.get(job.idempotencyKey) ?? job, receipts };
    } catch (error) {
      const status = this.deps.store.fail(job.idempotencyKey, error, this.now());
      // memory211/08 A4-① — the failure text rides from the STORE (lastError),
      // which has already been through redactSensitiveText; the raw error may
      // carry secrets and must never reach the observability stream.
      // `?? undefined` would make "store read failed" look identical to "no
      // error" in the event — say so instead of dropping the key.
      const storeRow = this.deps.store.get(job.idempotencyKey);
      const storedError = storeRow
        ? (storeRow.lastError ?? '<no-lastError>')
        : '<store-row-missing>';
      // The extraction failure carries its HTTP status on the thrown Error
      // (hook-server attaches it) — forward it as a diagnostic number.
      const errorStatus =
        typeof (error as { status?: unknown })?.status === 'number' ? (error as { status: number }).status : undefined;
      this.emitExtractDone(job, status === 'dead_letter' ? 'failed_terminal' : 'failed_retryable', {
        error: storedError,
        ...(errorStatus != null ? { diag: { pages: [], errorStatus } } : {}),
      });
      return {
        state: status === 'dead_letter' ? 'terminal_failure' : 'retryable_failure',
        job: this.deps.store.get(job.idempotencyKey) ?? job,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * memory211/08 A4-① — one `extract.done` observability envelope per outcome
   * transition, best-effort: no emit closure, no actor identity, or a throwing
   * sink simply skips (recall_pull discipline — never fabricate an actor,
   * never block the post-turn lane). Replay paths do not emit.
   */
  private emitExtractDone(
    job: PostTurnJob,
    outcome: 'applied' | 'skipped' | 'failed_retryable' | 'failed_terminal',
    extra: { pages?: number; skipReason?: string; error?: string; diag?: PostTurnExtractionResult },
  ): void {
    const emit = this.deps.emitObservability;
    if (!emit) return;
    if (!job.agentImUserId) {
      // Same discipline as recall_pull (rpc.ts:2416-2417): never fabricate an
      // actor. But a silent skip would be indistinguishable from "nothing
      // happened" — the extraction still ran, so say why the row is missing.
      process.stderr.write(`[post-turn] extract.done skipped: empty agentImUserId job=${job.idempotencyKey}\n`);
      return;
    }
    // attemptCount AFTER the store transition (fail/terminalFailure increment;
    // complete does not) — retries get distinct keys, terminal states exactly one.
    const attempt = this.deps.store.get(job.idempotencyKey)?.attemptCount ?? 0;
    const { diag, ...rest } = extra;
    try {
      emit({
        eventId: randomUUID(),
        schemaVersion: 1,
        eventType: 'extract.done',
        workspaceId: job.workspaceId,
        actorImUserId: job.agentImUserId,
        actorKind: 'agent',
        deviceId: this.deviceId,
        createdAt: new Date().toISOString(),
        idempotencyKey: `obs:extract.done:${job.idempotencyKey}:${attempt}:${outcome}`,
        metadataJson: {
          outcome,
          pages: rest.pages ?? 0,
          ...(rest.skipReason ? { skipReason: rest.skipReason } : {}),
          // pre-redacted store lastError, capped — never the dialogue text.
          ...(rest.error ? { error: rest.error.slice(0, 220) } : {}),
          turnId: job.turnId,
          canonicalTurnId: job.canonicalTurnId,
          lane: job.lane,
          ...(job.conversationId ? { conversationId: job.conversationId } : {}),
          ...(job.payload.traceId ? { traceId: job.payload.traceId } : {}),
        },
        metricsJson: {
          outcome,
          ...(diag
            ? {
                ...(diag.gatedOut != null ? { gatedOut: diag.gatedOut } : {}),
                ...(diag.truncated != null ? { truncated: diag.truncated } : {}),
                ...(diag.latencyMs != null ? { latencyMs: diag.latencyMs } : {}),
                ...(diag.promptTokens != null ? { promptTokens: diag.promptTokens } : {}),
                ...(diag.completionTokens != null ? { completionTokens: diag.completionTokens } : {}),
                ...(diag.errorStatus != null ? { errorStatus: diag.errorStatus } : {}),
              }
            : {}),
        },
        // query / pageId deliberately absent (W7 discipline; one turn → N pages).
      });
    } catch (err) {
      // best-effort — observability must never break the post-turn lane. But
      // an empty catch would hide a systematically failing sink (panel reads
      // zero, logs read clean), so the failure itself is logged.
      process.stderr.write(
        `[post-turn] extract.done emit threw (outcome=${outcome} job=${job.idempotencyKey}): ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  private outcomeForStoredJob(job: PostTurnJob | null): PostTurnProcessOutcome {
    if (!job) return { state: 'not_found' };
    if (job.status === 'completed') {
      const receipts = job.applyResult ?? [];
      return receipts.length > 0
        ? { state: 'persisted', job, receipts }
        : { state: 'skipped_not_durable', job, receipts: [] };
    }
    if (job.status === 'dead_letter') {
      return { state: 'terminal_failure', job, error: job.lastError ?? 'post_turn_dead_letter' };
    }
    if (job.status === 'pending' && job.lastError) {
      return { state: 'retryable_failure', job, error: job.lastError };
    }
    return { state: 'processing', job };
  }

  private refreshHealth(): void {
    this.healthSnapshot = this.deps.store.health(this.now());
  }

  private maybeCompact(now: number): void {
    if (this.lastRetentionSweepAt !== null && now - this.lastRetentionSweepAt < RETENTION_SWEEP_INTERVAL_MS) {
      return;
    }
    this.deps.store.compactTerminalPayloads(now, this.retentionMs);
    this.lastRetentionSweepAt = now;
  }

  private scheduleDrain(): void {
    void this.drainOnce().catch((error) => {
      console.error('[PostTurnWorker] drain failed outside job retry boundary', error);
    });
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('post-turn processing aborted');
}

function toPageReceipts(value: unknown): PostTurnPageReceipt[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    const pageId = typeof row.pageId === 'string' ? row.pageId : '';
    const path = typeof row.path === 'string' ? row.path : '';
    const version =
      typeof row.version === 'number' ? row.version : typeof row.pageVersion === 'number' ? row.pageVersion : 0;
    const contentHash = typeof row.contentHash === 'string' ? row.contentHash : '';
    const authorityEventId = typeof row.pageOutboxId === 'string' ? row.pageOutboxId : '';
    return pageId && path && Number.isInteger(version) && version > 0 && contentHash
      ? [
          {
            pageId,
            path,
            version,
            contentHash,
            ...(authorityEventId ? { authority: 'outbox' as const, authorityEventId } : {}),
          },
        ]
      : [];
  });
}

function isExtractionResult(value: unknown): value is PostTurnExtractionResult {
  return !!value && typeof value === 'object' && Array.isArray((value as { pages?: unknown }).pages);
}
