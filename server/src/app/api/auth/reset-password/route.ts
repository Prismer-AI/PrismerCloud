import { NextResponse } from 'next/server';
import { resetPasswordWithCode, LocalAuthError } from '@/lib/auth/local-auth';

/**
 * POST /api/auth/reset-password  { email, code, password, confirm_password }
 * Native — bcrypt-hashes new password, persists to im_users.passwordHash,
 * and consumes the reset-password code on success.
 */
export async function POST(request: Request) {
  try {
    const { email, code, password, confirm_password } = await request.json();

    if (!email || !code || !password || !confirm_password) {
      return NextResponse.json({ error: { code: 400, msg: 'All fields are required' } }, { status: 400 });
    }
    if (password !== confirm_password) {
      return NextResponse.json({ error: { code: 400, msg: 'Passwords do not match' } }, { status: 400 });
    }

    const result = await resetPasswordWithCode(email, code, password, confirm_password);
    return NextResponse.json(result);
  } catch (error: any) {
    const status = error instanceof LocalAuthError ? error.status : 400;
    const code = error instanceof LocalAuthError ? error.code : 400;
    return NextResponse.json({ error: { code, msg: error.message || 'Password reset failed' } }, { status });
  }
}
