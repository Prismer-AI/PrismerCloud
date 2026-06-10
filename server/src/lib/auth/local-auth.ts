import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import prisma from '@/lib/prisma';
import { redis } from '@/lib/auth/redis';

// ─── Types ────────────────────────────────────────────────────

type AuthProvider = 'email' | 'google' | 'github' | 'apple' | 'twitter' | 'sms';
type CodeType = 'signup' | 'reset-password';

/**
 * Internal record shape — maps to IMUser fields (auth columns added by migration 130).
 */
interface AuthUserRecord {
  id: string;
  numericId?: bigint | number | null;
  email?: string | null;
  phone?: string | null;
  passwordHash?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
  googleId?: string | null;
  githubId?: string | null;
  appleId?: string | null;
  twitterId?: string | null;
  banned: boolean;
  suspendedUntil?: Date | null;
  emailVerified?: boolean | null;
  metadata?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthUser {
  id: number;
  name?: string;
  email: string;
  phone?: string;
  avatar: string;
  is_active: boolean;
  email_verified: boolean;
  last_login_at: string;
  google_id: string;
  github_id: string;
  apple_id: string;
  twitter_id: string;
  created_at: string;
  updated_at: string;
  deleted_at: null;
}

export interface AuthResponse {
  user: AuthUser;
  token: string;
  expires_in: number;
}

export class LocalAuthError extends Error {
  constructor(
    public status: number,
    public code: number,
    message: string,
  ) {
    super(message);
    this.name = 'LocalAuthError';
  }
}

// ─── Constants ───────────────────────────────────────────────

const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
// Aligned with Go backend: 5min TTL, 60s send rate-limit, 5 verify attempts,
// 10 sends per email per calendar day.
const EMAIL_CODE_TTL_SECONDS = 5 * 60;
const EMAIL_CODE_RATE_SECONDS = 60;
const EMAIL_CODE_MAX_ATTEMPTS = 5;
const EMAIL_CODE_DAILY_LIMIT = 10;
const SMS_CODE_TTL_SECONDS = 10 * 60;
const SMS_CODE_RATE_SECONDS = 60;
const SMS_CODE_MAX_ATTEMPTS = 5;

// ─── Helpers ─────────────────────────────────────────────────

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET || process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new LocalAuthError(500, 500, 'JWT_SECRET is not configured');
  }
  return secret;
}

function emailCodeKey(type: CodeType, email: string): string {
  return `auth:email-code:${type}:${normalizeEmail(email)}`;
}
function emailRateKey(type: CodeType, email: string): string {
  return `auth:email-code-rate:${type}:${normalizeEmail(email)}`;
}
function emailAttemptsKey(type: CodeType, email: string): string {
  return `auth:email-code-attempts:${type}:${normalizeEmail(email)}`;
}
function emailDailyCountKey(email: string): string {
  // Per-email, calendar-day bucket. UTC date is fine — daily limit is
  // a coarse anti-abuse guard, not a billing window.
  const day = new Date().toISOString().slice(0, 10);
  return `auth:email-code-daily:${day}:${normalizeEmail(email)}`;
}
function smsCodeKey(phone: string): string {
  return `auth:sms-code:${phone}`;
}
function smsRateKey(phone: string): string {
  return `auth:sms-code-rate:${phone}`;
}
function smsAttemptsKey(phone: string): string {
  return `auth:sms-code-attempts:${phone}`;
}

/** "Active" = not banned AND (not suspended OR suspension expired). */
function isUserActive(user: AuthUserRecord): boolean {
  if (user.banned) return false;
  if (user.suspendedUntil && user.suspendedUntil > new Date()) return false;
  return true;
}

/**
 * Safely parse the IMUser.metadata JSON blob.
 *
 * If the blob is corrupted (manual edit, charset truncation, prior bug),
 * we MUST NOT silently overwrite the original — that's data loss. Log,
 * preserve a recovery hint, and return an empty object so callers can
 * continue. The corrupt raw value gets surfaced via log so ops can
 * forensic-recover.
 */
function parseMetadataSafe(blob: string | null | undefined, userId: string): Record<string, unknown> {
  if (!blob) return {};
  try {
    const parsed = JSON.parse(blob);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    console.warn('[Auth] metadata parsed to non-object', { userId, type: typeof parsed });
    return { __corruptAt: new Date().toISOString(), __raw: String(blob).slice(0, 500) };
  } catch (err) {
    console.error('[Auth] metadata JSON.parse failed — preserving raw for recovery', {
      userId,
      err: (err as Error).message,
      raw: blob.slice(0, 200),
    });
    return { __corruptAt: new Date().toISOString(), __raw: blob.slice(0, 500) };
  }
}

function getLastLoginAt(user: AuthUserRecord): Date | null {
  if (!user.metadata) return null;
  const m = parseMetadataSafe(user.metadata, user.id);
  if (m.lastLoginAt && typeof m.lastLoginAt === 'string') return new Date(m.lastLoginAt);
  return null;
}

/**
 * Lazy-allocate numericId for legacy rows (created via Go backend) that
 * have NULL numericId. Idempotent — no-op if numericId is already set.
 *
 * Implementation: we update the row to itself with a sentinel and rely on
 * MySQL's AUTO_INCREMENT trigger via INSERT ... SELECT trick. Since Prisma
 * can't do that directly, we instead create a temporary throwaway row and
 * use its allocated numericId, then assign it via raw SQL. Simpler: do a
 * raw query that uses MAX+1 in a transaction to avoid the throwaway.
 */
async function ensureNumericId(user: AuthUserRecord): Promise<AuthUserRecord> {
  if (user.numericId != null && asNumber(user.numericId) > 0) return user;
  try {
    // MySQL idiom: `LAST_INSERT_ID(expr)` lets us read+set the auto_increment
    // counter atomically. Use a transaction to fetch next, then assign.
    await (prisma as any).$executeRawUnsafe(
      `UPDATE im_users
       SET numericId = (SELECT IFNULL(MAX(t.numericId), 0) + 1 FROM (SELECT numericId FROM im_users) AS t)
       WHERE id = ? AND numericId IS NULL`,
      user.id,
    );
    const refreshed = (await (prisma as any).iMUser.findUnique({ where: { id: user.id } })) as AuthUserRecord | null;
    return refreshed ?? user;
  } catch (err) {
    console.error('[Auth] ensureNumericId failed', { userId: user.id, err: (err as Error).message });
    return user;
  }
}

function asNumber(v: bigint | number | null | undefined): number {
  if (v == null) return 0;
  return typeof v === 'bigint' ? Number(v) : v;
}

function toAuthUser(user: AuthUserRecord): AuthUser {
  return {
    id: asNumber(user.numericId),
    name: user.displayName ?? undefined,
    email: user.email ?? '',
    phone: user.phone ?? undefined,
    avatar: user.avatarUrl ?? '',
    is_active: isUserActive(user),
    email_verified: user.emailVerified ?? false,
    last_login_at: getLastLoginAt(user)?.toISOString() ?? '',
    google_id: user.googleId ?? '',
    github_id: user.githubId ?? '',
    apple_id: user.appleId ?? '',
    twitter_id: user.twitterId ?? '',
    created_at: user.createdAt.toISOString(),
    updated_at: user.updatedAt.toISOString(),
    deleted_at: null,
  };
}

function issueToken(user: AuthUserRecord, _type: AuthProvider): string {
  // Shape aligned with src/im/auth/jwt.ts JWTPayload contract: { sub,
  // username, role, email?, ... }. `username` is required by IM ws/sse
  // handshake; we fall back to the displayName / email-prefix if not set.
  const fallbackUsername =
    (user as any).username || user.displayName || (user.email ? user.email.split('@')[0] : user.id);
  return jwt.sign(
    {
      sub: user.id,
      username: fallbackUsername,
      role: 'human',
      numericId: asNumber(user.numericId) || undefined,
      email: user.email ?? '',
    },
    getJwtSecret(),
    { expiresIn: TOKEN_TTL_SECONDS } as jwt.SignOptions,
  );
}

function toAuthResponse(user: AuthUserRecord, type: AuthProvider): AuthResponse {
  return {
    user: toAuthUser(user),
    token: issueToken(user, type),
    expires_in: TOKEN_TTL_SECONDS,
  };
}

/** Read-modify-write metadata.lastLoginAt. */
async function updateLastLoginAt(userId: string): Promise<AuthUserRecord> {
  const existing = (await (prisma as any).iMUser.findUnique({ where: { id: userId } })) as AuthUserRecord | null;
  const current = parseMetadataSafe(existing?.metadata, userId);
  current.lastLoginAt = new Date().toISOString();
  return (await (prisma as any).iMUser.update({
    where: { id: userId },
    data: { metadata: JSON.stringify(current) },
  })) as AuthUserRecord;
}

function constantTimeCodeMatches(inputCode: string, storedCode: string): boolean {
  const input = String(inputCode).padEnd(8, '0');
  const stored = String(storedCode).padEnd(8, '0');
  const inputBuffer = Buffer.from(input, 'utf8');
  const storedBuffer = Buffer.from(stored, 'utf8');
  return inputBuffer.length === storedBuffer.length && crypto.timingSafeEqual(inputBuffer, storedBuffer);
}

async function validateEmailCode(email: string, code: string, type: CodeType, consume: boolean): Promise<void> {
  const key = emailCodeKey(type, email);
  const attemptsKey = emailAttemptsKey(type, email);
  const attemptsStr = await redis.get(attemptsKey);
  const attempts = Number(attemptsStr) || 0;

  if (attempts >= EMAIL_CODE_MAX_ATTEMPTS) {
    await redis.del(key);
    await redis.del(attemptsKey);
    throw new LocalAuthError(429, 429, 'Too many attempts. Please request a new code.');
  }

  const storedCode = await redis.get(key);

  if (!storedCode || !constantTimeCodeMatches(code, storedCode)) {
    await redis.setex(attemptsKey, EMAIL_CODE_TTL_SECONDS, String(attempts + 1));
    throw new LocalAuthError(400, 400, 'Invalid or expired verification code');
  }

  await redis.del(attemptsKey);
  if (consume) {
    await redis.del(key);
  }
}

async function validateSmsCode(phone: string, code: string, consume: boolean): Promise<void> {
  const key = smsCodeKey(phone);
  const attemptsKey = smsAttemptsKey(phone);
  const attempts = Number(await redis.get(attemptsKey)) || 0;
  if (attempts >= SMS_CODE_MAX_ATTEMPTS) {
    await redis.del(key);
    await redis.del(attemptsKey);
    throw new LocalAuthError(429, 429, 'Too many attempts. Please request a new code.');
  }
  const storedCode = await redis.get(key);
  if (!storedCode || !constantTimeCodeMatches(code, storedCode)) {
    await redis.setex(attemptsKey, SMS_CODE_TTL_SECONDS, String(attempts + 1));
    throw new LocalAuthError(400, 400, 'Invalid or expired SMS code');
  }
  await redis.del(attemptsKey);
  if (consume) {
    await redis.del(key);
  }
}

// ─── Public API: email verification code ─────────────────────

/**
 * Wire shape aligned with Go backend's gin wrapper: success envelope is
 * `{code: 200, message: "Success"}`. Optional dev/debug fields
 * (verification_code, provider) ride alongside.
 */
/**
 * LAN-dev mode: cloud running with `LOCAL_ONLY=1` (no Nacos, no email
 * provider) on a non-production Node runtime. In this mode we want a
 * predictable, well-known verification code so any client (iPhone over
 * LAN, browser, curl) can complete signup without an out-of-band code
 * relay. See sendEmailVerificationCode below.
 *
 * Gate hardening — both must hold:
 *   - LOCAL_ONLY=1
 *   - NODE_ENV !== 'production'
 *
 * Mirrors the existing nacos-config.ts:443 gate. Dockerfile pins
 * NODE_ENV=production for prod images so the second clause cannot leak.
 */
function isLocalOnlyDev(): boolean {
  return process.env.LOCAL_ONLY === '1' && process.env.NODE_ENV !== 'production';
}

/** Well-known LAN-dev verification code. Constant — see isLocalOnlyDev. */
const LOCAL_ONLY_DEV_OTP = '000000';

/**
 * Strict prod check for whether the verification code may ride in the
 * response body. Defense-in-depth: refuses to expose in prod even if
 * AUTH_EMAIL_CODE_RETURN_IN_RESPONSE is mistakenly set true via Nacos.
 *
 * LOCAL_ONLY=1 implicitly opts in (LAN dev has no email provider, the
 * fixed code is the whole point — no security delta vs the existing
 * dev-flag path).
 */
function shouldExposeCodeInResponse(): boolean {
  const isProd = process.env.NODE_ENV === 'production' || process.env.APP_ENV === 'prod';
  if (isProd) return false;
  if (isLocalOnlyDev()) return true;
  return process.env.AUTH_EMAIL_CODE_RETURN_IN_RESPONSE === 'true';
}

export async function sendEmailVerificationCode(input: { email: string; type: CodeType }): Promise<{
  code: number;
  message: string;
  verification_code?: string;
  provider?: string;
  dev_mode?: boolean;
}> {
  const email = normalizeEmail(input.email);
  if (!email) throw new LocalAuthError(400, 400, 'Email is required');

  // Per-(type,email) 60s rate limit. Atomic SET-NX so the gate itself is
  // race-free (concurrent senders see exactly one winner).
  const rateKey = emailRateKey(input.type, email);
  const isRateLimited = await redis.exists(rateKey);
  if (isRateLimited) {
    throw new LocalAuthError(429, 429, 'Please wait 60 seconds before requesting again');
  }

  // Per-(email, day) daily quota. INCR-with-TTL is atomic — concurrent
  // senders can't both pass at the boundary.
  const dailyKey = emailDailyCountKey(email);
  const dailyCount = await redis.incrWithTtl(dailyKey, 24 * 60 * 60);
  if (dailyCount > EMAIL_CODE_DAILY_LIMIT) {
    throw new LocalAuthError(
      429,
      429,
      `Daily limit reached (${EMAIL_CODE_DAILY_LIMIT}/day). Please try again tomorrow.`,
    );
  }

  // LAN-dev path: deterministic code, no email provider call. Redis flow
  // is identical (same TTL, same attempts counter, same constant-time
  // compare on validate) — only the code itself is well-known.
  const devBypass = isLocalOnlyDev();
  const code = devBypass ? LOCAL_ONLY_DEV_OTP : String(crypto.randomInt(100000, 999999));

  // Order matters: set the rate-limit gate FIRST so a process kill between
  // setex calls can't leave a usable code with no rate gate. Then cache the
  // code; only after both succeed do we attempt provider dispatch. Also
  // clear any stale attempts counter so a fresh code starts with a fresh
  // 5-attempt budget (otherwise a user who mistyped 4 times then waited
  // for the code to expire and re-requested a new one would only get 1
  // attempt on the fresh code).
  await redis.setex(rateKey, EMAIL_CODE_RATE_SECONDS, '1');
  await redis.del(emailAttemptsKey(input.type, email));
  await redis.setex(emailCodeKey(input.type, email), EMAIL_CODE_TTL_SECONDS, code);

  if (devBypass) {
    // No email provider in LAN dev — that's the whole point of
    // LOCAL_ONLY. Skip the dispatch + the "no provider configured"
    // 503. Always expose the code in the response so curl + cookbook
    // scripts work without AUTH_EMAIL_CODE_RETURN_IN_RESPONSE; iPhone
    // users type the well-known `000000`.
    return {
      code: 200,
      message: 'Success',
      verification_code: code,
      provider: 'local-only-dev',
      dev_mode: true,
    };
  }

  const { sendVerificationEmail } = await import('@/lib/auth/email');
  const dispatch = await sendVerificationEmail(email, code, input.type);

  const exposeCode = shouldExposeCodeInResponse();

  if (dispatch.configured && !dispatch.success) {
    throw new LocalAuthError(502, 502, `Email provider error: ${dispatch.error || 'send failed'}`);
  }
  if (!dispatch.configured && !exposeCode) {
    throw new LocalAuthError(503, 503, 'Email delivery provider is not configured');
  }

  return {
    code: 200,
    message: 'Success',
    ...(dispatch.success ? { provider: dispatch.provider } : {}),
    ...(exposeCode ? { verification_code: code } : {}),
  };
}

export async function verifyEmailCode(input: {
  email: string;
  code: string;
  type: CodeType;
}): Promise<{ code: number; message: string }> {
  const email = normalizeEmail(input.email);
  await validateEmailCode(email, input.code, input.type, false);
  return { code: 200, message: 'Success' };
}

// ─── Public API: email password ──────────────────────────────

/**
 * Password verification with dual-format support for legacy Go-backend hashes.
 *
 * Storage formats in the wild:
 *   - bcrypt: starts with "$2a$" / "$2b$" / "$2y$" — new native-auth users
 *   - raw SHA256 hex: 64 hex chars — Go-backend legacy users (prismer_info.users)
 *
 * On a legacy SHA256 match we transparently re-hash to bcrypt and persist —
 * lazy migration so eventually all rows converge to bcrypt without forcing
 * a password reset.
 */
function isBcryptHash(s: string): boolean {
  return /^\$2[aby]\$/.test(s);
}

function isSha256Hex(s: string): boolean {
  return /^[a-f0-9]{64}$/i.test(s);
}

/**
 * In-process guard against concurrent rehash storms. N parallel logins for
 * a hot legacy account would each spend ~250ms CPU on bcrypt + issue a
 * separate UPDATE. With this guard, only one rehash runs per user at a
 * time; later concurrent logins still succeed via raw SHA256 path.
 */
const rehashInFlight = new Set<string>();

async function verifyAndMaybeRehash(userId: string, storedHash: string, clientHash: string): Promise<boolean> {
  if (isBcryptHash(storedHash)) {
    return bcrypt.compare(clientHash, storedHash);
  }
  if (isSha256Hex(storedHash)) {
    const a = Buffer.from(storedHash.toLowerCase(), 'utf8');
    const b = Buffer.from(clientHash.toLowerCase(), 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;

    // Lazy migrate to bcrypt. Skip if a rehash is already in-flight for
    // this user (another concurrent login won the race) — login still
    // succeeds, the other request will write the upgraded hash.
    if (!rehashInFlight.has(userId)) {
      rehashInFlight.add(userId);
      try {
        const upgraded = await bcrypt.hash(clientHash, 12);
        // WHERE-clause guard: only update if the row STILL has the legacy
        // raw SHA256 hash. Defends against last-writer-wins races where a
        // change-password ran between the verify and the update.
        await (prisma as any).iMUser.update({
          where: { id: userId, passwordHash: storedHash },
          data: { passwordHash: upgraded },
        });
      } catch (err) {
        console.warn('[Auth] lazy rehash failed; will retry next login', {
          userId,
          err: (err as Error).message,
        });
      } finally {
        rehashInFlight.delete(userId);
      }
    }
    return true;
  }
  return false;
}

export async function loginWithPassword(email: string, passwordHash: string): Promise<AuthResponse> {
  // passwordHash is SHA256(plaintext) hex, posted by the frontend. New rows
  // store bcrypt(SHA256); legacy Go-backend rows store raw SHA256. The
  // verifier handles both and lazy-migrates legacy rows on success.
  const norm = normalizeEmail(email);
  const user = (await (prisma as any).iMUser.findFirst({
    where: { email: norm, role: 'human' },
  })) as AuthUserRecord | null;

  if (!user?.passwordHash || !isUserActive(user)) {
    throw new LocalAuthError(401, 401, 'Invalid email or password');
  }
  const isValid = await verifyAndMaybeRehash(user.id, user.passwordHash, passwordHash);
  if (!isValid) {
    throw new LocalAuthError(401, 401, 'Invalid email or password');
  }
  const updated = await updateLastLoginAt(user.id);
  return toAuthResponse(updated, 'email');
}

export async function registerWithPassword(
  email: string,
  passwordHash: string,
  confirmPasswordHash: string,
  code: string,
): Promise<AuthResponse> {
  const norm = normalizeEmail(email);
  if (!norm || !passwordHash || !confirmPasswordHash || !code) {
    throw new LocalAuthError(400, 400, 'All fields are required');
  }
  if (passwordHash !== confirmPasswordHash) {
    throw new LocalAuthError(400, 400, 'Passwords do not match');
  }

  await validateEmailCode(norm, code, 'signup', true);

  const existing = await (prisma as any).iMUser.findFirst({
    where: { email: norm, role: 'human' },
  });
  if (existing) {
    throw new LocalAuthError(409, 409, 'User already exists');
  }

  const username = norm.split('@')[0] + '_' + Math.random().toString(36).slice(2, 7);
  const user = (await (prisma as any).iMUser.create({
    data: {
      email: norm,
      passwordHash: await bcrypt.hash(passwordHash, 12),
      username,
      displayName: norm.split('@')[0],
      emailVerified: true,
      role: 'human',
      metadata: JSON.stringify({ lastLoginAt: new Date().toISOString() }),
    },
  })) as AuthUserRecord;

  return toAuthResponse(user, 'email');
}

/**
 * Magic-link invite claim (passwordless). Finds-or-creates a human account
 * for an email that the caller has ALREADY resolved SERVER-SIDE from a valid,
 * pending, non-expired email-link workspace invite token (the token was
 * emailed to this address, so possessing it proves mailbox access). Returns
 * the same AuthResponse shape as login/register plus the internal imUserId so
 * the route can accept() the invite.
 *
 * SECURITY INVARIANTS (enforced by the caller + here):
 *   - `email` MUST be the inviteeEmail resolved SERVER-SIDE from the token,
 *     never a client-supplied value. The route is responsible for that
 *     resolution; this function trusts its `email` argument is token-derived.
 *   - Passwordless account creation is gated entirely behind that token
 *     resolution. There is NO code path that creates a passwordless human
 *     account without a token-derived email.
 *   - emailVerified is set true because the token IS the proof of ownership.
 *   - The created row has NO password hash (passwordHash left null) — mirrors
 *     the OAuth account-creation path, which is already passwordless. The
 *     account can later set a password via the reset-password flow (which
 *     re-proves ownership with an email code).
 *   - If the email already has an account we REUSE it (this is find-or-create,
 *     like OAuth): the invite owner explicitly addressed this mailbox, and the
 *     mintSessionToken/issueToken below is identical to a normal login token,
 *     so no privilege is gained beyond a normal sign-in to that account.
 *
 * Does NOT validate any code. Callers MUST only reach this after a successful
 * server-side token resolution; otherwise use registerWithPassword.
 */
export async function findOrCreateInvitedUser(
  email: string,
): Promise<AuthResponse & { imUserId: string }> {
  const norm = normalizeEmail(email);
  if (!norm) {
    throw new LocalAuthError(400, 400, 'Email is required');
  }

  let user = (await (prisma as any).iMUser.findFirst({
    where: { email: norm, role: 'human' },
  })) as AuthUserRecord | null;

  if (user) {
    if (!isUserActive(user)) {
      // A banned/suspended account must not be re-animated through an invite.
      throw new LocalAuthError(403, 403, 'Account is inactive');
    }
    user = await updateLastLoginAt(user.id);
  } else {
    // Passwordless create — mirror the OAuth provisioning path: same username
    // generation + displayName + emailVerified + role + metadata as
    // registerWithPassword, but NO passwordHash (column is nullable).
    const username = norm.split('@')[0] + '_' + Math.random().toString(36).slice(2, 7);
    user = (await (prisma as any).iMUser.create({
      data: {
        email: norm,
        username,
        displayName: norm.split('@')[0],
        emailVerified: true,
        role: 'human',
        metadata: JSON.stringify({ lastLoginAt: new Date().toISOString() }),
      },
    })) as AuthUserRecord;
  }

  // Lazy numericId allocation for any legacy row that lacked it (mirrors OAuth).
  user = await ensureNumericId(user);

  return { ...toAuthResponse(user, 'email'), imUserId: user.id };
}

export async function resetPasswordWithCode(
  email: string,
  code: string,
  passwordHash: string,
  confirmPasswordHash: string,
): Promise<{ code: number; message: string }> {
  const norm = normalizeEmail(email);
  if (!norm || !code || !passwordHash || !confirmPasswordHash) {
    throw new LocalAuthError(400, 400, 'All fields are required');
  }
  if (passwordHash !== confirmPasswordHash) {
    throw new LocalAuthError(400, 400, 'Passwords do not match');
  }

  await validateEmailCode(norm, code, 'reset-password', true);

  const user = (await (prisma as any).iMUser.findFirst({
    where: { email: norm, role: 'human' },
  })) as AuthUserRecord | null;
  if (!user) throw new LocalAuthError(404, 404, 'User not found');

  await (prisma as any).iMUser.update({
    where: { id: user.id },
    data: { passwordHash: await bcrypt.hash(passwordHash, 12) },
  });
  return { code: 200, message: 'Success' };
}

// ─── Public API: OAuth callbacks ─────────────────────────────

export async function loginWithGoogleAccessToken(accessToken: string): Promise<AuthResponse> {
  if (!accessToken) throw new LocalAuthError(400, 400, 'Google access token is required');

  const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
  });
  if (!userInfoRes.ok) throw new LocalAuthError(401, 401, 'Failed to fetch Google user info');

  const profile = (await userInfoRes.json()) as {
    sub?: string;
    email?: string;
    name?: string;
    picture?: string;
    email_verified?: boolean;
  };
  if (!profile.sub || !profile.email) {
    throw new LocalAuthError(401, 401, 'Google profile missing required fields');
  }

  const email = normalizeEmail(profile.email);
  const emailVerified = profile.email_verified === true;

  // Account-linking security: ALWAYS prefer match by googleId (immutable
  // provider identity). Only fall back to email match if Google says the
  // email is verified — otherwise an attacker can register a Google account
  // with someone else's email and hijack their existing native-auth row.
  let user = (await (prisma as any).iMUser.findFirst({
    where: { googleId: profile.sub, role: 'human' },
  })) as AuthUserRecord | null;

  if (!user && emailVerified) {
    user = (await (prisma as any).iMUser.findFirst({
      where: { email, role: 'human' },
    })) as AuthUserRecord | null;
  }

  // v2.0 D1 (方案 A) — banned user must not be resurrected via OAuth re-login.
  // The DELETE /me cascade soft-deletes (banned=true). The previous behavior
  // here updated the banned row and returned a JWT that auth middleware then
  // rejected with "Account is inactive". Apple "account deletion" semantics
  // require the user to come back with a NEW identity, not a re-animated one.
  //
  // Strategy: when we match a banned row, anonymize its unique identifiers
  // (email → tombstone, googleId → NULL) so they're freed for a fresh row,
  // then fall through to the create-new branch.
  if (user && user.banned) {
    await (prisma as any).iMUser.update({
      where: { id: user.id },
      data: {
        email: `${user.id}@deleted.local`,
        googleId: null,
        metadata: JSON.stringify({
          ...parseMetadataSafe(user.metadata, user.id),
          identityReleasedAt: new Date().toISOString(),
          identityReleasedReason: 'google-oauth-re-login-after-deletion',
        }),
      },
    });
    user = null;
  }

  if (!user) {
    // No googleId match, no verified-email match → create a fresh row.
    // If the Google email is unverified, store it but mark emailVerified=false
    // so a later password-reset flow on that email goes through proper
    // ownership proof.
    const username = email.split('@')[0] + '_g_' + Math.random().toString(36).slice(2, 6);
    user = (await (prisma as any).iMUser.create({
      data: {
        email,
        username,
        displayName: profile.name ?? email.split('@')[0],
        avatarUrl: profile.picture,
        googleId: profile.sub,
        emailVerified,
        role: 'human',
        metadata: JSON.stringify({ lastLoginAt: new Date().toISOString() }),
      },
    })) as AuthUserRecord;
  } else {
    user = (await (prisma as any).iMUser.update({
      where: { id: user.id },
      data: {
        googleId: user.googleId ?? profile.sub,
        displayName: user.displayName ?? profile.name,
        avatarUrl: profile.picture ?? user.avatarUrl,
        emailVerified: user.emailVerified || emailVerified,
        metadata: JSON.stringify({
          ...parseMetadataSafe(user.metadata, user.id),
          lastLoginAt: new Date().toISOString(),
        }),
      },
    })) as AuthUserRecord;
  }

  // Lazy numericId allocation for legacy rows that came in via Go
  // backend (numericId NULL) — we need this for downstream pc_* tables.
  user = await ensureNumericId(user);

  return toAuthResponse(user, 'google');
}

export async function loginWithGithubCode(code: string): Promise<AuthResponse> {
  if (!code) throw new LocalAuthError(400, 400, 'GitHub authorization code is required');

  // Nacos convention: NEXT_PUBLIC_GITHUB_CLIENT_ID (visible to client),
  // GITHUB_CLIENT_SECRET (server-only). Plain GITHUB_CLIENT_ID kept as
  // fallback for local dev.
  const clientId = process.env.NEXT_PUBLIC_GITHUB_CLIENT_ID || process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new LocalAuthError(500, 500, 'GitHub OAuth not configured on server');
  }

  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
  });
  if (!tokenRes.ok) throw new LocalAuthError(401, 401, 'Failed to exchange GitHub authorization code');
  const tokenData = (await tokenRes.json()) as { access_token?: string };
  if (!tokenData.access_token) throw new LocalAuthError(401, 401, 'GitHub access token missing');

  const userRes = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: 'application/vnd.github+json' },
    cache: 'no-store',
  });
  if (!userRes.ok) throw new LocalAuthError(401, 401, 'Failed to fetch GitHub user info');

  const githubUser = (await userRes.json()) as {
    id?: number;
    login?: string;
    name?: string | null;
    email?: string | null;
    avatar_url?: string | null;
  };
  if (!githubUser.id || !githubUser.login) {
    throw new LocalAuthError(401, 401, 'GitHub profile missing required fields');
  }

  // GitHub emails are verified server-side via /user/emails. Track whether
  // the email is verified so we can gate account-linking by it.
  let email = '';
  let emailVerified = false;
  // /user/emails is the authoritative source for verification status.
  // The /user `email` field is only verified IF the user marked it
  // primary AND set primary verified — but we can't tell from /user alone,
  // so always cross-check with /user/emails.
  const emailsRes = await fetch('https://api.github.com/user/emails', {
    headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: 'application/vnd.github+json' },
    cache: 'no-store',
  });
  if (emailsRes.ok) {
    const emails = (await emailsRes.json()) as Array<{ email: string; primary?: boolean; verified?: boolean }>;
    const primary = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
    if (primary) {
      email = normalizeEmail(primary.email);
      emailVerified = true;
    }
  }
  // Fallback to /user.email but mark as unverified — we couldn't confirm.
  if (!email && githubUser.email) {
    email = normalizeEmail(githubUser.email);
  }
  if (!email) email = `${githubUser.login}@github.prismer.app`;

  const githubId = String(githubUser.id);

  // Account-linking security: prefer githubId (immutable). Only fall back
  // to email match when GitHub returned a verified primary email.
  let user = (await (prisma as any).iMUser.findFirst({
    where: { githubId, role: 'human' },
  })) as AuthUserRecord | null;

  if (!user && emailVerified) {
    user = (await (prisma as any).iMUser.findFirst({
      where: { email, role: 'human' },
    })) as AuthUserRecord | null;
  }

  // v2.0 D1 — see Google branch for rationale. Release banned row's
  // unique identifiers so re-login creates a fresh imUserId.
  if (user && user.banned) {
    await (prisma as any).iMUser.update({
      where: { id: user.id },
      data: {
        email: `${user.id}@deleted.local`,
        githubId: null,
        metadata: JSON.stringify({
          ...parseMetadataSafe(user.metadata, user.id),
          identityReleasedAt: new Date().toISOString(),
          identityReleasedReason: 'github-oauth-re-login-after-deletion',
        }),
      },
    });
    user = null;
  }

  if (!user) {
    const username = githubUser.login + '_' + Math.random().toString(36).slice(2, 6);
    user = (await (prisma as any).iMUser.create({
      data: {
        email,
        username,
        displayName: githubUser.name ?? githubUser.login,
        avatarUrl: githubUser.avatar_url ?? undefined,
        githubId,
        emailVerified: emailVerified && !email.endsWith('@github.prismer.app'),
        role: 'human',
        metadata: JSON.stringify({ lastLoginAt: new Date().toISOString() }),
      },
    })) as AuthUserRecord;
  } else {
    user = (await (prisma as any).iMUser.update({
      where: { id: user.id },
      data: {
        githubId: user.githubId ?? githubId,
        displayName: user.displayName ?? githubUser.name ?? githubUser.login,
        avatarUrl: githubUser.avatar_url ?? user.avatarUrl,
        emailVerified: user.emailVerified || emailVerified,
        metadata: JSON.stringify({
          ...parseMetadataSafe(user.metadata, user.id),
          lastLoginAt: new Date().toISOString(),
        }),
      },
    })) as AuthUserRecord;
  }

  user = await ensureNumericId(user);

  return toAuthResponse(user, 'github');
}

async function verifyAppleIdentityToken(identityToken: string): Promise<jwt.JwtPayload> {
  const decoded = jwt.decode(identityToken, { complete: true }) as any;
  const kid = decoded?.header?.kid;
  if (!kid) throw new LocalAuthError(401, 401, 'Apple identity token missing key id');

  const keysRes = await fetch('https://appleid.apple.com/auth/keys', { cache: 'no-store' });
  if (!keysRes.ok) throw new LocalAuthError(502, 502, 'Failed to fetch Apple public keys');
  const jwks = (await keysRes.json()) as { keys?: JsonWebKey[] };
  const jwk = jwks.keys?.find((key: any) => key.kid === kid);
  if (!jwk) throw new LocalAuthError(401, 401, 'Apple signing key not found');

  let publicKey: crypto.KeyObject;
  try {
    publicKey = crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: 'jwk' });
  } catch {
    throw new LocalAuthError(401, 401, 'Invalid Apple public key');
  }

  const audience = process.env.APPLE_CLIENT_ID || process.env.IOS_BUNDLE_ID || 'Prismer.lumin';
  try {
    return jwt.verify(identityToken, publicKey, {
      algorithms: ['RS256'],
      audience,
      issuer: 'https://appleid.apple.com',
    }) as jwt.JwtPayload;
  } catch {
    throw new LocalAuthError(401, 401, 'Apple identity token verification failed');
  }
}

export async function loginWithAppleIdentityToken(
  identityToken: string,
  fullName?: string | null,
): Promise<AuthResponse> {
  if (!identityToken) throw new LocalAuthError(400, 400, 'Apple identity token is required');

  const payload = await verifyAppleIdentityToken(identityToken);
  const appleId = typeof payload.sub === 'string' ? payload.sub : '';
  if (!appleId) throw new LocalAuthError(401, 401, 'Apple profile missing subject');

  const rawEmail = typeof payload.email === 'string' ? payload.email : '';
  const email = rawEmail ? normalizeEmail(rawEmail) : `${appleId}@apple.prismer.app`;
  const emailVerified = payload.email_verified === true || payload.email_verified === 'true';
  const trimmedName = fullName?.trim();

  // Account-linking security mirrors Google/GitHub: immutable provider id
  // first, verified email fallback only when Apple asserts ownership.
  let user = (await (prisma as any).iMUser.findFirst({
    where: { appleId, role: 'human' },
  })) as AuthUserRecord | null;

  if (!user && emailVerified && rawEmail) {
    user = (await (prisma as any).iMUser.findFirst({
      where: { email, role: 'human' },
    })) as AuthUserRecord | null;
  }

  // v2.0 D1 — see Google branch for rationale.
  if (user && user.banned) {
    await (prisma as any).iMUser.update({
      where: { id: user.id },
      data: {
        email: rawEmail ? `${user.id}@deleted.local` : user.email,
        appleId: null,
        metadata: JSON.stringify({
          ...parseMetadataSafe(user.metadata, user.id),
          identityReleasedAt: new Date().toISOString(),
          identityReleasedReason: 'apple-oauth-re-login-after-deletion',
        }),
      },
    });
    user = null;
  }

  if (!user) {
    const baseName = trimmedName || (rawEmail ? email.split('@')[0] : 'apple_user');
    const username =
      baseName.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 24) + '_a_' + Math.random().toString(36).slice(2, 6);
    user = (await (prisma as any).iMUser.create({
      data: {
        email,
        username,
        displayName: trimmedName || baseName,
        appleId,
        emailVerified: emailVerified && rawEmail.length > 0,
        role: 'human',
        metadata: JSON.stringify({ lastLoginAt: new Date().toISOString() }),
      },
    })) as AuthUserRecord;
  } else {
    user = (await (prisma as any).iMUser.update({
      where: { id: user.id },
      data: {
        appleId: user.appleId ?? appleId,
        displayName: user.displayName ?? trimmedName,
        emailVerified: user.emailVerified || (emailVerified && rawEmail.length > 0),
        metadata: JSON.stringify({
          ...parseMetadataSafe(user.metadata, user.id),
          lastLoginAt: new Date().toISOString(),
        }),
      },
    })) as AuthUserRecord;
  }

  user = await ensureNumericId(user);
  return toAuthResponse(user, 'apple');
}

// ─── Public API: SMS ─────────────────────────────────────────

/**
 * Generate + cache a 6-digit SMS code; returns the code in dev for the
 * route to optionally surface in the response. The actual sending lives
 * in src/lib/auth/sms.ts (called by the route layer to keep cyclic deps
 * out of this file).
 */
export async function generateSmsCode(phone: string): Promise<string> {
  const isRateLimited = await redis.exists(smsRateKey(phone));
  if (isRateLimited) {
    throw new LocalAuthError(429, 429, 'Please wait 60 seconds before requesting again');
  }
  const code = String(crypto.randomInt(100000, 999999));
  await redis.setex(smsCodeKey(phone), SMS_CODE_TTL_SECONDS, code);
  await redis.setex(smsRateKey(phone), SMS_CODE_RATE_SECONDS, '1');
  return code;
}

/**
 * Verify the SMS code + return an AuthResponse. Provisions a new IMUser
 * by phone if one doesn't exist (similar to OAuth provisioning). The
 * client handles the "first-time user" UX upstream.
 */
export async function verifySmsCode(phone: string, code: string): Promise<AuthResponse> {
  await validateSmsCode(phone, code, true);

  let user = (await (prisma as any).iMUser.findFirst({
    where: { phone, role: 'human' },
  })) as AuthUserRecord | null;

  if (!user) {
    const username = `phone_${phone.slice(-4)}_${Math.random().toString(36).slice(2, 6)}`;
    user = (await (prisma as any).iMUser.create({
      data: {
        phone,
        username,
        displayName: `User ${phone.slice(-4)}`,
        role: 'human',
        emailVerified: false,
        metadata: JSON.stringify({ lastLoginAt: new Date().toISOString() }),
      },
    })) as AuthUserRecord;
  } else {
    user = await updateLastLoginAt(user.id);
  }

  return toAuthResponse(user, 'sms');
}

// ─── Public API: token introspection ─────────────────────────

function tokenBlacklistKey(token: string): string {
  // Hash the token so the raw value never lands in Redis logs.
  return `auth:token-blacklist:${crypto.createHash('sha256').update(token).digest('hex')}`;
}

async function isTokenBlacklisted(token: string): Promise<boolean> {
  return redis.exists(tokenBlacklistKey(token));
}

export async function getUserProfileFromToken(token: string): Promise<AuthResponse | null> {
  try {
    if (await isTokenBlacklisted(token)) return null;

    const payload = jwt.verify(token, getJwtSecret()) as { sub?: string };
    if (!payload.sub) return null;

    const user = (await (prisma as any).iMUser.findFirst({
      where: { id: payload.sub, role: 'human' },
    })) as AuthUserRecord | null;
    if (!user || !isUserActive(user)) return null;

    return toAuthResponse(user, 'email');
  } catch {
    return null;
  }
}

export async function refreshAuthToken(token: string): Promise<AuthResponse | null> {
  return getUserProfileFromToken(token);
}

// ─── Public API: mint a session token for a known IMUser ──────

/**
 * Mint a fresh session JWT (7-day TTL) for an existing human IMUser, by id.
 *
 * Used by the login-QR (F2) flow: a web-authenticated user grants their
 * own session to a scanning mobile device after an explicit second
 * confirmation. The minted token is for `imUserId` (the offer creator) —
 * identical shape to a normal email/OAuth login token, so the mobile client
 * bootstraps through the exact same IM ws/sse handshake.
 *
 * Returns null if the user doesn't exist, isn't active, or isn't a human.
 */
export async function mintSessionToken(
  imUserId: string,
): Promise<{ token: string; expiresIn: number; imUserId: string; numericId: number } | null> {
  const user = (await (prisma as any).iMUser.findFirst({
    where: { id: imUserId, role: 'human' },
  })) as AuthUserRecord | null;
  if (!user || !isUserActive(user)) return null;
  return {
    token: issueToken(user, 'email'),
    expiresIn: TOKEN_TTL_SECONDS,
    imUserId: user.id,
    numericId: asNumber(user.numericId),
  };
}

// ─── Public API: logout (token blacklist) ────────────────────

/**
 * Adds the token to a Redis blacklist. TTL is derived from the VERIFIED
 * `exp` claim (not the raw decode) so an attacker can't submit a forged
 * token with `exp = now + 10 years` to fill Redis with permanent garbage.
 * Invalid/expired tokens are rejected with 401 before any blacklist write.
 *
 * TTL clamp: [60s, TOKEN_TTL_SECONDS] — defends against clock skew and
 * caps how long a single blacklist entry can live.
 */
export async function logoutAndBlacklist(token: string): Promise<{ code: number; message: string }> {
  if (!token) throw new LocalAuthError(400, 400, 'Token is required');

  let exp: number | undefined;
  try {
    const payload = jwt.verify(token, getJwtSecret()) as { exp?: number };
    exp = payload.exp;
  } catch {
    // Invalid/expired token: refuse to write to the blacklist. The
    // caller can't logout something they don't actually hold.
    throw new LocalAuthError(401, 401, 'Invalid or expired token');
  }

  let ttlSeconds = TOKEN_TTL_SECONDS;
  if (exp) {
    const remaining = exp - Math.floor(Date.now() / 1000);
    ttlSeconds = Math.max(60, Math.min(remaining, TOKEN_TTL_SECONDS));
  }

  await redis.setex(tokenBlacklistKey(token), ttlSeconds, '1');
  return { code: 200, message: 'Success' };
}

// ─── Public API: change-password (authenticated) ─────────────

/**
 * For a logged-in user. No verification code required — current password
 * is the proof of identity. `currentHash` and `newHash` are SHA256 hex
 * digests posted by the frontend (same convention as login/register).
 */
export async function changePasswordAuthenticated(
  userId: string,
  currentHash: string,
  newHash: string,
  confirmHash: string,
): Promise<{ code: number; message: string }> {
  if (!userId || !currentHash || !newHash || !confirmHash) {
    throw new LocalAuthError(400, 400, 'All fields are required');
  }
  if (newHash !== confirmHash) {
    throw new LocalAuthError(400, 400, 'New passwords do not match');
  }
  if (newHash === currentHash) {
    throw new LocalAuthError(400, 400, 'New password must differ from current password');
  }

  const user = (await (prisma as any).iMUser.findFirst({
    where: { id: userId, role: 'human' },
  })) as AuthUserRecord | null;

  if (!user?.passwordHash || !isUserActive(user)) {
    throw new LocalAuthError(404, 404, 'User not found');
  }

  const ok = await verifyAndMaybeRehash(user.id, user.passwordHash, currentHash);
  if (!ok) {
    throw new LocalAuthError(401, 401, 'Current password is incorrect');
  }

  await (prisma as any).iMUser.update({
    where: { id: user.id },
    data: { passwordHash: await bcrypt.hash(newHash, 12) },
  });

  return { code: 200, message: 'Success' };
}
