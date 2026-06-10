import { NextRequest, NextResponse } from 'next/server';
import { requireAuthIdentity, AuthError } from '@/lib/auth/guard';
import { loginQrService, LoginQrError } from '@/lib/auth/login-qr.service';

/**
 * POST /api/auth/login-qr/confirm  (F2 — MANDATORY second confirmation)
 *
 * Auth: web user's session JWT. MUST be the same user who created the offer
 *       (enforced in the service: offer.userId === caller IMUser.id).
 * Body: { offerId }
 * Returns: { status: 'approved' }
 *
 * This is the human-in-the-loop gate against shoulder-surf credential theft.
 * The web user has seen the scanning device's label (from /consume) and now
 * explicitly approves. Only after this does /result mint+return a token.
 */
export async function POST(request: NextRequest) {
  try {
    const identity = await requireAuthIdentity(request);
    const body = (await request.json().catch(() => ({}))) as { offerId?: string };
    const offerId = (body.offerId ?? '').trim();
    if (!offerId) {
      return NextResponse.json({ error: { code: 400, msg: 'offerId is required' } }, { status: 400 });
    }

    const result = await loginQrService.confirm(offerId, identity.id);
    return NextResponse.json(result);
  } catch (error: any) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: { code: error.status, msg: error.message } }, { status: error.status });
    }
    if (error instanceof LoginQrError) {
      return NextResponse.json({ error: { code: error.code, msg: error.message } }, { status: error.httpStatus });
    }
    console.error('[login-qr/confirm] error:', error);
    return NextResponse.json({ error: { code: 500, msg: 'Failed to confirm login offer' } }, { status: 500 });
  }
}
