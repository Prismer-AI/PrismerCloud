import { NextRequest, NextResponse } from 'next/server';
import { requireAuthIdentity, AuthError } from '@/lib/auth/guard';
import { loginQrService } from '@/lib/auth/login-qr.service';

/**
 * POST /api/auth/login-qr/create  (F2 — account scan-login web → mobile)
 *
 * Auth: web user's session JWT (Authorization: Bearer <jwt> or NextAuth
 *       session cookie). The minted login will be for THIS user.
 * Body: (none)
 * Returns: { offerId, qrPayload, expiresAt }
 *   - qrPayload: the string the web top-bar renders as a QR; mobile scans it.
 *
 * The QR/offer is a 120-second single-use handshake. Mobile then calls
 * /consume; the web user confirms via /confirm; mobile polls /result.
 */
export async function POST(request: NextRequest) {
  try {
    const identity = await requireAuthIdentity(request);
    const offer = await loginQrService.create(identity.id);
    return NextResponse.json(offer);
  } catch (error: any) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: { code: error.status, msg: error.message } }, { status: error.status });
    }
    console.error('[login-qr/create] error:', error);
    return NextResponse.json({ error: { code: 500, msg: 'Failed to create login offer' } }, { status: 500 });
  }
}
