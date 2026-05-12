/**
 * Prismer IM — Conversations API
 */

import { Hono } from 'hono';
import { authMiddleware } from '../auth/middleware';
import { ConversationService } from '../services/conversation.service';
import prisma from '../db';
import type { ApiResponse, ConversationStatus } from '../types/index';
import type { IMParticipant, IMConversation, IMUser, IMReadCursor } from '@prisma/client';
import type { RoomManager } from '../ws/rooms';
import { ServerEvents } from '../ws/events';

type ConversationParticipantLite = {
  imUserId: string;
  role: string;
  imUser: {
    id: string;
    username: string;
    displayName: string;
    role: string;
    agentType: string | null;
  };
};

function directDisplayTitle(
  conv: IMConversation & { participants?: ConversationParticipantLite[] },
  viewerImUserId: string,
): string | null {
  const directLike =
    conv.type === 'direct' ||
    (conv.type === 'group' && conv.participants?.length === 2 && /^direct\s*[·:|-]/i.test(conv.title ?? ''));
  const others = conv.participants?.filter((p) => p.imUserId !== viewerImUserId) ?? [];
  if (directLike) {
    const other = others[0]?.imUser;
    return other?.displayName || other?.username || conv.title || null;
  }
  if (conv.title?.trim()) return conv.title.trim();
  if (conv.type !== 'group') return conv.title;
  const names = others.map((p) => p.imUser.displayName || p.imUser.username).filter(Boolean);
  if (names.length === 0) return 'Group session';
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 3).join(', ')} +${names.length - 3}`;
}

function serializeConversationParticipant(participant: ConversationParticipantLite) {
  return {
    userId: participant.imUser.id,
    username: participant.imUser.username,
    displayName: participant.imUser.displayName,
    role: participant.role,
    userRole: participant.imUser.role,
    agentType: participant.imUser.agentType,
  };
}

export function createConversationsRouter(conversationService: ConversationService, rooms?: RoomManager) {
  const router = new Hono();

  // All routes require auth
  router.use('*', authMiddleware);

  /**
   * POST /api/conversations/direct — Create a 1:1 conversation
   */
  router.post('/direct', async (c) => {
    const user = c.get('user');
    const body = await c.req.json();
    const { otherUserId, metadata } = body;
    let { workspaceId } = body as { workspaceId?: string };

    if (!otherUserId) {
      return c.json<ApiResponse>({ ok: false, error: 'otherUserId is required' }, 400);
    }

    // Keep direct workspace sessions aligned with group creation and task
    // projection: callers may pass an explicit workspaceId, otherwise direct
    // sessions land in the human owner's default workspace when one exists.
    if (!workspaceId) {
      const defaultWs = await prisma.iMWorkspace.findFirst({
        where: { ownerImUserId: user.imUserId, isDefault: true, deletedAt: null },
        select: { id: true },
      });
      if (defaultWs) workspaceId = defaultWs.id;
    }

    const conv = await conversationService.createDirect({
      createdBy: user.imUserId,
      otherUserId,
      workspaceId,
      metadata,
    });
    const participants = (await conversationService.getParticipants(conv.id)) as ConversationParticipantLite[];
    const convWithParticipants = { ...conv, participants };
    const displayTitle = directDisplayTitle(convWithParticipants, user.imUserId);

    return c.json<ApiResponse>(
      {
        ok: true,
        data: {
          ...conv,
          title: displayTitle,
          displayTitle,
          participants: participants.map(serializeConversationParticipant),
        },
      },
      201,
    );
  });

  /**
   * POST /api/conversations/group — Create a group conversation
   */
  router.post('/group', async (c) => {
    const user = c.get('user');
    const body = await c.req.json();
    const { title, description, memberIds, metadata } = body;

    if (!title) {
      return c.json<ApiResponse>({ ok: false, error: 'title is required' }, 400);
    }

    const conv = await conversationService.createGroup({
      createdBy: user.imUserId,
      title,
      description,
      memberIds: memberIds ?? [],
      metadata,
    });
    const participants = (await conversationService.getParticipants(conv.id)) as ConversationParticipantLite[];
    const convWithParticipants = { ...conv, participants };
    const displayTitle = directDisplayTitle(convWithParticipants, user.imUserId);

    return c.json<ApiResponse>(
      {
        ok: true,
        data: {
          ...conv,
          title: displayTitle,
          displayTitle,
          participants: participants.map(serializeConversationParticipant),
        },
      },
      201,
    );
  });

  /**
   * GET /api/conversations — List user's conversations
   *
   * Query params:
   *   status      - Filter by status (default: active)
   *   withUnread  - Include unread counts (default: false)
   *   unreadOnly  - Only return conversations with unread messages
   *
   * Note: `workspaceId` query param is accepted for backwards compatibility
   * but ignored. The participant table is the auth gate — a user sees every
   * conversation they're a current participant in, regardless of which
   * workspace the creator stamped on it. (Cross-workspace invites would
   * otherwise be hidden from recipients.)
   */
  router.get('/', async (c) => {
    const user = c.get('user');
    const status = (c.req.query('status') ?? 'active') as ConversationStatus;
    const withUnread = c.req.query('withUnread') === 'true';
    const unreadOnly = c.req.query('unreadOnly') === 'true';

    const conversations = await conversationService.listByUser(user.imUserId, status);

    let result = conversations.map(
      (p: IMParticipant & { conversation: IMConversation & { participants?: ConversationParticipantLite[] } }) => {
        const displayTitle = directDisplayTitle(p.conversation, user.imUserId);
        return {
          ...p.conversation,
          title: displayTitle,
          displayTitle,
          participants: p.conversation.participants?.map(serializeConversationParticipant),
          myRole: p.role,
          pinned: p.pinned,
          muted: p.muted,
          pinnedAt: p.pinnedAt,
          unreadCount: 0,
        };
      },
    );

    // Calculate unread counts if requested
    if (withUnread || unreadOnly) {
      const readCursors = await prisma.iMReadCursor.findMany({
        where: { imUserId: user.imUserId },
      });
      const cursorMap = new Map(readCursors.map((rc: IMReadCursor) => [rc.conversationId, rc.lastReadAt]));

      result = await Promise.all(
        result.map(async (conv: IMConversation & { myRole: string; unreadCount: number }) => {
          const lastReadAt = cursorMap.get(conv.id);
          const unreadCount = await prisma.iMMessage.count({
            where: {
              conversationId: conv.id,
              senderId: { not: user.imUserId },
              ...(lastReadAt ? { createdAt: { gt: lastReadAt } } : {}),
            },
          });
          return { ...conv, unreadCount };
        }),
      );

      if (unreadOnly) {
        result = result.filter(
          (conv: IMConversation & { myRole: string; unreadCount: number }) => conv.unreadCount > 0,
        );
      }
    }

    result.sort((a: any, b: any) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      if (a.pinned && b.pinned) {
        return (b.pinnedAt?.getTime() ?? 0) - (a.pinnedAt?.getTime() ?? 0);
      }
      const aTime = a.lastMessageAt?.getTime?.() ?? a.updatedAt?.getTime?.() ?? 0;
      const bTime = b.lastMessageAt?.getTime?.() ?? b.updatedAt?.getTime?.() ?? 0;
      return bTime - aTime;
    });

    return c.json<ApiResponse>({
      ok: true,
      data: result,
    });
  });

  /**
   * GET /api/conversations/:id — Get conversation details
   *
   * Mirrors the list endpoint's viewer-flag enrichment so a single-conversation
   * refresh (e.g. after toggling Mute/Pin) gives the UI the same `myRole /
   * pinned / muted / pinnedAt` fields it would have read from the list. Mute
   * and pin are participant-level, not conversation-level — we resolve them
   * from the caller's IMParticipant row.
   */
  router.get("/:id", async (c) => {
    const user = c.get("user");
    const convId = c.req.param("id")!;

    const conv = await conversationService.getById(convId);
    if (!conv) {
      return c.json<ApiResponse>({ ok: false, error: 'Conversation not found' }, 404);
    }

    const viewerParticipant = await prisma.iMParticipant.findUnique({
      where: { conversationId_imUserId: { conversationId: convId, imUserId: user.imUserId } },
    });
    if (!viewerParticipant || viewerParticipant.leftAt) {
      return c.json<ApiResponse>({ ok: false, error: 'Not a participant' }, 403);
    }

    const participants = await conversationService.getParticipants(convId);
    const convWithParticipants = {
      ...conv,
      participants: participants as ConversationParticipantLite[],
    };
    const displayTitle = directDisplayTitle(convWithParticipants, user.imUserId);

    return c.json<ApiResponse>({
      ok: true,
      data: {
        ...conv,
        title: displayTitle,
        displayTitle,
        myRole: viewerParticipant.role,
        pinned: viewerParticipant.pinned,
        muted: viewerParticipant.muted,
        pinnedAt: viewerParticipant.pinnedAt,
        participants: participants.map((p: IMParticipant & { imUser: IMUser }) => ({
          id: p.id,
          role: p.role,
          joinedAt: p.joinedAt,
          user: {
            id: p.imUser.id,
            username: p.imUser.username,
            displayName: p.imUser.displayName,
            role: p.imUser.role,
            agentType: p.imUser.agentType,
          },
        })),
      },
    });
  });

  /**
   * PATCH /api/conversations/:id — Update conversation
   */
  router.patch("/:id", async (c) => {
    const user = c.get("user");
    const convId = c.req.param("id")!;
    const body = await c.req.json();

    const isMember = await conversationService.isParticipant(convId, user.imUserId);
    if (!isMember) {
      return c.json<ApiResponse>({ ok: false, error: 'Not a participant' }, 403);
    }

    const updated = await conversationService.update(convId, body);
    return c.json<ApiResponse>({ ok: true, data: updated });
  });

  /**
   * POST /api/conversations/:id/read — Mark conversation as read
   */
  router.post("/:id/read", async (c) => {
    const user = c.get("user");
    const convId = c.req.param("id")!;

    // Verify participation
    const isMember = await conversationService.isParticipant(convId, user.imUserId);
    if (!isMember) {
      return c.json<ApiResponse>({ ok: false, error: 'Not a participant' }, 403);
    }

    // Get the latest message in this conversation
    const latestMessage = await prisma.iMMessage.findFirst({
      where: { conversationId: convId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true },
    });

    // Upsert read cursor
    const now = new Date();
    await prisma.iMReadCursor.upsert({
      where: {
        conversationId_imUserId: {
          conversationId: convId,
          imUserId: user.imUserId,
        },
      },
      update: {
        lastReadAt: now,
        lastReadMsgId: latestMessage?.id ?? null,
      },
      create: {
        conversationId: convId,
        imUserId: user.imUserId,
        lastReadAt: now,
        lastReadMsgId: latestMessage?.id ?? null,
      },
    });

    if (rooms) {
      rooms.broadcastToRoom(
        convId,
        ServerEvents.messageRead({
          conversationId: convId,
          readBy: user.imUserId,
          readAt: now.toISOString(),
          lastReadMessageId: latestMessage?.id,
        }),
        user.imUserId,
      );
    }

    return c.json<ApiResponse>({ ok: true });
  });

  /**
   * POST /api/conversations/:id/archive — Archive conversation
   */
  router.post("/:id/archive", async (c) => {
    const convId = c.req.param("id")!;
    const updated = await conversationService.archive(convId);
    return c.json<ApiResponse>({ ok: true, data: updated });
  });

  /**
   * PATCH /api/conversations/:id/pin — Toggle pin
   */
  router.patch('/:id/pin', async (c) => {
    const user = c.get('user');
    const convId = c.req.param('id');
    const { pinned } = await c.req.json();

    await prisma.iMParticipant.update({
      where: { conversationId_imUserId: { conversationId: convId, imUserId: user.imUserId } },
      data: { pinned: !!pinned, pinnedAt: pinned ? new Date() : null },
    });

    return c.json<ApiResponse>({ ok: true });
  });

  /**
   * PATCH /api/conversations/:id/mute — Toggle mute
   */
  router.patch('/:id/mute', async (c) => {
    const user = c.get('user');
    const convId = c.req.param('id');
    const { muted } = await c.req.json();

    await prisma.iMParticipant.update({
      where: { conversationId_imUserId: { conversationId: convId, imUserId: user.imUserId } },
      data: { muted: !!muted },
    });

    return c.json<ApiResponse>({ ok: true });
  });

  /**
   * POST /api/conversations/:id/unarchive — Restore archived conversation
   */
  router.post('/:id/unarchive', async (c) => {
    const user = c.get('user');
    const convId = c.req.param('id');

    const participant = await prisma.iMParticipant.findUnique({
      where: { conversationId_imUserId: { conversationId: convId, imUserId: user.imUserId } },
    });
    if (!participant) {
      return c.json<ApiResponse>({ ok: false, error: 'Not a participant' }, 403);
    }

    await prisma.iMConversation.update({
      where: { id: convId },
      data: { status: 'active' },
    });

    return c.json<ApiResponse>({ ok: true });
  });

  /**
   * DELETE /api/conversations/:id — Soft-delete (leave conversation)
   */
  router.delete('/:id', async (c) => {
    const user = c.get('user');
    const convId = c.req.param('id');

    await prisma.iMParticipant.update({
      where: { conversationId_imUserId: { conversationId: convId, imUserId: user.imUserId } },
      data: { leftAt: new Date() },
    });

    return c.json<ApiResponse>({ ok: true });
  });

  /**
   * POST /api/conversations/:id/participants — Add participant
   */
  router.post("/:id/participants", async (c) => {
    const convId = c.req.param("id")!;
    const body = await c.req.json();
    const { userId, role } = body;

    if (!userId) {
      return c.json<ApiResponse>({ ok: false, error: 'userId is required' }, 400);
    }

    const participant = await conversationService.addParticipant(convId, userId, role);
    return c.json<ApiResponse>({ ok: true, data: participant }, 201);
  });

  /**
   * DELETE /api/conversations/:id/participants/:userId — Remove participant
   */
  router.delete("/:id/participants/:userId", async (c) => {
    const convId = c.req.param("id")!;
    const userId = c.req.param("userId")!;

    const removed = await conversationService.removeParticipant(convId, userId);
    return c.json<ApiResponse>({ ok: true, data: removed });
  });

  return router;
}
