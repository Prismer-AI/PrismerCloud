/**
 * Prismer IM — Conversations API
 */

import { Hono } from 'hono';
import { authMiddleware } from '../auth/middleware';
import { ConversationService } from '../services/conversation.service';
// release201/26 Phase 2: L2 Range producer singleton. Owned by the parallel
// conversation-compaction.service work; this file only consumes
// `regenerateSegment`. If the module is not yet present at integration time the
// import will fail to resolve — see delivery note. Contract: exports singleton
// `conversationCompactionService` with `regenerateSegment(conversationId, segmentSeq)`.
import { conversationCompactionService } from '../services/conversation-compaction.service';
import prisma from '../db';
import type { ApiResponse, ConversationStatus } from '../types/index';
import type { IMParticipant, IMConversation, IMUser, IMReadCursor } from '@prisma/client';
import type { RoomManager } from '../ws/rooms';
import { ServerEvents } from '../ws/events';
import {
  buildConversationViewerAccess,
  hasWorkspaceConversationAccess,
  resolveConversationViewerAccess,
  type ConversationViewerAccess,
} from './conversation-visibility';

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

type ConversationListItem = IMConversation & {
  myRole: string;
  viewerAccess: ConversationViewerAccess;
  pinned: boolean;
  muted: boolean;
  pinnedAt: Date | null;
  unreadCount: number;
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
    if (others.length === 1) {
      const other = others[0]?.imUser;
      return other?.displayName || other?.username || conv.title || null;
    }
    const names =
      conv.participants?.map((p) => p.imUser.displayName || p.imUser.username).filter((name) => name?.trim()) ?? [];
    if (names.length >= 2) return names.slice(0, 2).join(' / ');
    return names[0] ?? conv.title ?? null;
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

function serializeViewerAccess(access: ConversationViewerAccess): ConversationViewerAccess {
  return { ...access };
}

export function filterConversationsForWorkspace<T extends { workspaceId?: string | null }>(
  conversations: T[],
  workspaceId: string | null,
): T[] {
  if (!workspaceId) return conversations;
  return conversations.filter((conv) => conv.workspaceId === workspaceId);
}

export async function resolveDirectWorkspaceId(createdBy: string, otherUserId: string): Promise<string | undefined> {
  const ownerDefault = await prisma.iMWorkspace.findFirst({
    where: { ownerImUserId: createdBy, isDefault: true, deletedAt: null },
    select: { id: true },
  });
  if (ownerDefault) return ownerDefault.id;

  const [creatorProfiles, otherProfiles, creatorCard, otherCard] = await Promise.all([
    prisma.iMAgentProfile.findMany({
      where: { agentImUserId: createdBy, deletedAt: null },
      select: { workspaceId: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
    }),
    prisma.iMAgentProfile.findMany({
      where: { agentImUserId: otherUserId, deletedAt: null },
      select: { workspaceId: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
    }),
    prisma.iMAgentCard.findUnique({ where: { imUserId: createdBy }, select: { workspaceId: true } }),
    prisma.iMAgentCard.findUnique({ where: { imUserId: otherUserId }, select: { workspaceId: true } }),
  ]);

  const otherProfileIds = new Set(otherProfiles.map((profile: (typeof otherProfiles)[number]) => profile.workspaceId));
  const commonProfile = creatorProfiles.find((profile: (typeof creatorProfiles)[number]) =>
    otherProfileIds.has(profile.workspaceId),
  );
  if (commonProfile) return commonProfile.workspaceId;

  if (creatorCard?.workspaceId && creatorCard.workspaceId === otherCard?.workspaceId) return creatorCard.workspaceId;
  return creatorProfiles[0]?.workspaceId ?? creatorCard?.workspaceId ?? undefined;
}

export function createConversationsRouter(conversationService: ConversationService, rooms?: RoomManager) {
  const router = new Hono();

  // All routes require auth
  // eslint-disable-next-line custom/no-wildcard-sub-router-middleware -- mounted at /conversations in routes.ts; wildcard scoped to that prefix
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
    if (!workspaceId) workspaceId = await resolveDirectWorkspaceId(user.imUserId, otherUserId);

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
    // `workspaceId` was previously dropped here, so a group created via this
    // route had a NULL workspace and never showed up in the workspace-scoped
    // directory (`/conversations?workspaceId=...`) — contradicting the Python
    // SDK's documented `create_group(workspace_id=...)` (which sends
    // `body.workspaceId`) and docs/54release/{03,09}. Forward it. Only when the
    // caller supplies it — no default-workspace fallback — so callers that omit
    // it keep the prior NULL-workspace behaviour unchanged. (The canonical
    // `/api/im/groups` route adds the default-workspace fallback for the web UI.)
    const { title, description, memberIds, workspaceId, metadata } = body;

    if (!title) {
      return c.json<ApiResponse>({ ok: false, error: 'title is required' }, 400);
    }

    const conv = await conversationService.createGroup({
      createdBy: user.imUserId,
      title,
      description,
      memberIds: memberIds ?? [],
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
   * GET /api/conversations — List user's conversations
   *
   * Query params:
   *   status      - Filter by status (default: active)
   *   withUnread  - Include unread counts (default: false)
   *   unreadOnly  - Only return conversations with unread messages
   *
   * `workspaceId` extends the participant list with every conversation in that
   * workspace when the caller has workspace-level access. Workspace owner/admin
   * are control-plane observers; only active participants can send messages.
   */
  router.get('/', async (c) => {
    const user = c.get('user');
    const status = (c.req.query('status') ?? 'active') as ConversationStatus;
    const withUnread = c.req.query('withUnread') === 'true';
    const unreadOnly = c.req.query('unreadOnly') === 'true';
    const workspaceId = c.req.query('workspaceId')?.trim() || null;

    const conversations = await conversationService.listByUser(user.imUserId, status);

    const resultById = new Map<string, any>();
    for (const p of conversations as Array<
      IMParticipant & { conversation: IMConversation & { participants?: ConversationParticipantLite[] } }
    >) {
      const displayTitle = directDisplayTitle(p.conversation, user.imUserId);
      const viewerAccess = buildConversationViewerAccess({
        participant: { role: p.role, leftAt: p.leftAt },
        workspaceCanObserve: false,
        workspaceCanManage: false,
      });
      resultById.set(p.conversation.id, {
        ...p.conversation,
        title: displayTitle,
        displayTitle,
        participants: p.conversation.participants?.map(serializeConversationParticipant),
        myRole: viewerAccess.role,
        viewerAccess: serializeViewerAccess(viewerAccess),
        pinned: p.pinned,
        muted: p.muted,
        pinnedAt: p.pinnedAt,
        unreadCount: 0,
      });
    }

    if (workspaceId && (await hasWorkspaceConversationAccess(workspaceId, user.imUserId))) {
      const workspaceCanManage = await hasWorkspaceConversationAccess(workspaceId, user.imUserId, ['owner']);
      const workspaceConversations = await prisma.iMConversation.findMany({
        where: { workspaceId, status },
        include: {
          participants: { where: { leftAt: null }, include: { imUser: true } },
        },
      });
      for (const conv of workspaceConversations) {
        if (resultById.has(conv.id)) {
          const existing = resultById.get(conv.id);
          existing.viewerAccess = serializeViewerAccess(
            buildConversationViewerAccess({
              participant: { role: existing.myRole, leftAt: null },
              workspaceCanObserve: true,
              workspaceCanManage,
            }),
          );
          existing.myRole = existing.viewerAccess.role;
          continue;
        }
        const displayTitle = directDisplayTitle(conv, user.imUserId);
        const viewerAccess = buildConversationViewerAccess({
          participant: null,
          workspaceCanObserve: true,
          workspaceCanManage,
        });
        resultById.set(conv.id, {
          ...conv,
          title: displayTitle,
          displayTitle,
          participants: conv.participants.map(serializeConversationParticipant),
          myRole: viewerAccess.role,
          viewerAccess: serializeViewerAccess(viewerAccess),
          pinned: false,
          muted: false,
          pinnedAt: null,
          unreadCount: 0,
        });
      }
    }

    let result = filterConversationsForWorkspace([...resultById.values()] as ConversationListItem[], workspaceId);

    // Calculate unread counts if requested
    //
    // 2026-05-23: prefer lastReadMsgId-based anchoring when available — the
    // cursor row carries both lastReadAt + lastReadMsgId; pre-Wave 4 writers
    // only set lastReadAt, so we keep lastReadAt as the fallback. Using the
    // message id is more robust against clock skew + sub-millisecond ordering
    // (two messages at the same createdAt would otherwise be ambiguous).
    if (withUnread || unreadOnly) {
      const readCursors = await prisma.iMReadCursor.findMany({
        where: { imUserId: user.imUserId },
      });
      const cursorMap = new Map<string, { lastReadAt: Date | null; lastReadMsgId: string | null }>(
        readCursors.map((rc: IMReadCursor) => [
          rc.conversationId,
          { lastReadAt: rc.lastReadAt, lastReadMsgId: rc.lastReadMsgId },
        ]),
      );

      result = await Promise.all(
        result.map(async (conv: ConversationListItem) => {
          const cursor = cursorMap.get(conv.id);
          let unreadCount = 0;
          if (cursor?.lastReadMsgId) {
            // Anchor on the message row itself: count messages whose
            // createdAt > the read message's createdAt. Round-trip cost is
            // one extra index hit (im_messages PK) per conversation.
            const anchor = await prisma.iMMessage.findUnique({
              where: { id: cursor.lastReadMsgId },
              select: { createdAt: true },
            });
            const anchorAt = anchor?.createdAt ?? cursor.lastReadAt;
            unreadCount = await prisma.iMMessage.count({
              where: {
                conversationId: conv.id,
                senderId: { not: user.imUserId },
                ...(anchorAt ? { createdAt: { gt: anchorAt } } : {}),
              },
            });
          } else {
            unreadCount = await prisma.iMMessage.count({
              where: {
                conversationId: conv.id,
                senderId: { not: user.imUserId },
                ...(cursor?.lastReadAt ? { createdAt: { gt: cursor.lastReadAt } } : {}),
              },
            });
          }
          return { ...conv, unreadCount };
        }),
      );

      if (unreadOnly) {
        result = result.filter((conv: ConversationListItem) => conv.unreadCount > 0);
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
    if (!conv || conv.status === 'deleted') {
      return c.json<ApiResponse>({ ok: false, error: 'Conversation not found' }, 404);
    }

    const viewerParticipant = await prisma.iMParticipant.findUnique({
      where: { conversationId_imUserId: { conversationId: convId, imUserId: user.imUserId } },
    });
    const viewerAccess = await resolveConversationViewerAccess(convId, user.imUserId);
    if (!viewerAccess.canObserve) {
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
        myRole: viewerAccess.role,
        viewerAccess: serializeViewerAccess(viewerAccess),
        pinned: viewerParticipant && !viewerParticipant.leftAt ? viewerParticipant.pinned : false,
        muted: viewerParticipant && !viewerParticipant.leftAt ? viewerParticipant.muted : false,
        pinnedAt: viewerParticipant && !viewerParticipant.leftAt ? viewerParticipant.pinnedAt : null,
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

    const viewerAccess = await resolveConversationViewerAccess(convId, user.imUserId);
    if (!viewerAccess.canRename) {
      return c.json<ApiResponse>({ ok: false, error: 'Permission denied' }, 403);
    }

    const updated = await conversationService.update(convId, body);
    return c.json<ApiResponse>({ ok: true, data: updated });
  });

  /**
   * POST /api/conversations/:id/skill-dev-role — release201/08 §3.0 / S21.
   *
   * Tags a conversation with one of the 4 skill-dev roles (business / dev /
   * test / review) so Studio Lifecycle session-links can render the chain.
   * Body: { role, skillDraftId, projectId?, parentConversationId? }
   *
   * AuthZ: the caller must be a participant of the conversation; in practice
   * this is invoked by the workspace owner (business) or by cloud-internal
   * service paths spawning dev/test/review children. Service layer is the
   * single writer of `conversation.metadata.skillDev` — no other endpoint is
   * permitted to mutate that JSON sub-object.
   */
  router.post('/:id/skill-dev-role', async (c) => {
    const user = c.get('user');
    const convId = c.req.param('id');
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Invalid JSON body' }, 400);
    }
    const role = body.role as 'business' | 'dev' | 'test' | 'review' | undefined;
    const skillDraftId = typeof body.skillDraftId === 'string' ? body.skillDraftId : null;
    if (!role || !['business', 'dev', 'test', 'review'].includes(role)) {
      return c.json<ApiResponse>({ ok: false, error: "role must be 'business' | 'dev' | 'test' | 'review'" }, 400);
    }
    // skillDraftId may be null for `business` sessions at the moment of /skill
    // new — the draft hasn't been created yet. We tolerate empty string and
    // backfill once createDraft returns. dev/test/review MUST carry it.
    if (role !== 'business' && !skillDraftId) {
      return c.json<ApiResponse>({ ok: false, error: 'skillDraftId is required for dev/test/review roles' }, 400);
    }
    const viewerAccess = await resolveConversationViewerAccess(convId, user.imUserId);
    if (!viewerAccess.canRead) {
      return c.json<ApiResponse>({ ok: false, error: 'Not a participant' }, 403);
    }
    try {
      const result = await conversationService.setSkillDevRole(convId, skillDraftId ?? '', role, {
        projectId: typeof body.projectId === 'string' ? body.projectId : undefined,
        parentConversationId: typeof body.parentConversationId === 'string' ? body.parentConversationId : undefined,
      });
      return c.json<ApiResponse>({ ok: true, data: result });
    } catch (err) {
      console.error('[conversations] setSkillDevRole failed', { err: (err as Error).message });
      return c.json<ApiResponse>({ ok: false, error: 'setSkillDevRole failed' }, 500);
    }
  });

  /**
   * POST /api/conversations/:id/read — Mark conversation as read
   */
  router.post("/:id/read", async (c) => {
    const user = c.get("user");
    const convId = c.req.param("id")!;

    const viewerAccess = await resolveConversationViewerAccess(convId, user.imUserId);
    if (!viewerAccess.canRead) {
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
  router.post('/:id/archive', async (c) => {
    const user = c.get('user');
    const convId = c.req.param('id');
    const viewerAccess = await resolveConversationViewerAccess(convId, user.imUserId);
    if (!viewerAccess.canArchive) {
      return c.json<ApiResponse>({ ok: false, error: 'Permission denied' }, 403);
    }
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

    const viewerAccess = await resolveConversationViewerAccess(convId, user.imUserId);
    if (!viewerAccess.canPin) {
      return c.json<ApiResponse>({ ok: false, error: 'Not a participant' }, 403);
    }

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

    const viewerAccess = await resolveConversationViewerAccess(convId, user.imUserId);
    if (!viewerAccess.canMute) {
      return c.json<ApiResponse>({ ok: false, error: 'Not a participant' }, 403);
    }

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
    const viewerAccess = await resolveConversationViewerAccess(convId, user.imUserId);
    if (!participant && !viewerAccess.canArchive) {
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

    const participant = await prisma.iMParticipant.findUnique({
      where: { conversationId_imUserId: { conversationId: convId, imUserId: user.imUserId } },
    });
    const viewerAccess = await resolveConversationViewerAccess(convId, user.imUserId);

    if (viewerAccess.canDelete) {
      await conversationService.softDelete(convId);
      return c.json<ApiResponse>({ ok: true });
    }

    if (participant && !participant.leftAt && viewerAccess.canLeave) {
      await prisma.iMParticipant.update({
        where: { conversationId_imUserId: { conversationId: convId, imUserId: user.imUserId } },
        data: { leftAt: new Date() },
      });
      return c.json<ApiResponse>({ ok: true });
    }

    if (participant) {
      return c.json<ApiResponse>({ ok: false, error: 'Already left this conversation' }, 409);
    }

    return c.json<ApiResponse>({ ok: false, error: 'Not a participant' }, 403);
  });

  /**
   * POST /api/conversations/:id/participants — Add participant
   */
  router.post('/:id/participants', async (c) => {
    const actor = c.get('user');
    const convId = c.req.param('id');
    const body = await c.req.json();
    const { userId, role } = body;

    if (!userId) {
      return c.json<ApiResponse>({ ok: false, error: 'userId is required' }, 400);
    }

    const viewerAccess = await resolveConversationViewerAccess(convId, actor.imUserId);
    if (!viewerAccess.canAddMember) {
      return c.json<ApiResponse>({ ok: false, error: 'Permission denied' }, 403);
    }

    const participant = await conversationService.addParticipant(convId, userId, role);
    return c.json<ApiResponse>({ ok: true, data: participant }, 201);
  });

  /**
   * DELETE /api/conversations/:id/participants/:userId — Remove participant
   */
  router.delete('/:id/participants/:userId', async (c) => {
    const actor = c.get('user');
    const convId = c.req.param('id');
    const userId = c.req.param('userId');

    const viewerAccess = await resolveConversationViewerAccess(convId, actor.imUserId);
    if (!viewerAccess.canRemoveMember && userId !== actor.imUserId) {
      return c.json<ApiResponse>({ ok: false, error: 'Permission denied' }, 403);
    }

    const removed = await conversationService.removeParticipant(convId, userId);
    return c.json<ApiResponse>({ ok: true, data: removed });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Wave 3.5 W1 — Hydration endpoints for chat panel task phase signal
  //   - GET /:cid/active-task-phases — §4.4.2 page-load phase hydration
  //   - GET /:cid/active-task-count  — §4.4.5 footer counter DB-derived
  // Spec: docs/release200/14-messaging-state-machine-reliability.md §4.4
  // Consumer: src/app/workspace/lib/sync-api.ts::fetchActiveTaskPhases
  //           (C1 currently uses GET /tasks?conversationId=X as placeholder;
  //            once this endpoint lands, only that helper needs to swap.)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * GET /api/conversations/:cid/active-task-phases — Hydrate phase signals on F5.
   *
   * Filter: status IN ('running','review','blocked') AND conversationId = cid.
   * Auth: requester must be a participant OR have workspace-conversation observer
   *       access (mirrors the GET /messages/:cid permission gate so workspace
   *       owners viewing agent-only convs still get hydration).
   *
   * `lastStep` is derived from im_task_run_steps by selecting the most recent
   * row with kind='tool_call' for each task (best-effort — null when daemon
   * has not yet pushed a step). currentPhase is a daemon-written free-form
   * string (Wave 1 Q1.A decision) — server does not enum-validate.
   */
  router.get('/:cid/active-task-phases', async (c) => {
    const user = c.get('user');
    const cid = c.req.param('cid');

    const isMember = await conversationService.isParticipant(cid, user.imUserId);
    if (!isMember && !(await hasWorkspaceConversationAccess(cid, user.imUserId))) {
      return c.json<ApiResponse>({ ok: false, error: 'Not a participant' }, 403);
    }

    // Recency guard (2026-05-23): never hydrate tasks older than 30 minutes
    // into the typing-indicator stream. Pre-fix, tasks stuck at status='running'
    // for days (daemon went silent, no reaper covered the never-heartbeated
    // case) showed up as permanent EXECUTING pills every F5. Even though
    // sweepStuckPhases + failNeverDispatchedTasks now cover most of those,
    // this filter is a belt-and-suspenders so a missed sweep tick still
    // doesn't leak stale state to the UI.
    const recencyCutoff = new Date(Date.now() - 30 * 60 * 1000);
    const tasks = await prisma.iMTask.findMany({
      where: {
        conversationId: cid,
        status: { in: ['running', 'review', 'blocked'] },
        updatedAt: { gt: recencyCutoff },
      },
      select: {
        id: true,
        status: true,
        currentPhase: true,
        lastHeartbeatAt: true,
        progress: true,
        statusMessage: true,
        assigneeId: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    });

    // Best-effort lastStep enrichment from im_task_run_steps.
    // One query per task is fine at take:50 because the daemon writes few
    // steps per task; the (taskId, occurredAt) index makes this O(log n).
    const taskIds = tasks.map((t: { id: string }) => t.id);
    const lastStepByTaskId = new Map<string, { kind: string; toolName: string; occurredAt: Date }>();
    if (taskIds.length > 0) {
      try {
        const steps = await prisma.iMTaskRunStep.findMany({
          where: { taskId: { in: taskIds }, kind: 'tool_call' },
          select: { taskId: true, kind: true, payloadJson: true, occurredAt: true },
          orderBy: { occurredAt: 'desc' },
          take: 200,
        });
        for (const step of steps) {
          if (lastStepByTaskId.has(step.taskId)) continue; // first (most-recent) wins
          let toolName = '';
          try {
            const payload =
              typeof step.payloadJson === 'string'
                ? JSON.parse(step.payloadJson)
                : (step.payloadJson as Record<string, unknown>);
            toolName = typeof payload?.toolName === 'string' ? payload.toolName : '';
          } catch {
            // payload corrupt — skip toolName but still emit kind/occurredAt
          }
          lastStepByTaskId.set(step.taskId, {
            kind: step.kind,
            toolName,
            occurredAt: step.occurredAt,
          });
        }
      } catch (err) {
        // Non-fatal — return tasks without lastStep enrichment.
        console.warn('[ConversationTasks] lastStep enrichment failed:', (err as Error).message);
      }
    }

    type ActiveTaskRow = {
      id: string;
      status: string;
      currentPhase: string | null;
      lastHeartbeatAt: Date | null;
      progress: number | null;
      statusMessage: string | null;
      assigneeId: string | null;
    };

    return c.json({
      ok: true,
      data: {
        tasks: tasks.map((t: ActiveTaskRow) => ({
          taskId: t.id,
          status: t.status,
          currentPhase: t.currentPhase,
          lastHeartbeatAt: t.lastHeartbeatAt,
          progress: t.progress,
          statusMessage: t.statusMessage,
          assigneeId: t.assigneeId,
          lastStep: lastStepByTaskId.get(t.id) ?? null,
        })),
      },
    });
  });

  /**
   * GET /api/conversations/:cid/active-task-count — Footer counter DB-derived.
   *
   * Returns { running, stuck, waiting, total }:
   *   - running: status='running' (any phase)
   *   - stuck:   status='running' AND currentPhase='stuck'   (subset of running)
   *   - waiting: status='running' AND currentPhase IN ('waiting_user','waiting_dep')
   *   - total:   status IN ('running','review','blocked')
   *
   * Auth: same as /active-task-phases.
   *
   * Eliminates the "永远 working" stale counter bug — see §4.4.5. Front-end
   * polls every 10s + refreshes on SSE task.completed/failed/phase.changed.
   */
  router.get('/:cid/active-task-count', async (c) => {
    const user = c.get('user');
    const cid = c.req.param('cid');

    const isMember = await conversationService.isParticipant(cid, user.imUserId);
    if (!isMember && !(await hasWorkspaceConversationAccess(cid, user.imUserId))) {
      return c.json<ApiResponse>({ ok: false, error: 'Not a participant' }, 403);
    }

    // Same recency guard as /:cid/active-task-phases above — count only
    // tasks updated within the last 30 minutes so footer "N agents working"
    // doesn't inflate from stale state when a reaper tick is missed.
    const recencyCutoff = new Date(Date.now() - 30 * 60 * 1000);
    const rows = await prisma.iMTask.findMany({
      where: {
        conversationId: cid,
        status: { in: ['running', 'review', 'blocked'] },
        updatedAt: { gt: recencyCutoff },
      },
      select: { status: true, currentPhase: true },
    });

    let running = 0;
    let stuck = 0;
    let waiting = 0;
    for (const row of rows) {
      if (row.status === 'running') {
        running++;
        if (row.currentPhase === 'stuck') stuck++;
        else if (row.currentPhase === 'waiting_user' || row.currentPhase === 'waiting_dep') waiting++;
      }
    }

    return c.json({
      ok: true,
      data: {
        running,
        stuck,
        waiting,
        total: rows.length,
      },
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // release201/26 Phase 2 — L2 conversational-memory admin endpoints.
  //
  //   GET  /:id/memory                          — list compressed segments +
  //                                                identifier index for a conv
  //   POST /:id/memory/segments/:seq/regenerate — re-run the Range producer for
  //                                                one segment
  //
  // RBAC: admin-only (mirrors runtime-diagnose.ts / daemon-health.ts —
  // `user.role === 'admin'`). These are operator/debug surfaces for inspecting
  // and repairing the derived L2 layer; they are NOT participant-facing reads,
  // so non-admins get 403 even if they are members of the conversation.
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * GET /api/conversations/:id/memory — Admin: inspect L2 compressed memory.
   *
   * Returns the conversation's current (supersededBy = null) Range segments,
   * plus the identifier index (Phase 3 populated; likely empty in Phase 2).
   * Pass `?includeSuperseded=1` to also return historical (regenerated-over)
   * segment versions for drift inspection.
   *
   * AuthZ: admin only. Existence of the conversation is validated first so the
   * caller can distinguish 404 (no such conv) from an empty-but-valid result.
   */
  router.get('/:id/memory', async (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') {
      return c.json<ApiResponse>({ ok: false, error: 'Forbidden' }, 403);
    }

    const convId = c.req.param('id');
    const includeSuperseded = c.req.query('includeSuperseded') === '1';

    const conv = await prisma.iMConversation.findUnique({
      where: { id: convId },
      select: { id: true },
    });
    if (!conv) {
      return c.json<ApiResponse>({ ok: false, error: 'Conversation not found' }, 404);
    }

    const segments = await prisma.iMConversationCompressedSegment.findMany({
      where: {
        conversationId: convId,
        ...(includeSuperseded ? {} : { supersededBy: null }),
      },
      orderBy: { segmentSeq: 'asc' },
    });

    const identifiers = await prisma.iMConversationIdentifierIndex.findMany({
      where: { conversationId: convId },
      orderBy: { updatedAt: 'desc' },
    });

    return c.json<ApiResponse>({
      ok: true,
      data: { segments, identifiers },
    });
  });

  /**
   * POST /api/conversations/:id/memory/segments/:seq/regenerate — Admin: re-run
   * the Range producer for a single segment (drift repair, §10 bulk-regenerate).
   *
   * Delegates entirely to `conversationCompactionService.regenerateSegment`
   * (release201/26 Phase 2 producer, owned by conversation-compaction.service).
   * This endpoint does NOT implement producer logic — it is the admin trigger.
   *
   * AuthZ: admin only.
   */
  router.post('/:id/memory/segments/:seq/regenerate', async (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') {
      return c.json<ApiResponse>({ ok: false, error: 'Forbidden' }, 403);
    }

    const convId = c.req.param('id');
    const seqRaw = c.req.param('seq');
    const seq = Number(seqRaw);
    if (!Number.isInteger(seq) || seq < 0) {
      return c.json<ApiResponse>({ ok: false, error: 'segmentSeq must be a non-negative integer' }, 400);
    }

    const conv = await prisma.iMConversation.findUnique({
      where: { id: convId },
      select: { id: true },
    });
    if (!conv) {
      return c.json<ApiResponse>({ ok: false, error: 'Conversation not found' }, 404);
    }

    try {
      const segment = await conversationCompactionService.regenerateSegment(convId, seq);
      // Producer returns null when there is no segment at that seq (or the
      // range could not be re-produced). Surface 404 so the caller can tell a
      // missing segment apart from a successful regenerate.
      if (!segment) {
        return c.json<ApiResponse>({ ok: false, error: 'Segment not found or could not be regenerated' }, 404);
      }
      return c.json<ApiResponse>({ ok: true, data: { segment } });
    } catch (err) {
      console.error('[conversations] regenerateSegment failed', {
        convId,
        seq,
        err: (err as Error).message,
      });
      return c.json<ApiResponse>({ ok: false, error: 'regenerateSegment failed' }, 500);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // release201/26 Phase 3 — agent-facing read endpoints (resolve / quote).
  //
  // These are consumed by the agent CLI (`cloud conversation resolve-identifier`
  // / `cloud quote read`, decision H — #10 wraps them in a built-in skill). They
  // are NOT admin endpoints: AuthZ is conversation MEMBERSHIP (any participant /
  // observer may read; non-participants get 403), matching GET /:id.
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * GET /api/conversations/:id/identifiers/resolve?q=<alias>
   *
   * Fuzzy-resolve a human alias / canonical id to a canonical identifier from
   * IMConversationIdentifierIndex. Matches against `aliasesJson` + `displayLabel`
   * + `canonicalId`. Returns the best match plus ALL scored candidates so an
   * ambiguous query surfaces multiple — the agent MUST disambiguate, never guess
   * (§ doc 26 Phase 3 "歧义带规则").
   *
   * Shape: { ok, data: { canonicalId, displayLabel, kind, candidates:[{...,score}] } }
   * When nothing matches: canonicalId/displayLabel/kind null, candidates [].
   */
  router.get('/:id/identifiers/resolve', async (c) => {
    const user = c.get('user');
    const convId = c.req.param('id');
    const q = (c.req.query('q') ?? '').trim();

    const access = await resolveConversationViewerAccess(convId, user.imUserId);
    if (!access.canObserve) {
      return c.json<ApiResponse>({ ok: false, error: 'Not a participant' }, 403);
    }
    if (!q) {
      return c.json<ApiResponse>({ ok: false, error: 'q query param required' }, 400);
    }

    const rows = (await prisma.iMConversationIdentifierIndex.findMany({
      where: { conversationId: convId },
      orderBy: { updatedAt: 'desc' },
    })) as Array<{
      identifierKind: string;
      canonicalId: string;
      aliasesJson: string;
      displayLabel: string | null;
    }>;

    const qLower = q.toLowerCase();
    type Candidate = { canonicalId: string; displayLabel: string; kind: string; score: number };
    const candidates: Candidate[] = [];
    for (const r of rows) {
      let aliases: string[] = [];
      try {
        const parsed = JSON.parse(r.aliasesJson || '[]');
        if (Array.isArray(parsed)) aliases = parsed.filter((x): x is string => typeof x === 'string');
      } catch {
        aliases = [];
      }
      const haystacks = [r.canonicalId, r.displayLabel ?? '', ...aliases]
        .filter(Boolean)
        .map((s) => s.toLowerCase());
      // Score: exact match 1.0, prefix 0.8, substring 0.5, none → skip.
      let score = 0;
      for (const h of haystacks) {
        if (h === qLower) score = Math.max(score, 1);
        else if (h.startsWith(qLower)) score = Math.max(score, 0.8);
        else if (h.includes(qLower)) score = Math.max(score, 0.5);
      }
      if (score > 0) {
        candidates.push({
          canonicalId: r.canonicalId,
          displayLabel: r.displayLabel ?? r.canonicalId,
          kind: r.identifierKind,
          score,
        });
      }
    }
    candidates.sort((a, b) => b.score - a.score);

    // "不猜": only surface a single canonical answer when there is exactly one
    // top-scoring candidate. If two candidates tie for the top score, the answer
    // is ambiguous → leave canonicalId null and return all candidates.
    const top = candidates[0];
    const tie = candidates.length > 1 && candidates[1].score === top?.score;
    const unambiguous = top && !tie;

    return c.json<ApiResponse>({
      ok: true,
      data: {
        canonicalId: unambiguous ? top.canonicalId : null,
        displayLabel: unambiguous ? top.displayLabel : null,
        kind: unambiguous ? top.kind : null,
        candidates,
      },
    });
  });

  /**
   * GET /api/conversations/:id/quote/:messageId
   *
   * Read a quoted message's content for the agent. Prefers the
   * IMConversationQuoteCache snapshot (resilient to source deletion); falls back
   * to a live read of the raw IMMessage when no snapshot exists. When the source
   * was deleted, the snapshot's `sourceDeletedAt` is surfaced.
   *
   * Shape: { ok, data: { messageId, content, sender, createdAt, sourceDeletedAt? } }
   */
  router.get('/:id/quote/:messageId', async (c) => {
    const user = c.get('user');
    const convId = c.req.param('id');
    const messageId = c.req.param('messageId');

    const access = await resolveConversationViewerAccess(convId, user.imUserId);
    if (!access.canObserve) {
      return c.json<ApiResponse>({ ok: false, error: 'Not a participant' }, 403);
    }

    // Prefer a snapshot for this quoted message in this conversation.
    const snap = (await prisma.iMConversationQuoteCache.findFirst({
      where: { conversationId: convId, quotedMessageId: messageId },
      orderBy: { createdAt: 'desc' },
      select: {
        snapshotContent: true,
        snapshotSender: true,
        snapshotCreatedAt: true,
        sourceDeletedAt: true,
      },
    })) as {
      snapshotContent: string;
      snapshotSender: string;
      snapshotCreatedAt: Date;
      sourceDeletedAt: Date | null;
    } | null;

    if (snap) {
      return c.json<ApiResponse>({
        ok: true,
        data: {
          messageId,
          content: snap.snapshotContent ?? '',
          sender: snap.snapshotSender,
          createdAt:
            snap.snapshotCreatedAt instanceof Date
              ? snap.snapshotCreatedAt.toISOString()
              : String(snap.snapshotCreatedAt),
          ...(snap.sourceDeletedAt
            ? {
                sourceDeletedAt:
                  snap.sourceDeletedAt instanceof Date
                    ? snap.sourceDeletedAt.toISOString()
                    : String(snap.sourceDeletedAt),
              }
            : {}),
        },
      });
    }

    // No snapshot → live read of the raw message (must belong to this conv).
    const raw = (await prisma.iMMessage.findFirst({
      where: { id: messageId, conversationId: convId },
      select: { id: true, content: true, senderId: true, createdAt: true },
    })) as { id: string; content: string | null; senderId: string; createdAt: Date } | null;

    if (!raw) {
      return c.json<ApiResponse>({ ok: false, error: 'Quoted message not found' }, 404);
    }

    const sender = (await prisma.iMUser.findUnique({
      where: { id: raw.senderId },
      select: { username: true },
    })) as { username: string } | null;

    return c.json<ApiResponse>({
      ok: true,
      data: {
        messageId: raw.id,
        content: raw.content ?? '',
        sender: sender?.username ?? raw.senderId,
        createdAt: raw.createdAt instanceof Date ? raw.createdAt.toISOString() : String(raw.createdAt),
      },
    });
  });

  /**
   * GET /api/conversations/:id/summary — agent-facing: read compressed-segment
   * summaries for the conversation's current range.
   *
   * The Phase 2 `GET /:id/memory` endpoint is admin-only (operator/debug surface
   * that also returns producer internals + the identifier index). The agent
   * capability in release201/26 Phase 3 ("read compressed-segment summaries to
   * recall earlier context") must be callable by a non-admin agent identity, so
   * this is a SEPARATE, membership-gated read that returns ONLY the
   * participant-relevant projection (seq, range, summary, token/coverage counts).
   * It deliberately omits producerModel/version, supersededBy, salientFacts raw
   * JSON and the identifier index — those stay admin-only on /memory.
   *
   * AuthZ: conversation membership (canObserve), matching resolve/quote above.
   * Returns current (supersededBy = null) segments ordered oldest→newest.
   */
  router.get('/:id/summary', async (c) => {
    const user = c.get('user');
    const convId = c.req.param('id');

    const access = await resolveConversationViewerAccess(convId, user.imUserId);
    if (!access.canObserve) {
      return c.json<ApiResponse>({ ok: false, error: 'Not a participant' }, 403);
    }

    const segments = (await prisma.iMConversationCompressedSegment.findMany({
      where: { conversationId: convId, supersededBy: null },
      orderBy: { segmentSeq: 'asc' },
      select: {
        segmentSeq: true,
        segmentKind: true,
        summary: true,
        coversFromMessageId: true,
        coversToMessageId: true,
        coversFromCreatedAt: true,
        coversToCreatedAt: true,
        coveredRawMessageIdsJson: true,
        tokenCountCl100k: true,
      },
    })) as Array<{
      segmentSeq: number;
      segmentKind: string;
      summary: string;
      coversFromMessageId: string;
      coversToMessageId: string;
      coversFromCreatedAt: Date;
      coversToCreatedAt: Date;
      coveredRawMessageIdsJson: string;
      tokenCountCl100k: number;
    }>;

    const toIso = (d: Date) => (d instanceof Date ? d.toISOString() : String(d));
    const messageCount = (json: string): number => {
      try {
        const parsed = JSON.parse(json || '[]');
        return Array.isArray(parsed) ? parsed.length : 0;
      } catch {
        return 0;
      }
    };

    return c.json<ApiResponse>({
      ok: true,
      data: {
        segments: segments.map((s) => ({
          segmentSeq: s.segmentSeq,
          segmentKind: s.segmentKind,
          summary: s.summary,
          coversFromMessageId: s.coversFromMessageId,
          coversToMessageId: s.coversToMessageId,
          coversFromCreatedAt: toIso(s.coversFromCreatedAt),
          coversToCreatedAt: toIso(s.coversToCreatedAt),
          messageCount: messageCount(s.coveredRawMessageIdsJson),
          tokenCount: s.tokenCountCl100k,
        })),
      },
    });
  });

  return router;
}
