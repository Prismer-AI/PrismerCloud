import { NextResponse } from 'next/server';
import { findOrCreateInvitedUser, LocalAuthError } from '@/lib/auth/local-auth';
import { createModuleLogger } from '@/lib/logger';

const log = createModuleLogger('InviteClaim');

/**
 * POST /api/auth/invite-claim — magic-link one-click join (passwordless).
 *
 * Body: { inviteToken }.
 *
 * Flow (Slack/Notion style):
 *   1. Resolve the token SERVER-SIDE via WorkspaceInviteService.resolveEmailInvite.
 *      Only a valid, pending, non-expired, EMAIL-link invite resolves to a
 *      non-null { inviteeEmail }. Anything else → 400. This is the SOLE gate
 *      that unlocks passwordless account creation.
 *   2. findOrCreateInvitedUser(inviteeEmail) → find-or-create a human account
 *      bound to the SERVER-resolved email (never a client-supplied value) and
 *      mint a session (same issueToken as login/register).
 *   3. accept(token, imUserId) → adds the member row + flips the invite status
 *      pending→accepted in one transaction. The P0.2 email-match guard passes
 *      by construction (the account email IS the inviteeEmail). The accept's
 *      `updateMany WHERE status='pending'` guard makes the token single-use: a
 *      second claim with the same token resolves to null (status no longer
 *      pending) and 400s cleanly.
 *
 * Returns the SAME shape as /api/auth/register on success — `{ user, token,
 * expires_in }` — so the frontend can `login(data.user, data.token)` and
 * persist it as `prismer_auth`. The internal imUserId is stripped.
 */
export async function POST(request: Request) {
  try {
    const { inviteToken } = await request.json();

    if (typeof inviteToken !== 'string' || inviteToken.length < 16) {
      return NextResponse.json({ error: { code: 400, msg: 'Invite is invalid or expired' } }, { status: 400 });
    }

    // Resolve SERVER-SIDE — the authoritative validator. Non-null only for a
    // pending, non-expired, email-link invite. inviteeEmail is the ONLY email
    // we ever assign/use; the request body carries no email at all.
    const { WorkspaceInviteService } = await import('@/im/services/workspace-invite.service');
    const inv = await new WorkspaceInviteService().resolveEmailInvite(inviteToken);
    if (!inv) {
      return NextResponse.json({ error: { code: 400, msg: 'Invite is invalid or expired' } }, { status: 400 });
    }

    const result = await findOrCreateInvitedUser(inv.inviteeEmail);

    // Accept via the real accept() path (member-insert + status flip in one
    // txn). Email matches by construction (P0.2 guard passes). If accept throws
    // a terminal-state / forbidden error, surface it so the user understands
    // why the join didn't complete.
    await new WorkspaceInviteService().accept(inviteToken, result.imUserId);

    if (result?.user?.id) {
      initHumanCredits(result.user.id).catch((err) => log.error({ err }, 'Failed to init credits'));
    }

    // Strip the internal imUserId before returning the public AuthResponse.
    const { imUserId: _omit, ...authResponse } = result;
    void _omit;
    return NextResponse.json(authResponse);
  } catch (error: any) {
    // LocalAuthError carries a numeric `status`. InviteErrors carry a numeric
    // `status` too (400/403/404/410). Default to 400.
    const status = typeof error?.status === 'number' ? error.status : 400;
    const code = error instanceof LocalAuthError ? error.code : (error?.code ?? status);
    return NextResponse.json(
      { error: { code, msg: error?.message || 'Could not join workspace' } },
      { status },
    );
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
