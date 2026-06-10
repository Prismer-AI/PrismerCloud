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
  /**
   * Bug Z2 fix — IM user id carried separately from `userId` so the IM proxy
   * route + middleware can resolve IMUser directly by cuid sub, while legacy
   * `userId = numericId` is preserved for FF_API_KEYS_LOCAL paths
   * (`/api/keys` does `Number(guard.auth.userId)`). Populated only when the
   * JWT's `sub` matches the IMUser.id cuid shape (`/^cmp[a-z0-9]{20,}$/`).
   */
  imUserSub?: string;
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
 *
 * TODO(release202/12 P2, beta-deferred): this trusts an UNVERIFIED JWT payload
 * on a spend-bearing path — a forged `{numericId}` impersonates any user. Not
 * fixed during beta (a blanket verify would lock out OAuth/Google/GitHub tokens
 * signed with third-party keys). Before enabling: confirm whether an edge
 * gateway already verifies, and split local-issued (`local-auth.ts::issueToken`,
 * HS256 via getJWTSecret) vs OAuth tokens so each is verified appropriately.
 */
/**
 * IMUser.id cuid shape — Prisma `@default(cuid())` produces 25-char strings
 * starting with `cmp` (we narrow `c` to `cmp` to avoid false positives like
 * email addresses). Bug Z2: when the JWT sub matches this shape, it IS the
 * IMUser.id — downstream proxies / middleware must NOT re-translate via
 * numericId, which would mint a phantom IMUser. The looser shorter form
 * (9-char `generateUserId()` output) is not detected here because we can't
 * disambiguate it from a numeric short string without DB lookup; the
 * conservative cuid-only check covers the Z2-impacted production rows
 * (legacy `cmp...` users like the invite-accept failure).
 */
const IM_CUID_RE = /^cmp[a-z0-9]{20,}$/;

async function validateJwt(token: string, authHeader: string): Promise<AuthInfo | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));

    // Prefer `numericId` (pc_users.id, canonical FK for FF_*_LOCAL paths
    // like /api/keys → `Number(guard.auth.userId)`). Newer JWTs from
    // local-auth.ts::issueToken set both `sub` (IMUser.id cuid) and
    // `numericId` (pc_users.id int). Falling back to `sub` makes
    // /api/keys cast NaN → 403 INVALID_USER for any Google/email-login
    // user, so prefer numericId when available.
    const resolvedUserId =
      typeof payload.numericId === 'number' && Number.isFinite(payload.numericId)
        ? payload.numericId
        : payload.sub || payload.user_id || payload.id;
    if (resolvedUserId === undefined || resolvedUserId === null || resolvedUserId === '') return null;

    // Bug Z2 — preserve the IMUser.id (cuid sub) alongside numericId. The IM
    // proxy route + IM auth middleware use this to resolve the existing
    // IMUser by id, avoiding the api_key_proxy translation that previously
    // minted phantom IMUsers on invite accept.
    const subValue = typeof payload.sub === 'string' ? payload.sub : undefined;
    const imUserSub = subValue && IM_CUID_RE.test(subValue) ? subValue : undefined;

    return {
      userId: String(resolvedUserId),
      email: payload.email || '',
      authType: 'jwt',
      authHeader,
      ...(imUserSub ? { imUserSub } : {}),
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
  const secret = process.env.JWT_SECRET || process.env.NEXTAUTH_SECRET;
  if (secret) return secret;
  const appEnv = process.env.APP_ENV;
  if (process.env.NODE_ENV === 'production' || appEnv === 'prod' || appEnv === 'test') {
    throw new Error('[api-guard] FATAL: JWT_SECRET (or NEXTAUTH_SECRET) must be set in non-dev environments');
  }
  return 'dev-secret-change-me';
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

/**
 * Bug Z2 — generate a direct IM JWT (NOT api_key_proxy) when the upstream
 * JWT's sub is already an IMUser.id cuid. The IM authMiddleware sees a token
 * without `type: 'api_key_proxy'` and treats sub as imUserId directly,
 * skipping `ensureIMUser` (which would mint a phantom IMUser on a
 * numeric-id miss). Used by the IM proxy route when `auth.imUserSub` is set.
 */
export function generateIMTokenForImUser(imUserId: string, email?: string): string {
  return jwt.sign(
    { sub: imUserId, username: imUserId, role: 'human' as const, ...(email && { email }) },
    getJWTSecret(),
    { expiresIn: '1h' },
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
