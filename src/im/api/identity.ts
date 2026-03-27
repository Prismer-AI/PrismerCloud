/**
 * Prismer IM — Identity Key API
 *
 * PUT    /keys/identity           Register/rotate identity public key
 * GET    /keys/identity/:userId   Get peer's identity key + server attestation
 * POST   /keys/identity/revoke    Revoke compromised key
 * GET    /keys/audit/:userId      Key audit log query
 * GET    /keys/audit/:userId/verify  Verify audit log hash chain integrity
 * GET    /keys/server             Get server's public key (for attestation verification)
 */

import { Hono } from 'hono';
import { authMiddleware } from '../auth/middleware';
import { IdentityService, IdentityError } from '../services/identity.service';
import type { ApiResponse } from '../types';

export function createIdentityRouter(identityService: IdentityService) {
  const router = new Hono();

  router.use('*', authMiddleware);

  /**
   * GET /keys/server — Get server's public key
   * Used by clients to verify server attestations.
   */
  router.get('/server', (c) => {
    return c.json<ApiResponse>({
      ok: true,
      data: {
        publicKey: identityService.getServerPublicKey(),
      },
    });
  });

  /**
   * PUT /keys/identity — Register or rotate identity key
   *
   * Body: { publicKey: string (Base64 Ed25519), derivationMode?: string }
   */
  router.put('/identity', async (c) => {
    const user = c.get('user');
    const body = await c.req.json();

    const { publicKey, derivationMode } = body;

    if (!publicKey || typeof publicKey !== 'string') {
      return c.json<ApiResponse>({ ok: false, error: 'publicKey is required (Base64 Ed25519)' }, 400);
    }

    try {
      const result = await identityService.registerKey(
        user.imUserId,
        publicKey,
        derivationMode ?? 'generated',
      );

      return c.json<ApiResponse>({
        ok: true,
        data: {
          ...result,
          registeredAt: result.registeredAt.toISOString(),
          revokedAt: result.revokedAt?.toISOString() ?? null,
          serverPublicKey: identityService.getServerPublicKey(),
        },
      });
    } catch (err) {
      if (err instanceof IdentityError) {
        return c.json<ApiResponse>({ ok: false, error: err.message }, 400);
      }
      throw err;
    }
  });

  /**
   * GET /keys/identity/:userId — Get peer's identity key + attestation
   */
  router.get('/identity/:userId', async (c) => {
    const targetUserId = c.req.param('userId')!;

    const key = await identityService.lookupKey(targetUserId);
    if (!key) {
      return c.json<ApiResponse>({ ok: false, error: 'No active identity key found' }, 404);
    }

    return c.json<ApiResponse>({
      ok: true,
      data: {
        ...key,
        registeredAt: key.registeredAt.toISOString(),
        revokedAt: key.revokedAt?.toISOString() ?? null,
        serverPublicKey: identityService.getServerPublicKey(),
      },
    });
  });

  /**
   * POST /keys/identity/revoke — Revoke own identity key
   */
  router.post('/identity/revoke', async (c) => {
    const user = c.get('user');

    try {
      await identityService.revokeKey(user.imUserId);
      return c.json<ApiResponse>({ ok: true });
    } catch (err) {
      if (err instanceof IdentityError) {
        return c.json<ApiResponse>({ ok: false, error: err.message }, 400);
      }
      throw err;
    }
  });

  /**
   * GET /keys/audit/:userId — Get key audit log
   * Users can view their own audit log. Others can too (transparency).
   */
  router.get('/audit/:userId', async (c) => {
    const targetUserId = c.req.param('userId')!;
    const logs = await identityService.getAuditLog(targetUserId);

    return c.json<ApiResponse>({
      ok: true,
      data: logs.map(l => ({
        ...l,
        createdAt: l.createdAt.toISOString(),
      })),
    });
  });

  /**
   * GET /keys/audit/:userId/verify — Verify audit log hash chain integrity
   */
  router.get('/audit/:userId/verify', async (c) => {
    const targetUserId = c.req.param('userId')!;
    const result = await identityService.verifyAuditChain(targetUserId);

    return c.json<ApiResponse>({ ok: true, data: result });
  });

  return router;
}
