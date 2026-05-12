/**
 * scripts/test-ceo-permissions.ts
 *
 * §30 §2.8.6 / §31 §2.1 — CEO permissions API e2e.
 *
 * Validates the Settings → CEO Authorization wire contract:
 *   1. GET before any PATCH → `{ canCreateAgents: false, canDispatch: false }`
 *   2. PATCH `{ canCreateAgents: true, canDispatch: true }` → both true
 *   3. GET reflects the persisted state
 *   4. PATCH `{ canCreateAgents: false }` → only that key flips
 *   5. GET reflects `{ canCreateAgents: false, canDispatch: true }`
 *   6. Other metadata sub-keys are not clobbered by PATCH (preferredCreationMode probe)
 *   7. Unauth GET → 401
 *
 * Run:
 *   ./scripts/dev-stack.sh up
 *   npm run dev               # :3000
 *   npx tsx scripts/test-ceo-permissions.ts
 */

import path from 'node:path';
import { createRequire } from 'node:module';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'mysql://prismer:devpass@localhost:3307/prismer_cloud';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:3000';
const JWT_SECRET = process.env.JWT_SECRET || process.env.NEXTAUTH_SECRET || 'local-dev-secret-do-not-use-in-prod';

const FIXTURE_PREFIX = 'e2e-ceo-perms';
const OWNER_USERNAME = `${FIXTURE_PREFIX}-owner`;
const AGENT_USERNAME = `${FIXTURE_PREFIX}-agent`;
const GHOST_USER_ID = 'usr-e2e-ceo-ghost-doesnotexist';

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

interface PermsResp {
  success: boolean;
  data?: { canCreateAgents: boolean; canDispatch: boolean };
  error?: { code: string; message: string };
}

async function seedOwner(): Promise<string> {
  // Reset metadata to a controlled baseline that includes a sibling key
  // so we can prove PATCH preserves it (regression guard for the helper).
  const ownerId = `usr-${FIXTURE_PREFIX.slice(0, 12)}`.slice(0, 30);
  const baselineMetadata = JSON.stringify({ preferredCreationMode: 'simple' });
  await prisma.iMUser.upsert({
    where: { username: OWNER_USERNAME },
    create: {
      id: ownerId,
      username: OWNER_USERNAME,
      displayName: 'E2E CEO Perms Owner',
      role: 'human',
      metadata: baselineMetadata,
    },
    update: { displayName: 'E2E CEO Perms Owner', metadata: baselineMetadata },
  });
  return ownerId;
}

async function seedAgent(): Promise<string> {
  // Agent JWT must be rejected (403) — n1/n2 spec. We seed a real agent row
  // so requireAuthIdentity passes (it loads the IM row and reads `role`),
  // and the route's own role gate is the layer under test.
  const agentId = `usr-${FIXTURE_PREFIX.slice(0, 12)}-a`.slice(0, 30);
  await prisma.iMUser.upsert({
    where: { username: AGENT_USERNAME },
    create: {
      id: agentId,
      username: AGENT_USERNAME,
      displayName: 'E2E CEO Perms Agent',
      role: 'agent',
    },
    update: { displayName: 'E2E CEO Perms Agent', role: 'agent' },
  });
  return agentId;
}

function signToken(userId: string, opts: { username?: string; role?: 'human' | 'agent' } = {}): string {
  const { username = OWNER_USERNAME, role = 'human' } = opts;
  return jwt.sign({ sub: userId, username, role }, JWT_SECRET, {
    expiresIn: '1h',
  });
}

async function get(token: string | null): Promise<{ status: number; body: PermsResp }> {
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}/api/users/me/ceo-permissions`, { headers });
  const body = (await res.json()) as PermsResp;
  return { status: res.status, body };
}

async function patch(
  token: string,
  body: Partial<{ canCreateAgents: boolean; canDispatch: boolean }>,
): Promise<{ status: number; body: PermsResp }> {
  const res = await fetch(`${BASE_URL}/api/users/me/ceo-permissions`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const respBody = (await res.json()) as PermsResp;
  return { status: res.status, body: respBody };
}

async function main(): Promise<void> {
  console.log('[test-ceo-permissions] base =', BASE_URL);
  const ownerId = await seedOwner();
  console.log(`  seeded owner=${ownerId}`);
  const token = signToken(ownerId);

  // ───── Step 1: unauthenticated GET → 401 ─────
  console.log('\n[step 1] unauthenticated GET → 401');
  {
    const r = await get(null);
    assert(r.status === 401, `unauth GET 401 (got ${r.status})`, JSON.stringify(r.body));
  }

  // ───── Step 2: authenticated GET (default) ─────
  console.log('\n[step 2] authenticated GET → defaults all false');
  {
    const r = await get(token);
    assert(r.status === 200, `GET 200 (got ${r.status})`);
    assert(r.body.success === true, 'body.success === true');
    assert(r.body.data?.canCreateAgents === false, 'canCreateAgents default false');
    assert(r.body.data?.canDispatch === false, 'canDispatch default false');
  }

  // ───── Step 3: PATCH both true ─────
  console.log('\n[step 3] PATCH { canCreateAgents: true, canDispatch: true }');
  {
    const r = await patch(token, { canCreateAgents: true, canDispatch: true });
    assert(r.status === 200, `PATCH 200 (got ${r.status})`);
    assert(
      r.body.data?.canCreateAgents === true && r.body.data?.canDispatch === true,
      'both true',
      JSON.stringify(r.body.data),
    );
  }

  // ───── Step 4: GET reflects both true ─────
  console.log('\n[step 4] GET reflects both true');
  {
    const r = await get(token);
    assert(r.body.data?.canCreateAgents === true, 'canCreateAgents = true');
    assert(r.body.data?.canDispatch === true, 'canDispatch = true');
  }

  // ───── Step 5: partial PATCH — only canCreateAgents=false ─────
  console.log('\n[step 5] PATCH { canCreateAgents: false } → canDispatch retained');
  {
    const r = await patch(token, { canCreateAgents: false });
    assert(r.status === 200, `PATCH 200 (got ${r.status})`);
    assert(r.body.data?.canCreateAgents === false, 'canCreateAgents = false');
    assert(
      r.body.data?.canDispatch === true,
      'canDispatch retained true (merge, not replace)',
      JSON.stringify(r.body.data),
    );
  }

  // ───── Step 6: GET reflects mixed state ─────
  console.log('\n[step 6] GET reflects mixed state');
  {
    const r = await get(token);
    assert(r.body.data?.canCreateAgents === false, 'canCreateAgents = false');
    assert(r.body.data?.canDispatch === true, 'canDispatch = true');
  }

  // ───── Step 7: sibling metadata key preserved ─────
  console.log('\n[step 7] metadata.preferredCreationMode preserved (no clobber)');
  {
    const row = await prisma.iMUser.findUnique({ where: { id: ownerId }, select: { metadata: true } });
    let preserved = false;
    let hasCeo = false;
    try {
      const parsed = JSON.parse(row?.metadata || '{}');
      preserved = parsed?.preferredCreationMode === 'simple';
      hasCeo =
        !!parsed?.ceoPermissions &&
        parsed.ceoPermissions.canCreateAgents === false &&
        parsed.ceoPermissions.canDispatch === true;
    } catch {
      /* leave both false */
    }
    assert(preserved, 'preferredCreationMode = "simple" still in metadata', row?.metadata ?? '<null>');
    assert(hasCeo, 'ceoPermissions persisted alongside sibling key', row?.metadata ?? '<null>');
  }

  // ───── Step 8: empty PATCH → 400 ─────
  console.log('\n[step 8] empty PATCH → 400');
  {
    const r = await patch(token, {});
    assert(r.status === 400, `empty PATCH 400 (got ${r.status})`, JSON.stringify(r.body));
  }

  // ───── Step 9: PATCH with non-boolean → 400 (ignored, no fields valid) ─────
  console.log('\n[step 9] PATCH non-boolean values → 400');
  {
    const r = await patch(token, { canCreateAgents: 'true' as unknown as boolean });
    assert(r.status === 400, `non-bool PATCH 400 (got ${r.status})`, JSON.stringify(r.body));
  }

  console.log('\n──────────────────────────────');
  if (failed === 0) {
    console.log('ALL CHECKS PASS');
  } else {
    console.error(`${failed} CHECK(S) FAILED`);
  }
  await prisma.$disconnect();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('[test-ceo-permissions] FATAL', err);
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
