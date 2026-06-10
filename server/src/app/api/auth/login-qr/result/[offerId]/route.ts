import { NextRequest, NextResponse } from 'next/server';
import { loginQrService, LoginQrError } from '@/lib/auth/login-qr.service';

/**
 * GET /api/auth/login-qr/result/:offerId  (F2)
 *
 * Auth: PUBLIC — the mobile device polls this while unauthenticated.
 * Query: ?consumerToken=<token from this device's own /consume> ([SYNC-6]).
 *        The web poller omits it (it only wants `consumerDevice`, never a token).
 * Returns:
 *   - { status: 'pending' }                          — not yet scanned (NO token)
 *   - { status: 'pending_confirm', consumerDevice }  — awaiting web confirm (NO token)
 *   - { status: 'superseded' }                       — a later device replaced you
 *   - { status: 'denied' }                           — approved, but for another device
 *   - { status: 'approved', token, imUserId, numericId } — ONCE, only to the
 *       confirmed device (matching consumerToken); the offer is then burned
 *       (single-use). The next poll returns 410 OFFER_GONE.
 *   - 410 OFFER_EXPIRED / OFFER_GONE — expired or already consumed.
 *
 * The token is the session JWT for the offer creator's account — mobile drops
 * it in the Keychain and bootstraps the IM ws/sse handshake with it.
 */
export async function GET(request: NextRequest, ctx: { params: Promise<{ offerId: string }> }) {
  try {
    const { offerId } = await ctx.params;
    if (!offerId) {
      return NextResponse.json({ error: { code: 400, msg: 'offerId is required' } }, { status: 400 });
    }

    const consumerToken = request.nextUrl.searchParams.get('consumerToken') ?? undefined;
    const result = await loginQrService.result(offerId, consumerToken);
    return NextResponse.json(result);
  } catch (error: any) {
    if (error instanceof LoginQrError) {
      return NextResponse.json({ error: { code: error.code, msg: error.message } }, { status: error.httpStatus });
    }
    console.error('[login-qr/result] error:', error);
    return NextResponse.json({ error: { code: 500, msg: 'Failed to read login offer' } }, { status: 500 });
  }
}
