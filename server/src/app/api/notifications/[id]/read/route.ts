/**
 * PATCH /api/notifications/:id/read — Wave-8 W9
 *
 * Per-row mark-as-read for the workspace Bell. The drawer hits this when a
 * notification row is clicked (so closing the drawer doesn't mass-mark the
 * unrelated unread rows). Reuses the existing /api/notifications PATCH
 * `{ id }` shape under the hood — this route exists for a clean RESTful URL
 * surface and to keep the click-handler URL stable across W9 / future bells.
 */
import { NextRequest, NextResponse } from 'next/server';
import { FEATURE_FLAGS } from '@/lib/feature-flags';
import { getUserFromAuth } from '@/lib/auth-utils';
import { ensureNacosConfig } from '@/lib/nacos-config';
import { getNotifications, markRead } from '@/lib/db-notifications';

export const dynamic = 'force-dynamic';

export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  await ensureNacosConfig();

  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json({ success: false, error: 'id required' }, { status: 400 });
  }

  if (!FEATURE_FLAGS.NOTIFICATIONS_LOCAL) {
    return NextResponse.json({ success: true });
  }

  const authResult = await getUserFromAuth(request.headers.get('Authorization'));
  if (!authResult.success || !authResult.user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  await markRead(id, authResult.user.id);

  // Return refreshed counts so the Bell can update its badge in one round trip.
  const result = await getNotifications(authResult.user.id, { limit: 100 });
  return NextResponse.json({
    success: true,
    unreadCount: result.unreadCount,
    unreadByKind: result.unreadByKind,
  });
}
