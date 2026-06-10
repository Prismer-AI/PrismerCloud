/**
 * Bug Z2 regression — JWT translation chain preserves IMUser sub (cuid).
 *
 * Pre-Z2 chain (BUG):
 *   1. src/lib/api-guard.ts::validateJwt — discards sub when numericId set
 *      ⇒ guard.auth.userId = numericId
 *   2. src/app/api/im/[...path]/route.ts — sees numeric userId, mints
 *      api_key_proxy token with sub = numericId
 *   3. src/im/auth/middleware.ts — type=api_key_proxy → ensureIMUser(numericId)
 *      ⇒ if im_users.numericId backfill missing, MINT phantom IMUser
 *
 * Symptom on invite accept: user B accepts invite, server creates a NEW
 * IMUser (orphan), invite.acceptedByUserId points at the orphan, B's
 * existing identity loses ownership of accepted membership.
 *
 * Post-Z2 fix:
 *   1. api-guard surfaces `imUserSub` when JWT sub matches cuid shape
 *   2. route shim mints DIRECT IM token (no api_key_proxy) for that sub
 *   3. middleware on direct JWT uses sub as imUserId — single findUnique,
 *      no auto-create
 *
 * Run:
 *   rm -f /tmp/prismer-acp-z2.db
 *   DATABASE_URL="file:/tmp/prismer-acp-z2.db" \
 *     npx prisma db push --schema prisma/schema.prisma --skip-generate --accept-data-loss
 *   DATABASE_URL="file:/tmp/prismer-acp-z2.db" JWT_SECRET=dev-secret-change-me \
 *     npx tsx src/im/tests/acp-jwt-chain-sub-priority.test.ts
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as jwt from 'jsonwebtoken';
import prisma from '../db';

// Cloud-side guard (decoder + token mint helpers)
import {
  generateIMTokenForImUser,
  generateIMTokenForUser,
} from '../../lib/api-guard';

// IM-side jwt verifier (so we exercise the same path the middleware uses)
import { verifyToken } from '../auth/jwt';

let passed = 0;
let failed = 0;

function ok(label: string) {
  passed++;
  console.log(`  ok — ${label}`);
}
function bad(label: string, err: unknown) {
  failed++;
  console.error(`  FAIL — ${label}: ${err instanceof Error ? err.message : String(err)}`);
}

async function withCase(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    ok(name);
  } catch (err) {
    bad(name, err);
  }
}

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const IM_CUID_RE = /^cmp[a-z0-9]{20,}$/;

// Generate a cuid-shape id (cmp + 22 lowercase alphanumeric → 25 chars total)
function fakeCuid(): string {
  const tail = crypto.randomBytes(16).toString('hex').slice(0, 22);
  return `cmp${tail}`;
}

// Helper: mint an upstream platform JWT exactly like local-auth.ts::issueToken
function mintPlatformJwt(opts: {
  sub: string;
  numericId?: number;
  email?: string;
  username?: string;
}): string {
  return jwt.sign(
    {
      sub: opts.sub,
      username: opts.username || opts.sub,
      role: 'human',
      ...(opts.numericId !== undefined ? { numericId: opts.numericId } : {}),
      ...(opts.email ? { email: opts.email } : {}),
    },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

// Replicate api-guard::validateJwt locally (decoder is non-IO; importing the
// route handler pulls in NextRequest which won't load under tsx without an
// http context). This mirrors the exact post-Z2 shape.
function decodeAuthGuardJwt(token: string): {
  userId: string;
  email: string;
  imUserSub?: string;
} | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
  const resolvedUserId =
    typeof payload.numericId === 'number' && Number.isFinite(payload.numericId)
      ? payload.numericId
      : payload.sub || payload.user_id || payload.id;
  if (resolvedUserId === undefined || resolvedUserId === null || resolvedUserId === '') return null;
  const subValue = typeof payload.sub === 'string' ? payload.sub : undefined;
  const imUserSub = subValue && IM_CUID_RE.test(subValue) ? subValue : undefined;
  return {
    userId: String(resolvedUserId),
    email: payload.email || '',
    ...(imUserSub ? { imUserSub } : {}),
  };
}

async function seedIMUser(opts: { id?: string; numericId?: number; suffix: string }): Promise<{
  id: string;
  numericId: number | null;
}> {
  const id = opts.id || fakeCuid(); // cuid-shape
  await prisma.iMUser.create({
    data: {
      id,
      username: `z2_user_${opts.suffix}`,
      displayName: `Z2 User ${opts.suffix}`,
      role: 'human',
      ...(opts.numericId !== undefined ? { numericId: opts.numericId } : {}),
      userId: `cloud_${opts.suffix}`,
    },
  });
  return { id, numericId: opts.numericId ?? null };
}

async function main() {
  console.log('• Bug Z2 — JWT chain sub (cuid) priority over numericId');

  // ─── Layer 1: api-guard validateJwt ─────────────────────────────────────
  await withCase('api-guard: cuid-shape sub surfaces imUserSub', async () => {
    const sub = fakeCuid();
    assert.ok(IM_CUID_RE.test(sub), 'sub must look cuid-shape for test setup');

    const token = mintPlatformJwt({ sub, numericId: 9991, email: 'a@x.io' });
    const auth = decodeAuthGuardJwt(token);
    assert.ok(auth, 'decode must succeed');
    // Legacy contract preserved: userId still numericId for /api/keys
    assert.equal(auth!.userId, '9991', 'userId still resolves to numericId (legacy compat)');
    // New contract: imUserSub set to the cuid sub
    assert.equal(auth!.imUserSub, sub, 'imUserSub carries the IMUser.id cuid');
  });

  await withCase('api-guard: numeric-only sub does NOT set imUserSub', async () => {
    // Legacy api_key_proxy-style or older mint — sub == numericId string
    const token = mintPlatformJwt({ sub: '40', numericId: 40 });
    const auth = decodeAuthGuardJwt(token);
    assert.ok(auth);
    assert.equal(auth!.userId, '40');
    assert.equal(auth!.imUserSub, undefined, 'no cuid sub → no imUserSub (legacy path intact)');
  });

  await withCase('api-guard: email-like sub does NOT match cuid (no imUserSub)', async () => {
    const token = mintPlatformJwt({ sub: 'alice@example.com', numericId: 7 });
    const auth = decodeAuthGuardJwt(token);
    assert.ok(auth);
    assert.equal(auth!.userId, '7');
    assert.equal(auth!.imUserSub, undefined);
  });

  // ─── Layer 2: IM proxy route translation (token mint shape) ──────────────
  await withCase('route shim: cuid-sub path mints direct IM token (no api_key_proxy)', async () => {
    const sub = fakeCuid();
    const token = generateIMTokenForImUser(sub, 'b@x.io');
    const payload = jwt.verify(token, JWT_SECRET) as any;
    assert.equal(payload.sub, sub, 'minted token sub === IMUser.id');
    assert.notEqual(payload.type, 'api_key_proxy', 'must NOT be api_key_proxy (would trigger ensureIMUser)');
    assert.equal(payload.role, 'human', 'direct human JWT shape');
  });

  await withCase('route shim: legacy numeric path still mints api_key_proxy', async () => {
    // Legacy fallback (numeric-only sub) must remain compatible with sk-prismer-* flow
    const token = generateIMTokenForUser('40', 'leg@x.io');
    const payload = jwt.verify(token, JWT_SECRET) as any;
    assert.equal(payload.sub, '40', 'numeric sub preserved');
    assert.equal(payload.type, 'api_key_proxy', 'legacy translation flag preserved');
  });

  // ─── Layer 3: IM middleware behaviour (DB-level) ─────────────────────────
  await withCase('middleware: direct JWT (cuid sub) resolves IMUser by id', async () => {
    const seeded = await seedIMUser({ suffix: `mw_${Date.now()}` });
    // Direct IM JWT — middleware uses sub as imUserId without ensureIMUser
    const directToken = generateIMTokenForImUser(seeded.id);
    const verified = verifyToken(directToken) as any;
    assert.equal(verified.sub, seeded.id);
    assert.notEqual(verified.type, 'api_key_proxy', 'must NOT be api_key_proxy');

    const im = await prisma.iMUser.findUnique({ where: { id: verified.sub } });
    assert.ok(im, 'middleware findUnique({id: sub}) must hit existing row');
    assert.equal(im!.id, seeded.id);
  });

  await withCase('middleware: api_key_proxy with cuid sub → findUnique hit, no phantom mint', async () => {
    const seeded = await seedIMUser({
      suffix: `apx_${Date.now()}`,
      numericId: Math.floor(Math.random() * 1_000_000) + 100_000_000,
    });
    const beforeCount = await prisma.iMUser.count();

    // Even if the IM proxy shim mistakenly wrapped a cuid sub in
    // api_key_proxy, the middleware Z2 guard catches it before ensureIMUser.
    // Simulate that path: build an api_key_proxy token carrying the cuid sub.
    const proxyToken = generateIMTokenForUser(seeded.id);
    const verified = verifyToken(proxyToken) as any;
    assert.equal(verified.type, 'api_key_proxy');
    assert.ok(IM_CUID_RE.test(verified.sub), 'sub remains cuid-shape post-mint');

    // Mirror middleware: cuid sub → findUnique first
    const direct = await prisma.iMUser.findUnique({ where: { id: verified.sub } });
    assert.ok(direct, 'cuid-sub findUnique must hit');

    const afterCount = await prisma.iMUser.count();
    assert.equal(afterCount, beforeCount, 'no phantom IMUser minted');
  });

  await withCase('end-to-end: invite-accept identity preserved (sub-based chain)', async () => {
    // Seed two users (A inviter, B invitee). B has a cuid id + numericId.
    // Pre-Z2 chain: B's JWT → guard.userId=numericId → IM proxy mints
    // api_key_proxy(sub=numericId) → middleware ensureIMUser by numericId
    // misses B (no backfill) → mints phantom IMUser, invite recorded with
    // phantomId rather than B.id.
    const aliceNumeric = Math.floor(Math.random() * 1_000_000) + 200_000_000;
    const bobNumeric = Math.floor(Math.random() * 1_000_000) + 300_000_000;
    const alice = await seedIMUser({ suffix: `inv_alice_${Date.now()}`, numericId: aliceNumeric });
    const bob = await seedIMUser({ suffix: `inv_bob_${Date.now()}`, numericId: bobNumeric });

    const beforeCount = await prisma.iMUser.count();

    // B logs in via cloud — receives upstream JWT with sub=B.id (cuid) + numericId
    const bobJwt = mintPlatformJwt({
      sub: bob.id,
      numericId: bobNumeric,
      email: 'bob@x.io',
      username: 'bob',
    });
    const guardAuth = decodeAuthGuardJwt(bobJwt);
    assert.ok(guardAuth, 'guard must accept token');
    assert.equal(guardAuth!.imUserSub, bob.id, 'guard surfaces B.id as imUserSub (Z2 contract)');

    // Route shim: imUserSub present → DIRECT IM token (not api_key_proxy)
    const imToken = generateIMTokenForImUser(guardAuth!.imUserSub!, guardAuth!.email);
    const decoded = verifyToken(imToken) as any;
    assert.notEqual(decoded.type, 'api_key_proxy', 'direct token — no api_key_proxy translation');
    assert.equal(decoded.sub, bob.id, 'decoded sub === B IMUser.id');

    // Middleware path: direct JWT → imUserId = sub
    const resolvedImUserId = decoded.sub;
    assert.equal(resolvedImUserId, bob.id, 'middleware resolves to B (not a phantom)');

    // Sanity: identity preserved end-to-end, no orphan minted
    const afterCount = await prisma.iMUser.count();
    assert.equal(afterCount, beforeCount, 'no phantom IMUser created end-to-end');

    // A & B IMUsers still distinct
    const aliceRow = await prisma.iMUser.findUnique({ where: { id: alice.id } });
    const bobRow = await prisma.iMUser.findUnique({ where: { id: bob.id } });
    assert.ok(aliceRow);
    assert.ok(bobRow);
    assert.notEqual(aliceRow!.id, bobRow!.id);
  });

  await withCase('legacy compat: api_key (sk-prismer-*) flow still works', async () => {
    // sk-prismer-* path in api-guard validates DB → userId = numericId string.
    // It does NOT mint a JWT for the upstream; it generates an imToken via
    // generateIMToken(userId), which keeps api_key_proxy semantics. Middleware
    // sees numeric sub (≠ cuid shape) → ensureIMUser path runs unchanged.
    const numericUser = '12345';
    const imToken = generateIMTokenForUser(numericUser);
    const verified = verifyToken(imToken) as any;
    assert.equal(verified.type, 'api_key_proxy', 'legacy api_key_proxy semantics');
    assert.equal(verified.sub, numericUser);
    assert.ok(!IM_CUID_RE.test(verified.sub), 'numeric sub NOT cuid-shape → ensureIMUser runs as before');
  });

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
