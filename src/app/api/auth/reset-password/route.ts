import { NextResponse } from 'next/server';
import { resetPassword } from '@/lib/auth-api';

/**
 * POST /api/auth/reset-password
 * Reset password
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { email, code, password, confirm_password } = body;

    if (!email || !code || !password || !confirm_password) {
      return NextResponse.json(
        { error: { code: 400, msg: 'All fields are required' } },
        { status: 400 }
      );
    }

    if (password !== confirm_password) {
      return NextResponse.json(
        { error: { code: 400, msg: 'Passwords do not match' } },
        { status: 400 }
      );
    }

    // Passwords should already be SHA256 hashed on client side
    const result = await resetPassword(email, code, password, confirm_password);
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json(
      { error: { code: 400, msg: error.message || 'Password reset failed' } },
      { status: 400 }
    );
  }
}









