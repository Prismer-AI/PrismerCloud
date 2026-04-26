/**
 * Friend & Contact Management API (v1.8.0 P9)
 *
 * Routes mounted under /contacts prefix (coexists with existing contacts router).
 */

import { Hono } from 'hono';
import { authMiddleware } from '../auth/middleware';
import { ContactService } from '../services/contact.service';
import type { RoomManager } from '../ws/rooms';
import { ServerEvents } from '../ws/events';

export function createFriendRouter(contactService: ContactService, rooms: RoomManager): Hono {
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

      rooms.sendToUser(
        toUserId,
        ServerEvents.contactRequest({
          requestId: request.id,
          fromUserId: fromId,
          toUserId,
          fromUsername: request.fromUser?.username,
          fromDisplayName: request.fromUser?.displayName,
          reason,
          source,
        }),
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
        // Send to fromUser with toUser's info
        rooms.sendToUser(
          fromId,
          ServerEvents.contactAccepted({
            fromUserId: fromId,
            toUserId: toId,
            conversationId: result.conversationId,
            username: (result.request as any)?.toUser?.username,
            displayName: (result.request as any)?.toUser?.displayName,
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
            displayName: (result.request as any)?.fromUser?.displayName,
          }),
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

  // DELETE /contacts/:userId/remove — Remove friend
  router.delete('/:userId/remove', async (c) => {
    const user = c.get('user' as any) as any;
    const contactId = c.req.param('userId');

    try {
      const myId = user.imUserId ?? user.sub ?? user.id;
      await contactService.removeFriend(myId, contactId);

      rooms.sendToUser(contactId, ServerEvents.contactRemoved({ userId: myId, removedUserId: contactId }));

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
    const offset = Math.max(parseInt(c.req.query('offset') || '0', 10) || 0, 0);

    const data = await contactService.blocklist(user.imUserId ?? user.sub ?? user.id, { limit, offset });
    return c.json({ ok: true, data });
  });

  return router;
}
