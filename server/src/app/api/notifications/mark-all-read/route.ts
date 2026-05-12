/**
 * PATCH /api/notifications/mark-all-read[?kind=tasks|contacts|runtime] — Wave-8 W9
 *
 * Sweeps every unread row for the caller. With `?kind=` only the rows
 * matching that tab are flipped, so "Mark all read" inside the Tasks tab
 * doesn't quietly clear an unread Runtime row the operator hasn't seen yet.
 */
import { NextRequest, NextResponse } from 'next/server';
import { FEATURE_FLAGS } from '@/lib/feature-flags';
import { getUserFromAuth } from '@/lib/auth-utils';
import { ensureNacosConfig } from '@/lib/nacos-config';
import { getNotifications, markAllRead } from '@/lib/db-notifications';

export const dynamic = 'force-dynamic';

export async function PATCH(request: NextRequest) {
  await ensureNacosConfig();

  if (!FEATURE_FLAGS.NOTIFICATIONS_LOCAL) {
    return NextResponse.json({ success: true });
  }

  const authResult = await getUserFromAuth(request.headers.get('Authorization'));
  if (!authResult.success || !authResult.user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const kind = searchParams.get('kind');

  await markAllRead(authResult.user.id, kind);
  const result = await getNotifications(authResult.user.id, { kindFilter: kind, limit: 100 });
  return NextResponse.json({
    success: true,
    data: result.notifications,
    unreadCount: result.unreadCount,
    unreadByKind: result.unreadByKind,
  });
}
