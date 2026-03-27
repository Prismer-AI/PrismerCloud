import { NextResponse } from 'next/server';
import { MOCK_NOTIFICATIONS } from '@/lib/mock-data';
import { FEATURE_FLAGS } from '@/lib/feature-flags';
import { getUserFromAuth } from '@/lib/auth-utils';
import { ensureNacosConfig } from '@/lib/nacos-config';
import {
  getNotifications,
  markRead,
  markAllRead as markAllReadDb,
  deleteNotification,
} from '@/lib/db-notifications';

// Mock fallback (when flag is off)
let mockNotifications = [...MOCK_NOTIFICATIONS];

/**
 * GET /api/notifications
 */
export async function GET(request: Request) {
  await ensureNacosConfig();

  if (FEATURE_FLAGS.NOTIFICATIONS_LOCAL) {
    const authHeader = request.headers.get('Authorization');
    const authResult = await getUserFromAuth(authHeader);
    if (!authResult.success || !authResult.user) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { notifications, unreadCount } = await getNotifications(authResult.user.id);
    return NextResponse.json({ success: true, data: notifications, unreadCount });
  }

  // Mock fallback
  const unreadCount = mockNotifications.filter(n => !n.read).length;
  return NextResponse.json({ success: true, data: mockNotifications, unreadCount });
}

/**
 * PATCH /api/notifications — Mark as read
 */
export async function PATCH(request: Request) {
  await ensureNacosConfig();

  try {
    const body = await request.json();
    const { ids, markAllRead } = body;

    if (FEATURE_FLAGS.NOTIFICATIONS_LOCAL) {
      const authHeader = request.headers.get('Authorization');
      const authResult = await getUserFromAuth(authHeader);
      if (!authResult.success || !authResult.user) {
        return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
      }

      if (markAllRead) {
        await markAllReadDb(authResult.user.id);
      } else if (ids && Array.isArray(ids)) {
        for (const id of ids) {
          await markRead(id, authResult.user.id);
        }
      }

      const result = await getNotifications(authResult.user.id);
      return NextResponse.json({ success: true, data: result.notifications, unreadCount: result.unreadCount });
    }

    // Mock fallback
    if (markAllRead) {
      mockNotifications = mockNotifications.map(n => ({ ...n, read: true }));
    } else if (ids && Array.isArray(ids)) {
      mockNotifications = mockNotifications.map(n =>
        ids.includes(n.id) ? { ...n, read: true } : n
      );
    }
    const unreadCount = mockNotifications.filter(n => !n.read).length;
    return NextResponse.json({ success: true, data: mockNotifications, unreadCount });
  } catch (error) {
    return NextResponse.json({ success: false, error: 'Failed to update notifications' }, { status: 400 });
  }
}

/**
 * DELETE /api/notifications
 */
export async function DELETE(request: Request) {
  await ensureNacosConfig();

  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    const clearAll = searchParams.get('clearAll');

    if (FEATURE_FLAGS.NOTIFICATIONS_LOCAL) {
      const authHeader = request.headers.get('Authorization');
      const authResult = await getUserFromAuth(authHeader);
      if (!authResult.success || !authResult.user) {
        return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
      }

      if (id) {
        await deleteNotification(id, authResult.user.id);
      }

      const result = await getNotifications(authResult.user.id);
      return NextResponse.json({ success: true, data: result.notifications, unreadCount: result.unreadCount });
    }

    // Mock fallback
    if (clearAll === 'true') {
      mockNotifications = [];
    } else if (id) {
      mockNotifications = mockNotifications.filter(n => n.id !== id);
    }
    const unreadCount = mockNotifications.filter(n => !n.read).length;
    return NextResponse.json({ success: true, data: mockNotifications, unreadCount });
  } catch (error) {
    return NextResponse.json({ success: false, error: 'Failed to delete notification' }, { status: 400 });
  }
}
