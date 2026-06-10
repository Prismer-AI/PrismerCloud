import { NextRequest, NextResponse } from 'next/server';
import { loginQrService, LoginQrError } from '@/lib/auth/login-qr.service';

/**
 * POST /api/auth/login-qr/consume  (F2)
 *
 * Auth: PUBLIC — the scanning mobile device is unauthenticated (that's the
 *       whole point; it's logging in).
 * Body: { offerId, consumerDevice }
 * Returns: { status: 'pending_confirm', consumerToken }
 *
 * Registers that a device is waiting on the offer + its device label, moving
 * the offer to `pending_confirm`. NEVER returns a token — the web user must
 * still explicitly confirm (mandatory second confirmation). The device label
 * is what the web user sees before confirming, so they can reject a
 * shoulder-surf scan.
 *
 * Returns a per-device `consumerToken` ([SYNC-6]) — the device keeps it private
 * and presents it on `result`; only the device whose token the web user
 * confirmed gets the session, closing the multi-device race.
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      offerId?: string;
      consumerDevice?: string;
    };
    const offerId = (body.offerId ?? '').trim();
    const consumerDevice = (body.consumerDevice ?? '').trim();

    if (!offerId) {
      return NextResponse.json({ error: { code: 400, msg: 'offerId is required' } }, { status: 400 });
    }
    if (!consumerDevice) {
      return NextResponse.json({ error: { code: 400, msg: 'consumerDevice is required' } }, { status: 400 });
    }

    const result = await loginQrService.consume(offerId, consumerDevice);
    return NextResponse.json(result);
  } catch (error: any) {
    if (error instanceof LoginQrError) {
      return NextResponse.json({ error: { code: error.code, msg: error.message } }, { status: error.httpStatus });
    }
    console.error('[login-qr/consume] error:', error);
    return NextResponse.json({ error: { code: 500, msg: 'Failed to consume login offer' } }, { status: 500 });
  }
}
