/**
 * Account deletion cascade — Cloud 1.5 (54release).
 *
 * Soft-delete only: the IMUser row stays (FK references in im_messages,
 * im_tasks, im_conversations etc. would break otherwise) but is marked
 * `banned=true` with metadata.deletedAt. Cloud-side credentials (pc_api_keys
 * + the requesting JWT) are revoked so the user can never re-authenticate
 * after this returns 200.
 *
 * Cross-cutting touches:
 *   - im_users               → banned + bannedAt + bannedReason + metadata
 *   - im_conversations       → archived for those the user owns
 *   - im_tasks               → cancelled for the user's open tasks
 *   - pc_api_keys            → status='REVOKED' (raw SQL via Prisma — table
 *                              lives in MySQL only; SQLite dev path skipped)
 *   - auth:token-blacklist…  → the requesting JWT is blacklisted with TTL
 *                              clamped to its own remaining `exp`
 *
 * What we explicitly DON'T touch:
 *   - im_messages / im_task_logs — historical record, FK-protected.
 *   - im_assets / im_workspace_files — content-addressed; another user may
 *     reference the same hash.
 *   - im_workspaces — owner is gone but other queries already filter on
 *     `ownerImUserId` so the rows become unreachable through the public API.
 *     Hard-delete is the account-purge job, not this handler.
 */

import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import prisma from '../db';
import { redis } from '../../lib/auth/redis';
import { config } from '../config';

const BLACKLIST_KEY_PREFIX = 'auth:token-blacklist:';
const BLACKLIST_TTL_FALLBACK_SECONDS = 60 * 60 * 24 * 7; // 7 days — caps a forged-`exp` token from filling Redis.
const BLACKLIST_TTL_FLOOR_SECONDS = 60;

export interface DeleteAccountResult {
  imUserId: string;
  numericId: number | null;
  deletedAt: string;
  cascade: {
    conversationsArchived: number;
    tasksCancelled: number;
    apiKeysRevoked: number;
    tokenBlacklisted: boolean;
  };
}

export class AccountDeletionError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AccountDeletionError';
  }
}

/**
 * Run the deletion cascade. Idempotent for already-banned users — returns the
 * same shape so the mobile client can re-issue the call after a transient
 * network failure without seeing 4xx.
 */
export async function deleteAccountCascade(opts: {
  imUserId: string;
  /**
   * The Bearer JWT that authenticated this DELETE request. Used to compute
   * the blacklist key + clamp the TTL to the token's own `exp`. Optional
   * because some callers (admin tools, future flows) may not have one.
   */
  requestToken?: string | null;
}): Promise<DeleteAccountResult> {
  const { imUserId, requestToken } = opts;

  const user = (await (prisma as any).iMUser.findUnique({
    where: { id: imUserId },
    select: { id: true, numericId: true, banned: true, metadata: true },
  })) as { id: string; numericId: bigint | number | null; banned: boolean; metadata: string | null } | null;

  if (!user) {
    throw new AccountDeletionError(404, 'User not found');
  }

  const numericId = user.numericId == null ? null : Number(user.numericId);
  const now = new Date();
  const deletedAtIso = now.toISOString();

  // ── 1. Mark the IMUser banned + record deletion metadata ───────────
  let mergedMetadata: Record<string, unknown> = {};
  try {
    mergedMetadata = user.metadata ? JSON.parse(user.metadata) : {};
  } catch {
    mergedMetadata = {};
  }
  mergedMetadata.deletedAt = deletedAtIso;
  mergedMetadata.deletionSource = 'self-service';

  await (prisma as any).iMUser.update({
    where: { id: imUserId },
    data: {
      banned: true,
      bannedAt: now,
      banReason: mergedMetadata.banReason ?? 'Account deletion requested by owner',
      metadata: JSON.stringify(mergedMetadata),
    },
  });

  // ── 2. Archive conversations the user owns ─────────────────────────
  const ownedConvs = await (prisma as any).iMConversation.updateMany({
    where: { createdById: imUserId, status: { not: 'archived' } },
    data: { status: 'archived' },
  });

  // ── 3. Cancel the user's open tasks (creator side) ─────────────────
  // assignee-side tasks are someone else's commitment — let them re-claim
  // or fail naturally; we don't touch them here.
  const openStates = ['pending', 'assigned', 'running', 'in_progress', 'review'];
  const cancelledTasks = await (prisma as any).iMTask.updateMany({
    where: { creatorId: imUserId, status: { in: openStates } },
    data: { status: 'cancelled' },
  });

  // ── 4. Revoke pc_api_keys (MySQL-only; SQLite dev path skipped) ────
  let apiKeysRevoked = 0;
  if (numericId != null && numericId > 0) {
    try {
      apiKeysRevoked = await (prisma as any).$executeRawUnsafe(
        "UPDATE pc_api_keys SET status = 'REVOKED' WHERE user_id = ? AND status = 'ACTIVE'",
        numericId,
      );
    } catch (err) {
      // SQLite dev DB doesn't have pc_api_keys; treat as 0 revoked, don't
      // fail the whole cascade. Production MySQL will succeed.
      console.warn('[ME] pc_api_keys revoke skipped', {
        imUserId,
        err: (err as Error).message,
      });
    }
  }

  // ── 5. Blacklist the request token ─────────────────────────────────
  let tokenBlacklisted = false;
  if (requestToken) {
    try {
      const ttl = computeBlacklistTtlSeconds(requestToken);
      const key = BLACKLIST_KEY_PREFIX + crypto.createHash('sha256').update(requestToken).digest('hex');
      await redis.setex(key, ttl, '1');
      tokenBlacklisted = true;
    } catch (err) {
      // Redis down ≠ fail the deletion. The `banned=true` flag is the
      // source-of-truth fallback enforced by the auth guard at every
      // subsequent request.
      console.warn('[ME] token blacklist write failed; banned=true fallback in effect', {
        imUserId,
        err: (err as Error).message,
      });
    }
  }

  // ── 6. Audit — pre-SIEM, console.warn so it stands out in pino logs ─
  console.warn('[ME] account deletion', {
    imUserId,
    numericId,
    deletedAt: deletedAtIso,
    cascade: {
      conversationsArchived: ownedConvs.count ?? 0,
      tasksCancelled: cancelledTasks.count ?? 0,
      apiKeysRevoked,
      tokenBlacklisted,
    },
  });

  return {
    imUserId,
    numericId,
    deletedAt: deletedAtIso,
    cascade: {
      conversationsArchived: ownedConvs.count ?? 0,
      tasksCancelled: cancelledTasks.count ?? 0,
      apiKeysRevoked,
      tokenBlacklisted,
    },
  };
}

function computeBlacklistTtlSeconds(token: string): number {
  let exp: number | undefined;
  try {
    const payload = jwt.verify(token, config.jwt.secret) as { exp?: number };
    exp = payload.exp;
  } catch {
    // verify failed (signature/expiry) — fall back to a small TTL so we
    // don't refuse to blacklist a token the caller obviously held (the
    // signature might have been signed by a sibling secret in a key
    // rotation window, etc.). Cap to the fallback to bound Redis impact.
    return BLACKLIST_TTL_FALLBACK_SECONDS;
  }
  if (!exp) return BLACKLIST_TTL_FALLBACK_SECONDS;
  const remaining = exp - Math.floor(Date.now() / 1000);
  return Math.max(BLACKLIST_TTL_FLOOR_SECONDS, Math.min(remaining, BLACKLIST_TTL_FALLBACK_SECONDS));
}
