/**
 * Prismer IM — Conversation Security API
 *
 * P2.1: Encryption mode management (none/available/required)
 * P2.2: ECDH key exchange assistance (server stores public keys only)
 */

import { Hono } from 'hono';
import { authMiddleware } from '../auth/middleware';
import type { ApiResponse } from '../types/index';
import prisma from '../db';

async function isParticipant(conversationId: string, imUserId: string): Promise<boolean> {
  const p = await prisma.iMParticipant.findFirst({
    where: { conversationId, imUserId, leftAt: null },
  });
  return !!p;
}

export function createSecurityRouter() {
  const router = new Hono();
  router.use('*', authMiddleware);

  /**
   * GET /api/conversations/:id/security — Get security settings
   */
  router.get('/:id/security', async (c) => {
    const user = c.get('user');
    const conversationId = c.req.param('id')!;
    if (!(await isParticipant(conversationId, user.imUserId))) {
      return c.json<ApiResponse>({ ok: false, error: 'Not a participant' }, 403);
    }
    const security = await prisma.iMConversationSecurity.findUnique({
      where: { conversationId },
    });
    if (!security) {
      return c.json<ApiResponse>({
        ok: true,
        data: { conversationId, signingPolicy: 'recommended', encryptionMode: 'none', keys: [] },
      });
    }
    return c.json<ApiResponse>({
      ok: true,
      data: {
        conversationId,
        signingPolicy: security.signingPolicy,
        encryptionMode: security.encryptionMode,
        keys: JSON.parse(security.ephemeralKeys || '[]'),
      },
    });
  });

  /**
   * PATCH /api/conversations/:id/security — Update security settings
   */
  router.patch('/:id/security', async (c) => {
    const user = c.get('user');
    const conversationId = c.req.param('id')!;
    if (!(await isParticipant(conversationId, user.imUserId))) {
      return c.json<ApiResponse>({ ok: false, error: 'Not a participant' }, 403);
    }
    const body = await c.req.json();
    const { signingPolicy, encryptionMode } = body;

    const validPolicies = ['optional', 'recommended', 'required'];
    const validModes = ['none', 'available', 'required'];

    if (signingPolicy && !validPolicies.includes(signingPolicy)) {
      return c.json<ApiResponse>(
        { ok: false, error: `signingPolicy must be one of: ${validPolicies.join(', ')}` },
        400,
      );
    }
    if (encryptionMode && !validModes.includes(encryptionMode)) {
      return c.json<ApiResponse>({ ok: false, error: `encryptionMode must be one of: ${validModes.join(', ')}` }, 400);
    }

    const data: Record<string, string> = {};
    if (signingPolicy) data.signingPolicy = signingPolicy;
    if (encryptionMode) data.encryptionMode = encryptionMode;

    await prisma.iMConversationSecurity.upsert({
      where: { conversationId },
      update: data,
      create: { conversationId, ...data },
    });

    return c.json<ApiResponse>({ ok: true, data: { conversationId, ...data } });
  });

  /**
   * POST /api/conversations/:id/keys — Upload ECDH public key
   */
  router.post('/:id/keys', async (c) => {
    const user = c.get('user');
    const conversationId = c.req.param('id')!;
    if (!(await isParticipant(conversationId, user.imUserId))) {
      return c.json<ApiResponse>({ ok: false, error: 'Not a participant' }, 403);
    }
    const { publicKey, algorithm } = await c.req.json();

    if (!publicKey || typeof publicKey !== 'string') {
      return c.json<ApiResponse>({ ok: false, error: 'publicKey is required' }, 400);
    }

    const security = await prisma.iMConversationSecurity.upsert({
      where: { conversationId },
      update: {},
      create: { conversationId },
    });

    const keys: any[] = JSON.parse(security.ephemeralKeys || '[]');
    // Replace existing key for this user, or append
    const idx = keys.findIndex((k: any) => k.userId === user.imUserId);
    const entry = {
      userId: user.imUserId,
      publicKey,
      algorithm: algorithm || 'ECDH-P256',
      createdAt: new Date().toISOString(),
    };
    if (idx >= 0) keys[idx] = entry;
    else keys.push(entry);

    await prisma.iMConversationSecurity.update({
      where: { conversationId },
      data: { ephemeralKeys: JSON.stringify(keys) },
    });

    return c.json<ApiResponse>({ ok: true, data: entry });
  });

  /**
   * GET /api/conversations/:id/keys — Get all member public keys
   */
  router.get('/:id/keys', async (c) => {
    const user = c.get('user');
    const conversationId = c.req.param('id')!;
    if (!(await isParticipant(conversationId, user.imUserId))) {
      return c.json<ApiResponse>({ ok: false, error: 'Not a participant' }, 403);
    }
    const security = await prisma.iMConversationSecurity.findUnique({
      where: { conversationId },
      select: { ephemeralKeys: true },
    });
    const keys = security?.ephemeralKeys ? JSON.parse(security.ephemeralKeys) : [];
    return c.json<ApiResponse>({ ok: true, data: keys });
  });

  /**
   * DELETE /api/conversations/:id/keys/:keyUserId — Revoke a key
   */
  router.delete('/:id/keys/:keyUserId', async (c) => {
    const user = c.get('user');
    const conversationId = c.req.param('id')!;
    const keyUserId = c.req.param('keyUserId')!;

    // Only key owner or admin can revoke
    if (user.imUserId !== keyUserId && user.role !== 'admin') {
      return c.json<ApiResponse>({ ok: false, error: 'Can only revoke own keys' }, 403);
    }

    const security = await prisma.iMConversationSecurity.findUnique({
      where: { conversationId },
    });
    if (!security) return c.json<ApiResponse>({ ok: true });

    const keys: any[] = JSON.parse(security.ephemeralKeys || '[]');
    const filtered = keys.filter((k: any) => k.userId !== keyUserId);

    await prisma.iMConversationSecurity.update({
      where: { conversationId },
      data: { ephemeralKeys: JSON.stringify(filtered) },
    });

    return c.json<ApiResponse>({ ok: true });
  });

  return router;
}
