import { createHash } from 'node:crypto';
import type { LocalDb } from '../../../../sync/store.js';
import {
  canonicalDurabilityCommitKey,
  resolveCanonicalTurnIdentity,
} from './canonical-turn-identity.js';
import { postTurnIdempotencyKey } from './post-turn-store.js';
import type {
  PostTurnInput,
  PostTurnLane,
  PostTurnPageReceipt,
  PostTurnStore,
} from './post-turn-store.js';
import type { PostTurnWorker } from './post-turn-worker.js';
import { redactSensitiveText } from './secret-redaction.js';

export type DurabilityCommitState =
  | 'pending'
  | 'writing'
  | 'persisted'
  | 'skipped_not_durable'
  | 'skipped_duplicate'
  | 'retryable_failure'
  | 'terminal_failure';

export interface DurabilityError {
  code: string;
  message: string;
}

export interface DurabilityResult {
  commitKey: string;
  postTurnKey: string;
  canonicalTurnId: string;
  conversationId?: string;
  runId?: string;
  messageId?: string;
  profileId?: string;
  profileName?: string;
  model?: string;
  provider?: string;
  targetPageKey?: string;
  normalizedContentHash?: string;
  state: Exclude<DurabilityCommitState, 'pending' | 'writing'>;
  receipts: PostTurnPageReceipt[];
  error?: DurabilityError;
  timeoutMs: number;
  replyCommittedAt: number;
  duplicateOf?: {
    state: 'persisted' | 'skipped_not_durable' | 'retryable_failure' | 'terminal_failure';
    receipts: PostTurnPageReceipt[];
    replyCommittedAt: number;
  };
}

export interface PreReplyDurabilityInput extends PostTurnInput {
  lane: PostTurnLane;
  profileId?: string;
  profileName?: string;
  model?: string;
  provider?: string;
  providerTurnId?: string;
}

export interface DurabilityCommitRecord {
  commitKey: string;
  workspaceId: string;
  agentSubject: string;
  conversationId?: string;
  runId?: string;
  messageId?: string;
  canonicalTurnId: string;
  profileId?: string;
  profileName?: string;
  model?: string;
  provider?: string;
  targetPageKey?: string;
  normalizedContentHash?: string;
  classification: 'durable' | 'not_durable' | 'invalid_context';
  state: DurabilityCommitState;
  receipts: PostTurnPageReceipt[];
  attemptCount: number;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  timeoutMs?: number;
  createdAt: number;
  updatedAt: number;
  replyCommittedAt?: number;
}

interface CommitRow {
  commit_key: string;
  workspace_id: string;
  agent_subject: string;
  conversation_id: string | null;
  run_id: string | null;
  message_id: string | null;
  canonical_turn_id: string;
  profile_id: string | null;
  profile_name: string | null;
  model: string | null;
  provider: string | null;
  target_page_key: string | null;
  normalized_content_hash: string | null;
  classification: DurabilityCommitRecord['classification'];
  state: DurabilityCommitState;
  receipts_json: string | null;
  attempt_count: number;
  last_error_code: string | null;
  last_error_message: string | null;
  timeout_ms: number | null;
  created_at: number;
  updated_at: number;
  reply_committed_at: number | null;
}

export class DurabilityCommitStore {
  constructor(private readonly db: LocalDb) {}

  /**
   * Persist an authoritative native memory_write receipt before the provider's
   * terminal hook runs. Hermes may execute tool calls and sync_turn through
   * different provider instances, so an in-process Python buffer is not a
   * sufficient exactly-once boundary. The later pre-reply barrier enriches
   * this canonical row with terminal identity and consumes the receipt instead
   * of invoking extraction again.
   */
  stageExplicitReceipt(
    input: {
      workspaceId: string;
      agentSubject: string;
      canonicalTurnId: string;
      receipt: PostTurnPageReceipt;
    },
    now = Date.now(),
  ): DurabilityCommitRecord {
    const commitKey = canonicalDurabilityCommitKey({
      workspaceId: input.workspaceId,
      agentImUserId: input.agentSubject,
      canonicalTurnId: input.canonicalTurnId,
    });
    const current = this.get(commitKey);
    if (current?.replyCommittedAt !== undefined) return current;
    const receipts = mergeReceipts(current?.receipts, [input.receipt]);
    const targetPageKey = targetPageKeyFromReceipts(receipts);
    if (current?.targetPageKey && targetPageKey && current.targetPageKey !== targetPageKey) {
      throw new DurabilityCommitConflictError(
        commitKey,
        'targetPageKey',
        current.targetPageKey,
        targetPageKey,
      );
    }
    this.db.prepare(
      `INSERT OR IGNORE INTO runtime_durability_commits (
         commit_key, workspace_id, agent_subject, canonical_turn_id,
         target_page_key, classification, state, receipts_json,
         attempt_count, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'durable', 'pending', ?, 0, ?, ?)`,
    ).run(
      commitKey,
      input.workspaceId,
      input.agentSubject,
      input.canonicalTurnId,
      targetPageKey ?? null,
      JSON.stringify(receipts),
      now,
      now,
    );
    this.db.prepare(
      `UPDATE runtime_durability_commits
          SET receipts_json = ?, target_page_key = COALESCE(target_page_key, ?),
              classification = 'durable', updated_at = ?
        WHERE commit_key = ? AND reply_committed_at IS NULL`,
    ).run(JSON.stringify(receipts), targetPageKey ?? null, now, commitKey);
    const staged = this.get(commitKey);
    if (!staged) throw new Error(`DurabilityCommitStore.stageExplicitReceipt: ${commitKey} missing`);
    return staged;
  }

  begin(
    input: {
      commitKey: string;
      workspaceId: string;
      agentSubject: string;
      conversationId?: string;
      runId?: string;
      messageId?: string;
      canonicalTurnId: string;
      profileId?: string;
      profileName?: string;
      model?: string;
      provider?: string;
      targetPageKey?: string;
      normalizedContentHash: string;
      classification: DurabilityCommitRecord['classification'];
      timeoutMs: number;
    },
    now = Date.now(),
  ): { record: DurabilityCommitRecord; inserted: boolean } {
    const changed = this.db.prepare(
      `INSERT OR IGNORE INTO runtime_durability_commits (
         commit_key, workspace_id, agent_subject, conversation_id, run_id,
         message_id, canonical_turn_id, profile_id, profile_name, model,
         provider, target_page_key, normalized_content_hash,
         classification, state, timeout_ms, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    ).run(
      input.commitKey,
      input.workspaceId,
      input.agentSubject,
      input.conversationId ?? null,
      input.runId ?? null,
      input.messageId ?? null,
      input.canonicalTurnId,
      input.profileId ?? null,
      input.profileName ?? null,
      input.model ?? null,
      input.provider ?? null,
      input.targetPageKey ?? null,
      input.normalizedContentHash,
      input.classification,
      input.timeoutMs,
      now,
      now,
    );
    let record = this.get(input.commitKey);
    if (!record) throw new Error(`DurabilityCommitStore.begin: ${input.commitKey} missing after insert`);
    if (changed.changes === 0) {
      if (canReopenRecoverableIdentityFailure(record, input)) {
        this.db.prepare(
          `UPDATE runtime_durability_commits SET
             conversation_id = ?, run_id = ?, message_id = ?,
             profile_id = ?, profile_name = ?, model = ?, provider = ?,
             target_page_key = ?, normalized_content_hash = ?,
             classification = ?, state = 'pending', receipts_json = '[]',
             last_error_code = NULL, last_error_message = NULL,
             timeout_ms = ?, reply_committed_at = NULL, updated_at = ?
           WHERE commit_key = ?`,
        ).run(
          input.conversationId ?? null,
          input.runId ?? null,
          input.messageId ?? null,
          input.profileId ?? null,
          input.profileName ?? null,
          input.model ?? null,
          input.provider ?? null,
          input.targetPageKey ?? null,
          input.normalizedContentHash,
          input.classification,
          input.timeoutMs,
          now,
          input.commitKey,
        );
        record = this.get(input.commitKey) ?? record;
        return { record, inserted: false };
      }
      if (record.normalizedContentHash && record.normalizedContentHash !== input.normalizedContentHash) {
        throw new DurabilityCommitConflictError(
          input.commitKey,
          'normalizedContentHash',
          record.normalizedContentHash,
          input.normalizedContentHash,
        );
      }
      if (record.targetPageKey && input.targetPageKey && record.targetPageKey !== input.targetPageKey) {
        throw new DurabilityCommitConflictError(
          input.commitKey,
          'targetPageKey',
          record.targetPageKey,
          input.targetPageKey,
        );
      }
      this.db.prepare(
        `UPDATE runtime_durability_commits SET
           conversation_id = COALESCE(conversation_id, ?),
           run_id = COALESCE(run_id, ?), message_id = COALESCE(message_id, ?),
           profile_id = COALESCE(profile_id, ?), profile_name = COALESCE(profile_name, ?),
           model = COALESCE(model, ?), provider = COALESCE(provider, ?),
           target_page_key = COALESCE(target_page_key, ?),
           normalized_content_hash = COALESCE(normalized_content_hash, ?),
           timeout_ms = COALESCE(timeout_ms, ?), updated_at = ?
         WHERE commit_key = ? AND reply_committed_at IS NULL`,
      ).run(
        input.conversationId ?? null,
        input.runId ?? null,
        input.messageId ?? null,
        input.profileId ?? null,
        input.profileName ?? null,
        input.model ?? null,
        input.provider ?? null,
        input.targetPageKey ?? null,
        input.normalizedContentHash,
        input.timeoutMs,
        now,
        input.commitKey,
      );
      record = this.get(input.commitKey) ?? record;
    }
    return { record, inserted: changed.changes === 1 };
  }

  get(key: string): DurabilityCommitRecord | null {
    const row = this.db.prepare(
      'SELECT * FROM runtime_durability_commits WHERE commit_key = ?',
    ).get(key) as CommitRow | undefined;
    return row ? fromRow(row) : null;
  }

  markWriting(key: string, now = Date.now()): void {
    this.db.prepare(
      `UPDATE runtime_durability_commits SET state = 'writing',
         attempt_count = attempt_count + 1, updated_at = ?
       WHERE commit_key = ? AND reply_committed_at IS NULL AND state = 'pending'`,
    ).run(now, key);
  }

  bindTargetPageKey(key: string, targetPageKey: string, now = Date.now()): DurabilityCommitRecord {
    const current = this.get(key);
    if (!current) throw new Error(`DurabilityCommitStore.bindTargetPageKey: ${key} not found`);
    if (current.targetPageKey && current.targetPageKey !== targetPageKey) {
      throw new DurabilityCommitConflictError(key, 'targetPageKey', current.targetPageKey, targetPageKey);
    }
    this.db.prepare(
      `UPDATE runtime_durability_commits
       SET target_page_key = COALESCE(target_page_key, ?), updated_at = ?
       WHERE commit_key = ? AND reply_committed_at IS NULL`,
    ).run(targetPageKey, now, key);
    return this.get(key) ?? current;
  }

  finish(
    key: string,
    input: {
      classification: DurabilityCommitRecord['classification'];
      state: DurabilityResult['state'];
      receipts?: PostTurnPageReceipt[];
      error?: DurabilityError;
    },
    now = Date.now(),
  ): DurabilityCommitRecord {
    this.db.prepare(
      `UPDATE runtime_durability_commits SET classification = ?, state = ?,
         receipts_json = ?, last_error_code = ?, last_error_message = ?, updated_at = ?
       WHERE commit_key = ? AND reply_committed_at IS NULL`,
    ).run(
      input.classification,
      input.state,
      JSON.stringify(input.receipts ?? []),
      input.error?.code ?? null,
      input.error?.message ?? null,
      now,
      key,
    );
    const record = this.get(key);
    if (!record) throw new Error(`DurabilityCommitStore.finish: ${key} not found`);
    return record;
  }

  markReplyCommitted(key: string, now = Date.now()): DurabilityCommitRecord {
    this.db.prepare(
      `UPDATE runtime_durability_commits SET reply_committed_at = COALESCE(reply_committed_at, ?), updated_at = ?
       WHERE commit_key = ?`,
    ).run(now, now, key);
    const record = this.get(key);
    if (!record) throw new Error(`DurabilityCommitStore.markReplyCommitted: ${key} not found`);
    return record;
  }
}

function canReopenRecoverableIdentityFailure(
  record: DurabilityCommitRecord,
  input: Parameters<DurabilityCommitStore['begin']>[0],
): boolean {
  if (input.classification !== 'durable') return false;
  if (record.classification !== 'invalid_context' && record.lastErrorCode !== 'memory_identity_invalid') return false;
  if (record.state !== 'terminal_failure' && record.state !== 'retryable_failure') return false;
  if (record.receipts.length > 0 || record.targetPageKey) return false;
  return Boolean(input.conversationId && input.runId && input.messageId && input.profileId && input.model && input.provider);
}

export class DurabilityCommitConflictError extends Error {
  readonly code = 'memory_idempotency_conflict';
  readonly retryable = false;

  constructor(
    readonly commitKey: string,
    readonly field: 'targetPageKey' | 'normalizedContentHash',
    readonly stored: string,
    readonly incoming: string,
  ) {
    super(`durability commit ${commitKey} reused with different ${field}`);
    this.name = 'DurabilityCommitConflictError';
  }
}

/**
 * Barrier timeout budget. The barrier must never abort an extraction that the
 * gateway call itself still considers healthy: derive the default from the
 * SAME budget family as the extraction gateway (MEMORY_EXTRACT_TIMEOUT_MS,
 * 120s default), not a separate stale 30s constant. Explicit env overrides
 * keep ops control on both knobs.
 */
export function resolveBarrierTimeoutMs(overrideMs?: number): number {
  if (overrideMs !== undefined && Number.isFinite(overrideMs) && overrideMs > 0) return overrideMs;
  const explicit = Number(process.env.PRISMER_MEMORY_BARRIER_TIMEOUT_MS);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const extractBudget = Number(process.env.MEMORY_EXTRACT_TIMEOUT_MS);
  if (Number.isFinite(extractBudget) && extractBudget > 0) return extractBudget;
  return 120_000;
}

export class PreReplyDurabilityBarrier {
  private readonly now: () => number;

  constructor(
    private readonly deps: {
      store: PostTurnStore;
      worker: PostTurnWorker;
      commits: DurabilityCommitStore;
      /**
       * Confirms that locally-applied Page receipts reached the authoritative
       * Cloud writer. A local SQLite row or pending outbox item is not a
       * durable Page receipt and must not be projected as `persisted`.
       */
      confirmAuthoritative: (input: {
        workspaceId: string;
        receipts: PostTurnPageReceipt[];
        signal: AbortSignal;
      }) => Promise<PostTurnPageReceipt[]>;
      timeoutMs?: number;
      now?: () => number;
    },
  ) {
    this.now = deps.now ?? Date.now;
  }

  async run(input: PreReplyDurabilityInput): Promise<DurabilityResult> {
    // Resolve the budget PER RUN, not per construction: the barrier is a
    // long-lived singleton in the daemon runner, and ConfigDelivery applies
    // PRISMER_MEMORY_BARRIER_TIMEOUT_MS updates to process.env while the
    // process is live (no daemon restart). A constructor-time snapshot would
    // pin the boot-time default forever.
    const timeoutMs = resolveBarrierTimeoutMs(this.deps.timeoutMs);
    const identity = resolveCanonicalTurnIdentity({
      taskId: input.canonicalTurnId ?? input.turnId,
      runId: input.runId,
      providerTurnId: input.providerTurnId ?? input.executionContext?.providerTurnId,
    });
    const normalized: PostTurnInput = {
      ...input,
      canonicalTurnId: identity.canonicalTurnId,
      ...(identity.runId ? { runId: identity.runId } : {}),
      executionContext: {
        ...input.executionContext,
        ...(input.profileId ? { profileId: input.profileId } : {}),
        ...(input.profileName ? { profileName: input.profileName } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.provider ? { provider: input.provider } : {}),
        ...(identity.providerTurnId ? { providerTurnId: identity.providerTurnId } : {}),
        ...(input.model && input.provider ? { routingEvidenceSource: 'adapter' as const } : {}),
      },
    };
    const postTurnKey = postTurnIdempotencyKey(normalized);
    const commitKey = canonicalDurabilityCommitKey({
      workspaceId: input.workspaceId,
      agentImUserId: input.agentImUserId,
      canonicalTurnId: identity.canonicalTurnId,
    });
    const missing = requiredIdentityMissing(normalized, input);
    const normalizedContentHash = hashNormalizedContent(input.assistantResponse);
    const inputTargetPageKey = targetPageKeyFromReceipts(input.explicitMemoryReceipts);
    let begun: ReturnType<DurabilityCommitStore['begin']>;
    try {
      begun = this.deps.commits.begin({
        commitKey,
        workspaceId: input.workspaceId,
        agentSubject: input.agentImUserId,
        ...(normalized.conversationId ? { conversationId: normalized.conversationId } : {}),
        ...(normalized.runId ? { runId: normalized.runId } : {}),
        ...(normalized.messageId ? { messageId: normalized.messageId } : {}),
        canonicalTurnId: identity.canonicalTurnId,
        ...(input.profileId ? { profileId: input.profileId } : {}),
        ...(input.profileName ? { profileName: input.profileName } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.provider ? { provider: input.provider } : {}),
        ...(inputTargetPageKey ? { targetPageKey: inputTargetPageKey } : {}),
        normalizedContentHash,
        classification: missing.length > 0 ? 'invalid_context' : 'durable',
        timeoutMs: timeoutMs,
      }, this.now());
    } catch (err) {
      if (!(err instanceof DurabilityCommitConflictError)) throw err;
      return {
        commitKey,
        postTurnKey,
        canonicalTurnId: identity.canonicalTurnId,
        ...(normalized.conversationId ? { conversationId: normalized.conversationId } : {}),
        ...(normalized.runId ? { runId: normalized.runId } : {}),
        ...(normalized.messageId ? { messageId: normalized.messageId } : {}),
        ...(input.profileId ? { profileId: input.profileId } : {}),
        ...(input.profileName ? { profileName: input.profileName } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.provider ? { provider: input.provider } : {}),
        ...(inputTargetPageKey ? { targetPageKey: inputTargetPageKey } : {}),
        normalizedContentHash,
        state: 'terminal_failure',
        receipts: [],
        error: { code: err.code, message: redactSensitiveText(err.message, 4 * 1024) },
        timeoutMs: timeoutMs,
        replyCommittedAt: this.now(),
      };
    }

    if (!begun.inserted && isExternallyFinal(begun.record)) {
      return projectDuplicate(begun.record, postTurnKey, timeoutMs);
    }

    const explicitMemoryReceipts = mergeReceipts(
      normalized.explicitMemoryReceipts,
      begun.record.receipts,
    );
    if (explicitMemoryReceipts.length > 0) {
      normalized.lane = 'explicit';
      normalized.explicitMemoryReceipts = explicitMemoryReceipts;
    }

    // Only the lane that owns (or joins) a non-final commit may create/enrich
    // the repair job. A replay of an already-frozen reply never mutates it.
    this.deps.store.enqueue(normalized, this.now());

    if (missing.length > 0) {
      const detail = `invalid_context:${missing.map((field) => `no_${field}`).join(',')}`;
      this.deps.store.terminalFailure(postTurnKey, detail, this.now());
      this.deps.commits.finish(commitKey, {
        classification: 'invalid_context',
        state: 'terminal_failure',
        error: { code: 'memory_identity_invalid', message: detail },
      }, this.now());
      return project(
        this.deps.commits.markReplyCommitted(commitKey, this.now()),
        postTurnKey,
        timeoutMs,
      );
    }

    this.deps.commits.markWriting(commitKey, this.now());
    const controller = new AbortController();
    let timedOut = false;
    const timeoutSentinel = Symbol('memory-barrier-timeout');
    let resolveTimeout!: (value: typeof timeoutSentinel) => void;
    const boundedTimeout = new Promise<typeof timeoutSentinel>((resolve) => {
      resolveTimeout = resolve;
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('memory_barrier_timeout'));
      resolveTimeout(timeoutSentinel);
    }, timeoutMs);
    timeout.unref?.();
    try {
      const authoritativeWork = (async () => {
        const outcome = await this.deps.worker.processKey(postTurnKey, {
          signal: controller.signal,
          ignoreSchedule: true,
        });
        if (outcome.state === 'persisted') {
          const receipts = await this.deps.confirmAuthoritative({
            workspaceId: input.workspaceId,
            receipts: outcome.receipts,
            signal: controller.signal,
          });
          return { ...outcome, receipts };
        }
        return outcome;
      })();
      const outcome = await Promise.race([
        authoritativeWork,
        boundedTimeout,
      ]);
      const error = timedOut
        ? { code: 'memory_barrier_timeout', message: `durability barrier exceeded ${timeoutMs}ms` }
        : outcome !== timeoutSentinel && 'error' in outcome
          ? {
              code: outcome.state === 'terminal_failure' ? 'memory_write_failed' : 'memory_write_retryable',
              message: redactSensitiveText(outcome.error, 4 * 1024),
            }
          : undefined;
      const state: DurabilityResult['state'] = timedOut
        ? 'retryable_failure'
        : outcome !== timeoutSentinel && (outcome.state === 'persisted' || outcome.state === 'skipped_not_durable')
          ? outcome.state
          : outcome !== timeoutSentinel && outcome.state === 'terminal_failure'
            ? 'terminal_failure'
            : 'retryable_failure';
      const receipts = outcome !== timeoutSentinel && outcome.state === 'persisted' ? outcome.receipts : [];
      const committedTargetPageKey = targetPageKeyFromReceipts(receipts);
      if (committedTargetPageKey) {
        this.deps.commits.bindTargetPageKey(commitKey, committedTargetPageKey, this.now());
      }
      this.deps.commits.finish(commitKey, {
        classification: state === 'skipped_not_durable' ? 'not_durable' : 'durable',
        state,
        receipts,
        ...(error ? { error } : {}),
      }, this.now());
      return project(
        this.deps.commits.markReplyCommitted(commitKey, this.now()),
        postTurnKey,
        timeoutMs,
      );
    } catch (err) {
      const message = redactSensitiveText(err instanceof Error ? err.message : String(err), 4 * 1024);
      const retryable = !err || typeof err !== 'object' || (err as { retryable?: unknown }).retryable !== false;
      const authorityCode = err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string'
        ? (err as { code: string }).code
        : undefined;
      this.deps.commits.finish(commitKey, {
        classification: 'durable',
        state: retryable ? 'retryable_failure' : 'terminal_failure',
        error: {
          code: authorityCode ?? (retryable ? 'memory_write_retryable' : 'memory_write_failed'),
          message,
        },
      }, this.now());
      return project(
        this.deps.commits.markReplyCommitted(commitKey, this.now()),
        postTurnKey,
        timeoutMs,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

function requiredIdentityMissing(
  input: PostTurnInput,
  context: Pick<PreReplyDurabilityInput, 'profileId' | 'model' | 'provider'>,
): string[] {
  const missing: string[] = [];
  if (!input.conversationId) missing.push('conversation_id');
  if (!input.runId) missing.push('run_id');
  if (!input.messageId) missing.push('message_id');
  if (!context.profileId) missing.push('profile_id');
  if (!context.model) missing.push('model');
  if (!context.provider) missing.push('provider');
  return missing;
}

function isExternallyFinal(record: DurabilityCommitRecord): boolean {
  return record.replyCommittedAt !== undefined && !['pending', 'writing'].includes(record.state);
}

function project(
  record: DurabilityCommitRecord,
  postTurnKey: string,
  timeoutMs: number,
): DurabilityResult {
  const state: DurabilityResult['state'] =
    record.state === 'persisted' ||
    record.state === 'skipped_not_durable' ||
    record.state === 'skipped_duplicate' ||
    record.state === 'retryable_failure' ||
    record.state === 'terminal_failure'
      ? record.state
      : 'terminal_failure';
  return {
    commitKey: record.commitKey,
    postTurnKey,
    canonicalTurnId: record.canonicalTurnId,
    ...(record.conversationId ? { conversationId: record.conversationId } : {}),
    ...(record.runId ? { runId: record.runId } : {}),
    ...(record.messageId ? { messageId: record.messageId } : {}),
    ...(record.profileId ? { profileId: record.profileId } : {}),
    ...(record.profileName ? { profileName: record.profileName } : {}),
    ...(record.model ? { model: record.model } : {}),
    ...(record.provider ? { provider: record.provider } : {}),
    ...(record.targetPageKey ? { targetPageKey: record.targetPageKey } : {}),
    ...(record.normalizedContentHash ? { normalizedContentHash: record.normalizedContentHash } : {}),
    state,
    receipts: record.receipts,
    ...(record.lastErrorCode
      ? { error: { code: record.lastErrorCode, message: record.lastErrorMessage ?? record.lastErrorCode } }
      : {}),
    timeoutMs: record.timeoutMs ?? timeoutMs,
    replyCommittedAt: record.replyCommittedAt ?? record.updatedAt,
  };
}

function projectDuplicate(
  record: DurabilityCommitRecord,
  postTurnKey: string,
  timeoutMs: number,
): DurabilityResult {
  const originalState =
    record.state === 'persisted' ||
    record.state === 'skipped_not_durable' ||
    record.state === 'retryable_failure' ||
    record.state === 'terminal_failure'
      ? record.state
      : 'terminal_failure';
  const effectiveFailure = originalState === 'retryable_failure' || originalState === 'terminal_failure';
  return {
    ...project(record, postTurnKey, timeoutMs),
    // Replaying a frozen failure must preserve the effective terminal outcome;
    // otherwise dispatch can mistake skipped_duplicate for a successful turn.
    state: effectiveFailure ? originalState : 'skipped_duplicate',
    receipts: [],
    duplicateOf: {
      state: originalState,
      receipts: record.receipts,
      replyCommittedAt: record.replyCommittedAt ?? record.updatedAt,
    },
  };
}

function fromRow(row: CommitRow): DurabilityCommitRecord {
  return {
    commitKey: row.commit_key,
    workspaceId: row.workspace_id,
    agentSubject: row.agent_subject,
    ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
    ...(row.run_id ? { runId: row.run_id } : {}),
    ...(row.message_id ? { messageId: row.message_id } : {}),
    canonicalTurnId: row.canonical_turn_id,
    ...(row.profile_id ? { profileId: row.profile_id } : {}),
    ...(row.profile_name ? { profileName: row.profile_name } : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(row.provider ? { provider: row.provider } : {}),
    ...(row.target_page_key ? { targetPageKey: row.target_page_key } : {}),
    ...(row.normalized_content_hash ? { normalizedContentHash: row.normalized_content_hash } : {}),
    classification: row.classification,
    state: row.state,
    receipts: parseReceipts(row.receipts_json),
    attemptCount: row.attempt_count,
    ...(row.last_error_code ? { lastErrorCode: row.last_error_code } : {}),
    ...(row.last_error_message ? { lastErrorMessage: row.last_error_message } : {}),
    ...(row.timeout_ms !== null ? { timeoutMs: row.timeout_ms } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.reply_committed_at !== null ? { replyCommittedAt: row.reply_committed_at } : {}),
  };
}

function hashNormalizedContent(value: string): string {
  const normalized = String(value ?? '').normalize('NFC').replace(/\r\n?/g, '\n').trim();
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

function targetPageKeyFromReceipts(receipts: PostTurnPageReceipt[] | undefined): string | undefined {
  const paths = [...new Set((receipts ?? []).map((item) => item.path.trim()).filter(Boolean))].sort();
  if (paths.length === 0) return undefined;
  if (paths.length === 1) return paths[0];
  return `multi:${createHash('sha256').update(paths.join('\n'), 'utf8').digest('hex')}`;
}

function parseReceipts(json: string | null): PostTurnPageReceipt[] {
  if (!json) return [];
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? value as PostTurnPageReceipt[] : [];
  } catch {
    return [];
  }
}

function mergeReceipts(...values: Array<PostTurnPageReceipt[] | undefined>): PostTurnPageReceipt[] {
  const seen = new Set<string>();
  return values.flatMap((value) => value ?? []).filter((receipt) => {
    const key = `${receipt.pageId}\u0000${receipt.path}\u0000${receipt.version}\u0000${receipt.contentHash}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
