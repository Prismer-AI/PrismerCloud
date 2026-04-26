/**
 * Contact & Relationship Service (v1.8.0 P9)
 *
 * Friend requests, contact management, and blocking.
 */

import prisma from '../db';
import { createModuleLogger } from '../../lib/logger';

const log = createModuleLogger('ContactService');

export class ContactService {
  // ─── Friend Requests ───────────────────────────────────

  async sendRequest(fromUserId: string, toUserId: string, opts?: { reason?: string; source?: string }) {
    if (fromUserId === toUserId) {
      throw Object.assign(new Error('Cannot send friend request to yourself'), { status: 400, code: 'SELF_REQUEST' });
    }

    const blocked = await this.isBlocked(toUserId, fromUserId);
    if (blocked) {
      throw Object.assign(new Error('You are blocked by this user'), { status: 403, code: 'BLOCKED' });
    }

    const existing = await prisma.iMContactRelation.findUnique({
      where: { userId_contactId: { userId: fromUserId, contactId: toUserId } },
    });
    if (existing) {
      throw Object.assign(new Error('Already friends'), { status: 409, code: 'ALREADY_FRIENDS' });
    }

    const pending = await prisma.iMFriendRequest.findFirst({
      where: { fromUserId, toUserId, status: 'pending' },
    });
    if (pending) {
      throw Object.assign(new Error('Friend request already pending'), { status: 409, code: 'REQUEST_PENDING' });
    }

    // Reverse pending request → auto-accept
    const reverse = await prisma.iMFriendRequest.findFirst({
      where: { fromUserId: toUserId, toUserId: fromUserId, status: 'pending' },
    });
    if (reverse) {
      return this.acceptRequest(reverse.id, fromUserId);
    }

    const request = await prisma.iMFriendRequest.create({
      data: {
        fromUserId,
        toUserId,
        reason: opts?.reason,
        source: opts?.source,
        status: 'pending',
      },
      include: {
        fromUser: { select: { username: true, displayName: true, avatarUrl: true } },
        toUser: { select: { username: true, displayName: true, avatarUrl: true } },
      },
    });

    log.info(`Friend request sent: ${fromUserId} → ${toUserId}`);
    return request;
  }

  async pendingReceived(userId: string, pagination?: { limit: number; offset: number }) {
    return prisma.iMFriendRequest.findMany({
      where: { toUserId: userId, status: 'pending' },
      include: {
        fromUser: { select: { username: true, displayName: true, avatarUrl: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: pagination?.limit ?? 20,
      skip: pagination?.offset ?? 0,
    });
  }

  async pendingSent(userId: string, pagination?: { limit: number; offset: number }) {
    return prisma.iMFriendRequest.findMany({
      where: { fromUserId: userId, status: 'pending' },
      include: {
        toUser: { select: { username: true, displayName: true, avatarUrl: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: pagination?.limit ?? 20,
      skip: pagination?.offset ?? 0,
    });
  }

  async acceptRequest(requestId: string, acceptorId: string) {
    const result = await prisma.$transaction(async (tx: any) => {
      const request = await tx.iMFriendRequest.findUnique({
        where: { id: requestId },
        include: {
          fromUser: { select: { username: true, displayName: true } },
          toUser: { select: { username: true, displayName: true } },
        },
      });
      if (!request) {
        throw Object.assign(new Error('Friend request not found'), { status: 404, code: 'NOT_FOUND' });
      }
      if (request.status !== 'pending') {
        throw Object.assign(new Error('Request is no longer pending'), { status: 409, code: 'NOT_PENDING' });
      }
      // Only the receiver (toUserId) can accept; sender-initiated auto-accept
      // is handled in sendRequest() via reverse-request detection.
      if (request.toUserId !== acceptorId) {
        throw Object.assign(new Error('Not authorized to accept this request'), { status: 403, code: 'FORBIDDEN' });
      }

      const fromId = request.fromUserId;
      const toId = request.toUserId;

      await tx.iMFriendRequest.update({
        where: { id: requestId },
        data: { status: 'accepted' },
      });

      await tx.iMContactRelation.createMany({
        data: [
          { userId: fromId, contactId: toId },
          { userId: toId, contactId: fromId },
        ],
      });

      const existingConv = await tx.iMConversation.findFirst({
        where: {
          type: 'direct',
          AND: [{ participants: { some: { imUserId: fromId } } }, { participants: { some: { imUserId: toId } } }],
        },
      });

      let conversationId: string;
      if (existingConv) {
        conversationId = existingConv.id;
        if (existingConv.status === 'archived' || existingConv.status === 'deleted') {
          await tx.iMConversation.update({
            where: { id: existingConv.id },
            data: { status: 'active' },
          });
        }
      } else {
        const conv = await tx.iMConversation.create({
          data: {
            type: 'direct',
            status: 'active',
            createdById: fromId,
            participants: {
              create: [
                { imUserId: fromId, role: 'member' },
                { imUserId: toId, role: 'member' },
              ],
            },
          },
        });
        conversationId = conv.id;
      }

      return { conversationId, fromId, toId, request };
    });

    const contact = await prisma.iMContactRelation.findUnique({
      where: {
        userId_contactId: { userId: acceptorId, contactId: acceptorId === result.toId ? result.fromId : result.toId },
      },
    });

    log.info(`Request accepted: ${result.fromId} ↔ ${result.toId}, conv=${result.conversationId}`);
    return { contact, conversationId: result.conversationId, request: result.request };
  }

  async rejectRequest(requestId: string, rejecterId: string) {
    const request = await prisma.iMFriendRequest.findUnique({ where: { id: requestId } });
    if (!request) {
      throw Object.assign(new Error('Friend request not found'), { status: 404, code: 'NOT_FOUND' });
    }
    if (request.status !== 'pending') {
      throw Object.assign(new Error('Request is no longer pending'), { status: 409, code: 'NOT_PENDING' });
    }
    if (request.toUserId !== rejecterId) {
      throw Object.assign(new Error('Not authorized'), { status: 403, code: 'FORBIDDEN' });
    }

    await prisma.iMFriendRequest.update({
      where: { id: requestId },
      data: { status: 'rejected' },
    });

    log.info(`Request rejected: ${request.fromUserId} → ${rejecterId}`);
    return request;
  }

  // ─── Contact Management ────────────────────────────────

  async listFriends(userId: string, opts?: { limit: number; offset: number }) {
    const relations = await prisma.iMContactRelation.findMany({
      where: { userId },
      include: {
        contact: {
          select: {
            id: true,
            username: true,
            displayName: true,
            role: true,
            avatarUrl: true,
            agentType: true,
            institution: true,
            lastSeenAt: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: opts?.limit ?? 50,
      skip: opts?.offset ?? 0,
    });

    return relations.map((r: any) => ({
      userId: r.contactId,
      username: r.contact.username,
      displayName: r.contact.displayName,
      role: r.contact.role,
      avatarUrl: r.contact.avatarUrl,
      isAgent: r.contact.role === 'agent',
      institution: r.contact.institution ?? undefined,
      lastSeenAt: r.contact.lastSeenAt?.toISOString() ?? undefined,
      remark: r.remark,
      addedAt: r.createdAt.toISOString(),
    }));
  }

  async removeFriend(userId: string, contactId: string) {
    await prisma.iMContactRelation.deleteMany({
      where: {
        OR: [
          { userId, contactId },
          { userId: contactId, contactId: userId },
        ],
      },
    });
    log.info(`Friend removed: ${userId} ↔ ${contactId}`);
  }

  async setRemark(userId: string, contactId: string, remark: string) {
    const existing = await prisma.iMContactRelation.findUnique({
      where: { userId_contactId: { userId, contactId } },
    });
    if (!existing) {
      throw Object.assign(new Error('Not a friend'), { status: 404, code: 'NOT_FRIEND' });
    }

    await prisma.iMContactRelation.update({
      where: { userId_contactId: { userId, contactId } },
      data: { remark },
    });
  }

  // ─── Block / Unblock ───────────────────────────────────

  async block(userId: string, blockedId: string, reason?: string) {
    if (userId === blockedId) {
      throw Object.assign(new Error('Cannot block yourself'), { status: 400, code: 'SELF_BLOCK' });
    }

    await prisma.iMBlock.upsert({
      where: { userId_blockedId: { userId, blockedId } },
      create: { userId, blockedId, reason },
      update: { reason },
    });

    const isFriend = await prisma.iMContactRelation.findUnique({
      where: { userId_contactId: { userId, contactId: blockedId } },
    });
    if (isFriend) {
      await this.removeFriend(userId, blockedId);
    }

    log.info(`Blocked: ${userId} → ${blockedId}`);
  }

  async unblock(userId: string, blockedId: string) {
    await prisma.iMBlock.deleteMany({
      where: { userId, blockedId },
    });
    log.info(`Unblocked: ${userId} → ${blockedId}`);
  }

  async blocklist(userId: string, opts?: { limit: number; offset: number }) {
    const blocks = await prisma.iMBlock.findMany({
      where: { userId },
      include: {
        blocked: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatarUrl: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: opts?.limit ?? 50,
      skip: opts?.offset ?? 0,
    });

    return blocks.map((b: any) => ({
      userId: b.blockedId,
      username: b.blocked.username,
      displayName: b.blocked.displayName,
      avatarUrl: b.blocked.avatarUrl,
      reason: b.reason,
      blockedAt: b.createdAt.toISOString(),
    }));
  }

  async isBlocked(userId: string, targetId: string): Promise<boolean> {
    const block = await prisma.iMBlock.findUnique({
      where: { userId_blockedId: { userId, blockedId: targetId } },
    });
    return !!block;
  }

  /**
   * Check if messaging is blocked between two users.
   * Owner can always message their own agents (cloudUserId match).
   */
  async isBlockedForMessaging(senderId: string, receiverId: string): Promise<boolean> {
    const blocked = await this.isBlocked(receiverId, senderId);
    if (!blocked) return false;

    // Owner exemption: sender is the agent's owner
    const receiver = await prisma.iMUser.findUnique({
      where: { id: receiverId },
      select: { role: true, userId: true },
    });
    if (receiver?.role === 'agent' && receiver?.userId) {
      const sender = await prisma.iMUser.findUnique({
        where: { id: senderId },
        select: { userId: true },
      });
      if (sender?.userId && sender.userId === receiver.userId) {
        return false;
      }
    }

    return true;
  }

  /**
   * Expire pending friend requests older than the given number of days.
   * Returns the count of expired requests.
   */
  async expirePendingRequests(maxAgeDays = 30): Promise<number> {
    const cutoff = new Date(Date.now() - maxAgeDays * 86_400_000);
    const result = await prisma.iMFriendRequest.updateMany({
      where: {
        status: 'pending',
        createdAt: { lt: cutoff },
      },
      data: { status: 'expired' },
    });
    if (result.count > 0) {
      log.info(`Expired ${result.count} pending requests older than ${maxAgeDays}d`);
    }
    return result.count;
  }
}
