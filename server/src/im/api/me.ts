/**
 * Prismer IM — Self-Awareness API
 *
 * GET    /api/im/me — Agent/User self-awareness endpoint (identity + stats)
 * PATCH  /api/im/me — Update editable profile fields (v1.9.4 — closes Python SDK gap)
 * DELETE /api/im/me — Self-service account deletion (Cloud 1.5; Mobile 1 PR-6)
 */

import { Hono } from 'hono';
import { authMiddleware } from '../auth/middleware';
import prisma from '../db';
import type { CreditService } from '../services/credit.service';
import type { ApiResponse, BindingPlatform } from '../types/index';
import { deleteAccountCascade, AccountDeletionError } from '../services/account-delete.service';

export function createMeRouter(creditService: CreditService) {
  const router = new Hono();

  // eslint-disable-next-line custom/no-wildcard-sub-router-middleware -- mounted at /me in routes.ts; wildcard scoped to that prefix
  router.use('*', authMiddleware);

  /**
   * GET /me — Get current user's full profile + stats
   */
  router.get('/', async (c) => {
    const authUser = c.get('user');
    const imUserId = authUser.imUserId;

    // Fetch user with agent card
    const user = await prisma.iMUser.findUnique({
      where: { id: imUserId },
      include: { agentCard: true },
    });

    if (!user) {
      return c.json<ApiResponse>({ ok: false, error: 'User not found' }, 404);
    }

    // Count conversations (active, not left)
    const participations = await prisma.iMParticipant.findMany({
      where: { imUserId, leftAt: null },
      include: { conversation: { select: { type: true, status: true } } },
    });

    type Participation = (typeof participations)[number];
    const activeParticipations = participations.filter((p: Participation) => p.conversation.status === 'active');
    const directCount = activeParticipations.filter((p: Participation) => p.conversation.type === 'direct').length;
    const groupCount = activeParticipations.filter((p: Participation) => p.conversation.type === 'group').length;

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
        distinct: ['imUserId'],
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
        readCursors.map((rc: (typeof readCursors)[number]) => [rc.conversationId, rc.lastReadAt]),
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
      } catch {
        /* empty */
      }

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
    response.bindings = bindings.map((b: (typeof bindings)[number]) => ({
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

  /**
   * PATCH /me — update editable profile fields on the caller's IMUser.
   *
   * Closes Python SDK gap from commit 3e78325 (`client.account.update_profile()`
   * had no server endpoint). Same auth as GET /me (JWT bearer).
   *
   * Editable fields:
   *   - username     (slug, /^[a-z][a-z0-9-]{2,30}$/ — globally @unique,
   *                   P2002 on collision → 409 "Username already taken")
   *   - displayName  (string, 1-128)
   *   - avatarUrl    (string | null)
   *   - bio          (mapped to IMUser.description, v1.8.0 P9 column)
   *   - metadata     (object → JSON.stringify; null clears to "{}")
   *
   * Unknown keys are rejected with 400 to surface SDK/server contract drift.
   * Response shape mirrors GET /me's `user` block plus updatedAt.
   */
  router.patch('/', async (c) => {
    const authUser = c.get('user');
    const imUserId = authUser.imUserId;

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Invalid JSON body' }, 400);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json<ApiResponse>({ ok: false, error: 'Body must be an object' }, 400);
    }

    const allowed = new Set(['username', 'displayName', 'avatarUrl', 'bio', 'metadata']);
    const unknownKeys = Object.keys(body).filter((k) => !allowed.has(k));
    if (unknownKeys.length > 0) {
      return c.json<ApiResponse>({ ok: false, error: `Unknown field(s): ${unknownKeys.join(', ')}` }, 400);
    }

    const data: Record<string, unknown> = {};

    if ('username' in body) {
      const v = body.username;
      if (typeof v !== 'string') {
        return c.json<ApiResponse>({ ok: false, error: 'username must be a string' }, 400);
      }
      const trimmed = v.trim();
      // Slug format: lowercase, digits, hyphens; must start with a letter; 3-31 chars.
      // Source of truth is `PATCH /api/im/agents/:userId` in src/im/api/agents.ts
      // (search for SLUG_PATTERN). Duplicated here so the human-rename surface
      // stays in lockstep with the agent-rename surface; a future refactor can
      // extract this to a shared module if a third caller appears.
      const SLUG_PATTERN = /^[a-z][a-z0-9-]{2,30}$/;
      if (!SLUG_PATTERN.test(trimmed)) {
        return c.json<ApiResponse>(
          {
            ok: false,
            error: 'username must match /^[a-z][a-z0-9-]{2,30}$/ — lowercase, digits, hyphens; start with a letter',
          },
          400,
        );
      }
      data.username = trimmed;
    }

    if ('displayName' in body) {
      const v = body.displayName;
      if (typeof v !== 'string' || v.trim().length === 0 || v.length > 128) {
        return c.json<ApiResponse>({ ok: false, error: 'displayName must be a non-empty string ≤128 chars' }, 400);
      }
      data.displayName = v;
    }

    if ('avatarUrl' in body) {
      const v = body.avatarUrl;
      if (v !== null && typeof v !== 'string') {
        return c.json<ApiResponse>({ ok: false, error: 'avatarUrl must be a string or null' }, 400);
      }
      if (typeof v === 'string' && v.length > 2048) {
        return c.json<ApiResponse>({ ok: false, error: 'avatarUrl too long (>2048)' }, 400);
      }
      data.avatarUrl = v;
    }

    if ('bio' in body) {
      const v = body.bio;
      if (v !== null && typeof v !== 'string') {
        return c.json<ApiResponse>({ ok: false, error: 'bio must be a string or null' }, 400);
      }
      if (typeof v === 'string' && v.length > 1024) {
        return c.json<ApiResponse>({ ok: false, error: 'bio too long (>1024)' }, 400);
      }
      // bio is stored in IMUser.description (v1.8.0 P9 column)
      data.description = v;
    }

    if ('metadata' in body) {
      const v = body.metadata;
      if (v === null) {
        data.metadata = '{}';
      } else if (typeof v === 'object' && !Array.isArray(v)) {
        try {
          data.metadata = JSON.stringify(v);
        } catch {
          return c.json<ApiResponse>({ ok: false, error: 'metadata not serializable' }, 400);
        }
      } else {
        return c.json<ApiResponse>({ ok: false, error: 'metadata must be an object or null' }, 400);
      }
    }

    if (Object.keys(data).length === 0) {
      return c.json<ApiResponse>({ ok: false, error: 'No editable fields provided' }, 400);
    }

    try {
      const updated = await prisma.iMUser.update({
        where: { id: imUserId },
        data,
        select: {
          id: true,
          username: true,
          displayName: true,
          role: true,
          agentType: true,
          avatarUrl: true,
          description: true,
          metadata: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      let parsedMetadata: unknown = {};
      try {
        parsedMetadata = updated.metadata ? JSON.parse(updated.metadata) : {};
      } catch {
        parsedMetadata = {};
      }

      return c.json<ApiResponse>({
        ok: true,
        data: {
          user: {
            id: updated.id,
            username: updated.username,
            displayName: updated.displayName,
            role: updated.role,
            agentType: updated.agentType,
            avatarUrl: updated.avatarUrl,
            bio: updated.description,
            metadata: parsedMetadata,
            createdAt: updated.createdAt,
            updatedAt: updated.updatedAt,
          },
        },
      });
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (e?.code === 'P2025') {
        return c.json<ApiResponse>({ ok: false, error: 'User not found' }, 404);
      }
      if (e?.code === 'P2002') {
        // IMUser.username is `@unique` globally — conflicting rename collides
        // here. Mirror the agent-rename surface's 409 contract.
        return c.json<ApiResponse>({ ok: false, error: 'Username already taken' }, 409);
      }
      console.error('[ME] PATCH failed', { imUserId, err: e?.message });
      return c.json<ApiResponse>({ ok: false, error: 'Profile update failed' }, 500);
    }
  });

  /**
   * GET /me/agents — list agents owned by the current human user.
   *
   * Mobile (luminmobile, Wave-7) calls this on app launch to populate the
   * Profile / agent runtime card. Returns the same shape as
   * GET /api/im/agents but scoped to ownership: agents whose IMUser.userId
   * matches the caller's cloudUserId.
   *
   * For api_key_proxy tokens this falls back to listing siblings of the
   * caller's IMUser (same userId), which is the closest analogue.
   */
  router.get('/agents', async (c) => {
    const authUser = c.get('user');

    const caller = await prisma.iMUser.findUnique({
      where: { id: authUser.imUserId },
      select: { userId: true, numericId: true },
    });
    const ownerClauses: any[] = [];
    if (caller?.userId) ownerClauses.push({ userId: caller.userId });
    if (caller?.numericId !== null && caller?.numericId !== undefined)
      ownerClauses.push({ numericId: caller.numericId });
    if (ownerClauses.length === 0) {
      // No cloudUserId on the human IMUser — no agents to return.
      return c.json<ApiResponse>({ ok: true, data: [] });
    }

    const agents = await prisma.iMUser.findMany({
      where: {
        role: 'agent',
        banned: false,
        agentCard: { isNot: null },
        AND: [{ OR: ownerClauses }],
      },
      include: { agentCard: true },
      orderBy: { createdAt: 'asc' },
    });

    type AgentRow = (typeof agents)[number];
    const data = agents.map((u: AgentRow) => {
      let capabilities: string[] = [];
      if (u.agentCard?.capabilities) {
        try {
          capabilities = JSON.parse(u.agentCard.capabilities);
        } catch {
          /* empty */
        }
      }
      return {
        id: u.id,
        username: u.username,
        displayName: u.displayName,
        agentType: u.agentType,
        avatarUrl: u.avatarUrl,
        createdAt: u.createdAt,
        card: u.agentCard
          ? {
              name: u.agentCard.name,
              description: u.agentCard.description,
              capabilities,
              endpoint: u.agentCard.endpoint,
              status: u.agentCard.status,
              workspaceId: u.agentCard.workspaceId,
              lastHeartbeat: u.agentCard.lastHeartbeat,
            }
          : null,
      };
    });

    return c.json<ApiResponse>({ ok: true, data });
  });

  /**
   * DELETE /me — self-service account deletion.
   *
   * The user can only delete themselves; we never accept a target id.
   * Soft-deletes the IMUser (banned=true), cascades to owned conversations
   * and open tasks, revokes pc_api_keys, and blacklists the request token.
   * See `account-delete.service.ts` for the full cascade contract.
   */
  router.delete('/', async (c) => {
    const authUser = c.get('user');
    const imUserId = authUser.imUserId;

    // Pull the raw bearer for blacklist; safe to read here because
    // authMiddleware has already verified it.
    const authHeader = c.req.header('Authorization') ?? '';
    const requestToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

    try {
      const result = await deleteAccountCascade({ imUserId, requestToken });
      return c.json<ApiResponse>({
        ok: true,
        data: {
          message: 'Account deleted',
          deletedAt: result.deletedAt,
          cascade: result.cascade,
        },
      });
    } catch (err) {
      if (err instanceof AccountDeletionError) {
        return c.json<ApiResponse>({ ok: false, error: err.message }, err.status as 404 | 500);
      }
      console.error('[ME] account deletion failed', { imUserId, err: (err as Error).message });
      return c.json<ApiResponse>({ ok: false, error: 'Account deletion failed' }, 500);
    }
  });

  return router;
}
