/**
 * Prismer IM — Agent Self-Registration & Token Management
 *
 * Agents register autonomously with just an API Key.
 * Humans are auto-registered on first API Key usage (no explicit call needed).
 *
 * POST /api/im/register    — Register Agent/Human identity
 * POST /api/im/token/refresh — Refresh JWT token
 */

import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { authMiddleware } from '../auth/middleware';
import { signToken, verifyToken, decodeToken } from '../auth/jwt';
import prisma from '../db';
import type { ApiResponse, RegisterInput, RegisterResult } from '../types/index';
import { generateIMUserId } from '../utils/id-gen';
import type { EvolutionService } from '../services/evolution.service';
import type { RateLimiterService } from '../services/rate-limiter.service';
import { createRateLimitMiddleware } from '../middleware/rate-limit';

const USERNAME_REGEX = /^[a-zA-Z0-9_-]{3,32}$/;

/**
 * Optional auth middleware — sets user if valid token present, skips if not.
 *
 * For API Key proxy tokens: stores cloudUserId (does NOT auto-create IM user).
 * For direct JWT tokens: stores imUserId as before.
 */
async function optionalAuthMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    // No auth — proceed without user (anonymous registration)
    await next();
    return;
  }

  // Try to verify token
  const token = authHeader.slice(7);
  try {
    const payload = verifyToken(token);

    if (payload.type === 'api_key_proxy') {
      // API Key proxy: store cloudUserId for multi-agent lookup in handler
      c.set('user', { ...payload, cloudUserId: payload.sub } as any);
    } else {
      // Direct JWT: sub is already IM User ID
      c.set('user', { ...payload, imUserId: payload.sub } as any);
    }
  } catch {
    // Invalid token — proceed as anonymous
  }
  await next();
}

export function createRegisterRouter(evolutionService?: EvolutionService, rateLimiter?: RateLimiterService) {
  const router = new Hono();

  /**
   * POST /register — Agent/Human self-registration
   *
   * Auth is optional:
   * - With API Key: agent bound to human, credits from human's pool
   * - Without auth: anonymous self-registration, agent gets 100000 credits (≈100M messages)
   */
  router.use('/register', optionalAuthMiddleware);
  if (rateLimiter) {
    router.post('/register', createRateLimitMiddleware(rateLimiter, 'agent.register'));
  }
  router.post('/register', async (c) => {
    const user = c.get('user') as any | undefined;

    let body: RegisterInput;
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Invalid JSON body' }, 400);
    }

    const {
      type,
      username,
      displayName,
      agentType,
      capabilities,
      description,
      endpoint,
      webhookSecret,
      metadata: inputMetadata,
    } = body;

    // Validate type
    if (!type || !['agent', 'human'].includes(type)) {
      return c.json<ApiResponse>({ ok: false, error: 'type must be "agent" or "human"' }, 400);
    }

    // Validate username
    if (!username) {
      return c.json<ApiResponse>({ ok: false, error: 'username is required' }, 400);
    }
    if (!USERNAME_REGEX.test(username)) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: 'username must be 3-32 characters, alphanumeric, underscore, or hyphen',
        },
        400,
      );
    }

    // Validate displayName
    if (!displayName) {
      return c.json<ApiResponse>({ ok: false, error: 'displayName is required' }, 400);
    }

    // Validate agentType for agents
    const validAgentTypes = ['assistant', 'specialist', 'orchestrator', 'tool', 'bot'];
    if (type === 'agent' && agentType && !validAgentTypes.includes(agentType)) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: `agentType must be one of: ${validAgentTypes.join(', ')}`,
        },
        400,
      );
    }

    // Find existing user:
    // - API Key (cloudUserId): look up by (cloudUserId, username) — allows multi-agent
    // - Direct JWT (imUserId): look up by IM User ID
    // - Anonymous: look up by username only
    const cloudUserId = user?.cloudUserId as string | undefined;
    let existingUser: any = null;

    if (cloudUserId) {
      // API Key user: find agent with same (cloudUserId, username)
      existingUser = await prisma.iMUser.findFirst({
        where: { userId: cloudUserId, username },
        include: { agentCard: true },
      });
    } else if (user?.imUserId) {
      // Direct JWT user: find by IM User ID
      existingUser = await prisma.iMUser.findUnique({
        where: { id: user.imUserId },
        include: { agentCard: true },
      });
    }

    // Check username uniqueness (only reject if held by a DIFFERENT identity)
    const usernameHolder = await prisma.iMUser.findUnique({
      where: { username },
    });
    if (usernameHolder) {
      const isOwnUser = existingUser && usernameHolder.id === existingUser.id;
      const isOwnCloudUser = cloudUserId && usernameHolder.userId === cloudUserId;
      if (!isOwnUser && !isOwnCloudUser) {
        return c.json<ApiResponse>(
          {
            ok: false,
            error: `Username '${username}' is already taken`,
          },
          409,
        );
      }
      // If username is held by same cloud user but different agent, allow (it's updating)
      if (isOwnCloudUser && !existingUser) {
        existingUser = await prisma.iMUser.findUnique({
          where: { id: usernameHolder.id },
          include: { agentCard: true },
        });
      }
    }

    let isNew = false;
    let imUserId: string;

    // Build agent metadata: merge caller-provided metadata + webhookSecret
    const buildMetadata = (existing?: string | null) => {
      const base = existing ? JSON.parse(existing) : {};
      if (inputMetadata && typeof inputMetadata === 'object') {
        Object.assign(base, inputMetadata);
      }
      if (webhookSecret !== undefined) base.webhookSecret = webhookSecret;
      return JSON.stringify(base);
    };

    if (existingUser) {
      // Update existing user
      await prisma.iMUser.update({
        where: { id: existingUser.id },
        data: {
          username,
          displayName,
          role: type === 'agent' ? 'agent' : 'human',
          agentType: type === 'agent' ? (agentType ?? 'assistant') : null,
        },
      });
      imUserId = existingUser.id;

      // Update or create AgentCard for agents
      if (type === 'agent') {
        if (existingUser.agentCard) {
          await prisma.iMAgentCard.update({
            where: { imUserId: existingUser.id },
            data: {
              name: username,
              description: description ?? existingUser.agentCard.description,
              agentType: agentType ?? 'assistant',
              capabilities: JSON.stringify(capabilities ?? []),
              endpoint: endpoint ?? existingUser.agentCard.endpoint,
              metadata: buildMetadata(existingUser.agentCard.metadata),
              status: 'online',
            },
          });
        } else {
          await prisma.iMAgentCard.create({
            data: {
              imUserId: existingUser.id,
              name: username,
              description: description ?? '',
              agentType: agentType ?? 'assistant',
              capabilities: JSON.stringify(capabilities ?? []),
              endpoint: endpoint ?? null,
              metadata: buildMetadata(),
              status: 'online',
            },
          });
          // Seed evolution genes for newly created agent card
          evolutionService?.seedGenesForNewAgent(existingUser.id).catch(() => {});
        }
      }
    } else {
      // Create new user — link to cloud user if API Key auth present
      const role = type === 'agent' ? 'agent' : 'human';
      const newUser = await prisma.iMUser.create({
        data: {
          id: generateIMUserId(role),
          username,
          displayName,
          role,
          agentType: type === 'agent' ? (agentType ?? 'assistant') : null,
          userId: cloudUserId ?? undefined,
          metadata: JSON.stringify({ registeredVia: 'register_api', createdAt: new Date().toISOString() }),
        },
      });
      imUserId = newUser.id;
      isNew = true;

      // Create AgentCard for agents
      if (type === 'agent') {
        await prisma.iMAgentCard.create({
          data: {
            imUserId: newUser.id,
            name: username,
            description: description ?? '',
            agentType: agentType ?? 'assistant',
            capabilities: JSON.stringify(capabilities ?? []),
            endpoint: endpoint ?? null,
            metadata: buildMetadata(),
            status: 'online',
          },
        });
        // Seed evolution genes for new agent
        evolutionService?.seedGenesForNewAgent(newUser.id).catch(() => {});

        // Auto-create human owner record if not exists (for owner profile / contributor board)
        if (cloudUserId) {
          const hasOwner = await prisma.iMUser.findFirst({
            where: { userId: cloudUserId, role: 'human' },
            select: { id: true },
          });
          if (!hasOwner) {
            const ownerUsername = `user-${cloudUserId.slice(0, 8)}`;
            const existing = await prisma.iMUser.findUnique({ where: { username: ownerUsername } });
            if (!existing) {
              await prisma.iMUser.create({
                data: {
                  id: generateIMUserId('human'),
                  username: ownerUsername,
                  displayName: displayName,
                  role: 'human',
                  userId: cloudUserId,
                },
              }).catch(() => {});
            }
          }
        }
      }
    }

    // If the existing user was auto-created as 'human' but registering as 'agent', it's a new registration
    if (existingUser && existingUser.role === 'human' && type === 'agent') {
      isNew = true;
    }

    // AIP: Lookup DID for JWT claims (only non-revoked keys)
    const identityKey = await prisma.iMIdentityKey.findFirst({
      where: { imUserId, revokedAt: null },
      select: { didKey: true },
    });
    const userRecord = await prisma.iMUser.findUnique({
      where: { id: imUserId },
      select: { delegatedBy: true },
    });

    // Sign new JWT token (with AIP DID claims if available)
    const token = signToken({
      sub: imUserId,
      username,
      role: type === 'agent' ? 'agent' : 'human',
      agentType: type === 'agent' ? ((agentType as any) ?? 'assistant') : undefined,
      did: identityKey?.didKey ?? undefined,
      delegatedBy: userRecord?.delegatedBy ?? undefined,
    });

    const result: RegisterResult = {
      imUserId,
      username,
      displayName,
      role: type === 'agent' ? 'agent' : 'human',
      token,
      expiresIn: '7d',
      capabilities: type === 'agent' ? (capabilities ?? []) : undefined,
      isNew,
    };

    return c.json<ApiResponse<RegisterResult>>(
      {
        ok: true,
        data: result,
      },
      isNew ? 201 : 200,
    );
  });

  return router;
}

export function createTokenRouter() {
  const router = new Hono();

  /**
   * POST /token/refresh — Refresh JWT token
   */
  router.post('/refresh', async (c) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json<ApiResponse>({ ok: false, error: 'Missing Authorization header' }, 401);
    }

    const token = authHeader.slice(7);

    // Try to verify (valid token)
    let payload;
    try {
      payload = verifyToken(token);
    } catch {
      // Try to decode (expired token — allow refresh within grace period)
      payload = decodeToken(token);
      if (!payload) {
        return c.json<ApiResponse>({ ok: false, error: 'Invalid token' }, 401);
      }
    }

    // Verify user still exists
    const user = await prisma.iMUser.findUnique({ where: { id: payload.sub } });
    if (!user) {
      return c.json<ApiResponse>({ ok: false, error: 'User not found' }, 404);
    }

    // AIP: Lookup DID for refreshed token (only non-revoked keys)
    const refreshIdentityKey = await prisma.iMIdentityKey.findFirst({
      where: { imUserId: user.id, revokedAt: null },
      select: { didKey: true },
    });

    // Sign new token (with AIP DID claims)
    const newToken = signToken({
      sub: user.id,
      username: user.username,
      role: user.role as any,
      agentType: (user.agentType as any) ?? undefined,
      did: refreshIdentityKey?.didKey ?? undefined,
      delegatedBy: user.delegatedBy ?? undefined,
    });

    return c.json<ApiResponse>({
      ok: true,
      data: {
        token: newToken,
        expiresIn: '7d',
      },
    });
  });

  return router;
}
