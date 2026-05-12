/**
 * NewAPI Admin API Client
 *
 * Manages token lifecycle on the upstream NewAPI LLM gateway.
 * All tokens are created under the admin user (NewAPI binds token ownership
 * to the `New-Api-User` header, ignoring body `user_id`).
 * Each Prismer user gets one unlimited-quota token named `prismer_auto_{userId}`.
 * The mapping is cached in-process (10 min TTL).
 *
 * Required env vars (loaded via Nacos):
 *   NEWAPI_BASE_URL       — e.g. http://34.60.178.0:3000
 *   NEWAPI_ADMIN_TOKEN    — root user's access_token
 *   NEWAPI_ADMIN_USER_ID  — root user's numeric id (e.g. "1")
 */

import { ensureNacosConfig } from '@/lib/nacos-config';
import { createModuleLogger } from '@/lib/logger';

const log = createModuleLogger('NewAPIAdmin');

// ============================================================================
// Config helpers (read lazily after Nacos init)
// ============================================================================

function getConfig() {
  const baseUrl = process.env.NEWAPI_BASE_URL;
  const adminToken = process.env.NEWAPI_ADMIN_TOKEN;
  const adminUserId = process.env.NEWAPI_ADMIN_USER_ID;
  if (!baseUrl || !adminToken || !adminUserId) {
    throw new Error('[NewAPIAdmin] Missing required env: NEWAPI_BASE_URL, NEWAPI_ADMIN_TOKEN, NEWAPI_ADMIN_USER_ID');
  }
  return { baseUrl: baseUrl.replace(/\/$/, ''), adminToken, adminUserId };
}

function adminHeaders(): Record<string, string> {
  const { adminToken, adminUserId } = getConfig();
  return {
    'Content-Type': 'application/json',
    Authorization: adminToken,
    'New-Api-User': adminUserId,
  };
}

// ============================================================================
// In-process cache: prismerUserId → newApiTokenKey
// ============================================================================

interface CachedToken {
  key: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function flushNewAPITokenCache(): void {
  tokenCache.clear();
}

// ============================================================================
// Core: resolve a Prismer userId to a NewAPI token key
// ============================================================================

/**
 * Get (or lazily create) a NewAPI token key for the given Prismer user.
 * The token has unlimited quota — billing is handled by Prismer.
 */
export async function resolveNewAPIToken(prismerUserId: string): Promise<string> {
  await ensureNacosConfig();

  const cached = tokenCache.get(prismerUserId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.key;
  }

  const key = await findOrCreateToken(prismerUserId);

  tokenCache.set(prismerUserId, { key, expiresAt: Date.now() + CACHE_TTL_MS });
  return key;
}

// ============================================================================
// NewAPI Admin API calls
// ============================================================================

async function adminFetch(path: string, init?: RequestInit): Promise<Response> {
  const { baseUrl } = getConfig();
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: { ...adminHeaders(), ...init?.headers },
  });
  return res;
}

/**
 * Search for an existing token by name pattern.
 * NewAPI search returns paginated: { data: { items: [...], total } }
 * Token keys in search results are masked — must call /api/token/{id}/key to get full key.
 */
async function findExistingToken(prismerUserId: string): Promise<string | null> {
  const tokenName = `prismer_auto_${prismerUserId}`;
  const res = await adminFetch(`/api/token/search?keyword=${encodeURIComponent(tokenName)}`);
  if (!res.ok) {
    log.warn({ status: res.status }, 'Failed to search NewAPI tokens');
    return null;
  }

  const body = await res.json();
  // Paginated response: { success, data: { items: [...], total } }
  const items = body.data?.items ?? body.data;
  if (!body.success || !Array.isArray(items) || items.length === 0) return null;

  // Exact name match (search is keyword-based, may return partial matches)
  const match = items.find((t: any) => t.name === tokenName);
  if (!match) return null;

  // Fetch the full unmasked key
  return fetchFullTokenKey(match.id);
}

/**
 * Fetch the full unmasked token key by token id.
 * POST /api/token/{id}/key → { success, data: { key } }
 */
async function fetchFullTokenKey(tokenId: number): Promise<string | null> {
  const res = await adminFetch(`/api/token/${tokenId}/key`, { method: 'POST' });
  if (!res.ok) {
    log.warn({ tokenId, status: res.status }, 'Failed to fetch token key');
    return null;
  }
  const body = await res.json();
  if (!body.success) return null;
  return body.data?.key ?? body.data ?? null;
}

/**
 * Create a new unlimited-quota token under the admin user.
 * NewAPI assigns token to the user identified by `New-Api-User` header,
 * ignoring any `user_id` in the request body.
 *
 * Token creation does not return the key — we must list tokens after creation
 * and fetch the key separately.
 */
async function createToken(prismerUserId: string): Promise<string> {
  const tokenName = `prismer_auto_${prismerUserId}`;

  const res = await adminFetch('/api/token/', {
    method: 'POST',
    body: JSON.stringify({
      name: tokenName,
      unlimited_quota: true,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`[NewAPIAdmin] Failed to create token: ${res.status} ${text}`);
  }

  const body = await res.json();
  if (!body.success) {
    throw new Error(`[NewAPIAdmin] Create token failed: ${body.message || JSON.stringify(body)}`);
  }

  log.info({ prismerUserId, tokenName }, 'Created NewAPI token');

  // Token creation doesn't return the key — find and fetch it
  const key = await findExistingToken(prismerUserId);
  if (!key) {
    throw new Error('[NewAPIAdmin] Token created but could not retrieve key');
  }
  return key;
}

/**
 * Orchestrates the full find-or-create flow for a Prismer user.
 */
async function findOrCreateToken(prismerUserId: string): Promise<string> {
  // 1. Try to find existing token
  const existingKey = await findExistingToken(prismerUserId);
  if (existingKey) return existingKey;

  // 2. Create new token
  return createToken(prismerUserId);
}
