#!/usr/bin/env -S npx tsx
/**
 * Regression — `LOCAL_ONLY=1` OTP bypass.
 *
 * Drives the running cloud at $E2E_BASE (default `http://127.0.0.1:3000/api`)
 * and asserts the verification-code contract per the operating mode the
 * cloud is currently in. Auto-detects mode from `POST /auth/send-code`
 * response shape, so this single script proves *both* directions:
 *
 *   LOCAL_ONLY=1 cloud                  →  code === '000000', register w/ '000000' ✅
 *   LOCAL_ONLY=0 + EXPOSE=true cloud    →  random 6-digit code; '000000' is rejected
 *   LOCAL_ONLY=0 + EXPOSE=false cloud   →  no `verification_code` in response (skipped)
 *
 * Run twice (once with each cloud env) to cover both regressions:
 *   LOCAL_ONLY=1 npm run dev:next          # bypass-enabled cloud
 *   E2E_BASE=… npx tsx scripts/e2e-localonly-otp-bypass.ts
 *
 *   AUTH_EMAIL_CODE_RETURN_IN_RESPONSE=true npm run dev:next  # legacy path
 *   E2E_BASE=… npx tsx scripts/e2e-localonly-otp-bypass.ts
 */

import * as crypto from 'node:crypto';

const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:3000/api';
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

interface SendCodeResp {
  code?: number;
  message?: string;
  verification_code?: string;
  provider?: string;
  dev_mode?: boolean;
  error?: { code: number; msg: string };
}
interface RegisterResp {
  token?: string;
  user?: { id: number };
  error?: { code: number; msg: string };
}

async function http<T>(
  method: 'POST' | 'GET',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T; rawText: string }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const rawText = await res.text();
  let parsed: unknown;
  try {
    parsed = rawText ? JSON.parse(rawText) : undefined;
  } catch {
    parsed = { _raw: rawText };
  }
  return { status: res.status, body: parsed as T, rawText };
}

interface StepResult {
  name: string;
  pass: boolean;
  detail: string;
}
const results: StepResult[] = [];
function record(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
  process.stdout.write(`${pass ? '✅' : '❌'} ${name} — ${detail}\n`);
}

async function main(): Promise<void> {
  process.stdout.write(`[localonly-otp] BASE=${BASE}\n\n`);

  const ts = Date.now();
  const email = `localonly-${ts}@example.com`;
  const password = sha256(`Pwd${ts}!`);

  // 1. send-code
  const sendRes = await http<SendCodeResp>('POST', '/auth/send-code', { email, type: 'signup' });
  if (sendRes.status !== 200) {
    record('send-code 200', false, `HTTP ${sendRes.status}: ${sendRes.rawText.slice(0, 200)}`);
    process.exit(1);
  }
  const sb = sendRes.body;
  record('send-code 200', true, `provider=${sb.provider ?? 'n/a'} dev_mode=${sb.dev_mode ?? false}`);

  // 2. Detect mode
  const isLocalOnlyBypass = sb.dev_mode === true;
  const hasExposedRandomCode =
    !isLocalOnlyBypass && typeof sb.verification_code === 'string' && /^\d{6}$/.test(sb.verification_code);
  const noCodeExposed = sb.verification_code == null;

  if (isLocalOnlyBypass) {
    process.stdout.write('[localonly-otp] mode: LOCAL_ONLY=1 bypass\n');

    // 2a. assert fixed code
    record(
      'verification_code === "000000"',
      sb.verification_code === '000000',
      `got=${sb.verification_code}`,
    );
    record('provider === "local-only-dev"', sb.provider === 'local-only-dev', `got=${sb.provider}`);

    // 2b. register with the fixed code → 200
    const regRes = await http<RegisterResp>('POST', '/auth/register', {
      email,
      password,
      confirm_password: password,
      code: '000000',
    });
    record(
      'register w/ "000000" → 200 + token',
      regRes.status === 200 && typeof regRes.body.token === 'string',
      `HTTP ${regRes.status} tokenLen=${regRes.body.token?.length ?? 0}`,
    );
  } else if (hasExposedRandomCode) {
    process.stdout.write(
      '[localonly-otp] mode: AUTH_EMAIL_CODE_RETURN_IN_RESPONSE=true (legacy dev convenience)\n',
    );

    // 3a. random non-zero code
    record(
      'random non-"000000" code returned',
      sb.verification_code !== '000000',
      `got=${sb.verification_code}`,
    );

    // 3b. register w/ "000000" should FAIL — proves bypass is gated off
    const wrongRes = await http<RegisterResp>('POST', '/auth/register', {
      email,
      password,
      confirm_password: password,
      code: '000000',
    });
    record(
      'register w/ "000000" → rejected (proves LOCAL_ONLY bypass is OFF)',
      wrongRes.status === 400 || wrongRes.status === 401,
      `HTTP ${wrongRes.status}: ${wrongRes.body.error?.msg ?? wrongRes.rawText.slice(0, 120)}`,
    );

    // 3c. register w/ the actual code → 200
    const regRes = await http<RegisterResp>('POST', '/auth/register', {
      email,
      password,
      confirm_password: password,
      code: sb.verification_code as string,
    });
    record(
      `register w/ real code "${sb.verification_code}" → 200`,
      regRes.status === 200 && typeof regRes.body.token === 'string',
      `HTTP ${regRes.status} tokenLen=${regRes.body.token?.length ?? 0}`,
    );
  } else if (noCodeExposed) {
    process.stdout.write(
      '[localonly-otp] mode: production-style (no code in response) — register flow not headlessly testable\n',
    );
    record('production-style no-code response', true, 'verification_code absent (expected)');
    // Cannot complete register without OOB code; assert 503 was NOT thrown
    // (i.e., cloud has a real provider configured) by checking we got 200.
    record('send-code returned 200 (provider configured)', sendRes.status === 200, `provider=${sb.provider ?? '?'}`);
  } else {
    record(
      'unrecognised send-code response shape',
      false,
      `body=${JSON.stringify(sb).slice(0, 240)}`,
    );
  }

  // ─ summary
  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  process.stdout.write(`\n${passed} pass / ${failed} fail / ${results.length} total\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[localonly-otp] fatal:', err);
  process.exit(2);
});
