import { NextResponse } from 'next/server';
import { register } from '@/lib/auth-api';
import { createModuleLogger } from '@/lib/logger';

const log = createModuleLogger('Register');

/**
 * POST /api/auth/register
 * Register new user
 *
 * After successful backend registration, auto-init 10000 credits
 * for the new human account (feature-flag controlled).
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { email, password, confirm_password, code } = body;

    if (!email || !password || !confirm_password || !code) {
      return NextResponse.json({ error: { code: 400, msg: 'All fields are required' } }, { status: 400 });
    }

    if (password !== confirm_password) {
      return NextResponse.json({ error: { code: 400, msg: 'Passwords do not match' } }, { status: 400 });
    }

    // Passwords should already be SHA256 hashed on client side
    const result = await register(email, password, confirm_password, code);

    // Init credits for new human user (background, non-blocking)
    if (result?.user?.id) {
      initHumanCredits(result.user.id).catch((err) => {
        log.error({ err }, 'Failed to init credits');
      });
    }

    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json({ error: { code: 400, msg: error.message || 'Registration failed' } }, { status: 400 });
  }
}

/**
 * Init 10000 credits for a newly registered human user.
 * Uses INSERT IGNORE — safe to call multiple times.
 */
async function initHumanCredits(userId: number): Promise<void> {
  const { FEATURE_FLAGS } = await import('@/lib/feature-flags');
  if (!FEATURE_FLAGS.USER_CREDITS_LOCAL) return;

  const { initUserCredits } = await import('@/lib/db-credits');
  await initUserCredits(userId, 10000);
  log.info({ userId, credits: 10000 }, 'Initialized credits for new user');
}
