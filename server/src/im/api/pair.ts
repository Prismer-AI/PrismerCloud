/**
 * Prismer IM — Pair API (v1.9.3)
 *
 * Three endpoints driving the QR-based daemon ↔ cloud pairing flow.
 * See [docs/refactor/03-ws-protocol.md §"Pair endpoint"] for the protocol;
 * lifecycle implementation in `src/im/services/pair.service.ts`.
 *
 *   POST /pair/offer               — daemon, no auth
 *   POST /pair/approve             — mobile, JWT auth
 *   GET  /pair/poll/:nonce         — daemon, no auth (devicePub-bound)
 *   POST /pair/local-only-approve  — daemon, LOCAL_ONLY dev gate (no auth)
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { authMiddleware } from '../auth/middleware';
import prisma from '../db';
import {
  PairService,
  PairOfferNotFoundError,
  PairOfferExpiredError,
  PairOfferAlreadyApprovedError,
  PairOfferConsumedError,
  PairDevicePubMismatchError,
  PairApproverNotLinkedError,
} from '../services/pair.service';
import type { ApiResponse } from '../types/index';

/**
 * LAN-dev gate. Mirrors `src/lib/auth/local-auth.ts:isLocalOnlyDev` and
 * `src/lib/nacos-config.ts:443` — both clauses MUST hold:
 *
 *   - LOCAL_ONLY=1
 *   - NODE_ENV !== 'production'
 *
 * Dockerfile pins NODE_ENV=production for prod images, so even if
 * LOCAL_ONLY=1 leaks in via env injection the second clause refuses it.
 */
function isLocalOnlyDev(): boolean {
  return process.env.LOCAL_ONLY === '1' && process.env.NODE_ENV !== 'production';
}

export function createPairRouter(pairService: PairService) {
  const router = new Hono();

  /**
   * POST /pair/offer — Daemon creates a pairing offer.
   * Body: { devicePub, deviceName }
   * Returns: { nonce, qrUrl, expiresAt }
   *
   * No auth required: the daemon doesn't have an API key yet (this flow
   * is what bootstraps it). Rate-limiting per source IP / devicePub belongs
   * at the gateway layer.
   */
  router.post('/offer', async (c) => {
    let body: { devicePub?: string; deviceName?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Invalid JSON body' }, 400);
    }

    const devicePub = (body.devicePub ?? '').trim();
    const deviceName = (body.deviceName ?? '').trim();

    if (!devicePub) {
      return c.json<ApiResponse>({ ok: false, error: 'devicePub is required' }, 400);
    }
    if (devicePub.length > 256) {
      return c.json<ApiResponse>({ ok: false, error: 'devicePub too long (max 256)' }, 400);
    }
    if (!deviceName) {
      return c.json<ApiResponse>({ ok: false, error: 'deviceName is required' }, 400);
    }
    if (deviceName.length > 128) {
      return c.json<ApiResponse>({ ok: false, error: 'deviceName too long (max 128)' }, 400);
    }

    const result = await pairService.createOffer({ devicePub, deviceName });
    return c.json<ApiResponse>({
      ok: true,
      data: {
        nonce: result.nonce,
        qrUrl: result.qrUrl,
        expiresAt: result.expiresAt.toISOString(),
      },
    });
  });

  /**
   * POST /pair/approve — Mobile user approves an offer.
   * Auth: JWT (the user's IMUser id is taken from the bearer token).
   * Body: { nonce }
   * Returns: { ok: true }
   *
   * The API key plaintext is NOT returned here — it's cached server-side
   * keyed by nonce, daemon picks it up via /pair/poll. This keeps the key
   * out of the mobile client's memory entirely.
   */
  router.post('/approve', authMiddleware, async (c) => {
    const user = c.get('user');
    let body: { nonce?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Invalid JSON body' }, 400);
    }

    const nonce = (body.nonce ?? '').trim();
    if (!nonce) {
      return c.json<ApiResponse>({ ok: false, error: 'nonce is required' }, 400);
    }

    try {
      await pairService.approveOffer(nonce, user.imUserId);
      return c.json<ApiResponse>({ ok: true });
    } catch (err) {
      return mapPairError(c, err);
    }
  });

  /**
   * GET /pair/poll/:nonce?devicePub=… — Daemon polls for the approved key.
   *
   * Returns one of:
   *   200 { ok:true, data:{ apiKey, status:'approved' } } — first poll
   *     after approval; key is single-use.
   *   202 { ok:true, data:{ status:'pending' } } — not yet approved.
   *   410 { ok:false, error:'…' } — consumed (already returned once),
   *     expired, or device mismatch.
   *   404 { ok:false, error:'…' } — unknown nonce.
   *
   * No auth: daemon doesn't have a key yet. devicePub query param ties
   * the request to the same device that created the offer (passive QR
   * observers can't race).
   */
  router.get('/poll/:nonce', async (c) => {
    const nonce = c.req.param('nonce');
    const devicePub = (c.req.query('devicePub') ?? '').trim();

    if (!nonce) {
      return c.json<ApiResponse>({ ok: false, error: 'nonce is required' }, 400);
    }
    if (!devicePub) {
      return c.json<ApiResponse>({ ok: false, error: 'devicePub query param is required' }, 400);
    }

    try {
      const result = await pairService.pollOffer(nonce, devicePub);
      if (!result) {
        // Not yet approved.
        return c.json<ApiResponse>({ ok: true, data: { status: 'pending' } }, 202);
      }
      return c.json<ApiResponse>({
        ok: true,
        data: { status: 'approved', apiKey: result.apiKey },
      });
    } catch (err) {
      return mapPairError(c, err);
    }
  });

  /**
   * POST /pair/local-only-approve — LAN-dev bypass for /approve.
   *
   * Only callable when `LOCAL_ONLY=1 && NODE_ENV !== 'production'`. In any
   * other environment this returns 403 — the route is registered but
   * disabled, so a misconfigured prod container can't be tricked into
   * approving offers without a JWT.
   *
   * Body: { nonce, asUserEmail }
   * Returns: { ok: true } on success.
   *
   * The "as-user" email resolves to a human IMUser row; that user becomes
   * the approver of record (im_pairing_offers.approverImUserId), and the
   * minted API key is owned by that user's cloud account. This makes the
   * resulting paired daemon indistinguishable from one paired via the
   * normal QR + mobile-approve path — the harness gate just skips the
   * human in the loop.
   */
  router.post('/local-only-approve', async (c) => {
    if (!isLocalOnlyDev()) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: {
            code: 'LOCAL_ONLY_DISABLED',
            message: 'local-only-approve is only available when LOCAL_ONLY=1 and NODE_ENV is not production',
          },
        },
        403,
      );
    }

    let body: { nonce?: string; asUserEmail?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Invalid JSON body' }, 400);
    }

    const nonce = (body.nonce ?? '').trim();
    const asUserEmail = (body.asUserEmail ?? '').trim().toLowerCase();
    if (!nonce) {
      return c.json<ApiResponse>({ ok: false, error: 'nonce is required' }, 400);
    }
    if (!asUserEmail) {
      return c.json<ApiResponse>({ ok: false, error: 'asUserEmail is required' }, 400);
    }

    const imUser = await prisma.iMUser.findFirst({
      where: { email: asUserEmail, role: 'human' },
      select: { id: true, userId: true, numericId: true },
    });
    if (!imUser) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: {
            code: 'AS_USER_NOT_FOUND',
            message: `No human IMUser with email ${asUserEmail}`,
          },
        },
        404,
      );
    }

    // Native-auth users (registerWithPassword) get `numericId` from the
    // auto-increment but never have `userId` populated, while pair.service
    // requires userId to mint the pc_api_keys row. Self-heal that link
    // here — strictly limited to the LOCAL_ONLY path. Prod cannot reach
    // this code (NODE_ENV=production refuses bypass at the top of the
    // handler).
    if (!imUser.userId && imUser.numericId !== null && imUser.numericId !== undefined) {
      const userId = String(imUser.numericId);
      await prisma.iMUser.update({
        where: { id: imUser.id },
        data: { userId },
      });
      console.log(`[Pair API] LOCAL_ONLY self-healed IMUser.userId=${userId} for ${asUserEmail}`);
    }

    try {
      await pairService.approveOffer(nonce, imUser.id);
      console.log(`[Pair API] LOCAL_ONLY approve nonce=${nonce.slice(0, 8)}… asUser=${asUserEmail}`);
      return c.json<ApiResponse>({ ok: true });
    } catch (err) {
      return mapPairError(c, err);
    }
  });

  return router;
}

/**
 * Map PairService errors to HTTP responses with stable codes the daemon
 * can branch on.
 */
function mapPairError(c: Context, err: unknown) {
  if (err instanceof PairOfferNotFoundError) {
    return c.json<ApiResponse>(
      { ok: false, error: { code: 'OFFER_NOT_FOUND', message: 'Pairing offer not found' } },
      404,
    );
  }
  if (err instanceof PairOfferExpiredError) {
    return c.json<ApiResponse>({ ok: false, error: { code: 'OFFER_EXPIRED', message: 'Pairing offer expired' } }, 410);
  }
  if (err instanceof PairOfferAlreadyApprovedError) {
    return c.json<ApiResponse>(
      { ok: false, error: { code: 'OFFER_ALREADY_APPROVED', message: 'Pairing offer already approved' } },
      409,
    );
  }
  if (err instanceof PairOfferConsumedError) {
    return c.json<ApiResponse>(
      { ok: false, error: { code: 'OFFER_CONSUMED', message: 'Pairing offer already consumed' } },
      410,
    );
  }
  if (err instanceof PairDevicePubMismatchError) {
    return c.json<ApiResponse>(
      { ok: false, error: { code: 'DEVICE_MISMATCH', message: 'Device public key mismatch' } },
      403,
    );
  }
  if (err instanceof PairApproverNotLinkedError) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: {
          code: 'APPROVER_NOT_LINKED',
          message: 'Your IM user is not linked to a cloud account; cannot approve',
        },
      },
      400,
    );
  }
  console.error('[Pair API] Unexpected error:', err);
  return c.json<ApiResponse>({ ok: false, error: 'Internal error' }, 500);
}
