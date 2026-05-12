/**
 * Workspace memory ACL helper.
 *
 * Resolves which IMMemoryPage visibility classes a caller may read or write,
 * given a (workspaceId, callerImUserId, callerKind) triple. All A2/A3/A4/A5
 * memory endpoints route ACL through this helper instead of writing per-row
 * `WHERE ownerImUserId = ...` short-circuits, so visibility is the single
 * source of truth for memory access.
 *
 * Brief reference: doc 23 §8 U0a (54-release Memory Line A).
 *
 * Data-model deviation from the brief:
 *   The brief specified
 *     `IMAgentCard WHERE workspaceId=:wid AND ownerImUserId=:caller`
 *   to enumerate delegated agents under an owner. IMAgentCard has no
 *   `ownerImUserId` column — agent ownership is implicit via workspace
 *   ownership. We resolve in two lookups:
 *     1. IMWorkspace WHERE id=:wid AND ownerImUserId=:caller (caller is owner)
 *     2. IMAgentCard WHERE workspaceId=:wid              (delegated agents)
 *   If (1) succeeds the caller is the owner human, and (2) supplies the agent
 *   imUserIds whose `agent:<id>` namespaces the owner is allowed to read.
 */

import prisma from '../db';

const SECRET_REF_VISIBILITY = 'secret-ref';
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_SIZE = 1000;

export interface MemoryAclContext {
  workspaceId: string;
  callerImUserId: string;
  callerKind: 'user' | 'agent';
  /** Exact-match visibility values the caller is allowed to read. */
  allowedVisibilities: string[];
  /**
   * Visibility prefixes the caller is allowed to read via wildcard match
   * (e.g. owner human reads any `task:*`). Per-endpoint Prisma queries that
   * need wildcard support combine `allowedVisibilities` (`{ in: [...] }`) and
   * each prefix (`{ startsWith: prefix }`) under a single `OR` clause.
   */
  allowedVisibilityPrefixes: string[];
  canRead: (page: { visibility: string }) => boolean;
  canWrite: (page: { visibility: string }) => boolean;
}

interface CacheEntry {
  context: MemoryAclContext | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(workspaceId: string, callerImUserId: string, callerKind: string): string {
  return `${workspaceId}|${callerKind}|${callerImUserId}`;
}

function evictExpired(now: number): void {
  for (const [key, entry] of cache.entries()) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  if (cache.size > CACHE_MAX_SIZE) {
    const overflow = cache.size - CACHE_MAX_SIZE;
    let i = 0;
    for (const key of cache.keys()) {
      if (i++ >= overflow) break;
      cache.delete(key);
    }
  }
}

function buildContext(
  workspaceId: string,
  callerImUserId: string,
  callerKind: 'user' | 'agent',
  allowedVisibilities: string[],
  allowedVisibilityPrefixes: string[],
): MemoryAclContext {
  const exact = new Set(allowedVisibilities);
  const check = (page: { visibility: string }) => {
    if (page.visibility === SECRET_REF_VISIBILITY) return false;
    if (exact.has(page.visibility)) return true;
    return allowedVisibilityPrefixes.some((prefix) => page.visibility.startsWith(prefix));
  };
  return {
    workspaceId,
    callerImUserId,
    callerKind,
    allowedVisibilities,
    allowedVisibilityPrefixes,
    canRead: check,
    canWrite: check,
  };
}

async function computeContext(
  workspaceId: string,
  callerImUserId: string,
  callerKind: 'user' | 'agent',
): Promise<MemoryAclContext | null> {
  if (callerKind === 'agent') {
    const card = await prisma.iMAgentCard.findFirst({
      where: { imUserId: callerImUserId, workspaceId },
      select: { imUserId: true },
    });
    if (!card) return null;
    return buildContext(workspaceId, callerImUserId, callerKind, ['workspace', `agent:${callerImUserId}`], []);
  }

  const workspace = await prisma.iMWorkspace.findFirst({
    where: { id: workspaceId, ownerImUserId: callerImUserId, deletedAt: null },
    select: { id: true },
  });
  if (!workspace) return null;

  const delegatedAgents = await prisma.iMAgentCard.findMany({
    where: { workspaceId },
    select: { imUserId: true },
  });

  const allowed = [
    'workspace',
    `human:${callerImUserId}`,
    ...delegatedAgents.map((a: { imUserId: string }) => `agent:${a.imUserId}`),
  ];
  return buildContext(workspaceId, callerImUserId, callerKind, allowed, ['task:']);
}

/**
 * Resolve memory access for a caller in a workspace.
 *
 * Returns `null` when the caller is neither the workspace owner nor a
 * delegated agent of that workspace. Endpoints should treat `null` as
 * 403 Forbidden (or 404 to avoid leaking workspace existence).
 *
 * Performance contract:
 *   - cold path (DB miss + 1-2 indexed lookups): ≤ 20ms
 *   - warm path (LRU hit, TTL ≤ 60s):           ≤ 5ms
 * Visibility shifts (e.g. agent unbound, workspace member added) propagate on
 * the next TTL boundary; callers needing immediate invalidation should use
 * `_clearMemoryAclCache()`.
 */
export async function loadWorkspaceForMemoryAccess(
  workspaceId: string,
  callerImUserId: string,
  callerKind: 'user' | 'agent',
): Promise<MemoryAclContext | null> {
  if (!workspaceId || !callerImUserId) return null;

  const now = Date.now();
  evictExpired(now);

  const key = cacheKey(workspaceId, callerImUserId, callerKind);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) {
    cache.delete(key);
    cache.set(key, cached);
    return cached.context;
  }

  const context = await computeContext(workspaceId, callerImUserId, callerKind);
  cache.set(key, { context, expiresAt: now + CACHE_TTL_MS });
  return context;
}

/** Test-only escape hatch: drop the in-process ACL cache. */
export function _clearMemoryAclCache(): void {
  cache.clear();
}

/** Test-only: cache size for assertions. */
export function _memoryAclCacheSize(): number {
  return cache.size;
}
