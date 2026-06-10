/**
 * Prismer IM — Messages API
 */

import { Hono } from 'hono';
import { authMiddleware } from '../auth/middleware';
import { MessageService } from '../services/message.service';
import { ConversationService } from '../services/conversation.service';
import type { CreditService } from '../services/credit.service';
import type { RoomManager } from '../ws/rooms';
import { ServerEvents } from '../ws/events';
import type { SigningService } from '../services/signing.service';
import type { RateLimiterService } from '../services/rate-limiter.service';
import { createRateLimitMiddleware } from '../middleware/rate-limit';
import type { ApiResponse, MessageType, AssetAttachment } from '../types/index';
import prisma from '../db';
import { requireAgentToolAllowed, resolveConversationWorkspaceId } from '../security/mcp-allowlist';
import { canObserveWorkspaceConversation } from './conversation-visibility';
import { StreamService } from '../services/stream.service';

// v1.8.2: Resolve quoted message summary for quote replies
async function resolveQuotedMessage(messageId: string | null | undefined) {
  if (!messageId) return undefined;
  const quoted = await prisma.iMMessage.findUnique({
    where: { id: messageId },
    select: { id: true, senderId: true, content: true, type: true },
  });
  if (!quoted) return undefined;
  return {
    id: quoted.id,
    senderId: quoted.senderId,
    type: quoted.type,
    content: quoted.content?.slice(0, 200) ?? '',
  };
}

export function createMessagesRouter(
  messageService: MessageService,
  conversationService: ConversationService,
  creditService: CreditService,
  rooms: RoomManager,
  signingService: SigningService,
  rateLimiter?: RateLimiterService,
) {
  const router = new Hono();

  // eslint-disable-next-line custom/no-wildcard-sub-router-middleware -- mounted at /messages in routes.ts; wildcard scoped to that prefix
  router.use('*', authMiddleware);

  /**
   * POST /api/messages/delivered — Mark messages as delivered (delivery receipts)
   */
  router.post('/delivered', async (c) => {
    const user = c.get('user');
    const body = await c.req.json();
    const { conversationId, messageIds } = body;

    if (!conversationId || !Array.isArray(messageIds) || messageIds.length === 0) {
      return c.json<ApiResponse>({ ok: false, error: 'conversationId and messageIds[] are required' }, 400);
    }
    if (messageIds.length > 200) {
      return c.json<ApiResponse>({ ok: false, error: 'Maximum 200 messageIds per request' }, 400);
    }

    const isMember = await conversationService.isParticipant(conversationId, user.imUserId);
    if (!isMember) {
      return c.json<ApiResponse>({ ok: false, error: 'Not a participant' }, 403);
    }

    const now = new Date();
    const updated = await prisma.iMMessage.updateMany({
      where: {
        id: { in: messageIds },
        conversationId,
        senderId: { not: user.imUserId },
        status: { not: 'delivered' },
      },
      data: { status: 'delivered', updatedAt: now },
    });

    const event = ServerEvents.messageDelivered({
      conversationId,
      messageIds,
      deliveredBy: user.imUserId,
      deliveredAt: now.toISOString(),
    });
    const participants = await conversationService.getParticipantIds(conversationId);
    for (const uid of participants) {
      rooms.sendToUser(uid, event);
    }

    return c.json<ApiResponse>({ ok: true, data: { updated: updated.count } });
  });

  /**
   * GET /api/messages/:conversationId — Get message history with cursor pagination
   */
  router.get('/:conversationId', async (c) => {
    const user = c.get('user');
    const conversationId = c.req.param('conversationId')!;

    // Check participation (use imUserId for resolved identity). Workspace
    // owners/members may also read agent-only workspace conversations for the
    // ACP control-plane session list, even when the human was not added as a
    // participant to the agent-agent direct chat.
    const isMember = await conversationService.isParticipant(conversationId, user.imUserId);
    if (!isMember && !(await canObserveWorkspaceConversation(conversationId, user.imUserId))) {
      return c.json<ApiResponse>({ ok: false, error: 'Not a participant' }, 403);
    }

    const before = c.req.query('before') ?? undefined;
    const after = c.req.query('after') ?? undefined;
    const q = c.req.query('q')?.trim() ?? '';
    const parsedLimit = parseInt(c.req.query('limit') ?? (q ? '20' : '50'), 10);
    const limit = Number.isFinite(parsedLimit) ? parsedLimit : q ? 20 : 50;

    if (q) {
      const result = await messageService.searchMessages({
        conversationId,
        query: q,
        before,
        limit,
      });

      return c.json<ApiResponse>({
        ok: true,
        data: result.messages,
        meta: { total: result.total, pageSize: Math.min(Math.max(limit, 1), 50), query: q },
      });
    }

    const messages = await messageService.getHistory({
      conversationId,
      before,
      after,
      limit,
    });

    const total = await messageService.getCount(conversationId);

    // v1.8.2: Batch resolve quoted messages
    const quotedIds = messages.map((m: any) => m.quotedMessageId).filter(Boolean) as string[];
    let quotedMap = new Map<string, { id: string; senderId: string; type: string; content: string }>();
    if (quotedIds.length > 0) {
      const quoted = await prisma.iMMessage.findMany({
        where: { id: { in: [...new Set(quotedIds)] } },
        select: { id: true, senderId: true, type: true, content: true },
      });
      quotedMap = new Map(
        quoted.map((q: any) => [
          q.id,
          { id: q.id, senderId: q.senderId, type: q.type, content: q.content?.slice(0, 200) ?? '' },
        ]),
      );
    }
    const enrichedMessages = messages.map((m: any) => ({
      ...m,
      ...(m.quotedMessageId && quotedMap.has(m.quotedMessageId)
        ? { quotedMessage: quotedMap.get(m.quotedMessageId) }
        : {}),
    }));

    return c.json<ApiResponse>({
      ok: true,
      data: enrichedMessages,
      meta: { total, pageSize: limit },
    });
  });

  /**
   * POST /api/messages/:conversationId — Send a message via REST
   *
   * Now includes @mention parsing and routing information in response.
   */
  if (rateLimiter) {
    router.post('/:conversationId', createRateLimitMiddleware(rateLimiter, 'message.send'));
  }
  router.post('/:conversationId', async (c) => {
    const user = c.get('user');
    const conversationId = c.req.param('conversationId')!;
    const body = await c.req.json();

    const {
      type,
      content,
      metadata,
      attachments,
      parentId,
      quotedMessageId,
      secVersion,
      senderKeyId,
      senderDid,
      signedAt,
      sequence,
      contentHash,
      prevHash,
      signature,
      timestamp,
    } = body;

    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
    if (!content && !hasAttachments && type !== 'tool_call' && type !== 'system_event') {
      return c.json<ApiResponse>({ ok: false, error: 'content is required' }, 400);
    }

    // E2E Signing verification (Layer 2)
    // Accept both full signing (senderKeyId) and lite signing (senderDid only)
    const isSigned = secVersion != null && (senderKeyId || senderDid) && signature;
    const isLiteMode = isSigned && senderDid && !senderKeyId;
    if (isSigned && !isLiteMode && (typeof sequence !== 'number' || !Number.isInteger(sequence) || sequence < 1)) {
      return c.json<ApiResponse>({ ok: false, error: 'sequence must be a positive integer when signing' }, 400);
    }
    if (isSigned) {
      const verifyResult = await signingService.verifyMessage({
        senderId: user.imUserId,
        conversationId,
        type: (type as string) ?? 'text',
        content: content ?? '',
        createdAt: signedAt ?? timestamp ?? Date.now(),
        secVersion,
        senderKeyId,
        senderDid,
        sequence,
        contentHash,
        prevHash: prevHash ?? null,
        signature,
      });
      if (!verifyResult.valid) {
        return c.json<ApiResponse>(
          {
            ok: false,
            error: `Signature verification failed: ${verifyResult.reason}`,
          },
          403,
        );
      }
    } else {
      // Check if signing is required for this conversation
      const policy = await signingService.getSigningPolicy(conversationId);
      if (policy === 'required') {
        return c.json<ApiResponse>(
          {
            ok: false,
            error: 'This conversation requires signed messages',
          },
          403,
        );
      }
    }

    // Deduct IM credits (skip for API Key proxy — cloud credits handle it)
    if (user.type !== 'api_key_proxy') {
      const deductResult = await creditService.deduct(
        user.imUserId,
        0.001,
        `send: conversation/${conversationId}`,
        'message',
      );
      if (!deductResult.success) {
        return c.json<ApiResponse>({ ok: false, error: 'Insufficient IM credits' }, 402);
      }
    }

    // Support idempotency for offline SDK retries.
    // Defensively spread (metadata ?? {}) because body.metadata may be
    // undefined when client only supplied the header path.
    const idempotencyKey = c.req.header('X-Idempotency-Key');
    const enrichedMetadata = idempotencyKey
      ? { ...(metadata ?? {}), _idempotencyKey: idempotencyKey }
      : metadata;

    try {
      const result = await messageService.send({
        conversationId,
        senderId: user.imUserId,
        type: type as MessageType,
        content: content ?? '',
        metadata: enrichedMetadata,
        attachments,
        parentId,
        quotedMessageId,
        // E2E Signing fields (pass through if verified by this route)
        ...(isSigned
          ? {
              secVersion,
              senderKeyId,
              senderDid,
              sequence,
              contentHash,
              prevHash,
              signature,
              signedAt: signedAt ?? timestamp,
              _signatureVerified: true,
            }
          : {}),
      });

      // Push to all participants via sendToUser (works cross-pod via Redis)
      const msg = result.message;
      const messageMetadata = msg.metadata
        ? typeof msg.metadata === 'string'
          ? JSON.parse(msg.metadata)
          : msg.metadata
        : {};
      if (result.routing && result.routing.targets.length > 0) {
        messageMetadata.routeTargets = result.routing.targets.map((t: any) => t.userId);
        messageMetadata.routingMode = result.routing.mode;
      }
      const event = ServerEvents.messageNew({
        id: msg.id,
        conversationId,
        senderId: msg.senderId,
        type: msg.type as any,
        content: msg.content,
        metadata: messageMetadata,
        attachments: msg.attachments ?? undefined,
        parentId: msg.parentId ?? undefined,
        createdAt: msg.createdAt instanceof Date ? msg.createdAt.toISOString() : String(msg.createdAt),
      });
      const participants = await conversationService.getParticipantIds(conversationId);
      for (const uid of participants) {
        rooms.sendToUser(uid, event);
      }

      // v1.8.2: Resolve quoted message summary if present
      const quotedMessage = await resolveQuotedMessage((result.message as any).quotedMessageId);

      // v2.0 §4.1: Surface the freshly-allocated per-conversation
      // `boundarySeq` so the SDK / front-end can advance its reconcile
      // cursor synchronously with the POST response (don't wait for the
      // SSE echo). The boundarySeq lives on the IMSyncEvent row written
      // in the same tx — look it up by message id + type.
      let boundarySeq: number | null = null;
      try {
        const evt = await prisma.iMSyncEvent.findFirst({
          where: { conversationId, type: 'message.new', data: { contains: `"id":"${msg.id}"` } },
          orderBy: { id: 'desc' },
          select: { boundarySeq: true },
        });
        boundarySeq = evt?.boundarySeq != null ? Number(evt.boundarySeq) : null;
      } catch {
        // Non-fatal — SDK falls back to SSE for boundarySeq.
      }

      return c.json<ApiResponse>(
        {
          ok: true,
          data: {
            message: {
              ...result.message,
              ...(quotedMessage ? { quotedMessage } : {}),
              ...(boundarySeq != null ? { boundarySeq } : {}),
            },
            routing: result.routing
              ? {
                  mode: result.routing.mode,
                  targets: result.routing.targets.map((t) => ({
                    userId: t.userId,
                    username: t.username,
                    displayName: t.displayName,
                  })),
                }
              : undefined,
          },
        },
        201,
      );
    } catch (err) {
      const e = err as Error & { status?: number; code?: string };
      if (e.code === 'BLOCKED') {
        return c.json<ApiResponse>({ ok: false, error: e.message }, 403);
      }
      if (
        e.message.includes('not a participant') ||
        e.message.includes('requires encrypted messages') ||
        e.message.includes('Context access denied')
      ) {
        return c.json<ApiResponse>({ ok: false, error: e.message }, 403);
      }
      return c.json<ApiResponse>({ ok: false, error: e.message }, 500);
    }
  });

  /**
   * PATCH /api/messages/:conversationId/:messageId — Update a message
   */
  router.patch('/:conversationId/:messageId', async (c) => {
    const user = c.get('user');
    const conversationId = c.req.param('conversationId')!;
    const messageId = c.req.param('messageId')!;
    const body = await c.req.json();
    const denied = await requireAgentToolAllowed(
      c,
      'prismer.message.edit',
      await resolveConversationWorkspaceId(conversationId),
    );
    if (denied) return denied;

    const msg = await messageService.getById(messageId);
    if (!msg) {
      return c.json<ApiResponse>({ ok: false, error: 'Message not found' }, 404);
    }
    if (msg.senderId !== user.imUserId) {
      return c.json<ApiResponse>({ ok: false, error: 'Can only edit own messages' }, 403);
    }

    const updated = await messageService.update(messageId, {
      content: body.content,
      metadata: body.metadata,
    });

    if (updated) {
      const updatedMetadata = updated.metadata
        ? typeof updated.metadata === 'string'
          ? JSON.parse(updated.metadata)
          : updated.metadata
        : undefined;
      const event = ServerEvents.messageEdit({
        id: updated.id,
        conversationId,
        content: updated.content,
        type: updated.type ?? msg.type ?? 'text',
        editedAt:
          (updated.updatedAt instanceof Date ? updated.updatedAt.toISOString() : String(updated.updatedAt)) ||
          new Date().toISOString(),
        editedBy: user.imUserId,
        metadata: updatedMetadata,
      });
      const participants = await conversationService.getParticipantIds(conversationId);
      for (const uid of participants) {
        rooms.sendToUser(uid, event);
      }
    }

    return c.json<ApiResponse>({ ok: true, data: updated });
  });

  /**
   * POST /api/messages/:conversationId/:messageId/attach — release202/09 P5#3
   * (A2): append an already-uploaded asset to an ALREADY-PERSISTED message.
   *
   * Complements A1 (`cloud deliver`, which rides the reply that doesn't exist
   * yet). Use case: the agent already replied (`cloud send` / `cloud file send`
   * returned a messageId), then produced a file it wants on THAT message.
   *
   * Body: `{ assetId }`. The asset must already exist (the daemon uploads it
   * first with its own credential, then calls this with the resulting assetId).
   * Auth = same agent-proxy as every other IM op (X-IM-Agent → resolved
   * `user.imUserId`); sender-only (you may only attach to your own message),
   * matching the PATCH/DELETE edit guard. Re-emits `message.updated` carrying
   * the new `attachments[]` so the UI picks it up in-place (im-channel.tsx).
   */
  router.post('/:conversationId/:messageId/attach', async (c) => {
    const user = c.get('user');
    const conversationId = c.req.param('conversationId');
    const messageId = c.req.param('messageId');
    let body: { assetId?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'invalid JSON body' }, 400);
    }
    const assetId = typeof body.assetId === 'string' ? body.assetId.trim() : '';
    if (!assetId) {
      return c.json<ApiResponse>({ ok: false, error: 'assetId is required' }, 400);
    }

    const denied = await requireAgentToolAllowed(
      c,
      'prismer.message.edit',
      await resolveConversationWorkspaceId(conversationId),
    );
    if (denied) return denied;

    const msg = await messageService.getById(messageId);
    if (!msg) {
      return c.json<ApiResponse>({ ok: false, error: 'Message not found' }, 404);
    }
    if (msg.conversationId !== conversationId) {
      // The messageId must belong to the conversation in the path — prevents a
      // valid credential from attaching to a message in someone else's thread.
      return c.json<ApiResponse>({ ok: false, error: 'Message does not belong to this conversation' }, 404);
    }
    if (msg.senderId !== user.imUserId) {
      return c.json<ApiResponse>({ ok: false, error: 'Can only attach to your own messages' }, 403);
    }

    try {
      const { message: updated, attachment, added } = await messageService.attachAssetToMessage(messageId, assetId);

      if (added) {
        const updatedMetadata = updated.metadata
          ? typeof updated.metadata === 'string'
            ? JSON.parse(updated.metadata)
            : updated.metadata
          : undefined;
        const event = ServerEvents.messageUpdated({
          id: updated.id,
          conversationId,
          content: updated.content,
          type: (updated.type ?? msg.type ?? 'text') as MessageType,
          attachments: (updated as { attachments?: AssetAttachment[] | null }).attachments ?? undefined,
          metadata: updatedMetadata,
        });
        const participants = await conversationService.getParticipantIds(conversationId);
        for (const uid of participants) {
          rooms.sendToUser(uid, event);
        }
      }

      return c.json<ApiResponse>({ ok: true, data: { messageId: updated.id, assetId, attachment, added } });
    } catch (err) {
      const e = err as Error & { status?: number };
      return c.json<ApiResponse>({ ok: false, error: e.message }, (e.status as 400 | 404 | 422) ?? 500);
    }
  });

  /**
   * DELETE /api/messages/:conversationId/:messageId — Delete a message
   */
  router.delete('/:conversationId/:messageId', async (c) => {
    const user = c.get('user');
    const conversationId = c.req.param('conversationId');
    const messageId = c.req.param('messageId');
    const denied = await requireAgentToolAllowed(
      c,
      'prismer.message.delete',
      await resolveConversationWorkspaceId(conversationId),
    );
    if (denied) return denied;

    const msg = await messageService.getById(messageId);
    if (!msg) {
      return c.json<ApiResponse>({ ok: false, error: 'Message not found' }, 404);
    }
    if (msg.senderId !== user.imUserId) {
      return c.json<ApiResponse>({ ok: false, error: 'Can only delete own messages' }, 403);
    }

    await messageService.delete(messageId);

    const delEvent = ServerEvents.messageDeleted({ id: messageId, conversationId });
    const delParticipants = await conversationService.getParticipantIds(conversationId);
    for (const uid of delParticipants) {
      rooms.sendToUser(uid, delEvent);
    }

    return c.json<ApiResponse>({ ok: true });
  });

  /**
   * POST /api/messages/:conversationId/:messageId/reactions — Add/remove reaction (v1.8.2)
   * Body: { emoji: "👍" } to add, { emoji: "👍", remove: true } to remove
   *
   * Reactions are stored in dedicated im_message_reactions table with composite
   * unique key (messageId, userId, emoji). Add = upsert (idempotent), remove =
   * deleteMany (idempotent), no read-modify-write race.
   */
  router.post('/:conversationId/:messageId/reactions', async (c) => {
    const user = c.get('user');
    const conversationId = c.req.param('conversationId');
    const messageId = c.req.param('messageId');
    const body = await c.req.json();
    const denied = await requireAgentToolAllowed(
      c,
      'prismer.message.react',
      await resolveConversationWorkspaceId(conversationId),
    );
    if (denied) return denied;

    if (!body.emoji || typeof body.emoji !== 'string') {
      return c.json<ApiResponse>({ ok: false, error: 'emoji is required' }, 400);
    }
    if (body.emoji.length > 32) {
      return c.json<ApiResponse>({ ok: false, error: 'emoji too long (max 32 chars)' }, 400);
    }

    // Verify participant
    const isMember = await conversationService.isParticipant(conversationId, user.imUserId);
    if (!isMember) {
      return c.json<ApiResponse>({ ok: false, error: 'Not a participant' }, 403);
    }

    // Verify message exists in this conversation
    const msg = await messageService.getById(messageId);
    if (!msg || msg.conversationId !== conversationId) {
      return c.json<ApiResponse>({ ok: false, error: 'Message not found' }, 404);
    }

    const action: 'add' | 'remove' = body.remove ? 'remove' : 'add';

    if (action === 'add') {
      // Idempotent insert. Prefer `create` + swallow P2002 (unique violation)
      // over `upsert`: Prisma's upsert does SELECT→INSERT/UPDATE which can
      // deadlock on concurrent writes hitting the same composite unique key
      // (observed on MySQL v1.8.2 regression: 1/5 parallel requests returned
      // 500). Plain INSERT with catch is atomic and never deadlocks.
      try {
        await prisma.iMMessageReaction.create({
          data: { messageId, userId: user.imUserId, emoji: body.emoji },
        });
      } catch (err: unknown) {
        // P2002 = unique constraint violation → reaction already exists → treat as success
        if (!(err && typeof err === 'object' && (err as { code?: string }).code === 'P2002')) {
          throw err;
        }
      }
    } else {
      // Idempotent delete (deleteMany returns count, never throws on 0 matches)
      await prisma.iMMessageReaction.deleteMany({
        where: { messageId, userId: user.imUserId, emoji: body.emoji },
      });
    }

    // Aggregate current reaction state for response + broadcast
    const allReactions = await prisma.iMMessageReaction.findMany({
      where: { messageId },
      select: { emoji: true, userId: true },
    });
    const reactions: Record<string, string[]> = {};
    for (const r of allReactions) {
      (reactions[r.emoji] ??= []).push(r.userId);
    }

    // Broadcast dedicated message.reaction event (NOT message.edit — that lies about the content changing)
    const event = ServerEvents.messageReaction({
      messageId,
      conversationId,
      emoji: body.emoji,
      userId: user.imUserId,
      action,
      reactions,
    });
    const participants = await conversationService.getParticipantIds(conversationId);
    for (const uid of participants) {
      rooms.sendToUser(uid, event);
    }

    return c.json<ApiResponse>({ ok: true, data: { reactions } });
  });

  /**
   * GET /api/messages/:conversationId/:messageId/partials?afterSeq=N
   *
   * v2.0 §4.4.7 — F5 hydration endpoint for streaming partial chunks.
   * Returns persisted `im_message_partials` rows for `messageId` with
   * `chunkSeq > afterSeq`, ordered ASC. The browser uses this on reload
   * to rebuild the half-written placeholder before the SSE catches up.
   *
   * Partials live for 24h then the scheduler.sweepMessagePartials reaper
   * clears them. A missing message → 404; a message with no partials
   * (already-completed stream) → `{ partials: [] }`.
   *
   * Query params:
   *   afterSeq — last seen chunkSeq (default 0)
   *   limit    — max chunks (1-500, default 500)
   *
   * 403 if caller is not a participant in the conversation.
   */
  router.get('/:conversationId/:messageId/partials', async (c) => {
    const user = c.get('user');
    const conversationId = c.req.param('conversationId');
    const messageId = c.req.param('messageId');
    const afterSeq = parseInt(c.req.query('afterSeq') ?? '0', 10);
    const limit = Math.min(parseInt(c.req.query('limit') ?? '500', 10), 500);

    if (!Number.isFinite(afterSeq) || afterSeq < 0) {
      return c.json<ApiResponse>({ ok: false, error: 'afterSeq must be a non-negative integer' }, 400);
    }

    // Participant check — same surface as POST /messages/:cid.
    const participant = await prisma.iMParticipant.findFirst({
      where: { conversationId, imUserId: user.imUserId, leftAt: null },
      select: { id: true },
    });
    if (!participant) {
      return c.json<ApiResponse>({ ok: false, error: 'Not a participant' }, 403);
    }

    try {
      const partials = await StreamService.getPartials(messageId, afterSeq, limit);
      const lastSeq = partials.length > 0 ? partials[partials.length - 1].chunkSeq : afterSeq;
      return c.json<ApiResponse>({
        ok: true,
        data: { messageId, partials, lastSeq },
      });
    } catch (err) {
      console.error('[Messages] /partials error:', err);
      return c.json<ApiResponse>({ ok: false, error: 'partial hydration failed' }, 500);
    }
  });

  return router;
}
