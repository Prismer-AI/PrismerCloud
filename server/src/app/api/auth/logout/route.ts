import { NextRequest, NextResponse } from 'next/server';
import { logoutAndBlacklist, LocalAuthError } from '@/lib/auth/local-auth';

/**
 * POST /api/auth/logout
 * Invalidates the bearer token by adding it to a Redis blacklist with
 * TTL = remaining JWT lifetime. After expiry the entry self-evicts.
 *
 * Mirrors the Go backend's logout semantics so existing clients that
 * call POST /api/auth/logout continue to work.
 */
export async function POST(request: NextRequest) {
  try {
    const header = request.headers.get('authorization') || '';
    const m = header.match(/^Bearer\s+(.+)$/i);
    const token = m ? m[1].trim() : '';

    if (!token) {
      return NextResponse.json({ error: { code: 401, msg: 'Authorization header is required' } }, { status: 401 });
    }

    const result = await logoutAndBlacklist(token);
    return NextResponse.json(result);
  } catch (error: any) {
    const status = error instanceof LocalAuthError ? error.status : 500;
    const code = error instanceof LocalAuthError ? error.code : 500;
    return NextResponse.json({ error: { code, msg: error.message || 'Logout failed' } }, { status });
  }
}
