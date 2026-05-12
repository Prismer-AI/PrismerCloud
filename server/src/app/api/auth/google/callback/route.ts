import { NextResponse } from 'next/server';
import { loginWithGoogleAccessToken, LocalAuthError } from '@/lib/auth/local-auth';

/**
 * POST /api/auth/google/callback  { access_token }
 * Native — exchanges the Google access token for the userinfo profile,
 * upserts an im_users row, and returns a Prismer JWT.
 */
export async function POST(request: Request) {
  try {
    const { access_token } = await request.json();

    if (!access_token) {
      return NextResponse.json({ error: { code: 400, msg: 'access_token is required' } }, { status: 400 });
    }

    const result = await loginWithGoogleAccessToken(access_token);
    return NextResponse.json(result);
  } catch (error: any) {
    const status = error instanceof LocalAuthError ? error.status : 500;
    const code = error instanceof LocalAuthError ? error.code : 500;
    return NextResponse.json({ error: { code, msg: error.message || 'Google authentication failed' } }, { status });
  }
}
