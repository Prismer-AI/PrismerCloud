/**
 * Friend & Contact Management API (v1.8.0 P9)
 *
 * Routes mounted under /contacts prefix (coexists with existing contacts router).
 *
 * Wave-8 W8: SSE fan-out — every contact mutation writes a sync event for both
 * sender and recipient via `syncService.writeEvent` so Contacts panels in
 * the workspace shell update without manual reload. Mirrors the WS
 * `rooms.sendToUser` path but reaches SSE-connected browser tabs through
 * Redis pub/sub at `im:sync:<userId>`.
 */

import { Hono } from 'hono';
import { authMiddleware } from '../auth/middleware';
import { ContactService } from '../services/contact.service';
import type { SyncService } from '../services/sync.service';
import prisma from '../db';
import type { RoomManager } from '../ws/rooms';
import { ServerEvents } from '../ws/events';
import { emitNotification } from '../../lib/notification-emitter';

// IMUser.id (cuid) → IMUser.numericId (BigInt, the canonical pc_notifications
// FK matched by /api/notifications JWT resolution). The legacy `userId`
// String field carries the old Go-backend user id which only matches numericId
// for users created before the consolidation — emitting against userId leaves
// notifications unreadable for newer accounts. Best-effort: agent-only rows
// without numericId are silently skipped.
async function notifyImUser(
  imUserId: string,
  type: 'info' | 'success' | 'warning' | 'error',
  title: string,
  message: string,
  referenceId: string,
): Promise<void> {
  try {
    const row = await prisma.iMUser.findUnique({
      where: { id: imUserId },
      select: { numericId: true },
    });
    const numericId = row?.numericId;
    if (numericId == null) return;
    const cloudId = typeof numericId === 'bigint' ? Number(numericId) : Number(numericId);
    if (!Number.isFinite(cloudId) || cloudId <= 0) return;
    emitNotification({ userId: cloudId, type, title, message, referenceType: 'contact', referenceId });
  } catch (err) {
    // Notification publish is best-effort — don't fail the contact mutation.
    console.error('[friend] notifyImUser failed:', err);
  }
}

/**
 * Wave-8 W8: write the same payload as a sync event for both peers so SSE
 * subscribers (Contacts panel, etc.) reload without manual refresh. We pass
 * `null` for conversationId — these aren't conversation-scoped events. The
 * sync service publishes to `im:sync:<userId>` for each recipient.
 */
async function fanOutContactSync(
  syncService: SyncService | undefined,
  type: string,
  data: Record<string, unknown>,
  recipientIds: string[],
): Promise<void> {
  if (!syncService) return;
  const seen = new Set<string>();
  await Promise.all(
    recipientIds
      .filter((id) => id && !seen.has(id) && (seen.add(id), true))
      .map((id) =>
        syncService.writeEvent(type, data, null, id).catch((err) => {
          // Sync fan-out is best-effort — WS already delivered to live clients,
          // and the panel still reloads on user-driven actions.
          console.error('[friend] sync fan-out failed for', id, err);
        }),
      ),
  );
}

export function createFriendRouter(
  contactService: ContactService,
  rooms: RoomManager,
  syncService?: SyncService,
): Hono {
  const router = new Hono();
  router.use('*', authMiddleware);

  // POST /contacts/request — Send friend request
  router.post('/request', async (c) => {
    const user = c.get('user' as any) as any;
    const { userId: toUserId, reason, source } = await c.req.json();

    if (!toUserId) {
      return c.json({ ok: false, error: 'userId is required' }, 400);
    }

    try {
      const fromId = user.imUserId ?? user.sub ?? user.id;
      const request = await contactService.sendRequest(fromId, toUserId, { reason, source });

      const payload = {
        requestId: request.id,
        fromUserId: fromId,
        toUserId,
        fromUsername: request.fromUser?.username,
        fromDisplayName: request.fromUser?.displayName,
        reason,
        source,
      };

      rooms.sendToUser(toUserId, ServerEvents.contactRequest(payload));
      // Sender also needs the SSE ping so their Sent tab shows the new row
      // without waiting for the user-driven reload — mirror over to both.
      await fanOutContactSync(syncService, 'contact.request', { ...payload, createdAt: new Date().toISOString() }, [
        fromId,
        toUserId,
      ]);

      const fromLabel = request.fromUser?.displayName ?? request.fromUser?.username ?? 'Someone';
      await notifyImUser(
        toUserId,
        'info',
        `Friend request from ${fromLabel}`,
        reason || `${fromLabel} wants to connect on Prismer.`,
        request.id,
      );

      return c.json({ ok: true, data: request });
    } catch (err: any) {
      return c.json({ ok: false, error: err.message, code: err.code }, err.status || 500);
    }
  });

  // GET /contacts/requests/received — List pending received requests
  router.get('/requests/received', async (c) => {
    const user = c.get('user' as any) as any;
    const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '20', 10) || 20, 1), 100);
    const offset = Math.max(parseInt(c.req.query('offset') || '0', 10) || 0, 0);

    const data = await contactService.pendingReceived(user.imUserId ?? user.sub ?? user.id, { limit, offset });
    return c.json({ ok: true, data });
  });

  // GET /contacts/requests/sent — List pending sent requests
  router.get('/requests/sent', async (c) => {
    const user = c.get('user' as any) as any;
    const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '20', 10) || 20, 1), 100);
    const offset = Math.max(parseInt(c.req.query('offset') || '0', 10) || 0, 0);

    const data = await contactService.pendingSent(user.imUserId ?? user.sub ?? user.id, { limit, offset });
    return c.json({ ok: true, data });
  });

  // POST /contacts/requests/:id/accept
  router.post('/requests/:id/accept', async (c) => {
    const user = c.get('user' as any) as any;
    const requestId = c.req.param('id');

    try {
      const acceptorId = user.imUserId ?? user.sub ?? user.id;
      const result = await contactService.acceptRequest(requestId, acceptorId);

      const fromId = result.request?.fromUserId;
      const toId = result.request?.toUserId;
      if (fromId && toId && result.conversationId) {
        const fromLabel = (result.request as any)?.fromUser?.displayName ?? (result.request as any)?.fromUser?.username;
        const toLabel = (result.request as any)?.toUser?.displayName ?? (result.request as any)?.toUser?.username;
        // Send to fromUser with toUser's info
        rooms.sendToUser(
          fromId,
          ServerEvents.contactAccepted({
            fromUserId: fromId,
            toUserId: toId,
            conversationId: result.conversationId,
            username: (result.request as any)?.toUser?.username,
            displayName: toLabel,
          }),
        );
        // Send to toUser with fromUser's info
        rooms.sendToUser(
          toId,
          ServerEvents.contactAccepted({
            fromUserId: fromId,
            toUserId: toId,
            conversationId: result.conversationId,
            username: (result.request as any)?.fromUser?.username,
            displayName: fromLabel,
          }),
        );

        // SSE fan-out so workspace panels invalidate friends/sent/received
        // queries without waiting for a manual reload.
        await fanOutContactSync(
          syncService,
          'contact.accepted',
          {
            requestId,
            fromUserId: fromId,
            toUserId: toId,
            conversationId: result.conversationId,
            acceptedAt: new Date().toISOString(),
          },
          [fromId, toId],
        );

        // Notify the original sender — receiver already has UI feedback from
        // their accept click, but the sender needs an out-of-band ping to know
        // a chat is now open with them.
        await notifyImUser(
          fromId,
          'success',
          `${toLabel ?? 'Your contact'} accepted your friend request`,
          `You can now chat directly with ${toLabel ?? 'them'}.`,
          requestId,
        );
      }

      return c.json({ ok: true, data: result });
    } catch (err: any) {
      return c.json({ ok: false, error: err.message, code: err.code }, err.status || 500);
    }
  });

  // POST /contacts/requests/:id/reject
  router.post('/requests/:id/reject', async (c) => {
    const user = c.get('user' as any) as any;
    const requestId = c.req.param('id');

    try {
      const rejecterId = user.imUserId ?? user.sub ?? user.id;
      const rejected = await contactService.rejectRequest(requestId, rejecterId);

      if (rejected?.fromUserId) {
        rooms.sendToUser(
          rejected.fromUserId,
          ServerEvents.contactRejected({
            fromUserId: rejected.fromUserId,
            toUserId: rejecterId,
            requestId,
          }),
        );

        await fanOutContactSync(
          syncService,
          'contact.rejected',
          {
            requestId,
            fromUserId: rejected.fromUserId,
            toUserId: rejecterId,
            rejectedAt: new Date().toISOString(),
          },
          [rejected.fromUserId, rejecterId],
        );

        // The sender hears about the decline through the bell — no rich detail
        // (don't reveal who rejected if we can avoid it). Keep the message
        // neutral so it doesn't read as accusatory.
        await notifyImUser(
          rejected.fromUserId,
          'info',
          'Friend request declined',
          'The recipient declined your friend request.',
          requestId,
        );
      }

      return c.json({ ok: true });
    } catch (err: any) {
      return c.json({ ok: false, error: err.message, code: err.code }, err.status || 500);
    }
  });

  // DELETE /contacts/requests/:id/cancel — Sender cancels their own pending request
  //
  // Wave-8 W8 C4: pairs with the Sent-tab Cancel button in ContactsPanel.
  // Idempotency mirrors rejectRequest (prior 'cancelled' rows wiped before
  // flipping status). Recipient receives a `contact.cancelled` notification
  // so their Bell drawer no longer flags the (now-revoked) pending request.
  router.delete('/requests/:id/cancel', async (c) => {
    const user = c.get('user' as any) as any;
    const requestId = c.req.param('id');

    try {
      const cancellerId = user.imUserId ?? user.sub ?? user.id;
      const cancelled = await contactService.cancelRequest(requestId, cancellerId);

      if (cancelled?.toUserId) {
        rooms.sendToUser(
          cancelled.toUserId,
          ServerEvents.contactCancelled({
            fromUserId: cancellerId,
            toUserId: cancelled.toUserId,
            requestId,
          }),
        );

        await fanOutContactSync(
          syncService,
          'contact.cancelled',
          {
            requestId,
            fromUserId: cancellerId,
            toUserId: cancelled.toUserId,
            cancelledAt: new Date().toISOString(),
          },
          [cancellerId, cancelled.toUserId],
        );

        // Tell the recipient the request was withdrawn so their navbar Bell
        // stops surfacing the pending entry. info type — dismissable, no
        // action required.
        await notifyImUser(
          cancelled.toUserId,
          'info',
          'Friend request withdrawn',
          'A pending friend request was withdrawn by the sender.',
          requestId,
        );
      }

      return c.json({ ok: true });
    } catch (err: any) {
      return c.json({ ok: false, error: err.message, code: err.code }, err.status || 500);
    }
  });

  // GET /contacts/friends — List friends (independent from GET /contacts)
  router.get('/friends', async (c) => {
    const user = c.get('user' as any) as any;
    const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '50', 10) || 50, 1), 100);
    const offset = Math.max(parseInt(c.req.query('offset') || '0', 10) || 0, 0);

    const data = await contactService.listFriends(user.imUserId ?? user.sub ?? user.id, { limit, offset });
    return c.json({ ok: true, data });
  });

  // GET /contacts/status?username=X — Relationship status for the lookup target
  //
  // Wave-8 W8 C5: powers the inline relationship chip in NewChannelDialog
  // (and any future "Add friend by username" surface). Returns one of:
  //   self | friend | pending_sent | pending_received | blocked_by_me
  //   blocked_by_them | stranger
  // along with the resolved IMUser identity so callers can show display name
  // without a second round trip. Not authoritative — the actual friend-request
  // mutations re-check on the server.
  router.get('/status', async (c) => {
    const user = c.get('user' as any) as any;
    const me = user.imUserId ?? user.sub ?? user.id;
    const usernameQuery = c.req.query('username');
    const userIdQuery = c.req.query('userId');
    if (!usernameQuery && !userIdQuery) {
      return c.json({ ok: false, error: 'username or userId required' }, 400);
    }

    let target: { id: string; username: string; displayName: string; role: string } | null = null;
    if (userIdQuery) {
      target = await prisma.iMUser.findUnique({
        where: { id: userIdQuery },
        select: { id: true, username: true, displayName: true, role: true },
      });
    } else if (usernameQuery) {
      const cleaned = usernameQuery.replace(/^@/, '');
      target = await prisma.iMUser.findFirst({
        where: { username: cleaned },
        select: { id: true, username: true, displayName: true, role: true },
      });
    }
    if (!target) {
      return c.json({ ok: false, error: 'User not found' }, 404);
    }

    if (target.id === me) {
      return c.json({
        ok: true,
        data: { status: 'self', user: target },
      });
    }

    // Run all four relationship lookups in parallel; the panel needs every
    // edge to render a single chip. Only one of these maps to the final
    // status — block edges win over friend/pending so blocked users can't
    // be friended around the dialog.
    const [blockByMe, blockByThem, friend, sent, received] = await Promise.all([
      prisma.iMBlock.findUnique({ where: { userId_blockedId: { userId: me, blockedId: target.id } } }),
      prisma.iMBlock.findUnique({ where: { userId_blockedId: { userId: target.id, blockedId: me } } }),
      prisma.iMContactRelation.findUnique({ where: { userId_contactId: { userId: me, contactId: target.id } } }),
      prisma.iMFriendRequest.findFirst({
        where: { fromUserId: me, toUserId: target.id, status: 'pending' },
        select: { id: true },
      }),
      prisma.iMFriendRequest.findFirst({
        where: { fromUserId: target.id, toUserId: me, status: 'pending' },
        select: { id: true },
      }),
    ]);

    let status: string;
    if (blockByMe) status = 'blocked_by_me';
    else if (blockByThem) status = 'blocked_by_them';
    else if (friend) status = 'friend';
    else if (sent) status = 'pending_sent';
    else if (received) status = 'pending_received';
    else status = 'stranger';

    return c.json({
      ok: true,
      data: {
        status,
        user: target,
        requestId: sent?.id ?? received?.id ?? undefined,
      },
    });
  });

  // DELETE /contacts/:userId/remove — Remove friend
  router.delete('/:userId/remove', async (c) => {
    const user = c.get('user' as any) as any;
    const contactId = c.req.param('userId');

    try {
      const myId = user.imUserId ?? user.sub ?? user.id;
      await contactService.removeFriend(myId, contactId);

      rooms.sendToUser(contactId, ServerEvents.contactRemoved({ userId: myId, removedUserId: contactId }));
      await fanOutContactSync(
        syncService,
        'contact.removed',
        { userId: myId, removedUserId: contactId, removedAt: new Date().toISOString() },
        [myId, contactId],
      );

      return c.json({ ok: true });
    } catch (err: any) {
      return c.json({ ok: false, error: err.message, code: err.code }, err.status || 500);
    }
  });

  // PATCH /contacts/:userId/remark — Set remark
  router.patch('/:userId/remark', async (c) => {
    const user = c.get('user' as any) as any;
    const contactId = c.req.param('userId');
    const { remark } = await c.req.json();

    if (typeof remark !== 'string' || remark.length > 500) {
      return c.json({ ok: false, error: 'Remark must be a string of 0-500 characters' }, 400);
    }

    try {
      await contactService.setRemark(user.imUserId ?? user.sub ?? user.id, contactId, remark);
      return c.json({ ok: true });
    } catch (err: any) {
      return c.json({ ok: false, error: err.message, code: err.code }, err.status || 500);
    }
  });

  // POST /contacts/:userId/block — Block user
  router.post('/:userId/block', async (c) => {
    const user = c.get('user' as any) as any;
    const blockedId = c.req.param('userId');
    const body = await c.req.json().catch(() => ({}));

    try {
      const myId = user.imUserId ?? user.sub ?? user.id;
      await contactService.block(myId, blockedId, body.reason);

      rooms.sendToUser(blockedId, ServerEvents.contactBlocked({ userId: myId, blockedUserId: blockedId }));
      await fanOutContactSync(
        syncService,
        'contact.blocked',
        { userId: myId, blockedUserId: blockedId, blockedAt: new Date().toISOString() },
        [myId, blockedId],
      );

      return c.json({ ok: true });
    } catch (err: any) {
      return c.json({ ok: false, error: err.message, code: err.code }, err.status || 500);
    }
  });

  // DELETE /contacts/:userId/block — Unblock user
  router.delete('/:userId/block', async (c) => {
    const user = c.get('user' as any) as any;
    const blockedId = c.req.param('userId');

    try {
      await contactService.unblock(user.imUserId ?? user.sub ?? user.id, blockedId);
      return c.json({ ok: true });
    } catch (err: any) {
      return c.json({ ok: false, error: err.message, code: err.code }, err.status || 500);
    }
  });

  // GET /contacts/blocked — Get blocklist
  router.get('/blocked', async (c) => {
    const user = c.get('user' as any) as any;
    const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '50', 10) || 50, 1), 100);
    const offset = Math.max(Math.max(parseInt(c.req.query('offset') || '0', 10) || 0, 0));

    const data = await contactService.blocklist(user.imUserId ?? user.sub ?? user.id, { limit, offset });
    return c.json({ ok: true, data });
  });

  return router;
}
