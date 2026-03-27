import { NextRequest, NextResponse } from 'next/server';
import { ensureNacosConfig } from '@/lib/nacos-config';
import { getUserFromAuth } from '@/lib/auth-utils';
import { getAdminAnalytics } from '@/lib/db-admin';

const ADMIN_EMAILS = ['tomwinshare@gmail.com'];

/**
 * GET /api/admin/analytics?period=7d|30d|90d
 *
 * Platform-wide business analytics.
 * Auth: JWT required, email must be in ADMIN_EMAILS whitelist.
 */
export async function GET(request: NextRequest) {
  try {
    await ensureNacosConfig();

    // Auth guard
    const authHeader = request.headers.get('authorization');
    const auth = await getUserFromAuth(authHeader);
    if (!auth.success || !auth.user) {
      return NextResponse.json(
        { success: false, error: { code: 'UNAUTHORIZED', message: 'Login required' } },
        { status: 401 }
      );
    }
    if (!ADMIN_EMAILS.includes(auth.user.email)) {
      return NextResponse.json(
        { success: false, error: { code: 'FORBIDDEN', message: 'Admin access only' } },
        { status: 403 }
      );
    }

    const { searchParams } = new URL(request.url);
    const period = searchParams.get('period') || '30d';

    const data = await getAdminAnalytics(period);

    return NextResponse.json({
      success: true,
      data,
      period,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Admin Analytics] Error:', error);
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_ERROR', message: String(error) } },
      { status: 500 }
    );
  }
}
