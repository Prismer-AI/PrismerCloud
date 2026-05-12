/**
 * Prismer IM — Auth middleware for Hono
 *
 * Supports two authentication modes:
 * 1. Direct JWT (from init/init-group) - uses token's sub as IM User ID
 * 2. API Key proxy (type='api_key_proxy') - auto-creates IM User from Cloud User ID
 */

import type { Context, Next } from 'hono';
import { verifyToken, type JWTPayload } from './jwt';
import prisma from '../db';
import { generateUserId } from '../utils/id-gen';

/**
 * Extended payload that includes IM User info after resolution.
 */
export interface ResolvedUser extends JWTPayload {
  imUserId: string; // Actual IM User ID (may differ from sub for API Key users)
  trustTier: number; // 0-4 trust level (Layer 4 Security)
  suspendedUntil?: Date | null; // Account suspension timestamp
  resolvedDid?: string; // AIP: did:key from identity key (always fresh, not from JWT cache)
}

/**
 * Extends Hono context variables with the authenticated user.
 */
declare module 'hono' {
  interface ContextVariableMap {
    user: ResolvedUser;
  }
}

/**
 * Ensure IM User exists for a Cloud User ID.
 *
 * Supports multi-agent: one Cloud User can own multiple IM Users.
 * - If agentHint provided, find the specific agent by (cloudUserId, username)
 * - Otherwise, use the first (oldest) IM User for this Cloud User
 * - Creates a human IM User if none exist
 */
/**
 * Ensure a default workspace exists for a human IM user.
 * Called from both the api_key_proxy path (in ensureIMUser) and the direct
 * JWT path (in authMiddleware) so every human user — whether they signed up
 * via OAuth, native register, or API key proxy — gets their Personal
 * workspace. Before this fix, JWT users (Google/GitHub/Apple/native reg)
 * had no workspace auto-created and saw "No workspace yet" after login.
 */
async function ensureDefaultWorkspace(imUserId: string): Promise<void> {
  const ws = await prisma.iMWorkspace.findFirst({
    where: { ownerImUserId: imUserId, isDefault: true, deletedAt: null },
    select: { id: true },
  });
  if (!ws) {
    try {
      await prisma.iMWorkspace.create({
        data: {
          ownerImUserId: imUserId,
          name: 'Personal',
          slug: `personal-${imUserId.slice(-6)}`,
          isDefault: true,
        },
      });
      console.log(`[Auth] Auto-created default workspace for IM User ${imUserId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('Unique') && !msg.includes('UNIQUE')) {
        console.error(`[Auth] Failed to create default workspace for ${imUserId}: ${msg}`);
      }
    }
  }
}

async function ensureIMUser(cloudUserId: string, username: string, agentHint?: string): Promise<string> {
  // 1. If agent hint provided, find specific agent
  if (agentHint) {
    const agent = await prisma.iMUser.findFirst({
      where: { userId: cloudUserId, username: agentHint },
    });
    if (agent) return agent.id;
  }

  // 2. Prefer the human IMUser for this Cloud User. Workspaces are owned by
  // humans, so binding to an agent imuser would surface a "no workspace
  // found" error on every workspace API call. Multi-agent routing uses the
  // X-IM-Agent header (handled above), not the createdAt ordering.
  let imUser = await prisma.iMUser.findFirst({
    where: { userId: cloudUserId, role: 'human' },
    orderBy: { createdAt: 'asc' },
  });
  if (!imUser) {
    // Fall back to any IMUser (legacy data without role split, or pre-1.9.x rows)
    imUser = await prisma.iMUser.findFirst({
      where: { userId: cloudUserId },
      orderBy: { createdAt: 'asc' },
    });
  }
  // Why: API-key auth in api-guard.ts derives `cloudUserId` from
  // `pc_api_keys.user_id` (bigint = im_users.numericId). For legacy users
  // whose `im_users.userId` was never backfilled to that numeric string,
  // the above two lookups miss and we'd silently create a phantom IMUser
  // (username/displayName = the numeric id) on every dispatch — the source
  // of the ws82hi80y / wpr51t54n orphan trail and the workspace-owner
  // filter returning [] for the real owner.
  if (!imUser && /^\d+$/.test(cloudUserId)) {
    try {
      const numericId = BigInt(cloudUserId);
      imUser = await prisma.iMUser.findFirst({
        where: { numericId, role: 'human' },
        orderBy: { createdAt: 'asc' },
      });
      if (!imUser) {
        imUser = await prisma.iMUser.findFirst({
          where: { numericId },
          orderBy: { createdAt: 'asc' },
        });
      }
    } catch {
      // BigInt parse failed — fall through to auto-create below
    }
  }

  if (!imUser) {
    // 3. Create new IM User linked to Cloud User
    imUser = await prisma.iMUser.create({
      data: {
        id: generateUserId(),
        username: username,
        displayName: username.split('@')[0] || username,
        role: 'human',
        userId: cloudUserId,
        metadata: JSON.stringify({ autoCreated: true, createdAt: new Date().toISOString() }),
      },
    });
    console.log(`[Auth] Auto-created IM User ${imUser.id} for Cloud User ${cloudUserId}`);
  }

  // Ensure workspace is created for human users
  if (imUser.role === 'human') {
    await ensureDefaultWorkspace(imUser.id);
  }

  return imUser.id;
}

/**
 * JWT authentication middleware.
 * Expects `Authorization: Bearer <token>` header.
 *
 * For API Key proxy tokens (type='api_key_proxy'):
 * - Automatically creates IM User if not exists
 * - Maps Cloud User ID to IM User ID
 */
export async function authMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ ok: false, error: 'Missing or invalid Authorization header' }, 401);
  }

  const token = authHeader.slice(7);
  try {
    const payload = verifyToken(token);

    // Resolve IM User ID based on token type
    let imUserId: string;

    if (payload.type === 'api_key_proxy') {
      // API Key proxy: find IM User (supports multi-agent via X-IM-Agent header)
      const agentHint = c.req.header('X-IM-Agent');
      imUserId = await ensureIMUser(payload.sub, payload.username, agentHint);
    } else {
      // Direct JWT: sub is already IM User ID
      imUserId = payload.sub;
    }

    // Fetch trust tier, suspension status, role, banned flag, and DID for
    // security context. Cloud 1.5 (54release): `banned=true` (set by
    // DELETE /api/im/me cascade) and an active `suspendedUntil` MUST cause
    // the request to be rejected here — the cloud-side guard already does
    // this, and previously the IM router was the gap that let deleted
    // users keep using their JWT until expiry.
    let dbRole: string | undefined;
    let trustTier = 0;
    let suspendedUntil: Date | null = null;
    let resolvedDid: string | undefined;
    let banned = false;
    let userExists = false;
    try {
      const imUser = await prisma.iMUser.findUnique({
        where: { id: imUserId },
        select: { role: true, trustTier: true, suspendedUntil: true, primaryDid: true, banned: true },
      });
      if (imUser) {
        userExists = true;
        dbRole = imUser.role;
        trustTier = imUser.trustTier;
        suspendedUntil = imUser.suspendedUntil;
        resolvedDid = imUser.primaryDid ?? undefined;
        banned = imUser.banned;

        // Ensure default workspace exists for human users. The api_key_proxy
        // path handles this inside ensureIMUser, but the direct JWT path
        // (Google/GitHub/Apple/native register) skips ensureIMUser entirely,
        // leaving OAuth users without a Personal workspace — the "No workspace
        // yet" bug that plagued fresh login.
        if (imUser.role === 'human') {
          await ensureDefaultWorkspace(imUserId);
        }
      }
    } catch {
      // Best effort — default to tier 0; let the request through (existing behaviour).
    }

    // Hard reject banned (account deletion / moderation ban) and currently
    // suspended users. We let "user not found in DB" through ONLY for
    // api_key_proxy tokens — that path auto-creates IMUsers and the row
    // may not exist yet on the very first request after registration.
    //
    // For direct JWT, "user not found" means the token references a
    // deleted/rotated IMUser id (e.g. a stale token from a wiped dev DB
    // or a re-seeded test env). Returning the request through silently
    // makes downstream endpoints emit confusing 404s ("/api/im/me 404"
    // while /api/im/conversations returns 200 [] — see Wave-7 ζ regression).
    // Reject the token cleanly so clients can detect "log out + re-login"
    // instead of debugging mystery 404s.
    if (userExists && banned) {
      return c.json({ ok: false, error: 'Account is inactive' }, 401);
    }
    if (userExists && suspendedUntil && suspendedUntil > new Date()) {
      return c.json({ ok: false, error: 'Account is temporarily suspended' }, 401);
    }
    if (!userExists && payload.type !== 'api_key_proxy') {
      return c.json({ ok: false, error: 'Account no longer exists. Please sign in again.' }, 401);
    }

    // Resolve admin role: check email against ADMIN_EMAILS env var
    const adminEmails = (process.env.ADMIN_EMAILS || '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    const isAdmin = !!payload.email && adminEmails.includes(payload.email.toLowerCase());

    // Set resolved user with actual IM User ID + security fields + AIP DID
    // Use DB role (actual IM user role) over JWT payload role (proxy default)
    const resolvedUser: ResolvedUser = {
      ...payload,
      role: isAdmin ? ('admin' as any) : dbRole || payload.role,
      imUserId,
      trustTier,
      suspendedUntil,
      resolvedDid,
    };

    c.set('user', resolvedUser);
    await next();
  } catch (err) {
    console.error('[Auth] Error:', err);
    return c.json({ ok: false, error: 'Invalid or expired token' }, 401);
  }
}

/**
 * Role-based access guard.
 */
export function requireRole(...roles: string[]) {
  return async (c: Context, next: Next) => {
    const user = c.get('user');
    if (!user || !roles.includes(user.role)) {
      return c.json({ ok: false, error: 'Forbidden' }, 403);
    }
    await next();
  };
}
