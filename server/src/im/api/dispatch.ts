/**
 * Prismer IM — daemon dispatch reply API.
 *
 * Spec: docs/release200/14-messaging-state-machine-reliability.md §4.3
 *
 * Three endpoints:
 *   - POST /dispatch/:taskId/prepare  — phase 1, idempotent on (taskId, idempotencyKey)
 *   - POST /dispatch/:taskId/commit   — phase 2, idempotent on replyId
 *   - POST /dispatch/reply            — DEPRECATED (single-shot legacy), kept
 *                                       for backwards compatibility with the
 *                                       current daemon SDK. Daemon migration
 *                                       to prepare/commit is Wave 4.
 *
 * The legacy /reply path attaches `Deprecation: true` + `Sunset: 2026-09-01`
 * response headers per RFC 9745 / RFC 8594 so HTTP clients can surface the
 * upgrade pressure without a behavioural break.
 */

import { Hono } from 'hono';
import type { ApiResponse } from '../types/index';
import {
  persistAgentDispatchReply,
  validateAgentDispatchReplyPayload,
  type DispatchReplyPersistDeps,
} from '../services/agent-dispatcher';
import {
  prepareDispatchReply,
  commitDispatchReply,
  AssetNotReadyError,
  DispatchReplyNotFoundError,
  DispatchReplyInvalidStateError,
  type DispatchReplyDeps,
  type PrepareInput,
} from '../services/dispatch-reply.service';

/**
 * Sunset date for legacy /dispatch/reply per RFC 8594. Daemon SDK must
 * migrate to prepare/commit before this date. Tracked under Wave 4.
 */
const LEGACY_REPLY_SUNSET_HTTP_DATE = 'Tue, 01 Sep 2026 00:00:00 GMT';

export function createDispatchRouter(deps: DispatchReplyPersistDeps & DispatchReplyDeps) {
  const router = new Hono();

  // ───────────────────────────────────────────────────────────────
  // POST /dispatch/:taskId/prepare — phase 1
  // ───────────────────────────────────────────────────────────────
  router.post('/:taskId/prepare', async (c) => {
    const taskId = c.req.param('taskId');
    if (!taskId) {
      return c.json<ApiResponse>({ ok: false, error: 'taskId is required' }, 400);
    }

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Invalid JSON body' }, 400);
    }

    const input = parsePrepareBody(taskId, body);
    if (isParseError(input)) {
      return c.json<ApiResponse>({ ok: false, error: { code: 'INVALID_PREPARE_BODY', message: input.error } }, 400);
    }

    try {
      const result = await prepareDispatchReply(input);
      return c.json<ApiResponse>({
        ok: true,
        data: {
          replyId: result.replyId,
          status: result.status,
          existed: result.existed,
        },
      });
    } catch (err) {
      if (err instanceof AssetNotReadyError) {
        return c.json<ApiResponse>(
          {
            ok: false,
            error: {
              code: 'ASSETS_NOT_READY',
              message: err.message,
              details: { missingAssetIds: err.missingAssetIds },
            } as any,
          },
          400,
        );
      }
      console.warn('[DispatchAPI] prepare failed:', (err as Error).message);
      return c.json<ApiResponse>(
        {
          ok: false,
          error: {
            code: 'DISPATCH_REPLY_PREPARE_FAILED',
            message: err instanceof Error ? err.message : 'prepare failed',
          },
        },
        500,
      );
    }
  });

  // ───────────────────────────────────────────────────────────────
  // POST /dispatch/:taskId/commit — phase 2
  // ───────────────────────────────────────────────────────────────
  router.post('/:taskId/commit', async (c) => {
    const taskId = c.req.param('taskId');
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Invalid JSON body' }, 400);
    }

    const replyId = typeof body?.replyId === 'string' ? body.replyId.trim() : '';
    if (!replyId) {
      return c.json<ApiResponse>(
        { ok: false, error: { code: 'INVALID_COMMIT_BODY', message: 'replyId is required' } },
        400,
      );
    }

    try {
      const result = await commitDispatchReply(replyId, deps);
      return c.json<ApiResponse>({
        ok: true,
        data: {
          taskId,
          replyId,
          alreadyCommitted: result.alreadyCommitted,
          messageId: result.messageId,
        },
      });
    } catch (err) {
      if (err instanceof DispatchReplyNotFoundError) {
        return c.json<ApiResponse>(
          { ok: false, error: { code: 'DISPATCH_REPLY_NOT_FOUND', message: err.message } },
          404,
        );
      }
      if (err instanceof DispatchReplyInvalidStateError) {
        return c.json<ApiResponse>(
          {
            ok: false,
            error: {
              code: 'DISPATCH_REPLY_INVALID_STATE',
              message: err.message,
              details: { currentStatus: err.currentStatus },
            } as any,
          },
          400,
        );
      }
      console.warn('[DispatchAPI] commit failed:', (err as Error).message);
      return c.json<ApiResponse>(
        {
          ok: false,
          error: {
            code: 'DISPATCH_REPLY_COMMIT_FAILED',
            message: err instanceof Error ? err.message : 'commit failed',
          },
        },
        500,
      );
    }
  });

  // ───────────────────────────────────────────────────────────────
  // POST /dispatch/reply — LEGACY (single-shot)
  // Kept compatible with the current daemon SDK. Marked Deprecated
  // via RFC 9745 + RFC 8594 headers. Daemon migration → Wave 4.
  // ───────────────────────────────────────────────────────────────
  router.post('/reply', async (c) => {
    // Stamp deprecation headers up-front so even a 400 carries the signal.
    c.header('Deprecation', 'true');
    c.header('Sunset', LEGACY_REPLY_SUNSET_HTTP_DATE);
    c.header(
      'Link',
      '</api/im/dispatch/:taskId/prepare>; rel="successor-version", </api/im/dispatch/:taskId/commit>; rel="successor-version"',
    );

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Invalid JSON body' }, 400);
    }

    let payload;
    try {
      payload = validateAgentDispatchReplyPayload(body);
    } catch (err) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: {
            code: 'INVALID_DISPATCH_REPLY',
            message: err instanceof Error ? err.message : 'Invalid dispatch reply payload',
          },
        },
        400,
      );
    }

    try {
      const result = await persistAgentDispatchReply(payload, deps);
      return c.json<ApiResponse>({
        ok: true,
        data: {
          messageId: result.message.id,
          conversationId: result.message.conversationId,
          status: payload.status,
          _deprecated: true,
          _migrationGuide: 'POST /dispatch/:taskId/prepare then POST /dispatch/:taskId/commit',
        } as any,
      });
    } catch (err) {
      console.warn('[DispatchAPI] Failed to persist dispatch reply (legacy):', (err as Error).message);
      return c.json<ApiResponse>(
        {
          ok: false,
          error: {
            code: 'DISPATCH_REPLY_PERSIST_FAILED',
            message: err instanceof Error ? err.message : 'Failed to persist dispatch reply',
          },
        },
        500,
      );
    }
  });

  return router;
}

// ─── helpers ──────────────────────────────────────────────────────────────

type ParseError = { _parseError: true; error: string };
function parseError(message: string): ParseError {
  return { _parseError: true, error: message };
}
function isParseError(value: unknown): value is ParseError {
  return typeof value === 'object' && value !== null && (value as { _parseError?: boolean })._parseError === true;
}

function parsePrepareBody(taskId: string, raw: any): PrepareInput | ParseError {
  if (!raw || typeof raw !== 'object') return parseError('body must be an object');
  const idempotencyKey = stringField(raw.idempotencyKey, 'idempotencyKey');
  if (typeof idempotencyKey !== 'string') return parseError(idempotencyKey.error);
  const conversationId = stringField(raw.conversationId, 'conversationId');
  if (typeof conversationId !== 'string') return parseError(conversationId.error);
  const replyToken = stringField(raw.replyToken, 'replyToken');
  if (typeof replyToken !== 'string') return parseError(replyToken.error);
  const replyToMessageId = stringField(raw.replyToMessageId, 'replyToMessageId');
  if (typeof replyToMessageId !== 'string') return parseError(replyToMessageId.error);
  const agentImUserId = stringField(raw.agentImUserId, 'agentImUserId');
  if (typeof agentImUserId !== 'string') return parseError(agentImUserId.error);
  const status = raw.status;
  if (status !== 'ok' && status !== 'agent_offline' && status !== 'timeout' && status !== 'agent_error') {
    return parseError('status must be one of: ok, agent_offline, timeout, agent_error');
  }
  const completedAt = stringField(raw.completedAt, 'completedAt');
  if (typeof completedAt !== 'string') return parseError(completedAt.error);

  const assetIds = Array.isArray(raw.assetIds)
    ? raw.assetIds.filter((x: unknown): x is string => typeof x === 'string' && x.length > 0)
    : [];

  let attachments: Array<{ kind: 'file' | 'image'; assetId: string }> | undefined;
  if (Array.isArray(raw.attachments)) {
    attachments = [];
    for (const att of raw.attachments) {
      if (!att || typeof att !== 'object') return parseError('attachments entries must be objects');
      if (att.kind !== 'file' && att.kind !== 'image') return parseError('attachment.kind must be file or image');
      if (typeof att.assetId !== 'string' || att.assetId.length === 0) {
        return parseError('attachment.assetId is required');
      }
      attachments.push({ kind: att.kind, assetId: att.assetId });
    }
  }

  const replyText = typeof raw.replyText === 'string' ? raw.replyText : undefined;
  const messageContent =
    raw.messageContent && typeof raw.messageContent === 'object' && !Array.isArray(raw.messageContent)
      ? (raw.messageContent as Record<string, unknown>)
      : undefined;
  const metrics =
    raw.metrics && typeof raw.metrics === 'object' && !Array.isArray(raw.metrics)
      ? (raw.metrics as Record<string, unknown>)
      : undefined;
  const error =
    raw.error && typeof raw.error === 'object' && typeof raw.error.code === 'string' && typeof raw.error.message === 'string'
      ? { code: raw.error.code, message: raw.error.message }
      : undefined;

  if (status === 'ok') {
    if (!replyText?.trim() && !(attachments && attachments.length > 0) && assetIds.length === 0) {
      return parseError('replyText or attachments/assetIds required when status=ok');
    }
  } else if (!error) {
    return parseError('error.code and error.message are required when status is not ok');
  }

  return {
    taskId,
    idempotencyKey,
    conversationId,
    replyToken,
    replyToMessageId,
    agentImUserId,
    status,
    ...(replyText !== undefined ? { replyText } : {}),
    assetIds,
    ...(attachments ? { attachments } : {}),
    ...(messageContent ? { messageContent } : {}),
    ...(metrics ? { metrics } : {}),
    completedAt,
    ...(error ? { error } : {}),
  };
}

function stringField(value: unknown, field: string): string | { error: string } {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return parseError(`${field} is required`);
  }
  return value.trim();
}
