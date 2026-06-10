import { Hono, type Context, type Next } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authUser: {
    sub: '12345',
    username: 'numeric-cloud-user',
    role: 'system',
    type: 'api_key_proxy',
    imUserId: 'imu-human-1',
    trustTier: 0,
  },
  findById: vi.fn(),
  update: vi.fn(),
}));

vi.mock('../auth/middleware', () => ({
  authMiddleware: async (c: Context, next: Next) => {
    c.set('user', mocks.authUser);
    await next();
  },
}));

vi.mock('../models/user', () => ({
  UserModel: vi.fn().mockImplementation(() => ({
    findById: mocks.findById,
    update: mocks.update,
  })),
}));

vi.mock('../db', () => ({ default: {} }));

import { createUsersRouter } from '../api/users';

function app() {
  const h = new Hono();
  h.route('/users', createUsersRouter());
  return h;
}

describe('/users/me resolved IM identity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authUser = {
      sub: '12345',
      username: 'numeric-cloud-user',
      role: 'system',
      type: 'api_key_proxy',
      imUserId: 'imu-human-1',
      trustTier: 0,
    };
  });

  it('reads the resolved imUserId instead of proxy token sub', async () => {
    mocks.findById.mockResolvedValue({
      id: 'imu-human-1',
      username: 'owner',
      displayName: 'Owner',
      role: 'human',
      agentType: null,
      avatarUrl: null,
      primaryDid: null,
      metadata: null,
      createdAt: new Date('2026-05-22T00:00:00Z'),
    });

    const res = await app().request('/users/me', { headers: { Authorization: 'Bearer test' } });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mocks.findById).toHaveBeenCalledWith('imu-human-1');
    expect(mocks.findById).not.toHaveBeenCalledWith('12345');
    expect(body.data.id).toBe('imu-human-1');
  });

  it('patches the resolved imUserId instead of proxy token sub', async () => {
    mocks.update.mockResolvedValue({
      id: 'imu-human-1',
      username: 'owner',
      displayName: 'Owner Updated',
      role: 'human',
      agentType: null,
      avatarUrl: null,
      primaryDid: null,
      metadata: null,
      createdAt: new Date('2026-05-22T00:00:00Z'),
      numericId: BigInt(1),
    });

    const res = await app().request('/users/me', {
      method: 'PATCH',
      headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Owner Updated' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith('imu-human-1', {
      displayName: 'Owner Updated',
      avatarUrl: undefined,
      metadata: undefined,
    });
    expect(mocks.update).not.toHaveBeenCalledWith('12345', expect.anything());
    expect(body.data.id).toBe('imu-human-1');
    expect(body.data.numericId).toBeUndefined();
  });
});
