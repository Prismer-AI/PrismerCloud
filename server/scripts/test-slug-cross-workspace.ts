/**
 * scripts/test-slug-cross-workspace.ts
 *
 * §30 Q2 (post-decision) — slug = im_users.username is GLOBALLY UNIQUE.
 * The API-Key (cloudUserId) bypass path in `POST /api/im/register` used
 * to silently rebind an existing agent's AgentCard from workspace A to
 * workspace B when the SAME cloud user re-registered the same slug under
 * a different workspaceId. The fix returns 409
 * USERNAME_TAKEN_IN_OTHER_WORKSPACE instead, leaving the original
 * AgentCard untouched in its original workspace.
 *
 * This script reproduces the bug-then-fix path and asserts:
 *   1. workspace A first-register via API-Key proxy token → 200/201, the
 *      AgentCard is bound to wsA.
 *   2. workspace B same-cloud-user same-slug → 409 with
 *      error.code === 'USERNAME_TAKEN_IN_OTHER_WORKSPACE'.
 *   3. POST-STATE: the AgentCard is STILL bound to wsA (no silent rebind
 *      to wsB).
 *
 * Fixtures are upsert-style so reruns are idempotent. Targets the local
 * docker stack (mysql:8.0 :3307, redis :6380) — do NOT run against
 * cloud.prismer.dev or prismer.cloud.
 *
 * Usage:
 *   ./scripts/dev-stack.sh up
 *   npm run dev                                        # next.js on :3000
 *   npx tsx scripts/test-slug-cross-workspace.ts
 *
 * Exit codes:
 *   0 — all assertions pass
 *   1 — any assertion fails
 */

import path from 'node:path';
import { createRequire } from 'node:module';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'mysql://prismer:devpass@localhost:3307/prismer_cloud';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:3000';
const JWT_SECRET = process.env.JWT_SECRET || process.env.NEXTAUTH_SECRET || 'local-dev-secret-do-not-use-in-prod';

const FIXTURE_PREFIX = 'cross-ws-slug';
const OWNER_USERNAME = `${FIXTURE_PREFIX}-owner`;
// Stable cloud user id — represents the upstream Cloud 1 user uuid that
// api_key_proxy tokens carry as `sub`. Anything works as long as it's
// the same value across both registrations.
const CLOUD_USER_ID = `cloud-${FIXTURE_PREFIX}-uid-1`;
const TARGET_SLUG = `${FIXTURE_PREFIX}-test-001`;

const require_ = createRequire(import.meta.url);
const { PrismaClient } = require_(path.join(process.cwd(), 'prisma/generated/mysql'));
const jwt = require_('jsonwebtoken');

const prisma = new PrismaClient();

let failed = 0;
function assert(cond: unknown, label: string, detail?: string): void {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    failed += 1;
  }
}

interface RegisterResp {
  ok: boolean;
  data?: { imUserId: string; token: string; isNew: boolean };
  error?: string | { code: string; message: string };
  meta?: Record<string, unknown>;
}

async function seedTwoWorkspaces(): Promise<{
  ownerImUserId: string;
  wsA: { id: string; slug: string };
  wsB: { id: string; slug: string };
}> {
  // Owner human IMUser. The cloud user id (userId column) ties this row
  // to the api_key_proxy token below — register.ts resolveOwnerWorkspaceId
  // looks up `userId: cloudUserId, role: 'human'`.
  const ownerId = `usr-${FIXTURE_PREFIX}`.slice(0, 30);
  const owner = await prisma.iMUser.upsert({
    where: { username: OWNER_USERNAME },
    create: {
      id: ownerId,
      username: OWNER_USERNAME,
      displayName: 'Cross-WS Slug Owner',
      role: 'human',
      userId: CLOUD_USER_ID,
    },
    update: { displayName: 'Cross-WS Slug Owner', userId: CLOUD_USER_ID },
    select: { id: true, userId: true },
  });

  const ws: Array<{ id: string; slug: string }> = [];
  for (const slug of [`${FIXTURE_PREFIX}-wsA`, `${FIXTURE_PREFIX}-wsB`]) {
    let existing = await prisma.iMWorkspace.findFirst({
      where: { ownerImUserId: owner.id, slug, deletedAt: null },
      select: { id: true, slug: true },
    });
    if (!existing) {
      existing = await prisma.iMWorkspace.create({
        data: {
          ownerImUserId: owner.id,
          name: slug,
          slug,
          isDefault: false,
        },
        select: { id: true, slug: true },
      });
    }
    ws.push(existing);
  }

  // Reset the test agent on every run so the baseline is "fresh slug,
  // no existing AgentCard". Deletes by username (global unique).
  await prisma.iMAgentCard.deleteMany({
    where: { imUser: { username: TARGET_SLUG } },
  });
  await prisma.iMUser.deleteMany({ where: { username: TARGET_SLUG } });

  return { ownerImUserId: owner.id, wsA: ws[0], wsB: ws[1] };
}

/**
 * Sign an API-Key proxy token. register.ts treats `type: 'api_key_proxy'`
 * specially — `sub` becomes cloudUserId (NOT an im user id), and the
 * register flow looks up existing rows by `(cloudUserId, username)`.
 */
function signApiKeyProxyToken(cloudUserId: string): string {
  return jwt.sign(
    {
      sub: cloudUserId,
      username: OWNER_USERNAME,
      role: 'human',
      type: 'api_key_proxy',
    },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

async function register(
  token: string,
  workspaceId: string,
  username: string,
): Promise<{ status: number; body: RegisterResp }> {
  const res = await fetch(`${BASE_URL}/api/im/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      type: 'agent',
      username,
      displayName: username,
      agentType: 'assistant',
      workspaceId,
    }),
  });
  return { status: res.status, body: (await res.json()) as RegisterResp };
}

async function main(): Promise<void> {
  console.log(`[cross-ws-slug] base = ${BASE_URL}`);
  const { ownerImUserId, wsA, wsB } = await seedTwoWorkspaces();
  console.log(`[cross-ws-slug] seeded owner=${ownerImUserId} wsA=${wsA.id} (${wsA.slug}) wsB=${wsB.id} (${wsB.slug})`);
  console.log(`[cross-ws-slug] cloudUserId=${CLOUD_USER_ID} slug=${TARGET_SLUG}`);

  const token = signApiKeyProxyToken(CLOUD_USER_ID);

  // ---- Step 1: register in wsA. Expect success.
  const r1 = await register(token, wsA.id, TARGET_SLUG);
  console.log(`[cross-ws-slug] wsA register -> status=${r1.status}`);
  assert(
    r1.status === 200 || r1.status === 201,
    `wsA register accepted (status=${r1.status})`,
    r1.status >= 400 ? JSON.stringify(r1.body).slice(0, 240) : undefined,
  );
  assert(!!r1.body?.data?.imUserId, 'wsA register returned imUserId');
  const wsAImUserId = r1.body?.data?.imUserId;

  // Pre-check: the AgentCard is bound to wsA.
  const cardAfterStep1 = await prisma.iMAgentCard.findFirst({
    where: { imUser: { username: TARGET_SLUG } },
    select: { imUserId: true, workspaceId: true },
  });
  assert(
    cardAfterStep1?.workspaceId === wsA.id,
    `AgentCard bound to wsA after step 1 (got ${cardAfterStep1?.workspaceId})`,
  );

  // ---- Step 2: same cloudUserId, same slug, but workspaceId = wsB.
  // BEFORE the fix this would silently rebind cardAfterStep1 to wsB and
  // return 200. AFTER the fix it must return 409 USERNAME_TAKEN_IN_OTHER_WORKSPACE.
  const r2 = await register(token, wsB.id, TARGET_SLUG);
  console.log(`[cross-ws-slug] wsB register -> status=${r2.status}`);
  console.log(`[cross-ws-slug]   body=${JSON.stringify(r2.body).slice(0, 280)}`);
  assert(r2.status === 409, `wsB register rejected with 409 (got ${r2.status})`);
  const err2 = r2.body?.error;
  const code = typeof err2 === 'object' && err2 ? err2.code : undefined;
  assert(
    code === 'USERNAME_TAKEN_IN_OTHER_WORKSPACE',
    `error.code === USERNAME_TAKEN_IN_OTHER_WORKSPACE (got ${code})`,
  );

  // ---- Step 3: POST-STATE — AgentCard still bound to wsA (not silently
  // rebound to wsB). This is the core regression assertion: even if a
  // future bug returns the right error code but mutates state, the row
  // check catches it.
  const cardAfterStep2 = await prisma.iMAgentCard.findFirst({
    where: { imUser: { username: TARGET_SLUG } },
    select: { imUserId: true, workspaceId: true },
  });
  assert(
    cardAfterStep2?.workspaceId === wsA.id,
    `AgentCard STILL bound to wsA after wsB-attempt (got ${cardAfterStep2?.workspaceId}); silent rebind regression`,
  );
  assert(
    cardAfterStep2?.imUserId === wsAImUserId,
    `AgentCard.imUserId unchanged (got ${cardAfterStep2?.imUserId}, expected ${wsAImUserId})`,
  );

  console.log('');
  if (failed > 0) {
    console.error(`[cross-ws-slug] FAIL — ${failed} assertion(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('[cross-ws-slug] PASS — all assertions met');
  }
}

main()
  .catch((err) => {
    console.error('[cross-ws-slug] CRASH —', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
