/**
 * Wave 3.5 W1 — Server hydration endpoint integration tests.
 *
 * Real-DB tests (no mocks) against `localhost:3000` next.js dev server +
 * docker MySQL. Tests three new endpoints:
 *   1. GET  /api/im/conversations/:cid/active-task-phases
 *   2. GET  /api/im/conversations/:cid/active-task-count
 *   3. POST /api/im/tasks/:id/retry-dispatch
 *
 * Run:
 *   APP_ENV=dev DATABASE_URL="mysql://prismer:devpass@localhost:3307/prismer_cloud" \
 *     npx tsx src/im/tests/w1-hydration-endpoints.test.ts
 *
 * Pre-conditions:
 *   - docker mysql (port 3307) + redis (port 6380) running
 *   - next dev server running at http://localhost:3000
 *   - migration 405 (im_task_run_steps) applied
 */

// Dynamic prisma client selection — matches src/lib/prisma.ts logic.
// MySQL (docker dev): use prisma/generated/mysql; SQLite: default @prisma/client.
function makePrismaClient(): any {
  const url = process.env.DATABASE_URL || '';
  if (url.startsWith('mysql://')) {
    const { PrismaClient: MySQLClient } = require('../../../prisma/generated/mysql');
    return new MySQLClient();
  }
  const { PrismaClient: SQLiteClient } = require('@prisma/client');
  return new SQLiteClient();
}

// Load .env.local so JWT_SECRET matches the running dev server's secret.
// Empirically the dev server loads `.env.local` AFTER Nacos so `.env.local`
// wins for JWT_SECRET (40 chars `local-dev-secret-do-not-use-in-prod`). Our
// tests sign tokens via the same `signToken()` helper the server uses, so
// JWT_SECRET must be identical or auth middleware returns 401.
async function loadDotenvLocal(): Promise<void> {
  try {
    const path = require('path');
    const dotenv = require('dotenv');
    // Resolve repo root from compiled file location.
    const envPath = path.resolve(__dirname, '../../../.env.local');
    const result = dotenv.config({ path: envPath, override: false });
    if (result.error) {
      console.warn('[w1-test] .env.local load:', result.error.message);
    }
  } catch (err) {
    console.warn('[w1-test] .env.local load failed:', (err as Error).message);
  }
}

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';
const JWT_TOM =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjbXAxdWhxd3owMDAweHp3dDZ1c203bTJlIiwidXNlcm5hbWUiOiJ0b213aW5zaGFyZSIsInJvbGUiOiJodW1hbiIsIm51bWVyaWNJZCI6NDAsImVtYWlsIjoidG9td2luc2hhcmVAZ21haWwuY29tIiwiaWF0IjoxNzc5Mzc3NDA2LCJleHAiOjE3Nzk5ODIyMDZ9.EZrF94iRe-Z1FVxldbT5V1EejRGEsubKcBGu7IvZXCY';
const TOM_USER_ID = 'cmp1uhqwz0000xzwt6usm7m2e'; // im_users.id for tomwinshare (numericId=40)

const prisma: any = makePrismaClient();

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(name: string) {
  passed++;
  console.log(`  ✅ ${name}`);
}

function fail(name: string, msg: string) {
  failed++;
  failures.push(`${name}: ${msg}`);
  console.log(`  ❌ ${name} — ${msg}`);
}

function assert(cond: boolean, name: string, msg = 'assertion failed') {
  if (cond) ok(name);
  else fail(name, msg);
}

async function api(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { __raw: text };
  }
  return { status: res.status, body };
}

// ─── Fixture setup ──────────────────────────────────────────────────────────

interface Fixture {
  conversationId: string;
  workspaceId: string;
  otherUserId: string;
  otherJwt: string; // we'll just construct a fake one or use direct DB inserts
  agentImUserId: string;
  taskIds: {
    running: string;
    runningStuck: string;
    runningWaitingUser: string;
    review: string;
    blocked: string;
    completed: string; // should NOT appear in results
  };
}

async function setupFixture(): Promise<Fixture> {
  const ts = Date.now();

  // Use Tom's existing workspace + create a new conversation he owns.
  const ws = await prisma.iMWorkspace.findFirst({
    where: { ownerImUserId: TOM_USER_ID, deletedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (!ws) throw new Error('Tom has no workspace');

  // Find an existing "other user" who is NOT Tom (for 403 test).
  const otherUser = await prisma.iMUser.findFirst({
    where: { id: { not: TOM_USER_ID }, role: 'human', banned: false },
    select: { id: true },
  });
  if (!otherUser) throw new Error('no other human user for 403 test');

  const conv = await prisma.iMConversation.create({
    data: {
      id: `cmpw1${ts}`,
      title: `w1-hydration-${ts}`,
      type: 'group',
      status: 'active',
      createdById: TOM_USER_ID,
      workspaceId: ws.id,
    },
  });

  await prisma.iMParticipant.create({
    data: {
      id: `cmpw1p${ts}`,
      conversationId: conv.id,
      imUserId: TOM_USER_ID,
      role: 'owner',
    },
  });

  // Create a synthetic agent user for assignee.
  const agentUser = await prisma.iMUser.create({
    data: {
      id: `cmpw1a${ts}`,
      username: `w1agent-${ts}`,
      displayName: `W1 Test Agent ${ts}`,
      role: 'agent',
      agentType: 'assistant',
      userId: String(40), // owned by tom (numericId=40)
    },
  });

  const mkTask = async (suffix: string, status: string, phase: string | null) => {
    const t = await prisma.iMTask.create({
      data: {
        id: `cmpw1t${ts}${suffix}`,
        title: `W1 Test Task ${suffix}`,
        description: 'integration test fixture',
        status,
        currentPhase: phase,
        creatorId: TOM_USER_ID,
        assigneeId: agentUser.id,
        workspaceId: ws.id,
        conversationId: conv.id,
        runtimeRoute: 'agent',
        // Recent heartbeat — keep reaper away. 5s < 45s cutoff.
        lastHeartbeatAt: new Date(Date.now() - 5_000),
        progress: 0.42,
        statusMessage: `phase=${phase}`,
      },
    });
    return t.id;
  };

  const fx: Fixture = {
    conversationId: conv.id,
    workspaceId: ws.id,
    otherUserId: otherUser.id,
    otherJwt: '', // unused — we test 403 by issuing a JWT for otherUser via direct prisma path below
    agentImUserId: agentUser.id,
    taskIds: {
      running: await mkTask('R', 'running', 'thinking'),
      runningStuck: await mkTask('S', 'running', 'stuck'),
      runningWaitingUser: await mkTask('W', 'running', 'waiting_user'),
      review: await mkTask('V', 'review', null),
      blocked: await mkTask('B', 'blocked', null),
      completed: await mkTask('C', 'completed', null), // must NOT appear
    },
  };

  // Insert a tool_call step for the 'running' task so lastStep enrichment fires.
  await prisma.iMTaskRunStep.create({
    data: {
      id: `cmpw1step${ts}`,
      taskRunId: `cmpw1run${ts}`,
      taskId: fx.taskIds.running,
      seq: BigInt(1),
      kind: 'tool_call',
      payloadJson: JSON.stringify({ toolName: 'wechat-send', args: { msg: 'hello' } }),
      occurredAt: new Date(Date.now() - 5_000),
    },
  });

  return fx;
}

async function cleanupFixture(fx: Fixture) {
  // Delete in FK-safe order.
  await prisma.iMTaskLog.deleteMany({ where: { taskId: { in: Object.values(fx.taskIds) } } }).catch(() => {});
  await prisma.iMTaskRunStep.deleteMany({ where: { taskId: { in: Object.values(fx.taskIds) } } }).catch(() => {});
  await prisma.iMTask.deleteMany({ where: { id: { in: Object.values(fx.taskIds) } } }).catch(() => {});
  await prisma.iMParticipant.deleteMany({ where: { conversationId: fx.conversationId } }).catch(() => {});
  await prisma.iMConversation.delete({ where: { id: fx.conversationId } }).catch(() => {});
  await prisma.iMUser.delete({ where: { id: fx.agentImUserId } }).catch(() => {});
}

// Issue a JWT for the "other" user (for 403 test).
// We sign one directly via the same algorithm/secret the server uses.
async function issueJwtForUser(imUserId: string): Promise<string> {
  const u = await prisma.iMUser.findUnique({
    where: { id: imUserId },
    select: { email: true, username: true, role: true },
  });
  if (!u) throw new Error('user missing');
  const { signToken } = await import('../auth/jwt');
  return signToken({
    sub: imUserId,
    username: u.username,
    role: u.role as any,
    email: u.email ?? undefined,
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

async function testActiveTaskPhases(fx: Fixture) {
  console.log('\n[1] GET /conversations/:cid/active-task-phases');

  // Happy path
  const res = await api('GET', `/api/im/conversations/${fx.conversationId}/active-task-phases`, {
    token: JWT_TOM,
  });
  assert(res.status === 200, '1.1 happy 200', `got ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);
  assert(res.body?.ok === true, '1.2 happy ok=true', JSON.stringify(res.body).slice(0, 200));
  const tasks = res.body?.data?.tasks ?? [];
  assert(Array.isArray(tasks), '1.3 tasks is array');
  // Expect 5 active tasks (running, runningStuck, runningWaitingUser, review, blocked).
  // 'completed' must be filtered out.
  const taskIds = tasks.map((t: any) => t.taskId);
  assert(taskIds.length === 5, `1.4 task count = 5 (got ${taskIds.length})`, JSON.stringify(taskIds));
  assert(taskIds.includes(fx.taskIds.running), '1.5 includes running');
  assert(taskIds.includes(fx.taskIds.runningStuck), '1.6 includes runningStuck');
  assert(taskIds.includes(fx.taskIds.review), '1.7 includes review');
  assert(taskIds.includes(fx.taskIds.blocked), '1.8 includes blocked');
  assert(!taskIds.includes(fx.taskIds.completed), '1.9 excludes completed');

  // lastStep enrichment — running task has a tool_call step
  const runningRow = tasks.find((t: any) => t.taskId === fx.taskIds.running);
  assert(runningRow?.lastStep?.kind === 'tool_call', '1.10 lastStep.kind=tool_call', JSON.stringify(runningRow?.lastStep));
  assert(runningRow?.lastStep?.toolName === 'wechat-send', '1.11 lastStep.toolName=wechat-send');
  assert(runningRow?.currentPhase === 'thinking', '1.12 currentPhase=thinking');

  // Tasks without steps have lastStep=null
  const reviewRow = tasks.find((t: any) => t.taskId === fx.taskIds.review);
  assert(reviewRow?.lastStep === null, '1.13 review task lastStep=null');

  // Non-participant 403
  const otherJwt = await issueJwtForUser(fx.otherUserId);
  const res403 = await api('GET', `/api/im/conversations/${fx.conversationId}/active-task-phases`, { token: otherJwt });
  assert(res403.status === 403, `1.14 non-participant 403 (got ${res403.status})`, JSON.stringify(res403.body).slice(0, 200));

  // Empty conv — create one with no tasks
  const emptyConv = await prisma.iMConversation.create({
    data: {
      id: `cmpw1ec${Date.now()}`,
      title: 'empty-conv',
      type: 'group',
      status: 'active',
      createdById: TOM_USER_ID,
      workspaceId: fx.workspaceId,
    },
  });
  await prisma.iMParticipant.create({
    data: {
      id: `cmpw1ecp${Date.now()}`,
      conversationId: emptyConv.id,
      imUserId: TOM_USER_ID,
      role: 'owner',
    },
  });
  const emptyRes = await api('GET', `/api/im/conversations/${emptyConv.id}/active-task-phases`, {
    token: JWT_TOM,
  });
  assert(emptyRes.status === 200, '1.15 empty conv 200');
  assert(Array.isArray(emptyRes.body?.data?.tasks) && emptyRes.body.data.tasks.length === 0, '1.16 empty tasks []');
  await prisma.iMParticipant.deleteMany({ where: { conversationId: emptyConv.id } });
  await prisma.iMConversation.delete({ where: { id: emptyConv.id } });
}

async function testActiveTaskCount(fx: Fixture) {
  console.log('\n[2] GET /conversations/:cid/active-task-count');

  const res = await api('GET', `/api/im/conversations/${fx.conversationId}/active-task-count`, {
    token: JWT_TOM,
  });
  assert(res.status === 200, '2.1 happy 200');
  const data = res.body?.data;
  // running tasks: running (thinking), runningStuck (stuck), runningWaitingUser (waiting_user) → running=3
  // stuck=1, waiting=1 (waiting_user), total=5 (running×3 + review + blocked)
  assert(data?.running === 3, `2.2 running=3 (got ${data?.running})`, JSON.stringify(data));
  assert(data?.stuck === 1, `2.3 stuck=1 (got ${data?.stuck})`, JSON.stringify(data));
  assert(data?.waiting === 1, `2.4 waiting=1 (got ${data?.waiting})`, JSON.stringify(data));
  assert(data?.total === 5, `2.5 total=5 (got ${data?.total})`, JSON.stringify(data));

  // 403
  const otherJwt = await issueJwtForUser(fx.otherUserId);
  const res403 = await api('GET', `/api/im/conversations/${fx.conversationId}/active-task-count`, { token: otherJwt });
  assert(res403.status === 403, `2.6 non-participant 403 (got ${res403.status})`);

  // Empty conv (no tasks → all zeros)
  const emptyConv = await prisma.iMConversation.create({
    data: {
      id: `cmpw1ec2${Date.now()}`,
      title: 'empty-conv-2',
      type: 'group',
      status: 'active',
      createdById: TOM_USER_ID,
      workspaceId: fx.workspaceId,
    },
  });
  await prisma.iMParticipant.create({
    data: {
      id: `cmpw1ecp2${Date.now()}`,
      conversationId: emptyConv.id,
      imUserId: TOM_USER_ID,
      role: 'owner',
    },
  });
  const emptyRes = await api('GET', `/api/im/conversations/${emptyConv.id}/active-task-count`, {
    token: JWT_TOM,
  });
  assert(emptyRes.status === 200, '2.7 empty 200');
  assert(
    emptyRes.body?.data?.running === 0 &&
      emptyRes.body?.data?.stuck === 0 &&
      emptyRes.body?.data?.waiting === 0 &&
      emptyRes.body?.data?.total === 0,
    '2.8 empty counters all 0',
    JSON.stringify(emptyRes.body?.data),
  );
  await prisma.iMParticipant.deleteMany({ where: { conversationId: emptyConv.id } });
  await prisma.iMConversation.delete({ where: { id: emptyConv.id } });
}

async function testRetryDispatch(fx: Fixture) {
  console.log('\n[3] POST /tasks/:id/retry-dispatch');

  // Happy path — runningStuck task (status=running, phase=stuck)
  const res = await api('POST', `/api/im/tasks/${fx.taskIds.runningStuck}/retry-dispatch`, {
    token: JWT_TOM,
    body: { reason: 'integration test' },
  });
  assert(res.status === 200, `3.1 stuck task 200 (got ${res.status})`, JSON.stringify(res.body).slice(0, 300));
  assert(res.body?.ok === true, '3.2 ok=true');
  assert(res.body?.data?.taskId === fx.taskIds.runningStuck, '3.3 taskId echoed back');
  assert(res.body?.data?.status === 'running', '3.4 status unchanged (running)');

  // Verify task log was written
  const logs = await prisma.iMTaskLog.findMany({
    where: { taskId: fx.taskIds.runningStuck, action: 'retry-dispatch' },
  });
  assert(logs.length === 1, `3.5 task log written (got ${logs.length})`);
  assert(logs[0]?.message?.includes('integration test'), '3.6 log message includes reason');

  // Reject non-stuck task (running but phase=thinking, not stuck) → 409
  const resNonStuck = await api('POST', `/api/im/tasks/${fx.taskIds.running}/retry-dispatch`, {
    token: JWT_TOM,
    body: {},
  });
  assert(
    resNonStuck.status === 409,
    `3.7 non-stuck rejected 409 (got ${resNonStuck.status})`,
    JSON.stringify(resNonStuck.body).slice(0, 200),
  );
  assert(
    resNonStuck.body?.error?.code === 'INVALID_STATE_TRANSITION',
    '3.8 error code INVALID_STATE_TRANSITION',
    JSON.stringify(resNonStuck.body?.error),
  );

  // Reject completed task → 409
  const resCompleted = await api('POST', `/api/im/tasks/${fx.taskIds.completed}/retry-dispatch`, {
    token: JWT_TOM,
    body: {},
  });
  assert(
    resCompleted.status === 409,
    `3.9 completed task rejected 409 (got ${resCompleted.status})`,
    JSON.stringify(resCompleted.body).slice(0, 200),
  );

  // Non-creator/non-orchestrator agent → should be 403
  // Use the otherUser (a human who isn't the workspace owner/admin/creator)
  const otherJwt = await issueJwtForUser(fx.otherUserId);
  // First, set the runningStuck task back to stuck phase (in case daemon emitted a change — we don't care, the task still exists)
  await prisma.iMTask.update({
    where: { id: fx.taskIds.runningStuck },
    data: { currentPhase: 'stuck', status: 'running' },
  });
  const res403 = await api('POST', `/api/im/tasks/${fx.taskIds.runningStuck}/retry-dispatch`, {
    token: otherJwt,
    body: {},
  });
  assert(
    res403.status === 403,
    `3.10 non-creator 403 (got ${res403.status})`,
    JSON.stringify(res403.body).slice(0, 200),
  );

  // 404 for nonexistent task
  const resMissing = await api('POST', `/api/im/tasks/nonexistent-task-id/retry-dispatch`, {
    token: JWT_TOM,
    body: {},
  });
  assert(resMissing.status === 404, `3.11 missing task 404 (got ${resMissing.status})`);
}

// ─── Driver ─────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Wave 3.5 W1 — Server hydration endpoint tests (BASE=${BASE})`);
  console.log('Loading .env.local (JWT_SECRET must match dev server)...');
  await loadDotenvLocal();
  console.log('Setting up fixture...');
  const fx = await setupFixture();
  console.log(`  conv=${fx.conversationId} agent=${fx.agentImUserId}`);

  try {
    await testActiveTaskPhases(fx);
    await testActiveTaskCount(fx);
    await testRetryDispatch(fx);
  } finally {
    console.log('\nCleaning up fixture...');
    await cleanupFixture(fx);
    await prisma.$disconnect();
  }

  console.log(`\n──────────────────────────────────────`);
  console.log(`PASS: ${passed}  FAIL: ${failed}`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('Test driver crashed:', err);
  prisma.$disconnect();
  process.exit(2);
});
