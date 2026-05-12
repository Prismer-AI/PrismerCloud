import { NextResponse } from 'next/server';
import { loginWithPassword, LocalAuthError } from '@/lib/auth/local-auth';
import { metrics } from '@/lib/metrics';

/**
 * POST /api/auth/login
 * Email/Password login (native — no Go-backend dependency).
 * Password is SHA256-hashed on the client; bcrypt-compared server-side.
 */
export async function POST(request: Request) {
  const reqStart = Date.now();
  try {
    const { email, password } = await request.json();

    if (!email || !password) {
      metrics.recordRequest('/api/auth/login', Date.now() - reqStart, 400);
      return NextResponse.json({ error: { code: 400, msg: 'email and password are required' } }, { status: 400 });
    }

    const result = await loginWithPassword(email, password);
    metrics.recordRequest('/api/auth/login', Date.now() - reqStart, 200);
    return NextResponse.json(result);
  } catch (error: any) {
    const status = error instanceof LocalAuthError ? error.status : 401;
    const code = error instanceof LocalAuthError ? error.code : 401;
    metrics.recordRequest('/api/auth/login', Date.now() - reqStart, status);
    return NextResponse.json({ error: { code, msg: error.message || 'Login failed' } }, { status });
  }
}
