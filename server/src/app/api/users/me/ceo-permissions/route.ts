/**
 * /api/users/me/ceo-permissions — §30 §2.8.6 + §31 §2.1.
 *
 * Caller-scoped CEO authorization read/write. Persisted on the IM user
 * row's `metadata.ceoPermissions` JSON sub-key (see ceo-permissions.ts).
 *
 * - GET   → returns `{ canCreateAgents, canDispatch }`, defaulting to all
 *           false when the user has not yet authorized.
 * - PATCH → merge-updates either / both fields. Body is a partial; missing
 *           keys retain their current value (NOT reset to false).
 *
 * Auth: all calls go through `requireAuthIdentity` so we get a stable
 * `im_users.id` regardless of whether the caller arrives via NextAuth
 * session, JWT bearer, or API key.
 *
 * Boundary note: this endpoint only stores the toggle. Enforcement
 * (gating `prismer.agent.register` or dispatch tool calls) lives in §31
 * middleware — landing this route in §30 just unblocks the Settings UI
 * + gives §31 something concrete to read from.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuthIdentity, AuthError, authErrorResponse, type AuthIdentity } from '@/lib/auth/guard';
import { getCeoPermissions, setCeoPermissions, type CeoPermissions } from '@/lib/ceo-permissions';
import { createModuleLogger } from '@/lib/logger';

const log = createModuleLogger('CeoPermissions');

function asResponse(perms: CeoPermissions) {
  return NextResponse.json({ success: true, data: perms });
}

/**
 * §31 §2.1 boundary: CEO authorization is a property of the *human* owner,
 * not the agent. Agents authenticating with their own JWT must not be able
 * to read/mutate ceoPermissions on their own row — that would let an agent
 * silently grant itself dispatch / register privileges when §31 enforcement
 * lands. Reject anything that is not `role === 'human'` up front.
 */
function rejectIfAgent(identity: AuthIdentity): NextResponse | null {
  if (identity.role !== 'human') {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'AGENT_CANNOT_MANAGE_CEO_PERMISSIONS',
          message: 'CEO permissions are owned by the human account, not the agent.',
        },
      },
      { status: 403 },
    );
  }
  return null;
}

function userNotFoundResponse(userId: string): NextResponse {
  return NextResponse.json(
    {
      success: false,
      error: {
        code: 'USER_NOT_FOUND',
        message: `IM user row missing for authenticated identity (${userId}). Data inconsistency — auth/IM split or row deleted.`,
      },
    },
    { status: 500 },
  );
}

function isUserNotFoundError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('User not found: ');
}

export async function GET(request: NextRequest) {
  try {
    const identity = await requireAuthIdentity(request);
    const reject = rejectIfAgent(identity);
    if (reject) return reject;
    const perms = await getCeoPermissions(identity.id);
    return asResponse(perms);
  } catch (err) {
    if (err instanceof AuthError) return authErrorResponse(err);
    if (isUserNotFoundError(err)) {
      log.error({ err }, 'GET failed: IM user row missing for authenticated identity');
      return userNotFoundResponse((err as Error).message.replace('User not found: ', ''));
    }
    log.error({ err }, 'GET failed');
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL', message: 'Failed to read CEO permissions' } },
      { status: 500 },
    );
  }
}

interface PatchBody {
  canCreateAgents?: unknown;
  canDispatch?: unknown;
}

export async function PATCH(request: NextRequest) {
  try {
    const identity = await requireAuthIdentity(request);
    const reject = rejectIfAgent(identity);
    if (reject) return reject;

    let body: PatchBody = {};
    try {
      body = (await request.json()) as PatchBody;
    } catch {
      return NextResponse.json(
        { success: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } },
        { status: 400 },
      );
    }

    // Strict boolean validation — anything else is ignored (we don't want
    // truthy strings like "false" silently flipping a permission on).
    const patch: Partial<CeoPermissions> = {};
    if (typeof body.canCreateAgents === 'boolean') patch.canCreateAgents = body.canCreateAgents;
    if (typeof body.canDispatch === 'boolean') patch.canDispatch = body.canDispatch;
    if (Object.keys(patch).length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'BAD_REQUEST',
            message: 'Body must include at least one of canCreateAgents | canDispatch (boolean)',
          },
        },
        { status: 400 },
      );
    }

    const next = await setCeoPermissions(identity.id, patch);

    // CEO authorization is a high-trust mutation (gates §31 agent register +
    // dispatch). Persist an audit trail so ops can answer "I never authorized
    // this — why did the agent register N teams" after the fact. Capture
    // userId + patch + result + ip + UA (forwarded headers from edge).
    const ip =
      request.headers.get('cf-connecting-ip') ||
      request.headers.get('x-forwarded-for') ||
      request.headers.get('x-real-ip') ||
      null;
    log.info(
      {
        audit: 'ceo-permissions.patch',
        userId: identity.id,
        authSource: identity.source,
        patch,
        result: next,
        ip,
        userAgent: request.headers.get('user-agent') || null,
      },
      'CEO permissions updated',
    );

    return asResponse(next);
  } catch (err) {
    if (err instanceof AuthError) return authErrorResponse(err);
    if (isUserNotFoundError(err)) {
      log.error({ err }, 'PATCH failed: IM user row missing for authenticated identity');
      return userNotFoundResponse((err as Error).message.replace('User not found: ', ''));
    }
    log.error({ err }, 'PATCH failed');
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL', message: 'Failed to update CEO permissions' } },
      { status: 500 },
    );
  }
}
