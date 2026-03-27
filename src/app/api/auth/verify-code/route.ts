import { NextResponse } from 'next/server';
import { verifyCode } from '@/lib/auth-api';

/**
 * POST /api/auth/verify-code
 * Verify code
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { email, code, type } = body;

    if (!email || !code || !type) {
      return NextResponse.json(
        { error: { code: 400, msg: 'email, code, and type are required' } },
        { status: 400 }
      );
    }

    if (type !== 'signup' && type !== 'reset-password') {
      return NextResponse.json(
        { error: { code: 400, msg: 'type must be "signup" or "reset-password"' } },
        { status: 400 }
      );
    }

    const result = await verifyCode(email, code, type);
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json(
      { error: { code: 400, msg: error.message || 'Code verification failed' } },
      { status: 400 }
    );
  }
}









