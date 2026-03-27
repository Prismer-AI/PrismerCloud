/**
 * Unified API Guard — Authentication + Balance Pre-check
 *
 * Two tiers:
 * - billable: validate auth + check balance + allow execution
 * - tracked:  validate auth + allow execution (no balance check)
 *
 * Usage recording is NOT handled here — each route already calls
 * recordUsageBackground() after execution.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getBackendApiBase } from '@/lib/backend-api';
import { ensureNacosConfig } from '@/lib/nacos-config';
import { FEATURE_FLAGS } from '@/lib/feature-flags';
import { getUserCredits } from '@/lib/db-credits';
import { validateApiKeyFromDb } from '@/lib/db-api-keys';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';

// ============================================================================
// Types
// ============================================================================

export type GuardTier = 'billable' | 'tracked';

export interface GuardOptions {
  tier: GuardTier;
  /** Estimated cost in credits for billable routes (used for balance pre-check) */
  estimatedCost?: number;
}

export interface AuthInfo {
  userId: string;
  email: string;
  authType: 'api_key' | 'jwt';
  /** Original Authorization header (for passing downstream) */
  authHeader: string;
  /** IM JWT generated from API Key (for Hono IM app) */
  imToken?: string;
}

export interface GuardResult {
  ok: true;
  auth: AuthInfo;
}

export interface GuardError {
  ok: false;
  response: NextResponse;
}

// ============================================================================
// API Key Validation Cache
// ============================================================================

interface CachedKey {
  userId: string;
  validUntil: number;
}

const keyCache = new Map<string, CachedKey>();
const KEY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCachedKeyValidation(apiKey: string): string | null {
  const hash = crypto.createHash('sha256').update(apiKey).digest('hex');
  const cached = keyCache.get(hash);
  if (cached && cached.validUntil > Date.now()) {
    return cached.userId;
  }
  if (cached) {
    keyCache.delete(hash);
  }
  return null;
}

function setCachedKeyValidation(apiKey: string, userId: string): void {
  const hash = crypto.createHash('sha256').update(apiKey).digest('hex');
  keyCache.set(hash, { userId, validUntil: Date.now() + KEY_CACHE_TTL });

  // Evict old entries periodically (keep cache bounded)
  if (keyCache.size > 1000) {
    const now = Date.now();
    for (const [k, v] of keyCache) {
      if (v.validUntil < now) keyCache.delete(k);
    }
  }
}

// ============================================================================
// Core: validateAuth
// ============================================================================

/**
 * Validate an Authorization header.
 * - API Key (sk-prismer-*): verify via local DB (FF_API_KEYS_LOCAL) or backend probe (fallback)
 * - JWT: decode payload locally (no signature verification — same as existing auth-utils.ts)
 */
async function validateAuth(authHeader: string): Promise<AuthInfo | null> {
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : authHeader;

  if (!token) return null;

  if (token.startsWith('sk-prismer-')) {
    return validateApiKey(token, authHeader);
  }

  return validateJwt(token, authHeader);
}

/**
 * Validate API Key.
 *
 * FF_API_KEYS_LOCAL=true  → SHA-256 hash → query pc_api_keys → real numeric userId
 * FF_API_KEYS_LOCAL=false → backend probe (known to be unreliable)
 */
async function validateApiKey(apiKey: string, authHeader: string): Promise<AuthInfo | null> {
  // Check cache first
  const cachedUserId = getCachedKeyValidation(apiKey);
  if (cachedUserId) {
    return {
      userId: cachedUserId,
      email: '',
      authType: 'api_key',
      authHeader,
      imToken: generateIMToken(cachedUserId),
    };
  }

  // --- Local DB validation (preferred) ---
  if (FEATURE_FLAGS.API_KEYS_LOCAL) {
    try {
      const result = await validateApiKeyFromDb(apiKey);
      if (result) {
        const userId = String(result.userId);
        setCachedKeyValidation(apiKey, userId);

        return {
          userId,
          email: '',
          authType: 'api_key',
          authHeader,
          imToken: generateIMToken(userId),
        };
      }
      // Not found in local DB — fall through to backend probe
      console.log('[API Guard] API Key not in local DB, trying backend fallback...');
    } catch (err) {
      console.error('[API Guard] Local API Key validation error, trying backend fallback:', err);
    }
  }

  // --- Backend probe fallback (only when backend is configured) ---
  const backendBase = await getBackendApiBase();
  if (!backendBase) {
    console.log('[API Guard] No backend configured, API Key validation failed');
    return null;
  }

  try {
    const res = await fetch(`${backendBase}/cloud/context/withdraw`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: 'https://_guard_auth_check', format: 'hqcc' }),
    });

    if (res.status === 401 || res.status === 403) {
      console.log('[API Guard] API Key rejected by backend');
      return null;
    }

    // Key is valid — derive stable user ID
    const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
    const userId = `apikey_${keyHash}`;

    // Cache the result
    setCachedKeyValidation(apiKey, userId);

    return {
      userId,
      email: '',
      authType: 'api_key',
      authHeader,
      imToken: generateIMToken(userId),
    };
  } catch (err) {
    console.error('[API Guard] API Key verification failed:', err);
    return null;
  }
}

/**
 * Validate JWT.
 * FF_AUTH_LOCAL=true → verify signature with JWT_SECRET
 * FF_AUTH_LOCAL=false → decode only (backend issued the token)
 */
async function validateJwt(token: string, authHeader: string): Promise<AuthInfo | null> {
  try {
    if (FEATURE_FLAGS.AUTH_LOCAL) {
      // Self-host: verify signature
      const payload = jwt.verify(token, getJWTSecret()) as jwt.JwtPayload;
      const userId = payload.sub || payload.user_id || payload.id;
      if (!userId) return null;
      return {
        userId: String(userId),
        email: (payload.email as string) || '',
        authType: 'jwt',
        authHeader,
      };
    }

    // Backend mode: decode only (trust backend-issued tokens)
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
    const userId = payload.sub || payload.user_id || payload.id;
    if (!userId) return null;

    return {
      userId: String(userId),
      email: payload.email || '',
      authType: 'jwt',
      authHeader,
    };
  } catch {
    return null;
  }
}

// ============================================================================
// Balance Check
// ============================================================================

/**
 * Best-effort balance pre-check.
 * Only works when FF_USER_CREDITS_LOCAL is true and user has a numeric ID.
 * Returns true (allow) if check cannot be performed.
 */
async function checkBalance(userId: string, estimatedCost: number): Promise<boolean> {
  if (FEATURE_FLAGS.UNLIMITED_CREDITS) {
    return true;
  }

  if (!FEATURE_FLAGS.USER_CREDITS_LOCAL) {
    // No local DB path — skip check (best-effort)
    return true;
  }

  const numericId = parseInt(userId, 10);
  if (isNaN(numericId)) {
    // API Key users without FF_API_KEYS_LOCAL have string IDs (apikey_XXXX) — skip
    return true;
  }

  try {
    const credits = await getUserCredits(numericId);
    return credits.balance >= estimatedCost;
  } catch (err) {
    console.error('[API Guard] Balance check failed:', err);
    // Fail open — allow the request
    return true;
  }
}

// ============================================================================
// IM JWT Helper
// ============================================================================

function getJWTSecret(): string {
  return process.env.JWT_SECRET || process.env.NEXTAUTH_SECRET || 'dev-secret-change-me';
}

/**
 * Generate a short-lived IM JWT for API Key users.
 * The Hono IM app requires JWT auth — API Key users get a translated token.
 */
function generateIMToken(userId: string): string {
  return jwt.sign(
    { sub: userId, username: userId, role: 'system' as const, type: 'api_key_proxy' },
    getJWTSecret(),
    { expiresIn: '1h' }
  );
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Unified API guard.
 *
 * @param request - The incoming Next.js request
 * @param options - Guard configuration (tier, estimatedCost)
 * @returns GuardResult (ok + auth info) or GuardError (error response)
 *
 * Usage:
 * ```ts
 * const guard = await apiGuard(request, { tier: 'billable', estimatedCost: 1 });
 * if (!guard.ok) return guard.response;
 * // guard.auth.userId, guard.auth.authHeader, etc.
 * ```
 */
export async function apiGuard(
  request: NextRequest,
  options: GuardOptions
): Promise<GuardResult | GuardError> {
  try {
    // Ensure Nacos config is loaded (needed for backend URL resolution)
    await ensureNacosConfig();

    // Short-circuit: AUTH_DISABLED — treat all requests as default admin
    if (FEATURE_FLAGS.AUTH_DISABLED) {
      return {
        ok: true,
        auth: {
          userId: '1',
          email: process.env.INIT_ADMIN_EMAIL || 'admin@localhost',
          authType: 'jwt',
          authHeader: '',
        },
      };
    }

    // 1. Extract Authorization header
    const authHeader = request.headers.get('authorization');
    if (!authHeader) {
      return {
        ok: false,
        response: NextResponse.json({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Authorization header is required. Use: Authorization: Bearer <token>',
          },
        }, { status: 401 }),
      };
    }

    // 2. Validate auth
    const auth = await validateAuth(authHeader);
    if (!auth) {
      return {
        ok: false,
        response: NextResponse.json({
          success: false,
          error: {
            code: 'INVALID_TOKEN',
            message: 'Invalid or expired token',
          },
        }, { status: 401 }),
      };
    }

    // 3. Balance pre-check (billable tier only)
    if (options.tier === 'billable' && options.estimatedCost && options.estimatedCost > 0) {
      const hasBalance = await checkBalance(auth.userId, options.estimatedCost);
      if (!hasBalance) {
        return {
          ok: false,
          response: NextResponse.json({
            success: false,
            error: {
              code: 'INSUFFICIENT_CREDITS',
              message: 'Insufficient credits. Please top up your account.',
            },
          }, { status: 402 }),
        };
      }
    }

    return { ok: true, auth };
  } catch (err) {
    console.error('[API Guard] Unexpected error:', err);
    return {
      ok: false,
      response: NextResponse.json({
        success: false,
        error: {
          code: 'AUTH_ERROR',
          message: 'Authentication service error',
        },
      }, { status: 500 }),
    };
  }
}
