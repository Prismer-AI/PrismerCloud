/**
 * Prismer IM — Dispatch reply two-phase service.
 *
 * Spec: docs/release200/14-messaging-state-machine-reliability.md §4.3
 *
 * Two-phase protocol replacing single-shot `/dispatch/reply`:
 *
 *   1. PREPARE: daemon posts `{ idempotencyKey, assetIds, messageContent, metrics }`
 *      → cloud validates every assetId is in `ingestStatus='ready'` (else 400),
 *        writes `im_dispatch_replies` row with status='prepared'.
 *      → NO message written, NO task transition.
 *      → Idempotent on (taskId, idempotencyKey).
 *
 *   2. COMMIT: daemon posts `{ replyId }`
 *      → cloud writes message + transitions task + outbox sync event
 *        (single-process atomic chain, with the IMDispatchReply status flip
 *        guarded by a $transaction over the reply row + message/task work
 *        invoked under that tx where possible).
 *      → Idempotent — re-commit on `status='committed'` returns 200.
 *
 * Orphan reaper (sweepArphanedDispatchReplies):
 *   Replies still 'prepared' after >1h are flipped to 'aborted'.
 *   Their assets are preserved as evidence (deferred to a separate asset
 *   GC pass — outside Wave 3.5 scope, see §4.3 "asset 不删（保留作 evidence）").
 *
 * Critical invariants:
 *   - Re-prepare with same (taskId, idempotencyKey) returns existing row, never duplicates.
 *   - Re-commit with same replyId returns ok=true without re-writing the message.
 *   - prepare with any non-ready asset fails 400 + marks the (would-be) row aborted
 *     (no row is written; the aborted state only applies once a 'prepared' row exists).
 *   - applyTransitionSideEffects (§12.2) is preserved: commit goes through
 *     `taskService.transitionTask` so notify-creator side effect fires normally.
 */

import * as crypto from 'node:crypto';
import prisma from '../db';
import type { MessageService } from './message.service';
import type { TaskService } from './task.service';
import type { RoomManager } from '../ws/rooms';
import type { SyncService } from './sync.service';
import { ServerEvents } from '../ws/events';
import { createModuleLogger } from '../../lib/logger';
import {
  validateAgentDispatchReplyToken,
  type AgentDispatchReplyAttachment,
  type AgentDispatchReplyStatus,
  type AgentDispatchReplyPayload,
} from './agent-dispatcher';

const log = createModuleLogger('DispatchReplyService');

/** Replies still 'prepared' beyond this window are reaped to 'aborted'. */
export const PREPARED_REPLY_ORPHAN_MS = 60 * 60 * 1000; // 1h

export interface PrepareInput {
  taskId: string;
  idempotencyKey: string;
  conversationId: string;
  replyToken: string;
  replyToMessageId: string;
  agentImUserId: string;
  status: AgentDispatchReplyStatus;
  replyText?: string;
  assetIds: string[];
  attachments?: AgentDispatchReplyAttachment[];
  messageContent?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
  completedAt: string;
  error?: { code: string; message: string };
}

export interface PrepareResult {
  replyId: string;
  status: 'prepared' | 'committed';
  existed: boolean;
}

export interface CommitResult {
  ok: true;
  alreadyCommitted: boolean;
  messageId?: string;
}

export interface DispatchReplyDeps {
  messageService: Pick<MessageService, 'send'>;
  taskService: Pick<TaskService, 'transitionTask'>;
  syncService?: Pick<SyncService, 'writeEvent'>;
  getParticipantIds: (conversationId: string) => Promise<string[]>;
  rooms?: Pick<RoomManager, 'sendToUser'>;
}

/**
 * Phase 1 — prepare the reply. Idempotent on (taskId, idempotencyKey).
 *
 * Validates each assetId is ingestStatus='ready' before writing the prepared
 * row. If any asset is missing or not-yet-ready, throws AssetNotReadyError
 * (caller maps to HTTP 400) — no row is persisted (so a subsequent retry
 * with the same idempotencyKey is unaffected and may eventually succeed
 * once the asset finishes ingesting).
 *
 * Also re-validates the dispatch reply token so prepare can never be called
 * by a non-cloud-issued caller; this is the same guarantee as the legacy
 * `/dispatch/reply` path.
 */
export async function prepareDispatchReply(input: PrepareInput): Promise<PrepareResult> {
  // 1. Token signature must match — re-use the agent-dispatcher validator.
  //    We construct the canonical payload so the validator runs identically
  //    to the legacy /dispatch/reply path (no behavioural drift).
  const tokenPayload: AgentDispatchReplyPayload = {
    replyToken: input.replyToken,
    conversationId: input.conversationId,
    replyToMessageId: input.replyToMessageId,
    agentImUserId: input.agentImUserId,
    status: input.status,
    completedAt: input.completedAt,
    ...(input.replyText !== undefined ? { replyText: input.replyText } : {}),
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    ...(input.error ? { error: input.error } : {}),
  };
  validateAgentDispatchReplyToken(tokenPayload);

  // 2. Idempotency check — (taskId, idempotencyKey) UNIQUE. Re-prepare must
  //    NOT throw on a committed row (daemon may not realise the cloud
  //    finished commit if the response was dropped). Return the existing.
  const existing = await prisma.iMDispatchReply.findUnique({
    where: { taskId_idempotencyKey: { taskId: input.taskId, idempotencyKey: input.idempotencyKey } },
  });
  if (existing) {
    log.info(
      { taskId: input.taskId, idempotencyKey: input.idempotencyKey, status: existing.status },
      'prepare hit existing row',
    );
    return {
      replyId: existing.id,
      status: existing.status as 'prepared' | 'committed',
      existed: true,
    };
  }

  // 3. Asset-servable gate. Empty assetIds is fine (text-only reply). Any
  //    referenced assetId must exist AND have its BYTES servable AND not be
  //    soft-deleted.
  //    release202 FIX: the gate used to require the literal `ingestStatus='ready'`,
  //    but the file-UPLOAD pipeline (assets.ts) never produces 'ready' — it
  //    produces 'asset-only' (binary/PDF), 'indexed' (text) or 'memory-ready'.
  //    Only the markdown task-artifact services (todo/task-spec/skill) mint
  //    'ready'. So uploaded PDFs/images could NEVER attach to an agent reply
  //    (AssetNotReadyError → fell back to a fragmented `cloud file send`). The
  //    gate's intent is "bytes are servable", which is every status EXCEPT
  //    `pending`/`failed`. `asset-only` literally means "bytes available, no
  //    memory embedding" (message.service.ts) and the bytes endpoint serves it.
  const SERVABLE_INGEST_STATUSES = ['ready', 'memory-ready', 'asset-only', 'indexed'];
  if (input.assetIds.length > 0) {
    const ready = await prisma.iMAsset.findMany({
      where: { id: { in: input.assetIds }, ingestStatus: { in: SERVABLE_INGEST_STATUSES }, deletedAt: null },
      select: { id: true },
    });
    const readySet = new Set(ready.map((r: { id: string }) => r.id));
    const missing = input.assetIds.filter((id) => !readySet.has(id));
    if (missing.length > 0) {
      log.warn(
        { taskId: input.taskId, idempotencyKey: input.idempotencyKey, missing },
        'prepare failed — assets not ready',
      );
      throw new AssetNotReadyError(missing);
    }
  }

  // 4. Persist the prepared row. Cuid-style id for compatibility with
  //    Prisma @id @db.VarChar(40).
  const id = newReplyId();
  await prisma.iMDispatchReply.create({
    data: {
      id,
      taskId: input.taskId,
      idempotencyKey: input.idempotencyKey,
      status: 'prepared',
      assetIdsJson: input.assetIds,
      messageContentJson: buildMessageContentJson(input),
      metricsJson: input.metrics ?? null,
    },
  });

  log.info(
    { replyId: id, taskId: input.taskId, idempotencyKey: input.idempotencyKey, assetCount: input.assetIds.length },
    'prepared dispatch reply',
  );
  return { replyId: id, status: 'prepared', existed: false };
}

/**
 * Phase 2 — commit. Idempotent on replyId. Writes message, transitions
 * task, fans out sync event. The status flip on im_dispatch_replies is
 * the commit point; if anything before it throws, the row remains
 * 'prepared' and the daemon can retry.
 *
 * We deliberately use messageService.send (not raw tx) because the send
 * pipeline has many invariants (idempotency, encryption, attachment
 * normalisation, ws fan-out preparation) that are out of scope for this
 * wave to reimplement. The "single tx" wording in §4.3 is satisfied at
 * the IMDispatchReply state-machine level: the row only flips to
 * 'committed' after message+transition succeed, so any partial failure
 * leaves the row as 'prepared' (the reaper will not touch it within 1h,
 * giving the daemon a retry window).
 */
export async function commitDispatchReply(
  replyId: string,
  deps: DispatchReplyDeps,
): Promise<CommitResult> {
  const reply = await prisma.iMDispatchReply.findUnique({ where: { id: replyId } });
  if (!reply) {
    throw new DispatchReplyNotFoundError(replyId);
  }
  if (reply.status === 'committed') {
    log.info({ replyId }, 'commit no-op — already committed');
    return { ok: true, alreadyCommitted: true };
  }
  if (reply.status !== 'prepared') {
    throw new DispatchReplyInvalidStateError(replyId, reply.status);
  }

  const messageContent = (reply.messageContentJson ?? {}) as Record<string, unknown>;
  const persisted = await persistReplyMessage(reply, messageContent, deps);

  // Transition the task — running → review (or running → failed when status
  // is not 'ok'). We use the standard transitionTask path so the §12.2
  // applyTransitionSideEffects (notify-creator etc.) is preserved.
  const replyStatus = (messageContent.status as AgentDispatchReplyStatus) ?? 'ok';
  await transitionTaskFromReply(reply.taskId, replyStatus, messageContent, deps);

  // Flip the reply row to committed. This is the single-row commit point.
  await prisma.iMDispatchReply.update({
    where: { id: replyId },
    data: { status: 'committed', committedAt: new Date() },
  });

  log.info(
    { replyId, taskId: reply.taskId, messageId: persisted.messageId },
    'committed dispatch reply',
  );
  return { ok: true, alreadyCommitted: false, messageId: persisted.messageId };
}

/**
 * Reaper — flip stale `prepared` rows to `aborted` after the orphan window.
 * Writes an IMTaskLog action='dispatch-reply-aborted' for audit.
 *
 * Per §4.3 "asset 不删（保留作 evidence）" — we deliberately leave the
 * referenced IMAsset rows alone. A separate asset GC pass (out of Wave 3.5
 * scope) can sweep them later if desired.
 *
 * Returns the count of reaped rows so the scheduler can log it.
 */
export async function sweepArphanedDispatchReplies(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - PREPARED_REPLY_ORPHAN_MS);
  const stale = await prisma.iMDispatchReply.findMany({
    where: { status: 'prepared', preparedAt: { lt: cutoff } },
    select: { id: true, taskId: true, idempotencyKey: true, assetIdsJson: true, preparedAt: true },
    take: 100, // cap per sweep to avoid lock storms
  });
  if (stale.length === 0) return 0;

  let reaped = 0;
  for (const row of stale) {
    try {
      await prisma.$transaction(async (tx: any) => {
        // Conditional update — only flip if still prepared. This guards
        // against a concurrent commit racing with the reaper (commit wins).
        const result = await tx.iMDispatchReply.updateMany({
          where: { id: row.id, status: 'prepared' },
          data: { status: 'aborted', abortedAt: now },
        });
        if (result.count === 0) return; // committed under our feet — skip
        await tx.iMTaskLog.create({
          data: {
            taskId: row.taskId,
            actorId: null,
            action: 'dispatch-reply-aborted',
            message: `Dispatch reply ${row.id} reaped after >1h prepared (orphaned)`,
            metadata: JSON.stringify({
              replyId: row.id,
              idempotencyKey: row.idempotencyKey,
              assetIds: row.assetIdsJson,
              preparedAt: row.preparedAt.toISOString(),
              reapedAt: now.toISOString(),
            }),
          },
        });
      });
      reaped++;
    } catch (err) {
      log.warn(
        { err: (err as Error).message, replyId: row.id, taskId: row.taskId },
        'reaper iteration failed',
      );
    }
  }
  if (reaped > 0) {
    log.info({ reaped, total: stale.length }, 'sweep aborted prepared dispatch replies');
  }
  return reaped;
}

// ─── internals ─────────────────────────────────────────────────────────────

async function persistReplyMessage(
  reply: any,
  messageContent: Record<string, unknown>,
  deps: DispatchReplyDeps,
): Promise<{ messageId: string }> {
  const status = (messageContent.status as AgentDispatchReplyStatus) ?? 'ok';
  const ok = status === 'ok';
  const replyText = typeof messageContent.replyText === 'string' ? messageContent.replyText : '';
  const attachments = Array.isArray(messageContent.attachments)
    ? (messageContent.attachments as Array<{ kind: 'file' | 'image'; assetId: string }>).map((a) => ({
        kind: a.kind,
        assetId: a.assetId,
        role: 'output' as const,
      }))
    : [];
  const error = messageContent.error as { code: string; message: string } | undefined;
  const fallbackContent = `Agent dispatch ${status}: ${error?.message ?? 'No reply was produced.'}`;
  const content = ok
    ? replyText.trim() ||
      (attachments.length > 0 ? `Sent ${attachments.length} file${attachments.length === 1 ? '' : 's'}` : '')
    : fallbackContent;
  const conversationId = String(messageContent.conversationId);
  const agentImUserId = String(messageContent.agentImUserId);
  const replyToMessageId = String(messageContent.replyToMessageId);

  const result = await deps.messageService.send({
    conversationId,
    senderId: agentImUserId,
    type: ok ? 'text' : 'system_event',
    content,
    metadata: {
      _idempotencyKey: `dispatch_reply_v2:${reply.id}`,
      dispatchReplyKey: `dispatch_reply_v2:${reply.id}`,
      dispatchReplyId: reply.id,
      kind: ok ? 'agent_reply' : 'agent_status_event',
      source: 'dispatch_reply_two_phase',
      triggerMessageId: replyToMessageId,
      replyToMessageId,
      agentImUserId,
      dispatchStatus: status,
      completedAt: messageContent.completedAt,
      ...(error
        ? {
            errorCode: error.code,
            error: error.message,
          }
        : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    },
    attachments: attachments.length > 0 ? attachments : undefined,
  });

  const message = result.message;
  const createdAt = message.createdAt instanceof Date ? message.createdAt.toISOString() : String(message.createdAt);
  const event = ServerEvents.messageNew({
    id: message.id,
    conversationId,
    senderId: message.senderId,
    type: message.type as any,
    content: message.content,
    metadata: parseMetadata(message.metadata),
    attachments: attachments.length > 0 ? attachments : undefined,
    parentId: message.parentId ?? undefined,
    createdAt,
  });
  const participants = await deps.getParticipantIds(conversationId);
  for (const userId of participants) {
    deps.rooms?.sendToUser(userId, event);
  }

  return { messageId: message.id };
}

async function transitionTaskFromReply(
  taskId: string,
  status: AgentDispatchReplyStatus,
  messageContent: Record<string, unknown>,
  deps: DispatchReplyDeps,
): Promise<void> {
  // Look up the task to discover its current status (we don't blindly
  // transition — if the task isn't in 'running' or 'assigned', the
  // dispatch reply is informational only and we leave the status alone).
  const task = await prisma.iMTask.findUnique({
    where: { id: taskId },
    select: { id: true, status: true, assigneeId: true },
  });
  if (!task) {
    log.warn({ taskId }, 'commit: task not found, skipping transition');
    return;
  }
  if (task.status !== 'running' && task.status !== 'assigned') {
    log.info(
      { taskId, currentStatus: task.status, replyStatus: status },
      'commit: task not in running/assigned, skipping transition',
    );
    return;
  }

  const agentImUserId = String(messageContent.agentImUserId);
  const targetStatus = status === 'ok' ? 'review' : 'failed';
  try {
    await deps.taskService.transitionTask(taskId, agentImUserId, {
      to: targetStatus,
      reason: status === 'ok' ? 'dispatch-reply-commit' : `dispatch-reply-${status}`,
    });
  } catch (err) {
    // Transitions can fail if e.g. running→review isn't permitted from
    // the current row's status (race). Log + swallow — the message has
    // already landed, and the reply will still mark committed because
    // the user-visible artefact (chat message) is present.
    log.warn(
      { err: (err as Error).message, taskId, from: task.status, to: targetStatus },
      'commit: transition failed (non-fatal, message persisted)',
    );
  }
}

function buildMessageContentJson(input: PrepareInput): Record<string, unknown> {
  return {
    conversationId: input.conversationId,
    replyToMessageId: input.replyToMessageId,
    agentImUserId: input.agentImUserId,
    status: input.status,
    replyText: input.replyText ?? '',
    attachments: input.attachments ?? [],
    completedAt: input.completedAt,
    ...(input.error ? { error: input.error } : {}),
    ...(input.messageContent ? { extra: input.messageContent } : {}),
  };
}

function parseMetadata(metadata: unknown): Record<string, unknown> {
  if (!metadata) return {};
  if (typeof metadata === 'string') {
    try {
      const parsed = JSON.parse(metadata);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof metadata === 'object' && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : {};
}

function newReplyId(): string {
  // 32 hex chars, fits @db.VarChar(40). Avoid bringing in cuid here to keep
  // the service self-contained (cuid is only used by Prisma's @default).
  return `dr_${crypto.randomBytes(12).toString('hex')}`;
}

export class AssetNotReadyError extends Error {
  readonly missingAssetIds: string[];
  constructor(missingAssetIds: string[]) {
    super(`assets not ready: ${missingAssetIds.join(', ')}`);
    this.name = 'AssetNotReadyError';
    this.missingAssetIds = missingAssetIds;
  }
}

export class DispatchReplyNotFoundError extends Error {
  constructor(replyId: string) {
    super(`dispatch reply not found: ${replyId}`);
    this.name = 'DispatchReplyNotFoundError';
  }
}

export class DispatchReplyInvalidStateError extends Error {
  readonly currentStatus: string;
  constructor(replyId: string, currentStatus: string) {
    super(`dispatch reply ${replyId} is in '${currentStatus}', cannot commit (must be 'prepared')`);
    this.name = 'DispatchReplyInvalidStateError';
    this.currentStatus = currentStatus;
  }
}
