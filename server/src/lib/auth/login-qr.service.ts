/**
 * Login-QR (F2) Service — account scan-login web → mobile.
 *
 * A web-authenticated user displays an account-login QR; an unauthenticated
 * mobile device scans it; the web user **explicitly confirms** (mandatory
 * second confirmation — defeats shoulder-surf credential theft); the mobile
 * device then receives a session JWT for the **web user's account** =
 * "log this account into a new device".
 *
 * Credential direction is the inverse of daemon pairing (pair.service.ts):
 * there a NEW device gets a freshly-minted API key; here an EXISTING logged-in
 * session is granted to the scanning device. Because the human in the loop is
 * authorizing a *login to their own account from another device*, the second
 * confirmation is NOT optional.
 *
 * State machine (all in Redis, key = offerId, TTL = 120s, single-use):
 *
 *   create   (web JWT)      → state=pending          { offerId, qrPayload, expiresAt }
 *   consume  (public)       → state=pending_confirm  { } + consumerDevice  (NEVER a token)
 *   confirm  (web JWT)      → state=approved         mints session JWT for offer.userId
 *   result   (public, poll) → pending | pending_confirm | approved(+token, once) | gone | expired
 *
 * Why Redis-ephemeral (no table / no migration): the offer is a ≤2-minute
 * single-use handshake. There is no stated requirement to persist an audit
 * row of every QR login. Redis with a 120s TTL keeps the minted token out of
 * durable storage and self-cleans; single-use is enforced by DELeting the key
 * the first time `result` hands back the token.
 */

import crypto from 'node:crypto';
import { redis } from './redis';
import { mintSessionToken } from './local-auth';

// ─── Constants ───────────────────────────────────────────────

/** Logical offer TTL — short enough that a stale on-screen QR is harmless. */
const OFFER_TTL_MS = 120 * 1000;

/**
 * Redis TTL is a bit longer than the logical TTL so that an offer which
 * just logically expired can still be *read* and reported as `expired`
 * (rather than silently vanishing into `gone`). The blob carries its own
 * `expiresAt`; logical expiry is computed from that, not from key presence.
 */
const REDIS_TTL_SECONDS = 180;

const REDIS_KEY_PREFIX = 'login-qr:offer:';

/** 24 bytes = 48 hex chars; unguessable within the 2-min window. */
const OFFER_ID_BYTES = 24;

/** 32 bytes = 64 hex chars; per-consume device-binding secret ([SYNC-6]). */
const CONSUMER_TOKEN_BYTES = 32;

const MAX_DEVICE_NAME = 128;

export type LoginQrStatus = 'pending' | 'pending_confirm' | 'approved';

// ─── Errors ──────────────────────────────────────────────────

export type LoginQrErrorCode = 'OFFER_NOT_FOUND' | 'OFFER_EXPIRED' | 'OFFER_GONE' | 'OFFER_FORBIDDEN' | 'BAD_STATE';

export class LoginQrError extends Error {
  constructor(
    public code: LoginQrErrorCode,
    public httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = 'LoginQrError';
  }
}

// ─── Stored shape ────────────────────────────────────────────

interface OfferRecord {
  offerId: string;
  /** Canonical IMUser.id (cuid) of the web user who created the offer. */
  userId: string;
  status: LoginQrStatus;
  /** Device label supplied by the scanning mobile client at consume time. */
  consumerDevice?: string;
  /**
   * Per-consume secret minted on `consume` and returned ONLY to the scanning
   * device (never in the public `result` poll). The CURRENT pending consumer's
   * token. A later consume overwrites it (that device supersedes the earlier).
   */
  consumerToken?: string;
  /**
   * The consumerToken the web user actually confirmed (bound at confirm time =
   * whichever device was pending when the user clicked confirm). `result` only
   * hands the session token to the device whose consumerToken matches THIS,
   * closing the multi-device race ([SYNC-6]).
   */
  approvedConsumerToken?: string;
  createdAt: number;
  expiresAt: number;
  /**
   * Minted session token, present only once `status === 'approved'`. It is
   * written at confirm time and read+wiped (whole key DELeted) the first time
   * `result` returns it — that DELETE is the single-use enforcement.
   */
  token?: string;
  imUserId?: string;
  numericId?: number;
}

// ─── Dependency seam (tests can override clock / id gen) ──────

export interface LoginQrDeps {
  now?: () => number;
  generateOfferId?: () => string;
  /** Override token minter for tests. Default: local-auth.mintSessionToken. */
  mintSessionToken?: typeof mintSessionToken;
}

// ─── Service ─────────────────────────────────────────────────

export class LoginQrService {
  constructor(private deps: LoginQrDeps = {}) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private newOfferId(): string {
    if (this.deps.generateOfferId) return this.deps.generateOfferId();
    return crypto.randomBytes(OFFER_ID_BYTES).toString('hex');
  }

  private redisKey(offerId: string): string {
    return `${REDIS_KEY_PREFIX}${offerId}`;
  }

  private async load(offerId: string): Promise<OfferRecord> {
    const raw = await redis.get(this.redisKey(offerId));
    if (!raw) {
      // The key is gone: either it was never created, it expired past the
      // Redis TTL, or it was consumed (token already handed out + DELeted).
      // From the caller's POV all three are unrecoverable; surface as gone.
      throw new LoginQrError('OFFER_GONE', 410, 'Login offer is no longer available');
    }
    let rec: OfferRecord;
    try {
      rec = JSON.parse(raw) as OfferRecord;
    } catch {
      throw new LoginQrError('OFFER_GONE', 410, 'Login offer is corrupted');
    }
    if (rec.expiresAt <= this.now()) {
      throw new LoginQrError('OFFER_EXPIRED', 410, 'Login offer has expired');
    }
    return rec;
  }

  private async save(rec: OfferRecord): Promise<void> {
    await redis.setex(this.redisKey(rec.offerId), REDIS_TTL_SECONDS, JSON.stringify(rec));
  }

  /**
   * create — web user (authenticated) generates a login offer.
   *
   * `userId` is the canonical IMUser.id from the caller's verified JWT. The
   * minted token (later) will be for THIS user, i.e. the web user grants
   * their own session to whoever scans + they then confirm.
   */
  async create(userId: string): Promise<{ offerId: string; qrPayload: string; expiresAt: string }> {
    const offerId = this.newOfferId();
    const createdAt = this.now();
    const expiresAt = createdAt + OFFER_TTL_MS;

    const rec: OfferRecord = {
      offerId,
      userId,
      status: 'pending',
      createdAt,
      expiresAt,
    };
    await this.save(rec);

    return {
      offerId,
      qrPayload: `prismer://login-qr?offer=${offerId}`,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  /**
   * consume — mobile (public, unauthenticated) registers that a device is
   * waiting on this offer + its device label. Transitions pending →
   * pending_confirm. NEVER returns a token: only `confirm` can move the offer
   * to `approved`, and only then does `result` mint/return a token.
   *
   * Returns a fresh per-consume `consumerToken` to THIS device. The mobile must
   * keep it private and present it on `result`; only the device whose token the
   * web user confirmed gets the session ([SYNC-6] race fix). A later consume
   * mints a new token + overwrites the pending consumer (it supersedes earlier
   * scanners); each device should use the token from its most recent consume.
   */
  async consume(
    offerId: string,
    consumerDevice: string,
  ): Promise<{ status: LoginQrStatus; consumerToken: string }> {
    const rec = await this.load(offerId);

    if (rec.status === 'approved') {
      // Already approved+confirmed — nothing to consume; the device should
      // be polling `result` for its token.
      throw new LoginQrError('BAD_STATE', 409, 'Login offer already approved');
    }

    const consumerToken = crypto.randomBytes(CONSUMER_TOKEN_BYTES).toString('hex');
    rec.status = 'pending_confirm';
    rec.consumerDevice = consumerDevice.slice(0, MAX_DEVICE_NAME);
    rec.consumerToken = consumerToken;
    await this.save(rec);

    return { status: rec.status, consumerToken };
  }

  /**
   * confirm — web user (authenticated) approves the waiting device. This is
   * the MANDATORY second confirmation. Guards:
   *   - caller's IMUser.id MUST equal offer.userId (can't confirm someone
   *     else's offer)
   *   - offer MUST be in pending_confirm (a device must have scanned first;
   *     you can't pre-approve an offer nobody is waiting on)
   *
   * On success mints a session JWT for offer.userId and stashes it in the
   * record; `result` hands it back exactly once.
   */
  async confirm(offerId: string, callerUserId: string): Promise<{ status: LoginQrStatus }> {
    const rec = await this.load(offerId);

    if (rec.userId !== callerUserId) {
      throw new LoginQrError('OFFER_FORBIDDEN', 403, 'This login offer does not belong to you');
    }
    if (rec.status === 'approved') {
      // Idempotent re-confirm of one's own offer.
      return { status: 'approved' };
    }
    if (rec.status !== 'pending_confirm') {
      throw new LoginQrError(
        'BAD_STATE',
        409,
        'No device is waiting on this offer yet (must be scanned before it can be confirmed)',
      );
    }

    const mint = this.deps.mintSessionToken ?? mintSessionToken;
    const minted = await mint(rec.userId);
    if (!minted) {
      throw new LoginQrError('BAD_STATE', 409, 'Cannot mint a session for this account');
    }

    rec.status = 'approved';
    // Bind the session to the consumerToken that was pending at confirm time —
    // i.e. the device whose name the web user is looking at. Only that device's
    // `result` poll (matching consumerToken) gets the session ([SYNC-6]).
    rec.approvedConsumerToken = rec.consumerToken;
    rec.token = minted.token;
    rec.imUserId = minted.imUserId;
    rec.numericId = minted.numericId;
    await this.save(rec);

    return { status: 'approved' };
  }

  /**
   * result — polls offer state. `consumerToken` (from the device's own
   * `consume`) gates the session handoff ([SYNC-6]):
   *   - { status:'pending' }          — created, not yet scanned
   *   - { status:'pending_confirm', consumerDevice } — scanned, awaiting web
   *       confirmation; NO token. (The web polls WITHOUT consumerToken to read
   *       the device name for its confirm UI.)
   *   - { status:'superseded' }       — a later device consumed this offer and
   *       replaced you; stop polling. (Only when a stale consumerToken is given.)
   *   - { status:'approved', token, imUserId, numericId } — ONCE, ONLY to the
   *       device whose consumerToken === the confirmed one; then the key is
   *       DELeted so the next poll throws OFFER_GONE (410). Single-use.
   *   - { status:'denied' }           — approved, but for a DIFFERENT device
   *       (your consumerToken isn't the one the web user confirmed). NO token.
   *
   * Token is ONLY ever present in the approved+matching branch.
   */
  async result(
    offerId: string,
    consumerToken?: string,
  ): Promise<
    | { status: 'pending' }
    | { status: 'pending_confirm'; consumerDevice?: string }
    | { status: 'superseded' }
    | { status: 'denied' }
    | { status: 'approved'; token: string; imUserId: string; numericId: number }
  > {
    const rec = await this.load(offerId);

    if (rec.status === 'pending_confirm') {
      // A device that presents a stale consumerToken (a later scan replaced it)
      // learns it was superseded so it can stop polling. The web poll (no
      // consumerToken) always sees the current device name for its confirm UI.
      if (consumerToken && rec.consumerToken && consumerToken !== rec.consumerToken) {
        return { status: 'superseded' };
      }
      // Surface the scanning device name so the web confirm UI can show
      // "<device> wants to log in" — the user must be able to recognize/reject
      // a shoulder-surf scan. offerId-gated (48-hex QR secret), device name is
      // a low-sensitivity user-provided string.
      return { status: 'pending_confirm', consumerDevice: rec.consumerDevice };
    }
    if (rec.status !== 'approved') {
      return { status: rec.status };
    }

    // Approved: hand the session ONLY to the device the web user confirmed.
    // A mismatched/absent consumerToken (e.g. an earlier scanner, or the web's
    // own token-less poll) is denied — the offer stays alive until the right
    // device burns it (or it expires).
    if (consumerToken === undefined || consumerToken !== rec.approvedConsumerToken) {
      return { status: 'denied' };
    }

    if (!rec.token || !rec.imUserId) {
      // Defensive: approved without a token should be impossible.
      throw new LoginQrError('BAD_STATE', 409, 'Approved offer is missing its session');
    }
    const token = rec.token;
    const imUserId = rec.imUserId;
    const numericId = rec.numericId ?? 0;

    await redis.del(this.redisKey(offerId));

    return { status: 'approved', token, imUserId, numericId };
  }
}

/** Process-wide singleton — the service is stateless (Redis-backed). */
export const loginQrService = new LoginQrService();
