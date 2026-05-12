import { NextRequest, NextResponse } from 'next/server';
import { changePasswordAuthenticated, LocalAuthError } from '@/lib/auth/local-auth';
import { requireAuthIdentity, AuthError } from '@/lib/auth/guard';

/**
 * POST /api/auth/change-password
 * Authenticated change-password flow (no verification code — current
 * password is the proof of identity). Body fields are SHA256 hex.
 *
 *   {
 *     password: <SHA256 hex of current plaintext>,
 *     new_password: <SHA256 hex of new plaintext>,
 *     confirm_password: <SHA256 hex of new plaintext>,
 *   }
 */
export async function POST(request: NextRequest) {
  try {
    const identity = await requireAuthIdentity(request);
    const { password, new_password, confirm_password } = await request.json();

    const result = await changePasswordAuthenticated(identity.id, password, new_password, confirm_password);
    return NextResponse.json(result);
  } catch (error: any) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: { code: error.status, msg: error.message } }, { status: error.status });
    }
    const status = error instanceof LocalAuthError ? error.status : 400;
    const code = error instanceof LocalAuthError ? error.code : 400;
    return NextResponse.json({ error: { code, msg: error.message || 'Change password failed' } }, { status });
  }
}
