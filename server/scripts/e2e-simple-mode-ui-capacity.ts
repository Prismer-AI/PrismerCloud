/**
 * scripts/e2e-simple-mode-ui-capacity.ts
 *
 * P3-7 收尾 — Simple Mode 容量计数 UI 端到端验证。Phase 1 已经做完服务端
 * (scripts/e2e-device-max-agents.ts)、API 暴露 (maxAgents 字段);这里只
 * 验 UI 链路里需要的 wire signal:
 *
 *   1. Fresh workspace (无现有 device) → `/api/workspace/runtime-installations`
 *      返回空数组。Modal 会 fallback 到 3。
 *   2. 现有 device maxAgents=3, used=1 → API 返回 maxAgents=3 +
 *      hostedAgentSummary.declared=1。Modal 显示 (N/3)。
 *   3. SQL bump device 到 maxAgents=5 → API 返回 maxAgents=5。Modal
 *      显示 (N/5)。证明从 hardcode → API 转换真实生效。
 *   4. POST /api/im/register {daemonId} 在 used=max 时 → 409
 *      `{ error: { code: 'CAPACITY_EXCEEDED' }, meta: { used, max } }`
 *      (sanity check — UI 上 use-simple-provisioning 现在会把这个走
 *      `onCapacityExceeded` 而不是误判成 SlugConflictError)。
 *
 * Run
 * ----
 *   ./scripts/dev-stack.sh up
 *   npm run dev    # :3000
 *   npx tsx scripts/e2e-simple-mode-ui-capacity.ts
 */

import path from 'node:path';
import { createRequire } from 'node:module';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'mysql://prismer:devpass@localhost:3307/prismer_cloud';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:3000';
const JWT_SECRET = process.env.JWT_SECRET || process.env.NEXTAUTH_SECRET || 'local-dev-secret-do-not-use-in-prod';
const REDIS_HOST = process.env.E2E_REDIS_HOST || 'localhost';
const REDIS_PORT = Number(process.env.E2E_REDIS_PORT || '6380');

const FIXTURE_PREFIX = 'e2e-ui-cap';
const OWNER_USERNAME = `${FIXTURE_PREFIX}-owner`;
const WORKSPACE_SLUG = `${FIXTURE_PREFIX}-ws`;
const DAEMON_RUNTIME_INSTANCE_ID = `${FIXTURE_PREFIX}-rt-001`;
const DAEMON_ID = `container:${DAEMON_RUNTIME_INSTANCE_ID}`;

const require_ = createRequire(import.meta.url);
const { PrismaClient } = require_(path.join(process.cwd(), 'prisma/generated/mysql'));
const jwt = require_('jsonwebtoken');
const IORedis = require_('ioredis');

const prisma = new PrismaClient();
const redis = new IORedis({ host: REDIS_HOST, port: REDIS_PORT, lazyConnect: true });

let failed = 0;
function assert(cond: unknown, label: string, detail?: string): void {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    failed += 1;
  }
}

interface RuntimeInstallationDTO {
  id: string;
  daemonId: string;
  maxAgents: number;
  phase: string;
  hostedAgentSummary?: { declared: number; expected: number; verified: boolean };
}
interface ListResp {
  ok: boolean;
  data?: RuntimeInstallationDTO[];
  error?: string | { code: string; message: string };
}

async function seedFresh(): Promise<{ workspaceId: string; ownerImUserId: string; containerId: string }> {
  const ownerId = `usr-${FIXTURE_PREFIX.slice(0, 12)}`.slice(0, 30);
  const owner = await prisma.iMUser.upsert({
    where: { username: OWNER_USERNAME },
    create: { id: ownerId, username: OWNER_USERNAME, displayName: 'E2E UI Cap Owner', role: 'human' },
    update: { displayName: 'E2E UI Cap Owner' },
    select: { id: true },
  });

  // Workspace
  let workspace = await prisma.iMWorkspace.findFirst({
    where: { ownerImUserId: owner.id, slug: WORKSPACE_SLUG, deletedAt: null },
    select: { id: true },
  });
  if (!workspace) {
    workspace = await prisma.iMWorkspace.create({
      data: {
        ownerImUserId: owner.id,
        name: 'E2E UI Cap WS',
        slug: WORKSPACE_SLUG,
        isDefault: false,
      },
      select: { id: true },
    });
  }

  // Clear agent fixtures + the device (we'll re-create per scenario)
  await prisma.iMAgentCard.deleteMany({
    where: { workspaceId: workspace.id, imUser: { username: { startsWith: `${FIXTURE_PREFIX}-agent-` } } },
  });
  await prisma.iMUser.deleteMany({
    where: { username: { startsWith: `${FIXTURE_PREFIX}-agent-` } },
  });
  const containerId = `cont-${FIXTURE_PREFIX.slice(0, 12)}`.slice(0, 30);
  await prisma.iMContainer.deleteMany({ where: { id: containerId } });
  await redis.del(`runtime:device:${workspace.id}:${DAEMON_ID}`);
  await redis.srem(`runtime:devices:${workspace.id}`, DAEMON_ID);

  return { workspaceId: workspace.id, ownerImUserId: owner.id, containerId };
}

async function seedDeviceWithUsed(opts: {
  workspaceId: string;
  ownerImUserId: string;
  containerId: string;
  maxAgents: number;
  usedAgents: number;
}): Promise<void> {
  const podName = `pod-${FIXTURE_PREFIX}-001`.slice(0, 64);
  const existing = await prisma.iMContainer.findUnique({ where: { id: opts.containerId } });
  if (existing) {
    await prisma.iMContainer.update({
      where: { id: opts.containerId },
      data: {
        workspaceId: opts.workspaceId,
        tenantId: opts.ownerImUserId,
        agentImUserId: DAEMON_RUNTIME_INSTANCE_ID,
        status: 'running',
        maxAgents: opts.maxAgents,
      },
    });
  } else {
    await prisma.iMContainer.create({
      data: {
        id: opts.containerId,
        workspaceId: opts.workspaceId,
        tenantId: opts.ownerImUserId,
        agentImUserId: DAEMON_RUNTIME_INSTANCE_ID,
        podName,
        namespace: 'default',
        image: 'mock/sandbox:test',
        imageTag: 'test',
        status: 'running',
        runtimeKind: 'k8s',
        cpuRequest: '250m',
        cpuLimit: '2000m',
        memoryRequest: '2Gi',
        memoryLimit: '4Gi',
        maxAgents: opts.maxAgents,
      },
    });
  }

  // Daemon presence in Redis (route doesn't actually need it for GET, but
  // we keep it consistent in case the readiness probe consults it).
  await redis.set(
    `runtime:device:${opts.workspaceId}:${DAEMON_ID}`,
    JSON.stringify({
      daemonId: DAEMON_ID,
      deviceId: DAEMON_ID,
      name: 'E2E UI Cap Daemon',
      lastSeenAt: Date.now(),
      hostedAgents: opts.usedAgents,
    }),
  );
  await redis.sadd(`runtime:devices:${opts.workspaceId}`, DAEMON_ID);

  // Pre-create agent IMUsers + cards so hostedAgentSummary.declared counts
  // them. metadata.daemonId is what loadDeclaredByDaemon scans for.
  for (let i = 1; i <= opts.usedAgents; i++) {
    const agentUsername = `${FIXTURE_PREFIX}-agent-existing-${i}`;
    const agentId = `agt-${FIXTURE_PREFIX.slice(0, 10)}-${i}`.slice(0, 30);
    const agent = await prisma.iMUser.upsert({
      where: { username: agentUsername },
      create: { id: agentId, username: agentUsername, displayName: agentUsername, role: 'agent' },
      update: {},
      select: { id: true },
    });
    await prisma.iMAgentCard.upsert({
      where: { imUserId: agent.id },
      create: {
        imUserId: agent.id,
        workspaceId: opts.workspaceId,
        name: agentUsername,
        agentType: 'assistant',
        metadata: JSON.stringify({ daemonId: DAEMON_ID }),
        lastHeartbeat: new Date(),
      },
      update: {
        workspaceId: opts.workspaceId,
        metadata: JSON.stringify({ daemonId: DAEMON_ID }),
        lastHeartbeat: new Date(),
      },
    });
  }
}

function signOwnerToken(ownerImUserId: string): string {
  return jwt.sign({ sub: ownerImUserId, username: OWNER_USERNAME, role: 'human' }, JWT_SECRET, { expiresIn: '1h' });
}

async function listInstallations(token: string, workspaceId: string): Promise<ListResp> {
  const res = await fetch(
    `${BASE_URL}/api/workspace/runtime-installations?workspaceId=${encodeURIComponent(workspaceId)}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  return (await res.json()) as ListResp;
}

async function registerAgent(opts: {
  token: string;
  workspaceId: string;
  username: string;
  daemonId: string;
}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE_URL}/api/im/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.token}` },
    body: JSON.stringify({
      type: 'agent',
      username: opts.username,
      displayName: opts.username,
      agentType: 'assistant',
      workspaceId: opts.workspaceId,
      metadata: { daemonId: opts.daemonId },
    }),
  });
  return { status: res.status, body: await res.json() };
}

async function main(): Promise<void> {
  console.log('[e2e-simple-mode-ui-capacity] base =', BASE_URL);
  await redis.connect();

  const { workspaceId, ownerImUserId, containerId } = await seedFresh();
  console.log(`  seeded fresh ws=${workspaceId} owner=${ownerImUserId}`);
  const token = signOwnerToken(ownerImUserId);

  // ───── Scenario 1: fresh workspace, no device ─────
  console.log('\n[scenario 1] fresh workspace, no device → UI fallback to 3');
  {
    const list = await listInstallations(token, workspaceId);
    assert(list.ok === true, '/runtime-installations returns ok', JSON.stringify(list).slice(0, 200));
    assert(Array.isArray(list.data) && list.data.length === 0, 'empty installations list', JSON.stringify(list.data));
  }

  // ───── Scenario 2: device maxAgents=3, used=1 ─────
  console.log('\n[scenario 2] device maxAgents=3, used=1 → counter (N/3)');
  await seedDeviceWithUsed({ workspaceId, ownerImUserId, containerId, maxAgents: 3, usedAgents: 1 });
  {
    const list = await listInstallations(token, workspaceId);
    assert(list.ok === true && Array.isArray(list.data), 'list ok');
    const row = list.data?.[0];
    assert(row?.maxAgents === 3, `row.maxAgents === 3 (got ${row?.maxAgents})`);
    assert(
      row?.hostedAgentSummary?.declared === 1,
      `hostedAgentSummary.declared === 1 (got ${row?.hostedAgentSummary?.declared})`,
    );
    assert(
      typeof row?.daemonId === 'string' && row?.daemonId.length > 0,
      `row.daemonId present (got ${row?.daemonId})`,
    );
    console.log(
      `    → modal capacity probe will read maxAgents=${row?.maxAgents}, used=${row?.hostedAgentSummary?.declared}`,
    );
    console.log(`    → Step2 counter renders (N/${row?.maxAgents}). Real M from API (Phase 1 wire).`);
  }

  // ───── Scenario 3: SQL bump to maxAgents=5 ─────
  console.log('\n[scenario 3] SQL UPDATE im_containers SET maxAgents=5 → counter (N/5)');
  await prisma.iMContainer.update({ where: { id: containerId }, data: { maxAgents: 5 } });
  {
    const list = await listInstallations(token, workspaceId);
    const row = list.data?.[0];
    assert(row?.maxAgents === 5, `row.maxAgents === 5 (got ${row?.maxAgents})`);
    console.log(`    → modal capacity probe will read maxAgents=${row?.maxAgents}`);
    console.log(`    → Step2 counter renders (N/5). Proves hardcode→API conversion lands at runtime.`);
  }

  // ───── Scenario 4: server-side 409 CAPACITY_EXCEEDED still fires, UI handler bucks slug-conflict ─────
  console.log('\n[scenario 4] server 409 CAPACITY_EXCEEDED — distinct from SlugConflict (UI bucket check)');
  // Re-seed maxAgents=2, used=2 so any new register fails capacity.
  await prisma.iMContainer.update({ where: { id: containerId }, data: { maxAgents: 2 } });
  // Bring used count to 2 — agent-existing-1 already there; add one more.
  await seedDeviceWithUsed({ workspaceId, ownerImUserId, containerId, maxAgents: 2, usedAgents: 2 });
  {
    const { status, body } = await registerAgent({
      token,
      workspaceId,
      username: `${FIXTURE_PREFIX}-agent-overflow`,
      daemonId: DAEMON_ID,
    });
    assert(status === 409, `overflow register → 409 (got ${status})`, JSON.stringify(body).slice(0, 200));
    const err = body?.error;
    const code = typeof err === 'object' && err ? err.code : undefined;
    assert(code === 'CAPACITY_EXCEEDED', `error.code === CAPACITY_EXCEEDED (got ${code})`, JSON.stringify(err));
    assert(body?.meta?.used === 2, `meta.used === 2 (got ${body?.meta?.used})`);
    assert(body?.meta?.max === 2, `meta.max === 2 (got ${body?.meta?.max})`);
    // Verify that the message is NOT a username-conflict-shaped string — the
    // UI use-simple-provisioning checks `error.code === 'CAPACITY_EXCEEDED'`
    // first and routes to `onCapacityExceeded` instead of the SlugConflict
    // path. Asserts here that the wire shape supports that disambiguation.
    const message = typeof err === 'object' && err ? err.message : '';
    const looksLikeSlug = /username.*already taken/i.test(message);
    assert(
      !looksLikeSlug,
      'CAPACITY_EXCEEDED message does NOT match SlugConflict phrase ("username already taken")',
      message,
    );
    console.log(
      `    → use-simple-provisioning sees raw.error.code === CAPACITY_EXCEEDED first, ` +
        `routes to onCapacityExceeded(used=${body?.meta?.used}, max=${body?.meta?.max}, msg).`,
    );
    console.log(
      `    → SimpleStep3Launch surfaces inline error: "设备容量已满: ${body?.meta?.used} / ${body?.meta?.max} agents".`,
    );
  }

  console.log('');
  if (failed > 0) {
    console.error(`[e2e-simple-mode-ui-capacity] FAIL — ${failed} assertion(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('[e2e-simple-mode-ui-capacity] PASS — all assertions met');
  }
}

main()
  .catch((err) => {
    console.error('[e2e-simple-mode-ui-capacity] CRASH —', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
    await redis.quit().catch(() => {});
  });
