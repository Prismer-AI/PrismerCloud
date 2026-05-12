import { NextResponse } from 'next/server';
import { verifySmsCode, LocalAuthError } from '@/lib/auth/local-auth';
import { normalizePhone, isValidChinesePhone } from '@/lib/auth/sms';
import { ensureNacosConfig } from '@/lib/nacos-config';

/**
 * POST /api/auth/sms/verify  { phone, code }
 * Consumes the SMS code and either logs in (existing user) or provisions
 * a new im_users row keyed on phone number, returning a Prismer JWT.
 */
export async function POST(request: Request) {
  try {
    // verifySmsCode → local-auth.ts → Redis read which is also Nacos-fed
    // (REDIS_HOST/REDIS_PORT/REDIS_PASSWORD live in test/prod Nacos).
    // Defensive init same as the send route.
    await ensureNacosConfig();
    const { phone, code } = await request.json();

    if (!phone || !code) {
      return NextResponse.json({ error: { code: 400, msg: 'phone and code are required' } }, { status: 400 });
    }

    const normalized = normalizePhone(phone);
    if (!isValidChinesePhone(normalized)) {
      return NextResponse.json({ error: { code: 400, msg: 'Invalid phone number' } }, { status: 400 });
    }

    const result = await verifySmsCode(normalized, code);
    return NextResponse.json(result);
  } catch (error: any) {
    const status = error instanceof LocalAuthError ? error.status : 400;
    const errCode = error instanceof LocalAuthError ? error.code : 400;
    return NextResponse.json({ error: { code: errCode, msg: error.message || 'SMS verification failed' } }, { status });
  }
}
