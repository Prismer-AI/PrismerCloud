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
async function ensureIMUser(cloudUserId: string, username: string, agentHint?: string): Promise<string> {
  // 1. If agent hint provided, find specific agent
  if (agentHint) {
    const agent = await prisma.iMUser.findFirst({
      where: { userId: cloudUserId, username: agentHint },
    });
    if (agent) return agent.id;
  }

  // 2. Find first IM User for this Cloud User (oldest = default)
  let imUser = await prisma.iMUser.findFirst({
    where: { userId: cloudUserId },
    orderBy: { createdAt: 'asc' },
  });

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

    // Fetch trust tier, suspension status, role, and DID for security context
    let dbRole: string | undefined;
    let trustTier = 0;
    let suspendedUntil: Date | null = null;
    let resolvedDid: string | undefined;
    try {
      const imUser = await prisma.iMUser.findUnique({
        where: { id: imUserId },
        select: { role: true, trustTier: true, suspendedUntil: true, primaryDid: true },
      });
      if (imUser) {
        dbRole = imUser.role;
        trustTier = imUser.trustTier;
        suspendedUntil = imUser.suspendedUntil;
        resolvedDid = imUser.primaryDid ?? undefined;
      }
    } catch {
      // Best effort — default to tier 0
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
