/**
 * Prismer IM — Conversations API
 */

import { Hono } from "hono";
import { authMiddleware } from "../auth/middleware";
import { ConversationService } from "../services/conversation.service";
import prisma from "../db";
import type { ApiResponse, ConversationStatus } from "../types/index";
import type { IMParticipant, IMConversation, IMUser, IMReadCursor } from "@prisma/client";

export function createConversationsRouter(conversationService: ConversationService) {
  const router = new Hono();

  // All routes require auth
  router.use("*", authMiddleware);

  /**
   * POST /api/conversations/direct — Create a 1:1 conversation
   */
  router.post("/direct", async (c) => {
    const user = c.get("user");
    const body = await c.req.json();
    const { otherUserId, metadata } = body;

    if (!otherUserId) {
      return c.json<ApiResponse>({ ok: false, error: "otherUserId is required" }, 400);
    }

    const conv = await conversationService.createDirect({
      createdBy: user.imUserId,
      otherUserId,
      metadata,
    });

    return c.json<ApiResponse>({ ok: true, data: conv }, 201);
  });

  /**
   * POST /api/conversations/group — Create a group conversation
   */
  router.post("/group", async (c) => {
    const user = c.get("user");
    const body = await c.req.json();
    const { title, description, memberIds, metadata } = body;

    if (!title) {
      return c.json<ApiResponse>({ ok: false, error: "title is required" }, 400);
    }

    const conv = await conversationService.createGroup({
      createdBy: user.imUserId,
      title,
      description,
      memberIds: memberIds ?? [],
      metadata,
    });

    return c.json<ApiResponse>({ ok: true, data: conv }, 201);
  });

  /**
   * GET /api/conversations — List user's conversations
   *
   * Query params:
   *   status     - Filter by status (default: active)
   *   withUnread - Include unread counts (default: false)
   *   unreadOnly - Only return conversations with unread messages
   */
  router.get("/", async (c) => {
    const user = c.get("user");
    const status = (c.req.query("status") ?? "active") as ConversationStatus;
    const withUnread = c.req.query("withUnread") === "true";
    const unreadOnly = c.req.query("unreadOnly") === "true";

    const conversations = await conversationService.listByUser(user.imUserId, status);

    let result = conversations.map((p: IMParticipant & { conversation: IMConversation }) => ({
      ...p.conversation,
      myRole: p.role,
      unreadCount: 0,
    }));

    // Calculate unread counts if requested
    if (withUnread || unreadOnly) {
      const readCursors = await prisma.iMReadCursor.findMany({
        where: { imUserId: user.imUserId },
      });
      const cursorMap = new Map(
        readCursors.map((rc: IMReadCursor) => [rc.conversationId, rc.lastReadAt])
      );

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
        })
      );

      if (unreadOnly) {
        result = result.filter((conv: IMConversation & { myRole: string; unreadCount: number }) => conv.unreadCount > 0);
      }
    }

    return c.json<ApiResponse>({
      ok: true,
      data: result,
    });
  });

  /**
   * GET /api/conversations/:id — Get conversation details
   */
  router.get("/:id", async (c) => {
    const user = c.get("user");
    const convId = c.req.param("id")!;

    const conv = await conversationService.getById(convId);
    if (!conv) {
      return c.json<ApiResponse>({ ok: false, error: "Conversation not found" }, 404);
    }

    // Check participation
    const isMember = await conversationService.isParticipant(convId, user.imUserId);
    if (!isMember) {
      return c.json<ApiResponse>({ ok: false, error: "Not a participant" }, 403);
    }

    const participants = await conversationService.getParticipants(convId);

    return c.json<ApiResponse>({
      ok: true,
      data: {
        ...conv,
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
      return c.json<ApiResponse>({ ok: false, error: "Not a participant" }, 403);
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
      return c.json<ApiResponse>({ ok: false, error: "Not a participant" }, 403);
    }

    // Get the latest message in this conversation
    const latestMessage = await prisma.iMMessage.findFirst({
      where: { conversationId: convId },
      orderBy: { createdAt: "desc" },
      select: { id: true, createdAt: true },
    });

    // Upsert read cursor
    await prisma.iMReadCursor.upsert({
      where: {
        conversationId_imUserId: {
          conversationId: convId,
          imUserId: user.imUserId,
        },
      },
      update: {
        lastReadAt: new Date(),
        lastReadMsgId: latestMessage?.id ?? null,
      },
      create: {
        conversationId: convId,
        imUserId: user.imUserId,
        lastReadAt: new Date(),
        lastReadMsgId: latestMessage?.id ?? null,
      },
    });

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
   * POST /api/conversations/:id/participants — Add participant
   */
  router.post("/:id/participants", async (c) => {
    const convId = c.req.param("id")!;
    const body = await c.req.json();
    const { userId, role } = body;

    if (!userId) {
      return c.json<ApiResponse>({ ok: false, error: "userId is required" }, 400);
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
