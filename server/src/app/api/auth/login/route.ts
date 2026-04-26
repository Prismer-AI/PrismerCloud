import { NextResponse } from 'next/server';
import { login } from '@/lib/auth-api';
import { metrics } from '@/lib/metrics';

/**
 * POST /api/auth/login
 * Email/Password login
 */
export async function POST(request: Request) {
  const reqStart = Date.now();
  try {
    const body = await request.json();
    const { email, password } = body;

    if (!email || !password) {
      metrics.recordRequest('/api/auth/login', Date.now() - reqStart, 400);
      return NextResponse.json(
        { error: { code: 400, msg: 'email and password are required' } },
        { status: 400 }
      );
    }

    // Password should already be SHA256 hashed on client side
    const result = await login(email, password);
    metrics.recordRequest('/api/auth/login', Date.now() - reqStart, 200);
    return NextResponse.json(result);
  } catch (error: any) {
    metrics.recordRequest('/api/auth/login', Date.now() - reqStart, 401);
    return NextResponse.json(
      { error: { code: 401, msg: error.message || 'Login failed' } },
      { status: 401 }
    );
  }
}









