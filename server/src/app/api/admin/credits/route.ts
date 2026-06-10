import { NextRequest, NextResponse } from 'next/server';
import { ensureNacosConfig } from '@/lib/nacos-config';
import { getUserFromAuth } from '@/lib/auth-utils';
import { isSandboxAdmin } from '@/lib/admin-rbac';
import { createModuleLogger } from '@/lib/logger';
import {
  addCredits,
  deductCredits,
  getUserCredits,
  getUserTransactions,
  resolveCreditUserIdentity,
} from '@/lib/db-credits';

const log = createModuleLogger('AdminCredits');

/**
 * Admin manual credit management (release202/12).
 *
 * Beta-era companion to the P1 balance gate: with the proxy now blocking
 * zero-balance accounts (402 INSUFFICIENT_CREDITS) and no daily-refresh cron,
 * staff need a manual lever to add/subtract a user's credits. Keyed by the
 * numeric `userId` (pc_users.id — the same id credits/usage are keyed on;
 * surfaced in /admin/analytics top-users). Operates on the local
 * `pc_user_credits` table (the FF_USER_CREDITS_LOCAL source of truth).
 *
 * GET  /api/admin/credits?q=<email|username|id>  → resolved identity + balance
 *                                                   + plan + recent transactions
 *      (?userId=N is still accepted as a back-compat alias for ?q=N)
 * POST /api/admin/credits            → { userId, amount, reason } (amount may be ±)
 *
 * Auth: JWT, email must pass isSandboxAdmin (ADMIN_EMAILS allowlist).
 */

async function requireAdmin(
  request: NextRequest,
): Promise<{ ok: true; email: string } | { ok: false; response: NextResponse }> {
  const auth = await getUserFromAuth(request.headers.get('authorization'));
  if (!auth.success || !auth.user) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, error: { code: 'UNAUTHORIZED', message: 'Login required' } },
        { status: 401 },
      ),
    };
  }
  if (!isSandboxAdmin(auth.user.email)) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, error: { code: 'FORBIDDEN', message: 'Admin access only' } },
        { status: 403 },
      ),
    };
  }
  return { ok: true, email: auth.user.email };
}

export async function GET(request: NextRequest) {
  await ensureNacosConfig();
  const admin = await requireAdmin(request);
  if (!admin.ok) return admin.response;

  const params = new URL(request.url).searchParams;
  // Ops staff search by email / username / id — `q` is the canonical param;
  // `userId` stays as a back-compat alias.
  const q = (params.get('q') ?? params.get('userId') ?? '').trim();
  if (!q) {
    return NextResponse.json(
      { success: false, error: { code: 'MISSING_QUERY', message: 'Provide ?q=<email | username | user id>' } },
      { status: 400 },
    );
  }

  try {
    const identity = await resolveCreditUserIdentity(q);
    if (!identity) {
      return NextResponse.json(
        { success: false, error: { code: 'USER_NOT_FOUND', message: `No user found for "${q}" (try email, username, or numeric id)` } },
        { status: 404 },
      );
    }
    const credits = await getUserCredits(identity.userId);
    const { transactions } = await getUserTransactions(identity.userId, 1, 20);
    return NextResponse.json({ success: true, data: { identity, credits, transactions } });
  } catch (err) {
    log.error({ err, q }, 'Credit lookup failed');
    return NextResponse.json(
      { success: false, error: { code: 'LOOKUP_FAILED', message: 'Failed to read credits' } },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  await ensureNacosConfig();
  const admin = await requireAdmin(request);
  if (!admin.ok) return admin.response;

  let body: { userId?: unknown; amount?: unknown; reason?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: { code: 'INVALID_BODY', message: 'Body must be JSON' } },
      { status: 400 },
    );
  }

  const userId = typeof body.userId === 'number' && Number.isInteger(body.userId) && body.userId > 0 ? body.userId : null;
  const amount = typeof body.amount === 'number' && Number.isFinite(body.amount) ? body.amount : null;
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : '';

  if (userId === null) {
    return NextResponse.json(
      { success: false, error: { code: 'INVALID_USER_ID', message: 'userId must be a positive integer' } },
      { status: 400 },
    );
  }
  if (amount === null || amount === 0) {
    return NextResponse.json(
      { success: false, error: { code: 'INVALID_AMOUNT', message: 'amount must be a non-zero number (+ to add, − to subtract)' } },
      { status: 400 },
    );
  }

  // Audit trail lives in the transaction description (pc_credit_transactions).
  const description = `admin:${admin.email}${reason ? ` — ${reason}` : ' — manual adjust'}`;

  try {
    let balanceAfter: number;
    if (amount > 0) {
      ({ balance_after: balanceAfter } = await addCredits(userId, amount, 'gift', description));
    } else {
      const res = await deductCredits(userId, -amount, description);
      if (!res.success) {
        return NextResponse.json(
          {
            success: false,
            error: { code: 'INSUFFICIENT_BALANCE', message: res.error ?? 'Cannot subtract more than current balance' },
            balance: res.balance_after,
          },
          { status: 409 },
        );
      }
      balanceAfter = res.balance_after;
    }
    log.info({ admin: admin.email, userId, amount, reason, balanceAfter }, 'Admin credit adjustment applied');
    return NextResponse.json({ success: true, data: { userId, amount, balance: balanceAfter } });
  } catch (err) {
    log.error({ err, admin: admin.email, userId, amount }, 'Credit adjustment failed');
    return NextResponse.json(
      { success: false, error: { code: 'ADJUST_FAILED', message: 'Failed to apply adjustment' } },
      { status: 500 },
    );
  }
}
