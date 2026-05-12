/**
 * scripts/verify-slug-uniqueness-scope.ts
 *
 * §30 Q2 — slug uniqueness scope verifier (read-only / non-destructive).
 *
 * The §30 design table declares slug (= IMUser.username for agents) as
 * "workspace-scoped unique." The DB + register code disagree: `im_users`
 * carries a single-column `UNIQUE(username)` index and `POST /api/im/register`
 * actively rejects (409) any reuse across a different identity.
 *
 * This script makes the disagreement reproducible:
 *   1. Seed owner + two workspaces (wsA, wsB) under the same human IMUser.
 *   2. Register agent `slug-scope-test-ceo-001` in wsA via the direct-JWT
 *      register path.
 *   3. Try to register the same username in wsB.
 *   4. Print the verdict (GLOBAL-with-409 / GLOBAL-silent-rebind / etc.).
 *
 * Idempotent: each run resets the test agent rows before retrying. Does NOT
 * mutate `im_users.username` index or any schema state.
 *
 * Usage:
 *   E2E_BASE_URL=http://localhost:3300 npx tsx scripts/verify-slug-uniqueness-scope.ts
 */

import path from 'node:path';
import { createRequire } from 'node:module';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'mysql://prismer:devpass@localhost:3307/prismer_cloud';
const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:3300';
const JWT_SECRET = process.env.JWT_SECRET || process.env.NEXTAUTH_SECRET || 'local-dev-secret-do-not-use-in-prod';
const FIXTURE_PREFIX = 'slug-scope';

const require_ = createRequire(import.meta.url);
const { PrismaClient } = require_(path.join(process.cwd(), 'prisma/generated/mysql'));
const jwt = require_('jsonwebtoken');

const prisma = new PrismaClient();

async function seedTwoWorkspaces() {
  const ownerUsername = `${FIXTURE_PREFIX}-owner`;
  const ownerId = `usr-${FIXTURE_PREFIX}`.slice(0, 30);
  const owner = await prisma.iMUser.upsert({
    where: { username: ownerUsername },
    create: { id: ownerId, username: ownerUsername, displayName: 'Slug Scope Owner', role: 'human' },
    update: {},
    select: { id: true },
  });

  const ws = [] as { id: string; slug: string }[];
  for (const slug of [`${FIXTURE_PREFIX}-wsA`, `${FIXTURE_PREFIX}-wsB`]) {
    let existing = await prisma.iMWorkspace.findFirst({
      where: { ownerImUserId: owner.id, slug, deletedAt: null },
      select: { id: true, slug: true },
    });
    if (!existing) {
      existing = await prisma.iMWorkspace.create({
        data: { ownerImUserId: owner.id, name: slug, slug, isDefault: false },
        select: { id: true, slug: true },
      });
    }
    ws.push(existing);
  }

  // Reset the test agent so reruns observe the same baseline.
  await prisma.iMAgentCard.deleteMany({ where: { imUser: { username: `${FIXTURE_PREFIX}-test-ceo-001` } } });
  await prisma.iMUser.deleteMany({ where: { username: `${FIXTURE_PREFIX}-test-ceo-001` } });

  return { ownerId: owner.id, wsA: ws[0], wsB: ws[1] };
}

async function registerAgent(ownerId: string, workspaceId: string, username: string) {
  const token = jwt.sign({ sub: ownerId, username: `${FIXTURE_PREFIX}-owner`, role: 'human' }, JWT_SECRET, {
    expiresIn: '1h',
  });
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
  return { status: res.status, body: await res.json() };
}

async function main() {
  console.log(`[slug-scope] base = ${BASE_URL}`);
  const { ownerId, wsA, wsB } = await seedTwoWorkspaces();
  console.log(`[slug-scope] wsA=${wsA.id} (${wsA.slug})  wsB=${wsB.id} (${wsB.slug})`);

  const slug = `${FIXTURE_PREFIX}-test-ceo-001`;

  const r1 = await registerAgent(ownerId, wsA.id, slug);
  console.log(`[slug-scope] wsA register slug='${slug}' -> status=${r1.status}`);
  console.log(`[slug-scope]   body=${JSON.stringify(r1.body).slice(0, 200)}`);

  const r2 = await registerAgent(ownerId, wsB.id, slug);
  console.log(`[slug-scope] wsB register slug='${slug}' -> status=${r2.status}`);
  console.log(`[slug-scope]   body=${JSON.stringify(r2.body).slice(0, 200)}`);

  const after = await prisma.iMAgentCard.findFirst({
    where: { imUser: { username: slug } },
    select: { imUserId: true, workspaceId: true },
  });
  console.log(`[slug-scope] post-state: AgentCard imUserId=${after?.imUserId} workspaceId=${after?.workspaceId}`);

  if (r2.status >= 200 && r2.status < 300) {
    const sameImUser = r1.body?.data?.imUserId === r2.body?.data?.imUserId;
    const wsBboundCard = after?.workspaceId === wsB.id;
    console.log('');
    console.log(`[slug-scope] VERDICT: GLOBAL — same slug succeeded in both workspaces.`);
    console.log(`[slug-scope]   sameImUser=${sameImUser} (true => Cloud rebound existing record)`);
    console.log(`[slug-scope]   wsB-bound card=${wsBboundCard} (true => second call clobbered wsA binding)`);
  } else if (r2.status === 409) {
    console.log('');
    console.log(
      `[slug-scope] VERDICT: GLOBAL-with-409 — second register rejected due to global username unique index.`,
    );
  } else {
    console.log('');
    console.log(`[slug-scope] VERDICT: UNEXPECTED status=${r2.status} — investigate.`);
  }
}

main()
  .catch((err) => {
    console.error('[slug-scope] CRASH —', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
