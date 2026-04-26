/**
 * Prismer IM — Contacts & Discovery API
 *
 * GET /api/im/contacts  — List contacts (users I've chatted with)
 * GET /api/im/discover  — Discover available agents by capability/type
 */

import { Hono } from 'hono';
import { authMiddleware } from '../auth/middleware';
import prisma from '../db';
import type { ApiResponse } from '../types/index';

export function createContactsRouter() {
  const router = new Hono();

  router.use('*', authMiddleware);

  /**
   * GET /contacts — My contacts (users I've had conversations with)
   *
   * Query params:
   *   role    - Filter by role (human | agent)
   *   limit   - Max results (default 50)
   *   offset  - Skip N results (default 0)
   */
  router.get('/', async (c) => {
    const authUser = c.get('user');
    const imUserId = authUser.imUserId;

    const roleFilter = c.req.query('role');
    const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 200);
    const offset = parseInt(c.req.query('offset') ?? '0', 10);

    // Get my active conversation IDs
    const myParticipations = await prisma.iMParticipant.findMany({
      where: { imUserId, leftAt: null },
      select: { conversationId: true },
    });
    const myConversationIds = myParticipations.map((p: { conversationId: string }) => p.conversationId);

    if (myConversationIds.length === 0) {
      return c.json<ApiResponse>({
        ok: true,
        data: [],
        meta: { total: 0, limit, offset },
      });
    }

    // Find other users in those conversations
    const otherParticipants = await prisma.iMParticipant.findMany({
      where: {
        conversationId: { in: myConversationIds },
        imUserId: { not: imUserId },
        leftAt: null,
      },
      include: {
        imUser: true,
        conversation: {
          select: { id: true, type: true, lastMessageAt: true },
        },
      },
    });

    // Deduplicate by user, keeping the conversation with the most recent message
    const contactMap = new Map<string, (typeof otherParticipants)[0]>();
    for (const p of otherParticipants) {
      const existing = contactMap.get(p.imUserId);
      if (
        !existing ||
        (p.conversation.lastMessageAt &&
          (!existing.conversation.lastMessageAt || p.conversation.lastMessageAt > existing.conversation.lastMessageAt))
      ) {
        contactMap.set(p.imUserId, p);
      }
    }

    // Apply role filter
    let contacts = Array.from(contactMap.values());
    if (roleFilter) {
      contacts = contacts.filter((p) => p.imUser.role === roleFilter);
    }

    // Sort by last message time (most recent first)
    contacts.sort((a, b) => {
      const aTime = a.conversation.lastMessageAt?.getTime() ?? 0;
      const bTime = b.conversation.lastMessageAt?.getTime() ?? 0;
      return bTime - aTime;
    });

    const total = contacts.length;

    // Apply pagination
    const paged = contacts.slice(offset, offset + limit);

    // Get unread counts and last messages for each contact's conversation
    const readCursors = await prisma.iMReadCursor.findMany({
      where: { imUserId },
    });
    const cursorMap = new Map(
      readCursors.map(
        (rc: { conversationId: string; lastReadAt: Date }) => [rc.conversationId, rc.lastReadAt] as const,
      ),
    );

    const result = await Promise.all(
      paged.map(async (p) => {
        // Unread count
        const lastReadAt = cursorMap.get(p.conversationId);
        const unreadCount = await prisma.iMMessage.count({
          where: {
            conversationId: p.conversationId,
            senderId: { not: imUserId },
            ...(lastReadAt ? { createdAt: { gt: lastReadAt } } : {}),
          },
        });

        // Last message
        const lastMsg = await prisma.iMMessage.findFirst({
          where: { conversationId: p.conversationId },
          orderBy: { createdAt: 'desc' },
          select: { content: true },
        });

        return {
          userId: p.imUser.id,
          username: p.imUser.username,
          displayName: p.imUser.displayName,
          role: p.imUser.role,
          avatarUrl: p.imUser.avatarUrl,
          lastMessageAt: p.conversation.lastMessageAt?.toISOString() ?? null,
          lastMessage: lastMsg?.content ? lastMsg.content.substring(0, 100) : null,
          unreadCount,
          conversationId: p.conversationId,
          conversationType: p.conversation.type,
        };
      }),
    );

    return c.json<ApiResponse>({
      ok: true,
      data: result,
      meta: { total, limit, offset },
    });
  });

  return router;
}

export function createDiscoverRouter() {
  const router = new Hono();

  router.use('*', authMiddleware);

  /**
   * GET /discover — Discover available agents/users
   *
   * Query params:
   *   type        - Filter by role (agent | human)
   *   capability  - Filter agents by capability
   *   status      - Filter agents by status (online | all)
   *   q           - Search by username, displayName, or exact primaryDid when prefixed with did:key:
   *   limit       - Max results (default 50)
   *   offset      - Skip N results (default 0)
   */
  router.get('/', async (c) => {
    const authUser = c.get('user');
    const imUserId = authUser.imUserId;

    const typeFilter = c.req.query('type');
    const capabilityFilter = c.req.query('capability');
    const statusFilter = c.req.query('status');
    const searchQuery = c.req.query('q');
    const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 200);
    const offset = parseInt(c.req.query('offset') ?? '0', 10);

    // Build where clause
    const where: any = {
      id: { not: imUserId }, // Exclude self
    };

    if (typeFilter) {
      where.role = typeFilter;
    }

    if (searchQuery) {
      const q = searchQuery.trim();
      if (q.startsWith('did:key:')) {
        where.primaryDid = q;
      } else {
        where.OR = [{ username: { contains: q } }, { displayName: { contains: q } }];
      }
    }

    // Query users with agent cards
    const users = await prisma.iMUser.findMany({
      where,
      include: { agentCard: true, identityKey: true },
      orderBy: { createdAt: 'desc' },
    });

    // Apply capability and status filters (post-query since they're on agentCard)
    type UserWithAgentCard = (typeof users)[number];
    let filtered: UserWithAgentCard[] = users;

    if (capabilityFilter) {
      filtered = filtered.filter((u) => {
        if (!u.agentCard) return false;
        try {
          const caps: string[] = JSON.parse(u.agentCard.capabilities);
          return caps.some((cap) => cap.toLowerCase().includes(capabilityFilter.toLowerCase()));
        } catch {
          return false;
        }
      });
    }

    if (statusFilter && statusFilter !== 'all') {
      filtered = filtered.filter((u) => {
        if (!u.agentCard) return statusFilter !== 'online';
        return u.agentCard.status === statusFilter;
      });
    }

    // Sort: online agents first, then by creation time
    filtered.sort((a, b) => {
      const aOnline = a.agentCard?.status === 'online' ? 1 : 0;
      const bOnline = b.agentCard?.status === 'online' ? 1 : 0;
      if (bOnline !== aOnline) return bOnline - aOnline;
      return b.createdAt.getTime() - a.createdAt.getTime();
    });

    const total = filtered.length;
    const paged = filtered.slice(offset, offset + limit);

    // Get my contact IDs (users I've chatted with)
    const myParticipations = await prisma.iMParticipant.findMany({
      where: { imUserId, leftAt: null },
      select: { conversationId: true },
    });
    const myConversationIds = myParticipations.map((p: { conversationId: string }) => p.conversationId);

    let contactUserIds = new Set<string>();
    if (myConversationIds.length > 0) {
      const contactParticipants = await prisma.iMParticipant.findMany({
        where: {
          conversationId: { in: myConversationIds },
          imUserId: { not: imUserId },
          leftAt: null,
        },
        select: { imUserId: true },
        distinct: ['imUserId'],
      });
      contactUserIds = new Set(contactParticipants.map((p: { imUserId: string }) => p.imUserId));
    }

    const result = paged.map((u) => {
      let capabilities: string[] | undefined;
      if (u.agentCard) {
        try {
          capabilities = JSON.parse(u.agentCard.capabilities);
        } catch {
          capabilities = [];
        }
      }

      const ik = u.identityKey;
      return {
        userId: u.id,
        username: u.username,
        displayName: u.displayName,
        role: u.role,
        agentType: u.agentType ?? undefined,
        capabilities,
        description: u.agentCard?.description ?? undefined,
        status: u.agentCard?.status ?? undefined,
        did: u.agentCard?.did ?? u.primaryDid ?? ik?.didKey ?? undefined,
        didDocumentUrl: u.agentCard?.didDocumentUrl ?? undefined,
        identityKey: ik
          ? {
              keyId: ik.keyId,
              didKey: ik.didKey ?? undefined,
              publicKey: ik.publicKey,
              derivationMode: ik.derivationMode,
              revokedAt: ik.revokedAt?.toISOString() ?? null,
            }
          : undefined,
        isContact: contactUserIds.has(u.id),
      };
    });

    return c.json<ApiResponse>({
      ok: true,
      data: result,
      meta: { total, limit, offset },
    });
  });

  return router;
}
