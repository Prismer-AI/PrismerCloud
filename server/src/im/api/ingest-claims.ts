/**
 * Prismer IM — Ingest Claims API (Wave-54 B7)
 *
 * When multiple daemons share a workspace (paired phone + laptop + watcher),
 * exactly one daemon should run the heavy parse pass for any given asset
 * version. Daemons coordinate by claiming the parse work; other daemons
 * see the active claim and skip the duplicate effort.
 *
 * Endpoints (mounted under /ingest):
 *   POST /ingest/claims                    — acquire claim
 *   POST /ingest/claims/:id/heartbeat      — refresh liveness
 *   POST /ingest/claims/:id/complete       — mark complete
 *   GET  /ingest/claims/:id                — read claim state (used by tests)
 *
 * Coordination semantics:
 *   - One row per (workspaceId, assetId, ingestVersion). Takeover overwrites
 *     in place; we never accumulate stale rows.
 *   - heartbeatAt > now - CLAIM_HEARTBEAT_TTL_MS → claim is "alive".
 *   - Stale active claim → next acquire wins by overwriting the row.
 *   - Completed claim → re-acquire returns 409 "already_complete" with the
 *     verdict. Callers should not redo the work.
 *
 * See docs/54release/26-asset-multi-tier-sync.md (two-daemons-same-claim
 * race acceptance — exactly one acquire returns 201, the other 409).
 */

import { Hono } from 'hono';
import { authMiddleware } from '../auth/middleware';
import prisma from '../db';
import type { ApiResponse } from '../types/index';

const DEFAULT_HEARTBEAT_TTL_MS = 30_000;

function getHeartbeatTtlMs(): number {
  const raw = process.env.INGEST_CLAIM_HEARTBEAT_TTL_MS;
  if (!raw) return DEFAULT_HEARTBEAT_TTL_MS;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HEARTBEAT_TTL_MS;
}

interface IngestClaimDTO {
  id: string;
  workspaceId: string;
  assetId: string;
  ingestVersion: number;
  claimantImUserId: string;
  claimantDeviceId: string;
  status: 'active' | 'completed' | 'abandoned';
  claimedAt: string;
  heartbeatAt: string;
  completedAt: string | null;
}

type ClaimRow = {
  id: string;
  workspaceId: string;
  assetId: string;
  ingestVersion: number;
  claimantImUserId: string;
  claimantDeviceId: string;
  status: string;
  claimedAt: Date;
  heartbeatAt: Date;
  completedAt: Date | null;
};

type ClaimStatus = 'active' | 'completed' | 'abandoned';

// Runtime narrowing for the DB-side `status String` column. A stray value
// (manual SQL fix-up, future fourth state shipped without DTO update) must
// not silently masquerade as a valid status — we log and downgrade to
// 'abandoned' so callers treat it as not-actively-held.
function parseClaimStatus(raw: string): ClaimStatus {
  if (raw === 'active' || raw === 'completed' || raw === 'abandoned') return raw;
  console.error(`[IngestClaims] Unknown claim status from DB: ${JSON.stringify(raw)}; treating as 'abandoned'`);
  return 'abandoned';
}

function toDTO(row: ClaimRow): IngestClaimDTO {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    assetId: row.assetId,
    ingestVersion: row.ingestVersion,
    claimantImUserId: row.claimantImUserId,
    claimantDeviceId: row.claimantDeviceId,
    status: parseClaimStatus(row.status),
    claimedAt: row.claimedAt.toISOString(),
    heartbeatAt: row.heartbeatAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}

async function loadWorkspaceForAssetAccess(workspaceId: string, callerImUserId: string) {
  const ws = await prisma.iMWorkspace.findFirst({
    where: { id: workspaceId, deletedAt: null },
    select: { id: true, ownerImUserId: true },
  });
  if (!ws) return null;
  if (ws.ownerImUserId === callerImUserId) return ws;
  const card = await prisma.iMAgentCard.findUnique({
    where: { imUserId: callerImUserId },
    select: { workspaceId: true },
  });
  return card?.workspaceId === workspaceId ? ws : null;
}

export function createIngestClaimsRouter() {
  const router = new Hono();

  // eslint-disable-next-line custom/no-wildcard-sub-router-middleware -- mounted at /ingest in routes.ts; wildcard scoped to that prefix
  router.use('*', authMiddleware);

  /**
   * POST /ingest/claims — acquire (or take over) a claim.
   *
   * Body: { assetId, ingestVersion, deviceId }
   *
   * 201 ok → fresh claim or successful takeover (caller should start work).
   * 409 conflict → live claim owned by a different daemon OR already complete.
   *                error.code is 'claimed_active' or 'already_complete'.
   */
  router.post('/claims', async (c) => {
    const user = c.get('user');

    let body: { assetId?: unknown; ingestVersion?: unknown; deviceId?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Expected JSON body' }, 400);
    }
    if (typeof body.assetId !== 'string' || !body.assetId) {
      return c.json<ApiResponse>({ ok: false, error: 'assetId is required' }, 400);
    }
    if (typeof body.ingestVersion !== 'number' || !Number.isInteger(body.ingestVersion) || body.ingestVersion < 1) {
      return c.json<ApiResponse>({ ok: false, error: 'ingestVersion must be a positive integer' }, 400);
    }
    if (typeof body.deviceId !== 'string' || !body.deviceId) {
      return c.json<ApiResponse>({ ok: false, error: 'deviceId is required' }, 400);
    }
    const assetId = body.assetId;
    const ingestVersion = body.ingestVersion;
    const deviceId = body.deviceId.slice(0, 120);

    const asset = await prisma.iMAsset.findUnique({
      where: { id: assetId },
      select: { id: true, workspaceId: true, ingestVersion: true, deletedAt: true },
    });
    if (!asset) return c.json<ApiResponse>({ ok: false, error: 'Asset not found' }, 404);
    if (asset.deletedAt) return c.json<ApiResponse>({ ok: false, error: 'Asset deleted' }, 410);

    const ws = await loadWorkspaceForAssetAccess(asset.workspaceId, user.imUserId);
    if (!ws) return c.json<ApiResponse>({ ok: false, error: 'Workspace not found' }, 404);

    const ttlMs = getHeartbeatTtlMs();
    const now = new Date();
    const staleBefore = new Date(now.getTime() - ttlMs);

    // Single-row coordination keyed on (workspaceId, assetId, ingestVersion).
    // Transaction + UNIQUE(workspaceId, assetId, ingestVersion) handles the
    // no-row → INSERT race (P2002 catch below). The stale-takeover path uses
    // a conditional updateMany so two daemons that both observed the same
    // expired heartbeat can't both win — only one updateMany affects 1 row,
    // the loser sees count=0 and re-reads to learn who took it.
    type ClaimTx = { iMIngestClaim: typeof prisma.iMIngestClaim };
    try {
      const result = await prisma.$transaction(async (tx: ClaimTx) => {
        const existing = await tx.iMIngestClaim.findUnique({
          where: {
            uq_ingest_claim_target: {
              workspaceId: asset.workspaceId,
              assetId,
              ingestVersion,
            },
          },
        });

        if (existing) {
          if (existing.status === 'completed') {
            return { kind: 'already_complete' as const, claim: existing };
          }
          if (existing.status === 'active' && existing.heartbeatAt > staleBefore) {
            const sameOwner =
              existing.claimantImUserId === user.imUserId && existing.claimantDeviceId === deviceId;
            if (sameOwner) {
              // Re-acquire from the same daemon refreshes the heartbeat.
              // This makes the API safe to call on agent restart.
              const refreshed = await tx.iMIngestClaim.update({
                where: { id: existing.id },
                data: { heartbeatAt: now },
              });
              return { kind: 'refreshed' as const, claim: refreshed };
            }
            return { kind: 'claimed_active' as const, claim: existing };
          }
          // Stale-active or abandoned → conditional takeover. The WHERE
          // re-asserts the predicate that made the row eligible; if another
          // transaction refreshed heartbeatAt or wrote a new owner between
          // our SELECT and UPDATE, count is 0 and we surface the conflict.
          const takeoverWhere = {
            id: existing.id,
            OR: [
              { status: { not: 'active' } },
              { heartbeatAt: { lt: staleBefore } },
            ],
          };
          const updateResult = await tx.iMIngestClaim.updateMany({
            where: takeoverWhere,
            data: {
              claimantImUserId: user.imUserId,
              claimantDeviceId: deviceId,
              status: 'active',
              claimedAt: now,
              heartbeatAt: now,
              completedAt: null,
            },
          });
          if (updateResult.count === 0) {
            // Lost the race. Re-read to report who actually owns it now.
            const fresh = await tx.iMIngestClaim.findUnique({ where: { id: existing.id } });
            if (!fresh) {
              // Vanished mid-transaction (shouldn't happen — unique row).
              return { kind: 'claimed_active' as const, claim: existing };
            }
            if (fresh.status === 'completed') {
              return { kind: 'already_complete' as const, claim: fresh };
            }
            return { kind: 'claimed_active' as const, claim: fresh };
          }
          const takenOver = await tx.iMIngestClaim.findUnique({ where: { id: existing.id } });
          // count was 1 so the row exists; findUnique can return null only
          // if a concurrent DELETE happened (no such code path exists today).
          if (!takenOver) {
            return { kind: 'claimed_active' as const, claim: existing };
          }
          return { kind: 'taken_over' as const, claim: takenOver };
        }

        const created = await tx.iMIngestClaim.create({
          data: {
            workspaceId: asset.workspaceId,
            assetId,
            ingestVersion,
            claimantImUserId: user.imUserId,
            claimantDeviceId: deviceId,
            status: 'active',
            claimedAt: now,
            heartbeatAt: now,
          },
        });
        return { kind: 'created' as const, claim: created };
      });

      if (result.kind === 'claimed_active') {
        return c.json<ApiResponse<IngestClaimDTO>>(
          {
            ok: false,
            error: {
              code: 'claimed_active',
              message: `Active claim held by another daemon (heartbeat ${result.claim.heartbeatAt.toISOString()})`,
            },
            meta: { claim: toDTO(result.claim as ClaimRow) },
          } as ApiResponse<IngestClaimDTO>,
          409,
        );
      }
      if (result.kind === 'already_complete') {
        return c.json<ApiResponse<IngestClaimDTO>>(
          {
            ok: false,
            error: {
              code: 'already_complete',
              message: `Ingest version ${ingestVersion} already complete for asset ${assetId}`,
            },
            meta: { claim: toDTO(result.claim as ClaimRow) },
          } as ApiResponse<IngestClaimDTO>,
          409,
        );
      }
      const status = result.kind === 'created' ? 201 : 200;
      return c.json<ApiResponse<IngestClaimDTO>>({ ok: true, data: toDTO(result.claim as ClaimRow) }, status);
    } catch (err) {
      // P2002 here means a concurrent transaction beat us to INSERT. Tell the
      // caller to retry — the GET on the same target will now find the row.
      if ((err as { code?: string })?.code === 'P2002') {
        return c.json<ApiResponse>(
          { ok: false, error: { code: 'claim_race', message: 'Concurrent claim — retry' } },
          409,
        );
      }
      // Surface the business keys with the error so coordination failures
      // can be traced across N daemons hitting different (asset, version)
      // pairs without grepping for the cuid.
      console.error('[IngestClaims] acquire failed', {
        workspaceId: asset.workspaceId,
        assetId,
        ingestVersion,
        claimantImUserId: user.imUserId,
        deviceId,
        err: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
      });
      return c.json<ApiResponse>({ ok: false, error: 'Claim acquire failed' }, 500);
    }
  });

  /**
   * POST /ingest/claims/:id/heartbeat — refresh the heartbeat.
   *
   * 200 ok → heartbeat refreshed; caller may continue work.
   * 410 gone → claim was taken over (status changed) or completed; abort work.
   */
  router.post('/claims/:id/heartbeat', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    let body: { deviceId?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Expected JSON body' }, 400);
    }
    if (typeof body.deviceId !== 'string' || !body.deviceId) {
      return c.json<ApiResponse>({ ok: false, error: 'deviceId is required' }, 400);
    }
    const deviceId = body.deviceId.slice(0, 120);

    const claim = await prisma.iMIngestClaim.findUnique({ where: { id } });
    if (!claim) return c.json<ApiResponse>({ ok: false, error: 'Claim not found' }, 404);
    if (!(await loadWorkspaceForAssetAccess(claim.workspaceId, user.imUserId))) {
      return c.json<ApiResponse>({ ok: false, error: 'Claim not found' }, 404);
    }
    if (claim.claimantImUserId !== user.imUserId || claim.claimantDeviceId !== deviceId) {
      return c.json<ApiResponse>(
        { ok: false, error: { code: 'claim_taken_over', message: 'Claim belongs to a different daemon' } },
        410,
      );
    }
    if (claim.status !== 'active') {
      return c.json<ApiResponse>(
        { ok: false, error: { code: 'claim_inactive', message: `Claim status is ${claim.status}` } },
        410,
      );
    }

    const refreshed = await prisma.iMIngestClaim.update({
      where: { id },
      data: { heartbeatAt: new Date() },
    });
    return c.json<ApiResponse<IngestClaimDTO>>({ ok: true, data: toDTO(refreshed as ClaimRow) });
  });

  /**
   * POST /ingest/claims/:id/complete — mark claim as completed.
   *
   * 200 ok → recorded. Future acquires for the same (asset, version) return
   *          409 already_complete with this claim's metadata.
   */
  router.post('/claims/:id/complete', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    let body: { deviceId?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Expected JSON body' }, 400);
    }
    if (typeof body.deviceId !== 'string' || !body.deviceId) {
      return c.json<ApiResponse>({ ok: false, error: 'deviceId is required' }, 400);
    }
    const deviceId = body.deviceId.slice(0, 120);

    const claim = await prisma.iMIngestClaim.findUnique({ where: { id } });
    if (!claim) return c.json<ApiResponse>({ ok: false, error: 'Claim not found' }, 404);
    if (!(await loadWorkspaceForAssetAccess(claim.workspaceId, user.imUserId))) {
      return c.json<ApiResponse>({ ok: false, error: 'Claim not found' }, 404);
    }
    if (claim.claimantImUserId !== user.imUserId || claim.claimantDeviceId !== deviceId) {
      return c.json<ApiResponse>(
        { ok: false, error: { code: 'claim_taken_over', message: 'Claim belongs to a different daemon' } },
        410,
      );
    }
    if (claim.status === 'completed') {
      return c.json<ApiResponse<IngestClaimDTO>>({ ok: true, data: toDTO(claim as ClaimRow) });
    }

    const now = new Date();
    const completed = await prisma.iMIngestClaim.update({
      where: { id },
      data: { status: 'completed', completedAt: now, heartbeatAt: now },
    });
    return c.json<ApiResponse<IngestClaimDTO>>({ ok: true, data: toDTO(completed as ClaimRow) });
  });

  /**
   * GET /ingest/claims/:id — inspect a claim (test + observability).
   */
  router.get('/claims/:id', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const claim = await prisma.iMIngestClaim.findUnique({ where: { id } });
    if (!claim) return c.json<ApiResponse>({ ok: false, error: 'Claim not found' }, 404);
    if (!(await loadWorkspaceForAssetAccess(claim.workspaceId, user.imUserId))) {
      return c.json<ApiResponse>({ ok: false, error: 'Claim not found' }, 404);
    }
    return c.json<ApiResponse<IngestClaimDTO>>({ ok: true, data: toDTO(claim as ClaimRow) });
  });

  return router;
}
