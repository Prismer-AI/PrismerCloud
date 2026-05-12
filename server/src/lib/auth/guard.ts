/**
 * Auth Identity Guard — pcrefactor Prismer Cloud
 *
 * Single source of truth for resolving the calling identity in API routes.
 * Replaces the legacy Go-backend `users` proxy with native NextAuth + JWT.
 *
 * Resolution order (first match wins):
 *   1. NextAuth session cookie (preferred for browser flows)
 *   2. Authorization: Bearer <jwt>      (IM token, sub=im_users.id)
 *   3. Authorization: Bearer sk-prismer-* (daemon/runtime API key)
 *   4. Dev fallback (NODE_ENV !== 'production'): X-Dev-User-Id header
 *
 * API-key auth resolves to the owning human IM identity, then callers still
 * enforce workspace/container/object authorization. It is not a bypass.
 *
 * Returns AuthIdentity with both string id (im_users.id, cuid) and
 * numericId (BIGINT — populated by migration 130 for native-auth users).
 * pc_* tables key on numericId; im_* tables key on id.
 */

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import prisma from '@/lib/prisma';
import { apiGuard } from '@/lib/api-guard';
import { auth } from '@/lib/auth/nextauth';
import { redis } from '@/lib/auth/redis';

export interface AuthIdentity {
  id: string;
  numericId: number;
  email?: string;
  role: 'human' | 'agent';
  source: 'session' | 'jwt' | 'api-key' | 'dev-fallback';
}

export class AuthError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET || process.env.NEXTAUTH_SECRET;
  if (!secret) throw new AuthError(500, 'JWT_SECRET is not configured');
  return secret;
}

function asNumber(v: bigint | number | null | undefined): number {
  if (v == null) return 0;
  return typeof v === 'bigint' ? Number(v) : v;
}

async function loadIMUserById(id: string): Promise<{
  id: string;
  numericId: number;
  email: string | null;
  role: string;
  banned: boolean;
  suspendedUntil: Date | null;
} | null> {
  const user = (await (prisma as any).iMUser.findUnique({
    where: { id },
    select: {
      id: true,
      numericId: true,
      email: true,
      role: true,
      banned: true,
      suspendedUntil: true,
    },
  })) as {
    id: string;
    numericId: bigint | number | null;
    email: string | null;
    role: string;
    banned: boolean;
    suspendedUntil: Date | null;
  } | null;
  if (!user) return null;
  return { ...user, numericId: asNumber(user.numericId) };
}

function isActive(user: { banned: boolean; suspendedUntil: Date | null }): boolean {
  if (user.banned) return false;
  if (user.suspendedUntil && user.suspendedUntil > new Date()) return false;
  return true;
}

// 1. NextAuth session ─────────────────────────────────────────

async function tryNextAuthSession(): Promise<AuthIdentity | null> {
  try {
    const session = await auth();
    if (!session?.user?.id) return null;
    const user = await loadIMUserById(session.user.id);
    if (!user || !isActive(user) || user.role !== 'human') return null;
    return {
      id: user.id,
      numericId: user.numericId,
      email: user.email ?? undefined,
      role: 'human',
      source: 'session',
    };
  } catch (err) {
    // Unexpected: NextAuth session decode or DB lookup blew up. Log so
    // ops can debug; treat as anonymous so the request continues.
    console.error('[AuthGuard] NextAuth session check failed', { err: (err as Error).message });
    return null;
  }
}

// 2. Authorization: Bearer <jwt> ──────────────────────────────

function extractBearer(req: NextRequest): string | null {
  const header = req.headers.get('authorization');
  if (!header) return null;
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

async function isTokenBlacklisted(token: string): Promise<boolean> {
  try {
    const key = `auth:token-blacklist:${crypto.createHash('sha256').update(token).digest('hex')}`;
    return await redis.exists(key);
  } catch (err) {
    // Fail-open: if Redis is unreachable we can't enforce logout
    // blacklist, but blocking all logins is worse. Surface clearly so
    // ops can alert. JWT signature still gates access.
    console.warn('[AuthGuard] redis blacklist check failed; failing open', {
      err: (err as Error).message,
    });
    return false;
  }
}

async function loadIMUserByNumericId(numericId: number): Promise<{
  id: string;
  numericId: number;
  email: string | null;
  role: string;
  banned: boolean;
  suspendedUntil: Date | null;
} | null> {
  const user = (await (prisma as any).iMUser.findFirst({
    where: { numericId: BigInt(numericId) as any },
    select: { id: true, numericId: true, email: true, role: true, banned: true, suspendedUntil: true },
  })) as {
    id: string;
    numericId: bigint | number | null;
    email: string | null;
    role: string;
    banned: boolean;
    suspendedUntil: Date | null;
  } | null;
  if (!user) return null;
  return { ...user, numericId: asNumber(user.numericId) };
}

async function loadHumanIMUserByCloudUserId(cloudUserId: number | string): Promise<{
  id: string;
  numericId: number;
  email: string | null;
  role: string;
  banned: boolean;
  suspendedUntil: Date | null;
} | null> {
  const user = (await (prisma as any).iMUser.findFirst({
    where: { userId: String(cloudUserId), role: 'human' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, numericId: true, email: true, role: true, banned: true, suspendedUntil: true },
  })) as {
    id: string;
    numericId: bigint | number | null;
    email: string | null;
    role: string;
    banned: boolean;
    suspendedUntil: Date | null;
  } | null;
  if (!user) return null;
  return { ...user, numericId: asNumber(user.numericId) };
}

async function tryJwtBearer(req: NextRequest): Promise<AuthIdentity | null> {
  const token = extractBearer(req);
  if (!token || token.startsWith('sk-prismer-')) return null;
  if (await isTokenBlacklisted(token)) return null;

  try {
    // Accept both shapes:
    //   - Native (Next.js): { sub: string (im_users.id cuid), numericId? }
    //   - Go backend:       { user_id: number (numericId), email }
    // Same JWT_SECRET on both sides → cross-decoded tokens validate.
    const payload = jwt.verify(token, getJwtSecret()) as {
      sub?: string;
      user_id?: number | string;
      numericId?: number;
      email?: string;
      role?: string;
    };

    let user: {
      id: string;
      numericId: number;
      email: string | null;
      role: string;
      banned: boolean;
      suspendedUntil: Date | null;
    } | null = null;

    if (payload.sub && typeof payload.sub === 'string') {
      user = await loadIMUserById(payload.sub);
    } else if (payload.user_id != null) {
      const num = typeof payload.user_id === 'string' ? parseInt(payload.user_id, 10) : payload.user_id;
      if (Number.isFinite(num) && num > 0) {
        user = await loadIMUserByNumericId(num);
      }
    }

    if (!user || !isActive(user)) return null;

    return {
      id: user.id,
      numericId: user.numericId || payload.numericId || 0,
      email: user.email ?? payload.email,
      role: user.role === 'agent' ? 'agent' : 'human',
      source: 'jwt',
    };
  } catch (err: any) {
    // Differentiate expected (signature/expiry) from unexpected (DB,
    // Prisma, Redis blacklist throw) — the latter MUST be visible in
    // logs or incident triage is impossible.
    const name = err?.name || '';
    if (name === 'JsonWebTokenError' || name === 'TokenExpiredError' || name === 'NotBeforeError') {
      // Expected — quiet (token doesn't validate; caller treats as no auth).
      return null;
    }
    console.error('[AuthGuard] JWT bearer check failed unexpectedly', {
      name,
      err: err?.message,
    });
    return null;
  }
}

// 3. API key bearer ──────────────────────────────────────────

async function tryApiKeyBearer(req: NextRequest): Promise<AuthIdentity | null> {
  const token = extractBearer(req);
  if (!token?.startsWith('sk-prismer-')) return null;

  const guard = await apiGuard(req, { tier: 'tracked' });
  if (!guard.ok || guard.auth.authType !== 'api_key') return null;
  const cloudUserId = guard.auth.userId;

  const numericCloudUserId = Number.parseInt(cloudUserId, 10);
  const numericMatch =
    Number.isFinite(numericCloudUserId) && numericCloudUserId > 0
      ? await loadIMUserByNumericId(numericCloudUserId)
      : null;
  const user = numericMatch?.role === 'human' ? numericMatch : await loadHumanIMUserByCloudUserId(cloudUserId);
  if (!user || !isActive(user) || user.role !== 'human') return null;

  return {
    id: user.id,
    numericId: user.numericId,
    email: user.email ?? undefined,
    role: 'human',
    source: 'api-key',
  };
}

// 4. Dev fallback ─────────────────────────────────────────────

async function tryDevFallback(req: NextRequest): Promise<AuthIdentity | null> {
  if (process.env.NODE_ENV === 'production') return null;
  const devId = req.headers.get('x-dev-user-id');
  if (!devId) return null;

  const user = await loadIMUserById(devId);
  if (!user || !isActive(user)) return null;
  return {
    id: user.id,
    numericId: user.numericId,
    email: user.email ?? undefined,
    role: user.role === 'agent' ? 'agent' : 'human',
    source: 'dev-fallback',
  };
}

// Public API ──────────────────────────────────────────────────

/**
 * Best-effort identity resolution. Returns null if no credential matches —
 * caller decides whether anonymous access is allowed.
 */
export async function getAuthIdentity(req: NextRequest): Promise<AuthIdentity | null> {
  return (
    (await tryNextAuthSession()) ??
    (await tryJwtBearer(req)) ??
    (await tryApiKeyBearer(req)) ??
    (await tryDevFallback(req))
  );
}

/**
 * Strict variant: throws AuthError(401) if no credential matches. Intended
 * for routes that require authentication.
 */
export async function requireAuthIdentity(req: NextRequest): Promise<AuthIdentity> {
  const identity = await getAuthIdentity(req);
  if (!identity) {
    throw new AuthError(401, 'Authentication required');
  }
  return identity;
}

/** Convenience wrapper: convert AuthError → NextResponse. */
export function authErrorResponse(err: unknown): NextResponse {
  if (err instanceof AuthError) {
    return NextResponse.json(
      { success: false, error: { code: 'AUTH_REQUIRED', message: err.message } },
      { status: err.status },
    );
  }
  console.error('[AuthGuard] Unexpected error:', err);
  return NextResponse.json(
    { success: false, error: { code: 'INTERNAL', message: 'Internal authentication error' } },
    { status: 500 },
  );
}
