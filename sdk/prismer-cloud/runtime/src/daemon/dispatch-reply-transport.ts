// Wave-4 E7 — daemon-side dispatch reply transport using the two-phase
// prepare → commit protocol (spec: §4.3; server: src/im/api/dispatch.ts).
//
// Replaces the legacy single-shot `POST /api/im/dispatch/reply` call in
// Runner.postMessageDispatchReply. The legacy endpoint stays alive on the
// server until Sunset 2026-09-01 (RFC 8594), but new daemon installs (this
// module) speak the new protocol exclusively. The legacy fallback path is
// retained inside this module for environments where the server is older
// than the prepare/commit endpoints — controlled via `useLegacyFallback`.
//
// Flow:
//
//   sendDispatchReplyTwoPhase({ taskId, payload, cloud, cache, ... })
//     ├─ generate idempotencyKey (UUID v4) if not supplied
//     ├─ cache.savePending(key, taskId, payload) — BEFORE network call
//     ├─ POST /api/im/dispatch/:taskId/prepare
//     │    ├─ 200 + status='prepared'  → cache.markPrepared(replyId)
//     │    ├─ 200 + status='committed' → server idempotent re-prepare; clear
//     │    └─ 4xx/5xx               → cache.markAttempt(err); throw
//     ├─ POST /api/im/dispatch/:taskId/commit
//     │    ├─ 200 (alreadyCommitted=true|false) → cache.clearPending(key)
//     │    └─ 4xx/5xx → throw (row remains in cache for recovery)
//     └─ return { taskId, replyId, status, messageId }
//
// On daemon cold-start, `recoverPendingReplies(...)` enumerates rows still
// in cache and resumes them:
//   - status='pending'  → re-POST prepare (idempotent on (taskId, key))
//   - status='prepared' → POST commit with the persisted replyId
//                          (idempotent on replyId)
//
// W3 server contract: commit on a row already aborted (>1h reaper) returns
// 400 DISPATCH_REPLY_INVALID_STATE. We surface that as "dispatch lost" so the
// caller can escalate to the user / drop the entry.

import type { CloudClient } from '../auth.js';
import type {
  PendingReplyCache,
  PendingReplyRow,
} from './pending-reply-cache.js';
import { generateIdempotencyKey } from './pending-reply-cache.js';

/** Shape of the body the server's `prepare` endpoint expects. */
export interface DispatchReplyPreparePayload {
  /** Conversation containing the @-mention message we're replying to. */
  conversationId: string;
  /** Wave-9: server-issued signed token tying daemon to the reply slot. */
  replyToken: string;
  /** Message we're replying to (carries the @mention). */
  replyToMessageId: string;
  agentImUserId: string;
  status: 'ok' | 'agent_offline' | 'timeout' | 'agent_error';
  /** Required when status='ok' (or rely on attachments/assetIds). */
  replyText?: string;
  /** Asset IDs the daemon already uploaded; server gates commit on ready-state. */
  assetIds?: string[];
  attachments?: Array<{ kind: 'file' | 'image'; assetId: string }>;
  /** Optional ContentBlock[] for rich multimodal replies — surfaced as messageContent.contentBlocks. */
  messageContent?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
  /** ISO8601. Server requires non-empty. */
  completedAt: string;
  /** Required when status!='ok'. */
  error?: { code: string; message: string };
}

export interface DispatchReplyTransportDeps {
  cloud: CloudClient;
  cache: PendingReplyCache;
  /**
   * Logger hook — used for prepare/commit success + recovery summaries.
   * Defaults to writing to process.stderr.
   */
  log?: (line: string) => void;
}

export interface SendDispatchReplyArgs extends DispatchReplyTransportDeps {
  taskId: string;
  payload: DispatchReplyPreparePayload;
  /** Override the auto-generated UUID — only used on recovery replay. */
  idempotencyKey?: string;
}

export interface SendDispatchReplyResult {
  taskId: string;
  replyId: string;
  /** 'committed' = full success; 'aborted' = server-side reaper killed it. */
  status: 'committed' | 'aborted';
  /** Message id created by commit, if returned by the server. */
  messageId?: string;
  /** True when commit hit `alreadyCommitted` (idempotent replay). */
  alreadyCommitted: boolean;
}

class DispatchReplyAbortedError extends Error {
  readonly code = 'DISPATCH_REPLY_INVALID_STATE';
  constructor(public readonly replyId: string) {
    super(`dispatch reply ${replyId} aborted by server reaper (likely >1h since prepare)`);
    this.name = 'DispatchReplyAbortedError';
  }
}

function defaultLog(line: string): void {
  process.stderr.write(`${line}\n`);
}

/**
 * Run the two-phase reply protocol end-to-end. Persists the reply id in the
 * local cache between prepare and commit so a crash in the middle is
 * recoverable on cold-start.
 */
export async function sendDispatchReplyTwoPhase(
  args: SendDispatchReplyArgs,
): Promise<SendDispatchReplyResult> {
  const { taskId, payload, cloud, cache } = args;
  const log = args.log ?? defaultLog;
  const idempotencyKey = args.idempotencyKey ?? generateIdempotencyKey();
  const payloadJson = JSON.stringify({ ...payload, _taskId: taskId, _idempotencyKey: idempotencyKey });

  // Persist BEFORE the network call so a process crash here is recoverable.
  cache.savePending(idempotencyKey, taskId, payloadJson);

  // ── 1. PREPARE ────────────────────────────────────────────────────────
  const prepareRes = await cloud.request<{
    ok: boolean;
    data?: { replyId: string; status: 'prepared' | 'committed'; existed: boolean };
    error?: { code: string; message: string };
  }>('POST', `/api/im/dispatch/${encodeURIComponent(taskId)}/prepare`, {
    body: { ...payload, idempotencyKey },
    timeoutMs: 30_000,
  });

  if (!prepareRes.ok || !prepareRes.data) {
    const errCode = prepareRes.error?.code ?? 'unknown';
    const errMsg = prepareRes.error?.message ?? `prepare failed (status=${prepareRes.status})`;
    cache.markAttempt(idempotencyKey, Date.now(), `prepare: ${errCode}: ${errMsg}`);
    throw new Error(`dispatch prepare failed: ${errCode}: ${errMsg}`);
  }

  // Server envelope: response body may be wrapped in `{ ok, data }` or be the
  // raw data depending on Hono c.json. CloudClient.request unwraps the http
  // status but not the envelope, so we handle both shapes here.
  const envelope = prepareRes.data as unknown as
    | { ok: boolean; data?: { replyId: string; status: 'prepared' | 'committed'; existed: boolean }; error?: { code: string; message: string } }
    | { replyId: string; status: 'prepared' | 'committed'; existed: boolean };
  const inner =
    'data' in envelope && envelope.data
      ? envelope.data
      : (envelope as { replyId: string; status: 'prepared' | 'committed'; existed: boolean });
  if (!inner || typeof inner.replyId !== 'string') {
    cache.markAttempt(idempotencyKey, Date.now(), 'prepare: missing replyId in response');
    throw new Error('dispatch prepare returned no replyId');
  }
  if ('ok' in envelope && envelope.ok === false) {
    const errCode = envelope.error?.code ?? 'prepare_failed';
    const errMsg = envelope.error?.message ?? 'prepare ok=false';
    cache.markAttempt(idempotencyKey, Date.now(), `prepare: ${errCode}: ${errMsg}`);
    throw new Error(`dispatch prepare failed: ${errCode}: ${errMsg}`);
  }

  cache.markPrepared(idempotencyKey, inner.replyId);
  log(
    `[daemon] dispatch.prepare task=${taskId} replyId=${inner.replyId} status=${inner.status} idem=${idempotencyKey}`,
  );

  // Idempotent re-prepare: server already committed this row on a previous
  // attempt → nothing left to do, drop the local row.
  if (inner.status === 'committed') {
    cache.clearPending(idempotencyKey);
    return {
      taskId,
      replyId: inner.replyId,
      status: 'committed',
      alreadyCommitted: true,
    };
  }

  // ── 2. COMMIT ─────────────────────────────────────────────────────────
  try {
    const result = await commitDispatchReply({ taskId, replyId: inner.replyId, cloud, log });
    cache.clearPending(idempotencyKey);
    return { taskId, replyId: inner.replyId, ...result };
  } catch (err) {
    if (err instanceof DispatchReplyAbortedError) {
      // Server killed it — drop the entry, surface "lost" to caller.
      cache.clearPending(idempotencyKey);
      log(`[daemon] dispatch.commit aborted task=${taskId} replyId=${inner.replyId} — dispatch lost`);
      return {
        taskId,
        replyId: inner.replyId,
        status: 'aborted',
        alreadyCommitted: false,
      };
    }
    cache.markAttempt(idempotencyKey, Date.now(), `commit: ${(err as Error).message}`);
    throw err;
  }
}

interface CommitArgs {
  taskId: string;
  replyId: string;
  cloud: CloudClient;
  log?: (line: string) => void;
}

async function commitDispatchReply(args: CommitArgs): Promise<{
  status: 'committed';
  messageId?: string;
  alreadyCommitted: boolean;
}> {
  const log = args.log ?? defaultLog;
  const res = await args.cloud.request<{
    ok: boolean;
    data?: { taskId: string; replyId: string; alreadyCommitted: boolean; messageId?: string };
    error?: { code: string; message: string };
  }>('POST', `/api/im/dispatch/${encodeURIComponent(args.taskId)}/commit`, {
    body: { replyId: args.replyId },
    timeoutMs: 30_000,
  });

  if (!res.ok || !res.data) {
    const code = res.error?.code ?? 'unknown';
    const msg = res.error?.message ?? `commit failed (status=${res.status})`;
    if (code === 'DISPATCH_REPLY_INVALID_STATE') {
      throw new DispatchReplyAbortedError(args.replyId);
    }
    throw new Error(`dispatch commit failed: ${code}: ${msg}`);
  }
  const env = res.data as unknown as
    | { ok: boolean; data?: { taskId: string; replyId: string; alreadyCommitted: boolean; messageId?: string }; error?: { code: string; message: string } }
    | { taskId: string; replyId: string; alreadyCommitted: boolean; messageId?: string };
  const inner = 'data' in env && env.data ? env.data : (env as { alreadyCommitted: boolean; messageId?: string });
  if ('ok' in env && env.ok === false) {
    const code = env.error?.code ?? 'commit_failed';
    if (code === 'DISPATCH_REPLY_INVALID_STATE') {
      throw new DispatchReplyAbortedError(args.replyId);
    }
    throw new Error(`dispatch commit failed: ${code}: ${env.error?.message ?? 'commit ok=false'}`);
  }
  log(
    `[daemon] dispatch.commit task=${args.taskId} replyId=${args.replyId} alreadyCommitted=${inner.alreadyCommitted ?? false}`,
  );
  return {
    status: 'committed',
    alreadyCommitted: Boolean(inner.alreadyCommitted),
    ...(inner.messageId ? { messageId: inner.messageId } : {}),
  };
}

/**
 * Daemon cold-start hook — replay any rows the cache still holds.
 *
 * Called once after WS is connected (signal: cloud is reachable). Returns a
 * summary so the runner can log/observe the recovery pass.
 */
export async function recoverPendingReplies(deps: DispatchReplyTransportDeps): Promise<{
  attempted: number;
  committed: number;
  aborted: number;
  failed: number;
}> {
  const log = deps.log ?? defaultLog;
  const rows = deps.cache.listForRecovery();
  if (rows.length === 0) {
    return { attempted: 0, committed: 0, aborted: 0, failed: 0 };
  }
  log(`[daemon] dispatch.recovery: ${rows.length} pending row(s) to replay`);

  let committed = 0;
  let aborted = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const result = await replayRow(row, deps);
      if (result.status === 'committed') committed += 1;
      else if (result.status === 'aborted') aborted += 1;
    } catch (err) {
      failed += 1;
      log(
        `[daemon] dispatch.recovery FAIL idem=${row.idempotencyKey} task=${row.taskId}: ${(err as Error).message}`,
      );
    }
  }
  log(
    `[daemon] dispatch.recovery done attempted=${rows.length} committed=${committed} aborted=${aborted} failed=${failed}`,
  );
  return { attempted: rows.length, committed, aborted, failed };
}

async function replayRow(
  row: PendingReplyRow,
  deps: DispatchReplyTransportDeps,
): Promise<{ status: 'committed' | 'aborted' }> {
  const log = deps.log ?? defaultLog;

  if (row.status === 'prepared' && row.replyId) {
    // Server already wrote the prepared row; just commit.
    try {
      const result = await commitDispatchReply({
        taskId: row.taskId,
        replyId: row.replyId,
        cloud: deps.cloud,
        log,
      });
      deps.cache.clearPending(row.idempotencyKey);
      return { status: result.status };
    } catch (err) {
      if (err instanceof DispatchReplyAbortedError) {
        deps.cache.clearPending(row.idempotencyKey);
        return { status: 'aborted' };
      }
      throw err;
    }
  }

  // status='pending' — re-run prepare (idempotent on (taskId, key) per W3)
  // then commit. We reconstruct the payload from the cached JSON.
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(row.payloadJson) as Record<string, unknown>;
  } catch (err) {
    deps.cache.clearPending(row.idempotencyKey);
    throw new Error(`pending row ${row.idempotencyKey} has unparseable payload: ${(err as Error).message}`);
  }
  // Drop the internal cache markers before re-sending.
  const { _taskId, _idempotencyKey, ...payload } = parsed as {
    _taskId?: string;
    _idempotencyKey?: string;
    [k: string]: unknown;
  };
  const result = await sendDispatchReplyTwoPhase({
    taskId: row.taskId,
    payload: payload as unknown as DispatchReplyPreparePayload,
    cloud: deps.cloud,
    cache: deps.cache,
    idempotencyKey: row.idempotencyKey,
    log: deps.log,
  });
  return { status: result.status };
}

export { DispatchReplyAbortedError };
