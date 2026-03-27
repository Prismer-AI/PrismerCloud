import { NextResponse } from 'next/server';
import { login } from '@/lib/auth-api';

/**
 * POST /api/auth/login
 * Email/Password login
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { email, password } = body;

    if (!email || !password) {
      return NextResponse.json(
        { error: { code: 400, msg: 'email and password are required' } },
        { status: 400 }
      );
    }

    // Password should already be SHA256 hashed on client side
    const result = await login(email, password);
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json(
      { error: { code: 401, msg: error.message || 'Login failed' } },
      { status: 401 }
    );
  }
}









