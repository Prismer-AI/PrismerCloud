/**
 * Prismer IM — Groups API
 *
 * Simplified API for group messaging. Uses familiar naming convention.
 *
 * Usage:
 *   POST /api/groups  — Create a group
 *   POST /api/groups/{groupId}/messages — Send message to group
 *   POST /api/groups/{groupId}/members — Add member
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

export function createGroupsRouter(
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
   * POST /api/groups — Create a new group
   */
  if (rateLimiter) {
    router.post('/', createRateLimitMiddleware(rateLimiter, 'conversation.create'));
  }
  router.post('/', async (c) => {
    const user = c.get('user');
    const body = await c.req.json();
    const { title, description, members, metadata } = body;

    if (!title) {
      return c.json<ApiResponse>({ ok: false, error: 'title is required' }, 400);
    }

    // Resolve member IDs
    const resolvedMembers: string[] = [];
    if (members && Array.isArray(members)) {
      for (const member of members) {
        const memberId = await resolveTargetUser(member);
        if (memberId && memberId !== user.imUserId) {
          resolvedMembers.push(memberId);
        }
      }
    }

    // Create via ConversationService (writes sync events)
    const conv = await conversationService.createGroup({
      createdBy: user.imUserId,
      title,
      description,
      memberIds: resolvedMembers,
      metadata,
    });

    // Fetch full group info
    const fullConv = await prisma.iMConversation.findUnique({
      where: { id: conv.id },
      include: {
        participants: { include: { imUser: true } },
      },
    });

    return c.json<ApiResponse>(
      {
        ok: true,
        data: {
          groupId: conv.id,
          title,
          description,
          members: fullConv?.participants.map((p: NonNullable<typeof fullConv>['participants'][number]) => ({
            userId: p.imUser.id,
            username: p.imUser.username,
            displayName: p.imUser.displayName,
            role: p.role,
          })),
        },
      },
      201,
    );
  });

  /**
   * GET /api/groups — List my groups
   */
  router.get('/', async (c) => {
    const user = c.get('user');

    const groups = await prisma.iMParticipant.findMany({
      where: {
        imUserId: user.imUserId,
        conversation: { type: 'group', status: 'active' },
      },
      include: {
        conversation: {
          include: {
            participants: { include: { imUser: true } },
          },
        },
      },
    });

    return c.json<ApiResponse>({
      ok: true,
      data: groups.map((g: (typeof groups)[number]) => ({
        groupId: g.conversation.id,
        title: g.conversation.title,
        description: g.conversation.description,
        myRole: g.role,
        memberCount: g.conversation.participants.length,
      })),
    });
  });

  /**
   * GET /api/groups/:groupId — Get group details
   */
  router.get('/:groupId', async (c) => {
    const user = c.get('user');
    const groupId = c.req.param('groupId');

    // Check membership
    const isMember = await conversationService.isParticipant(groupId, user.imUserId);
    if (!isMember) {
      return c.json<ApiResponse>({ ok: false, error: 'Not a member of this group' }, 403);
    }

    const group = await prisma.iMConversation.findUnique({
      where: { id: groupId },
      include: {
        participants: { include: { imUser: true } },
      },
    });

    if (!group || group.type !== 'group') {
      return c.json<ApiResponse>({ ok: false, error: 'Group not found' }, 404);
    }

    return c.json<ApiResponse>({
      ok: true,
      data: {
        groupId: group.id,
        title: group.title,
        description: group.description,
        members: group.participants.map((p: (typeof group.participants)[number]) => ({
          userId: p.imUser.id,
          username: p.imUser.username,
          displayName: p.imUser.displayName,
          role: p.role,
        })),
      },
    });
  });

  /**
   * POST /api/groups/:groupId/messages — Send message to group
   */
  if (rateLimiter) {
    router.post('/:groupId/messages', createRateLimitMiddleware(rateLimiter, 'message.send'));
  }
  router.post('/:groupId/messages', async (c) => {
    const user = c.get('user');
    const groupId = c.req.param('groupId');
    const body = await c.req.json();

    const { type, content, metadata, secVersion, senderKeyId, sequence, contentHash, prevHash, signature, timestamp } =
      body;

    if (!content && type !== 'system_event') {
      return c.json<ApiResponse>({ ok: false, error: 'content is required' }, 400);
    }

    // Check membership
    const isMember = await conversationService.isParticipant(groupId, user.imUserId);
    if (!isMember) {
      return c.json<ApiResponse>({ ok: false, error: 'Not a member of this group' }, 403);
    }

    // E2E Signing verification (Layer 2)
    const isSigned = secVersion != null && senderKeyId && signature;
    if (isSigned && (typeof sequence !== 'number' || !Number.isInteger(sequence) || sequence < 1)) {
      return c.json<ApiResponse>({ ok: false, error: 'sequence must be a positive integer when signing' }, 400);
    }
    if (isSigned) {
      const verifyResult = await signingService.verifyMessage({
        senderId: user.imUserId,
        conversationId: groupId,
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
      const policy = await signingService.getSigningPolicy(groupId);
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
      const deductResult = await creditService.deduct(user.imUserId, 0.001, `send: group/${groupId}`, 'message');
      if (!deductResult.success) {
        return c.json<ApiResponse>({ ok: false, error: 'Insufficient IM credits' }, 402);
      }
    }

    // Support idempotency for offline SDK retries
    const idempotencyKey = c.req.header('X-Idempotency-Key');
    const enrichedMetadata = idempotencyKey ? { ...metadata, _idempotencyKey: idempotencyKey } : metadata;

    // Send message
    let result;
    try {
      result = await messageService.send({
        conversationId: groupId,
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

    // Push to all group members via sendToUser (works cross-pod via Redis)
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
      conversationId: groupId,
      senderId: msg.senderId,
      type: msg.type as any,
      content: msg.content,
      metadata: messageMetadata,
      parentId: msg.parentId ?? undefined,
      createdAt: msg.createdAt instanceof Date ? msg.createdAt.toISOString() : String(msg.createdAt),
    });
    const participants = await conversationService.getParticipantIds(groupId);
    for (const uid of participants) {
      rooms.sendToUser(uid, event);
    }

    return c.json<ApiResponse>(
      {
        ok: true,
        data: {
          message: result.message,
          routing: result.routing,
        },
      },
      201,
    );
  });

  /**
   * GET /api/groups/:groupId/messages — Get group message history
   */
  router.get('/:groupId/messages', async (c) => {
    const user = c.get('user');
    const groupId = c.req.param('groupId');

    // Check membership
    const isMember = await conversationService.isParticipant(groupId, user.imUserId);
    if (!isMember) {
      return c.json<ApiResponse>({ ok: false, error: 'Not a member of this group' }, 403);
    }

    const limit = parseInt(c.req.query('limit') ?? '50', 10);
    const messages = await messageService.getHistory({
      conversationId: groupId,
      limit,
    });

    const total = await messageService.getCount(groupId);

    return c.json<ApiResponse>({
      ok: true,
      data: messages,
      meta: { total },
    });
  });

  /**
   * POST /api/groups/:groupId/members — Add member to group
   */
  router.post('/:groupId/members', async (c) => {
    const user = c.get('user');
    const groupId = c.req.param('groupId');
    const body = await c.req.json();
    const { userId, role } = body;

    if (!userId) {
      return c.json<ApiResponse>({ ok: false, error: 'userId is required' }, 400);
    }

    // Check if requester is owner/admin
    const participant = await prisma.iMParticipant.findUnique({
      where: {
        conversationId_imUserId: { conversationId: groupId, imUserId: user.imUserId },
      },
    });

    if (!participant || !['owner', 'admin'].includes(participant.role)) {
      return c.json<ApiResponse>({ ok: false, error: 'Only owner/admin can add members' }, 403);
    }

    // Resolve user
    const targetUserId = await resolveTargetUser(userId);
    if (!targetUserId) {
      return c.json<ApiResponse>({ ok: false, error: `User not found: ${userId}` }, 404);
    }

    // Add member via ConversationService (writes sync events)
    const newParticipant = await conversationService.addParticipant(groupId, targetUserId, role ?? 'member');

    return c.json<ApiResponse>({ ok: true, data: newParticipant }, 201);
  });

  /**
   * DELETE /api/groups/:groupId/members/:userId — Remove member from group
   */
  router.delete('/:groupId/members/:userId', async (c) => {
    const user = c.get('user');
    const groupId = c.req.param('groupId');
    const targetUserId = c.req.param('userId');

    // Resolve target
    const resolvedUserId = await resolveTargetUser(targetUserId);
    if (!resolvedUserId) {
      return c.json<ApiResponse>({ ok: false, error: `User not found: ${targetUserId}` }, 404);
    }

    // Check if requester is owner/admin or removing self
    const participant = await prisma.iMParticipant.findUnique({
      where: {
        conversationId_imUserId: { conversationId: groupId, imUserId: user.imUserId },
      },
    });

    const isSelf = resolvedUserId === user.imUserId;
    const isAdmin = participant && ['owner', 'admin'].includes(participant.role);

    if (!isSelf && !isAdmin) {
      return c.json<ApiResponse>({ ok: false, error: 'Permission denied' }, 403);
    }

    await conversationService.removeParticipant(groupId, resolvedUserId);

    return c.json<ApiResponse>({ ok: true });
  });

  return router;
}
