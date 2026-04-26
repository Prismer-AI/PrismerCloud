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
import type { ApiResponse, MessageType } from '../types/index';
import prisma from '../db';

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
    const conversationId = c.req.param('conversationId');

    // Check participation (use imUserId for resolved identity)
    const isMember = await conversationService.isParticipant(conversationId, user.imUserId);
    if (!isMember) {
      return c.json<ApiResponse>({ ok: false, error: 'Not a participant' }, 403);
    }

    const before = c.req.query('before') ?? undefined;
    const after = c.req.query('after') ?? undefined;
    const limit = parseInt(c.req.query('limit') ?? '50', 10);

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
    const conversationId = c.req.param('conversationId');
    const body = await c.req.json();

    const {
      type,
      content,
      metadata,
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

    if (!content && type !== 'tool_call' && type !== 'system_event') {
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

    // Support idempotency for offline SDK retries
    const idempotencyKey = c.req.header('X-Idempotency-Key');
    const enrichedMetadata = idempotencyKey ? { ...metadata, _idempotencyKey: idempotencyKey } : metadata;

    try {
      const result = await messageService.send({
        conversationId,
        senderId: user.imUserId,
        type: type as MessageType,
        content: content ?? '',
        metadata: enrichedMetadata,
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
        parentId: msg.parentId ?? undefined,
        createdAt: msg.createdAt instanceof Date ? msg.createdAt.toISOString() : String(msg.createdAt),
      });
      const participants = await conversationService.getParticipantIds(conversationId);
      for (const uid of participants) {
        rooms.sendToUser(uid, event);
      }

      // v1.8.2: Resolve quoted message summary if present
      const quotedMessage = await resolveQuotedMessage((result.message as any).quotedMessageId);

      return c.json<ApiResponse>(
        {
          ok: true,
          data: {
            message: { ...result.message, ...(quotedMessage ? { quotedMessage } : {}) },
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
    const conversationId = c.req.param('conversationId');
    const messageId = c.req.param('messageId');
    const body = await c.req.json();

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
   * DELETE /api/messages/:conversationId/:messageId — Delete a message
   */
  router.delete('/:conversationId/:messageId', async (c) => {
    const user = c.get('user');
    const conversationId = c.req.param('conversationId');
    const messageId = c.req.param('messageId');

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

  return router;
}
