/**
 * Prismer IM — Users API
 */

import { Hono } from 'hono';
import { UserModel } from '../models/user';
import { signToken } from '../auth/jwt';
import { authMiddleware } from '../auth/middleware';
import prisma from '../db';
import type { ApiResponse } from '../types/index';

// Simple password hashing (use bcrypt in production)
async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Minimal in-memory sliding-window rate limiter for /lookup.
// Policy: 30 requests / 60s per authenticated imUserId. Returns 429 with
// Retry-After when exceeded. Lookup is an enumeration vector (probes
// email/phone/oauth-id existence), and the IM server runs single-process
// (Hono embedded in the Next.js process, see CLAUDE.md), so a per-process
// Map is sufficient — no Redis dep needed, no cross-pod state to sync.
const LOOKUP_RATE_LIMIT = 30;
const LOOKUP_RATE_WINDOW_MS = 60_000;
const lookupHits = new Map<string, number[]>();

function checkLookupRate(imUserId: string): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  const cutoff = now - LOOKUP_RATE_WINDOW_MS;
  const hits = (lookupHits.get(imUserId) ?? []).filter((t) => t > cutoff);
  if (hits.length >= LOOKUP_RATE_LIMIT) {
    const oldest = hits[0];
    const retryAfterSec = Math.max(1, Math.ceil((oldest + LOOKUP_RATE_WINDOW_MS - now) / 1000));
    // Persist the trimmed array (drop expired entries) without recording this hit.
    lookupHits.set(imUserId, hits);
    return { allowed: false, retryAfterSec };
  }
  hits.push(now);
  lookupHits.set(imUserId, hits);
  // Opportunistic GC — keep the map bounded under burst load. 1% of writes
  // sweep expired entries; cheap and avoids a separate timer.
  if (Math.random() < 0.01) {
    for (const [k, v] of lookupHits) {
      const fresh = v.filter((t) => t > cutoff);
      if (fresh.length === 0) lookupHits.delete(k);
      else if (fresh.length !== v.length) lookupHits.set(k, fresh);
    }
  }
  return { allowed: true, retryAfterSec: 0 };
}

export function createUsersRouter() {
  const router = new Hono();
  const userModel = new UserModel();

  /**
   * POST /api/users/register — Register a new user (human or agent)
   */
  router.post('/register', async (c) => {
    const body = await c.req.json();
    const { username, displayName, password, role, agentType, avatarUrl, metadata, userId } = body;

    if (!username || !displayName) {
      return c.json<ApiResponse>({ ok: false, error: 'username and displayName are required' }, 400);
    }

    // Check uniqueness
    const existing = await userModel.findByUsername(username);
    if (existing) {
      return c.json<ApiResponse>({ ok: false, error: 'Username already taken' }, 409);
    }

    const passwordHash = password ? await hashPassword(password) : undefined;

    const user = await userModel.create({
      username,
      displayName,
      passwordHash,
      role: role ?? 'human',
      agentType: agentType ?? undefined,
      avatarUrl,
      metadata,
      userId, // Link to main User table if provided
    });

    const token = signToken({
      sub: user.id,
      username: user.username,
      role: user.role as any,
      agentType: user.agentType as any,
    });

    return c.json<ApiResponse>(
      {
        ok: true,
        data: {
          user: {
            id: user.id,
            username: user.username,
            displayName: user.displayName,
            role: user.role,
            agentType: user.agentType,
          },
          token,
        },
      },
      201
    );
  });

  /**
   * POST /api/users/login — Login and get JWT
   */
  router.post('/login', async (c) => {
    const body = await c.req.json();
    const { username, password } = body;

    if (!username) {
      return c.json<ApiResponse>({ ok: false, error: 'username is required' }, 400);
    }

    const user = await userModel.findByUsername(username);
    if (!user) {
      return c.json<ApiResponse>({ ok: false, error: 'Invalid credentials' }, 401);
    }

    // Verify password (if set)
    if (user.passwordHash && password) {
      const hash = await hashPassword(password);
      if (hash !== user.passwordHash) {
        return c.json<ApiResponse>({ ok: false, error: 'Invalid credentials' }, 401);
      }
    }

    const token = signToken({
      sub: user.id,
      username: user.username,
      role: user.role as any,
      agentType: user.agentType as any,
    });

    return c.json<ApiResponse>({
      ok: true,
      data: {
        user: {
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          role: user.role,
          agentType: user.agentType,
        },
        token,
      },
    });
  });

  /**
   * GET /api/users/me — Get current user profile
   */
  router.get('/me', authMiddleware, async (c) => {
    const jwtUser = c.get('user');
    // Browser platform JWTs can be translated by /api/im into an
    // api_key_proxy-style IM token whose `sub` is the numeric cloud user id.
    // authMiddleware resolves the actual IM user id onto `imUserId`; use it
    // for self-profile reads so the workspace UI can identify "my" messages.
    const user = await userModel.findById(jwtUser.imUserId);
    if (!user) {
      return c.json<ApiResponse>({ ok: false, error: 'User not found' }, 404);
    }

    return c.json<ApiResponse>({
      ok: true,
      data: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        agentType: user.agentType,
        avatarUrl: user.avatarUrl,
        metadata: user.metadata ? JSON.parse(user.metadata) : {},
        createdAt: user.createdAt,
      },
    });
  });

  /**
   * PATCH /api/users/me — Update current user profile
   */
  router.patch('/me', authMiddleware, async (c) => {
    const jwtUser = c.get('user');
    const body = await c.req.json();
    const { displayName, avatarUrl, metadata } = body;

    const updated = await userModel.update(jwtUser.imUserId, {
      displayName,
      avatarUrl,
      metadata,
    });

    // Strip BigInt fields (numericId) that JSON.stringify cannot serialize.
    // Prisma returns the full model on update, which includes numericId as
    // a BigInt — Hono's c.json calls JSON.stringify and throws on BigInt.
    const { numericId: _numericId, ...safeData } = updated || {};
    return c.json<ApiResponse>({ ok: true, data: safeData as Record<string, unknown> });
  });

  /**
   * GET /api/users/by-username/:username — Look up user by username (auth-gated
   * to prevent enumeration). Mirrors GET /:id response shape so callers can
   * treat both lookups interchangeably.
   *
   * Registered BEFORE /:id so the static prefix wins regardless of Hono's
   * router resolution order — defensive against future router changes.
   */
  router.get('/by-username/:username', authMiddleware, async (c) => {
    const username = c.req.param('username');
    const user = await userModel.findByUsername(username);
    if (!user) {
      return c.json<ApiResponse>({ ok: false, error: 'User not found' }, 404);
    }

    return c.json<ApiResponse>({
      ok: true,
      data: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        agentType: user.agentType,
        avatarUrl: user.avatarUrl,
        createdAt: user.createdAt,
      },
    });
  });

  /**
   * GET /api/users/lookup?identifier=...
   *
   * Unified contact lookup that probes any registration dimension the user
   * might know about a person: username, email, phone (E.164), Google/GitHub/
   * Apple/Twitter OAuth id, numeric id, or DID. ALWAYS scoped to humans —
   * workspace contact search must never surface external agents, and agents
   * have per-workspace-unique usernames (not globally unique) so an
   * unscoped lookup by username could return non-deterministic results
   * (schema note: prisma/schema.prisma:30).
   *
   * Rate-limited per imUserId (see LOOKUP_RATE_LIMIT above) to blunt the
   * enumeration vector — any authenticated user can otherwise probe whether
   * an email / phone / oauth-id is registered.
   *
   * Registered BEFORE /:id so the static prefix wins regardless of Hono's
   * router resolution order.
   */
  router.get('/lookup', authMiddleware, async (c) => {
    const jwtUser = c.get('user');
    const rate = checkLookupRate(jwtUser.imUserId);
    if (!rate.allowed) {
      c.header('Retry-After', String(rate.retryAfterSec));
      return c.json<ApiResponse>(
        {
          ok: false,
          error: `Rate limit exceeded. Limit: ${LOOKUP_RATE_LIMIT}/min. Retry in ${rate.retryAfterSec}s.`,
        },
        429,
      );
    }

    const raw = (c.req.query('identifier') ?? '').trim();
    if (!raw) {
      return c.json<ApiResponse>({ ok: false, error: 'identifier is required' }, 400);
    }

    const identifier = raw.replace(/^@/, '');

    // Build the OR clause based on what shape the identifier looks like.
    // Email is handled separately below via a case-insensitive raw query —
    // see comment there for why neither toLowerCase() on the query side nor
    // Prisma `mode: 'insensitive'` is acceptable.
    const conditions: any[] = [
      { username: identifier },
      { googleId: identifier },
      { githubId: identifier },
      { appleId: identifier },
      { twitterId: identifier },
    ];

    if (/^\+?[0-9 \-().]{6,}$/.test(identifier)) {
      const e164 = identifier.replace(/[^\d+]/g, '');
      conditions.push({ phone: e164 });
    }

    if (/^\d+$/.test(identifier)) {
      const n = parseInt(identifier, 10);
      if (Number.isFinite(n) && n > 0) conditions.push({ numericId: n });
    }

    if (identifier.startsWith('did:')) {
      conditions.push({ primaryDid: identifier });
    }

    let user = await prisma.iMUser.findFirst({ where: { OR: conditions, role: 'human' } });

    // Email — case-insensitive match on both engines.
    //
    // Constraints:
    //  - Emails are NOT normalized at write time anywhere (grep
    //    `email.*toLowerCase` confirms — only the JWT admin check lowercases).
    //    So stored values can be `Alice@Example.com`.
    //  - Searchers can type any casing: `alice@example.com`, `ALICE@EXAMPLE.COM`,
    //    `Alice@Example.com`. The OR-both-casings trick (`identifier` OR
    //    `identifier.toLowerCase()`) misses the all-caps case AND any mixed
    //    casing the searcher didn't happen to match.
    //  - Prisma `mode: 'insensitive'` is unsupported on the SQLite client
    //    (dev DB per prisma/schema.prisma:20).
    //  - MySQL with default `utf8mb4_*_ci` collation already matches `=`
    //    case-insensitively, but we cannot rely on that for SQLite.
    //
    // Cross-engine solution: a single `$queryRaw` with `LOWER(email) = LOWER(?)`.
    // Both engines support LOWER() and tagged-template raw queries.
    if (!user && identifier.includes('@')) {
      const rows = await prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM im_users
        WHERE LOWER(email) = LOWER(${identifier})
          AND role = 'human'
        LIMIT 1
      `;
      if (rows[0]) {
        user = await prisma.iMUser.findUnique({ where: { id: rows[0].id } });
      }
    }

    if (!user) {
      return c.json<ApiResponse>({ ok: false, error: 'User not found' }, 404);
    }

    return c.json<ApiResponse>({
      ok: true,
      data: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        agentType: user.agentType,
        avatarUrl: user.avatarUrl,
        createdAt: user.createdAt,
      },
    });
  });

  /**
   * GET /api/users/:id — Get user by ID
   *
   * Declared AFTER /lookup and /by-username/:username so the static prefixes
   * are not shadowed by this dynamic segment.
   */
  router.get('/:id', authMiddleware, async (c) => {
    const userId = c.req.param('id');
    const user = await userModel.findById(userId);
    if (!user) {
      return c.json<ApiResponse>({ ok: false, error: 'User not found' }, 404);
    }

    return c.json<ApiResponse>({
      ok: true,
      data: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        agentType: user.agentType,
        avatarUrl: user.avatarUrl,
        createdAt: user.createdAt,
      },
    });
  });

  return router;
}
