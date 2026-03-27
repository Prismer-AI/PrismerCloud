/**
 * Prismer IM — Self-Awareness API
 *
 * GET /api/im/me — Agent/User self-awareness endpoint
 * Returns identity, agent card, and usage statistics.
 */

import { Hono } from "hono";
import { authMiddleware } from "../auth/middleware";
import prisma from "../db";
import type { CreditService } from "../services/credit.service";
import type { ApiResponse, BindingPlatform } from "../types/index";

export function createMeRouter(creditService: CreditService) {
  const router = new Hono();

  router.use("*", authMiddleware);

  /**
   * GET /me — Get current user's full profile + stats
   */
  router.get("/", async (c) => {
    const authUser = c.get("user");
    const imUserId = authUser.imUserId;

    // Fetch user with agent card
    const user = await prisma.iMUser.findUnique({
      where: { id: imUserId },
      include: { agentCard: true },
    });

    if (!user) {
      return c.json<ApiResponse>({ ok: false, error: "User not found" }, 404);
    }

    // Count conversations (active, not left)
    const participations = await prisma.iMParticipant.findMany({
      where: { imUserId, leftAt: null },
      include: { conversation: { select: { type: true, status: true } } },
    });

    type Participation = typeof participations[number];
    const activeParticipations = participations.filter(
      (p: Participation) => p.conversation.status === "active"
    );
    const directCount = activeParticipations.filter(
      (p: Participation) => p.conversation.type === "direct"
    ).length;
    const groupCount = activeParticipations.filter(
      (p: Participation) => p.conversation.type === "group"
    ).length;

    // Count distinct contacts (other users in my conversations)
    const myConversationIds = activeParticipations.map((p: Participation) => p.conversationId);
    let contactCount = 0;
    if (myConversationIds.length > 0) {
      const contacts = await prisma.iMParticipant.findMany({
        where: {
          conversationId: { in: myConversationIds },
          imUserId: { not: imUserId },
          leftAt: null,
        },
        select: { imUserId: true },
        distinct: ["imUserId"],
      });
      contactCount = contacts.length;
    }

    // Count messages sent
    const messagesSent = await prisma.iMMessage.count({
      where: { senderId: imUserId },
    });

    // Count unread messages
    let unreadCount = 0;
    if (myConversationIds.length > 0) {
      // Get read cursors for all conversations
      const readCursors = await prisma.iMReadCursor.findMany({
        where: { imUserId },
      });
      const cursorMap = new Map(
        readCursors.map((rc: typeof readCursors[number]) => [rc.conversationId, rc.lastReadAt])
      );

      // For each conversation, count messages after last read
      for (const convId of myConversationIds) {
        const lastReadAt = cursorMap.get(convId);
        const count = await prisma.iMMessage.count({
          where: {
            conversationId: convId,
            senderId: { not: imUserId },
            ...(lastReadAt ? { createdAt: { gt: lastReadAt } } : {}),
          },
        });
        unreadCount += count;
      }
    }

    // Build response
    const response: Record<string, unknown> = {
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        agentType: user.agentType,
        avatarUrl: user.avatarUrl,
        createdAt: user.createdAt,
      },
      stats: {
        conversationCount: activeParticipations.length,
        directCount,
        groupCount,
        contactCount,
        messagesSent,
        unreadCount,
      },
    };

    // Add agent card if exists
    if (user.agentCard) {
      let capabilities: string[] = [];
      try {
        capabilities = JSON.parse(user.agentCard.capabilities);
      } catch { /* empty */ }

      response.agentCard = {
        capabilities,
        description: user.agentCard.description,
        status: user.agentCard.status,
        endpoint: user.agentCard.endpoint,
        agentType: user.agentCard.agentType,
      };
    }

    // v0.3.0: Add bindings
    const bindings = await prisma.iMBinding.findMany({
      where: { imUserId },
    });
    response.bindings = bindings.map((b: typeof bindings[number]) => ({
      platform: b.platform as BindingPlatform,
      status: b.status,
      externalName: b.externalName,
    }));

    // v0.3.0: Add credits
    try {
      const credits = await creditService.getBalance(imUserId);
      response.credits = {
        balance: credits.balance,
        totalSpent: credits.totalSpent,
      };
    } catch {
      response.credits = null;
    }

    return c.json<ApiResponse>({ ok: true, data: response });
  });

  return router;
}
