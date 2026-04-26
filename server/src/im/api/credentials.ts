/**
 * Prismer IM — Credentials API Routes
 *
 * AIP Layer 7: Trust Accumulation endpoints.
 *   GET  /credentials/mine     — List caller's credentials
 *   POST /credentials/present  — Build a Verifiable Presentation
 *   POST /credentials/verify   — Verify a VP
 */

import { Hono } from 'hono';
import { authMiddleware } from '../auth/middleware';
import { CredentialService } from '../services/credential.service';

export function createCredentialsRouter(credentialService: CredentialService): Hono {
  const router = new Hono();
  router.use('*', authMiddleware);

  // List my credentials
  router.get('/mine', async (c) => {
    const user = c.get('user' as any) as any;
    if (!user) return c.json({ ok: false, error: 'unauthorized' }, 401);

    const { default: prisma } = await import('../db');
    const identityKey = await prisma.iMIdentityKey.findUnique({
      where: { imUserId: user.imUserId ?? user.sub ?? user.id },
    });
    if (!identityKey?.didKey) {
      return c.json({ ok: true, data: [] });
    }

    const type = c.req.query('type') as any;
    const credentials = await credentialService.getCredentials(identityKey.didKey, type);
    return c.json({ ok: true, data: credentials });
  });

  // Build a Verifiable Presentation
  // v1.8.0 S6: Supports two modes:
  //   Mode A (new): Client sends pre-signed VP via `signedPresentation` field
  //   Mode B (legacy, deprecated): Server signs on behalf of holder
  router.post('/present', async (c) => {
    const user = c.get('user' as any) as any;

    const body = await c.req.json();
    const { credentialIds, challenge, signedPresentation } = body;

    if (!challenge) {
      return c.json({ ok: false, error: 'challenge is required' }, 400);
    }

    // Mode A: Client-signed VP (v1.8.0 — preferred)
    if (signedPresentation) {
      const verifyResult = await credentialService.verifyPresentation(signedPresentation, challenge);
      if (!verifyResult.valid) {
        return c.json({ ok: false, error: `Invalid VP signature: ${verifyResult.reason || 'verification failed'}` }, 400);
      }
      return c.json({ ok: true, data: signedPresentation });
    }

    // Mode B: Server-attested VP (deprecated — use SDK to sign locally)
    const { default: prisma } = await import('../db');
    const identityKey = await prisma.iMIdentityKey.findUnique({
      where: { imUserId: user.imUserId ?? user.sub ?? user.id },
    });
    if (!identityKey?.didKey) {
      return c.json({ ok: false, error: 'No AIP identity found' }, 400);
    }

    const credentials = credentialIds?.length
      ? await Promise.all(
          credentialIds.map(async (id: string) => {
            const cred = await prisma.iMAgentCredential.findUnique({ where: { id } });
            return cred ? JSON.parse(cred.credential) : null;
          }),
        ).then((cs: any[]) => cs.filter(Boolean))
      : await credentialService.getCredentials(identityKey.didKey!);

    const { IdentityService } = await import('../services/identity.service');
    const identityService = new IdentityService();
    const serverPrivateKey = identityService.getServerPrivateKey();

    const vp = credentialService.buildPresentation({
      holderDid: identityKey.didKey,
      holderPrivateKey: serverPrivateKey,
      credentials,
      challenge,
    });

    c.header('X-Deprecation', 'Server-signed VP is deprecated. Use SDK to sign locally and send signedPresentation.');
    return c.json({ ok: true, data: vp });
  });

  // Verify a VP
  router.post('/verify', async (c) => {
    const body = await c.req.json();
    const { presentation, challenge } = body;

    if (!presentation || !challenge) {
      return c.json({ ok: false, error: 'presentation and challenge are required' }, 400);
    }

    const result = await credentialService.verifyPresentation(presentation, challenge);
    return c.json({ ok: true, data: result });
  });

  return router;
}
