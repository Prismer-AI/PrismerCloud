import { NextResponse } from 'next/server';
import { verifyEmailCode, LocalAuthError } from '@/lib/auth/local-auth';
import { ensureNacosConfig } from '@/lib/nacos-config';

/**
 * POST /api/auth/verify-code  { email, code, type }
 * Verifies (does NOT consume) the code — register/reset-password routes
 * consume it on success.
 */
export async function POST(request: Request) {
  try {
    // Defensive Nacos init — Redis (where the code lives) is fed by
    // REDIS_* env loaded from Nacos in test/prod.
    await ensureNacosConfig();
    const { email, code, type } = await request.json();

    if (!email || !code || !type) {
      return NextResponse.json({ error: { code: 400, msg: 'email, code, and type are required' } }, { status: 400 });
    }
    if (type !== 'signup' && type !== 'reset-password') {
      return NextResponse.json(
        { error: { code: 400, msg: 'type must be "signup" or "reset-password"' } },
        { status: 400 },
      );
    }

    const result = await verifyEmailCode({ email, code, type });
    return NextResponse.json(result);
  } catch (error: any) {
    const status = error instanceof LocalAuthError ? error.status : 400;
    const code = error instanceof LocalAuthError ? error.code : 400;
    return NextResponse.json({ error: { code, msg: error.message || 'Code verification failed' } }, { status });
  }
}
