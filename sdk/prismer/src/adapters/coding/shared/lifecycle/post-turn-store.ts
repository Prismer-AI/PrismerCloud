import { createHash } from 'node:crypto';
import type { LocalDb } from '../../../../sync/store.js';
import type { PostTurnExecutionContext } from './post-turn-context.js';
import { terminalRoutingEvidenceError } from './post-turn-context.js';
import { redactSensitiveText } from './secret-redaction.js';

export type { PostTurnExecutionContext } from './post-turn-context.js';

export type TerminalState = 'completed' | 'failed' | 'canceled' | 'host_crashed';
export type PostTurnJobStatus = 'pending' | 'processing' | 'completed' | 'dead_letter';
export type PostTurnLane = 'explicit' | 'pre-reply' | 'async-repair';

export interface PostTurnPageReceipt {
  pageId: string;
  path: string;
  version: number;
  contentHash: string;
  /** Internal proof source; public callers still rely on the four Page fields. */
  authority?: 'cloud' | 'outbox';
  authorityEventId?: string;
}

export interface ToolFailureSummary {
  tool: string;
  code?: string;
  summary: string;
}

export interface PostTurnInput {
  workspaceId: string;
  agentImUserId: string;
  conversationId?: string;
  runId?: string;
  messageId?: string;
  canonicalTurnId?: string;
  turnId: string;
  lane?: PostTurnLane;
  terminalState: TerminalState;
  userMessage: string;
  assistantResponse: string;
  toolFailures: ToolFailureSummary[];
  traceId?: string;
  executionContext?: PostTurnExecutionContext;
  explicitMemoryReceipts?: PostTurnPageReceipt[];
}

export interface PostTurnBodyMetadata {
  sha256: string;
  originalBytes: number;
  storedBytes: number;
  truncated: boolean;
}

export interface PostTurnPayload {
  compacted?: true;
  userMessage: string;
  assistantResponse: string;
  toolFailures: ToolFailureSummary[];
  traceId?: string;
  executionContext?: PostTurnExecutionContext;
  explicitMemoryReceipts?: PostTurnPageReceipt[];
  contentMeta: {
    userMessage: PostTurnBodyMetadata;
    assistantResponse: PostTurnBodyMetadata;
  };
}

export interface PostTurnJob {
  idempotencyKey: string;
  workspaceId: string;
  agentImUserId: string;
  conversationId?: string;
  runId?: string;
  messageId?: string;
  canonicalTurnId: string;
  turnId: string;
  lane: PostTurnLane;
  terminalState: TerminalState;
  payload: PostTurnPayload;
  result: unknown | null;
  resultHash: string | null;
  applyResult: PostTurnPageReceipt[] | null;
  extractedAt: number | null;
  status: PostTurnJobStatus;
  attemptCount: number;
  nextAttemptAt: number;
  lastError: string | null;
  createdAt: number;
  completedAt: number | null;
  payloadCompactedAt: number | null;
}

export interface PostTurnJobsHealth {
  pending: number;
  processing: number;
  deadLetter: number;
  oldestPendingAgeMs: number;
  sampledAt: number;
}

export interface PostTurnStoreOptions {
  maxAttempts?: number;
  retryBaseMs?: number;
}

const MAX_BODY_BYTES = 24 * 1024;
const MAX_FAILURES = 32;
const MAX_FAILURE_SUMMARY_BYTES = 2 * 1024;
const MAX_CONTEXT_FIELD_BYTES = 512;
const MAX_ATTACHED_ASSET_IDS = 20;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_BASE_MS = 1_000;
const TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

interface JobRow {
  idempotency_key: string;
  workspace_id: string;
  agent_im_user_id: string;
  conversation_id: string | null;
  run_id: string | null;
  message_id: string | null;
  canonical_turn_id: string | null;
  turn_id: string;
  lane: PostTurnLane;
  terminal_state: TerminalState;
  payload_json: string;
  result_json: string | null;
  result_hash: string | null;
  apply_result_json: string | null;
  extracted_at: number | null;
  status: PostTurnJobStatus;
  attempt_count: number;
  next_attempt_at: number;
  last_error: string | null;
  created_at: number;
  completed_at: number | null;
  payload_compacted_at: number | null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return value;
  return bytes
    .subarray(0, maxBytes)
    .toString('utf8')
    .replace(/\uFFFD$/u, '');
}

function sanitizeBody(value: string): { value: string; meta: PostTurnBodyMetadata } {
  const original = typeof value === 'string' ? value : String(value ?? '');
  const redacted = redactSensitiveText(original);
  const stored = truncateUtf8(redacted, MAX_BODY_BYTES);
  return {
    value: stored,
    meta: {
      sha256: sha256(original),
      originalBytes: Buffer.byteLength(original, 'utf8'),
      storedBytes: Buffer.byteLength(stored, 'utf8'),
      truncated: stored !== redacted,
    },
  };
}

function sanitizeExecutionContext(input: PostTurnExecutionContext | undefined): PostTurnExecutionContext | undefined {
  if (!input) return undefined;
  const clean = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const trimmed = redactSensitiveText(value.trim(), MAX_CONTEXT_FIELD_BYTES);
    return trimmed || undefined;
  };
  const attachedAssetIds = [
    ...new Set(
      (Array.isArray(input.attachedAssetIds) ? input.attachedAssetIds : [])
        .map(clean)
        .filter((value): value is string => !!value),
    ),
  ].slice(0, MAX_ATTACHED_ASSET_IDS);
  const adapterName = clean(input.adapterName);
  const roleSlug = clean(input.roleSlug);
  const trustedRouting = input.routingEvidenceSource === 'adapter';
  const model = trustedRouting ? clean(input.model) : undefined;
  const provider = trustedRouting ? clean(input.provider) : undefined;
  const profileId = clean(input.profileId);
  const profileName = clean(input.profileName);
  const proxyProvider = clean(input.proxyProvider);
  const providerTurnId = clean(input.providerTurnId);
  const context: PostTurnExecutionContext = {
    ...(adapterName ? { adapterName } : {}),
    ...(profileId ? { profileId } : {}),
    ...(profileName ? { profileName } : {}),
    ...(roleSlug ? { roleSlug } : {}),
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    ...(proxyProvider ? { proxyProvider } : {}),
    ...(providerTurnId ? { providerTurnId } : {}),
    ...(attachedAssetIds.length > 0 ? { attachedAssetIds } : {}),
    ...(trustedRouting ? { routingEvidenceSource: 'adapter' as const } : {}),
  };
  return Object.keys(context).length > 0 ? context : undefined;
}

function sanitizePayload(input: PostTurnInput): PostTurnPayload {
  const user = sanitizeBody(input.userMessage);
  const assistant = sanitizeBody(input.assistantResponse);
  const toolFailures = input.toolFailures.slice(0, MAX_FAILURES).map((failure) => ({
    tool: redactSensitiveText(String(failure.tool ?? 'unknown'), 256),
    ...(failure.code ? { code: redactSensitiveText(String(failure.code), 256) } : {}),
    summary: redactSensitiveText(String(failure.summary ?? ''), MAX_FAILURE_SUMMARY_BYTES),
  }));
  const executionContext = sanitizeExecutionContext(input.executionContext);
  const explicitMemoryReceipts = sanitizePageReceipts(input.explicitMemoryReceipts);
  return {
    userMessage: user.value,
    assistantResponse: assistant.value,
    toolFailures,
    ...(input.traceId ? { traceId: redactSensitiveText(input.traceId, 512) } : {}),
    ...(executionContext ? { executionContext } : {}),
    ...(explicitMemoryReceipts.length > 0 ? { explicitMemoryReceipts } : {}),
    contentMeta: { userMessage: user.meta, assistantResponse: assistant.meta },
  };
}

/** JSON with recursively sorted object keys, used as the extraction result ledger. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function postTurnIdempotencyKey(
  input: Pick<PostTurnInput, 'workspaceId' | 'agentImUserId' | 'conversationId' | 'turnId' | 'canonicalTurnId'>,
): string {
  // conversationId is intentionally excluded: it is optional at the provider
  // boundary and may be resolved later by a hook. A nullable enrichment field
  // must never split one turn into two jobs (and therefore two memory writes).
  return `post-turn:${input.workspaceId}:${input.agentImUserId}:${input.canonicalTurnId ?? input.turnId}`;
}

export class PostTurnStore {
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;

  constructor(
    private readonly db: LocalDb,
    opts: PostTurnStoreOptions = {},
  ) {
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.retryBaseMs = opts.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  }

  enqueue(input: PostTurnInput, now = Date.now()): { key: string; inserted: boolean } {
    const key = postTurnIdempotencyKey(input);
    const canonicalTurnId = input.canonicalTurnId ?? input.turnId;
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO post_turn_jobs (
           idempotency_key, workspace_id, agent_im_user_id, conversation_id,
           run_id, message_id, canonical_turn_id, turn_id, lane,
           terminal_state, payload_json, next_attempt_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        key,
        input.workspaceId,
        input.agentImUserId,
        input.conversationId ?? null,
        input.runId ?? null,
        input.messageId ?? null,
        canonicalTurnId,
        input.turnId,
        input.lane ?? 'async-repair',
        input.terminalState,
        JSON.stringify(sanitizePayload(input)),
        now,
        now,
      );
    if (info.changes === 0) {
      // A provider hook can arrive first with only api_* provenance. The
      // dispatch barrier enriches the same canonical row with cloud identity;
      // never fork a second job merely because optional context arrived later.
      const existing = this.get(key);
      const incoming = sanitizePayload(input);
      assertCompatibleRoutingEvidence(existing?.payload.executionContext, incoming.executionContext);
      const replaceRecoverablePayload = shouldReplaceRecoverablePayload(existing, incoming);
      const explicitReceipts = mergePageReceipts(
        replaceRecoverablePayload ? undefined : existing?.payload.explicitMemoryReceipts,
        incoming.explicitMemoryReceipts,
      );
      const executionContext = {
        ...(replaceRecoverablePayload ? {} : (existing?.payload.executionContext ?? {})),
        ...(incoming.executionContext ?? {}),
      };
      const mergedPayload: PostTurnPayload = existing
        ? {
            ...(replaceRecoverablePayload ? incoming : existing.payload),
            ...(Object.keys(executionContext).length > 0 ? { executionContext } : {}),
            ...(explicitReceipts.length > 0 ? { explicitMemoryReceipts: explicitReceipts } : {}),
          }
        : incoming;
      const reopenRecoverableDeadLetter =
        existing?.status === 'dead_letter' &&
        isRecoverableIdentityOrRoutingFailure(existing.lastError) &&
        terminalRoutingEvidenceError(mergedPayload.executionContext) === null &&
        existing.resultHash === null &&
        existing.applyResult === null &&
        existing.payloadCompactedAt === null;
      this.db
        .prepare(
          `UPDATE post_turn_jobs SET
           conversation_id = COALESCE(conversation_id, ?),
           run_id = COALESCE(run_id, ?),
           message_id = COALESCE(message_id, ?),
           canonical_turn_id = COALESCE(canonical_turn_id, ?),
           lane = CASE WHEN ? = 'explicit' THEN 'explicit' ELSE lane END,
           terminal_state = CASE WHEN ? = 1 THEN ? ELSE terminal_state END,
           payload_json = ?
         WHERE idempotency_key = ?`,
        )
        .run(
          input.conversationId ?? null,
          input.runId ?? null,
          input.messageId ?? null,
          canonicalTurnId,
          input.lane ?? 'async-repair',
          replaceRecoverablePayload ? 1 : 0,
          input.terminalState,
          JSON.stringify(mergedPayload),
          key,
        );
      if (reopenRecoverableDeadLetter) {
        this.db
          .prepare(
            `UPDATE post_turn_jobs SET status = 'pending', next_attempt_at = ?,
             last_error = NULL, completed_at = NULL
           WHERE idempotency_key = ? AND status = 'dead_letter'`,
          )
          .run(now, key);
      }
    }
    return { key, inserted: info.changes === 1 };
  }

  get(key: string): PostTurnJob | null {
    const row = this.db.prepare('SELECT * FROM post_turn_jobs WHERE idempotency_key = ?').get(key) as
      | JobRow
      | undefined;
    return row ? this.fromRow(row) : null;
  }

  list(): PostTurnJob[] {
    return (this.db.prepare('SELECT * FROM post_turn_jobs ORDER BY created_at, idempotency_key').all() as JobRow[]).map(
      (row) => this.fromRow(row),
    );
  }

  claimNext(now = Date.now()): PostTurnJob | null {
    const claim = this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT idempotency_key FROM post_turn_jobs
           WHERE status = 'pending' AND next_attempt_at <= ?
           ORDER BY created_at, idempotency_key LIMIT 1`,
        )
        .get(now) as { idempotency_key: string } | undefined;
      if (!row) return null;
      const changed = this.db
        .prepare(
          `UPDATE post_turn_jobs SET status = 'processing'
           WHERE idempotency_key = ? AND status = 'pending'`,
        )
        .run(row.idempotency_key);
      return changed.changes === 1 ? row.idempotency_key : null;
    });
    const key = claim();
    return key ? this.get(key) : null;
  }

  claimByKey(key: string, now = Date.now(), ignoreSchedule = false): PostTurnJob | null {
    const claim = this.db.transaction(() => {
      const changed = this.db
        .prepare(
          `UPDATE post_turn_jobs SET status = 'processing'
         WHERE idempotency_key = ? AND status = 'pending'
           AND (? = 1 OR next_attempt_at <= ?)`,
        )
        .run(key, ignoreSchedule ? 1 : 0, now);
      return changed.changes === 1;
    });
    return claim() ? this.get(key) : null;
  }

  recoverProcessing(now = Date.now()): number {
    return this.db
      .prepare(
        `UPDATE post_turn_jobs SET status = 'pending', next_attempt_at = ?,
           last_error = COALESCE(last_error, 'recovered_after_runtime_restart')
         WHERE status = 'processing'`,
      )
      .run(now).changes;
  }

  /**
   * A gateway/model outage may exhaust the bounded live retry budget and land
   * in dead-letter while preserving the untouched extraction payload. A
   * supervised Runtime restart is the explicit recovery boundary: reopen only
   * those pre-extraction gateway failures, keep their canonical key and prior
   * attempt count, then let the normal worker replay the same job once.
   *
   * Parse/apply/identity dead-letters are intentionally excluded: replaying
   * them without repaired input could fork or corrupt an authoritative Page.
   */
  recoverGatewayDeadLetters(now = Date.now()): number {
    return this.db
      .prepare(
        `UPDATE post_turn_jobs SET status = 'pending', next_attempt_at = ?, completed_at = NULL
         WHERE status = 'dead_letter'
           AND result_json IS NULL
           AND apply_result_json IS NULL
           AND payload_compacted_at IS NULL
           AND NULLIF(TRIM(conversation_id), '') IS NOT NULL
           AND NULLIF(TRIM(canonical_turn_id), '') IS NOT NULL
           AND json_extract(payload_json, '$.executionContext.routingEvidenceSource') = 'adapter'
           AND NULLIF(TRIM(json_extract(payload_json, '$.executionContext.model')), '') IS NOT NULL
           AND NULLIF(TRIM(json_extract(payload_json, '$.executionContext.provider')), '') IS NOT NULL
           AND last_error LIKE 'gateway /api/v1/messages failed%'`,
      )
      .run(now).changes;
  }

  saveExtractionResult(key: string, result: unknown, now = Date.now()): { result: unknown; hash: string } {
    const json = canonicalJson(result);
    const hash = sha256(json);
    this.db
      .prepare(
        `UPDATE post_turn_jobs SET result_json = ?, result_hash = ?, extracted_at = ?
         WHERE idempotency_key = ? AND result_json IS NULL`,
      )
      .run(json, hash, now, key);
    const row = this.get(key);
    if (!row?.resultHash || row.result === null) {
      throw new Error(`PostTurnStore.saveExtractionResult: job ${key} not found`);
    }
    return { result: row.result, hash: row.resultHash };
  }

  saveApplyResult(key: string, receipts: PostTurnPageReceipt[]): PostTurnPageReceipt[] {
    const sanitized = sanitizePageReceipts(receipts);
    this.db
      .prepare(
        `UPDATE post_turn_jobs SET apply_result_json = ?
       WHERE idempotency_key = ? AND apply_result_json IS NULL`,
      )
      .run(canonicalJson(sanitized), key);
    return this.get(key)?.applyResult ?? [];
  }

  complete(key: string, now = Date.now(), reason?: string): void {
    this.db
      .prepare(
        `UPDATE post_turn_jobs SET status = 'completed', completed_at = ?,
           last_error = COALESCE(?, last_error)
         WHERE idempotency_key = ?`,
      )
      .run(now, reason ?? null, key);
  }

  fail(key: string, error: unknown, now = Date.now()): PostTurnJobStatus {
    const row = this.get(key);
    if (!row) throw new Error(`PostTurnStore.fail: job ${key} not found`);
    const attempts = row.attemptCount + 1;
    const dead = attempts >= this.maxAttempts;
    const delay = this.retryBaseMs * 2 ** Math.max(0, attempts - 1);
    this.db
      .prepare(
        `UPDATE post_turn_jobs SET status = ?, attempt_count = ?, next_attempt_at = ?,
           last_error = ?, completed_at = ? WHERE idempotency_key = ?`,
      )
      .run(
        dead ? 'dead_letter' : 'pending',
        attempts,
        dead ? now : now + delay,
        redactSensitiveText(error instanceof Error ? error.message : String(error), 4 * 1024),
        dead ? now : null,
        key,
      );
    return dead ? 'dead_letter' : 'pending';
  }

  terminalFailure(key: string, error: unknown, now = Date.now()): void {
    this.db
      .prepare(
        `UPDATE post_turn_jobs SET status = 'dead_letter', attempt_count = attempt_count + 1,
         apply_result_json = NULL, last_error = ?, completed_at = ? WHERE idempotency_key = ?`,
      )
      .run(redactSensitiveText(error instanceof Error ? error.message : String(error), 4 * 1024), now, key);
  }

  health(now = Date.now()): PostTurnJobsHealth {
    const counts = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
           SUM(CASE WHEN status = 'dead_letter' THEN 1 ELSE 0 END) AS deadLetter,
           MIN(CASE WHEN status = 'pending' THEN created_at END) AS oldestPending
         FROM post_turn_jobs`,
      )
      .get() as {
      pending: number | null;
      processing: number | null;
      deadLetter: number | null;
      oldestPending: number | null;
    };
    return {
      pending: counts.pending ?? 0,
      processing: counts.processing ?? 0,
      deadLetter: counts.deadLetter ?? 0,
      oldestPendingAgeMs: counts.oldestPending === null ? 0 : Math.max(0, now - counts.oldestPending),
      sampledAt: now,
    };
  }

  compactTerminalPayloads(now = Date.now(), retentionMs = TERMINAL_RETENTION_MS): number {
    const cutoff = now - retentionMs;
    const rows = this.db
      .prepare(
        `SELECT idempotency_key, payload_json, result_hash FROM post_turn_jobs
         WHERE status IN ('completed', 'dead_letter')
           AND COALESCE(completed_at, created_at) <= ?
           AND payload_compacted_at IS NULL`,
      )
      .all(cutoff) as Array<{ idempotency_key: string; payload_json: string; result_hash: string | null }>;
    const update = this.db.prepare(
      `UPDATE post_turn_jobs SET payload_json = ?, result_json = ?, payload_compacted_at = ?
       WHERE idempotency_key = ? AND payload_compacted_at IS NULL`,
    );
    const compact = this.db.transaction(() => {
      let changed = 0;
      for (const row of rows) {
        const payload = JSON.parse(row.payload_json) as PostTurnPayload;
        const payloadTombstone = {
          compacted: true,
          userMessage: '',
          assistantResponse: '',
          toolFailures: [],
          contentMeta: payload.contentMeta,
          toolFailureCount: payload.toolFailures.length,
          traceId: payload.traceId,
        };
        const resultTombstone = row.result_hash ? { compacted: true, resultHash: row.result_hash } : null;
        changed += update.run(
          JSON.stringify(payloadTombstone),
          resultTombstone ? JSON.stringify(resultTombstone) : null,
          now,
          row.idempotency_key,
        ).changes;
      }
      return changed;
    });
    return compact();
  }

  private fromRow(row: JobRow): PostTurnJob {
    return {
      idempotencyKey: row.idempotency_key,
      workspaceId: row.workspace_id,
      agentImUserId: row.agent_im_user_id,
      ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
      ...(row.run_id ? { runId: row.run_id } : {}),
      ...(row.message_id ? { messageId: row.message_id } : {}),
      canonicalTurnId: row.canonical_turn_id ?? row.turn_id,
      turnId: row.turn_id,
      lane: row.lane ?? 'async-repair',
      terminalState: row.terminal_state,
      payload: JSON.parse(row.payload_json) as PostTurnPayload,
      result: row.result_json ? JSON.parse(row.result_json) : null,
      resultHash: row.result_hash,
      applyResult: row.apply_result_json ? sanitizePageReceipts(JSON.parse(row.apply_result_json) as unknown) : null,
      extractedAt: row.extracted_at,
      status: row.status,
      attemptCount: row.attempt_count,
      nextAttemptAt: row.next_attempt_at,
      lastError: row.last_error,
      createdAt: row.created_at,
      completedAt: row.completed_at,
      payloadCompactedAt: row.payload_compacted_at,
    };
  }
}

export class PostTurnRoutingEvidenceConflictError extends Error {
  readonly code = 'post_turn_routing_evidence_conflict';

  constructor(
    readonly field: 'model' | 'provider',
    stored: string,
    incoming: string,
  ) {
    super(`post-turn routing evidence conflict for ${field}: stored=${stored} incoming=${incoming}`);
    this.name = 'PostTurnRoutingEvidenceConflictError';
  }
}

function assertCompatibleRoutingEvidence(
  existing: PostTurnExecutionContext | undefined,
  incoming: PostTurnExecutionContext | undefined,
): void {
  if (existing?.routingEvidenceSource !== 'adapter' || incoming?.routingEvidenceSource !== 'adapter') return;
  for (const field of ['model', 'provider'] as const) {
    const stored = existing[field]?.trim();
    const next = incoming[field]?.trim();
    if (stored && next && stored !== next) {
      throw new PostTurnRoutingEvidenceConflictError(field, stored, next);
    }
  }
}

function isRoutingEvidenceFailure(value: string | null): boolean {
  return (
    value === 'non_extractable:untrusted_routing_evidence' ||
    value === 'non_extractable:no_execution_model' ||
    value === 'non_extractable:no_terminal_provider'
  );
}

function isRecoverableIdentityOrRoutingFailure(value: string | null): boolean {
  return isRoutingEvidenceFailure(value) || Boolean(value?.startsWith('invalid_context:no_'));
}

function shouldReplaceRecoverablePayload(
  existing: PostTurnJob | null | undefined,
  incoming: PostTurnPayload,
): boolean {
  return Boolean(
    existing?.status === 'dead_letter' &&
      isRecoverableIdentityOrRoutingFailure(existing.lastError) &&
      terminalRoutingEvidenceError(incoming.executionContext) === null &&
      existing.resultHash === null &&
      existing.applyResult === null &&
      existing.payloadCompactedAt === null,
  );
}

function sanitizePageReceipts(value: unknown): PostTurnPageReceipt[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    const pageId = typeof row.pageId === 'string' ? row.pageId.trim() : '';
    const path = typeof row.path === 'string' ? row.path.trim() : '';
    const version =
      typeof row.version === 'number' ? row.version : typeof row.pageVersion === 'number' ? row.pageVersion : 0;
    const contentHash = typeof row.contentHash === 'string' ? row.contentHash.trim() : '';
    if (!pageId || !path || !Number.isInteger(version) || version < 1 || !contentHash) return [];
    const authority = row.authority === 'cloud' || row.authority === 'outbox' ? row.authority : undefined;
    const authorityEventId =
      typeof row.authorityEventId === 'string' && row.authorityEventId.trim() ? row.authorityEventId.trim() : undefined;
    return [
      {
        pageId,
        path,
        version,
        contentHash,
        ...(authority ? { authority } : {}),
        ...(authorityEventId ? { authorityEventId } : {}),
      },
    ];
  });
}

function mergePageReceipts(...values: unknown[]): PostTurnPageReceipt[] {
  const seen = new Set<string>();
  return values
    .flatMap((value) => sanitizePageReceipts(value))
    .filter((receipt) => {
      const key = `${receipt.pageId}\u0000${receipt.path}\u0000${receipt.version}\u0000${receipt.contentHash}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
