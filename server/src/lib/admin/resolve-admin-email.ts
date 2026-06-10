/**
 * resolveAdminEmail — unified email resolution for `/api/sandboxes/_admin/*` routes.
 *
 * Mirrors the pattern from `sandbox-metrics/route.ts`:
 *   1. Prefer the NextAuth session (browser cookies, OAuth flows)
 *   2. Fall back to `requireAuthIdentity` which unwraps Bearer JWT or API key
 *
 * Without step 2, API-key callers (the CLI scaffolding, cross-env automation)
 * land at the handler with `session` = null, so `isSandboxAdmin(undefined)`
 * relies on the dev short-circuit and the audit log records `admin=null`.
 * That's wrong observability in dev and a hard 403 in prod for the same call.
 *
 * ## Bearer cache (added 2026-05-24)
 *
 * The Bearer path bcrypt-verifies the API key against `pc_api_keys.tokenHash`
 * on every call. `debug-bundle` fans out 4 HTTP loopback calls per invocation,
 * so one user-facing call = 5× bcrypt = ~0.5s baseline overhead on warm boxes.
 * Process-local LRU caches `sha256(authHeader) → { email, expiresAt }` with
 * a 60s TTL — short enough that revoked keys propagate within a minute, long
 * enough that a single CLI command never re-verifies.
 *
 * Returns null if neither path yields an email — callers should treat null as
 * "anonymous", let `isSandboxAdmin` decide whether to allow (dev short-circuit
 * still applies), and emit the audit log line either way.
 */

import { auth } from '@/lib/auth/nextauth';
import { requireAuthIdentity } from '@/lib/auth/guard';
import type { NextRequest } from 'next/server';
import { createHash } from 'node:crypto';

const BEARER_TTL_MS = 60_000;
const BEARER_CACHE_MAX = 256;

interface BearerCacheEntry {
  email: string | null;
  expiresAt: number;
}

const bearerCache = new Map<string, BearerCacheEntry>();

function hashBearer(header: string): string {
  return createHash('sha256').update(header).digest('hex');
}

function readCache(key: string): string | null | undefined {
  const entry = bearerCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    bearerCache.delete(key);
    return undefined;
  }
  // Refresh LRU position.
  bearerCache.delete(key);
  bearerCache.set(key, entry);
  return entry.email;
}

function writeCache(key: string, email: string | null): void {
  if (bearerCache.size >= BEARER_CACHE_MAX) {
    // Evict the oldest (Map iterates insertion order).
    const oldest = bearerCache.keys().next().value;
    if (oldest !== undefined) bearerCache.delete(oldest);
  }
  bearerCache.set(key, { email, expiresAt: Date.now() + BEARER_TTL_MS });
}

export async function resolveAdminEmail(req: NextRequest): Promise<string | null> {
  const session = await auth();
  if (session?.user?.email) return session.user.email;

  const authHeader = req.headers.get('authorization');
  const cacheKey = authHeader ? hashBearer(authHeader) : null;
  if (cacheKey) {
    const cached = readCache(cacheKey);
    if (cached !== undefined) return cached;
  }

  let email: string | null = null;
  try {
    const identity = await requireAuthIdentity(req);
    email = identity.email ?? null;
  } catch {
    email = null;
  }

  if (cacheKey) writeCache(cacheKey, email);
  return email;
}

/** Test-only: reset the bearer cache between unit tests. */
export function __resetResolveAdminEmailCache(): void {
  bearerCache.clear();
}
