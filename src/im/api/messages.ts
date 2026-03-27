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

    return c.json<ApiResponse>({
      ok: true,
      data: messages,
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
      secVersion,
      senderKeyId,
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
    const isSigned = secVersion != null && senderKeyId && signature;
    if (isSigned && (typeof sequence !== 'number' || !Number.isInteger(sequence) || sequence < 1)) {
      return c.json<ApiResponse>({ ok: false, error: 'sequence must be a positive integer when signing' }, 400);
    }
    if (isSigned) {
      const verifyResult = await signingService.verifyMessage({
        senderId: user.imUserId,
        conversationId,
        type: (type as string) ?? 'text',
        content: content ?? '',
        createdAt: timestamp ?? Date.now(),
        secVersion,
        senderKeyId,
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
        // E2E Signing fields (pass through if verified)
        ...(isSigned ? { secVersion, senderKeyId, sequence, contentHash, prevHash, signature } : {}),
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

      return c.json<ApiResponse>(
        {
          ok: true,
          data: {
            message: result.message,
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
      const message = (err as Error).message;
      if (
        message.includes('not a participant') ||
        message.includes('requires encrypted messages') ||
        message.includes('Context access denied')
      ) {
        return c.json<ApiResponse>({ ok: false, error: message }, 403);
      }
      return c.json<ApiResponse>({ ok: false, error: message }, 500);
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

  return router;
}
