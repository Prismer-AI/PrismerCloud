import { NextResponse } from 'next/server';
import { loginWithGithubCode, LocalAuthError } from '@/lib/auth/local-auth';

/**
 * POST /api/auth/github/callback  { code }
 * Native — exchanges the OAuth code for a GitHub access token, fetches
 * the user profile + primary email, upserts im_users, and returns a JWT.
 */
export async function POST(request: Request) {
  try {
    const { code: oauthCode } = await request.json();

    if (!oauthCode) {
      return NextResponse.json({ error: { code: 400, msg: 'code is required' } }, { status: 400 });
    }

    const result = await loginWithGithubCode(oauthCode);
    return NextResponse.json(result);
  } catch (error: any) {
    const status = error instanceof LocalAuthError ? error.status : 500;
    const code = error instanceof LocalAuthError ? error.code : 500;
    return NextResponse.json({ error: { code, msg: error.message || 'GitHub authentication failed' } }, { status });
  }
}
