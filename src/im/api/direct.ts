/**
 * Prismer IM — Direct Messages API
 *
 * Simplified API for 1:1 messaging. Auto-creates conversation if not exists.
 *
 * Usage:
 *   POST /api/direct/{targetUserId}/messages
 *   Authorization: Bearer sk-prismer-xxx  (or JWT)
 *   {"content": "Hello!"}
 *
 * This will:
 *   1. Auto-create IM User for sender (via middleware)
 *   2. Auto-create IM User for target (if not exists)
 *   3. Auto-create direct conversation (if not exists)
 *   4. Send message
 */

import { Hono } from 'hono';
import { authMiddleware } from '../auth/middleware';
import { MessageService } from '../services/message.service';
import { ConversationService } from '../services/conversation.service';
import type { CreditService } from '../services/credit.service';
import type { RoomManager } from '../ws/rooms';
import { ServerEvents } from '../ws/events';
import prisma from '../db';
import type { SigningService } from '../services/signing.service';
import type { RateLimiterService } from '../services/rate-limiter.service';
import { createRateLimitMiddleware } from '../middleware/rate-limit';
import type { ApiResponse, MessageType } from '../types/index';
import { resolveTargetUser } from '../utils/resolve-user';

export function createDirectRouter(
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
   * Get or create a direct conversation between two users.
   * Uses ConversationService.createDirect() so sync events fire.
   */
  async function getOrCreateDirectConversation(userId1: string, userId2: string): Promise<string> {
    // Find existing direct conversation between the two users
    const existing = await prisma.iMConversation.findFirst({
      where: {
        type: 'direct',
        AND: [{ participants: { some: { imUserId: userId1 } } }, { participants: { some: { imUserId: userId2 } } }],
      },
    });

    if (existing) return existing.id;

    // Create via ConversationService (writes sync events)
    const conv = await conversationService.createDirect({
      createdBy: userId1,
      otherUserId: userId2,
      metadata: { autoCreated: true },
    });

    return conv.id;
  }

  /**
   * POST /api/direct/:targetUserId/messages — Send a direct message
   *
   * Auto-creates conversation if not exists.
   */
  if (rateLimiter) {
    router.post('/:targetUserId/messages', createRateLimitMiddleware(rateLimiter, 'message.send'));
  }
  router.post('/:targetUserId/messages', async (c) => {
    const user = c.get('user');
    const targetUserId = c.req.param('targetUserId')!;

    let body: any;
    try {
      body = await c.req.json();
    } catch (e) {
      return c.json<ApiResponse>({ ok: false, error: 'Invalid JSON body' }, 400);
    }

    const { type, content, metadata, secVersion, senderKeyId, sequence, contentHash, prevHash, signature, timestamp } =
      body;

    if (!content && type !== 'system_event') {
      return c.json<ApiResponse>({ ok: false, error: 'content is required' }, 400);
    }

    // Resolve target user
    const targetImUserId = await resolveTargetUser(targetUserId);
    if (!targetImUserId) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: `User not found: ${targetUserId}. They need to register first.`,
        },
        404,
      );
    }

    // Can't message yourself
    if (targetImUserId === user.imUserId) {
      return c.json<ApiResponse>({ ok: false, error: 'Cannot send message to yourself' }, 400);
    }

    // Deduct IM credits (skip for API Key proxy — cloud credits handle it)
    if (user.type !== 'api_key_proxy') {
      const deductResult = await creditService.deduct(user.imUserId, 0.001, `send: direct/${targetUserId}`, 'message');
      if (!deductResult.success) {
        return c.json<ApiResponse>({ ok: false, error: 'Insufficient IM credits' }, 402);
      }
    }

    // Support idempotency for offline SDK retries
    const idempotencyKey = c.req.header('X-Idempotency-Key');
    const enrichedMetadata = idempotencyKey ? { ...metadata, _idempotencyKey: idempotencyKey } : metadata;

    // Get or create direct conversation
    const conversationId = await getOrCreateDirectConversation(user.imUserId, targetImUserId);

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

    // Send message
    let result;
    try {
      result = await messageService.send({
        conversationId,
        senderId: user.imUserId,
        type: (type as MessageType) ?? 'text',
        content: content ?? '',
        metadata: enrichedMetadata,
        ...(isSigned ? { secVersion, senderKeyId, sequence, contentHash, prevHash, signature } : {}),
      });
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

    // Push to both participants via sendToUser (works cross-pod via Redis)
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
    rooms.sendToUser(user.imUserId, event);
    rooms.sendToUser(targetImUserId, event);

    return c.json<ApiResponse>(
      {
        ok: true,
        data: {
          conversationId,
          message: result.message,
          routing: result.routing,
        },
      },
      201,
    );
  });

  /**
   * GET /api/direct/:targetUserId/messages — Get direct message history
   */
  router.get('/:targetUserId/messages', async (c) => {
    const user = c.get('user');
    const targetUserId = c.req.param('targetUserId')!;

    // Resolve target user
    const targetImUserId = await resolveTargetUser(targetUserId);
    if (!targetImUserId) {
      return c.json<ApiResponse>({ ok: false, error: `User not found: ${targetUserId}` }, 404);
    }

    // Find existing conversation
    const conv = await prisma.iMConversation.findFirst({
      where: {
        type: 'direct',
        AND: [
          { participants: { some: { imUserId: user.imUserId } } },
          { participants: { some: { imUserId: targetImUserId } } },
        ],
      },
    });

    if (!conv) {
      return c.json<ApiResponse>({
        ok: true,
        data: [],
        meta: { total: 0 },
      });
    }

    const limit = parseInt(c.req.query('limit') ?? '50', 10);
    const messages = await messageService.getHistory({
      conversationId: conv.id,
      limit,
    });

    const total = await messageService.getCount(conv.id);

    return c.json<ApiResponse>({
      ok: true,
      data: messages,
      meta: { total, conversationId: conv.id },
    });
  });

  /**
   * GET /api/direct/:targetUserId — Get direct conversation info
   */
  router.get('/:targetUserId', async (c) => {
    const user = c.get('user');
    const targetUserId = c.req.param('targetUserId')!;

    // Resolve target user
    const targetImUserId = await resolveTargetUser(targetUserId);
    if (!targetImUserId) {
      return c.json<ApiResponse>({ ok: false, error: `User not found: ${targetUserId}` }, 404);
    }

    // Find existing conversation
    const conv = await prisma.iMConversation.findFirst({
      where: {
        type: 'direct',
        AND: [
          { participants: { some: { imUserId: user.imUserId } } },
          { participants: { some: { imUserId: targetImUserId } } },
        ],
      },
      include: {
        participants: { include: { imUser: true } },
      },
    });

    if (!conv) {
      return c.json<ApiResponse>({
        ok: true,
        data: { exists: false, targetUserId: targetImUserId },
      });
    }

    return c.json<ApiResponse>({
      ok: true,
      data: {
        exists: true,
        conversationId: conv.id,
        participants: conv.participants.map((p: (typeof conv.participants)[number]) => ({
          userId: p.imUser.id,
          username: p.imUser.username,
          displayName: p.imUser.displayName,
        })),
      },
    });
  });

  return router;
}
