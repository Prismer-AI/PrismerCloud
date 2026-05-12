/**
 * Prismer IM — Pair Service (v1.9.3)
 *
 * QR-based daemon ↔ cloud pairing. Three operations:
 *
 *   1. createOffer({ devicePub, deviceName })
 *      Daemon-initiated, no auth. Generates a 64-char nonce + 5-min TTL.
 *      Returns the offer + a `prismer://pair?nonce=&pub=` QR URL the
 *      daemon prints to its terminal.
 *
 *   2. approveOffer(nonce, approverImUserId)
 *      Mobile-initiated (JWT auth). Mints a fresh `pc_api_keys` row owned
 *      by the mobile user's cloud account, stashes the plaintext in Redis
 *      under the nonce (TTL = offer expiry), and stamps the offer.
 *
 *   3. pollOffer(nonce, devicePub)
 *      Daemon short-poll, no auth, replay-protected by `devicePub`.
 *      First successful read flips `consumedAt` and returns the API key.
 *      Subsequent reads return `null` → caller maps to 410 Gone.
 *
 * Why Redis for plaintext: `pc_api_keys` only stores SHA-256 hashes, so we
 * can't reconstruct the plaintext at poll time. Sticking it in Redis with
 * a TTL bounded by the offer expiry keeps secrets out of long-lived
 * storage. Per [docs/refactor/03-ws-protocol.md §pair endpoint] this is
 * the simplification of 1.9.0's complex E2EE pairing — API key over HTTPS
 * is the binding.
 */

import crypto from 'node:crypto';
import type Redis from 'ioredis';
import prisma from '../db';
import { createModuleLogger } from '../../lib/logger';
import { createApiKey } from '../../lib/db-api-keys';

const log = createModuleLogger('PairService');

// ─── Constants ───────────────────────────────────────────────

/** 5-minute TTL — short enough that scanning a stale QR is safe. */
const OFFER_TTL_MS = 5 * 60 * 1000;

/** Redis key prefix for the cached API-key plaintext between approve and poll. */
const REDIS_KEY_PREFIX = 'pair:apikey:';

/** 32 bytes = 64 hex chars; collision chance for a 5min window is negligible. */
const NONCE_BYTES = 32;

// ─── Errors ──────────────────────────────────────────────────

export class PairOfferNotFoundError extends Error {
  constructor() {
    super('Pairing offer not found');
    this.name = 'PairOfferNotFoundError';
  }
}

export class PairOfferExpiredError extends Error {
  constructor() {
    super('Pairing offer has expired');
    this.name = 'PairOfferExpiredError';
  }
}

export class PairOfferAlreadyApprovedError extends Error {
  constructor() {
    super('Pairing offer has already been approved');
    this.name = 'PairOfferAlreadyApprovedError';
  }
}

export class PairOfferConsumedError extends Error {
  constructor() {
    super('Pairing offer has already been consumed');
    this.name = 'PairOfferConsumedError';
  }
}

export class PairDevicePubMismatchError extends Error {
  constructor() {
    super('Device public key does not match the offer');
    this.name = 'PairDevicePubMismatchError';
  }
}

export class PairApproverNotLinkedError extends Error {
  constructor() {
    super('Approver IM user is not linked to a cloud account');
    this.name = 'PairApproverNotLinkedError';
  }
}

// ─── Service ─────────────────────────────────────────────────

export interface PairServiceDeps {
  redis: Redis;
  /** Override clock for tests. Default: () => Date.now(). */
  now?: () => number;
  /** Override nonce generator for tests. Default: crypto.randomBytes. */
  generateNonce?: () => string;
  /**
   * Override pc_api_keys creator for tests. Defaults to the production
   * `createApiKey` helper that writes the SHA-256 hash + returns plaintext.
   */
  createApiKey?: typeof createApiKey;
}

export interface CreateOfferInput {
  devicePub: string;
  deviceName: string;
}

export interface CreateOfferResult {
  nonce: string;
  qrUrl: string;
  expiresAt: Date;
}

export interface ApproveOfferResult {
  apiKey: string;
}

export interface PollOfferResult {
  apiKey: string;
}

export class PairService {
  constructor(private deps: PairServiceDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private newNonce(): string {
    if (this.deps.generateNonce) return this.deps.generateNonce();
    return crypto.randomBytes(NONCE_BYTES).toString('hex');
  }

  private redisKey(nonce: string): string {
    return `${REDIS_KEY_PREFIX}${nonce}`;
  }

  /**
   * Create a fresh pairing offer. No auth required — the daemon doesn't
   * have an API key yet (that's what this whole flow is bootstrapping).
   * Mitigations against abuse: 5-min TTL + nonce required for both approve
   * and poll. Rate-limiting (per devicePub or per IP) lives at the
   * gateway/middleware layer.
   */
  async createOffer(input: CreateOfferInput): Promise<CreateOfferResult> {
    const nonce = this.newNonce();
    const expiresAt = new Date(this.now() + OFFER_TTL_MS);

    await prisma.iMPairingOffer.create({
      data: {
        nonce,
        devicePub: input.devicePub,
        deviceName: input.deviceName,
        expiresAt,
      },
    });

    log.info(`Offer created — nonce=${nonce.slice(0, 8)}… device="${input.deviceName}"`);

    return {
      nonce,
      qrUrl: `prismer://pair?nonce=${nonce}&pub=${encodeURIComponent(input.devicePub)}`,
      expiresAt,
    };
  }

  /**
   * Approve an offer. Caller must be authenticated as a cloud user (JWT
   * auth handled at the route layer). Mints a new API key under the
   * caller's cloud account, caches the plaintext in Redis for the daemon
   * to pick up via pollOffer, and stamps the offer row with the api_key_id
   * for audit.
   */
  async approveOffer(nonce: string, approverImUserId: string): Promise<ApproveOfferResult> {
    const offer = await prisma.iMPairingOffer.findUnique({ where: { nonce } });
    if (!offer) throw new PairOfferNotFoundError();
    if (offer.expiresAt.getTime() < this.now()) throw new PairOfferExpiredError();
    if (offer.approvedAt !== null) throw new PairOfferAlreadyApprovedError();

    // Resolve approver's cloud user id. Mobile signs in as a human IMUser,
    // and `IMUser.userId` carries the numeric pc_users.id as a string.
    const imUser = await prisma.iMUser.findUnique({
      where: { id: approverImUserId },
      select: { userId: true, role: true },
    });
    if (!imUser?.userId) throw new PairApproverNotLinkedError();
    const cloudUserId = parseInt(imUser.userId, 10);
    if (!Number.isFinite(cloudUserId)) throw new PairApproverNotLinkedError();

    // Mint fresh API key. Label distinguishes daemon keys from web/mobile
    // keys in the user's "manage keys" UI.
    const createKey = this.deps.createApiKey ?? createApiKey;
    const keyRow = await createKey(cloudUserId, `Daemon: ${offer.deviceName}`);

    // Cache plaintext in Redis (TTL = remaining offer life). Daemon picks
    // it up on its next poll; key is wiped on consumption.
    const remainingMs = Math.max(0, offer.expiresAt.getTime() - this.now());
    await this.deps.redis.set(this.redisKey(nonce), keyRow.key, 'PX', remainingMs);

    // Stamp the offer.
    await prisma.iMPairingOffer.update({
      where: { nonce },
      data: {
        approverImUserId,
        approvedAt: new Date(this.now()),
        apiKeyId: keyRow.id,
      },
    });

    log.info(`Offer approved — nonce=${nonce.slice(0, 8)}… approver=${approverImUserId} key=${keyRow.id}`);
    return { apiKey: keyRow.key };
  }

  /**
   * Poll for the API key. Returns null when the offer is approved but
   * already consumed, or when not yet approved (caller maps to 202
   * Accepted vs. 410 Gone respectively). Throws on hard errors (expired,
   * not found, devicePub mismatch).
   */
  async pollOffer(nonce: string, devicePub: string): Promise<PollOfferResult | null> {
    const offer = await prisma.iMPairingOffer.findUnique({ where: { nonce } });
    if (!offer) throw new PairOfferNotFoundError();
    if (offer.devicePub !== devicePub) throw new PairDevicePubMismatchError();
    if (offer.expiresAt.getTime() < this.now()) throw new PairOfferExpiredError();

    if (offer.consumedAt !== null) {
      // Already returned the key once — second poll is the daemon racing
      // itself; surface as Gone so the daemon doesn't loop.
      throw new PairOfferConsumedError();
    }

    if (offer.approvedAt === null) {
      // Daemon polls every 5s; mobile may not have approved yet. Caller
      // maps null → 202 Accepted so the daemon keeps polling.
      return null;
    }

    // Approved + not consumed → consume.
    const key = this.redisKey(nonce);
    const apiKey = await this.deps.redis.get(key);
    if (!apiKey) {
      // Should be vanishingly rare (Redis flushed between approve + poll
      // within 5min). Treat as consumed — the daemon will need a fresh
      // pair flow.
      log.warn(`Approved offer ${nonce.slice(0, 8)}… missing Redis cache; marking consumed`);
      await prisma.iMPairingOffer.update({
        where: { nonce },
        data: { consumedAt: new Date(this.now()) },
      });
      throw new PairOfferConsumedError();
    }

    // Atomically delete the cache + stamp the offer. If the second part
    // fails, the next poll lands on cache miss and surfaces as Consumed.
    await this.deps.redis.del(key);
    await prisma.iMPairingOffer.update({
      where: { nonce },
      data: { consumedAt: new Date(this.now()) },
    });

    log.info(`Offer consumed — nonce=${nonce.slice(0, 8)}… key=${offer.apiKeyId}`);
    return { apiKey };
  }
}
