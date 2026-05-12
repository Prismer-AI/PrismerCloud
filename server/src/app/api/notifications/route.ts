import { NextResponse } from 'next/server';
import { MOCK_NOTIFICATIONS } from '@/lib/mock-data';
import { FEATURE_FLAGS } from '@/lib/feature-flags';
import { getUserFromAuth } from '@/lib/auth-utils';
import { ensureNacosConfig } from '@/lib/nacos-config';
import { getNotifications, markRead, markAllRead as markAllReadDb, deleteNotification } from '@/lib/db-notifications';

// Mock fallback (when flag is off)
let mockNotifications = [...MOCK_NOTIFICATIONS];

/**
 * GET /api/notifications?kind=tasks|contacts|runtime
 *
 * Wave-8 W9: the workspace Bell drawer reads this with `?kind=` to populate
 * its tab views. Without the param the legacy "all" view is returned (used by
 * the navbar dropdown). Mock fallback ignores the filter — only the live DB
 * path can group, and the mock list only has 3 rows anyway.
 */
export async function GET(request: Request) {
  await ensureNacosConfig();

  const { searchParams } = new URL(request.url);
  const kindFilter = searchParams.get('kind');

  if (FEATURE_FLAGS.NOTIFICATIONS_LOCAL) {
    const authHeader = request.headers.get('Authorization');
    const authResult = await getUserFromAuth(authHeader);
    if (!authResult.success || !authResult.user) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { notifications, unreadCount, unreadByKind } = await getNotifications(authResult.user.id, {
      kindFilter,
      limit: 100,
    });
    return NextResponse.json({ success: true, data: notifications, unreadCount, unreadByKind });
  }

  // Mock fallback
  const unreadCount = mockNotifications.filter((n) => !n.read).length;
  return NextResponse.json({ success: true, data: mockNotifications, unreadCount, unreadByKind: {} });
}

/**
 * PATCH /api/notifications — mark-as-read
 *
 * Body shapes accepted (all live in the same handler so the existing navbar
 * dropdown's `{ markAllRead: true }` keeps working):
 *   - `{ ids: string[] }`               — mark a list of rows read
 *   - `{ id: string }`                  — mark a single row read (W9)
 *   - `{ markAllRead: true }`           — mark every unread row read
 *   - `{ markAllRead: true, kind }`     — mark every unread row read **for the
 *                                          tab** (W9)
 */
export async function PATCH(request: Request) {
  await ensureNacosConfig();

  try {
    const body = await request.json();
    const { ids, id, markAllRead, kind } = body as {
      ids?: string[];
      id?: string;
      markAllRead?: boolean;
      kind?: string | null;
    };

    if (FEATURE_FLAGS.NOTIFICATIONS_LOCAL) {
      const authHeader = request.headers.get('Authorization');
      const authResult = await getUserFromAuth(authHeader);
      if (!authResult.success || !authResult.user) {
        return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
      }

      if (markAllRead) {
        await markAllReadDb(authResult.user.id, kind ?? null);
      } else if (id) {
        await markRead(id, authResult.user.id);
      } else if (ids && Array.isArray(ids)) {
        for (const next of ids) {
          await markRead(next, authResult.user.id);
        }
      }

      const result = await getNotifications(authResult.user.id, { kindFilter: kind ?? null, limit: 100 });
      return NextResponse.json({
        success: true,
        data: result.notifications,
        unreadCount: result.unreadCount,
        unreadByKind: result.unreadByKind,
      });
    }

    // Mock fallback
    if (markAllRead) {
      mockNotifications = mockNotifications.map((n) => ({ ...n, read: true }));
    } else if (id) {
      mockNotifications = mockNotifications.map((n) => (n.id === id ? { ...n, read: true } : n));
    } else if (ids && Array.isArray(ids)) {
      mockNotifications = mockNotifications.map((n) => (ids.includes(n.id) ? { ...n, read: true } : n));
    }
    const unreadCount = mockNotifications.filter((n) => !n.read).length;
    return NextResponse.json({ success: true, data: mockNotifications, unreadCount, unreadByKind: {} });
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

      const result = await getNotifications(authResult.user.id, { limit: 100 });
      return NextResponse.json({
        success: true,
        data: result.notifications,
        unreadCount: result.unreadCount,
        unreadByKind: result.unreadByKind,
      });
    }

    // Mock fallback
    if (clearAll === 'true') {
      mockNotifications = [];
    } else if (id) {
      mockNotifications = mockNotifications.filter((n) => n.id !== id);
    }
    const unreadCount = mockNotifications.filter((n) => !n.read).length;
    return NextResponse.json({ success: true, data: mockNotifications, unreadCount, unreadByKind: {} });
  } catch (error) {
    return NextResponse.json({ success: false, error: 'Failed to delete notification' }, { status: 400 });
  }
}
