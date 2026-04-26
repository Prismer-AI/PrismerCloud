/**
 * Prismer IM — Delegation API Routes
 *
 * AIP Layer 6: Authorization & Revocation endpoints.
 *   POST /delegation/issue   — Issue a delegation from caller to target DID
 *   POST /delegation/verify  — Verify a delegation chain for a DID
 *   POST /delegation/revoke  — Revoke a delegation
 */

import { Hono } from 'hono';
import { authMiddleware } from '../auth/middleware';
import { DelegationService, DelegationError } from '../services/delegation.service';

export function createDelegationRouter(delegationService: DelegationService): Hono {
  const router = new Hono();
  router.use('*', authMiddleware);

  // Issue a Verifiable Delegation (server-signed on behalf of caller)
  router.post('/issue', async (c) => {
    const user = c.get('user' as any) as any;

    const body = await c.req.json();
    const { subjectDid, scope, role, validDays, constraints } = body;

    if (!subjectDid || !scope?.length) {
      return c.json({ ok: false, error: 'subjectDid and scope are required' }, 400);
    }

    try {
      const delegation = await delegationService.issueDelegation({
        issuerUserId: user.imUserId ?? user.sub ?? user.id,
        subjectDid,
        scope,
        role,
        validDays,
        constraints,
      });
      return c.json({ ok: true, data: delegation });
    } catch (err) {
      if (err instanceof DelegationError) {
        return c.json({ ok: false, error: err.message }, 400);
      }
      throw err;
    }
  });

  // Verify a delegation chain for a DID
  router.post('/verify', async (c) => {
    const body = await c.req.json();
    const { did } = body;

    if (!did) {
      return c.json({ ok: false, error: 'did is required' }, 400);
    }

    const result = await delegationService.verifyChain(did);
    return c.json({ ok: true, data: result });
  });

  // Revoke a delegation
  router.post('/revoke', async (c) => {
    const user = c.get('user' as any) as any;
    if (!user) return c.json({ ok: false, error: 'unauthorized' }, 401);

    const body = await c.req.json();
    const { targetDid, reason } = body;

    if (!targetDid || !reason) {
      return c.json({ ok: false, error: 'targetDid and reason are required' }, 400);
    }

    // Get issuer's DID from their identity key
    const { default: prisma } = await import('../db');
    const issuerKey = await prisma.iMIdentityKey.findUnique({
      where: { imUserId: user.imUserId ?? user.sub ?? user.id },
    });
    if (!issuerKey?.didKey) {
      return c.json({ ok: false, error: 'No AIP identity found for caller' }, 400);
    }

    await delegationService.revokeDelegation({
      issuerDid: issuerKey.didKey,
      targetDid,
      reason,
    });

    return c.json({ ok: true });
  });

  return router;
}
