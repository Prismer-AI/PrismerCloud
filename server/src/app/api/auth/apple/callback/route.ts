import { NextResponse } from 'next/server';
import { loginWithAppleIdentityToken, LocalAuthError } from '@/lib/auth/local-auth';

/**
 * POST /api/auth/apple/callback  { identity_token, full_name? }
 *
 * Native Sign in with Apple callback. The iOS app obtains the Apple
 * identity token via AuthenticationServices, then exchanges it here for
 * the same Prismer JWT shape returned by email / Google / GitHub auth.
 */
export async function POST(request: Request) {
  try {
    const { identity_token: identityToken, full_name: fullName } = await request.json();

    if (!identityToken) {
      return NextResponse.json({ error: { code: 400, msg: 'identity_token is required' } }, { status: 400 });
    }

    const result = await loginWithAppleIdentityToken(identityToken, fullName);
    return NextResponse.json(result);
  } catch (error: any) {
    const status = error instanceof LocalAuthError ? error.status : 500;
    const code = error instanceof LocalAuthError ? error.code : 500;
    return NextResponse.json({ error: { code, msg: error.message || 'Apple authentication failed' } }, { status });
  }
}
