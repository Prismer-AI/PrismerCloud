/**
 * Prismer IM — Users API
 */

import { Hono } from 'hono';
import { UserModel } from '../models/user';
import { signToken } from '../auth/jwt';
import { authMiddleware } from '../auth/middleware';
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
      201,
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
    const user = await userModel.findById(jwtUser.sub);
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
        primaryDid: user.primaryDid,
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

    const updated = await userModel.update(jwtUser.sub, {
      displayName,
      avatarUrl,
      metadata,
    });

    return c.json<ApiResponse>({ ok: true, data: updated });
  });

  /**
   * GET /api/users/:id — Get user by ID
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
