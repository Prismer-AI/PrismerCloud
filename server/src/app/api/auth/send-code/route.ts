import { NextResponse } from 'next/server';
import { sendEmailVerificationCode, LocalAuthError } from '@/lib/auth/local-auth';
import { ensureNacosConfig } from '@/lib/nacos-config';

/**
 * POST /api/auth/send-code  { email, type: 'signup' | 'reset-password' }
 * Native — generates a 6-digit code into Redis (10min TTL, 60s rate-limit).
 *
 * Three operating modes (highest precedence first):
 *
 * 1. LAN-dev bypass — `LOCAL_ONLY=1 && NODE_ENV !== 'production'`:
 *    Code is the constant `"000000"`. Always returned in response body
 *    (`verification_code: "000000"`, `dev_mode: true`, `provider:
 *    "local-only-dev"`). No email provider call. iPhone users / cookbook
 *    scripts / curl all enter `000000` as the OTP. Eliminates the
 *    out-of-band-relay friction documented in drift M2 #4. Defence in
 *    depth: gate matches `nacos-config.ts:443` so prod images
 *    (Dockerfile pins `NODE_ENV=production`) cannot opt in.
 *
 * 2. Dev convenience — `AUTH_EMAIL_CODE_RETURN_IN_RESPONSE=true` (and
 *    not prod): random 6-digit code; returned in response so cookbook /
 *    headless flows can pick it up without an email provider.
 *
 * 3. Production — random 6-digit code; only sent via configured email
 *    provider. Response carries no `verification_code`. If no provider
 *    is configured, the call returns 503 to avoid silent black-holes.
 */
export async function POST(request: Request) {
  try {
    // SMTP_HOST/USER/PASS (or other email-provider creds) live in Nacos
    // under the APP_ENV namespace in test/prod. Idempotent — no-op after
    // first call. Without this, the route may report "no provider
    // configured" until some other route initializes Nacos first.
    await ensureNacosConfig();
    const { email, type } = await request.json();

    if (!email || !type) {
      return NextResponse.json({ error: { code: 400, msg: 'email and type are required' } }, { status: 400 });
    }
    if (type !== 'signup' && type !== 'reset-password') {
      return NextResponse.json(
        { error: { code: 400, msg: 'type must be "signup" or "reset-password"' } },
        { status: 400 },
      );
    }

    const result = await sendEmailVerificationCode({ email, type });
    return NextResponse.json(result);
  } catch (error: any) {
    const status = error instanceof LocalAuthError ? error.status : 500;
    const code = error instanceof LocalAuthError ? error.code : 500;
    return NextResponse.json({ error: { code, msg: error.message || 'Failed to send code' } }, { status });
  }
}
