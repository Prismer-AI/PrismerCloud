import { NextResponse } from 'next/server';
import { generateSmsCode, LocalAuthError } from '@/lib/auth/local-auth';
import { sendSmsCode, normalizePhone, isValidChinesePhone } from '@/lib/auth/sms';
import { ensureNacosConfig } from '@/lib/nacos-config';

/**
 * POST /api/auth/sms/send  { phone }
 * Generates a 6-digit code into Redis (10min TTL, 60s rate-limit) and
 * sends it via ChuangLan template SMS. In dev (or when
 * AUTH_EMAIL_CODE_RETURN_IN_RESPONSE=true), the code is also returned
 * for testing.
 */
export async function POST(request: Request) {
  try {
    // Test/prod: SMS_ACCOUNT/SMS_PASSWORD (or CHUANGLAN_API_USER/_KEY) live
    // in Nacos under the APP_ENV namespace. Without this, sms.ts falls back
    // to "service not configured" until some other route happens to init
    // Nacos first. Idempotent — no-op after first call.
    await ensureNacosConfig();
    const { phone } = await request.json();

    if (!phone) {
      return NextResponse.json({ error: { code: 400, msg: 'phone is required' } }, { status: 400 });
    }

    const normalized = normalizePhone(phone);
    if (!isValidChinesePhone(normalized)) {
      return NextResponse.json(
        { error: { code: 400, msg: 'Invalid phone number (Chinese mainland 11-digit)' } },
        { status: 400 },
      );
    }

    const code = await generateSmsCode(normalized);

    // Best-effort dispatch — if the SMS provider isn't configured (dev),
    // we still return success and (in dev) include the code in the response.
    const sms = await sendSmsCode(normalized, code);

    const exposeCode =
      process.env.NODE_ENV !== 'production' || process.env.AUTH_EMAIL_CODE_RETURN_IN_RESPONSE === 'true';

    return NextResponse.json({
      code: sms.success ? 0 : 200,
      message: sms.success ? 'SMS sent' : `SMS dispatch failed: ${sms.error}; code is in cache`,
      ...(exposeCode ? { verification_code: code } : {}),
    });
  } catch (error: any) {
    const status = error instanceof LocalAuthError ? error.status : 500;
    const code = error instanceof LocalAuthError ? error.code : 500;
    return NextResponse.json({ error: { code, msg: error.message || 'Failed to send SMS' } }, { status });
  }
}
