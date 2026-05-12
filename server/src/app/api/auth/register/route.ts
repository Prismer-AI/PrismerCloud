import { NextResponse } from 'next/server';
import { registerWithPassword, LocalAuthError } from '@/lib/auth/local-auth';
import { createModuleLogger } from '@/lib/logger';

const log = createModuleLogger('Register');

/**
 * POST /api/auth/register
 * Native registration (no Go-backend). Auto-init 10000 credits for new
 * humans (feature-flag controlled via FF_USER_CREDITS_LOCAL).
 */
export async function POST(request: Request) {
  try {
    const { email, password, confirm_password, code } = await request.json();

    if (!email || !password || !confirm_password || !code) {
      return NextResponse.json({ error: { code: 400, msg: 'All fields are required' } }, { status: 400 });
    }
    if (password !== confirm_password) {
      return NextResponse.json({ error: { code: 400, msg: 'Passwords do not match' } }, { status: 400 });
    }

    const result = await registerWithPassword(email, password, confirm_password, code);

    if (result?.user?.id) {
      initHumanCredits(result.user.id).catch((err) => log.error({ err }, 'Failed to init credits'));
    }

    return NextResponse.json(result);
  } catch (error: any) {
    const status = error instanceof LocalAuthError ? error.status : 400;
    const code = error instanceof LocalAuthError ? error.code : 400;
    return NextResponse.json({ error: { code, msg: error.message || 'Registration failed' } }, { status });
  }
}

async function initHumanCredits(userId: number): Promise<void> {
  if (!userId) return;
  const { FEATURE_FLAGS } = await import('@/lib/feature-flags');
  if (!FEATURE_FLAGS.USER_CREDITS_LOCAL) return;
  const { initUserCredits } = await import('@/lib/db-credits');
  await initUserCredits(userId, 10000);
  log.info({ userId, credits: 10000 }, 'Initialized credits for new user');
}
