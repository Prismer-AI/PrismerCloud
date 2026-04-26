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
import { createModuleLogger } from '@/lib/logger';
import { FEATURE_FLAGS } from '@/lib/feature-flags';
import { getUserCredits } from '@/lib/db-credits';
import { validateApiKeyFromDb } from '@/lib/db-api-keys';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';

const log = createModuleLogger('APIGuard');

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
const KEY_CACHE_TTL = 60 * 1000; // 60 seconds (reduced from 5min for faster revocation propagation)

function getCachedKeyValidation(apiKey: string): string | null {
  const hash = crypto.createHash('sha256').update(apiKey).digest('hex');
  const cached = keyCache.get(hash);
  if (cached && cached.validUntil > Date.now()) {
    log.debug({ userId: cached.userId }, 'API Key cache hit');
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

/** Flush entire key cache (call on revoke/delete — route handlers don't have the raw key). */
export function flushKeyCache(): void {
  const size = keyCache.size;
  keyCache.clear();
  if (size > 0) {
    log.info({ flushed: size }, 'API Key cache flushed on revoke/delete');
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
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

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

  // --- Local DB validation (preferred & authoritative when enabled) ---
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
      // Not found in local DB — reject immediately.
      // When FF_API_KEYS_LOCAL is enabled, the local DB is the source of truth.
      // Do NOT fall through to backend probe, which may accept invalid keys.
      log.info('API Key not found in local DB, rejecting');
      return null;
    } catch (err) {
      log.warn({ err }, 'Local API Key validation error, trying backend fallback');
      // DB error — fall through to backend probe as a resilience measure
    }
  }

  // --- Backend probe fallback (only used when FF_API_KEYS_LOCAL is disabled or DB errored) ---
  try {
    const backendBase = await getBackendApiBase();
    const res = await fetch(`${backendBase}/cloud/context/withdraw`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: 'https://_guard_auth_check', format: 'hqcc' }),
    });

    // Only treat explicit 2xx as "key is valid".
    // Previously, any non-401/403 (including 400, 404, 500) was accepted,
    // which allowed invalid keys to pass and get cached.
    if (res.status === 401 || res.status === 403) {
      log.info('API Key rejected by backend');
      return null;
    }

    if (res.status >= 200 && res.status < 300) {
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
    }

    // Non-2xx, non-401/403 — treat as rejection (fail-closed)
    log.warn({ status: res.status }, 'Backend probe returned unexpected status, rejecting key');
    return null;
  } catch (err) {
    log.error({ err }, 'API Key verification failed');
    return null;
  }
}

/**
 * Decode JWT payload locally (no signature verification).
 * Same logic as existing auth-utils.ts getUserFromJwt.
 */
async function validateJwt(token: string, authHeader: string): Promise<AuthInfo | null> {
  try {
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
 * Balance pre-check result.
 */
interface BalanceCheckResult {
  allowed: boolean;
  balance?: number;
  required?: number;
  reason?: string;
}

/**
 * Balance pre-check — fail-closed by default.
 *
 * Resolves numeric userId from API Key string IDs (apikey_XXXX) when possible.
 * Configurable via FF_BALANCE_FAIL_OPEN for graceful rollout.
 */
async function checkBalance(userId: string, estimatedCost: number): Promise<BalanceCheckResult> {
  if (!FEATURE_FLAGS.USER_CREDITS_LOCAL) {
    // No local DB path — proxy path handles billing; allow but log
    log.debug({ userId }, 'Balance check skipped: USER_CREDITS_LOCAL disabled');
    return { allowed: true };
  }

  const numericId = parseInt(userId, 10);
  if (isNaN(numericId)) {
    // API Key users with string IDs — try to resolve from pc_api_keys
    if (FEATURE_FLAGS.API_KEYS_LOCAL && userId.startsWith('apikey_')) {
      log.debug({ userId }, 'String userId from API Key, cannot resolve numeric ID — denying');
      // apikey_XXXX IDs from backend probe fallback have no local credit record
      // This is the correct behavior: require FF_API_KEYS_LOCAL for billing
    }
    // Cannot check balance without numeric userId — fail-closed
    const failOpen = process.env.FF_BALANCE_FAIL_OPEN === 'true';
    if (failOpen) {
      log.warn({ userId }, 'Balance check skipped for non-numeric userId (FF_BALANCE_FAIL_OPEN=true)');
      return { allowed: true };
    }
    log.warn({ userId }, 'Balance check failed: non-numeric userId, denying request');
    return { allowed: false, reason: 'Cannot verify balance for this account type. Please use a registered account.' };
  }

  try {
    const credits = await getUserCredits(numericId);
    if (credits.balance >= estimatedCost) {
      return { allowed: true, balance: credits.balance, required: estimatedCost };
    }
    return {
      allowed: false,
      balance: credits.balance,
      required: estimatedCost,
      reason: 'Insufficient credits',
    };
  } catch (err) {
    log.error({ err, userId }, 'Balance check database error');
    // Fail-closed by default; configurable for rollout
    const failOpen = process.env.FF_BALANCE_FAIL_OPEN === 'true';
    if (failOpen) {
      log.warn({ userId }, 'Balance check error, allowing request (FF_BALANCE_FAIL_OPEN=true)');
      return { allowed: true };
    }
    return { allowed: false, reason: 'Unable to verify account balance. Please try again.' };
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
function generateIMToken(userId: string, email?: string): string {
  return jwt.sign(
    { sub: userId, username: userId, role: 'system' as const, type: 'api_key_proxy', ...(email && { email }) },
    getJWTSecret(),
    { expiresIn: '1h' },
  );
}

/**
 * Public wrapper — used by IM proxy route to generate IM JWT for platform JWT users.
 */
export function generateIMTokenForUser(userId: string, email?: string): string {
  return generateIMToken(userId, email);
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
export async function apiGuard(request: NextRequest, options: GuardOptions): Promise<GuardResult | GuardError> {
  try {
    // Ensure Nacos config is loaded (needed for backend URL resolution)
    await ensureNacosConfig();

    // 1. Extract Authorization header
    const authHeader = request.headers.get('authorization');
    if (!authHeader) {
      return {
        ok: false,
        response: NextResponse.json(
          {
            success: false,
            error: {
              code: 'UNAUTHORIZED',
              message: 'Authorization header is required. Use: Authorization: Bearer <token>',
            },
          },
          { status: 401 },
        ),
      };
    }

    // 2. Validate auth
    const auth = await validateAuth(authHeader);
    if (!auth) {
      return {
        ok: false,
        response: NextResponse.json(
          {
            success: false,
            error: {
              code: 'INVALID_TOKEN',
              message: 'Invalid or expired token',
            },
          },
          { status: 401 },
        ),
      };
    }

    // 3. Balance pre-check (billable tier only)
    if (options.tier === 'billable' && options.estimatedCost && options.estimatedCost > 0) {
      const balanceCheck = await checkBalance(auth.userId, options.estimatedCost);
      if (!balanceCheck.allowed) {
        return {
          ok: false,
          response: NextResponse.json(
            {
              success: false,
              error: {
                code: 'INSUFFICIENT_CREDITS',
                message: balanceCheck.reason || 'Insufficient credits. Please top up your account.',
                balance: balanceCheck.balance,
                required: balanceCheck.required,
                topupUrl: '/dashboard#billing',
              },
            },
            { status: 402 },
          ),
        };
      }
    }

    return { ok: true, auth };
  } catch (err) {
    log.error({ err }, 'Unexpected error');
    return {
      ok: false,
      response: NextResponse.json(
        {
          success: false,
          error: {
            code: 'AUTH_ERROR',
            message: 'Authentication service error',
          },
        },
        { status: 500 },
      ),
    };
  }
}
