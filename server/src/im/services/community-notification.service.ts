/**
 * Prismer IM — Community Notification Service
 *
 * Tracks mentions, replies, votes, best-answer events.
 * Stores notifications in IMUser.metadata under key `communityNotifications`.
 */

import { prisma } from '@/lib/prisma';
import { safeJsonParse } from '../utils/safe-json';

const NOTIFICATIONS_KEY = 'communityNotifications';
const MAX_NOTIFICATIONS = 100;

export interface CommunityNotification {
  id: string;
  type: 'reply' | 'vote' | 'best_answer' | 'mention' | 'follow';
  postId: string;
  postTitle: string;
  commentId?: string;
  actorId: string;
  actorName: string;
  read: boolean;
  createdAt: string;
}

function generateNotificationId(): string {
  return `notif_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export class CommunityNotificationService {

  async notify(userId: string, notification: Omit<CommunityNotification, 'id' | 'read' | 'createdAt'>, retries = 2): Promise<void> {
    try {
      // Use serializable transaction to prevent concurrent read-modify-write
      // from losing notifications (lost-update race condition)
      await prisma.$transaction(async (tx: any) => {
        const user = await tx.iMUser.findUnique({
          where: { id: userId },
          select: { metadata: true },
        });
        if (!user) return;

        const meta = safeJsonParse<Record<string, unknown>>(user.metadata, {});
        const existing = Array.isArray(meta[NOTIFICATIONS_KEY])
          ? (meta[NOTIFICATIONS_KEY] as CommunityNotification[])
          : [];

        const entry: CommunityNotification = {
          ...notification,
          id: generateNotificationId(),
          read: false,
          createdAt: new Date().toISOString(),
        };

        existing.unshift(entry);
        const trimmed = existing.slice(0, MAX_NOTIFICATIONS);

        await tx.iMUser.update({
          where: { id: userId },
          data: { metadata: JSON.stringify({ ...meta, [NOTIFICATIONS_KEY]: trimmed }) },
        });
      }, { isolationLevel: 'Serializable' });
    } catch (e: any) {
      // Retry on serialization failure (concurrent write conflict)
      if (retries > 0 && e?.code === 'P2034') {
        await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
        return this.notify(userId, notification, retries - 1);
      }
      console.error('[CommunityNotification] Failed to notify:', e);
    }
  }

  async getNotifications(
    userId: string,
    opts?: { unread?: boolean; limit?: number; offset?: number },
  ): Promise<{ items: CommunityNotification[]; total: number }> {
    try {
      const user = await prisma.iMUser.findUnique({
        where: { id: userId },
        select: { metadata: true },
      });
      if (!user) return { items: [], total: 0 };

      const meta = safeJsonParse<Record<string, unknown>>(user.metadata, {});
      let list = Array.isArray(meta[NOTIFICATIONS_KEY])
        ? (meta[NOTIFICATIONS_KEY] as CommunityNotification[])
        : [];

      if (opts?.unread) {
        list = list.filter((n) => !n.read);
      }
      const total = list.length;
      const off = Math.max(0, opts?.offset ?? 0);
      if (opts?.limit != null) {
        list = list.slice(off, off + opts.limit);
      } else {
        list = list.slice(off);
      }
      return { items: list, total };
    } catch (e) {
      console.error('[CommunityNotification] Failed to get notifications:', e);
      return { items: [], total: 0 };
    }
  }

  async markRead(userId: string, notificationId: string): Promise<boolean> {
    try {
      const user = await prisma.iMUser.findUnique({
        where: { id: userId },
        select: { metadata: true },
      });
      if (!user) return false;

      const meta = safeJsonParse<Record<string, unknown>>(user.metadata, {});
      const list = Array.isArray(meta[NOTIFICATIONS_KEY])
        ? (meta[NOTIFICATIONS_KEY] as CommunityNotification[])
        : [];

      const target = list.find((n) => n.id === notificationId);
      if (!target) return false;
      target.read = true;

      await prisma.iMUser.update({
        where: { id: userId },
        data: { metadata: JSON.stringify({ ...meta, [NOTIFICATIONS_KEY]: list }) },
      });
      return true;
    } catch (e) {
      console.error('[CommunityNotification] Failed to mark read:', e);
      return false;
    }
  }

  async markAllRead(userId: string): Promise<number> {
    try {
      const user = await prisma.iMUser.findUnique({
        where: { id: userId },
        select: { metadata: true },
      });
      if (!user) return 0;

      const meta = safeJsonParse<Record<string, unknown>>(user.metadata, {});
      const list = Array.isArray(meta[NOTIFICATIONS_KEY])
        ? (meta[NOTIFICATIONS_KEY] as CommunityNotification[])
        : [];

      let count = 0;
      for (const n of list) {
        if (!n.read) {
          n.read = true;
          count++;
        }
      }
      if (count === 0) return 0;

      await prisma.iMUser.update({
        where: { id: userId },
        data: { metadata: JSON.stringify({ ...meta, [NOTIFICATIONS_KEY]: list }) },
      });
      return count;
    } catch (e) {
      console.error('[CommunityNotification] Failed to mark all read:', e);
      return 0;
    }
  }

  async getUnreadCount(userId: string): Promise<number> {
    try {
      const user = await prisma.iMUser.findUnique({
        where: { id: userId },
        select: { metadata: true },
      });
      if (!user) return 0;

      const meta = safeJsonParse<Record<string, unknown>>(user.metadata, {});
      const list = Array.isArray(meta[NOTIFICATIONS_KEY])
        ? (meta[NOTIFICATIONS_KEY] as CommunityNotification[])
        : [];

      return list.filter((n) => !n.read).length;
    } catch (e) {
      console.error('[CommunityNotification] Failed to get unread count:', e);
      return 0;
    }
  }
}
