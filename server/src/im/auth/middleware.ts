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
 * Bug Z2 — IMUser.id cuid shape (Prisma `@default(cuid())`). When the JWT's
 * sub matches this, it IS the IMUser.id; skip the numericId-based
 * ensureIMUser path to avoid minting phantom IMUsers on backfill misses.
 * Mirrors `IM_CUID_RE` in src/lib/api-guard.ts; kept in sync manually.
 */
const IM_CUID_RE = /^cmp[a-z0-9]{20,}$/;

class AgentProxyResolutionError extends Error {
  constructor(
    message: string,
    public readonly status: 403 | 404 = 404,
    public readonly code = 'AGENT_PROXY_NOT_FOUND',
  ) {
    super(message);
    this.name = 'AgentProxyResolutionError';
  }
}

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
    /**
     * release201/30 §7 — request trace id, stamped by `traceIdMiddleware`
     * BEFORE auth. Optional in the type because some test harnesses skip
     * the middleware chain entirely; production routes always have it.
     */
    traceId?: string;
    /** v1.8.0 — request id stamped by `requestIdMiddleware`. */
    requestId?: string;
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
export async function ensureDefaultWorkspace(imUserId: string): Promise<void> {
  const ws = await prisma.iMWorkspace.findFirst({
    where: { ownerImUserId: imUserId, isDefault: true, deletedAt: null },
    select: { id: true },
  });
  if (!ws) {
    try {
      // Bug Z1 (v2.0.7 R3.E cookbook real-run): auto-create 路径必须与
      // POST /workspaces handler (api/workspaces.ts:190) 保持同样的原子语义 —
      // workspace + owner 的 im_workspace_members 行同事务写入。否则 owner
      // GET /workspaces/<id>/members 返 [] / 404，POST /tasks 被
      // task-permission.ts NotWorkspaceMemberError 拒 (403)。
      // M444 backfill 只覆盖 backfill 当时存在的历史 row；新建路径必须各自负责。
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- interactive tx client typing matches workspace-member.service pattern
      await prisma.$transaction(async (tx: any) => {
        const newWs = await tx.iMWorkspace.create({
          data: {
            ownerImUserId: imUserId,
            name: 'Personal',
            slug: `personal-${imUserId.slice(-6)}`,
            isDefault: true,
          },
        });
        await tx.iMWorkspaceMember.create({
          data: {
            workspaceId: newWs.id,
            memberImUserId: imUserId,
            role: 'owner',
          },
        });
      });
      console.log(`[Auth] Auto-created default workspace + owner member for IM User ${imUserId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('Unique') && !msg.includes('UNIQUE')) {
        console.error(`[Auth] Failed to create default workspace for ${imUserId}: ${msg}`);
      }
    }
  }
}

function activeUserWhere() {
  return {
    banned: false,
    OR: [{ suspendedUntil: null }, { suspendedUntil: { lte: new Date() } }],
  };
}

// release202/08 — shared owner-resolution clause. API-key auth derives
// `cloudUserId` from `pc_api_keys.user_id` (bigint = im_users.numericId), so a
// bare `{ userId: cloudUserId }` lookup MISSES every account whose
// `im_users.userId` was never backfilled to that numeric string. Callers that
// resolve "the IMUser owning this cloud user" (auth middleware, register.ts,
// …) MUST use this so they match on userId OR numericId — otherwise agent
// registration / owner-workspace resolution fails for those accounts.
export function cloudOwnerWhere(cloudUserId: string) {
  const clauses: any[] = [{ userId: cloudUserId }];
  if (/^\d+$/.test(cloudUserId)) {
    try {
      clauses.push({ numericId: BigInt(cloudUserId) });
    } catch {
      // Ignore malformed BigInt input; the userId clause remains valid.
    }
  }
  return clauses;
}

/**
 * Inverse of {@link cloudOwnerWhere}: given an already-resolved owner row,
 * return the numericId-aware identity key set used to check whether an agent's
 * `userId` belongs to that owner. api-key register sets the agent's
 * `userId = cloudUserId` (= numericId string) while the human owner may carry
 * `userId = null` with only `numericId` set, so the agent's userId must be
 * matched against BOTH the owner's `userId` and `String(numericId)`.
 */
export function ownerIdentityKeys(owner: {
  userId?: string | null;
  numericId?: bigint | number | null;
}): Set<string> {
  const keys = new Set<string>();
  if (owner.userId) keys.add(owner.userId);
  if (owner.numericId != null) keys.add(String(owner.numericId));
  return keys;
}

async function ensureIMUser(
  cloudUserId: string,
  username: string,
  agentHint?: string,
  workspaceId?: string,
): Promise<string> {
  const ownerClauses = cloudOwnerWhere(cloudUserId);

  // 1. If agent hint provided, find the active agent owned by this API-key
  // account. Scope by workspace when the daemon provides it so repeated simple
  // create/reset flows cannot resolve an older banned same-name agent.
  if (agentHint) {
    // release202/09 §3.6 — owner bridge. api-key auth derives `cloudUserId`
    // from `pc_api_keys.user_id` (= the human's numericId, e.g. 2916), but
    // agent registration wrote `agent.userId` = the human's `userId` field
    // (e.g. 909600419), which can diverge from numericId. `cloudOwnerWhere`
    // alone (`[{userId:'2916'},{numericId:2916}]`) then misses the agent.
    // Resolve the human owner once and UNION its full identity key set
    // (`{'909600419','2916'}`) into the agent-ownership clause so a
    // legitimately-owned-but-diverged agent matches. Additive only: the
    // original `cloudOwnerWhere` clauses are preserved; same-source accounts
    // (userId == numericId, or no owner found) behave exactly as before.
    const agentOwnerClauses: any[] = [...ownerClauses];
    const owner = await findCloudHumanOwner(cloudUserId);
    if (owner) {
      const ownerKeys = [...ownerIdentityKeys(owner)];
      if (ownerKeys.length > 0) {
        agentOwnerClauses.push({ userId: { in: ownerKeys } });
      }
    }

    const baseWhere = {
      username: agentHint,
      role: 'agent',
      ...activeUserWhere(),
      AND: [{ OR: agentOwnerClauses }],
    };
    const agent = await prisma.iMUser.findFirst({
      where: {
        ...baseWhere,
        ...(workspaceId ? { agentCard: { is: { workspaceId } } } : { agentCard: { isNot: null } }),
      },
      orderBy: { updatedAt: 'desc' },
    });
    if (agent) return agent.id;

    if (!workspaceId) {
      const fallbackAgent = await prisma.iMUser.findFirst({
        where: baseWhere,
        orderBy: { updatedAt: 'desc' },
      });
      if (fallbackAgent) return fallbackAgent.id;
    }

    if (workspaceId) {
      // Reuse the owner resolved above for the owner-bridge (§3.6); the
      // workspace-proxy sub-step only needs `owner.id`.
      if (owner && (await canUseWorkspaceAgentProxy(owner.id, workspaceId))) {
        const workspaceAgent = await prisma.iMUser.findFirst({
          where: {
            username: agentHint,
            role: 'agent',
            ...activeUserWhere(),
            agentCard: { is: { workspaceId } },
          },
          orderBy: { updatedAt: 'desc' },
        });
        if (workspaceAgent) return workspaceAgent.id;
      }
    }

    throw new AgentProxyResolutionError(
      `Agent '${agentHint}' is not active for this API key${workspaceId ? ` in workspace ${workspaceId}` : ''}`,
    );
  }

  // 2. Prefer the human IMUser for this Cloud User. Workspaces are owned by
  // humans, so binding to an agent imuser would surface a "no workspace
  // found" error on every workspace API call. Multi-agent routing uses the
  // X-IM-Agent header (handled above), not the createdAt ordering.
  let imUser = await prisma.iMUser.findFirst({
    where: { role: 'human', AND: [{ OR: ownerClauses }] },
    orderBy: { createdAt: 'asc' },
  });
  if (!imUser) {
    // Fall back to any IMUser (legacy data without role split, or pre-1.9.x rows)
    imUser = await prisma.iMUser.findFirst({
      where: { AND: [{ OR: ownerClauses }] },
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
      imUser = await prisma.iMUser.findFirst({ where: { numericId, role: 'human' }, orderBy: { createdAt: 'asc' } });
      if (!imUser) imUser = await prisma.iMUser.findFirst({ where: { numericId }, orderBy: { createdAt: 'asc' } });
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

// release202/09 §3.6 — `userId`/`numericId` are now selected (in addition to
// `id`) so the agentHint owner-bridge can derive `ownerIdentityKeys(owner)` and
// match agents whose `userId` diverges from the api-key-derived `cloudUserId`
// (the winshare 2916 ↔ 909600419 divergence). The workspace-proxy caller only
// reads `.id`, so the extra fields are additive and harmless there.
async function findCloudHumanOwner(
  cloudUserId: string,
): Promise<{ id: string; userId: string | null; numericId: bigint | null } | null> {
  const ownerClauses = cloudOwnerWhere(cloudUserId);
  let owner = await prisma.iMUser.findFirst({
    where: { role: 'human', AND: [{ OR: ownerClauses }] },
    select: { id: true, userId: true, numericId: true },
    orderBy: { createdAt: 'asc' },
  });
  if (owner) return owner;

  owner = await prisma.iMUser.findFirst({
    where: { AND: [{ OR: ownerClauses }] },
    select: { id: true, userId: true, numericId: true },
    orderBy: { createdAt: 'asc' },
  });
  return owner;
}

async function canUseWorkspaceAgentProxy(ownerImUserId: string, workspaceId: string): Promise<boolean> {
  const workspace = await prisma.iMWorkspace.findFirst({
    where: {
      id: workspaceId,
      deletedAt: null,
      OR: [
        { ownerImUserId },
        {
          members: {
            some: {
              memberImUserId: ownerImUserId,
              role: { in: ['owner', 'admin'] },
            },
          },
        },
      ],
    },
    select: { id: true },
  });
  return Boolean(workspace);
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
      const workspaceId = c.req.header('X-IM-Workspace') || undefined;

      // Bug Z2 (v2.0.7) — if the api_key_proxy token carries a cuid-shape
      // sub (= IMUser.id), trust it directly: the IM proxy route mints
      // these for upstream JWTs that already identified an IMUser. Falling
      // through to ensureIMUser would re-resolve by numericId and mint a
      // phantom IMUser when the cloudUserId↔numericId backfill is missing
      // (the invite-accept regression). The legacy api_key (sk-prismer-*)
      // flow passes a numeric `sub` (pc_users.id) and still goes through
      // ensureIMUser unchanged.
      if (IM_CUID_RE.test(payload.sub)) {
        const direct = await prisma.iMUser.findUnique({
          where: { id: payload.sub },
          select: { id: true },
        });
        if (direct) {
          imUserId = direct.id;
        } else {
          // Fall back: cuid was stale / not in DB — let ensureIMUser run
          // the legacy numericId resolution + auto-create path.
          imUserId = await ensureIMUser(payload.sub, payload.username, agentHint, workspaceId);
        }
      } else {
        imUserId = await ensureIMUser(payload.sub, payload.username, agentHint, workspaceId);
      }
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
    if (err instanceof AgentProxyResolutionError) {
      return c.json({ ok: false, error: { code: err.code, message: err.message } }, err.status);
    }
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
